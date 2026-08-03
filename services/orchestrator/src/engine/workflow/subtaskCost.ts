// cost-recording helpers for the planner-feedback loop. Extracted
// out of subtaskLoop.ts so the orchestration file stays under the 500-line
// architecture cap. Every Answerer/Writer call in the loop runs through these
// helpers. Token accounting is MANDATORY for a real CLI call: a real call that
// records its cost with NO token telemetry is parser/adapter drift that would
// otherwise silently land as a zero-token, zero-notional row — so it is surfaced
// LOUDLY (`usage.token_accounting_failed`), NEVER conflated with a genuine
// zero-token call (a fake fixture). Dollar cost stays best-effort (NULL when
// unknown), so recording never fails the task for missing cost.
import type { CostRecorder } from "../costs/index.js";
import type { RealProviderCostCapturer } from "../costs/generationCostCapture.js";
import {
  emptyTokenUsage,
  type AnswererAdapter,
  type TokenUsage,
  type WriterAdapter,
  type WriterResult,
} from "../providers/types.js";
import { CostRecordError } from "./stageFailureKind.js";
import type { AppendEvent } from "./subtaskLoop.js";

// The classified exit reason of the writer call whose cost is being recorded.
// Re-export of WriterResult["exitReason"] so callers can name the type without
// importing WriterResult directly. apex v50 surfaced that this discriminant
// MUST gate the loud `usage.token_accounting_failed` emission — see
// recordWriterCost below for the doctrine.
export type WriterExitReason = WriterResult["exitReason"];

// The agent role whose real call was found to carry no token telemetry — the
// `usage.token_accounting_failed` discriminant.
export type TokenAccountingRole =
  | "planner"
  | "checker"
  | "auditor"
  | "writer"
  | "triage"
  | "convergence"
  | "demoRun"
  | "designOracle";

// A narrow callback that emits the loud `usage.token_accounting_failed` event.
// Threaded from the loop (which owns the typed AppendEvent) so this helper stays
// free of an EventName import cycle. Absent on a path with no event sink (tests).
export type EmitTokenAccountingFailed = (input: {
  role: TokenAccountingRole;
  cli: string;
  model: string;
  taskId: string;
}) => Promise<void>;

export interface SubtaskCostContext {
  recorder: CostRecorder;
  runId: string;
  specId: string;
  projectId: string;
  /** The run's tenant key (NOT NULL on `runs.org_id`); stamped on the derived
   *  cost-timeline event (v68 fix; see {@link CostRecordContext.orgId}). */
  orgId: string;
  // MANAGED-run real-cost capture: given the OpenRouter generation id a managed
  // adapter surfaced (TokenUsage.openRouterGenerationId), resolve the REAL platform
  // `usage.cost` so cost_usd is recorded as a metered FACT (`provider_response`).
  // Absent on a BYOK / non-managed run → no capture → cost_usd NULL (no estimate).
  captureRealProviderCost?: RealProviderCostCapturer;
  // The loud-event sink for a real CLI call missing token telemetry. Threaded
  // from the loop; absent ⇒ no sink (the recording still proceeds).
  emitTokenAccountingFailed?: EmitTokenAccountingFailed;
  // The loud-event sink for a MANAGED OpenRouter real-cost capture failure
  // (auth/transport/API). Threaded from the loop; absent ⇒ no sink.
  emitProviderCaptureFailed?: EmitProviderCaptureFailed;
  // DRIFT DETECTION (the other direction from costs/meterability.ts): a capturer is
  // wired — i.e. the route was judged able to produce per-call facts — but a real
  // call surfaced NO generation id, so the capture silently could not fire. That
  // silence is exactly the symptom of the harness dropping the upstream envelope, so
  // it must be LOUD rather than a quiet reversion to NULL cost. Threaded from the
  // loop; absent ⇒ no sink.
  emitGenerationIdMissing?: EmitGenerationIdMissing;
  // ONE-SHOT LATCH for the above. The id is missing on EVERY call of an affected
  // run, so emitting per call would bury the timeline in identical events; the run's
  // standing posture is already narrated once by `cost.route_unmeterable`. Mutated
  // in place on the shared per-run context.
  generationIdMissingReported?: { reported: boolean };
}

// A narrow callback that emits the loud `cost.generation_id_missing` event.
export type EmitGenerationIdMissing = (input: { cli: string; taskId: string }) => Promise<void>;

// A narrow callback that emits the loud `cost.provider_capture_failed` event.
export type EmitProviderCaptureFailed = (input: {
  generationId: string;
  detail: string;
  taskId: string;
}) => Promise<void>;

