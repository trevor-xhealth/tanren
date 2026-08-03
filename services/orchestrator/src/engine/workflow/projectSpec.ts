import { randomUUID } from "node:crypto";
import { notifyDagChanged, notifyJobEnqueued, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { PgEventStore } from "../eventStore.js";
import { DEFAULT_SPEC_MODE, DEFAULT_SPEC_PRIORITY, type SpecMode, type SpecPriority } from "../state/spec.js";
import type { ProjectContract } from "./projectCreate.js";
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  SpecDependenciesBlockedError,
  SpecNotFoundError,
  SpecNotRunnableError,
} from "./projectSpecErrors.js";
import { loadProjectOrgId, loadSpecWithProject } from "./projectSpecRowSchema.js";
import { observeRunAsIntegrationNode } from "../dag/integrationNodesPg.js";
import type { AncestorStack } from "../dag/ancestorStack.js";
export { createProject, createProjectOnClient } from "./projectCreate.js";
export type { CreateProjectInput, CreateProjectOptions, ProjectContract } from "./projectCreate.js";

/** The pool or a checked-out client — anything that can run a query. */
export type ProjectSpecQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;
type QueryClient = ProjectSpecQueryClient;

/**
 * The `tasks.cli` value on the PLACEHOLDER plan row this module pre-creates.
 *
 * The row is LOAD-BEARING, not decoration: `job_queue.task_id` FK-references it,
 * `SpecRunContract.plannerTaskId` is returned to the caller and stamped on the
 * `run.queued` / `task.queued` events, and `merge/recoveryEvidencePg.ts` binds a
 * recovery receipt to it (`kind = 'plan'`). It exists because the run is queued
 * BEFORE any worker has resolved the run's routing, so the real harness is not yet
 * known — and `tasks.cli` is NOT NULL. The worker supersedes it via
 * `applySupersedeQueuedPlannerTask` the moment it inserts the real planner task with
 * the resolved `cli` (e.g. `codex`).
 *
 * It used to carry `cli = 'fake'` / `model = 'fake-planner'`, which in a `SELECT` or
 * a DB dump reads exactly like a deterministic fallback provider running in
 * production — and collides with the `fake` cli the TEST fixtures use for a stubbed
 * adapter. `unassigned` (with a NULL model, which the column allows) states the
 * actual fact: no harness has been assigned yet.
 */
export const UNASSIGNED_PLANNER_CLI = "unassigned";

export interface SpecTriageProvenance {
  parentSpecId: string;
  sourceFindingIds: ReadonlyArray<string>;
  originTriageTaskId: string;
  originRunId: string;
  originIssueLoopId?: string;
}

export interface CreateSpecInput {
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn?: string[];
  /** Execution priority (§1b); omitted ⇒ the `tbd` default the DagWalker schedules last. */
  priority?: SpecPriority;
  /** Writer-prompt MODE (task #86); omitted ⇒ `from_scratch`. See `engine/state/spec.ts`. */
  mode?: SpecMode;
  /** Triage routing provenance (Claude RA2); present only for a triage-routed spec. */
  triageProvenance?: SpecTriageProvenance;
}

export interface SpecContract {
  specId: string;
  projectId: string;
  orgId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  status: string;
  priority: SpecPriority;
  mode: SpecMode;
  triageProvenance?: SpecTriageProvenance;
}

export interface CreateSpecRunInput {
  specId: string;
  trigger?: string;
  branch?: string;
  // (§2c) SPECULATIVE start: the run is stacked on its unmerged ancestors. `ancestorStack`
  // is the ordered list of those ancestors (the jj-local source of truth — the dependent
  // assembles its base from these refs at bootstrap); `verifiedAncestorShas` = absorbed
  // carry-forward, `percolationPending` = marker. A present `speculative` block (even an
  // EMPTY stack — the §2c "ancestor-merged → non-speculative re-base" carrying only the
  // marker) SKIPS the done-only dependency gate.
  speculative?: {
    verifiedAncestorShas?: Record<string, string>;
    percolationPending?: unknown;
    // The ordered ancestor stack, written to `runs.ancestor_stack` (the jj-local base source).
    ancestorStack?: AncestorStack;
  };
}

