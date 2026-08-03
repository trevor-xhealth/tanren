// per-call stage functions for the planner-feedback loop. Each
// stage owns a single planner / writer / checker / auditor invocation
// (event append, cost record, task-row update). The orchestrator in
// subtaskLoop.ts sequences these stages; this file holds the inner detail
// so each module stays under the 500-line architecture cap.
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { CheckAnswer, PlanAnswer, PlanSubtask } from "../answerers/schemas/index.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { SpecMode } from "../state/spec.js";
import { emitStageTiming } from "../observability/index.js";
import { createLogger } from "../observability/logger.js";
import {
  checkerPostureFor,
  classifyEntityRisk,
  isUnexpectedRiskFailure,
  type EntityChangeMap,
  type EntityMapProduction,
  type EntityRiskSignal,
  type UnavailableReason,
} from "../oracle/index.js";
import type { AnswererAdapter, WriterResult } from "../providers/types.js";
import {
  decideCheckerOutcome,
  invokeChecker,
  type CheckerDecision,
  type CheckerSubtaskContext,
} from "./checker/checker.js";
import { invokePlanner, type PlannerRejectionFeedback, type PlannerSpecContext } from "./planner/planner.js";
import { runAnswererStageWithRecovery } from "./loopStageRecovery.js";
import { runStageBodyWithFinalizeGuard, wrapEventAppend } from "./stageFailureKind.js";
import { recordAnswererCost, secondsSince, type SubtaskCostContext } from "./subtaskCost.js";
import { insertChildTask, markTaskDoneWithEvent } from "./subtaskTasks.js";

type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface StageAppendEvent {
  <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void>;
}

export interface PlannerStageInput {
  pool: LoopQueryClient;
  /**
   * REQUIRED (audit finding H3 sweep): the planner task's atomic FAILED
   * terminal write rides the writer seam through this writer — no fallback.
   * The finalize guard's `markTaskFailedIfRunningWithEvent` commits the row
   * UPDATE + the `task.failed` event in ONE org-scoped transaction through
   * `RunStateWriter.updateTaskWithEvent`.
   */
  writer: RunStateWriter;
  costCtx: SubtaskCostContext;
  adapter: AnswererAdapter<PlanAnswer>;
  spec: PlannerSpecContext;
  runId: string;
  workspacePath: string;
  plannerTaskId: string;
  appendEvent: StageAppendEvent;
  attempt: number;
  rejectionHistory: ReadonlyArray<PlannerRejectionFeedback>;
  buildUsage?: (input: { plannerTaskId: string; attempt: number }) => Record<string, unknown>;
}

export async function runPlannerStage(args: PlannerStageInput): Promise<PlanAnswer> {
  // WIDER FINALIZE GUARD (task #35): wrap the WHOLE post-row body — invokePlanner +
  // the `planner.subtasks.emitted` event + recordAnswererCost — so a throw ANYWHERE
  // (including the cost recorder firing mid-stage) closes the row loud + emits
  // exactly one `task.failed`. The planner row's TERMINAL close happens externally
  // in `subtaskLoop.ts` (the orchestration owns the planner's done/failed state);
  // `markTaskFailedIfRunning` in the guard is the idempotency primitive — a row a
  // clean branch already moved to `done` is left alone, the loud signal is the
  // `task.failed` event on the timeline.
  //
  // task #21: thread `writer` through so the guard's row UPDATE + `task.failed`
  // event ride ONE org-scoped transaction (`markTaskFailedIfRunningWithEvent` via
  // `RunStateWriter.updateTaskWithEvent`) — atomicity parity with the writer /
  // checker / auditor stages. Absent (unit paths) ⇒ the no-writer split fallback.
  return await runStageBodyWithFinalizeGuard({
    writer: args.writer,
    taskId: args.plannerTaskId,
    taskKind: "plan",
    eventLineage: {
      runId: args.runId,
      specId: args.costCtx.specId,
      projectId: args.costCtx.projectId,
      orgId: args.costCtx.orgId,
    },
    body: () => runPlannerStageBody(args),
  });
}

