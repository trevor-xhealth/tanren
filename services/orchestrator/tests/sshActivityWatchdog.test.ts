import { EventEmitter } from "node:events";
import type { Client, ClientChannel } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { ActivityWatchdog } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { SshCommandSubstrate } from "../src/engine/ssh/index.js";
import {
  MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS,
  MIN_UNOBSERVABLE_PROBE_REPEATS,
} from "../src/engine/ssh/watchdogProgress.js";

// The ActivityWatchdog is the doctrine's progress-based replacement for the wall-clock
// kill (feedback_no_timeouts_progress_based): a process making genuine PROGRESS is NEVER
// killed regardless of elapsed time; the watchdog fires ONLY when the WORK SIGNATURE is at
// a fixed point (no new output AND no workspace advance across successive checks — a wedge,
// whether dead OR busy-but-not-advancing), and SURFACES a recoverable stall by default.
// The `livenessProbe` returns a discriminated OBSERVATION: `{ observed: true, signature }`
// carries real evidence about the workspace, `{ observed: false, reason }` carries NONE (F-10 —
// a slow or failed probe must never be re-told as "the step stalled"). These tests drive the real SshCommandSubstrate against a controllable
// fake ssh2 client with fake timers so we control the probe ticks deterministically.

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  identitySecretRef: "runner/run_1/identity",
};

// A controllable fake ssh2 Client + stream. `emitData` pushes an output chunk (a sign of
// life); the run resolves when the test settles it or the watchdog fires.
interface Controllable {
  client: Client & EventEmitter;
  emitStdout: (text: string) => void;
  emitClose: (exitCode: number) => void;
  state: { destroyCount: number };
}

function createControllableClient(): Controllable {
  const emitter = new EventEmitter();
  const stderr = new EventEmitter();
  const stream = Object.assign(new EventEmitter(), {
    stderr,
    end: () => stream,
  });
  const state = { destroyCount: 0 };
  const client = Object.assign(emitter, {
    connect: () => {
      queueMicrotask(() => emitter.emit("ready"));
      return client;
    },
    destroy: () => {
      state.destroyCount += 1;
      return client;
    },
    end: () => client,
    exec: (_command: string, callback: (error: Error | undefined, channel: ClientChannel) => void) => {
      // Defer so the run() promise wiring (the watchdog arm) is in place first.
      queueMicrotask(() => callback(undefined, stream as unknown as ClientChannel));
      return client;
    },
  });
  return {
    client: client as unknown as Client & EventEmitter,
    emitStdout: (text: string) => stream.emit("data", Buffer.from(text)),
    emitClose: (exitCode: number) => {
      stream.emit("exit", exitCode);
      stream.emit("close");
    },
    state,
  };
}

async function makeSubstrate(client: Client & EventEmitter): Promise<SshCommandSubstrate> {
  const secrets = new FakeSecretStore();
  await secrets.put({ ref: target.identitySecretRef, value: "private-key" });
  return new SshCommandSubstrate(secrets, { clientFactory: () => client });
}

