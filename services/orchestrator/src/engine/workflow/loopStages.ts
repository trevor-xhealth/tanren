// The SPEC-LOOP REDESIGN stages (docs/roadmap/spec-loop-redesign.md): DEMO-RUN,
// TRIAGE, and CONVERGENCE. Each owns a single answerer invocation (task row, event
// append, cost record) + maps the answer onto the deterministic loop decision. Split
// out of subtaskLoop.ts so every module stays under the 500-line cap. All three
// answerers are READ-ONLY + strict-JSON-schema (malformed ⇒ AnswererSchemaValidationError).
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import {
  answererOutputSchemaFor,
  ConvergenceAnswer,
  DemoRunAnswer,
  type DesignOracleAnswer,
  normalizeFinding,
  TriageAnswer,
} from "../answerers/schemas/index.js";
import type { Finding, FindingSeverity } from "../contracts/findings.js";
import type { ActorRef } from "../state/actor.js";
import type { SpecMode } from "../state/spec.js";
import { runDesignOracleLoopStage } from "./designOracleLoopStage.js";
import type { AuditPostureConfig } from "../config/shared.js";
import { emitStageTiming } from "../observability/index.js";
import type { AnswererAdapter } from "../providers/types.js";
import {
  applyConvergencePolicy,
  type ConvergenceDecision,
  type ConvergenceState,
  effectiveBlockingProgress,
  routeTriageItems,
  type RoutedWorkItem,
  summarizeTriageRouting,
  totalPScore,
  type TriageRoutingResult,
  type VelocityDeferPolicy,
} from "./loopPolicy.js";
import { buildConvergencePrompt, buildDemoRunPrompt, buildTriagePrompt } from "./loopStagePrompts.js";
import { recordAnswererCost, secondsSince, type SubtaskCostContext } from "./subtaskCost.js";
import { runAnswererStageWithRecovery } from "./loopStageRecovery.js";
import { runStageBodyWithFinalizeGuard, wrapEventAppend } from "./stageFailureKind.js";
import { insertChildTask, markTaskDoneWithEvent } from "./subtaskTasks.js";
import type { StageAppendEvent } from "./subtaskStages.js";
import {
  buildTriageCompletedPayloadPieces,
  ensureFindingCoverage,
  gateTriagedSpecs,
  type TriageSpecValidator,
} from "./loopFindings.js";

export type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

interface SpecContext {
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  baselineSha: string;
}

export interface StageBase {
  pool: LoopQueryClient;
  /** Required atomic writer for stage terminal row + event pairs. */
  writer: RunStateWriter;
  costCtx: SubtaskCostContext;
  runId: string;
  /** The source IssueLoop for an issue-origin spec; only triage uses this scope. */
  issueLoopId?: string;
  workspacePath: string;
  plannerTaskId: string;
  appendEvent: StageAppendEvent;
}

/** v68 fix: atomic terminal-pair envelope lineage builder. */
function lineage(a: StageBase) {
  return { runId: a.runId, specId: a.costCtx.specId, projectId: a.costCtx.projectId, orgId: a.costCtx.orgId };
}
// ---- DEMO-RUN (optional) --------------------------------------------------

export interface DemoRunStageInput extends StageBase, SpecContext {
  adapter: AnswererAdapter<DemoRunAnswer>;
}

/**
 * Run the OPTIONAL demo-run stage: exercise the promised user-flow and emit findings
 * (explicit P0–P3) for what did not work. Returns the findings (normalized to the
 * frozen `Finding` currency) so the loop merges them with the auditor's into one
 * triage input. The caller only invokes this when the project enabled the slot.
 */
export async function runDemoRunStage(args: DemoRunStageInput): Promise<{ findings: Finding[]; demoTaskId: string }> {
  const demoTaskId = `task_${randomUUID()}`;
  await insertChildTask(
    args.pool,
    {
      taskId: demoTaskId,
      runId: args.runId,
      kind: "demo",
      title: "demo-run spec",
      parentTaskId: args.plannerTaskId,
      agentKind: "answerer",
      cli: args.adapter.cli,
      model: null,
    },
    args.writer,
  );
  await args.appendEvent("task.started", { taskKind: "demo" }, demoTaskId);
  await args.appendEvent("demoRun.started", { taskKind: "demo" }, demoTaskId);
  // WIDER FINALIZE GUARD (task #35): wrap the WHOLE post-row body so a recorder
  // / event-append throw closes the row loud + emits `task.failed`.
  return await runStageBodyWithFinalizeGuard({
    writer: args.writer,
    taskId: demoTaskId,
    taskKind: "demo",
    eventLineage: lineage(args),
    body: () => runDemoRunStageBody(args, demoTaskId),
  });
}

