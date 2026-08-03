// NEGATIVE CONTROL for the `tanren.behavior.v0` / `tanren.persona.v0` catalog importer,
// against REAL Postgres on the restricted (NOBYPASSRLS) `tanren_app` role. It proves:
//   1. The decisive writes run as non-superuser, non-bypassrls tanren_app.
//   2. A whole synthetic catalog imports and is queryable with its OWN identity
//      (the stable `B-####` id), its ORDERED persona links, and its ORDERED
//      cross-references intact — nothing is lost at the door.
//   3. The projected BDD row carries the outcomes as `then` and the intent as
//      `description`, and leaves `given`/`when` HONESTLY EMPTY — the source schema
//      has no such concept, so nothing is invented (honest absence over invention).
//   4. An unresolvable persona slug FAILS LOUDLY and writes NOTHING (whole-import
//      transaction rolls back) — the behavior is never silently dropped.
//   5. A duplicate `B-####` id in one payload FAILS LOUDLY and writes NOTHING.
//   6. Re-importing the unchanged catalog is IDEMPOTENT — asserted on ROW COUNTS,
//      not merely on the absence of an error.
//   7. Cross-org reads see ZERO rows (RLS deny-by-default, FORCEd).
import { migrate, runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { CatalogImportError, importCatalog } from "../src/engine/catalog/importCatalog.js";
import { CatalogStore } from "../src/engine/catalog/store.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createCatalogRoutes } from "../src/routes/catalog/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_catalog_rls";
const OTHER_ORG = "org_catalog_rls_other";
const PROJECT = "project_catalog_rls";

const ACTOR: ActorContext = {
  userId: "user_catalog_rls",
  orgId: ORG,
  projectId: null,
  scopes: ["org:admin"],
  source: "local_dev",
};

function databaseName(): string {
  return `tanren_catalog_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function connectionUrl(database: string, role?: { user: string; password: string }): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${database}`;
  if (role !== undefined) {
    parsed.username = role.user;
    parsed.password = role.password;
  }
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// A small SYNTHETIC catalog in the exact `tanren.behavior.v0` /
// `tanren.persona.v0` shape. Deliberately domain-neutral: the importer must
// serve ANY catalog in this format, so nothing here names a real product.
// ---------------------------------------------------------------------------

function personaDoc(slug: string, name: string, world: string, aliases: readonly string[]) {
  return {
    path: `docs/personas/${slug}.md`,
    text: `---
schema: tanren.persona.v0
slug: ${slug}
name: "${name}"
world: ${world}
aliases: [${aliases.join(", ")}]
---

## Core job

${name} keeps the line running and answers for what it did.

## Motivations

- Finish the shift without a surprise.

## Concerns

- Being blamed for a machine's decision.

## Trust requirements

- Every number can be traced to where it came from.

## Authority and influence

- Can stop the line; cannot change the contract.

## Distinct from

- The scheduler, who plans but does not operate.

## Language they use

- "the line", "the run", "the stop".

## Notes

- Optional nuance.
`,
  };
}

function behaviorDoc(args: {
  id: string;
  slug: string;
  initiative: string;
  title: string;
  personas: readonly string[];
  provenance: readonly string[];
  authors: readonly string[];
  related: readonly string[];
  outcomes: readonly string[];
}) {
  const relatedBody = args.related.map((id) => `- ${id}`).join("\n");
  return {
    path: `docs/behaviors/${args.id}-${args.slug}.md`,
    text: `---
schema: tanren.behavior.v0
id: ${args.id}
initiative: ${args.initiative}
title: ${args.title}
personas: [${args.personas.join(", ")}]
provenance: [${args.provenance.join(", ")}]
authors: [${args.authors.join(", ")}]
related: [${args.related.join(", ")}]
---

## Intent

I need ${args.title.toLowerCase()} so that the shift ends without a surprise.

## Observable outcomes

${args.outcomes.map((outcome) => `- ${outcome}`).join("\n")}

## Related

${relatedBody}
`,
  };
}

const PERSONA_DOCS = [
  personaDoc("operator", "Line operator", "floor", ["operator", "line-op"]),
  personaDoc("auditor", "Independent auditor", "oversight", []),
];

const BEHAVIOR_DOCS = [
  behaviorDoc({
    id: "B-0001",
    slug: "i-see-the-current-queue-depth",
    initiative: "steady-state",
    title: "I see the current queue depth",
    personas: ["operator", "auditor"],
    provenance: ["SRC-0007", "SRC-0009"],
    authors: ["Ada", "Grace"],
    related: ["B-0002", "B-0003"],
    outcomes: ["I see the queue depth as of a stated instant.", "I can tell whether the figure is stale."],
  }),
  behaviorDoc({
    id: "B-0002",
    slug: "i-can-stop-the-line",
    initiative: "steady-state",
    title: "I can stop the line",
    personas: ["operator"],
    provenance: [],
    authors: [],
    related: ["B-0001"],
    outcomes: ["The line stops within the stated window."],
  }),
  behaviorDoc({
    id: "B-0003",
    slug: "i-can-replay-any-decision",
    initiative: "accountability",
    title: "I can replay any decision",
    personas: ["auditor", "operator"],
    provenance: ["SRC-0031"],
    authors: ["Grace"],
    related: [],
    outcomes: ["I can reconstruct the inputs behind a decision.", "I can see who signed it off."],
  }),
];

const CATALOG = [...PERSONA_DOCS, ...BEHAVIOR_DOCS];

async function seedTenant(owner: Pool): Promise<void> {
  for (const org of [ORG, OTHER_ORG]) {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [org],
    );
  }
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
}

interface CatalogRowCounts {
  personas: number;
  behaviors: number;
  personaLinks: number;
  relations: number;
  projectedBehaviors: number;
  projectedPersonas: number;
}

async function rowCounts(app: Pool): Promise<CatalogRowCounts> {
  return await runWithOrgScope(app, ORG, async (client) => {
    const result = await client.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM catalog_personas) AS personas,
         (SELECT count(*) FROM catalog_behaviors) AS behaviors,
         (SELECT count(*) FROM catalog_behavior_personas) AS persona_links,
         (SELECT count(*) FROM catalog_behavior_relations) AS relations,
         (SELECT count(*) FROM behaviors) AS projected_behaviors,
         (SELECT count(*) FROM personas) AS projected_personas`,
    );
    const row = result.rows[0] ?? {};
    return {
      personas: Number(row["personas"]),
      behaviors: Number(row["behaviors"]),
      personaLinks: Number(row["persona_links"]),
      relations: Number(row["relations"]),
      projectedBehaviors: Number(row["projected_behaviors"]),
      projectedPersonas: Number(row["projected_personas"]),
    };
  });
}

describeDb("tanren.behavior.v0 catalog import — real Postgres, tanren_app role", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner);
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("runs the decisive writes as the non-superuser, non-bypassrls tanren_app role", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("imports the catalog and keeps identity, persona links and cross-references intact", async () => {
    const summary = await importCatalog(app, { orgId: ORG, projectId: PROJECT, documents: CATALOG }, ACTOR);
    expect(summary.personas).toEqual({ created: 2, updated: 0, unchanged: 0 });
    expect(summary.behaviors).toEqual({ created: 3, updated: 0, unchanged: 0 });

    const record = await runWithOrgScope(app, ORG, async (client) =>
      CatalogStore.getBehavior(client, { orgId: ORG, projectId: PROJECT, catalogId: "B-0001" }),
    );
    expect(record).toBeDefined();
    // IDENTITY — the catalog's own stable, sparse id survives the door.
    expect(record?.catalogId).toBe("B-0001");
    expect(record?.schemaVersion).toBe("tanren.behavior.v0");
    expect(record?.initiative).toBe("steady-state");
    expect(record?.title).toBe("I see the current queue depth");
    expect(record?.provenance).toEqual(["SRC-0007", "SRC-0009"]);
    expect(record?.authors).toEqual(["Ada", "Grace"]);
    expect(record?.outcomes).toEqual([
      "I see the queue depth as of a stated instant.",
      "I can tell whether the figure is stale.",
    ]);
    // PERSONA LINKS — the whole ordered list, primary first (not just the first slug).
    expect(record?.personaSlugs).toEqual(["operator", "auditor"]);
    expect(record?.personaIds).toHaveLength(2);
    // CROSS-REFERENCES — ordered exactly as the frontmatter declared them.
    expect(record?.related).toEqual(["B-0002", "B-0003"]);

    // The projected BDD row: outcomes -> then, intent -> description, and
    // given/when HONESTLY EMPTY (the source schema has no such concept).
    const projected = await runWithOrgScope(app, ORG, async (client) => {
      const result = await client.query<{ given: string; when: string; then: string; description: string }>(
        `SELECT given, "when", "then", description FROM behaviors WHERE id = $1`,
        [record?.behaviorId],
      );
      return result.rows[0];
    });
    expect(projected?.given).toBe("");
    expect(projected?.when).toBe("");
    expect(projected?.then).toContain("I see the queue depth as of a stated instant.");
    expect(projected?.description).toContain("so that the shift ends without a surprise");
  });

  it("serves the same catalog over HTTP, and a dry run commits nothing", async () => {
    const http = new Hono<ActorContextEnv>();
    http.use("*", async (context, next) => {
      context.set("actor", ACTOR);
      await next();
    });
    http.route("/orgs", createCatalogRoutes({ pool: app }));

    const read = await http.request(`/orgs/${ORG}/projects/${PROJECT}/catalog/behaviors/B-0003`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      catalogId: "B-0003",
      personaSlugs: ["auditor", "operator"],
      related: [],
    });

    const before = await rowCounts(app);
    const dryRun = await http.request(`/orgs/${ORG}/projects/${PROJECT}/catalog/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [
          ...CATALOG,
          behaviorDoc({
            id: "B-0009",
            slug: "i-exist-only-in-a-dry-run",
            initiative: "steady-state",
            title: "I exist only in a dry run",
            personas: ["operator"],
            provenance: [],
            authors: [],
            related: [],
            outcomes: ["Nothing is committed."],
          }),
        ],
        dryRun: true,
      }),
    });
    expect(dryRun.status).toBe(200);
    expect(await dryRun.json()).toMatchObject({ behaviors: { created: 1 }, dryRun: true });
    expect(await rowCounts(app)).toEqual(before);
  });

  it("FAILS LOUDLY on an unresolvable persona slug and writes nothing", async () => {
    const before = await rowCounts(app);
    const orphan = behaviorDoc({
      id: "B-0004",
      slug: "i-depend-on-a-persona-that-does-not-exist",
      initiative: "steady-state",
      title: "I depend on a persona that does not exist",
      personas: ["ghost"],
      provenance: [],
      authors: [],
      related: [],
      outcomes: ["Nothing should be written."],
    });
    await expect(
      importCatalog(app, { orgId: ORG, projectId: PROJECT, documents: [...CATALOG, orphan] }, ACTOR),
    ).rejects.toThrow(CatalogImportError);
    await expect(
      importCatalog(app, { orgId: ORG, projectId: PROJECT, documents: [...CATALOG, orphan] }, ACTOR),
    ).rejects.toThrow(/ghost/u);
    expect(await rowCounts(app)).toEqual(before);
  });

  it("FAILS LOUDLY on a dangling `related` cross-reference and writes nothing", async () => {
    const before = await rowCounts(app);
    const dangling = behaviorDoc({
      id: "B-0005",
      slug: "i-relate-to-a-behavior-that-does-not-exist",
      initiative: "steady-state",
      title: "I relate to a behavior that does not exist",
      personas: ["operator"],
      provenance: [],
      authors: [],
      related: ["B-9999"],
      outcomes: ["Nothing should be written."],
    });
    await expect(
      importCatalog(app, { orgId: ORG, projectId: PROJECT, documents: [...CATALOG, dangling] }, ACTOR),
    ).rejects.toThrow(/B-9999/u);
    expect(await rowCounts(app)).toEqual(before);
  });

  it("DATABASE TEETH: the composite same-org FKs reject an unresolvable link even if application code let it through", async () => {
    await expect(
      runWithOrgScope(app, ORG, async (client) =>
        client.query(
          `INSERT INTO catalog_behavior_personas (org_id, project_id, catalog_id, persona_slug, ordinal)
           VALUES ($1, $2, 'B-0001', 'ghost', 99)`,
          [ORG, PROJECT],
        ),
      ),
    ).rejects.toThrow(/catalog_behavior_personas_persona_fk/u);
    await expect(
      runWithOrgScope(app, ORG, async (client) =>
        client.query(
          `INSERT INTO catalog_behavior_relations (org_id, project_id, catalog_id, related_catalog_id, ordinal)
           VALUES ($1, $2, 'B-0001', 'B-9999', 99)`,
          [ORG, PROJECT],
        ),
      ),
    ).rejects.toThrow(/catalog_behavior_relations_target_fk/u);
  });

  it("FAILS LOUDLY on a duplicate B-#### id and writes nothing", async () => {
    const before = await rowCounts(app);
    const duplicate = behaviorDoc({
      id: "B-0001",
      slug: "i-am-a-second-file-claiming-the-same-id",
      initiative: "steady-state",
      title: "I am a second file claiming the same id",
      personas: ["operator"],
      provenance: [],
      authors: [],
      related: [],
      outcomes: ["Nothing should be written."],
    });
    await expect(
      importCatalog(app, { orgId: ORG, projectId: PROJECT, documents: [...CATALOG, duplicate] }, ACTOR),
    ).rejects.toThrow(/B-0001/u);
    expect(await rowCounts(app)).toEqual(before);
  });

  it("IDEMPOTENT: re-importing the unchanged catalog leaves every row count identical", async () => {
    const before = await rowCounts(app);
    const summary = await importCatalog(app, { orgId: ORG, projectId: PROJECT, documents: CATALOG }, ACTOR);
    expect(summary.personas).toEqual({ created: 0, updated: 0, unchanged: 2 });
    expect(summary.behaviors).toEqual({ created: 0, updated: 0, unchanged: 3 });
    expect(await rowCounts(app)).toEqual(before);
    // And once more, to prove stability is not a one-shot accident.
    await importCatalog(app, { orgId: ORG, projectId: PROJECT, documents: CATALOG }, ACTOR);
    expect(await rowCounts(app)).toEqual(before);
  });

  it("RLS: a cross-org caller sees ZERO catalog rows", async () => {
    const visible = await runWithOrgScope(app, OTHER_ORG, async (client) => {
      const result = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM catalog_behaviors");
      return Number(result.rows[0]?.count);
    });
    expect(visible).toBe(0);
    const unscoped = await CatalogStore.getBehavior(app, { orgId: ORG, projectId: PROJECT, catalogId: "B-0001" });
    expect(unscoped).toBeUndefined();
  });
});
