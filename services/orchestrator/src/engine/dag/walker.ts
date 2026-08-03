// The production DagWalker (autonomy-engine.md §1a keystone + §2c speculative execution). A per-project background
// SCHEDULER over the EXISTING run executor (it mirrors how the BenchmarkRunner schedules trials — it does NOT execute
// runs itself). Each tick it loads the spec DAG + the per-spec LIFECYCLE PROJECTION under RLS, plans the tick with the
// pure `planSpeculativeDagTick` core (readiness = all deps crossed the configured SPECULATION THRESHOLD, not just
// merged), and for each ready spec RESOLVES its ordered unmerged-ancestor stack (when it has unmerged ancestors) and
// enqueues it carrying that `ancestor_stack` through the SAME createQueuedRunFromSpec path a manual operator trigger
// uses. The dependent run's own runner later jj-ASSEMBLES its base LOCALLY from those real ancestor PR-head refs (the
// bootstrap, `plannerRunJjLocalBootstrap.ts`) — there is NO orchestrator-synthesized `tanren/integ` host ref. The
// parallel run-executor worker then runs them.
//
// The pg seam wirings (read model + lifecycle projection + enqueuer + event emitter + the org-scoped ancestor-stack
// resolver) live in `walkerPg.ts`. The LISTEN/NOTIFY subscriber that runs the walker on startup + on every
// run.*-terminal / merge.completed notification (incl. ancestor-merge → dependent re-gate) lives in `subscriber.ts`.

