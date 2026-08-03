// The AUDITOR stage of the spec-implementation loop, split out of `subtaskStages.ts`
// to keep both modules under the 500-line architecture cap. Owns the single auditor
// invocation (task row, event append, cost record) AND the RECOVERABLE handling of an
// auditor schema-parse miss.
//
// SPEC-LOOP REDESIGN (docs/roadmap/spec-loop-redesign.md): the auditor is
// FINDINGS-ONLY and renders NO verdict. `runAuditorStage` returns the emitted findings
// (the frozen `Finding` currency); the loop COLLECTS them with the spec-gate CI-as-P0
// + demo findings and routes the union through TRIAGE + CONVERGENCE. There is NO
// auditor-level pass/loop/halt decision. A schema-parse miss surfaces as a synthetic
// P0 finding (fail-closed) so the loop never silently treats an un-audited run as
// clean, while the land gate's fail-closed synthetic-P0 still blocks any merge without
// a real `auditor.verdict`.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { AuditAnswer, PlanAnswer } from "../answerers/schemas/index.js";
import type { Finding } from "../contracts/findings.js";
import { emitStageTiming } from "../observability/index.js";
import type { AnswererAdapter } from "../providers/types.js";
import type { SpecMode } from "../state/spec.js";
import { AnswererSchemaValidationError } from "../providers/codex.js";
import { auditorFindings, invokeAuditor, type AuditorSpecContext } from "./auditor/auditor.js";
import { runAnswererStageWithRecovery } from "./loopStageRecovery.js";
import {
  classifyStageFailureKind,
  runStageBodyWithFinalizeGuard,
  stageFailureMessage,
  wrapEventAppend,
} from "./stageFailureKind.js";
import { recordAnswererCost, secondsSince, type SubtaskCostContext } from "./subtaskCost.js";
import { insertChildTask, markTaskDoneWithEvent, markTaskFailedWithEvent } from "./subtaskTasks.js";
import type { StageAppendEvent } from "./subtaskStages.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("auditor");

type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface AuditorStageInput {
  pool: LoopQueryClient;
  /**
   * REQUIRED (audit finding H3 sweep): the auditor's terminal row + event pair
   * rides the atomic seam through this writer — no fallback. Production wires
   * the always-returning `runStateWriterFromEnv`; tests wire the
   * `InMemoryRunStateWriter` fixture.
   */
  writer: RunStateWriter;
  costCtx: SubtaskCostContext;
  adapter: AnswererAdapter<AuditAnswer>;
  runId: string;
  workspacePath: string;
  plannerTaskId: string;
  plan: PlanAnswer;
  // The run base the combined writer change is diffed against. The auditor
  // inspects the change itself in its read-only workspace rather than receiving
  // an injected combined diff. Omitted by unit callers without a base sha.
  baseSha?: string;
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  // Task #86: the spec's writer-prompt MODE (`specialize_seed` for greenfield's
  // foundation specs; `from_scratch` otherwise). Threaded so the auditor prompt's
  // seeded-mode tail block is emitted when the writer is specializing a pre-existing,
  // proven-green composed seed — pre-existing seed surfaces are then NOT cited as
  // quality findings. Absent ⇒ no block (byte-identical to the legacy auditor prompt).
  specMode?: SpecMode;
  appendEvent: StageAppendEvent;
  buildUsage?: (input: { auditorTaskId: string; verdict: AuditAnswer }) => Record<string, unknown>;
}

export interface AuditorStageResult {
  // The auditor's emitted findings (the frozen `Finding` currency). On a schema-parse
  // miss this is a single synthetic P0 (fail-closed) so the loop never reads an
  // un-audited run as clean.
  findings: Finding[];
  auditorTaskId: string;
}

