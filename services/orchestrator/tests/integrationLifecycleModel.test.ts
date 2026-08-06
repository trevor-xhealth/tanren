import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import { RoutesPool } from "./helpers/routesPool.js";

const root = new URL("../../../", import.meta.url);
const migrationPath = fileURLToPath(new URL("db/migrations/0043_integration_lifecycle.sql", root));
const snapshotPath = fileURLToPath(new URL("db/migrations/meta/0043_snapshot.json", root));
const schemaPaths = [
  "db/src/schemaIntegrationConnections.ts",
  "db/src/schemaIntegrationRequirements.ts",
  "db/src/schemaIntegrationBindings.ts",
  "db/src/schemaIntegrationOperations.ts",
  "db/src/schemaIntegrationEnvironment.ts",
  "db/src/schemaIntegrationSelection.ts",
  "db/src/schemaProjectDerivations.ts",
  "db/src/schemaCore.ts",
  "db/src/schema.ts",
  "db/src/schemaEvents.ts",
  "db/src/schemaIntegrationNodes.ts",
].map((path) => fileURLToPath(new URL(path, root)));

const TABLES = [
  "behavior_integration_requirements",
  "capability_node_dependencies",
  "capability_nodes",
  "delivery_run_bindings",
  "delivery_runs",
  "delivery_stage_attempts",
  "integration_binding_env",
  "integration_binding_generations",
  "integration_bindings",
  "integration_reconciliations",
  "integration_requirements",
  "integration_resource_snapshots",
  "integration_validation_proofs",
  "org_integration_connection_auth_generations",
  "org_integration_connection_operations",
  "org_integration_connections",
  "org_integration_grant_generations",
  "org_integration_grants",
  "project_app_env",
  "project_derivations",
  "project_integration_grant_selections",
  "spec_capability_dependencies",
] as const;

interface SnapshotTable {
  columns: Record<string, { notNull: boolean }>;
  indexes: Record<string, unknown>;
  foreignKeys: Record<string, unknown>;
  policies: Record<string, { name: string; as: string; for: string; to: string[]; using: string; withCheck: string }>;
  isRLSEnabled: boolean;
}

const derivingProjectAdmin: ActorContext = {
  userId: "user_deriving_admin",
  orgId: "org_deriving",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function derivingProjectRouteHarness(lifecycle: string) {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_deriving" });
  pool.seedMembership("org_deriving", derivingProjectAdmin.userId, "admin");
  pool.seedProject({ project_id: "project_deriving", org_id: "org_deriving", lifecycle });

  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return derivingProjectAdmin;
        },
      } as never,
      localDevActor: derivingProjectAdmin,
    }),
  );
  app.route("/orgs", createProjectRoutes({ pool: pool.asPgPool(), secrets: {} as never, githubHttp: {} as never }));
  return app;
}

