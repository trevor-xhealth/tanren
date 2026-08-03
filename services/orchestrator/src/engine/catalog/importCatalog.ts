// Import a `tanren.behavior.v0` / `tanren.persona.v0` catalog.
//
// THE MODELLING DECISION, in one place (full reasoning in
// docs/architecture/behavior-catalog-import.md):
//
//   Intent            -> behaviors.description
//   Observable outcomes -> behaviors."then"   (they ARE the observable result)
//   given / when      -> ""                   (HONEST ABSENCE)
//
// The source schema has no `given` and no `when`. Inventing a plausible
// precondition ("Given the persona is signed in…") would put a sentence into a
// verification surface that no author wrote and no reviewer approved. So the
// projection leaves them empty and the catalog row records that the document
// came from a schema which has no such concept — the same posture the subtask
// writer takes toward an absent design contract: no block, NEVER a fabricated
// default. The catalog tables, not the BDD triple, are the authority.
//
// The whole import is ONE transaction: a single unresolvable persona slug,
// duplicate `B-####`, or dangling `related` target aborts everything. A partly
// applied catalog is worse than no catalog.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { BehaviorStore } from "../entities/behaviors.js";
import { PersonaStore } from "../entities/personas.js";
import {
  type CatalogBehaviorDocument,
  type CatalogDocumentSet,
  CatalogImportError,
  type CatalogPersonaDocument,
  type CatalogSourceDocument,
  parseCatalogDocuments,
} from "./documents.js";
import { type CatalogScope, CatalogStore } from "./store.js";

export { CatalogImportError } from "./documents.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface CatalogImportRequest {
  readonly orgId: string;
  readonly projectId: string;
  readonly documents: readonly CatalogSourceDocument[];
  readonly dryRun?: boolean;
}

export interface CatalogImportCounts {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
}

export interface CatalogImportSummary {
  readonly personas: CatalogImportCounts;
  readonly behaviors: CatalogImportCounts;
  readonly dryRun: boolean;
}

/** Internal signal: unwinds the transaction so a dry run commits nothing. */
class DryRunRollback extends Error {
  readonly summary: CatalogImportSummary;

  constructor(summary: CatalogImportSummary) {
    super("catalog dry run");
    this.name = "DryRunRollback";
    this.summary = summary;
  }
}

class Tally {
  created = 0;
  updated = 0;
  unchanged = 0;

  counts(): CatalogImportCounts {
    return { created: this.created, updated: this.updated, unchanged: this.unchanged };
  }
}

function assertActorMatchesOrg(actor: ActorContext, orgId: string): void {
  if (actor.scopes.includes("platform:admin")) return;
  if (actor.orgId !== orgId) {
    throw new CatalogImportError("catalog_org_access_denied", `actor ${actor.userId} is not scoped to org ${orgId}`);
  }
}

function assertUniqueIdentities(documents: CatalogDocumentSet): void {
  const slugs = new Set<string>();
  for (const persona of documents.personas) {
    if (slugs.has(persona.slug)) {
      throw new CatalogImportError(
        "catalog_duplicate_persona",
        `duplicate persona slug ${persona.slug}`,
        persona.sourcePath,
      );
    }
    slugs.add(persona.slug);
  }
  const ids = new Set<string>();
  for (const behavior of documents.behaviors) {
    if (ids.has(behavior.catalogId)) {
      throw new CatalogImportError(
        "catalog_duplicate_id",
        `duplicate behavior id ${behavior.catalogId}`,
        behavior.sourcePath,
      );
    }
    ids.add(behavior.catalogId);
  }
}

/**
 * Every persona slug and every `related` target must resolve — against this
 * payload OR against what the scope already holds. An unresolvable reference is
 * a LOUD failure; the behavior is never silently dropped, and never imported
 * with its links quietly thinned.
 */
function assertReferencesResolve(
  documents: CatalogDocumentSet,
  knownSlugs: ReadonlySet<string>,
  knownIds: ReadonlySet<string>,
): void {
  const slugs = new Set([...knownSlugs, ...documents.personas.map((persona) => persona.slug)]);
  const ids = new Set([...knownIds, ...documents.behaviors.map((behavior) => behavior.catalogId)]);
  for (const behavior of documents.behaviors) {
    for (const slug of behavior.personaSlugs) {
      if (!slugs.has(slug)) {
        throw new CatalogImportError(
          "catalog_unknown_persona",
          `${behavior.catalogId} references persona slug ${slug}, which is not in this catalog`,
          behavior.sourcePath,
        );
      }
    }
    for (const target of behavior.related) {
      if (target === behavior.catalogId) {
        throw new CatalogImportError(
          "catalog_self_relation",
          `${behavior.catalogId} relates to itself`,
          behavior.sourcePath,
        );
      }
      if (!ids.has(target)) {
        throw new CatalogImportError(
          "catalog_unknown_relation",
          `${behavior.catalogId} relates to ${target}, which is not in this catalog`,
          behavior.sourcePath,
        );
      }
    }
  }
}

function coreJobOf(persona: CatalogPersonaDocument): string {
  return persona.sections[0]?.body ?? "";
}

function projectionMetadata(behavior: CatalogBehaviorDocument): Record<string, unknown> {
  return {
    catalog: {
      schema: behavior.schemaVersion,
      catalogId: behavior.catalogId,
      initiative: behavior.initiative,
      sourcePath: behavior.sourcePath,
    },
  };
}

