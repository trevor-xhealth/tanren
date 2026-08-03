import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { issueLoopsReference } from "./schemaIssueLoopReferences.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";
import { stateEnumLists } from "./stateEnums.js";

// Core identity + project/spec/run tables live here so sub-schemas can reference them without importing schema.ts
// (avoids the no-cycle import loop). schema.ts re-exports this module as the single `schema.*` namespace for consumers + kit.

export function enumCheck(name: string, column: AnyPgColumn, values: ReadonlyArray<string>) {
  const literals = sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(","));
  return check(name, sql`${column} IN (${literals})`);
}

// org_id is the tenant-isolation root (P-tenancy). projects.org_id NOT NULL FK →
// organizations; downstream core tables carry derived mandatory indexed org_id.
export const projects = pgTable(
  "projects",
  {
    projectId: text("project_id").primaryKey(),
    name: text("name").notNull(),
    repoUrl: text("repo_url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    runnerImage: text("runner_image").notNull().default("ghcr.io/cat-cave/tanren-runner:v0"),
    allocator: text("allocator").notNull().default("local-docker"),
    // Versioned ProjectConfigV1; default is minimal valid `{"version":1}` (not `{}`).
    config: jsonb("config")
      .notNull()
      .default(sql`'{"version":1}'::jsonb`),
    // App CAS gen (never xmin). mode number + CHECK ≤ MAX_SAFE_INTEGER; HTTP uses ::text.
    configRevision: bigint("config_revision", { mode: "number" }).notNull().default(1),
    // Operator lifecycle: 'deriving' (greenfield graph incomplete), 'active'
    // (the autonomous walker drives it), or 'archived' (walker + strand
    // reconciler skip it; in-flight runs/specs are cancelled on archive).
    lifecycle: text("lifecycle").notNull().default("active"),
    // Governance tier visibility predicate (gv-8). NULL preserves the existing
    // project rows until the governance lane supplies an explicit visibility.
    repoVisibility: text("repo_visibility"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
  },
  (table) => [
    check(
      "projects_config_revision_range_check",
      sql`${table.configRevision} >= 1 AND ${table.configRevision} <= 9007199254740991`,
    ),
    uniqueIndex("projects_org_project_unique").on(table.orgId, table.projectId),
    index("projects_org_id").on(table.orgId),
    check("projects_lifecycle_check", sql`${table.lifecycle} IN ('deriving','active','archived')`),
    check("projects_repo_visibility_check", sql`${table.repoVisibility} IN ('public','private')`),
  ],
);

export const specs = pgTable(
  "specs",
  {
    specId: text("spec_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    title: text("title").notNull(),
    description: text("description").notNull(),
    // jsonb-ARRAY + tolerant reader (`StringArrayOrEmpty`) → not the versioned-object latent-500 case; `text[]` default below is Postgres empty-array syntax, not jsonb.
    acceptanceCriteria: jsonb("acceptance_criteria")
      .notNull()
      .default(sql`'[]'::jsonb`),
    dependsOn: text("depends_on")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text("status").notNull().default("open"),
    // DagWalker ready-set priority (P0…tbd). Literals mirror SpecPriority.
    priority: text("priority").notNull().default("tbd"),
    // Writer prompt mode: from_scratch | specialize_seed | modify_existing (see SpecMode).
    mode: text("mode").notNull().default("from_scratch"),
    // P3-0014 discovery provenance bag; `{}` is honest empty.
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Triage provenance trail (nullable); enables re-drive dedupe.
    parentSpecId: text("parent_spec_id"),
    sourceFindingIds: text("source_finding_ids").array(),
    originTriageTaskId: text("origin_triage_task_id"),
    originRunId: text("origin_run_id"),
    originIssueLoopId: text("origin_issue_loop_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "specs_project_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.originIssueLoopId],
      foreignColumns: [issueLoopsReference.orgId, issueLoopsReference.id],
      name: "specs_origin_issue_loop_fk",
    }),
    uniqueIndex("specs_org_spec_unique").on(table.orgId, table.specId),
    uniqueIndex("specs_org_project_spec_unique").on(table.orgId, table.projectId, table.specId),
    enumCheck("specs_status_check", table.status, stateEnumLists.specs_status),
    enumCheck("specs_priority_check", table.priority, ["P0", "P1", "P2", "tbd"]),
    enumCheck("specs_mode_check", table.mode, ["specialize_seed", "from_scratch", "modify_existing"]),
    index("specs_org_id").on(table.orgId),
    index("specs_project_created").on(table.projectId, table.createdAt, table.specId),
    uniqueIndex("specs_triage_provenance_unique")
      .on(table.projectId, table.parentSpecId, table.sourceFindingIds)
      .where(sql`parent_spec_id IS NOT NULL`),
  ],
);

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    login: text("login").notNull(),
    displayName: text("display_name").notNull(),
    // Versioned OrgConfigV1; default is minimal valid `{"version":1}` (not `{}`).
    config: jsonb("config")
      .notNull()
      .default(sql`'{"version":1}'::jsonb`),
    // App CAS gen (never xmin). mode number + CHECK ≤ MAX_SAFE_INTEGER; HTTP uses ::text.
    configRevision: bigint("config_revision", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("organizations_kind_check", sql`${table.kind} IN ('github_org','github_user','oidc')`),
    check(
      "organizations_config_revision_range_check",
      sql`${table.configRevision} >= 1 AND ${table.configRevision} <= 9007199254740991`,
    ),
    uniqueIndex("organizations_provider_unique").on(table.kind, table.externalId),
  ],
);

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    login: text("login"),
    email: text("email"),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("users_provider_check", sql`${table.provider} IN ('github_oauth','oidc','local_dev')`),
    uniqueIndex("users_provider_subject_unique").on(table.provider, table.providerSubject),
  ],
);