// A REAL CLI (NOT a fake fixture). A "fake" cli is a test fixture whose zero-token
// usage is legitimate and stays quiet; any other cli is a real call whose missing
// telemetry is mandatory-accounting drift, surfaced LOUDLY.
function isRealCli(cli: string): boolean {
  return cli !== "fake";
}

// A REAL CLI call whose token telemetry is absent or all-zero — mandatory-accounting
// drift, distinct from a genuine zero-token call.
function isRealMissingTelemetry(cli: string, tokenUsage: TokenUsage | undefined): boolean {
  return isRealCli(cli) && (tokenUsage === undefined || tokenUsage.totalTokens <= 0);
}

// Resolve the REAL provider cost for a call when (a) a managed-run capturer is
// wired AND (b) the adapter surfaced an OpenRouter generation id on its token
// usage. Returns null when no capturer / no id — cost_usd then stays NULL
// (`unknown`), never a list-rate estimate (REAL SPEND IS A FACT). A capturer that
// returns a LOUD `{ failed }` (managed auth/transport/API miss) erases
// AUTHORITATIVE platform spend: emit `cost.provider_capture_failed` and record
// cost_usd null (no silent $0), rather than swallowing the failure.
async function captureRealProviderCostUsd(
  ctx: SubtaskCostContext,
  tokenUsage: TokenUsage | undefined,
  taskId: string,
  cli: string,
): Promise<number | null> {
  const generationId = tokenUsage?.openRouterGenerationId;
  if (ctx.captureRealProviderCost === undefined) {
    return null;
  }
  if (generationId === undefined) {
    // A capturer IS wired (the route was judged meterable), yet the harness gave us
    // no id to query with — the exact silent-null this whole design exists to make
    // visible. Latched to once per run so the signal is legible, not a flood.
    if (ctx.generationIdMissingReported?.reported !== true) {
      if (ctx.generationIdMissingReported !== undefined) {
        ctx.generationIdMissingReported.reported = true;
      }
      await ctx.emitGenerationIdMissing?.({ cli, taskId });
    }
    return null;
  }
  const capture = await ctx.captureRealProviderCost(generationId);
  if ("failed" in capture) {
    await ctx.emitProviderCaptureFailed?.({
      generationId: capture.failed.generationId,
      detail: capture.failed.detail,
      taskId,
    });
    return null;
  }
  return capture.cost;
}

export interface AnswererCostInput<TOutput> {
  ctx: SubtaskCostContext;
  adapter: AnswererAdapter<TOutput>;
  // The answerer role whose call this records — the loud-event discriminant. Covers
  // the spec-loop redesign stages (triage/convergence/demoRun) alongside the original
  // planner/checker/auditor answerers (the writer records via recordWriterCost).
  role: Extract<
    TokenAccountingRole,
    "planner" | "checker" | "auditor" | "triage" | "convergence" | "demoRun" | "designOracle"
  >;
  taskId: string;
  /**
   * The REAL model id this call was sent to — the `cost_records.model` value and the
   * NOTIONAL price-source lookup key.
   *
   * It used to be a PSEUDO id naming the role (`"tanren-planner"`, `"tanren-writer"`,
   * …) because there was no other channel for the role. That smuggling had a cost:
   * no such id exists in the LiteLLM price source, so `computeNotionalUsd` returned
   * null for EVERY answerer/writer row and `notional_cost_usd` was structurally NULL
   * in every deployment (with `cost.notional_unpriced` firing on 100% of rows). The
   * role now travels on its own field (`CostRecordContext.role` →
   * `cost_source_raw.role`), so this carries the real id. `""` is the honest
   * "adapter declares no model" value (a `fake` fixture) — the recorder already
   * treats it as notional-null-and-quiet.
   */
  model: string;
  runtimeSeconds: number;
  rawUsage: Record<string, unknown>;
  /** Override the run scope for a pre-spec IssueLoop triage task. */
  issueLoopId?: string;
}

export interface WriterCostInput {
  ctx: SubtaskCostContext;
  adapter: WriterAdapter;
  taskId: string;
  /** The REAL model id this writer call was sent to — see {@link AnswererCostInput.model}. */
  model: string;
  runtimeSeconds: number;
  tokenUsage: TokenUsage | undefined;
  rawUsage: Record<string, unknown>;
  // The writer call's classified exit reason — gates the loud
  // `usage.token_accounting_failed` emission in recordWriterCost. A writer
  // TERMINATED mid-call (`timeout` / `crashed` / `window_exhausted`) was killed
  // before `turn.completed` could carry usage, so the missing telemetry is the
  // EXPECTED consequence of the termination (already loud via
  // `writer.subtask.failed`) — double-emit would double-classify the same
  // underlying failure. Only `completed` / `token_limit` (a turn that DID
  // complete) warrants the loud event for genuine parser/adapter drift.
  // Threaded by runWriterStage from `writerResult.exitReason`. (apex v50
  // surfaced the double-emit: 8 zero-token rows all `exitReason="timeout"`
  // each accompanied by the duplicate loud event.)
  exitReason: WriterExitReason;
}

