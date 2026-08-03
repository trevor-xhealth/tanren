import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { stateEnumLists } from "./stateEnums.js";
import {
  enumCheck,
  mergeQueue,
  mergeQueueHolds,
  mergeQueuePartitions,
  organizations,
  postMergeIssueClaims,
  projects,
  runs,
  specs,
  users,
} from "./schemaCore.js";
import { integrationNodes, integrationProofs } from "./schemaIntegrationNodes.js";
import { gateProofBundles, gateProofBundleSections } from "./schemaGateProofBundles.js";
import { events } from "./schemaEvents.js";
import { issueLoopEdges, issueLoops, sourceFindings } from "./schemaIssueLoops.js";
import { behaviors, personas } from "./schemaProductEntities.js";
export {
  enumCheck,
  integrationNodes,
  integrationProofs,
  gateProofBundles,
  gateProofBundleSections,
  mergeQueue,
  mergeQueueHolds,
  mergeQueuePartitions,
  organizations,
  postMergeIssueClaims,
  projects,
  runs,
  specs,
  users,
  events,
  behaviors,
  personas,
};
export { runners } from "./schemaRunners.js";
export { mergeEagerBeams } from "./schemaEagerBeams.js";
export { mergeRuntimeOutcomes } from "./schemaMergeRuntimeOutcomes.js";
export { mergeQueueCommands, mergeQueuePolicies, mergeQueueWindows } from "./schemaQueuePolicy.js";
export const tasks = pgTable(
  "tasks",
  {
    taskId: text("task_id").primaryKey(),
    runId: text("run_id").references(() => runs.runId),
    issueLoopId: text("issue_loop_id"),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    parentTaskId: text("parent_task_id").references((): AnyPgColumn => tasks.taskId),
    status: text("status").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    outcome: text("outcome"),
    failureKind: text("failure_kind"),
    agentKind: text("agent_kind").notNull(),
    cli: text("cli").notNull(),
    model: text("model"),
    attempt: integer("attempt").notNull().default(1),
    userId: text("user_id"),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.issueLoopId],
      foreignColumns: [issueLoops.orgId, issueLoops.id],
      name: "tasks_issue_loop_fk",
    }),
    enumCheck("tasks_kind_check", table.kind, stateEnumLists.tasks_kind),
    enumCheck("tasks_status_check", table.status, stateEnumLists.tasks_status),
    enumCheck("tasks_agent_kind_check", table.agentKind, stateEnumLists.tasks_agent_kind),
    check(
      "tasks_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN (${sql.raw(
        stateEnumLists.tasks_outcome.map((value) => `'${value.replaceAll("'", "''")}'`).join(","),
      )})`,
    ),
    index("tasks_org_id").on(table.orgId),
    index("tasks_org_run").on(table.orgId, table.runId),
    check("tasks_run_or_issue_loop_check", sql`(${table.runId} IS NOT NULL) <> (${table.issueLoopId} IS NOT NULL)`),
  ],
);
export const costRecords = pgTable(
  "cost_records",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.taskId),
    runId: text("run_id"),
    issueLoopId: text("issue_loop_id"),
    projectId: text("project_id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    cli: text("cli").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    // Disjoint token-type buckets (providers/types.ts TokenUsage); never fold types together.
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningOutputTokens: integer("reasoning_output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    // REAL SPEND (FOCUS BilledCost): actual cash out the door. NULL is an honest,
    // allowed state when no reliable real-cost basis exists (subscription
    // within-window / self-hosted / unpriced models). The budget gate sums THIS
    // column — it is the real-spend ceiling signal. Per-token API = real;
    // subscription within-window = NULL; subscription overage (credits) = real.
    costUsd: numeric("cost_usd", { precision: 14, scale: 6 }),
    // NOTIONAL VALUE (FOCUS ListCost): dollar value at public API LIST RATES,
    // computed for EVERY call (including subscription/self_hosted, where real
    // spend is $0/NULL). Comparable + forecastable; NOT real spend; NEVER summed
    // by the budget gate. NULL only when no provider rate is known.
    notionalCostUsd: numeric("notional_cost_usd", { precision: 14, scale: 6 }),
    billingMode: text("billing_mode").notNull(),
    costBasis: text("cost_basis").notNull(),
    costSourceRaw: jsonb("cost_source_raw")
      .notNull()
      .default(sql`'{}'::jsonb`),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    userId: text("user_id"),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.issueLoopId],
      foreignColumns: [issueLoops.orgId, issueLoops.id],
      name: "cost_records_issue_loop_fk",
    }),
    check(
      "cost_records_billing_mode_check",
      sql`${table.billingMode} IN ('per_token','subscription','self_hosted','unattributed')`,
    ),
    check(
      "cost_records_cost_basis_check",
      sql`${table.costBasis} IN ('ccusage','provider_response','credits','unknown','unattributed')`,
    ),
    index("cost_records_org_id").on(table.orgId),
    index("cost_records_org_run").on(table.orgId, table.runId),
    check(
      "cost_records_run_or_issue_loop_check",
      sql`(${table.runId} IS NOT NULL) <> (${table.issueLoopId} IS NOT NULL)`,
    ),
  ],
);

export const rateLimitObservations = pgTable("rate_limit_observations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  taskId: text("task_id").references(() => tasks.taskId),
  callSite: text("call_site").notNull(),
  provider: text("provider").notNull(),
  observation: text("observation").notNull(),
  detail: jsonb("detail")
    .notNull()
    .default(sql`'{}'::jsonb`),
  retryAfterS: integer("retry_after_s"),
  tenantId: text("tenant_id"),
  userId: text("user_id"),
});

export const notifications = pgTable(
  "notifications",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // WAVE-1 gv-6: the delivery ledger is now org-scoped + RLS-forced (migration
    // 0045). `org_id` is the direct tenant key every RLS policy compares; it
    // replaced the pre-org `tenant_id`.
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    channel: text("channel").notNull(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    userId: text("user_id"),
  },
  (table) => [
    index("notifications_org_id").on(table.orgId),
    pgPolicy("rls_org_isolation", {
      for: "all",
      using: sql`${table.orgId} = current_setting('app.current_org_id', true)`,
      withCheck: sql`${table.orgId} = current_setting('app.current_org_id', true)`,
    }),
  ],
).enableRLS();

export const jobQueue = pgTable(
  "job_queue",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id"),
    taskId: text("task_id").references(() => tasks.taskId),
    // RLS R3b: the owning run's org, stamped on enqueue. `job_queue` is a SYSTEM
    // table that stays OUTSIDE RLS (the claim is intentionally cross-org), so
    // this column is the worker's tenant BOOTSTRAP source: the claimed row's
    // `org_id` tells the worker which org owns the job WITHOUT an RLS-protected
    // `runs` read. Nullable: a system / null-org job (a CLI caller / fixture with
    // no org) has no org. Not FK-constrained on purpose — the queue must never
    // block a claim on a tenant-table lookup.
    orgId: text("org_id"),
    taskKind: text("task_kind").notNull(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("queued"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    // P3-0028 queue lease recovery. A claimed/running job holds a lease that the
    // worker renews via a heartbeat while it executes. `leasedUntil` is the lease
    // expiry; a reaper requeues any `running` job whose lease has lapsed (crashed
    // worker). `heartbeatAt` records the last renewal for observability.
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    // `attempts` is a DIAGNOSTIC re-claim counter, NOT a give-up budget: a
    // lease-expired job is requeued INDEFINITELY (no `max_attempts` ceiling — the
    // doctrine forbids a fixed attempt cap; a crashing worker is loud INFRA).
    failureKind: text("failure_kind"),
    failureMessage: text("failure_message"),
    tenantId: text("tenant_id"),
    userId: text("user_id"),
  },
  (table) => [
    index("job_queue_queued")
      .on(table.taskKind, table.enqueuedAt)
      .where(sql`${table.status} = 'queued'`),
    // P3-0028: reaper scans live (running) jobs by lease expiry.
    index("job_queue_lease")
      .on(table.leasedUntil)
      .where(sql`${table.status} = 'running'`),
    enumCheck("job_queue_status_check", table.status, stateEnumLists.job_queue_status),
    enumCheck("job_queue_task_kind_check", table.taskKind, stateEnumLists.job_queue_task_kind),
  ],
);

export const orgMembers = pgTable(
  "org_members",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId] }),
    check("org_members_role_check", sql`${table.role} IN ('admin','member')`),
  ],
);

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    check("project_members_role_check", sql`${table.role} IN ('admin','member')`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    csrfToken: text("csrf_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [index("sessions_user_id").on(table.userId), index("sessions_expires_at").on(table.expiresAt)],
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("api_tokens_user_id").on(table.userId), uniqueIndex("api_tokens_hash_unique").on(table.tokenHash)],
);

// P2A-0018 product entities. `personas` and `behaviors` live in
// ./schemaProductEntities.js (a pure move — see that file's header); milestones,
// the spec links, and the directed spec dependency edges stay here.
export const milestones = pgTable(
  "milestones",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    label: text("label").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    orderIndex: integer("order_index").notNull(),
    eta: timestamp("eta", { withTimezone: true }),
    status: text("status").notNull().default("planned"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("milestones_status_check", sql`${table.status} IN ('planned','in_flight','done','abandoned')`),
    uniqueIndex("milestones_project_label_unique").on(table.projectId, table.label),
    uniqueIndex("milestones_project_order_unique").on(table.projectId, table.orderIndex),
  ],
);

export const specBehaviors = pgTable(
  "spec_behaviors",
  {
    specId: text("spec_id")
      .notNull()
      .references(() => specs.specId),
    behaviorId: text("behavior_id")
      .notNull()
      .references(() => behaviors.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.specId, table.behaviorId] }),
    index("spec_behaviors_behavior_id").on(table.behaviorId),
  ],
);
export const specMilestones = pgTable(
  "spec_milestones",
  {
    specId: text("spec_id")
      .notNull()
      .references(() => specs.specId),
    milestoneId: text("milestone_id")
      .notNull()
      .references(() => milestones.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.specId, table.milestoneId] }),
    uniqueIndex("spec_milestones_spec_unique").on(table.specId),
    index("spec_milestones_milestone_id").on(table.milestoneId),
  ],
);
export { specDependencies } from "./schemaSpecGraph.js";
export { eventTypes } from "./schemaEventTypes.js";
export { notificationTargets, notificationRoutes } from "./schemaNotifications.js";
export { forgeThreads, forgeTurns, forgeActionProposals } from "./schemaForge.js";
export { workflowInsights, quarantinedTests, ciTestResults } from "./schemaInsights.js";
export { inboxSources, candidates, webhookEvents } from "./schemaInbox.js";
export { auditJobs } from "./schemaAudits.js";
export { experiments, experimentCells, experimentTrials } from "./schemaBenchmark.js";
export * from "./schemaIntegrationConnections.js";
export * from "./schemaIntegrationRequirements.js";
export * from "./schemaIntegrationBindings.js";
export * from "./schemaIntegrationOperations.js";
export * from "./schemaIntegrationEvidence.js";
export * from "./schemaIntegrationEnvironment.js";
export * from "./schemaIntegrationSelection.js";
export * from "./schemaProjectDerivations.js";
export { issueLoops, sourceFindings, issueLoopEdges };
export { specOrigins, specOriginFindings } from "./schemaSpecOrigins.js";
export { mergeRepairRoutes } from "./schemaMergeRepairRoutes.js";
export { symptomContracts, symptomContractFragments } from "./schemaSymptomContracts.js";
export * from "./schemaWave4.js";
export { fragments } from "./schemaFragments.js";
export { entityClaims } from "./schemaClaims.js";
export { environments } from "./schemaEnvironments.js";
export { designContracts } from "./schemaDesign.js";
export * from "./schemaDesignSystems.js";
export { designFragments } from "./schemaDesignFragments.js";
export { designRenderLandVerdicts } from "./schemaDesignRender.js";
export { manualDeployAttestations } from "./schemaDeploy.js";
export { governanceFragments, governancePolicyRevisions } from "./schemaGovernance.js";
export { integrationFragments } from "./schemaIntegrationFragments.js";
export * from "./schemaEffectivePolicySnapshots.js";
export * from "./schemaWave6.js";
export * from "./schemaBhCluster.js";
export { regressionBisections } from "./schemaRegressionBisections.js";
export { behaviorQuarantines } from "./schemaBehaviorQuarantines.js";
export { mergeTrainArtifacts } from "./schemaMergeTrainArtifacts.js";
export { landGroupDeliveryLoops } from "./schemaLandGroupDeliveryLoops.js";
export { designAdapterConformanceRuns } from "./schemaDesignAdapterConformance.js";
export * from "./schemaDesignEcosystem.js";
export {
  catalogBehaviorPersonas,
  catalogBehaviorRelations,
  catalogBehaviors,
  catalogPersonas,
} from "./schemaCatalog.js";
