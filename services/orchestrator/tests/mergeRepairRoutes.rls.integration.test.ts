// cspell:ignore mqeval mqgrp
// mq-10 live RLS proof: the PRODUCTION PgAutonomousRepairRouter over the isolated tanren_app
// role. Proves the three routes end-to-end (repair / respec / blocked), respec re-drives spec
// authoring by materializing a replacement spec + emitting merge.member.respec_routed, and a
// cross-org read sees ZERO rows (deny-by-default RLS).
import { randomUUID } from "node:crypto";
import { migrate, runWithOrgScope, setSystemPool } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgEventStore } from "../src/engine/eventStore.js";
import { canonicalFailureSignature } from "../src/engine/merge/repairRouteDecision.js";
import { PgAutonomousRepairRouter } from "../src/engine/merge/respecRouterPg.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_mq10_a";
const ORG_B = "org_mq10_b";
const PROJECT_A = "project_mq10_a";
// One stuck parent per SpecMode arm. A re-spec INHERITS its parent's authoring mode, so all
// three are pinned here — including `from_scratch`, whose expected value is unchanged, so
// that "inherit" is proven to be inheritance rather than a hardcode that happens to agree.
const MODE_PARENTS = [
  ["spec_mode_from_scratch", "from_scratch"],
  ["spec_mode_specialize_seed", "specialize_seed"],
  ["spec_mode_modify_existing", "modify_existing"],
] as const;