async function applyPersonas(
  client: QueryClient,
  scope: CatalogScope,
  documents: readonly CatalogPersonaDocument[],
  actor: ActorContext,
): Promise<{ counts: CatalogImportCounts; lookup: Map<string, string> }> {
  const state = await CatalogStore.readPersonaState(client, scope);
  const lookup = new Map([...state].map(([slug, value]) => [slug, value.personaId]));
  const tally = new Tally();
  for (const document of documents) {
    const existing = state.get(document.slug);
    if (existing === undefined) {
      const persona = await PersonaStore.create(
        client,
        {
          scope: "project",
          orgId: scope.orgId,
          projectId: scope.projectId,
          name: document.name,
          description: coreJobOf(document),
          metadata: {},
        },
        actor,
      );
      await CatalogStore.writePersona(client, scope, { ...document, personaId: persona.id });
      lookup.set(document.slug, persona.id);
      tally.created += 1;
      continue;
    }
    if (existing.sourceDigest === document.sourceDigest) {
      tally.unchanged += 1;
      continue;
    }
    await CatalogStore.refreshPersonaProjection(client, {
      personaId: existing.personaId,
      name: document.name,
      description: coreJobOf(document),
    });
    await CatalogStore.writePersona(client, scope, { ...document, personaId: existing.personaId });
    tally.updated += 1;
  }
  return { counts: tally.counts(), lookup };
}

async function applyBehaviors(
  client: QueryClient,
  scope: CatalogScope,
  documents: readonly CatalogBehaviorDocument[],
  lookup: ReadonlyMap<string, string>,
  actor: ActorContext,
): Promise<CatalogImportCounts> {
  const state = await CatalogStore.readBehaviorState(client, scope);
  const tally = new Tally();
  const touched: CatalogBehaviorDocument[] = [];
  for (const document of documents) {
    const existing = state.get(document.catalogId);
    if (existing !== undefined && existing.sourceDigest === document.sourceDigest) {
      tally.unchanged += 1;
      continue;
    }
    const behaviorId = await writeProjection(client, document, lookup, existing?.behaviorId, actor);
    await CatalogStore.writeBehavior(client, scope, { ...document, behaviorId });
    touched.push(document);
    if (existing === undefined) tally.created += 1;
    else tally.updated += 1;
  }
  // Links land only after every catalog row exists, so a `related` edge can
  // point at a sibling that appears later in the payload.
  for (const document of touched) {
    await CatalogStore.writePersonaLinks(client, scope, document.catalogId, document.personaSlugs);
    await CatalogStore.writeRelations(client, scope, document.catalogId, document.related);
  }
  return tally.counts();
}

async function writeProjection(
  client: QueryClient,
  document: CatalogBehaviorDocument,
  lookup: ReadonlyMap<string, string>,
  behaviorId: string | undefined,
  actor: ActorContext,
): Promise<string> {
  // The declared MAIN BENEFICIARY (the format puts it first) owns the projected
  // row; the full ordered list survives in catalog_behavior_personas.
  const primarySlug = document.personaSlugs[0] ?? "";
  const personaId = lookup.get(primarySlug);
  if (personaId === undefined) {
    throw new CatalogImportError(
      "catalog_unknown_persona",
      `${document.catalogId} references persona slug ${primarySlug}, which resolved to no persona`,
      document.sourcePath,
    );
  }
  const outcomes = document.outcomes.join("\n");
  if (behaviorId !== undefined) {
    await CatalogStore.refreshProjection(client, {
      behaviorId,
      personaId,
      title: document.title,
      outcomes,
      intent: document.intent,
      metadata: projectionMetadata(document),
    });
    return behaviorId;
  }
  /* eslint-disable unicorn/no-thenable */
  // "then" is the BDD column name, mirroring BehaviorCreateInput.
  const created = await BehaviorStore.create(
    client,
    {
      personaId,
      title: document.title,
      // HONEST ABSENCE: `tanren.behavior.v0` has no given/when. Empty, never invented.
      given: "",
      when: "",
      then: outcomes,
      description: document.intent,
      metadata: projectionMetadata(document),
    },
    actor,
  );
  /* eslint-enable unicorn/no-thenable */
  return created.id;
}

export async function importCatalog(
  pool: pg.Pool,
  request: CatalogImportRequest,
  actor: ActorContext,
): Promise<CatalogImportSummary> {
  assertActorMatchesOrg(actor, request.orgId);
  const documents = parseCatalogDocuments(request.documents);
  assertUniqueIdentities(documents);
  const scope: CatalogScope = { orgId: request.orgId, projectId: request.projectId };
  const dryRun = request.dryRun === true;
  try {
    return await runWithOrgScope(pool, request.orgId, async (client) => {
      const knownSlugs = new Set((await CatalogStore.readPersonaState(client, scope)).keys());
      const knownIds = new Set((await CatalogStore.readBehaviorState(client, scope)).keys());
      assertReferencesResolve(documents, knownSlugs, knownIds);
      const personas = await applyPersonas(client, scope, documents.personas, actor);
      const behaviors = await applyBehaviors(client, scope, documents.behaviors, personas.lookup, actor);
      const summary: CatalogImportSummary = { personas: personas.counts, behaviors, dryRun };
      if (dryRun) throw new DryRunRollback(summary);
      return summary;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.summary;
    throw error;
  }
}
