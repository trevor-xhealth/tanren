// The `DagWalker` seam: the per-project background scheduler that turns the spec
// DAG into self-driving execution (autonomy-engine.md §1a — the keystone). It is
// a SCHEDULER over the EXISTING run executor, mirroring how the BenchmarkRunner
// schedules trials — NOT a second executor. On startup and on every
// run.*-terminal / merge.completed notification for a project, the walker:
//
//   1. Loads the project's spec DAG (specs + dependsOn edges + status) under RLS
//      — DAG state is the source of truth, never in-memory.
//   2. Computes the READY SET: pending specs whose dependencies are all DONE
//      (the same predicate the manual-trigger path enforces via
//      ensureSpecDependenciesDone). Speculative readiness (§2c) is layered on
//      top; base readiness = all deps merged/done.
//   3. Orders the ready set deterministically (priority comes in P1b; here a
//      stable creation-order tiebreak, with a clean seam for priority ordering).
//   4. Enqueues up to the GOVERNED CONCURRENCY HEADROOM (the config ceiling,
//      never an env var) of ready specs via createQueuedRunFromSpec — the
//      SAME parallel worker runs them.
//
// Idempotent: a spec already in-flight (active / building / pr_open / running) is
// never re-enqueued; it stops when the DAG is drained, budget is exhausted, or it
// is blocked on human input. Milestones are LABELS, never gates — the walker
// never pauses at a milestone boundary.
//
// This contract carries the SEAMS (read model + enqueuer) and the PURE planner
// (`planDagTick`) so the scheduling decision is conformance-tested independent of
// any database or worker. The pg-backed read model + the createQueuedRunFromSpec
// enqueuer + the LISTEN/NOTIFY subscriber live in `engine/dag/walker.ts`.

import type { BudgetPeriod, SpeculationThreshold } from "../config/shared.js";
import type { DagLifecycleSnapshot } from "./dagLifecycle.js";
import type { AncestorStack } from "../dag/ancestorStack.js";
import { computeReadiness, type SpecReadiness } from "../dag/speculation.js";
import { priorityRank, type SpecPriority } from "../state/spec.js";

// ---- DAG snapshot ---------------------------------------------------------

/**
 * The lifecycle states a spec can occupy from the walker's vantage point,
 * normalized from the run-lifecycle spec status (engine/state/spec.ts) into the
 * three buckets that drive scheduling. The Phase-0/1 enum the run loop persists
 * is `pending → active → done`; the Phase-2 canonical enum adds
 * `open/in_flight/review/merged/halted/cancelled`. The walker only needs to know
 * whether a spec is a candidate (pending), occupying a slot (in-flight), or a
 * satisfied dependency (done) — `classifySpecStatus` maps both enums onto these.
 */
export type DagSpecPhase = "pending" | "in_flight" | "done" | "terminal_blocked";

/**
 * Codex H3 #9 — the four triage-routing PROVENANCE columns (Claude RA2, migration
 * 0025) surfaced on a routed spec. A snapshot node carries `triageProvenance` iff
 * the spec was auto-routed by triage from a parent spec's finding; operator /
 * discovery / seed specs omit. Downstream operator surfaces (the DAG view, the
 * spec-detail routes) render the routing chain from this field so a routed spec's
 * origin is visible without a second SELECT.
 */
export interface DagSpecTriageProvenance {
  parentSpecId: string;
  sourceFindingIds: string[];
  originTriageTaskId: string;
  originRunId: string;
  originIssueLoopId?: string;
}

/** One spec node in the project's DAG, as the walker reasons over it. */
export interface DagSpecNode {
  specId: string;
  /** The walker-relevant phase, already normalized from the persisted status. */
  phase: DagSpecPhase;
  /** The spec ids this spec depends on (its `depends_on` edges). */
  dependsOn: string[];
  /**
   * The spec's execution priority (autonomy-engine.md §1b). The PRIMARY ordering
   * key of the ready set: P0 before P1 before P2 before `tbd` (via `priorityRank`).
   * `orderKey`/`specId` are the deterministic tiebreak WITHIN a priority.
   */
  priority: SpecPriority;
  /**
   * A stable, monotonic ordering key (creation order) — the deterministic
   * tiebreak applied AFTER priority. Lower sorts first.
   */
  orderKey: number;
  /**
   * Codex H3 #9 — the triage-routing PROVENANCE trail, present iff this spec was
   * auto-routed by triage from a parent spec's finding. Undefined for a non-routed
   * spec (operator create / discovery accept / seed). Scheduling ignores this
   * field; it is a display-only enrichment that lets the DAG-snapshot consumer
   * surface the routing chain to operators.
   */
  triageProvenance?: DagSpecTriageProvenance;
}

