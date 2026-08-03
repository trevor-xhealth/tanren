// cspell:ignore unmeterable meterable PQEF Twnkf
// DRIFT DETECTION for the per-call real-cost capture, split out of
// subtaskCost.test.ts to keep that file under the 500-line architecture cap.
//
// `captureRealProviderCostUsd` used to `return null` unconditionally and silently
// when the adapter surfaced no generation id. That silence IS the failure mode
// docs/_design/openrouter-cost-attribution.md is about: a route judged meterable
// (a capturer is wired) whose harness drops the upstream envelope reverts every
// row to NULL cost with nothing in the timeline to say so. It is now loud —
// latched to once per run so the signal is legible rather than one event per call
// (the run's standing posture is narrated separately by `cost.route_unmeterable`).
// The `buildSubtaskCostContext` wiring assertions travel with it (the builder is
// what provisions the sink + the latch).
import { describe, expect, it } from "vitest";
import type { CostRecorder } from "../src/engine/costs/index.js";
import type { ProviderCostCapture } from "../src/engine/costs/generationCostCapture.js";
import {
  buildSubtaskCostContext,
  recordWriterCost,
  type SubtaskCostContext,
} from "../src/engine/workflow/subtaskCost.js";
import type { AppendEvent } from "../src/engine/workflow/subtaskLoop.js";
import { emptyTokenUsage, type TokenUsage, type WriterAdapter } from "../src/engine/providers/types.js";

// A module-scope capturer (identity-stable) for the threading assertion.
const sharedCapturer = async (): Promise<ProviderCostCapture> => ({ cost: 1 });

interface RecordCall {
  context: Record<string, unknown>;
  tokens: TokenUsage;
}

function recordingRecorder(): { recorder: CostRecorder; calls: RecordCall[] } {
  const calls: RecordCall[] = [];
  const recorder = {
    async record(context: Record<string, unknown>, tokens: TokenUsage) {
      calls.push({ context, tokens });
      return undefined as never;
    },
  } as unknown as CostRecorder;
  return { recorder, calls };
}

// A real codex writer over an OpenRouter key — the deployment in question.
const codexWriter: WriterAdapter = {
  kind: "writer",
  cli: "codex",
  authRef: "credential/openrouter/acme/default",
  model: "openai/gpt-5.6-luna",
  async runWriter() {
    return { diff: "", commits: [], exitReason: "completed" };
  },
};

