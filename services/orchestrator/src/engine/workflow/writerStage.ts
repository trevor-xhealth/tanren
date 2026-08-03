// The WRITER stage of the spec-implementation loop, split out of `subtaskStages.ts`
// to keep both modules under the 500-line architecture cap (same split shape as the
// `auditorStage.ts` extraction). Owns the single writer invocation per subtask: the
// task row INSERT, the `task.started` + `writer.subtask.started` events, the writer
// call itself (with apex v51 per-stage `task.failed` emit-on-throw wrapping the
// setup-path throw surface), the cost record, and the exit-reason branch
// (`window_exhausted` / `crashed` / `timeout` / `completed` / `token_limit`) that
// routes a non-`completed` writer to a typed FAILED task — never laundered into a
// passed task whose partial/empty diff flows downstream as a success.

import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { PlanSubtask } from "../answerers/schemas/index.js";
import { emitStageTiming } from "../observability/index.js";
import { createLogger } from "../observability/logger.js";
import type { WriterAdapter, WriterResult } from "../providers/types.js";
import { recordWriterCost, secondsSince, type SubtaskCostContext } from "./subtaskCost.js";
import { runStageBodyWithFinalizeGuard, wrapEventAppend } from "./stageFailureKind.js";
import { insertChildTask, markTaskDoneWithEvent, markTaskFailedWithEvent } from "./subtaskTasks.js";
import type { StageAppendEvent } from "./subtaskStages.js";

// Structured log seam for the watchdog-progress bridge (Codex critic #1). The
// `onWatchdogProgress` callback fires-and-forgets `writer.subtask.progress`; a
// silent swallow of an appendEvent rejection makes the cross-layer sign-of-life
// bridge invisibly broken (any parent progress reader reads the writer as
// no-longer-signaling while the actual work signature is still advancing). Route
// the catch through this logger so an operator investigating "why did the watchdog
// fire on a spec that was making progress" finds durable evidence of the
// transport failure, keyed by run/task/subtask.
const watchdogProgressLog = createLogger("writer-watchdog-progress");

type LoopQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface WriterStageInput {
  pool: LoopQueryClient;
  /**
   * REQUIRED (audit finding H3 sweep): the writer-subtask's terminal row +
   * event pair rides the atomic seam through this writer — no fallback.
   * Production wires the always-returning `runStateWriterFromEnv`; tests wire
   * the `InMemoryRunStateWriter` fixture.
   */
  writer: RunStateWriter;
  costCtx: SubtaskCostContext;
  adapter: WriterAdapter;
  runId: string;
  workspacePath: string;
  plannerTaskId: string;
  subtask: PlanSubtask;
  writeTaskId: string;
  prompt: string;
  // The run's BASE sha (clone point), captured once after the workspace clone.
  // Threaded to the writer so it diffs the workspace against the run base —
  // judging each subtask on the CUMULATIVE state, not the per-subtask HEAD
  // delta (so replanned already-done work isn't false-rejected as an empty
  // diff). Omitted by unit callers that drive the stage without a base sha.
  baseSha?: string;
  appendEvent: StageAppendEvent;
  buildUsage?: (input: {
    subtaskTaskId: string;
    subtaskIndex: number;
    attempt: number;
    writer: WriterResult;
  }) => Record<string, unknown>;
}

// The classified result of a writer subtask call. The provider adapters carefully
// classify each run via `WriterResult.exitReason`; this is where that signal is
// READ and routed. A non-`completed` writer must NEVER be laundered into a passed
// task whose partial/empty diff flows downstream as a success:
//   - `completed` / `token_limit` → the task passes; the diff is consumed (the
//     existing semantics — `token_limit` is a clean stop with usable output).
//   - `window_exhausted` → the subscription window is spent mid-call (an expected,
//     RECOVERABLE §4.3 condition); the loop halts the run as window pressure.
//   - `crashed` / `timeout` → a hard, typed failure routed back through the
//     planner-rework/retry-budget path; the task row lands `failed`, not `passed`.
export type WriterStageOutcome =
  | { kind: "completed"; writer: WriterResult }
  | { kind: "window_exhausted"; writer: WriterResult }
  | { kind: "failed"; writer: WriterResult; failureKind: "crashed" | "timeout" };

