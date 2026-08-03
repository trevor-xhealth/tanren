import { EventEmitter } from "node:events";
import type { Client, ClientChannel } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { SshCommandSubstrate } from "../src/engine/ssh/index.js";
import { buildActivityWatchdog, PROBE_TREE_MAXDEPTH } from "../src/engine/ssh/activityWatchdog.js";
import {
  MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS,
  MIN_UNOBSERVABLE_PROBE_REPEATS,
} from "../src/engine/ssh/watchdogProgress.js";

// F-10 NEGATIVE CONTROL — the liveness probe walked the ENTIRE worktree every cadence,
// and a slow/failed walk was folded as NON-PROGRESS.
//
// The probe used to run `find <ws> -type f -printf '%s\n' | awk …` — a full recursive
// enumeration of every inode under the workspace — on a `setInterval`, opening a fresh SSH
// exec channel each time. A materialized monorepo checkout is 300k–600k inodes. Measured
// on the runner image base (debian-slim) over a 369 505-inode monorepo-shaped tree:
// the old walk took 570 ms and enumerated 369 505 entries; the replacement takes 11 ms and
// enumerates 3 004. Worse, a walk that was slow or failed returned `undefined`, which the
// substrate folded into a FIXED sentinel — so two consecutive slow walks reached the vcs
// 2-neighbor streak floor and ABORTED a perfectly healthy step. That is infrastructure
// slowness masquerading as a stalled agent.
//
// These tests drive the REAL SshCommandSubstrate and the REAL `buildActivityWatchdog`
// probe against controllable doubles — no vi.mock anywhere.

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  identitySecretRef: "runner/run_1/identity",
};

const WORKSPACE = "/workspace/runs/run_1/repo";
const CADENCE_MS = 1_000;

// The fake ssh2 client the WATCHED command runs on. The probe runs on a separate scripted
// CommandSubstrate, exactly as in production (the probe is its own `ssh.run`).
interface Watched {
  client: Client & EventEmitter;
  emitStdout: (text: string) => void;
  emitClose: (exitCode: number) => void;
  destroyCount: () => number;
}