export async function runAuditorStage(args: AuditorStageInput): Promise<AuditorStageResult> {
  const auditorTaskId = `task_${randomUUID()}`;
  await insertChildTask(
    args.pool,
    {
      taskId: auditorTaskId,
      runId: args.runId,
      kind: "audit",
      title: "audit plan",
      parentTaskId: args.plannerTaskId,
      agentKind: "answerer",
      cli: args.adapter.cli,
      model: null,
    },
    args.writer,
  );
  await args.appendEvent("task.started", { taskKind: "audit" }, auditorTaskId);
  await args.appendEvent("auditor.started", { taskKind: "audit" }, auditorTaskId);
  const auditorContext: AuditorSpecContext = {
    specTitle: args.specTitle,
    specDescription: args.specDescription,
    acceptanceCriteria: args.acceptanceCriteria,
    subtasks: args.plan.subtasks,
    baselineSha: args.baseSha ?? "HEAD",
    // Task #86: thread the spec mode so the auditor prompt's seeded-mode tail block
    // is emitted when the spec runs in `specialize_seed` mode.
    ...(args.specMode !== undefined && { specMode: args.specMode }),
  };
  // SCHEMA-MISS PATH (KEPT OUTSIDE THE GUARD): a parse miss is an IN-STAGE RECOVERY,
  // not a failure — it becomes the synthetic P0 (fail-closed) so the loop's triage
  // routes a fix-in-spec task instead of dead-ending. The guard's `task.failed` emit
  // would conflict with the schema-miss path's own `task.failed` emit, so the
  // schema-miss try/catch lives at this outer layer and returns early.
  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof invokeAuditor>>;
  try {
    // STAGE-LOCAL stall recovery: a TRANSIENT stall re-drives the auditor IN PLACE
    // (sibling progress preserved); a wedged auditor escalates loudly.
    result = await runAnswererStageWithRecovery("auditor", () =>
      invokeAuditor(args.adapter, { context: auditorContext, workspace: args.workspacePath }),
    );
  } catch (error) {
    if (error instanceof AnswererSchemaValidationError) {
      return await failClosedForSchemaMiss(args, auditorTaskId, error);
    }
    // NON-schema throw from the answerer: route through the wider finalize guard
    // semantics by re-throwing into a guard wrapper. We emit the failure here
    // directly (mirroring runStageBodyWithFinalizeGuard) since the schema-miss
    // try/catch already owns this layer's catch — keep the audit-trail integrity.
    return await emitAuditorAnswererThrow(args, auditorTaskId, error);
  }
  // WIDER FINALIZE GUARD (task #35): wrap the cost-record + verdict-event + terminal
  // row + terminal-event block so a recorder / event-append throw closes the row
  // loud + emits `task.failed` (rather than stranding the row in `running`).
  return await runStageBodyWithFinalizeGuard({
    writer: args.writer,
    taskId: auditorTaskId,
    taskKind: "audit",
    eventLineage: {
      runId: args.runId,
      specId: args.costCtx.specId,
      projectId: args.costCtx.projectId,
      orgId: args.costCtx.orgId,
    },
    body: () => runAuditorTerminalBlock(args, auditorTaskId, result, startedAt),
  });
}

async function runAuditorTerminalBlock(
  args: AuditorStageInput,
  auditorTaskId: string,
  result: Awaited<ReturnType<typeof invokeAuditor>>,
  startedAt: number,
): Promise<AuditorStageResult> {
  const runtimeSeconds = secondsSince(startedAt);
  emitStageTiming("audit", Date.now() - startedAt, { runId: args.runId });
  // SPEC-LOOP REDESIGN: the auditor emits FINDINGS as its sole workflow currency.
  // `findings` is REQUIRED on the parsed `AuditAnswer` (no `.default([])`), so the
  // verdict always carries a real, explicitly-emitted array. `passed` is a derived
  // notification projection only: it never drives triage or merge posture.
  const findings = auditorFindings(result.verdict);
  // PRE-TERMINAL `auditor.verdict` wrapped: a throw here lands as
  // `event_append_failed` rather than the fail-closed `crashed`.
  await wrapEventAppend(() =>
    args.appendEvent("auditor.verdict", { runId: args.runId, passed: findings.length === 0, findings }, auditorTaskId),
  );
  await recordAnswererCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    role: "auditor",
    taskId: auditorTaskId,
    // The REAL model id the adapter sends, not a role pseudo-id — role travels on
    // `role` above (→ cost_source_raw.role) so notional pricing can key on a real id.
    model: args.adapter.model ?? "",
    runtimeSeconds,
    rawUsage: args.buildUsage?.({ auditorTaskId, verdict: result.verdict }) ?? { role: "auditor" },
  });
  // ATOMIC terminal-row + terminal-event pair (task #39): one org-scoped
  // transaction so the row UPDATE + `task.completed` COMMIT together — replaces
  // the prior split that stranded `done` rows with no `task.completed` event.
  await markTaskDoneWithEvent({
    writer: args.writer,
    taskId: auditorTaskId,
    envelope: auditorEventEnvelope(args),
    outcome: "passed",
  });
  return { findings, auditorTaskId };
}