/** A point-in-time snapshot of a project's spec DAG, loaded under RLS. */
export interface DagSnapshot {
  projectId: string;
  nodes: DagSpecNode[];
  /**
   * Exact project lifecycle. Only `active` is runnable: both a partial deriving
   * shell and an operator-archived project are dormant.
   */
  projectLifecycle: "deriving" | "active" | "archived" | "missing";
}

// ---- Tick plan (the pure scheduling decision) -----------------------------

/** Why a walker tick produced the outcome it did — drives the emitted event. */
export type DagTickStatus =
  // The walker enqueued one or more ready specs this tick.
  | "enqueued"
  // No pending spec is ready (all deps done) AND no slot pressure — every spec is
  // done or in-flight, or pending specs remain blocked on unfinished deps.
  | "drained"
  // Ready specs exist but the governed CONCURRENCY ceiling is already saturated —
  // the walker held them back (no in-flight slot free). Honestly named: this is
  // slot pressure, NOT a dollar-budget pause (which `budget_paused` now means).
  | "concurrency_saturated"
  // GENUINE dollar-budget exhaustion: the project's cumulative spend over the
  // configured period reached the configured ceiling, so the walker enqueued
  // NOTHING this tick. Decided in the walker (it needs the live spend sum), never
  // in the pure planner — the pure planners only ever produce
  // enqueued/drained/concurrency_saturated; the walker overrides to budget_paused.
  | "budget_paused"
  // Non-active project lifecycle: short-circuit before planning.
  | "archived"
  | "deriving"
  | "inactive";

/** The deterministic plan a tick produces from a snapshot + a ceiling. */
export interface DagTickPlan {
  status: DagTickStatus;
  /** Spec ids to enqueue THIS tick, in deterministic order, capped to headroom. */
  toEnqueue: string[];
  /** In-flight count at plan time (specs occupying a slot). */
  inFlightCount: number;
  /** Done-spec count (satisfied dependencies). */
  doneCount: number;
  /** Pending specs NOT ready — blocked on an unfinished dependency. */
  blockedCount: number;
  /** Ready specs that did not fit under the ceiling (the held-back count). */
  readyHeldBack: number;
  /** The governed concurrency ceiling the plan respected. */
  concurrencyCeiling: number;
}

/**
 * The PURE scheduling core (no DB, no I/O, no clock): given a DAG snapshot and
 * the governed concurrency ceiling, decide exactly which specs to enqueue this
 * tick and classify the outcome. This is the behavior the conformance suite pins.
 *
 * Readiness predicate (Phase-1 baseline, mirrors ensureSpecDependenciesDone): a
 * `pending` spec is ready iff EVERY id in its `dependsOn` resolves to a node in
 * `done` phase. A dependency that is missing, pending, in-flight, or terminally
 * blocked makes the spec NOT ready. A `pending` spec with no dependencies is
 * always ready (a root).
 *
 * Ordering: ready specs sort by `priority` first (P0 → P1 → P2 → tbd), then the
 * stable creation-order tiebreak (`orderKey`, then `specId`). `orderReadySet` is
 * the single ordering seam the planner calls, so the priority order is honored
 * here (autonomy-engine.md §1b).
 *
 * Headroom: enqueue at most `max(0, ceiling - inFlightCount)` specs. A spec
 * already in-flight is NEVER re-enqueued (idempotency) — it is counted as a slot
 * consumer, not a candidate.
 */
export function planDagTick(snapshot: DagSnapshot, concurrencyCeiling: number): DagTickPlan {
  if (!Number.isInteger(concurrencyCeiling) || concurrencyCeiling < 1) {
    throw new RangeError(`concurrencyCeiling must be a positive integer, got ${concurrencyCeiling}`);
  }
  const byId = new Map<string, DagSpecNode>();
  for (const node of snapshot.nodes) {
    byId.set(node.specId, node);
  }

  const doneCount = snapshot.nodes.filter((n) => n.phase === "done").length;
  const inFlightCount = snapshot.nodes.filter((n) => n.phase === "in_flight").length;

  const pending = snapshot.nodes.filter((n) => n.phase === "pending");
  const ready = pending.filter((n) => isReady(n, byId));
  const blockedCount = pending.length - ready.length;

  const ordered = orderReadySet(ready);
  const headroom = Math.max(0, concurrencyCeiling - inFlightCount);
  const toEnqueue = ordered.slice(0, headroom).map((n) => n.specId);
  const readyHeldBack = ordered.length - toEnqueue.length;

  const status: DagTickStatus =
    toEnqueue.length > 0 ? "enqueued" : readyHeldBack > 0 ? "concurrency_saturated" : "drained";

  return {
    status,
    toEnqueue,
    inFlightCount,
    doneCount,
    blockedCount,
    readyHeldBack,
    concurrencyCeiling,
  };
}