async function runPlannerStageBody(args: PlannerStageInput): Promise<PlanAnswer> {
  const startedAt = Date.now();
  // STAGE-LOCAL stall recovery (apex v70 fix): a transient plan-Answerer stall re-drives
  // THIS call in place — sibling progress from the enclosing subtask loop (writer diff,
  // checker/auditor verdicts, designOracle) is PRESERVED. A genuinely-wedged planner (a
  // stall on EVERY re-drive) escalates loudly via `StageStallEscalationError` — never a
  // count. Every other loop stage (checker, auditor, designOracle, triage, convergence,
  // demoRun) already runs through the same wrapper; the plan stage was the only gap.
  // The stage signature `"plan"` matches the `taskKind` convention.
  const result = await runAnswererStageWithRecovery("plan", () =>
    invokePlanner(args.adapter, {
      spec: args.spec,
      workspace: args.workspacePath,
      rejectionHistory: args.rejectionHistory,
    }),
  );
  const runtimeSeconds = secondsSince(startedAt);
  // stage-transition latency as a structured timing log (no schema).
  emitStageTiming("plan", Date.now() - startedAt, { runId: args.runId, attempt: args.attempt });
  // PRE-TERMINAL event append wrapped so a transport throw lands as
  // `event_append_failed` rather than the fail-closed `crashed` default.
  await wrapEventAppend(() =>
    args.appendEvent(
      "planner.subtasks.emitted",
      {
        runId: args.runId,
        taskId: args.plannerTaskId,
        subtasks: result.plan.subtasks.map((subtask) => ({
          index: subtask.index,
          title: subtask.title,
          intent: subtask.intent,
          estimatedTokens: subtask.estimatedTokens,
          behaviorIds: [...subtask.behaviorIds],
        })),
        rationale: result.plan.rationale,
      },
      args.plannerTaskId,
    ),
  );
  await recordAnswererCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    role: "planner",
    taskId: args.plannerTaskId,
    // The REAL model id the adapter sends, not a role pseudo-id — role travels on
    // `role` above (→ cost_source_raw.role) so notional pricing can key on a real id.
    model: args.adapter.model ?? "",
    runtimeSeconds,
    rawUsage: args.buildUsage?.({ plannerTaskId: args.plannerTaskId, attempt: args.attempt }) ?? {
      role: "planner",
      attempt: args.attempt,
    },
  });
  return result.plan;
}

// The WRITER stage lives in `writerStage.ts` (split out to keep both modules under the
// 500-line architecture cap); re-exported here so the subtask loop's single import site is
// unchanged. It owns the writer task INSERT, the exitReason-branched FAILED/PASSED routing,
// and the apex v51 per-stage `task.failed` emit-on-throw for the setup-path throw surface.
export { runWriterStage, type WriterStageInput, type WriterStageOutcome } from "./writerStage.js";

