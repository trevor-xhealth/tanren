import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { buildActivityWatchdog, outputOnlyWatchdog } from "../src/engine/ssh/activityWatchdog.js";
import {
  MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT,
  MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS,
} from "../src/engine/ssh/watchdogProgress.js";

// The shared `buildActivityWatchdog` factory is the SOLE constructor of the per-call
// ActivityWatchdog (feedback_no_timeouts_progress_based): every class is UNBOUNDED in
// time and continues while it makes genuine PROGRESS. The agent/vcs classes attach a
// workspace STRUCTURAL liveness probe that returns the workspace SIGNATURE - what the work
// has CONSUMED (free blocks + free inodes, one O(1) statfs) folded with a depth-bounded
// digest of the workspace's top levels. NOT a single newest mtime, which a heartbeat-touched
// lock file would advance forever (the apex-v45 wedge), and NOT a full-tree walk, which cost
// 570 ms on a 370k-inode checkout and false-stalled healthy steps (F-10). The substrate
// compares the SEQUENCE for advancement (a changing signature = a build/install consuming
// disk = progress). The infra class is output-driven only. None is a wall-clock kill.

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  identitySecretRef: "runner/run_1/identity",
};

// A scripted substrate: each `run` returns the next queued result. The probe's own
// `find <ws> … | awk` read (the "<count> <bytes>" structural signature) is what we control.
function scriptedSubstrate(results: CommandResult[]): { substrate: CommandSubstrate; commands: RunnerCommand[] } {
  const commands: RunnerCommand[] = [];
  let i = 0;
  const substrate: CommandSubstrate = {
    async run(_handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
      commands.push(command);
      const next = results[i] ?? { exitCode: 0, stdout: "", stderr: "" };
      i += 1;
      return next;
    },
  };
  return { substrate, commands };
}

// The runner's answer to the probe: `stat -f` free blocks + free inodes (an O(1) statfs),
// then the depth-bounded tree digest folded by `cksum` (crc + byte count). Neither half moves
// when a lock file is merely re-touched, so this is IMMUNE to the apex-v45 lock-mtime wedge
// (the bare newest-mtime it replaced would have ticked forever) - and neither half costs a
// full-tree walk (F-10). This helper scripts that four-integer stdout.
function probeRead(freeBlocks: number, freeInodes: number, crc = 111, cksumBytes = 222): CommandResult {
  return { exitCode: 0, stdout: `${freeBlocks} ${freeInodes}\n${crc} ${cksumBytes}\n`, stderr: "" };
}

function signatureOf(freeBlocks: number, freeInodes: number, crc = 111, cksumBytes = 222): string {
  return `ws:${freeBlocks}:${freeInodes}:${crc}:${cksumBytes}`;
}

