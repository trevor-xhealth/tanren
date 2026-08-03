import { EventEmitter } from "node:events";
import type { Client, ClientChannel } from "ssh2";
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { SshCommandSubstrate } from "../src/engine/ssh/index.js";
import { RETAINED_HEAD_CHARS, RETAINED_TAIL_CHARS } from "../src/engine/ssh/boundedOutput.js";

// F-9 NEGATIVE CONTROL — unbounded stdout/stderr accumulation in the SSH substrate.
//
// The substrate used to fold EVERY byte of EVERY chunk into one JavaScript string
// (`state.stdout += chunk.toString("utf8")`) with no cap, no ring, no spill. A single
// gate step on a large monorepo emits hundreds of MB, so a handful of concurrent runs
// OOMs the control plane. These tests pin the replacement: an OPT-IN bounded HEAD+TAIL
// retention that (a) bounds what the orchestrator holds, (b) leaves the bytes every
// downstream consumer actually reads byte-identical, and (c) reports the elision
// OUT OF BAND so no synthetic marker is ever injected into a stream a consumer parses.
//
// These are behavior tests against the REAL SshCommandSubstrate driven by a
// controllable fake ssh2 client — no vi.mock anywhere.

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  identitySecretRef: "runner/run_1/identity",
};

// The bound the gate's own consumer reads (runGateTier.OUTPUT_TAIL_LIMIT). The retained
// tail MUST be at least this large and byte-identical to the unbounded stream's tail,
// otherwise the fix would silently change what the gate records.
const GATE_OUTPUT_TAIL_LIMIT = 4_000;

// A synthetic gate-step stream: distinct, newline-terminated lines so a line-oriented
// consumer can be checked for corruption. Each line is ~1 KiB; 64 Ki lines ≈ 64 MB — a
// conservative stand-in for the real "hundreds of MB" gate output.
const LINE_COUNT = 65_536;
const FILLER = "x".repeat(1_000);

function line(index: number): string {
  return `step-line ${index} ${FILLER}\n`;
}

interface Controllable {
  client: Client & EventEmitter;
  emitStdout: (text: string) => void;
  emitStderr: (text: string) => void;
  emitClose: (exitCode: number) => void;
}

// A fake ssh2 client that hands the substrate a stream we drive by hand. `onReady` runs
// once the substrate has wired its collectors, so the test can push the whole stream and
// close in one shot.
function createStreamingClient(drive: (io: Controllable) => void): Controllable {
  const emitter = new EventEmitter();
  const stderr = new EventEmitter();
  const stream = Object.assign(new EventEmitter(), { stderr, end: () => stream });
  const io: Controllable = {
    client: undefined as unknown as Client & EventEmitter,
    emitStdout: (text: string) => stream.emit("data", Buffer.from(text)),
    emitStderr: (text: string) => stderr.emit("data", Buffer.from(text)),
    emitClose: (exitCode: number) => {
      stream.emit("exit", exitCode);
      stream.emit("close");
    },
  };
  const client = Object.assign(emitter, {
    connect: () => {
      queueMicrotask(() => emitter.emit("ready"));
      return client;
    },
    destroy: () => client,
    end: () => client,
    exec: (_command: string, callback: (error: Error | undefined, channel: ClientChannel) => void) => {
      queueMicrotask(() => {
        callback(undefined, stream as unknown as ClientChannel);
        queueMicrotask(() => drive(io));
      });
      return client;
    },
  });
  io.client = client as unknown as Client & EventEmitter;
  return io;
}

async function runStream(
  retention: "full" | "bounded" | undefined,
  drive: (io: Controllable) => void,
): Promise<{ stdout: string; stderr: string; stdoutElidedChars?: number; stderrElidedChars?: number }> {
  const io = createStreamingClient(drive);
  const secrets = new FakeSecretStore();
  await secrets.put({ ref: target.identitySecretRef, value: "private-key" });
  const substrate = new SshCommandSubstrate(secrets, { clientFactory: () => io.client });
  const result = await substrate.run(target, {
    command: "just ci",
    ...(retention === undefined ? {} : { outputRetention: retention }),
  });
  return result;
}

// The exact bytes an UNBOUNDED substrate would have produced, built once and memoized
// (it is ~64 MB — rebuilding it per assertion would dwarf the thing under test).
let fullStreamCache: string | undefined;
function fullStream(): string {
  if (fullStreamCache === undefined) {
    const parts: string[] = [];
    for (let i = 0; i < LINE_COUNT; i += 1) {
      parts.push(line(i));
    }
    fullStreamCache = parts.join("");
  }
  return fullStreamCache;
}