export interface CheckerStageInput {
  pool: LoopQueryClient;
  /**
   * REQUIRED (audit finding H3 sweep): the checker's terminal row + event pair
   * rides the atomic seam through this writer — no fallback.
   */
  writer: RunStateWriter;
  costCtx: SubtaskCostContext;
  adapter: AnswererAdapter<CheckAnswer>;
  runId: string;
  workspacePath: string;
  writeTaskId: string;
  checkerTaskId: string;
  subtask: PlanSubtask;
  writerResult: WriterResult;
  // The run base the writer's change is diffed against. The checker inspects the
  // change itself in its read-only workspace rather than receiving an injected
  // diff (which can balloon past the model's input limit). Omitted by unit
  // callers that drive the stage without a base sha.
  baseSha?: string;
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  // Task #86: the spec's writer-prompt MODE (`specialize_seed` for greenfield's
  // foundation specs; `from_scratch` otherwise). Threaded so the checker prompt's
  // seeded-mode tail block is emitted when the writer is specializing a pre-existing,
  // proven-green composed seed — pre-existing seed surfaces are then NOT cited as
  // completeness findings (only gaps in the product-specific surfaces this spec
  // delivered). Absent ⇒ no block (byte-identical to the legacy checker prompt).
  specMode?: SpecMode;
  appendEvent: StageAppendEvent;
  buildUsage?: (input: {
    checkerTaskId: string;
    subtaskIndex: number;
    verdict: CheckAnswer;
  }) => Record<string, unknown>;
  // §3.1 entity-risk oracle (engine/oracle): the HOST-SIDE PRODUCER of the neutral
  // entity-change map. In PRODUCTION the loop wires `entityRiskProducer` — a
  // closure that shells `sem diff --from <baselineSha> --to HEAD --format json`
  // READ-ONLY on the run's runner (over the existing command substrate) and
  // normalizes it into the neutral `EntityChangeMap`. The stage classifies that
  // map into a deterministic risk class and steers the checker posture BEFORE the
  // LLM judgement. This is a NATIVE Tanren signal, NOT prompt injection — the
  // agent still self-inspects the diff in its sandbox separately, and the raw sem
  // output never reaches the prompt (docs/roadmap/entity-analysis-layer.md §3.1).
  //
  // GRACEFUL FALLBACK: when no producer is wired (unit callers), or the producer
  // returns an unavailability, the classifier returns the `unknown` class and the
  // checker proceeds on the raw diff exactly as today. The producer distinguishes
  // a LEGITIMATE absence (`no-producer` / `producer-unsupported`, quiet) from an
  // UNEXPECTED failure (`producer-errored`, logged loudly) per no-silent-fallback.
  entityRiskProducer?: (baselineSha: string) => Promise<EntityMapProduction>;
  // Direct-injection seam for unit paths that pin the classifier without a
  // producer closure. Mutually exclusive with `entityRiskProducer` in practice;
  // when the producer is wired, its result takes precedence over these.
  entityChangeMap?: EntityChangeMap;
  entityMapUnavailable?: UnavailableReason;
}

const checkerOracleLogger = createLogger("checker-entity-risk");

// Derive the deterministic entity-risk signal for a checker stage. Resolves the
// neutral entity-change map FROM THE HOST-SIDE PRODUCER (the production path: `sem`
// run read-only on the runner) and classifies it via the pure classifier; the
// production default (no producer / an unavailability) is the graceful `unknown`
// signal. The producer NEVER throws (every failure maps to an `UnavailableReason`),
// but we still guard it: an unforeseen throw degrades to `producer-errored`
// (UNEXPECTED, loud) rather than failing the checker. The wiring layer emits the
// signal as an observable event AND logs the unexpected `producer-errored` case
// loudly (the legitimate absent paths stay quiet).
async function deriveCheckerRiskSignal(args: CheckerStageInput, baselineSha: string): Promise<EntityRiskSignal> {
  // Production: shell `sem` on the runner via the wired producer. Its result
  // (a map or an unavailability reason) takes precedence over any direct injection.
  if (args.entityRiskProducer !== undefined) {
    let production: EntityMapProduction;
    try {
      production = await args.entityRiskProducer(baselineSha);
    } catch {
      // The producer is contracted never to throw; a throw here is itself the
      // unexpected case — degrade loudly, never let it fail the checker stage.
      return classifyEntityRisk(undefined, "producer-errored");
    }
    return "map" in production
      ? classifyEntityRisk(production.map)
      : classifyEntityRisk(undefined, production.unavailable);
  }
  // Unit/direct-injection path: classify the supplied map / unavailability.
  return classifyEntityRisk(args.entityChangeMap, args.entityMapUnavailable);
}

// The base sha the checker tells the Answerer to diff against. The production
// loop threads the run base (`baseSha`); when it is absent (unit callers that
// drive the stage without a base) we fall back to the parent of the writer's
// first commit, or `HEAD` when the writer produced no commits — so the prompt
// always carries a usable git ref.
function checkerBaselineSha(args: CheckerStageInput): string {
  if (args.baseSha !== undefined) {
    return args.baseSha;
  }
  const firstCommit = args.writerResult.commits[0];
  return firstCommit === undefined ? "HEAD" : `${firstCommit.sha}~1`;
}