/**
 * The Phase-1 readiness predicate: a pending spec is ready iff every dependency
 * resolves to a DONE node. A missing dependency (an edge to an id not in the
 * snapshot) is treated as unsatisfied — the spec is held, never run on a phantom.
 */
function isReady(node: DagSpecNode, byId: Map<string, DagSpecNode>): boolean {
  return node.dependsOn.every((depId) => byId.get(depId)?.phase === "done");
}

// ---- Speculative tick plan (autonomy-engine.md §2c) -----------------

/**
 * The per-spec speculation outcome the walker narrates: each spec the walker
 * enqueues this tick carries whether it was a speculative start (and on which
 * unmerged ancestors), so the dag.spec.speculative event names them.
 */
export interface PlannedEnqueue {
  specId: string;
  speculative: boolean;
  /** The unmerged ancestors forming the integration branch (empty when not speculative). */
  unmergedAncestors: string[];
}

/**
 * The speculative tick plan: the Phase-1 `DagTickPlan` shape enriched with
 * per-spec speculation info (`enqueues`) and the specs HELD over the depth cap
 * (`held` — surfaced so the walker logs dag.spec.speculation_held rather than
 * silently truncating, §2c "no silent caps"). `toEnqueue` stays the bare ordered
 * id list for parity with the Phase-1 plan's consumers.
 */
export interface DagSpeculativeTickPlan extends DagTickPlan {
  enqueues: PlannedEnqueue[];
  held: SpecReadiness[];
}

/**
 * The PURE speculative scheduling core (no DB, no I/O): the §2c readiness model.
 * Identical to `planDagTick` EXCEPT readiness is "all deps crossed the configured
 * SPECULATION THRESHOLD" (per the lifecycle projection), not "all deps done". A
 * spec ready with one or more deps not-yet-merged is SPECULATIVE; a spec that
 * would be ready but whose unmerged-ancestor depth exceeds the cap is HELD (not
 * truncated). Ordering, headroom, and idempotency hold every tick.
 *
 * `conservative` reduces EXACTLY to the Phase-1 predicate (a crossed ancestor is a
 * merged one — `phase === "done"`), so the baseline behavior is preserved.
 */
export function planSpeculativeDagTick(
  snapshot: DagSnapshot,
  lifecycle: DagLifecycleSnapshot,
  options: { concurrencyCeiling: number; threshold: SpeculationThreshold; depthCap: number },
): DagSpeculativeTickPlan {
  const { concurrencyCeiling, threshold, depthCap } = options;
  if (!Number.isInteger(concurrencyCeiling) || concurrencyCeiling < 1) {
    throw new RangeError(`concurrencyCeiling must be a positive integer, got ${concurrencyCeiling}`);
  }

  const doneCount = snapshot.nodes.filter((n) => n.phase === "done").length;
  const inFlightCount = snapshot.nodes.filter((n) => n.phase === "in_flight").length;
  const pending = snapshot.nodes.filter((n) => n.phase === "pending");

  const readiness = computeReadiness(pending, snapshot.nodes, lifecycle, threshold, depthCap);
  const ready = pending.filter((n) => readiness.get(n.specId)?.ready === true);
  const held = pending.map((n) => readiness.get(n.specId)).filter((r): r is SpecReadiness => r?.held === true);
  // Blocked = pending, not ready, not held (genuinely waiting on an ancestor that
  // has not crossed the threshold).
  const blockedCount = pending.length - ready.length - held.length;

  const ordered = orderReadySet(ready);
  const headroom = Math.max(0, concurrencyCeiling - inFlightCount);
  const orderedToEnqueue = ordered.slice(0, headroom);
  const toEnqueue = orderedToEnqueue.map((n) => n.specId);
  const readyHeldBack = ordered.length - toEnqueue.length;

  const enqueues: PlannedEnqueue[] = orderedToEnqueue.map((n) => {
    const r = readiness.get(n.specId);
    return {
      specId: n.specId,
      speculative: r?.speculative ?? false,
      unmergedAncestors: r?.unmergedAncestors ?? [],
    };
  });

  const status: DagTickStatus =
    toEnqueue.length > 0 ? "enqueued" : readyHeldBack > 0 ? "concurrency_saturated" : "drained";

  return {
    status,
    toEnqueue,
    enqueues,
    held,
    inFlightCount,
    doneCount,
    blockedCount,
    readyHeldBack,
    concurrencyCeiling,
  };
}