describe("SSH activity watchdog (progress-based hang detection)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("NEVER kills for elapsed time: a long-but-ADVANCING op runs unbounded (no wall-clock kill)", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    // A probe whose workspace signature keeps ADVANCING (a build writing files) — genuine
    // progress, must never be killed no matter the elapsed time.
    let mtime = 1_000;
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve({ observed: true as const, signature: `ws:${(mtime += 1)}` }),
      probeIntervalMs: 1_000,
    };

    const runPromise = substrate.run(target, { command: "jj rebase", watchdog });
    // Advance FAR beyond any prior wall-clock budget — there is NO time-based kill now.
    await vi.advanceTimersByTimeAsync(10_000);
    // Still alive: the run has not settled. Now let it finish cleanly.
    c.emitClose(0);
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    expect(result.stalled).toBeFalsy();
    expect(c.state.destroyCount).toBe(0);
  });

  it("RESETS on new output: a streaming process is never killed while it emits NEW content", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    // A probe whose workspace signature NEVER advances (a fixed mtime) — output alone, as long
    // as it is genuinely NEW content, must keep the watchdog reset (the streaming-agent case).
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve({ observed: true as const, signature: "ws:1000" }),
      probeIntervalMs: 1_000,
    };

    const runPromise = substrate.run(target, { command: "codex --json", watchdog });
    // Let exec/arm settle.
    await vi.advanceTimersByTimeAsync(0);
    // Emit a token line every 500ms for several probe windows; each is genuinely-new content.
    for (let i = 0; i < 10; i += 1) {
      c.emitStdout(`{"token":${i}}\n`);
      await vi.advanceTimersByTimeAsync(500);
    }
    c.emitClose(0);
    const result = await runPromise;

    expect(result.stalled).toBeFalsy();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('{"token":9}');
    expect(c.state.destroyCount).toBe(0);
  });

  it("RESETS on an ADVANCING workspace signature for a SILENT op (no output, workspace moving)", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    let aliveChecks = 0;
    let mtime = 1_000;
    const watchdog: ActivityWatchdog = {
      // Silent op (a jj rebase) whose workspace keeps advancing (mtime climbs) — genuine
      // progress with no output. Must never be flagged.
      livenessProbe: () => {
        aliveChecks += 1;
        return Promise.resolve({ observed: true as const, signature: `ws:${(mtime += 1)}` });
      },
      probeIntervalMs: 1_000,
    };

    const runPromise = substrate.run(target, { command: "jj rebase -r all()", watchdog });
    // Five silent probe windows, the workspace advancing each time.
    await vi.advanceTimersByTimeAsync(5_000);
    c.emitClose(0);
    const result = await runPromise;

    expect(aliveChecks).toBeGreaterThan(0);
    expect(result.stalled).toBeFalsy();
    expect(result.exitCode).toBe(0);
    expect(c.state.destroyCount).toBe(0);
  });

  it("SURFACES a recoverable stall when the runner stays UNOBSERVABLE and the op is silent", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    // No output AND a probe that can never see the runner. This is NOT evidence of
    // non-progress (F-10), so it does not feed the work-signature fixed-point read - but a
    // long consecutive run of blind ticks is still worth surfacing, under its own kind, so a
    // permanently blind probe cannot leave a wedged step unwatched forever.
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve({ observed: false as const, reason: "unreachable" as const }),
      probeIntervalMs: 1_000,
    };

    const runPromise = substrate.run(target, { command: "jj rebase", watchdog });
    // Deliberately LATER than the progress floor: absence of observation is weaker evidence
    // than an observed fixed point. A streak on observation OUTCOMES, never elapsed time.
    await vi.advanceTimersByTimeAsync(1_000 * (MIN_UNOBSERVABLE_PROBE_REPEATS + 2));
    const result = await runPromise;

    expect(result.stalled).toBe(true);
    expect(result.stallKind).toBe("probe_unobservable");
    // SURFACED, not a hard transport failure.
    expect(result.failure).toBeUndefined();
    expect(typeof result.quietForMs).toBe("number");
    expect(c.state.destroyCount).toBe(1);
  });

  it("does NOT stall at the PROGRESS floor when the probe is merely unobservable (F-10)", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve({ observed: false as const, reason: "probe_failed" as const }),
      probeIntervalMs: 1_000,
    };

    const runPromise = substrate.run(target, { command: "just ci", watchdog });
    // The old fold aborted the step right here. A failing side-channel says nothing about
    // whether the step is advancing, so the step must still be running.
    await vi.advanceTimersByTimeAsync(1_000 * (MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS + 1));
    c.emitClose(0);
    const result = await runPromise;

    expect(result.stalled).toBeFalsy();
    expect(result.exitCode).toBe(0);
    expect(c.state.destroyCount).toBe(0);
  });

  it("SURFACES a stall on a WEDGED-BUT-BUSY process: byte-identical output forever, workspace flat", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    // The genuine-hang gap: the process is ALIVE (its probe reaches the runner, returns a
    // signature) and BUSY (it keeps spewing output) — but it emits BYTE-IDENTICAL lines and
    // its workspace mtime never advances. No NEW distinct work. The fixed-point read over the
    // work signature must SURFACE a stall (it would otherwise run truly forever).
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve({ observed: true as const, signature: "ws:1000" }),
      probeIntervalMs: 1_000,
    };

    const runPromise = substrate.run(target, { command: "./infinite-loop.sh", watchdog });
    await vi.advanceTimersByTimeAsync(0);
    // Spew the SAME line continuously across many probe windows — alive + busy, zero progress.
    // Without the work-signature backstop this would run TRULY FOREVER. Each chunk re-stamps
    // lastActivityAt (so a bare liveness watchdog reads "alive"), but the output TAIL never
    // changes and the workspace signature is flat → the work signature is a fixed point.
    for (let i = 0; i < 12; i += 1) {
      c.emitStdout("Retrying... still working\n");
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const result = await runPromise;

    expect(result.stalled).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(c.state.destroyCount).toBe(1);
  });

  // Task #24 (apex v52/v53) — CROSS-LAYER sign-of-life bridge between the SSH activity
  // watchdog and the #21B child-run progress breaker. On every probe tick the watchdog
  // reads the work signature as ADVANCING (new distinct output OR an advancing workspace),
  // it MUST invoke `onProgress` so the writer pipeline can emit a `writer.subtask.progress`
  // event the breaker counts. The watchdog already correctly TOLERATES a single mid-IO-burst
  // identical probe (the `MIN_NON_ADVANCING_NEIGHBOR_REPEATS=2` floor); without this bridge
  // the breaker would still age out — these tests pin that the bridge fires only on real
  // advancement, never on a fixed-point plateau.
  it("EMITS onProgress on every tick the work signature ADVANCES (output advancing)", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    const progressEvents: Array<{ outputBytesAdvanced: number; workspaceSignature?: string }> = [];
    // A probe whose workspace signature stays flat — the output stream alone advances each tick.
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve({ observed: true as const, signature: "ws:1000" }),
      probeIntervalMs: 1_000,
      onProgress: (signal) => {
        progressEvents.push({
          outputBytesAdvanced: signal.outputBytesAdvanced,
          workspaceSignature: signal.workspaceSignature,
        });
      },
    };

    const runPromise = substrate.run(target, { command: "codex --json", watchdog });
    await vi.advanceTimersByTimeAsync(0);
    // Emit a NEW distinct line every probe window; each is genuine advancement.
    for (let i = 0; i < 5; i += 1) {
      c.emitStdout(`{"token":${i}}\n`);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    c.emitClose(0);
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    expect(result.stalled).toBeFalsy();
    // The first probe tick observes a non-empty signature (prior is undefined → advance);
    // every subsequent tick that observed new distinct output also advanced. >= 2 events
    // proves the bridge is firing per genuine work-signature advancement, NOT once at arm.
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    // Every event MUST carry the workspaceSignature the probe returned this tick (the
    // bridge surfaces the count+bytes pair the #21B breaker downstream can index on).
    for (const event of progressEvents) {
      expect(event.workspaceSignature).toBe("ws:1000");
    }
  });

  it("DOES NOT emit onProgress on a fixed-point tick (no new output, flat workspace)", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    const progressEvents: Array<{ outputBytesAdvanced: number; workspaceSignature?: string }> = [];
    // The genuine-hang shape: zero output + flat workspace signature across probe ticks.
    // The first tick sets the signature (counts as advancement from undefined → defined),
    // every subsequent tick is signature-IDENTICAL → MUST NOT emit onProgress.
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve({ observed: true as const, signature: "ws:1000" }),
      probeIntervalMs: 1_000,
      onProgress: (signal) => {
        progressEvents.push({
          outputBytesAdvanced: signal.outputBytesAdvanced,
          workspaceSignature: signal.workspaceSignature,
        });
      },
    };

    const runPromise = substrate.run(target, { command: "./silent", watchdog });
    // Advance enough ticks to reach the streak floor — the watchdog will surface a stall.
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await runPromise;

    // First tick advanced (undefined → "ws:1000"); ALL subsequent identical ticks did not.
    expect(progressEvents.length).toBe(1);
    expect(result.stalled).toBe(true);
  });

  it("SWALLOWS a throw from onProgress so an emit failure cannot bubble into the watchdog tick", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    let invocations = 0;
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve({ observed: true as const, signature: "ws:1000" }),
      probeIntervalMs: 1_000,
      onProgress: () => {
        invocations += 1;
        throw new Error("synthetic append-event failure");
      },
    };

    const runPromise = substrate.run(target, { command: "codex --json", watchdog });
    await vi.advanceTimersByTimeAsync(0);
    c.emitStdout(`{"token":1}\n`);
    await vi.advanceTimersByTimeAsync(1_000);
    c.emitClose(0);
    const result = await runPromise;

    expect(invocations).toBeGreaterThan(0);
    // The thrown emit MUST NOT have killed the run — exit 0, no stall, no destroy.
    expect(result.exitCode).toBe(0);
    expect(result.stalled).toBeFalsy();
    expect(c.state.destroyCount).toBe(0);
  });

  // Class-specific streak floor (apex v76/v77). The agent-class watchdog widens
  // `minNonAdvancingRepeats` to 5 (~75s at the 15s probe cadence) to tolerate Codex's
  // think-then-stream burst pattern — a 2-neighbor floor false-positive-wedged legitimately-
  // generating agents at ~60% rate. These tests pin that the substrate HONORS the watchdog's
  // `minNonAdvancingRepeats` field (proving the wiring), and that a widened floor DOES tolerate
  // a plateau the default vcs floor would have fired on.
  it("HONORS the watchdog's minNonAdvancingRepeats: a widened floor tolerates the default-firing plateau", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    // A plateau of 3 identical work signatures (streak=2 identical-neighbor pairs) — enough
    // to fire the default 2-neighbor floor, NOT enough to fire the widened 5-neighbor floor.
    // With minNonAdvancingRepeats=5 the substrate MUST tolerate this plateau (the Codex
    // silent-generation window), then continue when new output finally arrives.
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve({ observed: true as const, signature: "ws:flat" }),
      probeIntervalMs: 1_000,
      minNonAdvancingRepeats: 5,
    };

    const runPromise = substrate.run(target, { command: "codex --json", watchdog });
    await vi.advanceTimersByTimeAsync(0);
    // 3 silent probe ticks (would fire under the default vcs floor of 2 pairs).
    await vi.advanceTimersByTimeAsync(3_000);
    // Then genuinely-new output — proves the run was still alive, not stalled.
    c.emitStdout('{"token":"finally"}\n');
    await vi.advanceTimersByTimeAsync(1_000);
    c.emitClose(0);
    const result = await runPromise;

    expect(result.stalled).toBeFalsy();
    expect(result.exitCode).toBe(0);
    expect(c.state.destroyCount).toBe(0);
  });

  it("HONORS the watchdog's minNonAdvancingRepeats: a widened floor STILL fires once the streak is reached", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    // A genuinely dead agent — no output, flat workspace, indefinitely. The widened floor is
    // still a STREAK ceiling on signature identity, not a green card: once the streak reaches
    // 5 identical-neighbor pairs the wedge fires and the substrate surfaces the stall.
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve({ observed: true as const, signature: "ws:flat" }),
      probeIntervalMs: 1_000,
      minNonAdvancingRepeats: 5,
    };

    const runPromise = substrate.run(target, { command: "codex --json", watchdog });
    // 8 silent probe ticks — well past the 5-neighbor streak (6 identical signatures suffice).
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await runPromise;

    expect(result.stalled).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(c.state.destroyCount).toBe(1);
  });

  it("KILLS with an in-band failure when onQuiet is 'kill' and the work signature is fixed", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    const watchdog: ActivityWatchdog = {
      // OBSERVED and flat - a genuine fixed point, not a blind probe.
      livenessProbe: () => Promise.resolve({ observed: true as const, signature: "ws:flat" }),
      probeIntervalMs: 1_000,
      onQuiet: "kill",
    };

    const runPromise = substrate.run(target, { command: "jj rebase", watchdog });
    // Advance enough probe ticks for the trailing identical-neighbor streak to reach the
    // watchdog's floor (MIN_NON_ADVANCING_NEIGHBOR_REPEATS).
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await runPromise;

    expect(result.stalled).toBe(true);
    expect(result.stallKind).toBe("no_progress");
    expect(result.failure?.kind).toBe("ssh_failed");
    expect(result.failure?.message).toContain("no sign of life");
    expect(c.state.destroyCount).toBe(1);
  });
});