export async function runCheckerStage(args: CheckerStageInput): Promise<CheckerDecision> {
  await insertChildTask(
    args.pool,
    {
      taskId: args.checkerTaskId,
      runId: args.runId,
      kind: "check",
      title: `check subtask ${args.subtask.index}`,
      parentTaskId: args.writeTaskId,
      agentKind: "answerer",
      cli: args.adapter.cli,
      model: null,
    },
    args.writer,
  );
  await args.appendEvent("task.started", { taskKind: "check" }, args.checkerTaskId);
  await args.appendEvent("checker.started", { taskKind: "check" }, args.checkerTaskId);

  // WIDER FINALIZE GUARD (task #35): wrap the WHOLE post-row body — entity-risk
  // derivation + invokeChecker (via recovery) + the `checker.verdict` event + cost
  // + the reject/pass terminal branch — so a throw ANYWHERE closes the row loud +
  // emits exactly one `task.failed`. Supersedes the prior inner
  // `runStageWithEmitOnThrow` (which only covered the answerer call).
  return await runStageBodyWithFinalizeGuard({
    writer: args.writer,
    taskId: args.checkerTaskId,
    taskKind: "check",
    eventLineage: {
      runId: args.runId,
      specId: args.costCtx.specId,
      projectId: args.costCtx.projectId,
      orgId: args.costCtx.orgId,
    },
    body: () => runCheckerStageBody(args),
  });
}