function createWatchedClient(): Watched {
  const emitter = new EventEmitter();
  const stderr = new EventEmitter();
  const stream = Object.assign(new EventEmitter(), { stderr, end: () => stream });
  let destroys = 0;
  const client = Object.assign(emitter, {
    connect: () => {
      queueMicrotask(() => emitter.emit("ready"));
      return client;
    },
    destroy: () => {
      destroys += 1;
      return client;
    },
    end: () => client,
    exec: (_command: string, callback: (error: Error | undefined, channel: ClientChannel) => void) => {
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
    destroyCount: () => destroys,
  };
}

// A substrate the PROBE's own little side-channel command runs on. `reply` decides what the
// runner answers on each probe tick; `commands` records what was actually asked.
function probeSubstrate(reply: (tick: number) => Promise<CommandResult>): {
  substrate: CommandSubstrate;
  commands: RunnerCommand[];
  calls: () => number;
} {
  const commands: RunnerCommand[] = [];
  let tick = 0;
  return {
    substrate: {
      async run(_handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
        commands.push(command);
        tick += 1;
        return await reply(tick);
      },
    },
    commands,
    calls: () => tick,
  };
}

// The runner's answer to the NEW probe: `stat -f` free blocks + free inodes, then the
// depth-bounded tree read folded by `cksum` (crc + byte count).
function probeReply(freeBlocks: number, freeInodes: number, crc: number, cksumBytes: number): CommandResult {
  return { exitCode: 0, stdout: `${freeBlocks} ${freeInodes}\n${crc} ${cksumBytes}\n`, stderr: "" };
}

async function substrateFor(client: Client & EventEmitter): Promise<SshCommandSubstrate> {
  const secrets = new FakeSecretStore();
  await secrets.put({ ref: target.identitySecretRef, value: "private-key" });
  return new SshCommandSubstrate(secrets, { clientFactory: () => client });
}

describe("F-10: the liveness probe is bounded, and an unobservable probe is not a stall", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT enumerate the whole worktree: every walk is depth-bounded, plus an O(1) statfs", async () => {
    const { substrate, commands } = probeSubstrate(async () => probeReply(1, 1, 1, 1));
    const watchdog = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: WORKSPACE });
    await watchdog.livenessProbe?.();

    const command = commands[0]?.command ?? "";
    // The exact shape the defect report named — an unbounded recursive enumeration of every
    // file under the workspace — must be gone.
    expect(command).not.toMatch(/find\s+\S+\s+-type\s+f\s+-printf/u);
    // EVERY `find` in the probe carries an explicit small `-maxdepth`, so its cost is bounded
    // by the workspace's top-level BREADTH and cannot grow as the tree deepens.
    const finds = [...command.matchAll(/find\s+[^|;&]*/gu)].map((m) => m[0]);
    expect(finds.length).toBeGreaterThan(0);
    for (const find of finds) {
      expect(find).toMatch(/-maxdepth\s+\d+/u);
      const depth = Number.parseInt(/-maxdepth\s+(\d+)/u.exec(find)?.[1] ?? "999", 10);
      expect(depth).toBe(PROBE_TREE_MAXDEPTH);
      expect(depth).toBeLessThanOrEqual(3);
    }
    // …and the deep/ignored-directory writes a depth-bounded read cannot see are covered by a
    // single O(1) statfs of the workspace's filesystem (free blocks + free inodes).
    expect(command).toMatch(/stat\s+-f\b/u);
  });

  it("keeps the apex-v45 property: a lock-file HEARTBEAT is still a FIXED POINT", async () => {
    // Re-touching one file changes neither the filesystem's free blocks/inodes nor the
    // depth-bounded tree digest, so the signature is byte-identical across ticks.
    const flat = probeReply(102_127_416, 28_070_427, 810_286_853, 123_094);
    const { substrate } = probeSubstrate(async () => flat);
    const probe = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: WORKSPACE }).livenessProbe;
    const reads = [await probe?.(), await probe?.(), await probe?.()];
    expect(new Set(reads.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(reads[0]).toEqual({ observed: true, signature: expect.stringContaining("102127416") });
  });

  it("still ADVANCES on a deep write a depth-bounded read alone would miss (statfs catches it)", async () => {
    // A 20 MB file landing four levels down: the depth-2 digest is unchanged, but the
    // filesystem's free blocks drop. The folded signature must advance.
    const replies = [
      probeReply(102_132_299, 28_070_428, 810_286_853, 123_094),
      probeReply(102_127_416, 28_070_427, 810_286_853, 123_094),
    ];
    const { substrate } = probeSubstrate(async (tick) => replies[tick - 1] as CommandResult);
    const probe = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: WORKSPACE }).livenessProbe;
    expect(await probe?.()).not.toEqual(await probe?.());
  });

  it("FALSE STALL: a probe that FAILS is not evidence of non-progress and must not abort the step", async () => {
    // The live bug. The probe's own side-channel command fails (a slow walk that timed out,
    // a transient SSH blip, a `find` that errored). The step itself is fine. Under the old
    // fold this reached the 2-neighbor vcs floor and aborted a healthy step.
    vi.useFakeTimers();
    const watched = createWatchedClient();
    const { substrate: probes, calls } = probeSubstrate(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "find: cannot access",
    }));
    const substrate = await substrateFor(watched.client);
    const watchdog = buildActivityWatchdog({ substrate: probes, target, cls: "vcs", workspace: WORKSPACE });
    watchdog.probeIntervalMs = CADENCE_MS;

    const runPromise = substrate.run(target, { command: "just ci", watchdog });
    // Well past the vcs streak floor: the old code fired here.
    await vi.advanceTimersByTimeAsync(CADENCE_MS * (MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS + 2));
    // The step is alive and unharmed — let it finish.
    watched.emitClose(0);
    const result = await runPromise;

    expect(calls()).toBeGreaterThanOrEqual(MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS + 1);
    expect(result.stalled).toBeFalsy();
    expect(result.exitCode).toBe(0);
    expect(watched.destroyCount()).toBe(0);
  });

  it("GENUINE STALL is still detected: an OBSERVED flat workspace with no output surfaces", async () => {
    // The half that must NOT be disabled. The probe reaches the runner and reports a
    // genuinely unchanging workspace, and the step emits nothing. That IS a wedge.
    vi.useFakeTimers();
    const watched = createWatchedClient();
    const flat = probeReply(102_127_416, 28_070_427, 810_286_853, 123_094);
    const { substrate: probes } = probeSubstrate(async () => flat);
    const substrate = await substrateFor(watched.client);
    const watchdog = buildActivityWatchdog({ substrate: probes, target, cls: "vcs", workspace: WORKSPACE });
    watchdog.probeIntervalMs = CADENCE_MS;

    const runPromise = substrate.run(target, { command: "just ci", watchdog });
    await vi.advanceTimersByTimeAsync(CADENCE_MS * (MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS + 2));
    const result = await runPromise;

    expect(result.stalled).toBe(true);
    // SURFACED (recoverable), not a hard transport failure — unchanged doctrine.
    expect(result.failure).toBeUndefined();
    expect(watched.destroyCount()).toBe(1);
  });

  it("distinguishes the two: a genuine wedge and an unobservable probe carry DIFFERENT stall kinds", async () => {
    vi.useFakeTimers();
    const watched = createWatchedClient();
    const flat = probeReply(102_127_416, 28_070_427, 810_286_853, 123_094);
    const { substrate: probes } = probeSubstrate(async () => flat);
    const substrate = await substrateFor(watched.client);
    const watchdog = buildActivityWatchdog({ substrate: probes, target, cls: "vcs", workspace: WORKSPACE });
    watchdog.probeIntervalMs = CADENCE_MS;

    const runPromise = substrate.run(target, { command: "just ci", watchdog });
    await vi.advanceTimersByTimeAsync(CADENCE_MS * (MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS + 2));
    const result = await runPromise;

    // The caller can tell "the agent wedged" from "we could not see the runner" — the whole
    // point of the fix, and what lets a re-drive policy treat them differently.
    expect(result.stallKind).toBe("no_progress");
  });

  it("a PERSISTENTLY unobservable probe still escalates — loudly, and as its own kind", async () => {
    // The fix must not silently disable the safety net. Not seeing the runner for a long
    // consecutive run of ticks is itself a condition worth surfacing — but as
    // `probe_unobservable`, never disguised as a stalled agent.
    vi.useFakeTimers();
    const watched = createWatchedClient();
    const { substrate: probes } = probeSubstrate(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "ssh: connect failed",
    }));
    const substrate = await substrateFor(watched.client);
    const watchdog = buildActivityWatchdog({ substrate: probes, target, cls: "vcs", workspace: WORKSPACE });
    watchdog.probeIntervalMs = CADENCE_MS;

    const runPromise = substrate.run(target, { command: "just ci", watchdog });
    await vi.advanceTimersByTimeAsync(CADENCE_MS * (MIN_UNOBSERVABLE_PROBE_REPEATS + 2));
    const result = await runPromise;

    expect(result.stalled).toBe(true);
    expect(result.stallKind).toBe("probe_unobservable");
    // Strictly later than the progress floor — an unobservable probe is a WEAKER signal than
    // an observed fixed point and must take longer to escalate.
    expect(MIN_UNOBSERVABLE_PROBE_REPEATS).toBeGreaterThan(MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS);
  });

  it("new OUTPUT resets an unobservable streak: a talking step is never escalated on probe blindness", async () => {
    vi.useFakeTimers();
    const watched = createWatchedClient();
    const { substrate: probes } = probeSubstrate(async () => ({ exitCode: 1, stdout: "", stderr: "boom" }));
    const substrate = await substrateFor(watched.client);
    const watchdog = buildActivityWatchdog({ substrate: probes, target, cls: "vcs", workspace: WORKSPACE });
    watchdog.probeIntervalMs = CADENCE_MS;

    const runPromise = substrate.run(target, { command: "just ci", watchdog });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < MIN_UNOBSERVABLE_PROBE_REPEATS * 2; i += 1) {
      watched.emitStdout(`compiling module ${i}\n`);
      await vi.advanceTimersByTimeAsync(CADENCE_MS);
    }
    watched.emitClose(0);
    const result = await runPromise;

    expect(result.stalled).toBeFalsy();
    expect(result.exitCode).toBe(0);
  });

  it("probe ticks do NOT overlap: a slow probe is never re-entered by the next cadence", async () => {
    // The probe ran on a `setInterval`, so on a large tree the walks piled up — each opening
    // its own SSH exec channel against the very runner that is already struggling.
    vi.useFakeTimers();
    const watched = createWatchedClient();
    let release: (() => void) | undefined;
    const { substrate: probes, calls } = probeSubstrate(
      async () =>
        await new Promise<CommandResult>((resolve) => {
          release = () => resolve(probeReply(1, 1, 1, 1));
        }),
    );
    const substrate = await substrateFor(watched.client);
    const watchdog = buildActivityWatchdog({ substrate: probes, target, cls: "vcs", workspace: WORKSPACE });
    watchdog.probeIntervalMs = CADENCE_MS;

    const runPromise = substrate.run(target, { command: "just ci", watchdog });
    // Many cadences elapse while the FIRST probe is still in flight.
    await vi.advanceTimersByTimeAsync(CADENCE_MS * 8);
    expect(calls()).toBe(1);

    release?.();
    await vi.advanceTimersByTimeAsync(0);
    watched.emitClose(0);
    await runPromise;
  });
});