import { getSystemPool, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { resolveWorkerConcurrency, type SpeculationThreshold } from "../config/index.js";
import {
  type BudgetGate,
  type DagEnqueuer,
  type DagReadModel,
  type DagWalker,
  type IntegrationPhase,
  planSpeculativeDagTick,
  type PlannedEnqueue,
  shouldPauseOnBudget,
  type WalkResult,
} from "../contracts/dagWalker.js";
import type { DagLifecycleReadModel, DagLifecycleSnapshot } from "../contracts/dagLifecycle.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { SpecDependenciesBlockedError, SpecNotRunnableError } from "../workflow/projectSpecErrors.js";
import type { SpecReadiness } from "./speculation.js";
import { pauseDagOnBudget } from "./budgetPause.js";
import { buildConcurrencyResolver, buildSpeculationConfigResolver } from "./walkerConfigResolvers.js";
import { ancestorLifecycleKey, HeldReDriveBackoff } from "./heldReDriveBackoff.js";
import {
  budgetMilestoneEvents,
  completedWalkResult,
  decideAncestorWait,
  inactiveProjectWalkResult,
  pruneAncestorWaitBackoff,
  speculativeEnqueuedEvent,
  standardEnqueuedEvent,
  type AncestorStack,
  unresolvedAncestorStack,
} from "./walkerTransitions.js";
import { PgBudgetGate } from "./budgetGate.js";
import { PgDagLifecycleReadModel } from "./lifecycle.js";
import {
  type DagAncestorStackResolver,
  type DagEventEmitter,
  PgDagAncestorStackResolver,
  PgDagEventEmitter,
  PgDagReadModel,
  SpecRunDagEnqueuer,
} from "./walkerPg.js";
import { createLogger } from "../observability/logger.js";
const log = createLogger("dag-walker");

/**
 * Resolve the governed concurrency ceiling FOR A PROJECT — the config knob
 * (project-over-org-over-default), never an env var. Async so the production
 * resolver can read the persisted config; a test may return the number directly.
 */
export type ConcurrencyResolver = (projectId: string) => number | Promise<number>;

/** The per-project speculation config (autonomy-engine.md §2c): threshold + depth cap. */
export interface SpeculationConfig {
  threshold: SpeculationThreshold;
  depthCap: number;
}

/** Resolve a project's speculation config from its versioned config (never an env var). */
export type SpeculationConfigResolver = (projectId: string) => Promise<SpeculationConfig>;

export interface DagWalkerDeps {
  readModel: DagReadModel;
  /** the per-spec lifecycle projection the speculation threshold reasons over. */
  lifecycleReadModel: DagLifecycleReadModel;
  enqueuer: DagEnqueuer;
  events: DagEventEmitter;
  /**
   * The dollar-budget gate (autonomy-engine.md §3 proof 6): resolves the project's
   * configured ceiling (project-over-org) + cumulative spend over the period before
   * enqueuing. When the ceiling is reached the walk pauses on budget (enqueues
   * nothing, emits dag.budget.paused). A project with no budget configured resolves
   * `ceilingUsd: undefined` ⇒ unlimited ⇒ behavior byte-identical to today.
   */
  budgetGate: BudgetGate;
  /**
   * Resolves a dependent's ordered unmerged-ancestor stack (the real PR-head branches it
   * will jj-assemble its base from, DAG-ordered) — org-scoped (RLS). The walker persists
   * this on the speculative run as `ancestor_stack`; NO host integration ref is built.
   */
  ancestorStackResolver: DagAncestorStackResolver;
  /** resolves the project's speculation threshold + depth cap from config. */
  speculationConfig: SpeculationConfigResolver;
  /** in-9/in-10 capability_prepare phase, run once per active-project walk before spec planning (optional). */
  integrationPhase?: IntegrationPhase;
  /**
   * The governed concurrency ceiling (autonomy-engine.md §1.4): the walked project's
   * persisted `allocator.concurrency` over its org's over the schema default —
   * `buildConcurrencyResolver`, which `buildDagWalker` wires. Never read from
   * `process.env`. Omitted (unit tests / an injected-deps walker) it falls back to the
   * config-surface default, the SAME ceiling the process-wide worker boots with.
   */
  concurrency?: ConcurrencyResolver;
  /**
   * ANCESTOR-NOT-READY RE-DRIVE BACKOFF + PROGRESS GATE (apex v35 + v45 hot-loop fix): the
   * per-spec backoff that gates re-driving a speculative dependent by time AND ancestor progress
   * (see `enqueueOne` + `ancestorWaitGate.ts`). A test injects a clock-controlled one.
   */
  ancestorWaitBackoff?: HeldReDriveBackoff;
}

/**
 * The production DagWalker. `walk(projectId)` performs one full scheduling pass:
 * load the DAG + lifecycle snapshots under RLS → plan the tick with the pure
 * SPECULATIVE core (readiness = all deps crossed the configured threshold) → for
 * each ready spec, resolve its ordered unmerged-ancestor stack (when it has unmerged
 * ancestors) and enqueue it carrying that `ancestor_stack` → emit the outcome event(s).
 * It never holds DAG state in memory across ticks (it reloads every walk), so the
 * DAG rows are always the source of truth. The subscriber drives it on startup +
 * on every relevant notification (incl. ancestor `merge.completed`, which re-walks
 * so a freshly-merged ancestor re-gates its dependents against reality —).
 */
export class EventEmittingDagWalker implements DagWalker {
  private readonly concurrency: ConcurrencyResolver;
  /** Per-spec ANCESTOR-NOT-READY re-drive backoff (apex v35 hot-loop fix); see `enqueueOne`. */
  private readonly ancestorWaitBackoff: HeldReDriveBackoff;

  constructor(private readonly deps: DagWalkerDeps) {
    this.concurrency = deps.concurrency ?? (() => resolveWorkerConcurrency());
    this.ancestorWaitBackoff = deps.ancestorWaitBackoff ?? new HeldReDriveBackoff();
  }

  async walk(projectId: string): Promise<WalkResult> {
    const [snapshot, lifecycle, config, budget] = await Promise.all([
      this.deps.readModel.loadSnapshot(projectId),
      this.deps.lifecycleReadModel.loadLifecycle(projectId),
      this.deps.speculationConfig(projectId),
      this.deps.budgetGate.resolveBudget(projectId),
    ]);

    // Bounded backoff map (issue #1072 F1): before any early return, free this project's
    // ancestor-wait entries for specs no longer in-play (DAG-phase terminal; see the helper).
    pruneAncestorWaitBackoff(this.ancestorWaitBackoff, projectId, snapshot);

    // Exact lifecycle gate: only a fully activated project may enter planning.
    if (snapshot.projectLifecycle !== "active") {
      return inactiveProjectWalkResult(projectId, snapshot.projectLifecycle);
    }

    // INTEGRATION PHASE (in-9/in-10): materialize + prepare the capability graph before
    // spec planning. Fail-safe (isolated .catch) so a prepare error never starves
    // scheduling — its tx rolled back, node state unchanged, next walk retries.
    await this.deps.integrationPhase
      ?.prepare(projectId)
      .catch((error) => log.error("capability_prepare phase failed; next walk retries", { projectId }, error));

    // Plan the tick BEFORE the budget short-circuit. The plan is the sole
    // readiness computation, and a truthful budget-pause observation needs to
    // report every otherwise-eligible spec the money gate stopped. The former
    // path returned before planning and therefore hard-coded readyHeldBack=0,
    // even with ready roots in the loaded snapshot.
    const ceiling = await this.concurrency(projectId);
    const plan = planSpeculativeDagTick(snapshot, lifecycle, {
      concurrencyCeiling: ceiling,
      threshold: config.threshold,
      depthCap: config.depthCap,
    });

    // The dollar-budget gate (autonomy-engine.md §3 proof 6 + BUDGET-SAFETY C1b/M5):
    // when the project's cumulative spend has reached the configured ceiling — OR the
    // gate must FAIL CLOSED (unpriced spend / unparseable config) — enqueue NOTHING
    // this tick and pause on budget. In-flight runs are NOT touched (they are bounded
    // by the escape hatches) — only NEW work stops. A project with no budget concern
    // (`ceilingUsd: undefined`, no failClosed) never hits this branch, so behavior is
    // byte-identical to before.
    if (shouldPauseOnBudget(budget)) {
      return pauseDagOnBudget(this.deps.events, projectId, budget, plan.toEnqueue.length + plan.readyHeldBack);
    }

    for (const input of budgetMilestoneEvents(projectId, budget)) {
      const emitted = await this.deps.events.emitBudgetMilestone(input);
      if (!emitted) {
        log.debug("budget milestone already recorded this window — deduped, no re-ping", {
          projectId,
          band: input.band,
        });
      }
    }

    await this.emitHeld(projectId, plan.held);

    const enqueuedSpecIds: string[] = [];
    const enqueuedRunIds: string[] = [];

    if (plan.enqueues.length > 0) {
      const depsBySpec = new Map(snapshot.nodes.map((n) => [n.specId, n.dependsOn]));
      let inFlightBefore = plan.inFlightCount;
      for (const enqueue of plan.enqueues) {
        let enqueued: { runId: string } | undefined;
        try {
          enqueued = await this.enqueueOne(
            projectId,
            enqueue,
            config.threshold,
            inFlightBefore,
            ceiling,
            depsBySpec,
            lifecycle,
          );
        } catch (error) {
          log.error(
            "enqueue of ready spec threw — skipping it this tick so the other ready specs are not starved; the next walk re-attempts it",
            { specId: enqueue.specId, projectId },
            error,
          );
          continue;
        }
        if (enqueued === undefined) {
          // The spec was NOT enqueued this tick because a CONCURRENT tick already
          // claimed it (SpecNotRunnableError — the pending→active claim is the
          // idempotency boundary, so this is the expected, harmless concurrent-tick
          // race, swallowed in enqueueOne). Skip it this tick, no error.
          //
          // NOTE (§4a / jj-local): an ancestor-vs-ancestor conflict is NO LONGER detected
          // here — under the jj-local model there is no walk-time host build. The
          // dependent enqueues optimistically; the conflict surfaces during its OWN
          // bootstrap-time local assembly (fail-closed THROW), still before the writer runs.
          continue;
        }
        enqueuedSpecIds.push(enqueue.specId);
        enqueuedRunIds.push(enqueued.runId);
        inFlightBefore += 1;
      }
    }

    if (enqueuedSpecIds.length === 0) {
      // The pure planner only ever yields concurrency_saturated (slot pressure) or
      // drained here — the genuine budget pause was already handled above the plan.
      if (plan.status === "concurrency_saturated") {
        await this.deps.events.emitConcurrencySaturated({ projectId, plan });
      } else {
        await this.deps.events.emitDrained({ projectId, plan });
      }
    }

    return completedWalkResult(projectId, plan.status, enqueuedSpecIds, enqueuedRunIds);
  }

  private async enqueueOne(
    projectId: string,
    enqueue: PlannedEnqueue,
    threshold: SpeculationThreshold,
    inFlightBefore: number,
    ceiling: number,
    depsBySpec: Map<string, string[]>,
    lifecycle: DagLifecycleSnapshot,
  ): Promise<{ runId: string } | undefined> {
    if (!enqueue.speculative) {
      const enqueued = await this.enqueueOrTolerate({ projectId, specId: enqueue.specId });
      if (enqueued === undefined) return undefined;
      await this.deps.events.emitSpecEnqueued(
        standardEnqueuedEvent(
          projectId,
          enqueue.specId,
          enqueued.runId,
          depsBySpec.get(enqueue.specId) ?? [],
          inFlightBefore,
          ceiling,
        ),
      );
      return { runId: enqueued.runId };
    }

    // ANCESTOR-NOT-READY GATE: decide skip/defer/proceed against the backoff + cheap pre-check.
    const decision = decideAncestorWait(
      this.ancestorWaitBackoff,
      projectId,
      enqueue.specId,
      enqueue.unmergedAncestors,
      lifecycle,
    );
    if (decision.kind === "skip") {
      log.debug("speculative dependent inside its re-drive backoff window — skipping (spaced)", {
        projectId,
        specId: enqueue.specId,
        remainingMs: decision.remainingMs,
      });
      return undefined;
    }
    if (decision.kind === "defer") {
      log.debug("speculative dependent deferred — ancestor has not published its head yet (no runner allocated)", {
        projectId,
        specId: enqueue.specId,
        ancestorSpecId: decision.ancestorSpecId,
        holds: decision.holds,
        delayMs: decision.delayMs,
      });
      await this.deps.events.emitAncestorNotReady({
        projectId,
        specId: enqueue.specId,
        ancestorSpecId: decision.ancestorSpecId,
        ancestorPhase: decision.ancestorPhase,
      });
      return undefined;
    }

    const ancestorStack = unresolvedAncestorStack(
      await this.deps.ancestorStackResolver.resolveStack({
        projectId,
        unmergedAncestorSpecIds: enqueue.unmergedAncestors,
      }),
    );

    const enqueued = await this.enqueueOrTolerate({
      projectId,
      specId: enqueue.specId,
      ancestorStack,
    });
    if (enqueued === undefined) return undefined;
    // ARM BACKOFF + ANCESTOR KEY: a re-driven speculative spec is gated on BOTH the time window
    // AND ancestor progress — the next walk only re-proceeds when the ancestor's lifecycle changes
    // (ancestor advanced). See `ancestorWaitGate.ts` (apex v35 + v45 hot-loop fix).
    this.ancestorWaitBackoff.recordHeld(enqueue.specId, {
      ancestorStateKey: ancestorLifecycleKey(enqueue.unmergedAncestors, lifecycle.bySpecId),
      projectId,
    });
    await this.deps.events.emitSpecSpeculative(
      speculativeEnqueuedEvent(projectId, enqueue.specId, enqueued.runId, enqueue.unmergedAncestors, threshold),
    );
    return { runId: enqueued.runId };
  }

  /**
   * Enqueue a spec run, TOLERATING the two benign, EXPECTED per-spec enqueue
   * conditions. Either is a benign skip (return `undefined` — the caller emits no
   * enqueued event); the tick continues enqueuing the OTHER ready specs and never
   * aborts. EVERY OTHER error propagates unchanged — a genuine failure still surfaces
   * loudly (no silent fallback), identically whether the enqueuer ran in-process or
   * through the control plane (the client reconstructs the typed error from the 409).
   *
   *   1. SpecNotRunnableError — a concurrent walker tick already claimed this spec
   *      (its open→in_flight claim, the idempotency boundary, won). The spec is
   *      already in flight; nothing to do this tick.
   *   2. SpecDependenciesBlockedError — the spec's dependencies are not yet `merged`
   *      at enqueue time (the planner saw them merged via the lifecycle projection,
   *      but the `specs.status='merged'` write was not yet visible to the enqueue tx).
   *      The spec simply is not ready yet; a later tick enqueues it once the
   *      dependency lands as merged. Tolerating it keeps this tick from aborting and
   *      starving the OTHER ready specs.
   */
  private async enqueueOrTolerate(input: {
    projectId: string;
    specId: string;
    ancestorStack?: AncestorStack;
  }): Promise<{ runId: string } | undefined> {
    try {
      return await this.deps.enqueuer.enqueueSpecRun(input);
    } catch (error) {
      if (error instanceof SpecNotRunnableError) {
        log.debug("skipped spec: already claimed by a concurrent tick — benign", {
          specId: input.specId,
          status: error.status,
        });
        return undefined;
      }
      if (error instanceof SpecDependenciesBlockedError) {
        log.debug("skipped spec: deps not yet done — benign, a later tick enqueues it", {
          specId: input.specId,
          blockedSpecIds: error.blockedSpecIds,
        });
        return undefined;
      }
      throw error;
    }
  }

  private async emitHeld(projectId: string, held: SpecReadiness[]): Promise<void> {
    for (const h of held) {
      await this.deps.events.emitSpeculationHeld({
        projectId,
        specId: h.specId,
        unmergedAncestors: h.unmergedAncestors,
        depth: h.depth,
        depthCap: h.depthCap,
      });
    }
  }
}

export interface BuildDagWalkerDeps {
  /**
   * Plane-split (autonomy loops): the control-plane run-state writer. When present,
   * the enqueuer routes its run-CREATION through the control plane and the event
   * emitter routes its dag.* events through it — instead of the de-privileged
   * direct-pool writes (migrations 0031/0035). Absent ⇒ the direct-pool writes,
   * byte-identical to today.
   */
  runStateWriter?: RunStateWriter;
  /** in-9/in-10 capability_prepare driver, wired by the subscriber; forwarded to the walker. */
  integrationPhase?: IntegrationPhase;
}

/**
 * Build the production DagWalker from a runtime pool — the single construction site
 * the worker boot + subscriber use. Wires the pg read model + lifecycle projection, the
 * createQueuedRunFromSpec enqueuer, the org-scoped ancestor-stack resolver, the pg event
 * emitter, and the per-project speculation-config + concurrency-ceiling resolvers (the
 * ceiling is the project's persisted `allocator.concurrency` over its org's over the
 * schema default — `buildConcurrencyResolver`). When a `runStateWriter` is
 * supplied (plane-split remote-writes), the enqueuer + event emitter route their tenant
 * writes through the control plane instead.
 */
export function buildDagWalker(pool: pg.Pool, deps: BuildDagWalkerDeps): DagWalker {
  // Hoisted so the speculation-config resolver shares the SAME emitter — a corrupt
  // config there surfaces a `dag.config.corrupt` event through the one event seam.
  const events = new PgDagEventEmitter(pool, deps.runStateWriter);
  return new EventEmittingDagWalker({
    readModel: new PgDagReadModel(pool),
    lifecycleReadModel: new PgDagLifecycleReadModel(pool),
    enqueuer: new SpecRunDagEnqueuer(pool, deps.runStateWriter),
    events,
    ancestorStackResolver: new PgDagAncestorStackResolver(pool),
    speculationConfig: buildSpeculationConfigResolver(pool, events),
    // The GOVERNED ceiling, resolved from the walked project's persisted
    // `allocator.concurrency` over its org's over the schema default.
    concurrency: buildConcurrencyResolver(pool),
    budgetGate: new PgBudgetGate(pool),
    // in-9/in-10: the capability_prepare integration phase (constructed by the
    // subscriber so this module never imports the concrete integrations driver).
    ...(deps.integrationPhase !== undefined && { integrationPhase: deps.integrationPhase }),
  });
}

/** Discover every project id that has a DAG to walk (system-scoped, cross-org). */
export async function listWalkableProjectIds(pool: pg.Pool): Promise<string[]> {
  const system = getSystemPool() ?? pool;
  return runWithSystemScope(system, async (client) => {
    const result = await client.query<{ project_id: string }>(
      "SELECT DISTINCT project_id FROM specs WHERE project_id IS NOT NULL ORDER BY project_id",
    );
    return result.rows.map((row) => row.project_id);
  });
}

// Re-exported so existing import sites (and the conformance/tests) keep pulling the pg seam
// wirings + classifier + the (line-cap-split) per-project config resolvers from `walker.ts`.
export { classifySpecStatus, PgDagReadModel, SpecRunDagEnqueuer, PgDagEventEmitter } from "./walkerPg.js";
export { buildConcurrencyResolver, buildSpeculationConfigResolver } from "./walkerConfigResolvers.js";
export type { DagEventEmitter };