async function runDemoRunStageBody(
  args: DemoRunStageInput,
  demoTaskId: string,
): Promise<{ findings: Finding[]; demoTaskId: string }> {
  const outputSchema = answererOutputSchemaFor("demoRun", DemoRunAnswer);
  const prompt = buildDemoRunPrompt({
    specTitle: args.specTitle,
    specDescription: args.specDescription,
    acceptanceCriteria: args.acceptanceCriteria,
    baselineSha: args.baselineSha,
  });
  const startedAt = Date.now();
  // STAGE-LOCAL stall recovery: a transient stall re-drives THIS stage in place; a wedged stage
  // escalates loudly. A deterministic throw re-throws OUT of `runAnswererStageWithRecovery`
  // into the outer finalize guard, which emits `task.failed` + closes the row.
  const verdict = await runAnswererStageWithRecovery("demoRun", () =>
    args.adapter.runAnswerer({ prompt, workspace: args.workspacePath, outputSchema }),
  );
  const runtimeSeconds = secondsSince(startedAt);
  emitStageTiming("demo", Date.now() - startedAt, { runId: args.runId });
  const findings = verdict.findings.map((f) => normalizeFinding(f));
  await wrapEventAppend(() =>
    args.appendEvent("demoRun.verdict", { runId: args.runId, summary: verdict.summary, findings }, demoTaskId),
  );
  await recordAnswererCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    role: "demoRun",
    taskId: demoTaskId,
    // The REAL model id the adapter sends, not a role pseudo-id — role travels on
    // `role` above (→ cost_source_raw.role) so notional pricing can key on a real id.
    model: args.adapter.model ?? "",
    runtimeSeconds,
    rawUsage: { role: "demoRun" },
  });
  // ATOMIC terminal-row + terminal-event pair (task #39): row UPDATE +
  // `task.completed` in ONE org-scoped tx (autonomy-engine.md §1c).
  await loopStageTaskDone(args, demoTaskId, "demo");
  return { findings, demoTaskId };
}

// ---- POST-AUDIT FINDING STAGES (demo-run + design-oracle) -----------------
export interface PostAuditFindingStagesInput extends StageBase {
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  baselineSha: string;
  projectId: string;
  client: LoopQueryClient;
  demoRunAdapter: AnswererAdapter<DemoRunAnswer>;
  designOracleAdapter: AnswererAdapter<DesignOracleAnswer>;
  // The demo-run slot is GATED by the policy flag (optional "does it work" gate); the
  // design-oracle slot is GATED by the presence of a design actor (it runs whenever a
  // contract exists — no kill-switch). Both findings merge into the SAME triage input.
  demoRunEnabled: boolean;
  designOracleActor?: { actor: ActorContext; actorRef: ActorRef };
  // OPTIONAL spec mode (audit round-2 H1) — threaded to the designOracle so a
  // `specialize_seed` spec gets the seeded-mode tail block (mirrors PR #708's
  // checker/auditor). Demo-run is "does it work" runtime — no specMode.
  specMode?: SpecMode;
}

/**
 * Run the two OPTIONAL post-auditor finding stages — the demo-run gate (when the policy
 * enables it) and the WS-D4 design-oracle gate (when a design actor is wired) — and return
 * their merged findings (normalized to the frozen `Finding` currency) for the loop's ONE
 * triage input. A design-fidelity gap re-drives the writer exactly like the demo/auditor.
 */
export async function runPostAuditFindingStages(args: PostAuditFindingStagesInput): Promise<Finding[]> {
  const findings: Finding[] = [];
  // OPTIONAL DEMO-RUN slot (after the auditor), gating the pass when enabled.
  if (args.demoRunEnabled) {
    const demo = await runDemoRunStage({
      pool: args.pool,
      writer: args.writer,
      costCtx: args.costCtx,
      adapter: args.demoRunAdapter,
      runId: args.runId,
      workspacePath: args.workspacePath,
      plannerTaskId: args.plannerTaskId,
      specTitle: args.specTitle,
      specDescription: args.specDescription,
      acceptanceCriteria: args.acceptanceCriteria,
      baselineSha: args.baselineSha,
      appendEvent: args.appendEvent,
    });
    findings.push(...demo.findings);
  }
  // WS-D4 DESIGN-ORACLE slot (after the demo-run): verify the built output against the
  // project's HEAD `DesignContract`. Runs whenever the design actor is wired AND a
  // contract exists; self-skips cleanly (empty findings, no task/cost) with no contract.
  if (args.designOracleActor !== undefined) {
    const designOracle = await runDesignOracleLoopStage({
      pool: args.pool,
      writer: args.writer,
      costCtx: args.costCtx,
      adapter: args.designOracleAdapter,
      client: args.client,
      runId: args.runId,
      plannerTaskId: args.plannerTaskId,
      projectId: args.projectId,
      workspacePath: args.workspacePath,
      actor: args.designOracleActor.actor,
      actorRef: args.designOracleActor.actorRef,
      baselineSha: args.baselineSha,
      appendEvent: args.appendEvent,
      // Audit round-2 H1: thread specMode → seeded-mode tail block on the oracle.
      ...(args.specMode !== undefined && { specMode: args.specMode }),
    });
    findings.push(...designOracle.findings);
  }
  return findings;
}