export interface SpecRunContract {
  runId: string;
  specId: string;
  projectId: string;
  // v68 fix: runs.org_id (NOT NULL).
  orgId: string;
  trigger: string;
  branch: string;
  status: "queued";
  plannerTaskId: string;
  plannerJobId: string;
  project: ProjectContract;
  spec: SpecContract;
}

// Domain errors live in `./projectSpecErrors.js` (max-classes-per-file): imported for
// local `throw` sites + re-exported so existing callers are unchanged.
export {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  SpecDependenciesBlockedError,
  SpecNotFoundError,
  SpecNotRunnableError,
};
export { requeueAttentionSpec, SpecNotInAttentionError } from "./requeueAttentionSpec.js";
export type { RequeueAttentionResult } from "./requeueAttentionSpec.js";

export async function createSpec(pool: pg.Pool, input: CreateSpecInput, actor?: ActorContext): Promise<SpecContract> {
  // RLS (specs write): org-carrying actor → org-scoped client; null-org → pool path.
  const orgId = actor?.orgId ?? null;
  if (orgId !== null) {
    return runWithOrgScope(pool, orgId, (client) => createSpecOnClient(client, input, actor));
  }
  return createSpecOnClient(pool, input, actor);
}

export async function createSpecOnClient(
  client: QueryClient,
  input: CreateSpecInput,
  actor?: ActorContext,
): Promise<SpecContract> {
  await ensureProjectExists(client, input.projectId);
  await ensureProjectAccess(client, input.projectId, actor);
  await ensureSpecDependenciesExist(client, input.projectId, input.dependsOn ?? []);
  const projectOrgId = await loadProjectOrgId(client, input.projectId);
  // Codex round-3 #4 — sort `sourceFindingIds` for stable `text[]` dedupe equality.
  const rp = input.triageProvenance;
  const canonical = rp && { ...rp, sourceFindingIds: [...rp.sourceFindingIds].sort() };
  const spec: SpecContract = {
    specId: `spec_${randomUUID()}`,
    projectId: input.projectId,
    orgId: projectOrgId,
    title: input.title,
    description: input.description,
    acceptanceCriteria: input.acceptanceCriteria,
    dependsOn: input.dependsOn ?? [],
    status: "open",
    priority: input.priority ?? DEFAULT_SPEC_PRIORITY,
    mode: input.mode ?? DEFAULT_SPEC_MODE,
    ...(canonical !== undefined && { triageProvenance: canonical }),
  };

  // Triage-routing PROVENANCE (Claude RA2): four nullable columns; a non-routed spec passes null.
  await client.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, depends_on,
                         status, priority, mode,
                         parent_spec_id, source_finding_ids, origin_triage_task_id, origin_run_id,
                         origin_issue_loop_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::text[], $8, $9, $10, $11, $12::text[], $13, $14, $15)`,
    [
      spec.specId,
      spec.projectId,
      spec.orgId,
      spec.title,
      spec.description,
      JSON.stringify(spec.acceptanceCriteria),
      spec.dependsOn,
      spec.status,
      spec.priority,
      spec.mode,
      canonical?.parentSpecId ?? null,
      canonical === undefined ? null : [...canonical.sourceFindingIds],
      canonical?.originTriageTaskId ?? null,
      canonical?.originRunId ?? null,
      canonical?.originIssueLoopId ?? null,
    ],
  );
  // Wake the DagWalker (notifyDagChanged): a fresh DAG's run channel never fires on its own.
  await notifyDagChanged(client, spec.projectId);
  return spec;
}

export async function createQueuedRunFromSpec(
  pool: pg.Pool,
  input: CreateSpecRunInput,
  actor?: ActorContext,
): Promise<SpecRunContract> {
  // RLS (write path): org-carrying actor → org-scoped tx; null-org (CLI) → manual tx.
  const orgId = actor?.orgId ?? null;
  if (orgId !== null) {
    return runWithOrgScope(pool, orgId, (client) => createQueuedRunFromSpecOnClient(client, input, actor));
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const run = await createQueuedRunFromSpecOnClient(client, input, actor);
    await client.query("COMMIT");
    return run;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureProjectAccess(pool: QueryClient, projectId: string, actor?: ActorContext): Promise<void> {
  if (actor === undefined || actor.scopes.includes("platform:admin")) {
    return;
  }
  const result = await pool.query<{ org_id: string | null }>("SELECT org_id FROM projects WHERE project_id = $1", [
    projectId,
  ]);
  // org_id is mandatory (no null-org bypass): a project with no resolvable org is denied.
  const projectOrg = result.rows[0]?.org_id ?? null;
  if (projectOrg === null) {
    throw new ProjectAccessDeniedError(projectId);
  }
  const memberResult = await pool.query<{ role: string }>(
    "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2",
    [projectId, actor.userId],
  );
  if ((memberResult.rowCount ?? 0) > 0) {
    return;
  }
  if (actor.orgId === projectOrg && actor.scopes.includes("org:member")) {
    return;
  }
  throw new ProjectAccessDeniedError(projectId);
}

/** JSON-encode a value for a jsonb column, or NULL when absent (the percolation columns). */
function jsonbOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function defaultRunBranch(spec: SpecContract): string {
  const slug = spec.title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 48);
  return `tanren/${slug || "spec"}-${spec.specId.replace(/^spec_/u, "").slice(0, 8)}`;
}

async function ensureProjectExists(pool: QueryClient, projectId: string): Promise<void> {
  const result = await pool.query("SELECT project_id FROM projects WHERE project_id = $1", [projectId]);
  if (result.rowCount === 0) {
    throw new ProjectNotFoundError(projectId);
  }
}

async function ensureSpecDependenciesExist(pool: QueryClient, projectId: string, dependsOn: string[]): Promise<void> {
  const uniqueDependsOn = [...new Set(dependsOn)];
  if (uniqueDependsOn.length === 0) {
    return;
  }
  const result = await pool.query("SELECT spec_id FROM specs WHERE project_id = $1 AND spec_id = ANY($2::text[])", [
    projectId,
    uniqueDependsOn,
  ]);
  const found = new Set(result.rows.map((row) => String(row.spec_id)));
  const missing = uniqueDependsOn.filter((specId) => !found.has(specId));
  if (missing.length > 0) {
    throw new SpecNotFoundError(missing.join(", "));
  }
}

export async function createQueuedRunFromSpecOnClient(
  client: pg.PoolClient,
  input: CreateSpecRunInput,
  actor?: ActorContext,
): Promise<SpecRunContract> {
  const loaded = await loadSpecWithProject(client, input.specId);
  await ensureClientProjectAccess(client, loaded.project.projectId, actor);
  // a speculative start skips the done-only gate (the walker enforced the threshold gate).
  if (input.speculative === undefined) await ensureSpecDependenciesDone(client, loaded.spec);
  const plannerTaskId = `task_${randomUUID()}`;
  const run: SpecRunContract = {
    runId: `run_${randomUUID()}`,
    specId: loaded.spec.specId,
    projectId: loaded.project.projectId,
    orgId: loaded.project.orgId,
    trigger: input.trigger ?? "cli",
    branch: input.branch ?? defaultRunBranch(loaded.spec),
    status: "queued",
    plannerTaskId,
    plannerJobId: "",
    project: loaded.project,
    spec: { ...loaded.spec, status: "in_flight" },
  };

  // Percolation columns set only on a speculative start; jj-local writes ONLY
  // `ancestor_stack` (the SOLE base truth post-WS-B PR-12).
  const spec = input.speculative;
  // v68: explicit org_id replaces the prior derive-from-project subquery.
  await client.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status,
                       verified_ancestor_shas, percolation_pending, ancestor_stack)
     VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9)`,
    [
      run.runId,
      run.specId,
      run.projectId,
      run.orgId,
      run.trigger,
      run.branch,
      jsonbOrNull(spec?.verifiedAncestorShas),
      jsonbOrNull(spec?.percolationPending),
      jsonbOrNull(spec?.ancestorStack),
    ],
  );
  // OBSERVE-ONLY: UPSERT the `integration_nodes` row mirroring this run (see the hook header). NEVER fails a run.
  await observeRunAsIntegrationNode(client, run, spec);
  await claimPendingSpec(client, loaded.spec);
  // The placeholder plan row (see UNASSIGNED_PLANNER_CLI): `model` stays NULL —
  // no harness, and therefore no model, has been assigned at queue time.
  await client.query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
     VALUES ($1, $2, (SELECT org_id FROM runs WHERE run_id = $2), 'plan', 'Plan spec implementation', 'queued', 'answerer', $3, NULL)`,
    [plannerTaskId, run.runId, UNASSIGNED_PLANNER_CLI],
  );
  const job = await client.query(
    // RLS R3b: stamp the run's org_id on the queue row (job_queue is OUTSIDE RLS).
    `INSERT INTO job_queue (run_id, task_id, task_kind, payload, org_id)
     VALUES ($1, $2, 'plan', $3::jsonb, (SELECT org_id FROM runs WHERE run_id = $1))
     RETURNING id::text`,
    [run.runId, plannerTaskId, JSON.stringify({ specId: run.specId, projectId: run.projectId, branch: run.branch })],
  );
  run.plannerJobId = String(job.rows[0]?.id);
  // LISTEN/NOTIFY: wake an idle worker the instant this run's plan job is enqueued.
  // The NOTIFY rides this tx's COMMIT, so it fires exactly when the row is visible.
  await notifyJobEnqueued(client);
  const eventStore = new PgEventStore(client);
  await eventStore.append({
    runId: run.runId,
    specId: run.specId,
    projectId: run.projectId,
    orgId: run.orgId,
    eventType: "run.queued",
    payload: {
      trigger: run.trigger,
      branch: run.branch,
      plannerTaskId: run.plannerTaskId,
      plannerJobId: run.plannerJobId,
      project: {
        repoUrl: run.project.repoUrl,
        defaultBranch: run.project.defaultBranch,
        runnerImage: run.project.runnerImage,
        allocator: run.project.allocator,
      },
      spec: {
        title: run.spec.title,
        acceptanceCriteria: run.spec.acceptanceCriteria,
        dependsOn: run.spec.dependsOn,
      },
    },
  });
  await eventStore.append({
    runId: run.runId,
    taskId: run.plannerTaskId,
    specId: run.specId,
    projectId: run.projectId,
    orgId: run.orgId,
    eventType: "task.queued",
    payload: { taskKind: "plan", jobId: run.plannerJobId },
  });
  return run;
}

async function claimPendingSpec(client: pg.PoolClient, spec: SpecContract): Promise<void> {
  const result = await client.query(
    "UPDATE specs SET status = 'in_flight' WHERE spec_id = $1 AND status = 'open' RETURNING spec_id",
    [spec.specId],
  );
  if (result.rowCount === 0) {
    throw new SpecNotRunnableError(spec.specId, spec.status);
  }
}

async function ensureSpecDependenciesDone(client: pg.PoolClient, spec: SpecContract): Promise<void> {
  if (spec.dependsOn.length === 0) {
    return;
  }
  // A dependency is SATISFIED when its spec reached the terminal-complete `merged` status.
  // This gate MUST agree with the planner; SpecDependenciesBlockedError is benign-transient.
  const result = await client.query(
    "SELECT spec_id FROM specs WHERE project_id = $1 AND status = 'merged' AND spec_id = ANY($2::text[])",
    [spec.projectId, spec.dependsOn],
  );
  const done = new Set(result.rows.map((row) => String(row.spec_id)));
  const blocked = spec.dependsOn.filter((specId) => !done.has(specId));
  if (blocked.length > 0) {
    throw new SpecDependenciesBlockedError(spec.specId, blocked);
  }
}

async function ensureClientProjectAccess(
  client: pg.PoolClient,
  projectId: string,
  actor?: ActorContext,
): Promise<void> {
  if (actor === undefined || actor.scopes.includes("platform:admin")) {
    return;
  }
  const projectRow = await client.query<{ org_id: string | null }>(
    "SELECT org_id FROM projects WHERE project_id = $1",
    [projectId],
  );
  const projectOrg = projectRow.rows[0]?.org_id ?? null;
  if (projectOrg === null) {
    throw new ProjectAccessDeniedError(projectId);
  }
  const memberResult = await client.query<{ role: string }>(
    "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2",
    [projectId, actor.userId],
  );
  if ((memberResult.rowCount ?? 0) > 0) {
    return;
  }
  if (actor.orgId === projectOrg && actor.scopes.includes("org:member")) {
    return;
  }
  throw new ProjectAccessDeniedError(projectId);
}