async function runCheckerStageBody(args: CheckerStageInput): Promise<CheckerDecision> {
  // §3.1: derive the deterministic entity-risk signal BEFORE the LLM judgement,
  // emit it as the observable pre-LLM classification, and use it to steer the
  // checker posture. The signal is produced HOST-SIDE (the wired producer shells
  // `sem` read-only on the runner over the same `baselineSha` the checker tells the
  // agent to diff against) and classified natively. The `unknown` class (no
  // producer / sem absent / can't-parse) is the graceful fallback: no posture
  // steer, and the prompt is byte-identical to the no-oracle path. An UNEXPECTED
  // producer failure is logged loudly (no-silent-fallback).
  const baselineSha = checkerBaselineSha(args);
  const riskSignal = await deriveCheckerRiskSignal(args, baselineSha);
  const riskPosture = checkerPostureFor(riskSignal);
  if (isUnexpectedRiskFailure(riskSignal.provenance)) {
    checkerOracleLogger.warn(
      "entity-risk producer errored; checker proceeding on raw diff (risk unclassified)",
      { runId: args.runId, taskId: args.checkerTaskId },
      { subtaskIndex: args.subtask.index, provenance: riskSignal.provenance, rationale: riskSignal.rationale },
    );
  }
  await wrapEventAppend(() =>
    args.appendEvent(
      "checker.entity_risk",
      {
        runId: args.runId,
        taskId: args.checkerTaskId,
        subtaskIndex: args.subtask.index,
        riskClass: riskSignal.riskClass,
        provenance: riskSignal.provenance,
        unexpectedFailure: isUnexpectedRiskFailure(riskSignal.provenance),
        scrutiny: riskPosture.scrutiny,
        rationale: riskSignal.rationale,
        counts: riskSignal.counts,
      },
      args.checkerTaskId,
    ),
  );

  const checkerContext: CheckerSubtaskContext = {
    specTitle: args.specTitle,
    specDescription: args.specDescription,
    acceptanceCriteria: args.acceptanceCriteria,
    subtask: args.subtask,
    baselineSha,
    // §3.1: steer ONLY when the signal is a real class; `unknown` adds no steer.
    riskSignal: riskSignal.riskClass === "unknown" ? undefined : riskSignal,
    // Task #86: thread the spec mode so the checker prompt's seeded-mode tail block
    // is emitted when the spec runs in `specialize_seed` mode.
    ...(args.specMode !== undefined && { specMode: args.specMode }),
  };
  const startedAt = Date.now();
  // STAGE-LOCAL stall recovery: a transient checker stall re-drives THIS call in place; a
  // wedged checker escalates loudly.
  const result = await runAnswererStageWithRecovery("checker", () =>
    invokeChecker(args.adapter, { context: checkerContext, workspace: args.workspacePath }),
  );
  const runtimeSeconds = secondsSince(startedAt);
  emitStageTiming("check", Date.now() - startedAt, {
    runId: args.runId,
    subtaskIndex: args.subtask.index,
  });
  // EMPTY-INCREMENTAL-DIFF (v35): the entity-risk oracle is the deterministic host-side
  // witness of whether `baselineSha → HEAD` actually changed anything. A `classified`
  // signal (the producer ran) with ZERO changed entities means the incremental diff is
  // empty — the re-driven-complete-spec / scaffold-is-the-seed case. We DON'T trust a
  // bare `unknown` (no producer / can't-parse) as "empty": that would let an unwired
  // oracle silently relabel any diff as empty. Only a real `classified` empty diff
  // counts. This flag NEVER forces a reject or fabricates an accept — it only stops the
  // loop from re-driving the writer over a diff that cannot grow (see decideCheckerOutcome).
  const emptyIncrementalDiff = riskSignal.provenance === "classified" && riskSignal.counts.total === 0;

  // SPEC-LOOP REDESIGN: the checker is completeness-FINDINGS-only. `complete` is the
  // deterministic loop's read (no findings ⇒ task-complete for downstream needs); the
  // findings + reasoning are the narration. `decideCheckerOutcome` is the SAME read.
  const decision = decideCheckerOutcome(result.verdict, emptyIncrementalDiff);
  // PRE-TERMINAL `checker.verdict` wrapped: a throw here lands as
  // `event_append_failed` (rather than the fail-closed `crashed`).
  await wrapEventAppend(() =>
    args.appendEvent(
      "checker.verdict",
      {
        runId: args.runId,
        taskId: args.checkerTaskId,
        subtaskIndex: args.subtask.index,
        complete: decision.kind === "pass",
        passed: decision.kind === "pass",
        reasoning: result.verdict.reasoning,
        behaviorIdsFailed: decision.kind === "reject" ? [...decision.behaviorIdsFailed] : [],
        findings: result.verdict.findings.map((f) => ({
          id: f.id,
          title: f.title,
          body: f.body,
          behaviorId: f.behaviorId ?? null,
        })),
        emptyIncrementalDiff,
      },
      args.checkerTaskId,
    ),
  );
  await recordAnswererCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    role: "checker",
    taskId: args.checkerTaskId,
    model: args.adapter.model ?? "",
    runtimeSeconds,
    rawUsage: args.buildUsage?.({
      checkerTaskId: args.checkerTaskId,
      subtaskIndex: args.subtask.index,
      verdict: result.verdict,
    }) ?? { role: "checker", subtaskIndex: args.subtask.index },
  });
  // Lineage for the checker's atomic terminal-pair events (task #39): the
  // costCtx already carries the run lineage at this stage. v68 fix: org_id is
  // now required on the envelope so every routed terminal event carries the
  // tenant key directly (see {@link AppendEventInput.orgId}).
  const eventEnvelope = {
    runId: args.runId,
    specId: args.costCtx.specId,
    projectId: args.costCtx.projectId,
    orgId: args.costCtx.orgId,
    taskKind: "check",
  };
  if (decision.kind === "reject") {
    // PRE-TERMINAL `checker.rejected` rides FIRST (wrapped — a transport throw
    // lands as `event_append_failed` rather than the fail-closed `crashed`),
    // then the atomic terminal pair (row UPDATE + `task.completed`) — task #39
    // single-finalize invariant.
    await wrapEventAppend(() =>
      args.appendEvent(
        "checker.rejected",
        {
          runId: args.runId,
          taskId: args.checkerTaskId,
          subtaskIndex: args.subtask.index,
          reason: decision.reason,
          behaviorIdsFailed: [...decision.behaviorIdsFailed],
        },
        args.checkerTaskId,
      ),
    );
    await markTaskDoneWithEvent({
      writer: args.writer,
      taskId: args.checkerTaskId,
      envelope: eventEnvelope,
      outcome: "rejected_by_checker",
    });
    return decision;
  }
  await markTaskDoneWithEvent({
    writer: args.writer,
    taskId: args.checkerTaskId,
    envelope: eventEnvelope,
    outcome: "passed",
  });
  return decision;
}

// The AUDITOR stage lives in `auditorStage.ts` (split out to keep both modules under
// the 500-line cap); re-exported here so the subtask loop's single import site is
// unchanged. It owns the recoverable auditor-schema-miss loop-back.
export { runAuditorStage, type AuditorStageInput } from "./auditorStage.js";