export async function runWriterStage(args: WriterStageInput): Promise<WriterStageOutcome> {
  await insertChildTask(
    args.pool,
    {
      taskId: args.writeTaskId,
      runId: args.runId,
      kind: "write",
      title: `write subtask ${args.subtask.index}: ${args.subtask.title}`,
      parentTaskId: args.plannerTaskId,
      agentKind: "writer",
      cli: args.adapter.cli,
      model: null,
    },
    args.writer,
  );
  await args.appendEvent("task.started", { taskKind: "write" }, args.writeTaskId);
  await args.appendEvent(
    "writer.subtask.started",
    {
      runId: args.runId,
      taskId: args.writeTaskId,
      subtaskIndex: args.subtask.index,
      intent: args.subtask.intent,
      behaviorIds: [...args.subtask.behaviorIds],
    },
    args.writeTaskId,
  );
  // WIDER FINALIZE GUARD (task #35 — critic-arc R1 #6 / R2): wrap the WHOLE
  // post-insert body — provider call + cost record + terminal row + terminal
  // event — so a throw ANYWHERE (provider setup, cost recorder, event append)
  // closes the row loud + emits exactly one `task.failed`. This SUPERSEDES the
  // inner `runStageWithEmitOnThrow` apex v51 wrap (it only covered the provider
  // body — a recorder throw still stranded the row in `running`).
  return await runStageBodyWithFinalizeGuard({
    writer: args.writer,
    taskId: args.writeTaskId,
    taskKind: "write",
    eventLineage: {
      runId: args.runId,
      specId: args.costCtx.specId,
      projectId: args.costCtx.projectId,
      orgId: args.costCtx.orgId,
    },
    body: () => runWriterStageBody(args),
  });
}