describe("captureRealProviderCostUsd — a wired capturer that never receives an id", () => {
  it("emits cost.generation_id_missing ONCE per run, and still records every row honestly", async () => {
    const { recorder, calls } = recordingRecorder();
    const missing: Array<{ cli: string; taskId: string }> = [];
    // One SHARED per-run context, exactly as buildSubtaskCostContext produces.
    const shared: SubtaskCostContext = {
      recorder,
      runId: "run_1",
      specId: "spec_1",
      projectId: "proj_1",
      orgId: "org_1",
      // A capturer IS wired — it would return a real figure if it were ever called.
      captureRealProviderCost: async (): Promise<ProviderCostCapture> => ({ cost: 5 }),
      generationIdMissingReported: { reported: false },
      emitGenerationIdMissing: async (input) => {
        missing.push(input);
      },
    };
    for (const taskId of ["task_write_1", "task_write_2", "task_write_3"]) {
      await recordWriterCost({
        ctx: shared,
        adapter: codexWriter,
        model: codexWriter.model ?? "",
        taskId,
        runtimeSeconds: 1,
        // Real tokens, NO generation id — exactly what `codex exec --json` produces.
        tokenUsage: { ...emptyTokenUsage, inputTokens: 10, totalTokens: 10 },
        rawUsage: {},
        exitReason: "completed",
      });
    }
    // Loud ONCE, naming the harness — not once per call.
    expect(missing).toEqual([{ cli: "codex", taskId: "task_write_1" }]);
    expect(shared.generationIdMissingReported).toEqual({ reported: true });
    // Every row still records, with NO cost invented from the unreachable capturer.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.context).toMatchObject({ realProviderCostUsd: null, role: "writer" });
      expect(call.tokens.totalTokens).toBe(10);
    }
  });

  it("stays silent when NO capturer is wired (there was nothing to drift from)", async () => {
    const { recorder, calls } = recordingRecorder();
    const missing: Array<{ cli: string; taskId: string }> = [];
    await recordWriterCost({
      ctx: {
        recorder,
        runId: "run_1",
        specId: "spec_1",
        projectId: "proj_1",
        orgId: "org_1",
        generationIdMissingReported: { reported: false },
        emitGenerationIdMissing: async (input) => {
          missing.push(input);
        },
      },
      adapter: codexWriter,
      model: codexWriter.model ?? "",
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: { ...emptyTokenUsage, inputTokens: 10, totalTokens: 10 },
      rawUsage: {},
      exitReason: "completed",
    });
    expect(missing).toEqual([]);
    expect(calls[0]?.context).toMatchObject({ realProviderCostUsd: null });
  });

  it("stays silent when the id IS present (the working path)", async () => {
    const { recorder, calls } = recordingRecorder();
    const missing: Array<{ cli: string; taskId: string }> = [];
    await recordWriterCost({
      ctx: {
        recorder,
        runId: "run_1",
        specId: "spec_1",
        projectId: "proj_1",
        orgId: "org_1",
        captureRealProviderCost: async (): Promise<ProviderCostCapture> => ({ cost: 0.0011782784 }),
        generationIdMissingReported: { reported: false },
        emitGenerationIdMissing: async (input) => {
          missing.push(input);
        },
      },
      adapter: codexWriter,
      model: codexWriter.model ?? "",
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: {
        ...emptyTokenUsage,
        inputTokens: 10,
        totalTokens: 10,
        openRouterGenerationId: "gen-1785730085-ifPQEF4jf7RVwCvTwnkf",
      },
      rawUsage: {},
      exitReason: "completed",
    });
    expect(missing).toEqual([]);
    // The captured figure IS the recorded real spend (cost_basis provider_response).
    expect(calls[0]?.context).toMatchObject({ realProviderCostUsd: 0.0011782784 });
  });
});
describe("buildSubtaskCostContext", () => {
  it("wires both loud event sinks over the loop's appendEvent (token_accounting_failed + provider_capture_failed)", async () => {
    const { recorder } = recordingRecorder();
    const appended: Array<{ type: string; payload: Record<string, unknown>; taskId?: string }> = [];
    const appendEvent = (async (type, payload, taskId) => {
      appended.push({ type, payload: payload as Record<string, unknown>, taskId });
    }) as AppendEvent;
    const built = buildSubtaskCostContext(
      { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1" },
      appendEvent,
    );
    await built.emitTokenAccountingFailed?.({ role: "writer", cli: "claude", model: "claude-opus-4", taskId: "t1" });
    await built.emitProviderCaptureFailed?.({ generationId: "gen-1", detail: "boom", taskId: "t2" });
    await built.emitGenerationIdMissing?.({ cli: "codex", taskId: "t3" });
    expect(appended.map((a) => a.type)).toEqual([
      "usage.token_accounting_failed",
      "cost.provider_capture_failed",
      "cost.generation_id_missing",
    ]);
    expect(appended[0]).toMatchObject({ payload: { role: "writer", cli: "claude" }, taskId: "t1" });
    expect(appended[1]).toMatchObject({ payload: { generationId: "gen-1", detail: "boom" }, taskId: "t2" });
    expect(appended[2]).toMatchObject({ payload: { cli: "codex" }, taskId: "t3" });
    // The one-shot latch is provisioned unarmed by the builder.
    expect(built.generationIdMissingReported).toEqual({ reported: false });
  });

  it("threads the managed capturer through when supplied", () => {
    const { recorder } = recordingRecorder();
    const appendEvent = (async () => {}) as AppendEvent;
    const built = buildSubtaskCostContext(
      { recorder, runId: "r", specId: "s", projectId: "p", captureRealProviderCost: sharedCapturer },
      appendEvent,
    );
    expect(built.captureRealProviderCost).toBe(sharedCapturer);
  });
});
