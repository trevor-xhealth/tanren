// Persistence for imported `tanren.behavior.v0` / `tanren.persona.v0` documents.
//
// Every statement here is org-keyed and expects to run on a client already inside
// `runWithOrgScope` (RLS is FORCEd on all four catalog tables, so an unscoped
// caller reads zero rows and writes are rejected). Rows are decoded through Zod
// on the way out — never cast.

import { z } from "zod";
import type pg from "pg";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface CatalogScope {
  readonly orgId: string;
  readonly projectId: string;
}

const StringList = z.array(z.string());

export const CatalogPersonaLink = z.object({
  slug: z.string().min(1),
  personaId: z.string().min(1),
});
export type CatalogPersonaLink = z.infer<typeof CatalogPersonaLink>;

export const CatalogBehaviorRecord = z.object({
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  catalogId: z.string().min(1),
  schemaVersion: z.string().min(1),
  initiative: z.string().min(1),
  title: z.string().min(1),
  intent: z.string(),
  outcomes: StringList,
  provenance: StringList,
  authors: StringList,
  behaviorId: z.string().min(1),
  sourcePath: z.string().min(1),
  sourceDigest: z.string().min(1),
  personaSlugs: StringList,
  personaIds: StringList,
  related: StringList,
});
export type CatalogBehaviorRecord = z.infer<typeof CatalogBehaviorRecord>;

const RawBehaviorRecord = z.object({
  org_id: z.string(),
  project_id: z.string(),
  catalog_id: z.string(),
  schema_version: z.string(),
  initiative: z.string(),
  title: z.string(),
  intent: z.string(),
  outcomes: StringList,
  provenance: StringList,
  authors: StringList,
  behavior_id: z.string(),
  source_path: z.string(),
  source_digest: z.string(),
  personas: z.array(CatalogPersonaLink),
  related: StringList,
});

const SELECT_BEHAVIOR_RECORD = `
  SELECT b.org_id, b.project_id, b.catalog_id, b.schema_version, b.initiative, b.title, b.intent,
         b.outcomes, b.provenance, b.authors, b.behavior_id, b.source_path, b.source_digest,
         COALESCE((
           SELECT json_agg(json_build_object('slug', link.persona_slug, 'personaId', doc.persona_id)
                           ORDER BY link.ordinal)
           FROM catalog_behavior_personas AS link
           JOIN catalog_personas AS doc
             ON doc.org_id = link.org_id AND doc.project_id = link.project_id AND doc.slug = link.persona_slug
           WHERE link.org_id = b.org_id AND link.project_id = b.project_id AND link.catalog_id = b.catalog_id
         ), '[]'::json) AS personas,
         COALESCE((
           SELECT json_agg(edge.related_catalog_id ORDER BY edge.ordinal)
           FROM catalog_behavior_relations AS edge
           WHERE edge.org_id = b.org_id AND edge.project_id = b.project_id AND edge.catalog_id = b.catalog_id
         ), '[]'::json) AS related
  FROM catalog_behaviors AS b
`;

function decodeBehaviorRecord(raw: unknown): CatalogBehaviorRecord {
  const row = RawBehaviorRecord.parse(raw);
  return CatalogBehaviorRecord.parse({
    orgId: row.org_id,
    projectId: row.project_id,
    catalogId: row.catalog_id,
    schemaVersion: row.schema_version,
    initiative: row.initiative,
    title: row.title,
    intent: row.intent,
    outcomes: row.outcomes,
    provenance: row.provenance,
    authors: row.authors,
    behaviorId: row.behavior_id,
    sourcePath: row.source_path,
    sourceDigest: row.source_digest,
    personaSlugs: row.personas.map((link) => link.slug),
    personaIds: row.personas.map((link) => link.personaId),
    related: row.related,
  });
}

export interface CatalogPersonaState {
  readonly personaId: string;
  readonly sourceDigest: string;
}

export interface CatalogBehaviorState {
  readonly behaviorId: string;
  readonly sourceDigest: string;
}

