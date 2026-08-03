import { describe, expect, it, vi } from "vitest";
import type { CostRecorder } from "../src/engine/costs/index.js";
import type { ProviderCostCapture } from "../src/engine/costs/generationCostCapture.js";
import {
  recordAnswererCost,
  recordWriterCost,
  secondsSince,
  type SubtaskCostContext,
  type TokenAccountingRole,
} from "../src/engine/workflow/subtaskCost.js";
import {
  emptyTokenUsage,
  type AnswererAdapter,
  type TokenUsage,
  type WriterAdapter,
} from "../src/engine/providers/types.js";

// Capture loud usage.token_accounting_failed emissions for the assertions below.
interface AccountingFailure {
  role: TokenAccountingRole;
  cli: string;
  model: string;
  taskId: string;
}

// subtaskCost.ts owns the cost-record context every planner/checker/auditor/
// writer call funnels through. The mutation survivors were that the recorded
// payload values (cli, model, authRef, runtimeSeconds, the disjoint token
// breakdown) and the secondsSince clamping math were never asserted. A fake
// CostRecorder captures exactly what is persisted so a mutated field/literal
// shows up as a failing assertion.

interface RecordCall {
  context: Record<string, unknown>;
  tokens: TokenUsage;
  rawUsage: Record<string, unknown>;
}

function recordingRecorder(): { recorder: CostRecorder; calls: RecordCall[] } {
  const calls: RecordCall[] = [];
  const recorder = {
    async record(context: Record<string, unknown>, tokens: TokenUsage, rawUsage: Record<string, unknown>) {
      calls.push({ context, tokens, rawUsage });
      return undefined as never;
    },
  } as unknown as CostRecorder;
  return { recorder, calls };
}

function ctx(recorder: CostRecorder, accountingFailures?: AccountingFailure[]): SubtaskCostContext {
  return {
    recorder,
    runId: "run_1",
    specId: "spec_1",
    projectId: "proj_1",
    orgId: "org_1",
    ...(accountingFailures !== undefined && {
      emitTokenAccountingFailed: async (input) => {
        accountingFailures.push(input);
      },
    }),
  };
}

const answererAdapter: AnswererAdapter<unknown> = {
  kind: "answerer",
  cli: "codex",
  authRef: "vault://codex/key",
  async runAnswerer() {
    return {};
  },
};

// A real codex answerer whose most-recent call surfaced token telemetry — the
// WORKING per-call accounting path: real tokens recorded, NO loud event.
function answererWithTelemetry(tokenUsage: TokenUsage): AnswererAdapter<unknown> {
  return { ...answererAdapter, lastTokenUsage: () => tokenUsage };
}

const writerAdapter: WriterAdapter = {
  kind: "writer",
  cli: "claude",
  authRef: "vault://claude/key",
  // The REAL model id, replacing the former hardcoded `"tanren-writer"` pseudo-id
  // (which no price source could look up, so notional was NULL on every writer row).
  model: "claude-opus-4",
  async runWriter() {
    return { diff: "", commits: [], exitReason: "completed" };
  },
};