// ---- TRIAGE ---------------------------------------------------------------
export interface TriageStageInput extends StageBase {
  adapter: AnswererAdapter<TriageAnswer>;
  specTitle: string;
  specDescription: string;
  baselineSha: string;
  // ALL findings to triage (spec-gate CI-as-P0 + auditor + demo).
  findings: ReadonlyArray<Finding>;
  posture: AuditPostureConfig;
  // WORKSTREAM 1 ↔ 2 SEAM — the spec-quality gate for `kind: spec` items. When wired,
  // every work item routed to a NEW DAG spec is validated against the spec-quality
  // contract BEFORE it leaves triage; a persistently-invalid spec raises
  // `PersistentlyInvalidSpecError` (loud needs_attention). Absent ⇒ inert.
  specValidator?: TriageSpecValidator;
}

export interface TriageStageResult {
  routing: TriageRoutingResult;
  triageTaskId: string;
}

/**
 * Run the TRIAGE stage: dedup the findings to root-cause work items, then route each
 * DETERMINISTICALLY (by severity + the agent `kind` hint + the project posture) to a
 * task-here or a new DAG spec. Returns the routing summary — `outcome: 'passed'` when
 * EVERY item became a new spec (the triage→passed arrow), `'kept'` when at least one
 * routed to a task in this spec (re-enter the writer loop after convergence).
 */
export async function runTriageStage(args: TriageStageInput): Promise<TriageStageResult> {
  const triageTaskId = `task_${randomUUID()}`;
  await insertChildTask(
    args.pool,
    {
      taskId: triageTaskId,
      ...(args.issueLoopId === undefined ? { runId: args.runId } : { issueLoopId: args.issueLoopId }),
      ...(args.issueLoopId === undefined ? {} : { orgId: args.costCtx.orgId }),
      kind: "triage",
      title: "triage findings",
      parentTaskId: args.plannerTaskId,
      agentKind: "answerer",
      cli: args.adapter.cli,
      model: null,
    },
    args.writer,
  );
  await args.appendEvent("task.started", { taskKind: "triage" }, triageTaskId);
  await args.appendEvent("triage.started", { taskKind: "triage" }, triageTaskId);
  // WIDER FINALIZE GUARD (task #35): same shape as demoRun. `gateTriagedSpecs` now
  // DEGRADES gracefully — a triage-proposed spec's `PersistentlyInvalidSpecError` is
  // caught per-spec + dropped/parked, so the run is NOT sunk by a bad proposal. The
  // guard still fail-closes on any OTHER stage throw (per `stageFailureKind.ts`).
  return await runStageBodyWithFinalizeGuard({
    writer: args.writer,
    taskId: triageTaskId,
    taskKind: "triage",
    eventLineage: lineage(args),
    body: () => runTriageStageBody(args, triageTaskId),
  });
}