describe("F-9: bounded stdout/stderr retention in the SSH substrate", () => {
  it("BOUNDS what the orchestrator retains for a hundreds-of-MB gate step", async () => {
    const result = await runStream("bounded", (io) => {
      for (let i = 0; i < LINE_COUNT; i += 1) {
        io.emitStdout(line(i));
      }
      io.emitClose(0);
    });

    const emittedChars = fullStream().length;
    // The unfixed substrate retains EVERY byte — ~64 MB in one JS string, per command.
    expect(emittedChars).toBeGreaterThan(60_000_000);
    // The fixed substrate retains only head + tail (plus at most one line of slack from
    // the line-boundary cut), independent of how much the step emitted.
    expect(result.stdout.length).toBeLessThanOrEqual(RETAINED_HEAD_CHARS + RETAINED_TAIL_CHARS);
    // Sanity: the bound is a real reduction, not a no-op.
    expect(result.stdout.length).toBeLessThan(emittedChars / 50);
  });

  it("leaves the bytes downstream ACTUALLY reads (the gate's 4 000-char tail) byte-identical", async () => {
    const result = await runStream("bounded", (io) => {
      for (let i = 0; i < LINE_COUNT; i += 1) {
        io.emitStdout(line(i));
      }
      io.emitClose(0);
    });

    const full = fullStream();
    // runGateTier's `tailOf(combinedOutput(result))` reads exactly this slice.
    expect(result.stdout.slice(-GATE_OUTPUT_TAIL_LIMIT)).toBe(full.slice(-GATE_OUTPUT_TAIL_LIMIT));
    // …and the whole retained tail is a genuine suffix of the real stream.
    expect(full.endsWith(result.stdout.slice(-100_000))).toBe(true);
  });

  it("retains a HEAD too, so an early sentinel (bootstrap's DEPS_INSTALL_SENTINEL) survives", async () => {
    const sentinel = "__TANREN_DEPS_ALREADY_INSTALLED__\n";
    const result = await runStream("bounded", (io) => {
      io.emitStdout(sentinel);
      for (let i = 0; i < LINE_COUNT; i += 1) {
        io.emitStdout(line(i));
      }
      io.emitClose(0);
    });

    // A tail-only bound would drop this and silently re-run the install every gate.
    expect(result.stdout.includes(sentinel)).toBe(true);
    expect(result.stdout.startsWith(sentinel)).toBe(true);
  });

  it("reports the elision OUT OF BAND and injects NO synthetic marker into the stream", async () => {
    const result = await runStream("bounded", (io) => {
      for (let i = 0; i < LINE_COUNT; i += 1) {
        io.emitStdout(line(i));
      }
      io.emitClose(0);
    });

    const full = fullStream();
    // Out-of-band accounting: head + elided + tail exactly reconstructs the emitted length,
    // so a consumer can tell its view is partial WITHOUT parsing a marker out of the body.
    expect(result.stdoutElidedChars).toBeGreaterThan(0);
    expect(result.stdout.length + (result.stdoutElidedChars ?? 0)).toBe(full.length);
    // Every retained line is a REAL line from the stream — no `[… N chars elided …]` line
    // that a JSONL/git-log/NUL-framed parser would choke on or miscount.
    // …and each retained line is byte-identical to the line the step actually emitted
    // (proving both "no synthetic line" and "the cut landed on a line boundary" — a
    // bisected line would not match its original).
    const retainedLines = result.stdout.split("\n").filter((l) => l !== "");
    expect(retainedLines.length).toBeGreaterThan(100);
    for (const retained of retainedLines) {
      const index = Number.parseInt(retained.slice("step-line ".length), 10);
      expect(Number.isInteger(index)).toBe(true);
      expect(`${retained}\n`).toBe(line(index));
    }
  });

  it("bounds stderr on the same terms as stdout", async () => {
    const result = await runStream("bounded", (io) => {
      for (let i = 0; i < LINE_COUNT; i += 1) {
        io.emitStderr(line(i));
      }
      io.emitClose(1);
    });

    expect(result.stderr.length).toBeLessThanOrEqual(RETAINED_HEAD_CHARS + RETAINED_TAIL_CHARS);
    expect(result.stderrElidedChars).toBeGreaterThan(0);
    expect(result.stderr.slice(-GATE_OUTPUT_TAIL_LIMIT)).toBe(fullStream().slice(-GATE_OUTPUT_TAIL_LIMIT));
  });

  it("DEFAULTS to full retention, so no existing whole-stream consumer is silently truncated", async () => {
    // 19 production sites reconstruct a whole file / parse the whole stream / COUNT regex
    // matches across it (gate `stdout-count` evidence, JUnit XML `cat`, writer `git diff`,
    // agent JSONL telemetry). Bounding by DEFAULT would corrupt every one of them, so the
    // default must stay complete and elision must be opt-in per call site.
    const smallStream = `${line(0)}${line(1)}${line(2)}`;
    const result = await runStream(undefined, (io) => {
      io.emitStdout(smallStream);
      io.emitClose(0);
    });
    expect(result.stdout).toBe(smallStream);
    expect(result.stdoutElidedChars ?? 0).toBe(0);

    const big = await runStream("full", (io) => {
      for (let i = 0; i < LINE_COUNT; i += 1) {
        io.emitStdout(line(i));
      }
      io.emitClose(0);
    });
    expect(big.stdout.length).toBe(fullStream().length);
    expect(big.stdoutElidedChars ?? 0).toBe(0);
  });
});