export interface CatalogPersonaWrite {
  readonly slug: string;
  readonly schemaVersion: string;
  readonly name: string;
  readonly world: string;
  readonly aliases: readonly string[];
  readonly sections: readonly { readonly heading: string; readonly body: string }[];
  readonly personaId: string;
  readonly sourcePath: string;
  readonly sourceDigest: string;
}

export interface CatalogBehaviorWrite {
  readonly catalogId: string;
  readonly schemaVersion: string;
  readonly initiative: string;
  readonly title: string;
  readonly intent: string;
  readonly outcomes: readonly string[];
  readonly provenance: readonly string[];
  readonly authors: readonly string[];
  readonly behaviorId: string;
  readonly sourcePath: string;
  readonly sourceDigest: string;
}

export const CatalogStore = {
  /** Existing persona documents for the scope, keyed by the catalog's slug. */
  async readPersonaState(client: QueryClient, scope: CatalogScope): Promise<Map<string, CatalogPersonaState>> {
    const result = await client.query<{ slug: string; persona_id: string; source_digest: string }>(
      "SELECT slug, persona_id, source_digest FROM catalog_personas WHERE org_id = $1 AND project_id = $2",
      [scope.orgId, scope.projectId],
    );
    return new Map(
      result.rows.map((row) => [row.slug, { personaId: row.persona_id, sourceDigest: row.source_digest }]),
    );
  },

  /** Existing behavior documents for the scope, keyed by the catalog's `B-####`. */
  async readBehaviorState(client: QueryClient, scope: CatalogScope): Promise<Map<string, CatalogBehaviorState>> {
    const result = await client.query<{ catalog_id: string; behavior_id: string; source_digest: string }>(
      "SELECT catalog_id, behavior_id, source_digest FROM catalog_behaviors WHERE org_id = $1 AND project_id = $2",
      [scope.orgId, scope.projectId],
    );
    return new Map(
      result.rows.map((row) => [row.catalog_id, { behaviorId: row.behavior_id, sourceDigest: row.source_digest }]),
    );
  },

  async writePersona(client: QueryClient, scope: CatalogScope, document: CatalogPersonaWrite): Promise<void> {
    await client.query(
      `INSERT INTO catalog_personas
         (org_id, project_id, slug, schema_version, name, world, aliases, sections, persona_id,
          source_path, source_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
       ON CONFLICT (org_id, project_id, slug) DO UPDATE SET
         schema_version = EXCLUDED.schema_version,
         name = EXCLUDED.name,
         world = EXCLUDED.world,
         aliases = EXCLUDED.aliases,
         sections = EXCLUDED.sections,
         source_path = EXCLUDED.source_path,
         source_digest = EXCLUDED.source_digest,
         updated_at = now()`,
      [
        scope.orgId,
        scope.projectId,
        document.slug,
        document.schemaVersion,
        document.name,
        document.world,
        JSON.stringify(document.aliases),
        JSON.stringify(document.sections),
        document.personaId,
        document.sourcePath,
        document.sourceDigest,
      ],
    );
  },

  async writeBehavior(client: QueryClient, scope: CatalogScope, document: CatalogBehaviorWrite): Promise<void> {
    await client.query(
      `INSERT INTO catalog_behaviors
         (org_id, project_id, catalog_id, schema_version, initiative, title, intent, outcomes,
          provenance, authors, behavior_id, source_path, source_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13)
       ON CONFLICT (org_id, project_id, catalog_id) DO UPDATE SET
         schema_version = EXCLUDED.schema_version,
         initiative = EXCLUDED.initiative,
         title = EXCLUDED.title,
         intent = EXCLUDED.intent,
         outcomes = EXCLUDED.outcomes,
         provenance = EXCLUDED.provenance,
         authors = EXCLUDED.authors,
         source_path = EXCLUDED.source_path,
         source_digest = EXCLUDED.source_digest,
         updated_at = now()`,
      [
        scope.orgId,
        scope.projectId,
        document.catalogId,
        document.schemaVersion,
        document.initiative,
        document.title,
        document.intent,
        JSON.stringify(document.outcomes),
        JSON.stringify(document.provenance),
        JSON.stringify(document.authors),
        document.behaviorId,
        document.sourcePath,
        document.sourceDigest,
      ],
    );
  },

  /**
   * Replace a behavior's ordered persona links. The persona foreign key is what
   * makes an unresolvable slug fail at the DATABASE, not merely in application code.
   */
  async writePersonaLinks(
    client: QueryClient,
    scope: CatalogScope,
    catalogId: string,
    slugs: readonly string[],
  ): Promise<void> {
    await client.query(
      "DELETE FROM catalog_behavior_personas WHERE org_id = $1 AND project_id = $2 AND catalog_id = $3",
      [scope.orgId, scope.projectId, catalogId],
    );
    for (const [ordinal, slug] of slugs.entries()) {
      await client.query(
        `INSERT INTO catalog_behavior_personas (org_id, project_id, catalog_id, persona_slug, ordinal)
         VALUES ($1, $2, $3, $4, $5)`,
        [scope.orgId, scope.projectId, catalogId, slug, ordinal],
      );
    }
  },

  /** Replace a behavior's ordered `related` edges. */
  async writeRelations(
    client: QueryClient,
    scope: CatalogScope,
    catalogId: string,
    related: readonly string[],
  ): Promise<void> {
    await client.query(
      "DELETE FROM catalog_behavior_relations WHERE org_id = $1 AND project_id = $2 AND catalog_id = $3",
      [scope.orgId, scope.projectId, catalogId],
    );
    for (const [ordinal, target] of related.entries()) {
      await client.query(
        `INSERT INTO catalog_behavior_relations (org_id, project_id, catalog_id, related_catalog_id, ordinal)
         VALUES ($1, $2, $3, $4, $5)`,
        [scope.orgId, scope.projectId, catalogId, target, ordinal],
      );
    }
  },

  /** Refresh the projected BDD row for an already-imported behavior. */
  async refreshProjection(
    client: QueryClient,
    projection: {
      readonly behaviorId: string;
      readonly personaId: string;
      readonly title: string;
      readonly outcomes: string;
      readonly intent: string;
      readonly metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `UPDATE behaviors
          SET persona_id = $2, title = $3, "then" = $4, description = $5, metadata = $6::jsonb, updated_at = now()
        WHERE id = $1`,
      [
        projection.behaviorId,
        projection.personaId,
        projection.title,
        projection.outcomes,
        projection.intent,
        JSON.stringify(projection.metadata),
      ],
    );
  },

  /** Refresh the projected persona row for an already-imported persona document. */
  async refreshPersonaProjection(
    client: QueryClient,
    projection: { readonly personaId: string; readonly name: string; readonly description: string },
  ): Promise<void> {
    await client.query("UPDATE personas SET name = $2, description = $3, updated_at = now() WHERE id = $1", [
      projection.personaId,
      projection.name,
      projection.description,
    ]);
  },

  async getBehavior(
    client: QueryClient,
    args: CatalogScope & { readonly catalogId: string },
  ): Promise<CatalogBehaviorRecord | undefined> {
    const result = await client.query(
      `${SELECT_BEHAVIOR_RECORD} WHERE b.org_id = $1 AND b.project_id = $2 AND b.catalog_id = $3`,
      [args.orgId, args.projectId, args.catalogId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodeBehaviorRecord(row);
  },

  async listBehaviors(client: QueryClient, scope: CatalogScope): Promise<CatalogBehaviorRecord[]> {
    const result = await client.query(
      `${SELECT_BEHAVIOR_RECORD} WHERE b.org_id = $1 AND b.project_id = $2 ORDER BY b.catalog_id`,
      [scope.orgId, scope.projectId],
    );
    return result.rows.map((row) => decodeBehaviorRecord(row));
  },
} as const;