// recordAnswererCost wraps the CostRecorder for the planner/checker/auditor (+
// triage/convergence/demoRun) call sites. The answerer adapter now SURFACES the
// most recent call's per-call token usage (`lastTokenUsage()`, parsed from the
// harness JSONL/stream-json), read here right after the awaited call (same adapter
// instance). So a REAL answerer call records its ACTUAL tokens → REAL notional cost
// (LiteLLM rates), INDEPENDENT of the codexbar/ccusage window probe. Token
// accounting is mandatory: a real call that surfaces NO telemetry (or all-zero) is
// genuine parser/adapter drift — recorded as the row (cost best-effort NULL) AND
// surfaced LOUDLY (`usage.token_accounting_failed`), distinct from a genuine
// zero-token call. A `fake` fixture is legitimately zero and stays quiet.
export async function recordAnswererCost<TOutput>(input: AnswererCostInput<TOutput>): Promise<void> {
  const tokenUsage = input.adapter.lastTokenUsage?.();
  // MANAGED OpenRouter run: query the REAL `usage.cost` for THIS answerer call's
  // generation id so cost_usd is a metered FACT (`provider_response`) — IDENTICAL to
  // recordWriterCost. Without this an answerer call (planner/checker/auditor/triage/
  // convergence/demoRun) on a metered key records a NULL-cost `per_token` row, which
  // the budget gate's fail-closed `unpriced_spend` pause trips on permanently when
  // ccusage cannot price the window. null on BYOK / no generation id (no estimate).
  const realProviderCostUsd = await captureRealProviderCostUsd(input.ctx, tokenUsage, input.taskId, input.adapter.cli);
  // FINALIZE GUARD (task #35): a throw from `recorder.record` (DB INSERT / RLS /
  // schema drift) is RE-RAISED as `CostRecordError` so the outer
  // `runStageBodyWithFinalizeGuard` classifies it deterministically as
  // `failureKind: "cost_record_failed"` — rather than landing in the fail-closed
  // `crashed` default and stranding the task row in `status='running'` forever.
  try {
    await input.ctx.recorder.record(
      {
        runId: input.ctx.runId,
        taskId: input.taskId,
        specId: input.ctx.specId,
        projectId: input.ctx.projectId,
        orgId: input.ctx.orgId,
        ...(input.issueLoopId === undefined ? {} : { issueLoopId: input.issueLoopId }),
        cli: input.adapter.cli,
        model: input.model,
        // The agent ROLE, on its OWN channel (→ `cost_source_raw.role`) instead of
        // smuggled through `model`. See AnswererCostInput.model.
        role: input.role,
        authRef: input.adapter.authRef,
        runtimeSeconds: input.runtimeSeconds,
        realProviderCostUsd,
      },
      tokenUsage ?? emptyTokenUsage,
      input.rawUsage,
    );
  } catch (error) {
    throw new CostRecordError(error);
  }
  // A REAL answerer call missing token telemetry (undefined / all-zero) is
  // mandatory-accounting drift — surface it LOUDLY, distinct from a genuine
  // zero-token call. A real call that DID surface tokens stays quiet (the working
  // path); a `fake` fixture is legitimately zero and stays quiet.
  if (isRealMissingTelemetry(input.adapter.cli, tokenUsage)) {
    await input.ctx.emitTokenAccountingFailed?.({
      role: input.role,
      cli: input.adapter.cli,
      model: input.model,
      taskId: input.taskId,
    });
  }
}

