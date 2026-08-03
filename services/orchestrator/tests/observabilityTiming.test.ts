// observability: unit tests for the boundary timing layer — the
// `timed()` helper, the stage-timing emitter, and the SSH / GitHub / provider
// decorators. These prove the layer measures latency and emits structured
// records WITHOUT changing the wrapped behavior or leaking secrets.
import { describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { defineFailure } from "../src/engine/failure.js";
import {
  emitStageTiming,
  TimedGitHubHttpClient,
  TimedCommandSubstrate,
  templatizePath,
  timed,
  timedAnswererAdapter,
  timedWriterAdapter,
  type TimingRecord,
} from "../src/engine/observability/index.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import {
  emptyTokenUsage,
  type AnswererAdapter,
  type WriterAdapter,
  type WriterResult,
} from "../src/engine/providers/types.js";

function captureSink() {
  const records: TimingRecord[] = [];
  return { records, sink: (record: TimingRecord) => records.push(record) };
}

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner",
  identitySecretRef: "runner/identity",
};

describe("timed() boundary helper", () => {
  it("emits one ok record carrying the boundary/operation/duration and returns the value", async () => {
    const { records, sink } = captureSink();
    let t = 100;
    const result = await timed({ boundary: "ssh", operation: "op", sink, now: () => (t += 5) }, async () => "value");
    expect(result).toBe("value");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "timing",
      boundary: "ssh",
      operation: "op",
      outcome: "ok",
      durationMs: 5,
    });
    expect(typeof records[0]?.timestamp).toBe("string");
  });

  it("emits an error record and re-throws the original error", async () => {
    const { records, sink } = captureSink();
    const boom = new Error("boom");
    await expect(
      timed({ boundary: "github", operation: "op", sink }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(records[0]).toMatchObject({ outcome: "error", boundary: "github" });
  });

  it("never lets a throwing sink break the wrapped operation", async () => {
    const result = await timed(
      {
        boundary: "provider",
        operation: "op",
        sink: () => {
          throw new Error("sink down");
        },
      },
      async () => 42,
    );
    expect(result).toBe(42);
  });
});

describe("emitStageTiming", () => {
  it("emits a workflow-stage record with the stage name and rounded duration", () => {
    const { records, sink } = captureSink();
    emitStageTiming("plan", 12.3456, { runId: "run_1" }, sink);
    expect(records[0]).toMatchObject({
      boundary: "workflow-stage",
      operation: "plan",
      durationMs: 12.346,
      outcome: "ok",
    });
    expect(records[0]?.attributes).toEqual({ runId: "run_1" });
  });

  it("clamps negative durations to zero", () => {
    const { records, sink } = captureSink();
    emitStageTiming("write", -1, undefined, sink);
    expect(records[0]?.durationMs).toBe(0);
  });
});

describe("templatizePath", () => {
  it("collapses numeric ids, SHAs, and query strings to bounded-cardinality templates", () => {
    expect(templatizePath("/repos/acme/widget/pulls/42")).toBe("/repos/acme/widget/pulls/:id");
    expect(templatizePath("/repos/acme/widget/commits/0123456789abcdef0123456789abcdef01234567/status")).toBe(
      "/repos/acme/widget/commits/:sha/status",
    );
    expect(templatizePath("/repos/acme/widget/pulls?state=open&head=acme:feat")).toBe("/repos/acme/widget/pulls");
  });
});

describe("TimedCommandSubstrate", () => {
  it("delegates to the inner substrate and emits secret-free SSH timing (no command/stdin)", async () => {
    const { records, sink } = captureSink();
    const inner: CommandSubstrate = {
      run: async (_t: RunnerHandle, _c: RunnerCommand): Promise<CommandResult> => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        timedOut: false,
      }),
    };
    const wrapped = new TimedCommandSubstrate(inner, sink);
    const result = await wrapped.run(target, {
      command: "echo SECRET_TOKEN_xyz",
      stdin: "SECRET",
      timeoutMs: 1000,
    });
    expect(result.stdout).toBe("ok");
    const run = records.find((r) => r.operation === "ssh.run");
    // Backend-neutral telemetry: the opaque handle's `backend` tag plus the SSH
    // backend's (non-secret) host/port/username reach fields.
    expect(run?.attributes).toEqual({ backend: "ssh", host: "runner", port: 22, username: "tanren" });
    // The command string and stdin must never appear in any emitted record.
    expect(JSON.stringify(records)).not.toContain("SECRET");
  });

  it("emits an extra error record when the substrate reports an in-band failure", async () => {
    const { records, sink } = captureSink();
    const inner: CommandSubstrate = {
      run: async (): Promise<CommandResult> => ({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: true,
        failure: defineFailure({ kind: "ssh_failed", target: "runner", message: "x" }),
      }),
    };
    await new TimedCommandSubstrate(inner, sink).run(target, { command: "x", timeoutMs: 10 });
    expect(records.some((r) => r.operation === "ssh.run.failed" && r.outcome === "error")).toBe(true);
  });
});