export const runs = pgTable(
  "runs",
  {
    runId: text("run_id").primaryKey(),
    specId: text("spec_id")
      .notNull()
      .references(() => specs.specId),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    trigger: text("trigger").notNull(),
    branch: text("branch").notNull(),
    status: text("status").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    outcome: text("outcome"),
    prUrl: text("pr_url"),
    userId: text("user_id"),
    // P2c-2: the per-ancestor head SHA map this dependent's work has actually
    // RE-GATED CLEAN against — gate+checker+auditor genuinely re-ran (a real run)
    // and passed with no open P0/P1. This is the ABSORBED / TERMINATION key: the
    // detect compares an ancestor's LIVE head against THIS (not the build-base), so
    // a change is only "absorbed" once the dependent's own governance re-ran clean
    // — never on a bare re-base. NULL until the first clean re-gate.
    verifiedAncestorShas: jsonb("verified_ancestor_shas"),
    // P2c-2: the IN-FLIGHT percolation marker (the loop-termination guard). When an
    // immediate upstream change kicks off a re-execution, this records the exact
    // `{ ancestorSpecId, toSha, reviewVerdict }` being absorbed so a sticky signal
    // (e.g. a `changes_requested` at an unchanged SHA) does NOT re-trigger every
    // walk: a pending marker means "already re-executing this signal — wait." It is
    // cleared (and `verified_ancestor_shas` advanced) when the re-execution settles.
    percolationPending: jsonb("percolation_pending"),
    // §3.7f credit double-count fix: the run's resolved credential identity (the
    // writer adapter's `authRef`). Prepaid-credit balances are GLOBAL to a credential,
    // so two overlapping runs sharing one credential would each capture the SAME
    // drawdown baseline and attribute the WHOLE concurrent drawdown — double-counting.
    // This per-run dedup key lets the run-end reconcile COUNT the runs concurrently
    // active on the same credential and attribute only this run's share (idempotent).
    // NULL until the worker resolves the writer credential (or no credential-priced spend).
    authRef: text("auth_ref"),
    // WS-A PR-1 (walker-jj-local-integration-design.md §2.3): the ORDERED ancestor stack
    // `[{ specId, runId, branch, headSha }]`. The sole jj-local base source.
    ancestorStack: jsonb("ancestor_stack"),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "runs_project_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.specId],
      foreignColumns: [specs.orgId, specs.projectId, specs.specId],
      name: "runs_spec_lineage_fk",
    }),
    enumCheck("runs_status_check", table.status, stateEnumLists.runs_status),
    check(
      "runs_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN (${sql.raw(
        stateEnumLists.runs_outcome.map((value) => `'${value.replaceAll("'", "''")}'`).join(","),
      )})`,
    ),
    index("runs_org_id").on(table.orgId),
    uniqueIndex("runs_org_run_unique").on(table.orgId, table.runId),
    uniqueIndex("runs_org_spec_run_unique").on(table.orgId, table.specId, table.runId),
    uniqueIndex("runs_org_project_run_unique").on(table.orgId, table.projectId, table.runId),
    uniqueIndex("runs_org_project_spec_run_unique").on(table.orgId, table.projectId, table.specId, table.runId),
    index("runs_org_project").on(table.orgId, table.projectId),
    // The §3.7f concurrency query: count the ACTIVE runs sharing one credential
    // (auth_ref) during a drawdown measurement → org-scoped, by auth_ref + status.
    index("runs_org_auth_ref").on(table.orgId, table.authRef),
  ],
);

export const mergeQueuePartitions = pgTable(
  "merge_queue_partitions",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    targetBranch: text("target_branch").notNull(),
    scopeKey: text("scope_key").notNull(),
    mode: text("mode").notNull(),
    capacity: integer("capacity").notNull(),
    state: text("state").notNull(),
    generation: integer("generation").notNull().default(0),
    pauseReason: text("pause_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "merge_queue_partitions_project_fk",
    }),
    uniqueIndex("merge_queue_partitions_project_target_scope_unique").on(
      table.orgId,
      table.projectId,
      table.targetBranch,
      table.scopeKey,
    ),
    index("merge_queue_partitions_org_id").on(table.orgId),
    check("merge_queue_partitions_mode_check", sql`${table.mode} IN ('serial','scoped','isolated')`),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

// P2d (autonomy-engine.md §2d): the native intelligent merge queue. One row per
// ready-to-merge run under `native_queue` — the persisted, RLS-scoped queue state
// the MergeCoordinator orders + serializes. DAG state is the source of truth
// (§1.7), so this table holds ONLY the queue membership + serialization claim, not
// duplicated DAG/lifecycle state: ordering (DAG-order + priority) is DERIVED fresh
// each pass from `specs` + `runs`. The table exists so the queue SURVIVES A
// RESTART (a process crash mid-coordinate leaves the queued/merging rows
// recoverable) and so the serialization claim (`status = 'merging'`) is durable —
// at most one entry per project is `merging` at a time (one merge in flight).
//
//   status:
//     - `queued`   — ready-to-merge, awaiting its turn in DAG order.
//     - `merging`  — the coordinator CLAIMED this entry and is driving its merge
//                    (the serialization lock — at most one per project).
//     - `merged`   — its merge landed (terminal; kept for queue statistics).
//     - `dequeued` — left the queue WITHOUT merging (conflict → recoverable hold,
//                    or removed for liveness so independent items proceed); the
//                    `dequeue_reason` records which. A re-ready run re-enqueues a
//                    NEW row, so a dequeued row is terminal.
//
// org_id is the tenant root (RLS deny-by-default); a `queued` unique index per run
// is the IDEMPOTENCY boundary — a run already queued/merging is never re-queued.
export const mergeQueue = pgTable(
  "merge_queue",
  {
    queueId: text("queue_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.runId),
    specId: text("spec_id")
      .notNull()
      .references(() => specs.specId),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    partitionId: text("partition_id"),
    leaseOwner: text("lease_owner"),
    /** Monotonic fencing generation; incremented for every successful claim. */
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    scopeFingerprint: text("scope_fingerprint"),
    policySnapshot: jsonb("policy_snapshot"),
    routeSnapshot: jsonb("route_snapshot"),
    prioritySnapshot: jsonb("priority_snapshot"),
    targetBranch: text("target_branch"),
    priorityOverride: text("priority_override"),
    policyHoldReason: text("policy_hold_reason"),
    status: text("status").notNull().default("queued"),
    /** The dequeue reason when status = 'dequeued' (conflict | blocked | failed | superseded | needs_attention). */
    dequeueReason: text("dequeue_reason"),
    /**
     * in-18: the integration-grant-blocked park reason (status = 'parked_grant';
     * mirrors `capability_nodes.wait_reason`). NON-terminal — the parked entry is
     * neither merged nor dropped; re-admitted only when its grant covers. NULL otherwise.
     */
    parkReason: text("park_reason"),
    /** The PR url + number captured at enqueue (the coordinator drives by run id). */
    prUrl: text("pr_url").notNull(),
    prNumber: text("pr_number").notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    // The NO-CHECKS SETTLE anchor (the no-CI-repo merge-queue hang fix). Set the FIRST
    // time the speculative batch check observes GENUINELY-zero checks on the rebuilt
    // integration ref keyed on this (tail) entry, and CLEARED the moment any real
    // verdict (checks_pending/passed/failed/conflict) is seen — so a repo whose workflow
    // registers a check within seconds never accrues a continuous no-checks window and
    // never settle-merges unverified. The settle grace measures `now - no_checks_since`
    // (NOT `now - enqueued_at`, which would wrongly count queue-backlog time), so a
    // genuinely-no-CI repo settles to pass only after the grace of CONTINUOUS no-checks.
    noChecksSince: timestamp("no_checks_since", { withTimezone: true }),
    /** Set when the coordinator CLAIMED the entry (status → merging). */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** Set when the entry reached a terminal status (merged / dequeued). */
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "merge_queue_project_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.specId],
      foreignColumns: [specs.orgId, specs.projectId, specs.specId],
      name: "merge_queue_spec_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.specId, table.runId],
      foreignColumns: [runs.orgId, runs.projectId, runs.specId, runs.runId],
      name: "merge_queue_run_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.partitionId],
      foreignColumns: [mergeQueuePartitions.orgId, mergeQueuePartitions.id],
      name: "merge_queue_partition_fk",
    }),
    enumCheck("merge_queue_status_check", table.status, [
      "queued",
      "merging",
      "merged",
      "dequeued",
      "parked_grant",
      "held_policy",
    ]),
    check(
      "merge_queue_dequeue_reason_check",
      sql`${table.dequeueReason} IS NULL OR ${table.dequeueReason} IN ('conflict','blocked','failed','superseded','needs_attention')`,
    ),
    check("merge_queue_park_reason_check", sql`${table.parkReason} IS NULL OR ${table.status} = 'parked_grant'`),
    check(
      "merge_queue_policy_hold_reason_check",
      sql`${table.policyHoldReason} IS NULL OR ${table.status} = 'held_policy'`,
    ),
    check(
      "merge_queue_lease_check",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    index("merge_queue_org_id").on(table.orgId),
    index("merge_queue_org_project").on(table.orgId, table.projectId),
    index("merge_queue_org_project_status").on(table.orgId, table.projectId, table.status),
    uniqueIndex("merge_queue_org_queue_unique").on(table.orgId, table.queueId),
    uniqueIndex("merge_queue_active_run_unique")
      .on(table.runId)
      .where(sql`status IN ('queued', 'merging', 'parked_grant', 'held_policy')`),
  ],
);

export const mergeQueueHolds = pgTable(
  "merge_queue_holds",
  {
    /** The scope this counter belongs to: a queue_id (recoverable_drive) or a project_id (batch_infra). */
    scopeId: text("scope_id").notNull(),
    /** Which ceiling: 'recoverable_drive' (per-entry) | 'batch_infra' (per-project). */
    kind: text("kind").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    /** The persisted consecutive-hold/attempt count — TELEMETRY ONLY (the emitted `attempts` diagnostic), NOT a control-flow trigger. The non-recovery alert keys off the SIGNATURE history below (the fixed-point read), never this count — see `infraNonRecovery.ts`. */
    attempts: text("attempts").notNull().default("0"),
    /** The trailing infra-failure SIGNATURE history (oldest→newest JSON of stable error-identity strings), bounded to the cycle window. The sustained-non-recovery read (`assessStructuralProgress`) reasons over THIS — the alert fires when the SAME signature persists with no progress across the backoff-spaced re-drives, never on a count. `'[]'` keeps it NOT NULL for a fresh scope. */
    signatures: text("signatures").notNull().default("[]"),
    /** When the counter was last incremented (observability + a future lease/expiry). */
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    enumCheck("merge_queue_holds_kind_check", table.kind, ["recoverable_drive", "batch_infra"]),
    // The (org, scope, kind) identity — the upsert conflict target (one counter per scope+kind).
    uniqueIndex("merge_queue_holds_identity").on(table.orgId, table.scopeId, table.kind),
    index("merge_queue_holds_org_id").on(table.orgId),
  ],
);

// Post-merge auto-issue claim (tempering.md dim A). The CROSS-PROCESS atomic
// "file once per merge" guard for the post-merge-failure watcher: the run_id
// PRIMARY KEY makes the claim INSERT (`ON CONFLICT (run_id) DO NOTHING RETURNING`)
// the single serialization point across an N-process worker fleet — only the
// process whose INSERT created the row wins and calls `createIssue`; every other
// LISTENing worker's INSERT returns 0 rows and skips. `status` carries the claim
// lifecycle: `claimed` (a winner is filing) → `filed` (the issue was opened, the
// durable terminal idempotency marker). A `claimed` row whose driver crashed
// before filing is reclaimable past a lease (mirrors merge_queue's stale-claim
// recovery); the watcher itself DELETEs its claim on a `createIssue` FAILURE so a
// transient GitHub error never permanently suppresses the issue.
//
// org_id is the tenant root (RLS deny-by-default, 3a-style direct org match like
// merge_queue). One row per merged run = one issue per merge.
export const postMergeIssueClaims = pgTable(
  "post_merge_issue_claims",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.runId),
    specId: text("spec_id")
      .notNull()
      .references(() => specs.specId),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    status: text("status").notNull().default("claimed"),
    /** The opened issue's url/number — set when status flips to `filed`. */
    issueUrl: text("issue_url"),
    issueNumber: text("issue_number"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when the issue was opened (status → filed). */
    filedAt: timestamp("filed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "post_merge_issue_claims_project_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.specId],
      foreignColumns: [specs.orgId, specs.projectId, specs.specId],
      name: "post_merge_issue_claims_spec_lineage_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.specId, table.runId],
      foreignColumns: [runs.orgId, runs.projectId, runs.specId, runs.runId],
      name: "post_merge_issue_claims_run_lineage_fk",
    }),
    enumCheck("post_merge_issue_claims_status_check", table.status, ["claimed", "filed"]),
    index("post_merge_issue_claims_org_id").on(table.orgId),
    index("post_merge_issue_claims_org_project").on(table.orgId, table.projectId),
  ],
);