describe("recordAnswererCost", () => {
  it("WORKING PATH: records the answerer's REAL per-call tokens (lastTokenUsage) + cli/authRef/model/runtime, NO loud event", async () => {
    const { recorder, calls } = recordingRecorder();
    const failures: AccountingFailure[] = [];
    const tokenUsage: TokenUsage = {
      inputTokens: 1200,
      cachedInputTokens: 300,
      cacheCreationTokens: 0,
      outputTokens: 400,
      reasoningOutputTokens: 100,
      totalTokens: 2000,
    };
    await recordAnswererCost({
      ctx: ctx(recorder, failures),
      adapter: answererWithTelemetry(tokenUsage),
      role: "planner",
      taskId: "task_planner",
      model: "tanren-planner",
      runtimeSeconds: 4.5,
      rawUsage: { role: "planner" },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.context).toMatchObject({
      runId: "run_1",
      taskId: "task_planner",
      specId: "spec_1",
      projectId: "proj_1",
      cli: "codex",
      model: "tanren-planner",
      authRef: "vault://codex/key",
      runtimeSeconds: 4.5,
    });
    // The REAL per-call token breakdown is recorded → REAL notional cost downstream.
    expect(call.tokens).toEqual(tokenUsage);
    expect(call.rawUsage).toEqual({ role: "planner" });
    // A real call that DID surface tokens is the normal working case — NOT loud.
    expect(failures).toEqual([]);
  });

  it("LOUD: a REAL answerer call with NO token telemetry (lastTokenUsage undefined) records zero AND emits usage.token_accounting_failed", async () => {
    const { recorder, calls } = recordingRecorder();
    const failures: AccountingFailure[] = [];
    await recordAnswererCost({
      ctx: ctx(recorder, failures),
      // answererAdapter has no lastTokenUsage → genuine telemetry breakage.
      adapter: answererAdapter,
      role: "auditor",
      taskId: "task_audit",
      model: "tanren-auditor",
      runtimeSeconds: 1,
      rawUsage: {},
    });
    // No telemetry → the empty (all-zero) usage row, surfaced LOUDLY (not a silent $0).
    expect(calls[0]!.tokens).toEqual(emptyTokenUsage);
    expect(failures).toEqual([{ role: "auditor", cli: "codex", model: "tanren-auditor", taskId: "task_audit" }]);
  });

  it("LOUD: a REAL answerer call whose telemetry is ALL-ZERO is treated as missing → token_accounting_failed", async () => {
    const { recorder } = recordingRecorder();
    const failures: AccountingFailure[] = [];
    await recordAnswererCost({
      ctx: ctx(recorder, failures),
      adapter: answererWithTelemetry(emptyTokenUsage),
      role: "checker",
      taskId: "task_check",
      model: "tanren-checker",
      runtimeSeconds: 1,
      rawUsage: {},
    });
    expect(failures).toEqual([{ role: "checker", cli: "codex", model: "tanren-checker", taskId: "task_check" }]);
  });

  it("QUIET: a FAKE-fixture answerer (legitimate zero) does NOT emit token_accounting_failed", async () => {
    const { recorder } = recordingRecorder();
    const failures: AccountingFailure[] = [];
    await recordAnswererCost({
      ctx: ctx(recorder, failures),
      adapter: { ...answererAdapter, cli: "fake" },
      role: "checker",
      taskId: "task_check",
      model: "tanren-checker",
      runtimeSeconds: 1,
      rawUsage: {},
    });
    expect(failures).toEqual([]);
  });

  it("captures the REAL provider cost for a MANAGED answerer call carrying an OpenRouter generation id (audit §3.7b)", async () => {
    // The fix: a managed answerer call (planner/checker/auditor/triage/convergence/demoRun)
    // must capture its REAL per-call usage.cost EXACTLY like the writer — otherwise it
    // records a NULL-cost per_token row and the budget gate's fail-closed unpriced_spend
    // pause fires mid-run (potentially permanently). lastTokenUsage carries the generation
    // id; a wired capturer resolves the metered FACT → realProviderCostUsd on the row.
    const { recorder, calls } = recordingRecorder();
    const captured: string[] = [];
    const capturer = async (generationId: string): Promise<ProviderCostCapture> => {
      captured.push(generationId);
      return { cost: 0.0199 };
    };
    await recordAnswererCost({
      ctx: { ...ctx(recorder), captureRealProviderCost: capturer },
      adapter: answererWithTelemetry({
        ...emptyTokenUsage,
        inputTokens: 1,
        totalTokens: 1,
        openRouterGenerationId: "gen-ans-1",
      }),
      role: "planner",
      taskId: "task_planner",
      model: "tanren-planner",
      runtimeSeconds: 2,
      rawUsage: {},
    });
    expect(captured).toEqual(["gen-ans-1"]);
    // The captured real cost is on the recorded row → cost_basis 'provider_response'
    // downstream (NOT a NULL-cost per_token row that trips the unpriced_spend pause).
    expect(calls[0]!.context).toMatchObject({ realProviderCostUsd: 0.0199 });
  });

  it("a managed answerer capture FAILURE emits cost.provider_capture_failed + records null cost (audit §3.7b)", async () => {
    const { recorder, calls } = recordingRecorder();
    const captureFailures: { generationId: string; detail: string; taskId: string }[] = [];
    await recordAnswererCost({
      ctx: {
        ...ctx(recorder),
        captureRealProviderCost: async (generationId): Promise<ProviderCostCapture> => ({
          failed: { generationId, detail: "503 upstream" },
        }),
        emitProviderCaptureFailed: async (input) => {
          captureFailures.push(input);
        },
      },
      adapter: answererWithTelemetry({
        ...emptyTokenUsage,
        inputTokens: 1,
        totalTokens: 1,
        openRouterGenerationId: "gen-ans-fail",
      }),
      role: "auditor",
      taskId: "task_audit",
      model: "tanren-auditor",
      runtimeSeconds: 1,
      rawUsage: {},
    });
    expect(captureFailures).toEqual([{ generationId: "gen-ans-fail", detail: "503 upstream", taskId: "task_audit" }]);
    expect(calls[0]!.context).toMatchObject({ realProviderCostUsd: null });
  });
});

describe("recordWriterCost", () => {
  it("records the writer's reported token usage, the REAL model id, and the role on its own field", async () => {
    const { recorder, calls } = recordingRecorder();
    const tokenUsage: TokenUsage = {
      inputTokens: 100,
      cachedInputTokens: 10,
      cacheCreationTokens: 5,
      outputTokens: 50,
      reasoningOutputTokens: 20,
      totalTokens: 185,
    };
    await recordWriterCost({
      ctx: ctx(recorder),
      adapter: writerAdapter,
      model: writerAdapter.model ?? "",
      taskId: "task_write",
      runtimeSeconds: 12,
      tokenUsage,
      rawUsage: { role: "writer" },
      exitReason: "completed",
    });

    const call = calls[0]!;
    expect(call.context).toMatchObject({
      taskId: "task_write",
      cli: "claude",
      // The REAL model id (not the old `"tanren-writer"` pseudo-id) plus the role on
      // its OWN field (→ cost_source_raw.role) — together they restore the notional
      // axis, since a real id is a key the LiteLLM price source can look up.
      model: "claude-opus-4",
      role: "writer",
      authRef: "vault://claude/key",
      runtimeSeconds: 12,
    });
    expect(call.tokens).toBe(tokenUsage);
  });

  it("falls back to the empty token usage AND emits a LOUD token_accounting_failed when a COMPLETED writer reports none", async () => {
    const { recorder, calls } = recordingRecorder();
    const failures: AccountingFailure[] = [];
    await recordWriterCost({
      ctx: ctx(recorder, failures),
      adapter: writerAdapter,
      model: writerAdapter.model ?? "",
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: undefined,
      rawUsage: {},
      // exitReason="completed": the turn FINISHED but carried no usage — genuine
      // parser/adapter drift, the case the loud event exists for.
      exitReason: "completed",
    });
    expect(calls[0]!.tokens).toEqual(emptyTokenUsage);
    // A REAL writer call missing telemetry is surfaced loudly, NOT a silent zero-token row.
    expect(failures).toEqual([{ role: "writer", cli: "claude", model: "claude-opus-4", taskId: "task_write" }]);
  });

  it("captures the REAL provider cost for a managed call carrying an OpenRouter generation id", async () => {
    // A managed run surfaced an openRouterGenerationId on the writer's token usage and
    // wired a capturer → the recorder context carries the captured real FACT, so
    // cost_usd becomes a metered figure (provider_response) downstream.
    const { recorder, calls } = recordingRecorder();
    const captured: string[] = [];
    const capturer = async (generationId: string): Promise<ProviderCostCapture> => {
      captured.push(generationId);
      return { cost: 0.0321 };
    };
    await recordWriterCost({
      ctx: { ...ctx(recorder), captureRealProviderCost: capturer },
      adapter: writerAdapter,
      model: writerAdapter.model ?? "",
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: { ...emptyTokenUsage, inputTokens: 1, totalTokens: 1, openRouterGenerationId: "gen-abc123" },
      rawUsage: {},
      exitReason: "completed",
    });
    expect(captured).toEqual(["gen-abc123"]);
    expect(calls[0]!.context).toMatchObject({ realProviderCostUsd: 0.0321 });
  });

  it("LOUD: a managed capture FAILURE emits cost.provider_capture_failed and records null cost", async () => {
    const { recorder, calls } = recordingRecorder();
    const captureFailures: { generationId: string; detail: string; taskId: string }[] = [];
    await recordWriterCost({
      ctx: {
        ...ctx(recorder),
        captureRealProviderCost: async (generationId): Promise<ProviderCostCapture> => ({
          failed: { generationId, detail: "boom 500" },
        }),
        emitProviderCaptureFailed: async (input) => {
          captureFailures.push(input);
        },
      },
      adapter: writerAdapter,
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: { ...emptyTokenUsage, inputTokens: 1, totalTokens: 1, openRouterGenerationId: "gen-fail" },
      rawUsage: {},
      exitReason: "completed",
    });
    // Authoritative platform spend could not be captured → surfaced loudly, cost null.
    expect(captureFailures).toEqual([{ generationId: "gen-fail", detail: "boom 500", taskId: "task_write" }]);
    expect(calls[0]!.context).toMatchObject({ realProviderCostUsd: null });
  });

  it("does NOT capture (real cost null) when no generation id is present, even with a capturer wired", async () => {
    const { recorder, calls } = recordingRecorder();
    const capturer = vi.fn<(generationId: string) => Promise<ProviderCostCapture>>(async () => ({ cost: 0.5 }));
    await recordWriterCost({
      ctx: { ...ctx(recorder), captureRealProviderCost: capturer },
      adapter: writerAdapter,
      model: writerAdapter.model ?? "",
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: { ...emptyTokenUsage, inputTokens: 1, totalTokens: 1 },
      rawUsage: {},
      exitReason: "completed",
    });
    expect(capturer).not.toHaveBeenCalled();
    expect(calls[0]!.context).toMatchObject({ realProviderCostUsd: null });
  });

  it("does NOT capture when a generation id is present but NO capturer is wired (BYOK / non-managed)", async () => {
    const { recorder, calls } = recordingRecorder();
    await recordWriterCost({
      ctx: ctx(recorder),
      adapter: writerAdapter,
      model: writerAdapter.model ?? "",
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: { ...emptyTokenUsage, inputTokens: 1, totalTokens: 1, openRouterGenerationId: "gen-xyz" },
      rawUsage: {},
      exitReason: "completed",
    });
    expect(calls[0]!.context).toMatchObject({ realProviderCostUsd: null });
  });
});

describe("recordWriterCost - apex v50 exit-reason gating (task #14)", () => {
  // The doctrine: `usage.token_accounting_failed` is for parser/adapter drift on
  // a COMPLETED writer call that surfaced no usage. A writer TERMINATED mid-call
  // (watchdog stall / crash / window) was killed BEFORE turn.completed could
  // carry usage — already loud via `writer.subtask.failed`. Double-emit
  // double-classifies the same failure (apex v50: 8 zero-token rows all
  // exitReason="timeout" each accompanied by the duplicate loud event). The
  // row itself is still recorded NULL-loud (unattributable downstream).
  async function runCase(exitReason: "completed" | "token_limit" | "timeout" | "crashed" | "window_exhausted") {
    const { recorder, calls } = recordingRecorder();
    const failures: AccountingFailure[] = [];
    await recordWriterCost({
      ctx: ctx(recorder, failures),
      // codex is a REAL CLI; isRealMissingTelemetry trips on the undefined usage.
      adapter: { ...writerAdapter, cli: "codex", model: "openai/gpt-5.6-luna" },
      // The OpenRouter-namespaced id a codex-through-OpenRouter run really sends.
      model: "openai/gpt-5.6-luna",
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: undefined,
      rawUsage: {},
      exitReason,
    });
    return { calls, failures };
  }

  it.each<"completed" | "token_limit">(["completed", "token_limit"])(
    "LOUD-FAILED: %s writer with no telemetry STILL emits token_accounting_failed (genuine parser/adapter drift)",
    async (exitReason) => {
      const { calls, failures } = await runCase(exitReason);
      expect(failures).toEqual([{ role: "writer", cli: "codex", model: "openai/gpt-5.6-luna", taskId: "task_write" }]);
      // The row is still recorded (empty usage → NULL-loud downstream).
      expect(calls).toHaveLength(1);
      expect(calls[0]!.tokens).toEqual(emptyTokenUsage);
    },
  );

  it.each<"timeout" | "crashed" | "window_exhausted">(["timeout", "crashed", "window_exhausted"])(
    "QUIET-FAILED: a %s writer with no telemetry does NOT emit token_accounting_failed (already loud via writer.subtask.failed)",
    async (exitReason) => {
      const { calls, failures } = await runCase(exitReason);
      // No double-emit (apex v50 fix B1).
      expect(failures).toEqual([]);
      // The cost row IS still recorded — work consumed real tokens regardless;
      // the row lands NULL-loud (empty usage → unattributable). Cost is fact.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.tokens).toEqual(emptyTokenUsage);
    },
  );

  it("QUIET: a FAKE-fixture writer (legitimate zero) stays quiet regardless of exitReason (isRealCli gate unchanged)", async () => {
    const { recorder } = recordingRecorder();
    const failures: AccountingFailure[] = [];
    await recordWriterCost({
      ctx: ctx(recorder, failures),
      adapter: { ...writerAdapter, cli: "fake" },
      model: writerAdapter.model ?? "",
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: undefined,
      rawUsage: {},
      exitReason: "completed",
    });
    expect(failures).toEqual([]);
  });
});

describe("secondsSince", () => {
  it("returns the elapsed seconds for a past start time", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      // 3000ms earlier -> exactly 3 seconds.
      expect(secondsSince(now - 3000)).toBeCloseTo(3, 5);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("clamps a non-positive elapsed to the 0.001 floor (never zero/negative)", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      // Same instant -> elapsed 0, which must be floored, not returned as 0.
      expect(secondsSince(now)).toBe(0.001);
      // Future start -> negative elapsed, also floored.
      expect(secondsSince(now + 5000)).toBe(0.001);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