describe("buildActivityWatchdog (the shared per-call-class factory)", () => {
  it("is always UNBOUNDED in time: no class carries a duration budget, only a poll cadence", () => {
    const { substrate } = scriptedSubstrate([]);
    for (const cls of ["agent", "vcs", "infra"] as const) {
      const wd = buildActivityWatchdog({ substrate, target, cls, workspace: "/ws" });
      // The default reaction is the recoverable SURFACE, never a wall-clock kill.
      expect(wd.onQuiet).toBe("surface");
      // `probeIntervalMs` is a poll cadence, NEVER a total-duration deadline.
      expect(typeof wd.probeIntervalMs).toBe("number");
      // No field encodes an elapsed-time kill budget.
      expect(wd).not.toHaveProperty("timeoutMs");
    }
  });

  it("attaches a workspace liveness probe for the silent classes (agent/vcs) when a workspace is known", () => {
    const { substrate } = scriptedSubstrate([]);
    expect(buildActivityWatchdog({ substrate, target, cls: "agent", workspace: "/ws" }).livenessProbe).toBeDefined();
    expect(buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" }).livenessProbe).toBeDefined();
    // The infra class is output-driven only (no workspace to probe).
    expect(buildActivityWatchdog({ substrate, target, cls: "infra", workspace: "/ws" }).livenessProbe).toBeUndefined();
    // An agent/vcs class with NO workspace also has no probe (output is the only tick).
    expect(buildActivityWatchdog({ substrate, target, cls: "vcs" }).livenessProbe).toBeUndefined();
  });

  it("liveness probe returns a CHANGING workspace signature as the work CONSUMES disk (a build/install)", async () => {
    // Each read reports MORE files / MORE bytes → the probe returns a DISTINCT signature each
    // tick. The substrate reads a changing signature as genuine progress (a workspace being
    // written — a package unpacking, a download landing).
    const { substrate } = scriptedSubstrate([probeRead(9_000, 500), probeRead(8_600, 460), probeRead(8_100, 420)]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" });
    const probe = wd.livenessProbe!;
    const a = await probe();
    const b = await probe();
    const c = await probe();
    expect(a).toEqual({ observed: true, signature: signatureOf(9_000, 500) });
    expect(b).toEqual({ observed: true, signature: signatureOf(8_600, 460) });
    expect(c).toEqual({ observed: true, signature: signatureOf(8_100, 420) });
    // Distinct signatures across ticks = advancement.
    expect(new Set([a, b, c].map((r) => JSON.stringify(r))).size).toBe(3);
  });

  it("liveness probe returns the SAME signature when the tree is FLAT (a deadlocked/zombied op)", async () => {
    // The SAME count+bytes each read — nothing new is being written → an UNCHANGING signature,
    // which the substrate's work-signature read eventually flags as a non-advancing fixed point.
    const { substrate } = scriptedSubstrate([
      probeRead(9_000_000, 2000),
      probeRead(9_000_000, 2000),
      probeRead(9_000_000, 2000),
    ]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" });
    const probe = wd.livenessProbe!;
    const flat = { observed: true, signature: signatureOf(9_000_000, 2000) };
    expect(await probe()).toEqual(flat);
    expect(await probe()).toEqual(flat);
    expect(await probe()).toEqual(flat);
  });

  it("apex-v45: a lock-file HEARTBEAT (constant tree, only an mtime ticking) reads as a FIXED POINT", async () => {
    // The exact apex-v45 wedge: `playwright install` stalled on a download while holding
    // `.cache/ms-playwright/__dirlock`, re-touched every few seconds. The OLD probe read the
    // single newest mtime and saw it ADVANCE forever → never fired → the job wedged for hours.
    // The structural count+bytes signature is IMMUNE: re-touching one file changes NEITHER the
    // file count NOR the byte total, so successive reads of the SAME (count, bytes) — even as a
    // lock's mtime ticks underneath — yield the IDENTICAL signature → a fixed point the
    // substrate surfaces as a recoverable stall.
    // Nothing is consumed and nothing changes shape while a lock's mtime ticks, so all four
    // components of the read hold flat.
    const wedged = probeRead(102_127_416, 28_070_427, 810_286_853, 123_094);
    const { substrate } = scriptedSubstrate([wedged, wedged, wedged, wedged]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" });
    const probe = wd.livenessProbe!;
    const reads = [await probe(), await probe(), await probe(), await probe()];
    // Every read is byte-identical - the lock-heartbeat is invisible to a structural signature.
    expect(new Set(reads.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(reads[0]).toEqual({
      observed: true,
      signature: signatureOf(102_127_416, 28_070_427, 810_286_853, 123_094),
    });
  });

  it("liveness probe ADVANCES on a byte-only grow (an in-place file growing, count flat)", async () => {
    // A download landing into an existing file grows BYTES without adding a file — still genuine
    // progress. The signature folds bytes, so it advances even when the file count is flat.
    // Free BLOCKS drop while the inode count and the depth-bounded digest are unchanged.
    const { substrate } = scriptedSubstrate([
      probeRead(102_132_299, 28_070_427, 810_286_853, 123_094),
      probeRead(102_127_416, 28_070_427, 810_286_853, 123_094),
    ]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" });
    const probe = wd.livenessProbe!;
    const a = await probe();
    const b = await probe();
    expect(a).not.toEqual(b);
  });

  it("reports UNOBSERVABLE (not a fixed point) when the probe itself cannot read the runner", async () => {
    // A probe whose OWN little command failed (exit != 0 / stalled / garbled) is NOT a signal
    // and NOT evidence of non-progress (F-10). It says so explicitly, so the substrate can keep
    // it out of the progress fixed-point read instead of aborting a healthy step.
    const failed: CommandResult = { exitCode: 1, stdout: "", stderr: "stat: cannot read" };
    const { substrate } = scriptedSubstrate([failed]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "agent", workspace: "/ws" });
    expect(await wd.livenessProbe!()).toEqual({ observed: false, reason: "probe_failed" });

    const unreachable: CommandResult = { exitCode: null, stdout: "", stderr: "", stalled: true };
    const { substrate: s2 } = scriptedSubstrate([unreachable]);
    const wd2 = buildActivityWatchdog({ substrate: s2, target, cls: "agent", workspace: "/ws" });
    expect(await wd2.livenessProbe!()).toEqual({ observed: false, reason: "unreachable" });

    const garbled: CommandResult = { exitCode: 0, stdout: "not a signature", stderr: "" };
    const { substrate: s3 } = scriptedSubstrate([garbled]);
    const wd3 = buildActivityWatchdog({ substrate: s3, target, cls: "agent", workspace: "/ws" });
    expect(await wd3.livenessProbe!()).toEqual({ observed: false, reason: "unparseable" });
  });

  it("the probe's own side-channel command runs under a connect-ESTABLISHMENT bound (not a kill budget)", async () => {
    const { substrate, commands } = scriptedSubstrate([probeRead(1, 10)]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" });
    await wd.livenessProbe!();
    // The structural read carries a connectTimeoutMs (the handshake bound for the trivial
    // side-channel) and NEVER a `timeoutMs` running-command kill.
    expect(commands[0]?.connectTimeoutMs).toBeGreaterThan(0);
    expect(commands[0]).not.toHaveProperty("timeoutMs");
  });

  it("outputOnlyWatchdog is unbounded, output-driven, and surfaces (never a wall-clock kill)", () => {
    const wd = outputOnlyWatchdog();
    expect(wd.onQuiet).toBe("surface");
    expect(wd.livenessProbe).toBeUndefined();
    expect(wd).not.toHaveProperty("timeoutMs");
  });

  it("class-specific streak floor: agent widens to MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT (apex v76/v77)", () => {
    // The apex v77 root cause: Codex's think-then-stream burst pattern (~9k bytes, then 30-60s
    // silent generation, then more) false-positive-wedged under the 2-neighbor vcs floor at
    // ~60% rate on tiny subtasks. The agent watchdog widens the floor to 5 (~75s of signature
    // identity at the 15s probe cadence) — still a STREAK ceiling on signature identity, never
    // an elapsed-time budget.
    const { substrate } = scriptedSubstrate([]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "agent", workspace: "/ws" });
    expect(wd.minNonAdvancingRepeats).toBe(MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT);
    expect(wd.minNonAdvancingRepeats).toBe(5);
  });

  it("class-specific streak floor: vcs keeps the historic 2-neighbor floor (`pnpm install` case)", () => {
    // The vcs floor is unchanged — the apex-v50 `pnpm install` case still requires the same
    // tolerance of a single mid-IO-burst identical probe.
    const { substrate } = scriptedSubstrate([]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" });
    expect(wd.minNonAdvancingRepeats).toBe(MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS);
    expect(wd.minNonAdvancingRepeats).toBe(2);
  });

  it("class-specific streak floor: infra keeps the vcs floor (output-only side-op)", () => {
    // Infra is a side/IO op (a usage read, a small capture). Same 2-neighbor floor as vcs —
    // there is nothing about a side op that needs the widened agent burst window.
    const { substrate } = scriptedSubstrate([]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "infra" });
    expect(wd.minNonAdvancingRepeats).toBe(MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS);
  });
});