async function runTriageStageBody(args: TriageStageInput, triageTaskId: string): Promise<TriageStageResult> {
  const outputSchema = answererOutputSchemaFor("triage", TriageAnswer);
  const prompt = buildTriagePrompt({
    specTitle: args.specTitle,
    specDescription: args.specDescription,
    findings: args.findings,
    baselineSha: args.baselineSha,
  });
  const startedAt = Date.now();
  // STAGE-LOCAL stall recovery (see runDemoRunStage).
  const answer = await runAnswererStageWithRecovery("triage", () =>
    args.adapter.runAnswerer({ prompt, workspace: args.workspacePath, outputSchema }),
  );
  const runtimeSeconds = secondsSince(startedAt);
  emitStageTiming("audit", Date.now() - startedAt, { runId: args.runId });
  // apex v79/v80 loop closure — FAIL-CLOSED on empty triage on non-empty findings
  // (`summarizeTriageRouting` would falsely return "passed"). See `ensureFindingCoverage`.
  const effectiveWorkItems = ensureFindingCoverage(answer.workItems, args.findings, triageTaskId);
  const routed: RoutedWorkItem[] = routeTriageItems(effectiveWorkItems, args.posture);
  const routing = summarizeTriageRouting(routed);
  // WORKSTREAM 1 ↔ 2 SEAM — gate every NEW-spec routed item against the spec-quality
  // contract before it materializes. Under autonomy a triage-PROPOSED spec is an
  // INDEPENDENT audit-derived DAG node (not the BUILD spec's critical path), so a
  // persistently-invalid proposal is DROPPED + PARKED (mirroring `autoRouteOrDeadLetter`)
  // rather than re-thrown to sink the run. `gateTriagedSpecs` returns the SURVIVORS
  // (gate-passing); only those leave this stage. Inert when no validator is wired.
  const gated = await gateTriagedSpecs(routing.newSpecs, args.specValidator);
  const survivingRouting: TriageRoutingResult = { ...routing, newSpecs: [...gated.survivors] };
  const completedPieces = buildTriageCompletedPayloadPieces(routed, gated);
  await wrapEventAppend(() =>
    args.appendEvent(
      "triage.completed",
      { runId: args.runId, taskId: triageTaskId, outcome: survivingRouting.outcome, ...completedPieces },
      triageTaskId,
    ),
  );
  await recordAnswererCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    role: "triage",
    taskId: triageTaskId,
    model: args.adapter.model ?? "",
    runtimeSeconds,
    rawUsage: { role: "triage" },
    ...(args.issueLoopId === undefined ? {} : { issueLoopId: args.issueLoopId }),
  });
  // ATOMIC terminal-row + terminal-event pair (task #39).
  await loopStageTaskDone(args, triageTaskId, "triage");
  return { routing: survivingRouting, triageTaskId };
}

// ---- CONVERGENCE ----------------------------------------------------------

export interface ConvergenceStageInput extends StageBase {
  adapter: AnswererAdapter<ConvergenceAnswer>;
  specTitle: string;
  baselineSha: string;
  loopIndex: number;
  currentFindings: ReadonlyArray<Finding>;
  priorFindings: ReadonlyArray<Finding>;
  state: ConvergenceState;
  // The configurable velocity-defer strategy + the worst severity among the
  // findings KEPT in-spec this loopback (undefined ⇒ no kept findings). Together
  // they gate whether a `velocity_defer` assessment is honored (→ `pass`).
  velocityPolicy: VelocityDeferPolicy;
  worstLeftoverSeverity?: FindingSeverity;
}

export interface ConvergenceStageResult {
  decision: ConvergenceDecision;
  state: ConvergenceState;
  reasoning: string;
  // The SPECIFIC human-actionable escalation reason when the agent's intelligent verdict
  // halted the loop (`decision === "halt"`); empty otherwise. Carried to the
  // `convergence.stalled` event + the `needs_attention` diagnosis (never a bare "stuck").
  escalationReason: string;
  convergenceTaskId: string;
}

/**
 * Run the CONVERGENCE stage on the loopback when work is kept in-spec. The answerer
 * reads progress/stall/velocity from the finding-delta + diff; the deterministic
 * policy (`applyConvergencePolicy`) turns that into the loop decision + the next
 * consecutive-stall state (the SOLE loop bound — NOT a retry counter). `halt` ⇒ the
 * caller finalizes the run `convergence_stalled`.
 */
export async function runConvergenceStage(args: ConvergenceStageInput): Promise<ConvergenceStageResult> {
  const convergenceTaskId = `task_${randomUUID()}`;
  await insertChildTask(
    args.pool,
    {
      taskId: convergenceTaskId,
      runId: args.runId,
      kind: "convergence",
      title: "convergence check",
      parentTaskId: args.plannerTaskId,
      agentKind: "answerer",
      cli: args.adapter.cli,
      model: null,
    },
    args.writer,
  );
  await args.appendEvent("task.started", { taskKind: "convergence" }, convergenceTaskId);
  await args.appendEvent("convergence.started", { taskKind: "convergence" }, convergenceTaskId);
  // WIDER FINALIZE GUARD (task #35): same shape as demoRun.
  return await runStageBodyWithFinalizeGuard({
    writer: args.writer,
    taskId: convergenceTaskId,
    taskKind: "convergence",
    eventLineage: lineage(args),
    body: () => runConvergenceStageBody(args, convergenceTaskId),
  });
}