describe("TimedGitHubHttpClient", () => {
  it("delegates and emits request+response records with method/path/status, never the token", async () => {
    const { records, sink } = captureSink();
    const inner: GitHubHttpClient = {
      request: async (_input: GitHubHttpRequest): Promise<GitHubHttpResponse> => ({
        status: 200,
        body: { ok: true },
      }),
    };
    const wrapped = new TimedGitHubHttpClient(inner, sink);
    const response = await wrapped.request({
      method: "GET",
      path: "/repos/acme/widget/pulls/7",
      token: "ghs_supersecret",
    });
    expect(response.status).toBe(200);
    const resp = records.find((r) => r.operation === "github.response");
    expect(resp?.attributes).toMatchObject({
      method: "GET",
      path: "/repos/acme/widget/pulls/:id",
      status: 200,
      rateLimited: false,
    });
    expect(JSON.stringify(records)).not.toContain("ghs_supersecret");
  });

  it("flags a 429 as rate-limited and marks the response record as an error", async () => {
    const { records, sink } = captureSink();
    const inner: GitHubHttpClient = {
      request: async (): Promise<GitHubHttpResponse> => ({ status: 429, body: undefined }),
    };
    await new TimedGitHubHttpClient(inner, sink).request({
      method: "POST",
      path: "/repos/a/b/pulls",
      token: "t",
    });
    const resp = records.find((r) => r.operation === "github.response");
    expect(resp?.attributes?.rateLimited).toBe(true);
    expect(resp?.outcome).toBe("error");
  });
});

describe("provider adapter timing wrappers", () => {
  it("times a writer call and preserves the result and adapter metadata", async () => {
    const { records, sink } = captureSink();
    const writerResult: WriterResult = {
      diff: "d",
      commits: [],
      exitReason: "completed",
      tokenUsage: emptyTokenUsage,
    };
    const inner: WriterAdapter = {
      kind: "writer",
      cli: "codex",
      authRef: "credential/codex",
      runWriter: vi.fn<() => Promise<WriterResult>>(async () => writerResult),
    };
    const wrapped = timedWriterAdapter(inner, sink);
    expect(wrapped.cli).toBe("codex");
    const out = await wrapped.runWriter({ prompt: "p", workspace: "/ws", timeoutMs: 1 });
    expect(out).toBe(writerResult);
    expect(records[0]).toMatchObject({
      boundary: "provider",
      operation: "provider.write",
      attributes: { cli: "codex", role: "writer" },
    });
  });

  it("times an answerer call with the supplied role dimension", async () => {
    const { records, sink } = captureSink();
    const inner: AnswererAdapter<{ ok: boolean }> = {
      kind: "answerer",
      cli: "claude",
      authRef: "credential/claude",
      runAnswerer: async () => ({ ok: true }),
    };
    const out = await timedAnswererAdapter(inner, "checker", sink).runAnswerer({
      prompt: "p",
      timeoutMs: 1,
      outputSchema: { name: "x", jsonSchema: {}, parse: (v) => v as { ok: boolean } },
    });
    expect(out).toEqual({ ok: true });
    expect(records[0]).toMatchObject({
      operation: "provider.answer",
      attributes: { cli: "claude", role: "checker" },
    });
  });

  // The timing decorator is the instance `buildWriterAdapter`/`buildAnswererAdapter`
  // hand the loop, so it is the object the cost recorder reads `model` off
  // (`args.adapter.model ?? ""` → `cost_records.model`). Dropping the field here
  // blanked the recorded model for EVERY production call — and a blank model makes
  // the notional price lookup unresolvable. An adapter that declares NO model (a
  // fake fixture) must stay absent, never become a `undefined`-valued key.
  it("forwards the wrapped adapter's real model id (the cost_records.model value)", async () => {
    const { sink } = captureSink();
    const writerResult: WriterResult = { diff: "d", commits: [], exitReason: "completed", tokenUsage: emptyTokenUsage };
    const writer = timedWriterAdapter(
      {
        kind: "writer",
        cli: "codex",
        authRef: "credential/openrouter/platform/default",
        model: "openai/gpt-5.6-luna",
        runWriter: async () => writerResult,
      },
      sink,
    );
    expect(writer.model).toBe("openai/gpt-5.6-luna");

    const answerer = timedAnswererAdapter<{ ok: boolean }>(
      {
        kind: "answerer",
        cli: "codex",
        authRef: "credential/openrouter/platform/default",
        model: "openai/gpt-5.6-luna",
        runAnswerer: async () => ({ ok: true }),
      },
      "auditor",
      sink,
    );
    expect(answerer.model).toBe("openai/gpt-5.6-luna");

    const withoutModel = timedWriterAdapter(
      { kind: "writer", cli: "fake", authRef: "credential/fake", runWriter: async () => writerResult },
      sink,
    );
    expect(withoutModel.model).toBeUndefined();
    expect(Object.hasOwn(withoutModel, "model")).toBe(false);
  });
});
