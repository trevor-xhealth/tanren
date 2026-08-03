// The WS-D4 native design-fidelity ORACLE loop stage — the verify→re-drive half of the
// design loop. Split out of loopStages.ts to keep both modules under the 500-line
// architecture cap (and to give the oracle's own stall recovery a clean home). The cost +
// event + task-row accounting is preserved exactly as the demo-run slot's.
import { randomUUID } from "node:crypto";
import type { ActorContext } from "../../auth/schemas.js";
import type { ActorRef } from "../state/actor.js";
import type { SpecMode } from "../state/spec.js";
import type { DesignOracleAnswer } from "../answerers/schemas/index.js";
import type { Finding } from "../contracts/findings.js";
import { emitStageTiming } from "../observability/index.js";
import type { AnswererAdapter } from "../providers/types.js";
import {
  MalformedDesignOracleResultError,
  runDesignOracleStage,
  type DesignOracleStageResult,
} from "./designOracle/designOracle.js";
import type { LoopQueryClient, StageBase } from "./loopStages.js";
import { runAnswererStageWithRecovery } from "./loopStageRecovery.js";
import { runStageBodyWithFinalizeGuard, wrapEventAppend } from "./stageFailureKind.js";
import { recordAnswererCost, secondsSince } from "./subtaskCost.js";
import { insertChildTask, markTaskDoneWithEvent } from "./subtaskTasks.js";

export interface DesignOracleLoopStageInput extends StageBase {
  adapter: AnswererAdapter<DesignOracleAnswer>;
  // The query client the oracle reads the contract + entity graph through (the run's
  // org-scoped pool — RLS-scoped, actor-authorized).
  client: LoopQueryClient;
  projectId: string;
  // The org-scope carrier for the entity-graph reads + the audit/event actor for the
  // contract store reads (built in plannerRun from the run's org/project).
  actor: ActorContext;
  actorRef: ActorRef;
  baselineSha: string;
  // OPTIONAL spec writer-prompt MODE (audit round-2 H1) — threaded through to the
  // oracle so a `specialize_seed` spec gets the seeded-mode tail block scoping the
  // oracle off the pre-existing seed surfaces. Absent / `from_scratch` ⇒ no block.
  specMode?: SpecMode;
}

/**
 * Run the native design-fidelity ORACLE stage (WS-D4) — the verify→re-drive half of the
 * design loop. Mirrors `runDemoRunStage`'s wiring (task row + events + cost), delegating
 * the contract read + ref resolution + answerer invocation to the reusable
 * `runDesignOracleStage` oracle module. Returns the normalized fidelity findings for the
 * loop's ONE triage input. No kill-switch; a project with NO design contract no-ops
 * cleanly (empty findings, no answerer call, no cost) — never a fabricated default.
 *
 * STAGE-LOCAL stall recovery: the oracle's answerer call (inside `runDesignOracleStage`) is
 * wrapped so a transient stall re-drives THIS stage in place — the spec loop's sibling
 * progress is preserved, never a whole-spec restart — while a genuinely-wedged oracle
 * escalates loudly via the shared convergence judgment. A no-contract no-op never stalls.
 */
export async function runDesignOracleLoopStage(
  args: DesignOracleLoopStageInput,
): Promise<{ findings: Finding[]; designOracleTaskId: string | undefined }> {
  // Run the oracle first; only materialize a task row / events / cost when a contract was
  // genuinely verified. A no-contract project produces no task (the explicit empty state),
  // mirroring how the demo-run slot is simply skipped when there is nothing to do. A throw
  // BEFORE the task row materializes propagates to the workflow catch — there is no row
  // to strand `running` yet, so no `task.failed` to emit against.
  const startedAt = Date.now();
  const result = await runAnswererStageWithRecovery("designOracle", () =>
    runDesignOracleStage({
      client: args.client,
      projectId: args.projectId,
      actor: args.actor,
      actorRef: args.actorRef,
      adapter: args.adapter,
      baselineSha: args.baselineSha,
      workspacePath: args.workspacePath,
      ...(args.specMode !== undefined && { specMode: args.specMode }),
    }),
  );
  if (!result.hasContract) {
    return { findings: [], designOracleTaskId: undefined };
  }

  // A contract WAS verified — record the stage as a task with its verdict + cost, exactly
  // like the demo-run slot. The oracle already invoked the answerer; the cost record below
  // attributes that real call (token telemetry surfaced by the same adapter instance).
  const designOracleTaskId = `task_${randomUUID()}`;
  await insertChildTask(
    args.pool,
    {
      taskId: designOracleTaskId,
      runId: args.runId,
      kind: "designOracle",
      title: "design-oracle verify",
      parentTaskId: args.plannerTaskId,
      agentKind: "answerer",
      cli: args.adapter.cli,
      model: null,
    },
    args.writer,
  );
  await args.appendEvent("task.started", { taskKind: "designOracle" }, designOracleTaskId);
  await args.appendEvent("designOracle.started", { taskKind: "designOracle" }, designOracleTaskId);
  // WIDER FINALIZE GUARD (Codex critic #5): wrap the WHOLE post-row body so a recorder /
  // event-append / terminal-pair throw closes the row loud + emits `task.failed`. This
  // stage was the outlier — the demo-run / triage / convergence neighbors already wrap
  // their post-insert bodies; a mid-stage throw here (verdict append / cost recorder /
  // markTaskDoneWithEvent) previously stranded the row `running` with no `task.failed`
  // event, defeating DAG-walker re-drive at the row granularity (same shape as #640).
  return await runStageBodyWithFinalizeGuard({
    writer: args.writer,
    taskId: designOracleTaskId,
    taskKind: "designOracle",
    eventLineage: {
      runId: args.runId,
      specId: args.costCtx.specId,
      projectId: args.costCtx.projectId,
      orgId: args.costCtx.orgId,
    },
    body: () => runDesignOracleLoopStageBody(args, designOracleTaskId, result, startedAt),
  });
}