async function runWriterStageBody(args: WriterStageInput): Promise<WriterStageOutcome> {
  const startedAt = Date.now();
  const writerResult = await args.adapter.runWriter({
    prompt: args.prompt,
    workspace: args.workspacePath,
    baseSha: args.baseSha,
    // CROSS-LAYER sign-of-life bridge (task #24, apex v52/v53). On every probe
    // tick the SSH ActivityWatchdog reads the work signature as advancing, emit a
    // `writer.subtask.progress` row — a durable per-tick advancement signal any
    // parent progress reader can observe. Composes with the substrate-internal
    // `MIN_NON_ADVANCING_NEIGHBOR_REPEATS_*` streak floor (ssh/watchdogProgress.ts)
    // so a legitimately slow writer whose work signature briefly plateaus mid-
    // IO-burst (a `pnpm install` window) does not trip a spurious wedge. Fire-
    // and-forget `void` because `onProgress` is synchronous (the substrate
    // already catches any throw, but we double-defend here — a rejected
    // appendEvent must not bubble back into the watchdog tick).
    //
    // Codex critic #1: the append is fire-and-forget, but its rejection is NOT
    // silent. The prior empty `.catch(() => {})` made a broken control-plane
    // writer invisible — any parent progress reader would then observe the
    // writer as no-longer-signaling while the actual work signature is still
    // advancing, so the watchdog fires on a run that WAS making progress with
    // zero durable evidence for the operator. Route through
    // `watchdogProgressLog.warn` so one structured JSON line (level=warn →
    // console.error) carries the run/task/subtask lineage + the underlying
    // error, on an entirely different path from `appendEvent` (the log stream,
    // not the event transport). Still never re-throws — the watchdog callback
    // contract stands.
    onWatchdogProgress: (signal) => {
      void args
        .appendEvent(
          "writer.subtask.progress",
          {
            runId: args.runId,
            taskId: args.writeTaskId,
            subtaskIndex: args.subtask.index,
            intent: args.subtask.intent,
            outputBytesAdvanced: signal.outputBytesAdvanced,
            ...(signal.workspaceSignature === undefined ? {} : { workspaceSignature: signal.workspaceSignature }),
          },
          args.writeTaskId,
        )
        .catch((error: unknown) => {
          watchdogProgressLog.warn(
            "writer.subtask.progress append failed — cross-layer sign-of-life bridge broken",
            {
              runId: args.runId,
              taskId: args.writeTaskId,
              subtaskIndex: args.subtask.index,
            },
            error,
          );
        });
    },
  });
  const runtimeSeconds = secondsSince(startedAt);
  emitStageTiming("write", Date.now() - startedAt, {
    runId: args.runId,
    subtaskIndex: args.subtask.index,
  });
  // The cost is recorded for EVERY outcome — a crashed / timed-out / window-
  // exhausted writer still consumed real tokens. The success event
  // (`writer.subtask.completed`) is emitted ONLY on the success branch below, so
  // a non-completing writer never claims completion. A throw from the recorder is
  // RE-RAISED as CostRecordError by recordWriterCost — the outer guard catches it
  // and routes `failureKind: "cost_record_failed"`.
  await recordWriterCost({
    ctx: args.costCtx,
    adapter: args.adapter,
    taskId: args.writeTaskId,
    // The REAL model id the writer adapter sends — replaces the former
    // `"tanren-writer"` pseudo-id, which no price source could ever look up. The
    // role is recorded on its own field (`role: "writer"`, → cost_source_raw.role).
    model: args.adapter.model ?? "",
    runtimeSeconds,
    tokenUsage: writerResult.tokenUsage,
    rawUsage: args.buildUsage?.({
      subtaskTaskId: args.writeTaskId,
      subtaskIndex: args.subtask.index,
      attempt: 1,
      writer: writerResult,
    }) ?? { role: "writer", attempt: 1, subtaskIndex: args.subtask.index },
    // Gates `usage.token_accounting_failed` in recordWriterCost — a TERMINATED
    // writer is already loud via `writer.subtask.failed` (apex v50 fix B1).
    exitReason: writerResult.exitReason,
  });

  // Branch on how the writer actually exited (provider adapters classify this
  // via `exitReason`; read it HERE so a non-`completed` run never reaches the
  // checker as a passed task with a partial/empty diff). The cost above is
  // recorded for every outcome — the work consumed real tokens regardless.
  //
  // task #22: the three writer-failed branches (window_exhausted / crashed /
  // timeout) all converge on the SAME shape — a wrapped pre-terminal
  // `writer.subtask.failed` event with `{ failureKind, message }`, then the atomic
  // FAILED-terminal pair (row UPDATE + `task.failed`) keyed on the same
  // `failureKind`. The branches now select only the per-kind `WriterFailedExit`
  // descriptor (kind + message + WriterStageOutcome shape) and route through ONE
  // helper, so the event payload + atomic terminal contract are written down ONCE.
  const exitReason = writerResult.exitReason;
  const failedExit = classifyFailedExit(exitReason);
  if (failedExit !== undefined) {
    return await emitWriterSubtaskTerminalFailure(args, writerResult, failedExit);
  }
  // `completed` / `token_limit`: the diff is usable, mark the task passed and
  // emit the success event (the writer genuinely produced its subtask output).
  // The PRE-TERMINAL `writer.subtask.completed` append is wrapped so a transport
  // throw lands as `event_append_failed` rather than the fail-closed `crashed`.
  // The terminal row + `task.completed` event are an ATOMIC pair (task #39):
  // ONE org-scoped transaction so the row UPDATE + the timeline event live or
  // die together — replaces the prior split that stranded the row terminal-`done`
  // with no `task.completed` on a crash/DB failure between them
  // (autonomy-engine.md §1c single-finalize invariant).
  await wrapEventAppend(() =>
    args.appendEvent(
      "writer.subtask.completed",
      {
        runId: args.runId,
        taskId: args.writeTaskId,
        subtaskIndex: args.subtask.index,
        intent: args.subtask.intent,
        decisions: [],
        toolCalls: [],
        diffBytes: Buffer.byteLength(writerResult.diff, "utf8"),
        commitSha: writerResult.commits[0]?.sha ?? null,
      },
      args.writeTaskId,
    ),
  );
  await markTaskDoneWithEvent({
    writer: args.writer,
    taskId: args.writeTaskId,
    envelope: writerEventEnvelope(args),
    outcome: "passed",
  });
  return { kind: "completed", writer: writerResult };
}