export async function recordWriterCost(input: WriterCostInput): Promise<void> {
  const tokens = input.tokenUsage ?? emptyTokenUsage;
  // MANAGED OpenRouter run: query the REAL `usage.cost` for this call's generation
  // id so cost_usd is a metered FACT (`provider_response`). null on BYOK / no id.
  const realProviderCostUsd = await captureRealProviderCostUsd(
    input.ctx,
    input.tokenUsage,
    input.taskId,
    input.adapter.cli,
  );
  // FINALIZE GUARD (task #35): see recordAnswererCost above — re-raise as
  // `CostRecordError` so the outer guard classifies as `cost_record_failed`.
  try {
    await input.ctx.recorder.record(
      {
        runId: input.ctx.runId,
        taskId: input.taskId,
        specId: input.ctx.specId,
        projectId: input.ctx.projectId,
        orgId: input.ctx.orgId,
        cli: input.adapter.cli,
        model: input.model,
        role: "writer",
        authRef: input.adapter.authRef,
        runtimeSeconds: input.runtimeSeconds,
        realProviderCostUsd,
      },
      tokens,
      input.rawUsage,
    );
  } catch (error) {
    throw new CostRecordError(error);
  }
  // A REAL writer call missing token telemetry looks like a zero-token call —
  // surface it LOUDLY, distinct from a genuine zero-token call. The discriminant
  // is exitReason:
  //
  //   - `completed` / `token_limit` (a turn that ACTUALLY FINISHED) with no
  //     usage on the row is genuine parser/adapter drift — codex's
  //     `turn.completed` arrived but carried no usage, or a future provider's
  //     stream did the same. That is the mandatory-accounting drift this loud
  //     event exists for; surface it.
  //
  //   - `timeout` / `crashed` / `window_exhausted` (TERMINATED mid-call — the
  //     watchdog stall, a crash, or the §4.3 window) was killed BEFORE
  //     `turn.completed` could carry usage. The call is already loud via
  //     `writer.subtask.failed` with the discriminated failureKind (emitted by
  //     runWriterStage). Emitting `usage.token_accounting_failed` here would
  //     double-classify the same underlying failure — pollution apex v50
  //     surfaced as 8 zero-token rows all `exitReason="timeout"` each
  //     accompanied by the duplicate loud event. The row itself stays
  //     NULL-loud (cost_basis='unknown' / billing_mode='unattributed' — the
  //     existing recorder path for an unattributable real call, unchanged);
  //     `writer.subtask.failed` is the sole loud signal for the terminated case.
  if (
    isRealMissingTelemetry(input.adapter.cli, input.tokenUsage) &&
    (input.exitReason === "completed" || input.exitReason === "token_limit")
  ) {
    await input.ctx.emitTokenAccountingFailed?.({
      role: "writer",
      cli: input.adapter.cli,
      model: input.model,
      taskId: input.taskId,
    });
  }
}

export function secondsSince(startedAtMs: number): number {
  const elapsed = (Date.now() - startedAtMs) / 1000;
  return elapsed > 0 ? elapsed : 0.001;
}

// buildSubtaskCostContext assembles the SubtaskCostContext for a run, wiring the
// two LOUD discriminated-failure event sinks over the loop's typed appendEvent:
// `usage.token_accounting_failed` (a real CLI call with no token telemetry) and
// `cost.provider_capture_failed` (a managed OpenRouter real-cost capture failure).
// Extracted from subtaskLoop.ts to keep that orchestration file under the 500-line
// cap; the appendEvent type is imported type-only (no runtime import cycle).
export function buildSubtaskCostContext(
  core: {
    recorder: CostRecorder;
    runId: string;
    specId: string;
    projectId: string;
    /** v68 fix: stamped on every derived cost-timeline event (NOT NULL on `events.org_id`). */
    orgId: string;
    captureRealProviderCost?: RealProviderCostCapturer;
  },
  appendEvent: AppendEvent,
): SubtaskCostContext {
  return {
    recorder: core.recorder,
    runId: core.runId,
    specId: core.specId,
    projectId: core.projectId,
    orgId: core.orgId,
    ...(core.captureRealProviderCost !== undefined && { captureRealProviderCost: core.captureRealProviderCost }),
    emitTokenAccountingFailed: async ({ role, cli, model, taskId }) => {
      await appendEvent(
        "usage.token_accounting_failed",
        {
          role,
          cli,
          model,
          reason:
            "a real CLI call recorded its cost with no token telemetry; token accounting is mandatory, so this is surfaced loudly rather than as a silent zero-token call",
        },
        taskId,
      );
    },
    // DRIFT: a wired capturer that never receives an id. One-shot per run.
    generationIdMissingReported: { reported: false },
    emitGenerationIdMissing: async ({ cli, taskId }) => {
      await appendEvent(
        "cost.generation_id_missing",
        {
          cli,
          reason:
            "a per-call real-cost capturer is wired for this run, but the harness surfaced no provider generation id on a real call, so the capture could not fire and cost_usd is NULL; surfaced loudly rather than silently reverting to unpriced spend (see docs/_design/openrouter-cost-attribution.md)",
        },
        taskId,
      );
    },
    emitProviderCaptureFailed: async ({ generationId, detail, taskId }) => {
      await appendEvent(
        "cost.provider_capture_failed",
        {
          generationId,
          detail,
          reason:
            "the managed OpenRouter per-call real-cost query failed; authoritative platform spend could not be captured, so it is surfaced loudly rather than silently recorded as $0",
        },
        taskId,
      );
    },
  };
}