async function runDesignOracleLoopStageBody(
  args: DesignOracleLoopStageInput,
  designOracleTaskId: string,
  result: DesignOracleStageResult,
  startedAt: number,
): Promise<{ findings: Finding[]; designOracleTaskId: string }> {
  emitStageTiming("audit", Date.now() - startedAt, { runId: args.runId });
  // Codex critic #6 — a `hasContract: true` result MUST carry `contractVersion` +
  // `verificationMode` + `summary`. The prior `?? 0` / `?? ""` fallbacks silently
  // coerced a malformed oracle result (a schema regression, an adapter mock miss,
  // etc.) into plausible-looking empty metadata on the `designOracle.verdict`
  // event, hiding the regression on the run timeline. Assert loud and let the
  // finalize guard close the task row on the typed error.
  const verdictPayload = assertDesignOracleVerdictPayload(result, args.runId);
  await wrapEventAppend(() => args.appendEvent("designOracle.verdict", verdictPayload, designOracleTaskId));
  await recordAnswererCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    role: "designOracle",
    taskId: designOracleTaskId,
    // The REAL model id the adapter sends, not a role pseudo-id — role travels on
    // `role` above (→ cost_source_raw.role) so notional pricing can key on a real id.
    model: args.adapter.model ?? "",
    runtimeSeconds: secondsSince(startedAt),
    rawUsage: { role: "designOracle" },
  });
  // ATOMIC terminal-row + terminal-event pair (task #39): row UPDATE +
  // `task.completed` ride ONE org-scoped transaction.
  await markTaskDoneWithEvent({
    writer: args.writer,
    taskId: designOracleTaskId,
    envelope: {
      runId: args.runId,
      specId: args.costCtx.specId,
      projectId: args.costCtx.projectId,
      orgId: args.costCtx.orgId,
      taskKind: "designOracle",
    },
    outcome: "passed",
  });
  return { findings: result.findings, designOracleTaskId };
}

/**
 * Validate the `hasContract: true` oracle result's timeline-observable fields and
 * return the strongly-typed `designOracle.verdict` payload (Codex critic #6). A
 * missing/empty field throws {@link MalformedDesignOracleResultError} so the
 * finalize guard closes the task row loud + emits a deterministic `task.failed`
 * — never the prior `?? 0` / `?? ""` silent coercion that hid the regression.
 *
 * Exported for direct unit-testing — the same assertion runs on every clean-path
 * `hasContract: true` result inside the loop-stage body.
 */
export function assertDesignOracleVerdictPayload(
  result: DesignOracleStageResult,
  runId: string,
): { runId: string; contractVersion: number; verificationMode: string; summary: string; findings: Finding[] } {
  const missing: string[] = [];
  const { contractVersion, verificationMode, summary } = result;
  if (contractVersion === undefined || contractVersion === null) missing.push("contractVersion");
  if (verificationMode === undefined || verificationMode === "") missing.push("verificationMode");
  if (summary === undefined || summary === "") missing.push("summary");
  if (missing.length > 0 || contractVersion === undefined || verificationMode === undefined || summary === undefined) {
    throw new MalformedDesignOracleResultError(`missing/empty field(s): ${missing.join(", ")}`);
  }
  return { runId, contractVersion, verificationMode, summary, findings: result.findings };
}