/** Lineage for the writer stage's atomic terminal-pair events (task #39). */
function writerEventEnvelope(args: WriterStageInput) {
  return {
    runId: args.runId,
    specId: args.costCtx.specId,
    projectId: args.costCtx.projectId,
    // The run's tenant key (from the CostRecordContext; NOT NULL on `runs.org_id`).
    // Required on TerminalTaskEventEnvelope so every routed terminal event carries
    // org_id explicitly (v68 fix; see {@link AppendEventInput.orgId}).
    orgId: args.costCtx.orgId,
    taskKind: "write",
  };
}

// Emit the (previously latent) `writer.subtask.failed` timeline event so a
// crashed / timed-out / window-exhausted writer is recorded loudly with its
// failure kind + message, never silently swallowed.
async function emitWriterSubtaskFailed(args: WriterStageInput, failureKind: string, message: string): Promise<void> {
  await args.appendEvent(
    "writer.subtask.failed",
    {
      runId: args.runId,
      taskId: args.writeTaskId,
      subtaskIndex: args.subtask.index,
      intent: args.subtask.intent,
      failureKind,
      message,
    },
    args.writeTaskId,
  );
}

// task #22: the closed set of writer FAILED `exitReason` arms the stage handles.
// Each carries (a) the deterministic `failureKind` written to BOTH the pre-terminal
// `writer.subtask.failed` event AND the atomic `task.failed` row/event pair, (b) the
// human-readable message that rides on `writer.subtask.failed` so the timeline
// carries one loud explanation per kind, and (c) the matching `WriterStageOutcome`
// shape returned to the caller. Centralized so all three branches use ONE
// payload+atomic-terminal contract — adding a future failed-exit kind only edits
// this descriptor.
type WriterFailedExitKind = "window_exhausted" | "crashed" | "timeout";
interface WriterFailedExitDescriptor {
  failureKind: WriterFailedExitKind;
  message: string;
  outcome: (writer: WriterResult) => WriterStageOutcome;
}

function classifyFailedExit(exitReason: WriterResult["exitReason"]): WriterFailedExitDescriptor | undefined {
  switch (exitReason) {
    case "window_exhausted":
      return {
        failureKind: "window_exhausted",
        message: "writer usage window exhausted mid-subtask",
        outcome: (writer) => ({ kind: "window_exhausted", writer }),
      };
    case "timeout":
      return {
        failureKind: "timeout",
        message: "writer timed out before completing the subtask",
        outcome: (writer) => ({ kind: "failed", writer, failureKind: "timeout" }),
      };
    case "crashed":
      return {
        failureKind: "crashed",
        message: "writer crashed mid-subtask",
        outcome: (writer) => ({ kind: "failed", writer, failureKind: "crashed" }),
      };
    default:
      // `completed` / `token_limit` — the SUCCESS arms, not handled here.
      return undefined;
  }
}

// task #22: the SINGLE writer-failed terminal helper. Every failed-exit branch
// (window_exhausted / crashed / timeout) flows through here:
//   1. wrapped pre-terminal `writer.subtask.failed` (so a transport throw lands as
//      `event_append_failed`, not the fail-closed `crashed`); then
//   2. the atomic FAILED-terminal pair (row UPDATE + `task.failed`) through
//      `markTaskFailedWithEvent` — ONE org-scoped transaction (task #39).
// Cost accounting is recorded for EVERY outcome BEFORE this helper runs (see the
// `recordWriterCost` call in `runWriterStageBody`), so the failed-exit branches
// already share that, too. The descriptor → outcome mapping is the only per-kind
// thing left.
async function emitWriterSubtaskTerminalFailure(
  args: WriterStageInput,
  writerResult: WriterResult,
  exit: WriterFailedExitDescriptor,
): Promise<WriterStageOutcome> {
  await wrapEventAppend(() => emitWriterSubtaskFailed(args, exit.failureKind, exit.message));
  await markTaskFailedWithEvent({
    writer: args.writer,
    taskId: args.writeTaskId,
    envelope: writerEventEnvelope(args),
    failureKind: exit.failureKind,
    message: exit.message,
  });
  return exit.outcome(writerResult);
}