async function runConvergenceStageBody(
  args: ConvergenceStageInput,
  convergenceTaskId: string,
): Promise<ConvergenceStageResult> {
  const outputSchema = answererOutputSchemaFor("convergence", ConvergenceAnswer);
  const prompt = buildConvergencePrompt({
    specTitle: args.specTitle,
    currentFindings: args.currentFindings,
    priorFindings: args.priorFindings,
    baselineSha: args.baselineSha,
    loopIndex: args.loopIndex,
    // The earlier-loop blocking root-cause ids, so the answerer can recognize a RETURN to a
    // prior unresolved blocker (the v40 oscillation) — the qualitative half of the backstop.
    priorBlockingRootCauseIds: args.state.blockingHistory.map((a) => a.failureSignature),
  });
  const startedAt = Date.now();
  // STAGE-LOCAL stall recovery (see runDemoRunStage): the cross-loop `consecutiveStalls` state
  // (the spec-level convergence-stall semantics) is UNTOUCHED; only the per-CALL transient
  // stall recovers here.
  const answer = await runAnswererStageWithRecovery("convergence", () =>
    args.adapter.runAnswerer({ prompt, workspace: args.workspacePath, outputSchema }),
  );
  const runtimeSeconds = secondsSince(startedAt);
  emitStageTiming("audit", Date.now() - startedAt, { runId: args.runId });
  const loopPScore = totalPScore(args.currentFindings);
  const { state, decision } = applyConvergencePolicy({
    assessment: answer.assessment,
    blockingProgress: answer.blockingRootCauseProgress,
    escalation: answer.escalation,
    state: args.state,
    velocityPolicy: args.velocityPolicy,
    loopBlocking: { id: answer.blockingRootCauseId, pScore: loopPScore },
    ...(args.worstLeftoverSeverity !== undefined && { worstLeftoverSeverity: args.worstLeftoverSeverity }),
  });
  // The blocking progress the policy ACTED on — the answerer's report, OVERRIDDEN to a stall
  // (`regressed`) when the deterministic oscillation backstop fired (a return to a prior
  // unresolved blocker). Surfaced on the event so the timeline shows the structural override.
  const effectiveProgress = effectiveBlockingProgress(answer.blockingRootCauseProgress, state.blockingHistory);
  await wrapEventAppend(() =>
    args.appendEvent(
      "convergence.assessed",
      {
        runId: args.runId,
        taskId: convergenceTaskId,
        assessment: answer.assessment,
        // The v24 cause-not-symptom signal: progress on the BLOCKING root cause + its
        // stable identity, so the timeline shows WHY a loop stalled (the blocker recurred
        // unchanged) even when peripheral findings moved. The EFFECTIVE progress reflects the
        // v40 oscillation backstop — a proven structural A→B→A→B cycle is surfaced as `regressed` even
        // when the answerer narrated `retired`, so the timeline shows the deterministic override.
        blockingRootCauseProgress: effectiveProgress,
        blockingRootCauseId: answer.blockingRootCauseId,
        // The intelligent escalation verdict — the "would a human add value beyond keep going?"
        // gate that decides a halt (replacing the old consecutive-stall count).
        escalation: answer.escalation,
        decision,
        consecutiveStalls: state.consecutiveStalls,
        reasoning: answer.reasoning,
      },
      convergenceTaskId,
    ),
  );
  await recordAnswererCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    role: "convergence",
    taskId: convergenceTaskId,
    model: args.adapter.model ?? "",
    runtimeSeconds,
    rawUsage: { role: "convergence" },
  });
  // ATOMIC terminal-row + terminal-event pair (task #39).
  await loopStageTaskDone(args, convergenceTaskId, "convergence");
  // The escalation reason is meaningful only on a halt (the agent's escalate verdict).
  const escalationReason = decision === "halt" ? answer.escalationReason : "";
  return { decision, state, reasoning: answer.reasoning, escalationReason, convergenceTaskId };
}

/**
 * Shared loopStages terminal-pair invoker (task #39): the row UPDATE +
 * `task.completed` event in ONE org-scoped tx. The no-writer test fallback
 * routes the terminal event back through the stage's `appendEvent` recorder so
 * the existing recorder-based test invariants keep observing the terminal event.
 */
async function loopStageTaskDone(
  args: StageBase,
  taskId: string,
  taskKind: "demo" | "triage" | "convergence",
): Promise<void> {
  await markTaskDoneWithEvent({
    writer: args.writer,
    taskId,
    envelope: { ...lineage(args), taskKind },
    outcome: "passed",
  });
}