/** Lineage for the auditor stage's atomic terminal-pair events (task #39). */
function auditorEventEnvelope(args: AuditorStageInput) {
  return {
    runId: args.runId,
    specId: args.costCtx.specId,
    projectId: args.costCtx.projectId,
    // The run's tenant key (from the CostRecordContext; NOT NULL on `runs.org_id`).
    // Required on TerminalTaskEventEnvelope so every routed terminal event carries
    // org_id explicitly (v68 fix; see {@link AppendEventInput.orgId}).
    orgId: args.costCtx.orgId,
    taskKind: "audit",
  };
}

// Replay the prior apex v51 emit-on-throw shape for a non-schema auditor-answerer
// throw, kept HERE (outside the finalize guard) because the schema-miss branch
// shares this catch layer — the wider task #35 guard wraps only the post-answerer
// terminal block to avoid colliding with the schema-miss path's own emits.
async function emitAuditorAnswererThrow(
  args: AuditorStageInput,
  auditorTaskId: string,
  error: unknown,
): Promise<never> {
  const failureKind = classifyStageFailureKind(error);
  // ATOMIC terminal-row + terminal-event pair (task #39): the row UPDATE +
  // `task.failed` event ride ONE org-scoped transaction so a crash between them
  // never strands a `failed` row with no event (or vice-versa) — the loud
  // timeline signal lands iff the row does.
  await markTaskFailedWithEvent({
    writer: args.writer,
    taskId: auditorTaskId,
    envelope: auditorEventEnvelope(args),
    failureKind,
    message: stageFailureMessage(error),
  });
  throw error;
}

// The synthetic P0 a schema-parse miss yields so the loop's triage routes a fix-in-spec
// task (re-plan + re-audit) instead of dead-ending. NOT the raw parse error (it can
// embed model output); the full error is logged via console.warn for diagnosis.
const AUDITOR_SCHEMA_MISS_FINDING: Finding = {
  id: "auditor-schema-miss",
  severity: "P0",
  title: "Auditor produced no parseable verdict",
  body: "The auditor emitted output that failed the audit schema parse; re-audit (and re-plan if needed) to obtain a well-formed findings list.",
};

/**
 * Turn an auditor schema-parse miss into a fail-closed synthetic P0 FINDING (not a
 * run-`failed` dead-end). Marks the audit task failed and returns the synthetic finding
 * so the loop's triage routes a fix-in-spec task. Fail-closed is preserved: no
 * `auditor.verdict` is written, so the land gate's synthetic-P0 still blocks the merge.
 */
async function failClosedForSchemaMiss(
  args: AuditorStageInput,
  auditorTaskId: string,
  error: AnswererSchemaValidationError,
): Promise<AuditorStageResult> {
  log.warn("schema-parse miss — synthesizing a P0 finding to re-audit", { runId: args.runId }, error);
  // Audit-trail integrity (critic-arc R1 #5 + task #39): row UPDATE +
  // `task.failed` ride ONE org-scoped transaction — the row flip to `failed`
  // with `failureKind="auditor_schema_invalid"` and the matching event commit
  // together, so a crash between them cannot self-inconsistency the audit trail
  // (the prior split that emitted `task.completed` against a `failed` row is
  // also gone — the EVENT here is correctly `task.failed`).
  await markTaskFailedWithEvent({
    writer: args.writer,
    taskId: auditorTaskId,
    envelope: auditorEventEnvelope(args),
    failureKind: "auditor_schema_invalid",
  });
  return { findings: [AUDITOR_SCHEMA_MISS_FINDING], auditorTaskId };
}