function dbName(): string {
  return `tanren_mq10_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function appUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = "tanren_app";
  parsed.password = APP_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function mqgrp(): string {
  return `mqgrp_${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
}
function mqeval(): string {
  return `mqeval_${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
}

describeDb("mq-10 autonomous-repair router under tanren_app RLS", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let router: PgAutonomousRepairRouter;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: appUrl(ADMIN_URL, database) });
    setSystemPool(ownerPool);
    for (const org of [ORG_A, ORG_B]) {
      await ownerPool.query(
        `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
         VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
        [org],
      );
    }
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id) VALUES ($1, 'mq-10', 'https://example.com/mq-10.git', $2)`,
      [PROJECT_A, ORG_A],
    );
    for (const [specId, runId] of [
      ["spec_repair", "run_repair"],
      ["spec_fp", "run_fp"],
      ["spec_blocked", "run_blocked"],
    ] as const) {
      await ownerPool.query(
        `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
         VALUES ($1, $2, $3, $1, 'mq-10 fixture', 'in_flight')`,
        [specId, PROJECT_A, ORG_A],
      );
      await ownerPool.query(
        `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
         VALUES ($1, $2, $3, $4, 'ci', $1, 'completed')`,
        [runId, specId, PROJECT_A, ORG_A],
      );
    }
    // One PARENT spec per SpecMode arm, so the mode-inheritance proof below runs against a
    // real `specs.mode` column (the DB CHECK enumerates the three literals).
    for (const [specId, mode] of MODE_PARENTS) {
      await ownerPool.query(
        `INSERT INTO specs (spec_id, project_id, org_id, title, description, status, mode)
         VALUES ($1, $2, $3, $1, 'mq-10 mode fixture', 'in_flight', $4)`,
        [specId, PROJECT_A, ORG_A, mode],
      );
      await ownerPool.query(
        `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
         VALUES ($1, $2, $3, $4, 'ci', $1, 'completed')`,
        [`run_${specId}`, specId, PROJECT_A, ORG_A],
      );
    }
    router = new PgAutonomousRepairRouter({ pool: appPool, events: new PgEventStore(appPool) });
  });

  // DROP the per-run database, like every other rls-integration sibling. This file
  // only closed its pools, which was invisible while it ran in no gate at all — now
  // that it is wired into `just smoke-rls-merge-repair-routes` it would otherwise
  // leak one `tanren_mq10_*` database per CI run, forever.
  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("routes a first deterministic-policy failure to in-place repair (durable row)", async () => {
    const outcome = await router.routeMemberFailure({
      projectId: PROJECT_A,
      groupId: mqgrp(),
      evaluationId: mqeval(),
      sourceSpecId: "spec_repair",
      runId: "run_repair",
      classification: "deterministic_policy",
      findingIds: ["f1"],
      reasonCodes: ["audit_policy"],
    });
    expect(outcome.kind).toBe("repair_in_place");
    const rows = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query<{ disposition: string }>(
        `SELECT disposition FROM merge_repair_routes WHERE source_spec_id = 'spec_repair'`,
      ),
    );
    expect(rows.rows.map((r) => r.disposition)).toEqual(["repair_in_place"]);
  });

  it("escalates a proven fixed point to a respec: materializes a replacement spec + emits the event", async () => {
    const signature = canonicalFailureSignature(["audit_policy"], ["f1"]);
    // Two prior identical-signature attempts (distinct evaluations) prove the fixed point.
    for (let n = 0; n < 2; n += 1) {
      await ownerPool.query(
        `INSERT INTO merge_repair_routes
           (org_id, route_id, project_id, source_spec_id, group_id, evaluation_id, disposition, failure_class,
            failure_signature, magnitude, finding_ids, reason_codes)
         VALUES ($1,$2,$3,'spec_fp',$4,$5,'repair_in_place','deterministic_policy',$6,1,'{f1}','{audit_policy}')`,
        [ORG_A, `mrr_prior_${n}`, PROJECT_A, mqgrp(), mqeval(), signature],
      );
    }
    const outcome = await router.routeMemberFailure({
      projectId: PROJECT_A,
      groupId: mqgrp(),
      evaluationId: mqeval(),
      sourceSpecId: "spec_fp",
      runId: "run_fp",
      classification: "deterministic_policy",
      findingIds: ["f1"],
      reasonCodes: ["audit_policy"],
    });
    expect(outcome.kind).toBe("respec");
    if (outcome.kind !== "respec") throw new Error("expected respec");
    expect(outcome.replacementSpecIds).toHaveLength(1);
    expect(outcome.packetHash).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const respecRow = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query<{ packet_hash: string; respec_generation: number; replacement_spec_ids: string[] }>(
        `SELECT packet_hash, respec_generation, replacement_spec_ids FROM merge_repair_routes
          WHERE source_spec_id = 'spec_fp' AND disposition = 'respec'`,
      ),
    );
    expect(respecRow.rows).toHaveLength(1);
    expect(respecRow.rows[0]?.packet_hash).toBe(outcome.packetHash);
    expect(respecRow.rows[0]?.respec_generation).toBe(1);

    // The replacement spec was materialized (re-drive of spec authoring) with the stuck spec as parent.
    const replacement = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query<{ spec_id: string }>(`SELECT spec_id FROM specs WHERE parent_spec_id = 'spec_fp'`),
    );
    expect(replacement.rows.map((r) => r.spec_id)).toEqual([...outcome.replacementSpecIds]);

    // The apex-proof event fired.
    const events = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query<{ event_type: string }>(
        `SELECT event_type FROM events WHERE event_type = 'merge.member.respec_routed' AND spec_id = 'spec_fp'`,
      ),
    );
    expect(events.rows).toHaveLength(1);
  });

  it("fails closed to blocked_needs_attention for an unclassifiable failure (never dropped)", async () => {
    const outcome = await router.routeMemberFailure({
      projectId: PROJECT_A,
      groupId: mqgrp(),
      evaluationId: mqeval(),
      sourceSpecId: "spec_blocked",
      runId: "run_blocked",
      classification: "unknown_fail_closed",
      findingIds: ["f9"],
      reasonCodes: ["unclassified_authority_block"],
    });
    expect(outcome.kind).toBe("blocked_needs_attention");
    const rows = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query<{ disposition: string }>(
        `SELECT disposition FROM merge_repair_routes WHERE source_spec_id = 'spec_blocked'`,
      ),
    );
    expect(rows.rows.map((r) => r.disposition)).toEqual(["blocked_needs_attention"]);
  });

  // THE MODE-INHERITANCE PROOF, on the real merge transaction. `materializeReplacementSpec`
  // runs inside the SAME `runWithOrgScope` transaction as the routing decision and the route
  // row, so the parent's mode is read there too — never in a separate connection that could
  // observe a torn state. The replacement's mode is read back from `specs` with a SELECT: the
  // defect was in what got WRITTEN, so the return value alone would not have caught it.
  //
  // Against the unfixed router (a hardcoded `mode: "from_scratch"` in
  // `materializeReplacementSpec`) the `modify_existing` and `specialize_seed` cases FAIL —
  // a brownfield spec silently reverting to rebuild-the-world mode on its first re-spec,
  // against a real, pre-existing repository, at the moment the system is already struggling.
  it.each(MODE_PARENTS)("a %s parent re-specs into a replacement persisted at mode=%s", async (specId, mode) => {
    const signature = canonicalFailureSignature(["audit_policy"], ["f1"]);
    for (let n = 0; n < 2; n += 1) {
      await ownerPool.query(
        `INSERT INTO merge_repair_routes
           (org_id, route_id, project_id, source_spec_id, group_id, evaluation_id, disposition, failure_class,
            failure_signature, magnitude, finding_ids, reason_codes)
         VALUES ($1,$2,$3,$4,$5,$6,'repair_in_place','deterministic_policy',$7,1,'{f1}','{audit_policy}')`,
        [ORG_A, `mrr_prior_${specId}_${n}`, PROJECT_A, specId, mqgrp(), mqeval(), signature],
      );
    }
    const outcome = await router.routeMemberFailure({
      projectId: PROJECT_A,
      groupId: mqgrp(),
      evaluationId: mqeval(),
      sourceSpecId: specId,
      runId: `run_${specId}`,
      classification: "deterministic_policy",
      findingIds: ["f1"],
      reasonCodes: ["audit_policy"],
    });
    expect(outcome.kind).toBe("respec");

    // The PERSISTED mode of the replacement row — the value a writer will actually be given.
    const replacement = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query<{ mode: string }>(`SELECT mode FROM specs WHERE parent_spec_id = $1`, [specId]),
    );
    expect(replacement.rows.map((r) => r.mode)).toEqual([mode]);

    // OBSERVABILITY: the mode is on the wire too, so the change is never silent.
    const events = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query<{ payload: { specMode?: string } }>(
        `SELECT payload FROM events WHERE event_type = 'merge.member.respec_routed' AND spec_id = $1`,
        [specId],
      ),
    );
    expect(events.rows.map((r) => r.payload.specMode)).toEqual([mode]);
  });

  it("denies cross-org reads: org B sees ZERO of org A's repair routes", async () => {
    const crossOrg = await runWithOrgScope(appPool, ORG_B, (client) =>
      client.query<{ count: string }>(`SELECT count(*)::text AS count FROM merge_repair_routes`),
    );
    expect(crossOrg.rows[0]?.count).toBe("0");
  });
});