describe("IN-1 P1 integration lifecycle schema contract", () => {
  let migration = "";
  let tables: Record<string, SnapshotTable> = {};
  let schemas = "";

  beforeAll(async () => {
    const [migrationSql, snapshotJson, ...schemaSources] = await Promise.all([
      readFile(migrationPath, "utf8"),
      readFile(snapshotPath, "utf8"),
      ...schemaPaths.map((path) => readFile(path, "utf8")),
    ]);
    migration = migrationSql;
    const parsed = JSON.parse(snapshotJson) as { tables: Record<string, SnapshotTable> };
    tables = parsed.tables;
    schemas = schemaSources.join("\n");
  });

  it("clean-replaces legacy authorities without a compatibility path", () => {
    expect(migration).toContain('DROP TABLE IF EXISTS "project_app_env" CASCADE');
    expect(migration).toContain('DROP TABLE IF EXISTS "org_integrations" CASCADE');
    expect(migration).not.toMatch(/CREATE (?:OR REPLACE )?VIEW/u);
    expect(migration).not.toContain('CREATE TABLE "org_integrations"');
    expect(migration).not.toContain('"binding_generations"');
    expect(tables).not.toHaveProperty("public.org_integrations");
  });

  it("performs no legacy-row transformation DML in the clean 0043 migration", () => {
    expect(migration).not.toMatch(/^\s*UPDATE\b/imu);
    expect(migration).not.toMatch(/^\s*DELETE\s+FROM\b/imu);
    expect(migration).not.toContain('UPDATE "inbox_sources"');
    expect(migration).not.toMatch(/config"\s*#>>\s*'\{attention/u);
    expect(migration).not.toContain("webhookSecretRef");
    expect(migration).toContain('ALTER TABLE "inbox_sources" ADD COLUMN "state"');
    expect(migration).toContain("inbox_sources_attention_check");
  });

  it("owns the complete P1 table model with direct indexed tenant roots", () => {
    expect(TABLES).toHaveLength(22);
    for (const tableName of TABLES) {
      expect(migration).toContain(`CREATE TABLE "${tableName}"`);
      const table = tables[`public.${tableName}`];
      if (table === undefined) throw new Error(`snapshot missing lifecycle table ${tableName}`);
      expect(table.columns["org_id"]).toMatchObject({ notNull: true });
      expect(Object.values(table.indexes).some((index) => JSON.stringify(index).includes('"org_id"'))).toBe(true);
    }
  });

  it("records one exact deny-by-default policy per table in Drizzle metadata and FORCE SQL", () => {
    for (const tableName of TABLES) {
      const table = tables[`public.${tableName}`]!;
      expect(table.isRLSEnabled).toBe(true);
      expect(Object.keys(table.policies)).toEqual(["rls_org_isolation"]);
      const policy = table.policies["rls_org_isolation"]!;
      const predicate = `"${tableName}"."org_id" = current_setting('app.current_org_id', true)`;
      expect(policy).toMatchObject({
        name: "rls_org_isolation",
        as: "PERMISSIVE",
        for: "ALL",
        to: ["public"],
        using: predicate,
        withCheck: predicate,
      });
      expect(migration).toContain(`ALTER TABLE "${tableName}" ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE "${tableName}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`CREATE POLICY "rls_org_isolation" ON "${tableName}"`);
    }
    expect(migration.match(/ FORCE ROW LEVEL SECURITY/gu)).toHaveLength(TABLES.length);
  });

  it("creates every composite FK target unique index before the first dependent FK", () => {
    const requiredBefore = [
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "projects_org_project_unique"',
        firstFk: 'CONSTRAINT "events_project_lineage_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "specs_org_spec_unique"',
        firstFk: 'CONSTRAINT "events_spec_tenant_lineage_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "runs_org_run_unique"',
        firstFk: 'CONSTRAINT "events_run_tenant_lineage_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "runs_org_spec_run_unique"',
        firstFk: 'CONSTRAINT "events_run_spec_lineage_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "runs_org_project_run_unique"',
        firstFk: 'CONSTRAINT "events_run_project_lineage_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "runs_org_project_spec_run_unique"',
        firstFk: 'CONSTRAINT "events_run_lineage_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "org_integration_connections_provider_id_unique"',
        firstFk: 'CONSTRAINT "project_integration_grant_selections_connection_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "org_integration_grants_connection_id_unique"',
        firstFk: 'CONSTRAINT "project_integration_grant_selections_grant_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "integration_requirements_project_id_unique"',
        firstFk: 'CONSTRAINT "capability_nodes_requirement_lineage_fk" FOREIGN KEY',
      },
      {
        uniqueIndex: 'CREATE UNIQUE INDEX "integration_binding_generations_binding_generation_unique"',
        firstFk: 'CONSTRAINT "integration_binding_env_binding_generation_fk" FOREIGN KEY',
      },
    ] as const;
    for (const { uniqueIndex, firstFk } of requiredBefore) {
      const indexAt = migration.indexOf(uniqueIndex);
      const fkAt = migration.indexOf(firstFk);
      expect(indexAt, `${uniqueIndex} missing`).toBeGreaterThanOrEqual(0);
      expect(fkAt, `${firstFk} missing`).toBeGreaterThanOrEqual(0);
      expect(indexAt).toBeLessThan(fkAt);
    }
  });

  it("pins the complete run/event/queue/claim ownership lineage in snapshot metadata", () => {
    const expected = {
      "public.specs": ["specs_project_lineage_fk"],
      "public.runs": ["runs_project_lineage_fk", "runs_spec_lineage_fk"],
      "public.merge_queue": [
        "merge_queue_project_lineage_fk",
        "merge_queue_spec_lineage_fk",
        "merge_queue_run_lineage_fk",
      ],
      "public.events": [
        "events_run_tenant_lineage_fk",
        "events_spec_tenant_lineage_fk",
        "events_project_lineage_fk",
        "events_run_spec_lineage_fk",
        "events_run_project_lineage_fk",
        "events_spec_lineage_fk",
        "events_run_lineage_fk",
      ],
      "public.post_merge_issue_claims": [
        "post_merge_issue_claims_project_lineage_fk",
        "post_merge_issue_claims_spec_lineage_fk",
        "post_merge_issue_claims_run_lineage_fk",
      ],
    } as const;
    for (const [tableName, constraints] of Object.entries(expected)) {
      const table = tables[tableName];
      if (table === undefined) throw new Error(`snapshot missing lineage table ${tableName}`);
      expect(Object.keys(table.foreignKeys)).toEqual(expect.arrayContaining([...constraints]));
    }
    expect(tables["public.events"]?.columns).toMatchObject({
      run_id: { notNull: false },
      spec_id: { notNull: false },
      project_id: { notNull: false },
    });
  });

  it("pins principal/generation authority and no fake dev provisioned bypass", () => {
    expect(migration).toContain("provider_principal_id");
    expect(migration).toContain("org_integration_connection_auth_generations");
    expect(migration).toContain("org_integration_grant_generations");
    expect(migration).toContain("delivery_run_bindings");
    expect(migration).toContain("project_derivations");
    expect(migration).toContain("projects_lifecycle_check");
    expect(migration).toContain("deriving");
    expect(migration).toContain('CONSTRAINT "project_app_env_binding_check"');
    expect(migration).not.toContain("manual-link.v1");
  });

  it("round-trips the migration-valid deriving lifecycle through the real repository and project route", async () => {
    const response = await derivingProjectRouteHarness("deriving").request(
      "/orgs/org_deriving/projects/project_deriving",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ projectId: "project_deriving", lifecycle: "deriving" });
  });

  it("fails closed when the repository reads a lifecycle outside the database contract", async () => {
    const response = await derivingProjectRouteHarness("provisioning").request(
      "/orgs/org_deriving/projects/project_deriving",
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });

  it("keeps all schema exports aligned and under the architecture line cap", async () => {
    const exports = [
      "orgIntegrationConnections",
      "orgIntegrationConnectionAuthGenerations",
      "orgIntegrationConnectionOperations",
      "orgIntegrationGrants",
      "orgIntegrationGrantGenerations",
      "integrationRequirements",
      "behaviorIntegrationRequirements",
      "capabilityNodes",
      "capabilityNodeDependencies",
      "specCapabilityDependencies",
      "integrationBindings",
      "integrationBindingGenerations",
      "integrationBindingEnv",
      "projectAppEnv",
      "projectIntegrationGrantSelections",
      "integrationReconciliations",
      "integrationResourceSnapshots",
      "deliveryRuns",
      "deliveryRunBindings",
      "deliveryStageAttempts",
      "integrationValidationProofs",
      "projectDerivations",
    ];
    for (const name of exports) expect(schemas).toContain(`export const ${name} = pgTable(`);
    for (const path of schemaPaths) {
      // Count lines the way the cap this mirrors counts them. `scripts/check-architecture.mjs`
      // (`file-line-max-500`) discounts the trailing newline; a bare `split("\n").length` counts
      // the empty string after it, so this asserted a silent 499 for every file in the repo (they
      // all end in a newline) and disagreed with the gate it exists to mirror. `schemaCore.ts` is
      // 499 real lines, read as 500 here — one byte from a failure that would have been wrong.
      // It DID fail under Stryker, whose sandbox copy carries an extra trailing newline, and the
      // response was to exclude this suite from every mutation run in `vitest.stryker.config.ts`.
      // Counting correctly fixes the cause, so that exclusion is gone and `stryker.full.mjs` keeps
      // this suite's coverage of `createProjectRoutes` (#1420 review, P3).
      const text = await readFile(path, "utf8");
      const lineCount = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(500);
    }
    expect(schemas).not.toContain("schemaIntegrationLifecycle");
  });
});
