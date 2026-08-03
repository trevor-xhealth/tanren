// cspell:ignore rolsuper rolbypassrls
// rv-23 — real-Postgres proof for the runtime-verification DASHBOARD read surface.
// Every decisive read runs as the restricted non-superuser `tanren_app` role
// (rolsuper=false AND rolbypassrls=false); the owner connection only provisions
// the DB and seeds FK prerequisites. Gated on TANREN_RLS_DB_TEST like every peer
// *.rls.integration test. Proves: the Behavior Proof Matrix distinguishes the
// PREVIEW plane from the PRODUCTION plane, a FAILED verdict is surfaced AS failed
// (no laundering), a quarantine is surfaced AS quarantined (never green), and a
// cross-org read sees ZERO rows on EVERY surface (org isolation at the DB, through
// the real route and directly through the store).

import { migrate, runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { ProofDashboardReadStore } from "../src/engine/verification/acceptance/proofDashboardReadStore.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createProofDashboardReadRoutes } from "../src/routes/proofDashboard/reads.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_pd_a";
const ORG_B = "org_pd_b";
const PROJECT = "project_pd";
const NODE_ID = "inode_pd";
const ENV_ID = "venv_pd";
const PERSONA = "persona_pd";
const PERSONA_REVISION = "pr_pd";
const BEHAVIOR = "behavior_pd";
const BEHAVIOR_REVISION = "br_pd";
const SPEC = "spec_pd";
const RUN_PREVIEW = "run_pd_preview";
const RUN_PROD = "run_pd_prod";
const D = `sha256:${"c".repeat(64)}`;
const CAS = `sha256:${"a".repeat(64)}`;
const H2 = `sha256:${"b".repeat(64)}`;

const ACTOR_A: ActorContext = {
  userId: "user_a",
  orgId: ORG_A,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function databaseName(): string {
  return `tanren_proof_dashboard_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function seedOrg(owner: Pool, org: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [org],
  );
}

async function seedRun(owner: Pool, runId: string, purpose: string): Promise<void> {
  await owner.query(
    `INSERT INTO behavior_verification_runs (org_id, id, project_id, purpose, environment_id, prepared_head_sha, jj_tree_id, plan_set_hash, runtime_behavior_context_hash, artifact_digest, status, policy)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $6, $7, 'completed', '{}'::jsonb)`,
    [ORG_A, runId, PROJECT, purpose, ENV_ID, D, CAS],
  );
}

async function seedVerdict(owner: Pool, id: string, runId: string, outcome: string, executed: number): Promise<void> {
  const required = 3;
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO behavior_verdicts
         (org_id, id, project_id, run_id, behavior_revision_id, example_hash, matrix_hash,
          required_assertion_count, executed_assertion_count, outcome, attempt_count,
          flake_state, gate_effect, artifact_digest, runtime_behavior_context_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, 1, 'stable', 'blocking', $10, $6)`,
      [ORG_A, id, PROJECT, runId, BEHAVIOR_REVISION, D, required, executed, outcome, CAS],
    );
    await client.query(
      `INSERT INTO behavior_verdict_attempts (org_id, verdict_id, attempt_ordinal, outcome)
       VALUES ($1, $2, 1, $3)`,
      [ORG_A, id, outcome],
    );
    await client.query(
      `INSERT INTO behavior_verdict_assertions (org_id, verdict_id, assertion_id, executed, passed)
       SELECT $1, $2, 'assertion_' || series::text, series <= $4,
              CASE WHEN series <= $4 THEN true ELSE NULL END
         FROM generate_series(1, $3) AS series`,
      [ORG_A, id, required, executed],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function seedTenant(owner: Pool): Promise<void> {
  await seedOrg(owner, ORG_A);
  await seedOrg(owner, ORG_B);
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG_A],
  );
  await owner.query(
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-pd')`,
    [NODE_ID, PROJECT, ORG_A, D],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
    [ORG_A, CAS, Buffer.from([0])],
  );
  await owner.query(
    `INSERT INTO personas (id, scope, org_id, project_id, name, description)
     VALUES ($1, 'project', $2, $3, 'persona', 'persona')`,
    [PERSONA, ORG_A, PROJECT],
  );
  await owner.query(
    `INSERT INTO behaviors (id, persona_id, title, given, "when", "then")
     VALUES ($1, $2, 'behavior', 'g', 'w', 't')`,
    [BEHAVIOR, PERSONA],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 't', 'd', 'open')`,
    [SPEC, PROJECT, ORG_A],
  );
  await owner.query(`INSERT INTO spec_behaviors (spec_id, behavior_id) VALUES ($1, $2)`, [SPEC, BEHAVIOR]);
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, $4, 'project', 1, 'persona', 'persona', $5)`,
    [PERSONA_REVISION, ORG_A, PROJECT, PERSONA, D],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest, design_contract_digest)
     VALUES ($1, $2, $3, $4, $5, 1, 'behavior', 'g', 'w', 't', $6, $7)`,
    [BEHAVIOR_REVISION, ORG_A, PROJECT, BEHAVIOR, PERSONA_REVISION, D, H2],
  );
  await owner.query(
    `INSERT INTO verification_environments (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'container', $6, $6, 'ready')`,
    [ORG_A, ENV_ID, PROJECT, NODE_ID, CAS, D],
  );
  await seedRun(owner, RUN_PREVIEW, "pre_merge");
  await seedRun(owner, RUN_PROD, "post_merge_production");
  await seedVerdict(owner, "verdict_pd_preview", RUN_PREVIEW, "passed", 3);
  await seedVerdict(owner, "verdict_pd_prod", RUN_PROD, "failed_product", 0);

  // Effect observations (causality viewer): one ok, one missing.
  await owner.query(
    `INSERT INTO behavior_effect_observations (org_id, project_id, observation_id, observer, provider, classification, occurrence_count)
     VALUES ($1, $2, 'obs_ok', 'slack-observer', 'slack', 'ok', 1),
            ($1, $2, 'obs_missing', 'slack-observer', 'slack', 'missing', 0)`,
    [ORG_A, PROJECT],
  );

  // Design-render (visual) verdict.
  await owner.query(
    `INSERT INTO design_render_land_verdicts
       (org_id, project_id, id, design_system_id, release_id, design_contract_version, accessibility_standard,
        outcome, checkpoint_count, passed_count, failed_count, inconclusive_count, excluded_count, failing_rule_ids, checkpoints)
     VALUES ($1, $2, 'drv_pd', 'ds_pd', 'rel_pd', 'v1', 'wcag21aa', 'failed_visual', 2, 1, 1, 0, 0, '["color-contrast"]'::jsonb, '[]'::jsonb)`,
    [ORG_A, PROJECT],
  );

  // Merge-queue regression bisection (localized culprit).
  await owner.query(
    `INSERT INTO behavior_regression_bisections
       (org_id, project_id, id, behavior_revision_id, failing_release_instance_id, failing_verdict_id, artifact_digest,
        integration_node_id, status, culprit_release_instance_id, culprit_integration_node_id, candidate_count, probe_count)
     VALUES ($1, $2, 'bis_pd', $3, 'rel_fail', 'verdict_pd_prod', $4, $5, 'localized', 'rel_culprit', $5, 3, 5)`,
    [ORG_A, PROJECT, BEHAVIOR_REVISION, CAS, NODE_ID],
  );

  // Flake quarantine (put INTO quarantine — excluded_from_green, flaky). `epoch` is the
  // mq-7 code-generation epoch (migration 0091, NOT NULL + sha256 CHECK); it matches the
  // artifact digest the seeded verdicts were produced from.
  await owner.query(
    `INSERT INTO behavior_flake_quarantines
       (org_id, project_id, id, behavior_revision_id, transition, gate_effect, classification, reason, actor, evidence, context_hash, epoch)
     VALUES ($1, $2, 'q_pd', $3, 'quarantine', 'excluded_from_green', 'flaky', 'flip observed', 'auto', '[{"verdictId":"v1","outcome":"passed"}]'::jsonb, $4, $5)`,
    [ORG_A, PROJECT, BEHAVIOR_REVISION, D, CAS],
  );
}

function appFor(pool: Pool, actor: ActorContext): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/v1/orgs", createProofDashboardReadRoutes({ pool }));
  return app;
}

describeDb("rv-23 runtime-verification dashboard read surface — real reads, isolation", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let store: ProofDashboardReadStore;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner);
    store = new ProofDashboardReadStore(app);
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

  it("runs the decisive reads as the non-superuser tanren_app role", async () => {
    const identity = await runWithOrgScope(app, ORG_A, (client) =>
      client.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
      ),
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("the Behavior Proof Matrix distinguishes preview (passed) from production (FAILED), never laundering", async () => {
    const response = await appFor(app, ACTOR_A).request(`/v1/orgs/${ORG_A}/projects/${PROJECT}/behavior-proof-matrix`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      version: string;
      rows: {
        behaviorRevisionId: string;
        latestPreview: { outcome: string } | null;
        latestProduction: { outcome: string } | null;
        lastProvenArtifactDigest: string | null;
        quarantined: boolean;
        owningSpecIds: string[];
        designContractDigest: string | null;
      }[];
    };
    expect(body.version).toBe("v1");
    const row = body.rows.find((r) => r.behaviorRevisionId === BEHAVIOR_REVISION);
    expect(row?.latestPreview?.outcome).toBe("passed");
    expect(row?.latestProduction?.outcome).toBe("failed_product");
    // Production never passed → no proven artifact (unproven, not green).
    expect(row?.lastProvenArtifactDigest).toBeNull();
    expect(row?.quarantined).toBe(true);
    expect(row?.owningSpecIds).toEqual([SPEC]);
    expect(row?.designContractDigest).toBe(H2);
  });

  it("effect-causality tallies ok/missing and lists provider observations", async () => {
    const summary = await store.readEffectCausality({ orgId: ORG_A, projectId: PROJECT });
    expect(summary.okCount).toBe(1);
    expect(summary.missingCount).toBe(1);
    expect(summary.observations).toHaveLength(2);
  });

  it("design-render surfaces the failed_visual verdict AS failed", async () => {
    const verdicts = await store.readDesignRenderVerdicts({ orgId: ORG_A, projectId: PROJECT });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.outcome).toBe("failed_visual");
    expect(verdicts[0]?.failingRuleIds).toEqual(["color-contrast"]);
  });

  it("regression bisections surface a localized culprit", async () => {
    const bisections = await store.readRegressionBisections({ orgId: ORG_A, projectId: PROJECT });
    expect(bisections).toHaveLength(1);
    expect(bisections[0]?.status).toBe("localized");
    expect(bisections[0]?.culpritReleaseInstanceId).toBe("rel_culprit");
  });

  it("flake quarantines surface the current quarantined state, never a green effect", async () => {
    const quarantines = await store.readFlakeQuarantines({ orgId: ORG_A, projectId: PROJECT });
    expect(quarantines).toHaveLength(1);
    expect(quarantines[0]?.state).toBe("quarantined");
    expect(quarantines[0]?.gateEffect).toBe("excluded_from_green");
    expect(quarantines[0]?.evidenceVerdictCount).toBe(1);
  });

  it("DECISIVE: a cross-org read sees ZERO rows on EVERY surface — org B cannot read org A", async () => {
    const scopeB = { orgId: ORG_B, projectId: PROJECT };
    expect(await store.readMatrix(scopeB)).toEqual([]);
    const causality = await store.readEffectCausality(scopeB);
    expect(causality.observations).toEqual([]);
    expect(causality.okCount).toBe(0);
    expect(await store.readDesignRenderVerdicts(scopeB)).toEqual([]);
    expect(await store.readRegressionBisections(scopeB)).toEqual([]);
    expect(await store.readFlakeQuarantines(scopeB)).toEqual([]);
  });
});