/**
 * Order the ready set deterministically (autonomy-engine.md §1b): PRIORITY first
 * (P0 → P1 → P2 → tbd via `priorityRank`), then the stable creation-order
 * tiebreak (`orderKey` ascending, then `specId` for total determinism) WITHIN a
 * priority. This is the SINGLE ordering seam the planner calls, so a higher-
 * priority spec always schedules ahead of a lower one regardless of creation
 * order, while ties resolve identically every tick.
 */
export function orderReadySet(ready: ReadonlyArray<DagSpecNode>): DagSpecNode[] {
  return [...ready].sort((a, b) => {
    const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
    if (byPriority !== 0) return byPriority;
    return a.orderKey === b.orderKey ? compareIds(a.specId, b.specId) : a.orderKey - b.orderKey;
  });
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- Seams ----------------------------------------------------------------

/**
 * Loads a project's spec-DAG snapshot under RLS. DAG state is the source of
 * truth (autonomy-engine.md §1.7) — the read happens fresh every tick, never
 * cached in memory. The pg-backed impl org-scopes the read; an off-scope read
 * sees zero rows (RLS denies by default), so the snapshot is always the calling
 * org's DAG.
 */
export interface DagReadModel {
  loadSnapshot(projectId: string): Promise<DagSnapshot>;
}

/**
 * Enqueues a run for one ready spec, via the EXISTING createQueuedRunFromSpec
 * path — the SAME path a manual operator trigger uses and the SAME parallel
 * worker then runs. Returns the new run id (for the dag.spec.enqueued event). It
 * atomically claims the pending spec (pending → active), so a concurrent tick can
 * never double-enqueue the same spec — the claim is the idempotency boundary.
 */
export interface DagEnqueuer {
  enqueueSpecRun(input: {
    projectId: string;
    specId: string;
    /**
     * walker-jj-local-integration-design.md §2.3: the ordered unmerged-ancestor stack
     * the run is stacked on — `[{ specId, runId, branch, headSha }]` (DAG order). Present
     * iff the walker started this spec SPECULATIVELY; persisted on the run as
     * `runs.ancestor_stack` (the jj-local base source the dependent assembles from at
     * bootstrap). When set, the enqueuer skips the `done`-only dependency gate (the walker
     * already enforced the threshold gate). Absent ⇒ a normal start (full dependency-done
     * gate + `default_branch` base). NO synthesized host integration ref is written.
     */
    ancestorStack?: AncestorStack;
  }): Promise<{ runId: string }>;
}

// ---- Budget gate (autonomy-engine.md §3 proof 6) --------------------------

/**
 * Why the budget gate FAILS CLOSED rather than the ordinary ceiling-reached path
 * (BUDGET-SAFETY C1b / M5). The walker pauses on any of these exactly as it pauses
 * on a reached ceiling — an unpriced/unparseable budget can never be allowed to
 * silently keep enqueuing real spend:
 *   - `unpriced_spend` — the window has cost_records rows with NULL cost_usd that
 *     are NOT honestly-unpriceable (cost_basis='unattributed': an unrecognized
 *     credential ref that SHOULD have priced). Their dollars are unknown, so the
 *     true spend may already exceed the ceiling; assume the ceiling is reached.
 *   - `unparseable_config` — a PRESENT-but-undecodable project/org budget config
 *     blob. We will not fail OPEN to unlimited on a config we cannot read.
 *   - `unresolvable_project_org` — the project row is missing OR its `org_id` is
 *     NULL (a corrupt/deleted row, an in-flight ownership migration). "The budget
 *     is the only run gate" (safety invariant) means we cannot silently degrade to
 *     `ceilingUsd: undefined` (which reads as UNLIMITED) on a project we cannot
 *     read: an ordinary budget-enforcement read failure would then become "no
 *     budget configured" and let spend run past whatever ceiling the operator
 *     intended. Fail CLOSED instead — the walker pauses on budget with this reason
 *     so operators can distinguish it from an intentional ceiling-reached pause.
 */
export type BudgetFailClosedReason = "unpriced_spend" | "unparseable_config" | "unresolvable_project_org";

/**
 * A project's resolved budget state at walk time: the configured ceiling (project
 * budget over org default, or absent = unlimited) and the cumulative spend summed
 * over the configured period from `cost_records`. The walker consults this BEFORE
 * enqueuing; when `ceilingUsd` is set and `spentUsd >= ceilingUsd`, the tick
 * pauses on budget (enqueues nothing, emits dag.budget.paused). `ceilingUsd:
 * undefined` ⇒ NO budget configured ⇒ unlimited (byte-identical to today).
 *
 * `failClosed` (BUDGET-SAFETY C1b / M5): when set, the gate PAUSES regardless of
 * the measured `spentUsd` — an unpriced or unparseable budget cannot be assumed to
 * be under the ceiling. It is only ever set on a project that HAS a budget concern
 * (a configured ceiling, or a present-but-broken config); an absent budget stays
 * legitimately unlimited.
 */
export interface ProjectBudgetState {
  ceilingUsd: number | undefined;
  period: BudgetPeriod;
  /**
   * REAL SPEND (FOCUS BilledCost; `cost_records.cost_usd`) over the period — the
   * ONLY figure the gate compares against the ceiling. Named "spent" because it is
   * the only field that is genuine money out the door.
   */
  spentUsd: number;
  /**
   * NOTIONAL / API-EQUIVALENT VALUE (FOCUS ListCost; `cost_records.notional_cost_usd`)
   * over the SAME period — the list-priced ESTIMATE, surfaced alongside real spend so
   * a subscription/Teams org sees a non-zero figure. NOT money; never gated, never
   * called "spend". The gate ignores it.
   */
  notionalUsd: number;
  /**
   * How many rows in the window are UN-PRICED REAL SPEND — `cost_usd IS NULL` with a
   * real-spend-bearing `billing_mode` (`per_token` / `unattributed`). This is the
   * exact population behind `failClosed: 'unpriced_spend'`, surfaced because the bare
   * flag is not actionable: an operator cannot tell whether one stray row or the
   * whole window is unpriced, nor that the rows may be the CURRENT run's own (in
   * which case raising the ceiling cannot clear the pause — see
   * docs/_design/openrouter-cost-attribution.md). Optional so an injected test gate
   * need not supply it; absent means "not measured", never "zero".
   */
  unpricedCount?: number;
  failClosed?: BudgetFailClosedReason;
}

/** True iff a configured ceiling has been reached (the genuine budget gate). */
export function isBudgetExhausted(state: ProjectBudgetState): boolean {
  return state.ceilingUsd !== undefined && state.spentUsd >= state.ceilingUsd;
}

/**
 * The full budget-pause decision the walker consults (BUDGET-SAFETY C1b / M5):
 * pause when the configured ceiling has been reached (the genuine gate) OR when the
 * gate must fail CLOSED (unpriced spend / unparseable config). Either way NO new
 * spec runs are enqueued this tick.
 */
export function shouldPauseOnBudget(state: ProjectBudgetState): boolean {
  return state.failClosed !== undefined || isBudgetExhausted(state);
}

/**
 * Resolves a project's budget state under RLS: the project-over-org budget config
 * + the cumulative spend over the configured period (the org-scoped `cost_records`
 * sum). DAG/cost state is the source of truth — read fresh each tick. The pg-backed
 * impl org-scopes the cost-sum read (an off-scope read sees zero rows), so the spend
 * is always exactly the calling org's. A project with no budget configured resolves
 * `ceilingUsd: undefined` (unlimited) and skips the (otherwise unnecessary) sum.
 */
export interface BudgetGate {
  resolveBudget(projectId: string): Promise<ProjectBudgetState>;
}

/** What a single walk produced — surfaced for the subscriber + tests to assert. */
export interface WalkResult {
  projectId: string;
  status: DagTickStatus;
  /** The spec ids actually enqueued this walk (in order). */
  enqueuedSpecIds: string[];
  /** The run ids created for them (parallel to enqueuedSpecIds). */
  enqueuedRunIds: string[];
}

/**
 * The per-project DagWalker. `walk(projectId)` performs one full scheduling pass:
 * load the snapshot → plan the tick → enqueue up to headroom → emit the outcome
 * event(s). The subscriber calls it on startup and on every relevant notification
 * for the project. `walk` is the unit of work the conformance suite drives.
 */
export interface DagWalker {
  walk(projectId: string): Promise<WalkResult>;
}

/**
 * The DagWalker INTEGRATION PHASE seam (in-9/in-10 capability_prepare). The walker
 * runs it once per walk of an active project, before spec planning, so a spec that
 * depends on a prepared integration binding sees fresh capability state. The
 * production impl is the `CapabilityPrepareDriver`; the walker depends only on this
 * capability so it never imports the concrete integrations module.
 */
export interface IntegrationPhase {
  prepare(projectId: string): Promise<unknown>;
}
