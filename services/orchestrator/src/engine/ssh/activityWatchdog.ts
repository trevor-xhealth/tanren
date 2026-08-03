// The SHARED ActivityWatchdog factory — the doctrine's wall-clock-kill replacement
// (feedback_no_timeouts_progress_based, BINDING). Tanren has ZERO arbitrary
// wall-clock kills: a process making genuine PROGRESS is NEVER terminated, no
// matter the total elapsed time ("10 minutes is nothing to an AI agent"). Every
// `ssh.run` call constructs its watchdog here — per CALL CLASS — instead of
// hand-rolling one at ~30 sites.
//
// The watchdog's PRIMARY signal is the command's streamed output (the substrate
// folds every stdout/stderr chunk into a WORK SIGNATURE — a `codex --json` line, a
// build log line is new distinct content = progress). For SILENT stretches a
// `livenessProbe` is consulted between output: it returns a SIGNATURE of the
// remote work state (what the work has CONSUMED — free blocks and free inodes — folded
// with a depth-bounded digest of the workspace's top levels; deliberately NOT a single
// file's mtime, which a heartbeat-touched lock file would advance forever with no real
// work — apex-v45; and deliberately NOT a full-tree walk, which cost 570 ms on a 370k-inode
// checkout and false-stalled healthy steps — F-10). The substrate feeds the SEQUENCE of
// work signatures into the shared convergence detector: a CHANGING signature (new output
// OR an advancing workspace) is genuine progress → the work continues UNBOUNDED. The
// watchdog FIRES only when the work signature is at a FIXED POINT (no new output AND an
// OBSERVED, unchanged workspace across successive checks) — which covers BOTH a
// dead/zombied/deadlocked process AND a WEDGED-BUT-BUSY one (an infinite loop emitting
// byte-identical output, a CPU-burn touching nothing) — and even then SURFACES a
// recoverable stall (the caller re-drives) by default rather than destroying
// possibly-recoverable work. A probe that could not SEE the workspace is not a fixed
// point: it is no evidence at all, and is tracked separately (see
// MIN_UNOBSERVABLE_PROBE_REPEATS) so infrastructure slowness cannot be re-told as a stall.
//
// There is NO time budget here: `probeIntervalMs` is a poll CADENCE (how often to
// snapshot the work signature between output), never a deadline — the trigger is
// signature IDENTITY (non-advancement), never an elapsed duration.
import type { RunnerHandle } from "../contracts/allocator.js";
import type {
  ActivityWatchdog,
  CommandSubstrate,
  LivenessProbe,
  ProbeObservation,
  WatchdogProgressSignal,
} from "../contracts/commandSubstrate.js";
import { quoteSshShellArg } from "./command.js";
import {
  MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT,
  MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS,
} from "./watchdogProgress.js";

// How often a watchdog consults its `livenessProbe` between output chunks. A poll
// INTERVAL (cadence), NOT a total-duration budget — every tick that finds life
// RESETS, so it never accumulates toward a kill. The substrate clamps the probe's
// own command on a short connect-establishment bound so a wedged probe can't hang
// the tick (a probe that itself cannot reach the runner reports UNOBSERVABLE — no
// evidence about the work either way, never "the step stalled").
const PROBE_CADENCE_MS = 15_000;

// The short connect-establishment bound the liveness probe's OWN little SSH command
// runs under (a sub-second `stat`/`ps`). This is a legitimate HANDSHAKE bound on a
// trivial side-channel command — not a kill budget on the watched work — so it is
// named in the connect-establishment class the lint allowlist accepts.
const PROBE_CONNECT_MS = 20_000;

// The call CLASS a watchdog is built for. The class only selects whether a
// `livenessProbe` is attached (and which signal it reads); EVERY class is unbounded
// in time and resets on any output. Classes:
//   - "agent": an LLM agent exec (codex/claude/opencode/aider/pi/reasonix). Its
//     `--json`/stream output is continuous, so output IS the primary tick; the probe
//     is a backstop for a long silent tool call. Surfaces a recoverable stall.
//   - "vcs": a git/jj/gate SSH command that can run silently for minutes (a big
//     rebase, a clone, a gate suite). The probe (the workspace CONSUMING blocks/inodes
//     plus a depth-bounded digest of its top levels — not a single mtime, and not a
//     full-tree walk) is the PRIMARY liveness signal. Surfaces a recoverable stall.
//   - "infra": a side/IO op (read of usage, a small capture). Output-driven only,
//     no probe; surfaces a stall rather than killing.
export type WatchdogClass = "agent" | "vcs" | "infra";

// What the liveness probe reads for a silent op: a STRUCTURAL SIGNATURE of the WORKSPACE
// state. A build/install/test consumes disk and creates files as it works, so a signature
// folded from what the work CONSUMES and what the tree LOOKS LIKE advances while real work
// happens and holds flat when it stops. The substrate compares the SEQUENCE for genuine
// advancement. A deadlocked/zombied process writes nothing new, so the signature holds flat
// → eventually a fixed point.
//
// APEX-V45 (why not the newest mtime). The probe once returned the single newest mtime under
// the workspace. That conflates "a file was TOUCHED" with "the build ADVANCED" — a stalled
// tool holding a HEARTBEAT LOCK FILE (playwright's `.cache/ms-playwright/__dirlock`,
// re-touched every few seconds while its download is wedged) advances the newest mtime
// FOREVER with zero real progress, so the watchdog never fired and the job wedged for hours
// (run_a81f3424: a constant 15591-file / 805552244-byte tree while one lock file ticked).
// The signature below is IMMUNE for the same reason its `find|awk` predecessor was:
// re-touching one file consumes no blocks, creates no inode, and changes no size — so a lock
// heartbeat is a fixed point, while a download landing or a package unpacking is not.
//
// F-10 (why not a full-tree walk). The predecessor read the workspace's total file COUNT +
// total BYTES via `find <ws> -type f -printf '%s\n' | awk …` — a complete recursive
// enumeration of EVERY inode, re-run on every cadence, each in a fresh SSH exec channel. A
// materialized monorepo checkout is 300k–600k inodes. Measured on the runner image base over
// a monorepo-shaped tree, the walk cost scales with the tree while this probe does not:
//
//     inodes    entries walked        old        this probe
//      5 105    → 204                 14 ms          3 ms
//     63 505    → 1 004               96 ms          4 ms
//    369 505    → 3 004              570 ms         11 ms
//
// and this module's own history records the walk stalling a 15 591-file / 805 MB tree. The
// replacement is two cheap reads whose cost does not grow with the tree:
//
//   1. `stat -f` on the workspace — ONE statfs syscall, O(1) regardless of tree size,
//      reporting the filesystem's FREE BLOCKS and FREE INODES. This is the direct O(1)
//      analogue of the byte/file totals it replaces: work that writes bytes consumes blocks,
//      work that creates files consumes inodes, and a lock-file re-touch consumes neither.
//      Critically it sees writes at ANY depth and inside ignored directories (`node_modules`,
//      `.cache`, build output) — the deep writes a depth-bounded read alone would miss.
//   2. `find <ws> -maxdepth PROBE_TREE_MAXDEPTH -printf … | cksum` — a digest of the
//      workspace's TOP LEVELS only (type, size, mtime of each entry), bounded by the
//      workspace's top-level BREADTH (hundreds to a few thousand entries) and NOT by its
//      total inode count. This is the workspace-SCOPED half: it moves when this run's tree
//      changes shape, independent of anything else on the host.
//
// HONEST LIMITATION OF (1): statfs is FILESYSTEM-wide, not workspace-scoped, and a
// long-lived runner can host several `/workspace/runs/*` at once. A co-tenant run's writes
// can therefore keep this component moving while THIS step is wedged — i.e. the error is
// toward reading PROGRESS, never toward a false stall. That direction is deliberate and
// matches the doctrine ("a process making genuine progress is NEVER terminated"): the
// remaining wedge detection comes from the output half of the work signature, from the
// workspace-scoped component (2), and from the transport's dead-socket keepalive. The
// component this replaced had the mirror-image error — it aborted healthy work — which is
// the failure actually observed in production.

// How deep the workspace-scoped half of the probe descends. The point of the bound is that
// the probe's cost is a function of the workspace's top-level BREADTH, never of how deep or
// how large the tree grows: unpacking 500k files under `node_modules/<pkg>/…` adds nothing
// at depth <= 2. Depth 2 covers the workspace's own top-level dirs and their immediate
// contents, which is where a run's structural change shows up.
export const PROBE_TREE_MAXDEPTH = 2;

// Build the `livenessProbe` for a workspace-bound op. Each tick runs the two bounded reads
// described above in ONE side-channel command and folds them into the work-state SIGNATURE.
// That command runs under a short connect-establishment bound (PROBE_CONNECT_MS) so a wedged
// side-channel cannot stall the tick.
//
// A probe that could not READ the workspace returns `{ observed: false }` — explicitly NOT a
// signature, and explicitly NOT evidence of non-progress (F-10). The substrate keeps those
// ticks out of the progress fixed-point read entirely and tracks them on their own streak, so
// a slow or failing side-channel can no longer be re-told as "the step stalled". Returns
// undefined (no probe at all) when there is no workspace to watch — the output-only class.
function buildWorkspaceLivenessProbe(
  substrate: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
): LivenessProbe {
  const ws = quoteSshShellArg(workspace);
  // `stat -f` (statfs: free blocks, free inodes) then a depth-bounded digest of the tree's
  // top levels. `&&` so a failed statfs exits nonzero and the whole read reports itself
  // UNOBSERVABLE rather than silently degrading. `-printf`/`stat -c` are GNU (the runner
  // image is debian-based); `2>/dev/null` on the walk swallows the benign race where a file
  // is removed mid-read (itself a sign of life).
  const command =
    `stat -f -c '%f %d' ${ws} && ` +
    `find ${ws} -maxdepth ${PROBE_TREE_MAXDEPTH} -printf '%y %s %T@\\n' 2>/dev/null | cksum`;
  return async (): Promise<ProbeObservation> => {
    const result = await substrate.run(target, {
      command,
      connectTimeoutMs: PROBE_CONNECT_MS,
      // The probe's own output is four integers; it is never load-bearing beyond that.
      outputRetention: "bounded",
    });
    if (result.failure !== undefined || result.stalled === true) {
      return { observed: false, reason: "unreachable" };
    }
    if (result.exitCode !== 0) {
      return { observed: false, reason: "probe_failed" };
    }
    // "<free-blocks> <free-inodes>\n<crc> <bytes>" — exactly four non-negative integers.
    const parts = result.stdout.trim().split(/\s+/u);
    if (parts.length !== 4 || !parts.every((part) => /^\d+$/u.test(part))) {
      return { observed: false, reason: "unparseable" };
    }
    // The workspace signature IS the fold: ANY of the four moving is forward motion (blocks
    // or inodes consumed, or the top-level tree changing shape); all four holding is no new
    // work, even while a lock file's mtime keeps ticking underneath.
    return { observed: true, signature: `ws:${parts.join(":")}` };
  };
}

// Inputs a call site threads to build its watchdog. `workspace` is the runner-local
// path whose touches mean "still working" (a git/jj/build/gate op); omit it for an
// output-only class with no workspace to watch.
//
// `onProgress` is the optional CROSS-LAYER sign-of-life bridge (task #24, apex v52/v53):
// on every probe tick the substrate reads the work signature as ADVANCING, it invokes
// this callback. Writers thread a closure that emits `writer.subtask.progress` so any
// parent progress reader observes a durable per-tick advancement signal — see
// contracts/commandSubstrate.ts WatchdogProgressSignal for the doctrine. Composes with
// the substrate-internal `MIN_NON_ADVANCING_NEIGHBOR_REPEATS_*` streak floor (below)
// so a legitimately slow writer whose signature briefly plateaus does not trip a
// spurious wedge. No-op when omitted (the default for non-writer call sites — vcs/infra
// ops do not need the bridge because their start/end is already a meaningful events emission).
export interface WatchdogInput {
  substrate: CommandSubstrate;
  target: RunnerHandle;
  cls: WatchdogClass;
  workspace?: string;
  onProgress?: (signal: WatchdogProgressSignal) => void;
}

// THE shared constructor. Returns the right `ActivityWatchdog` for the call class —
// always unbounded in time, always output-driven, with a workspace liveness probe
// attached for the silent classes (agent/vcs) when a workspace is known. Default
// reaction is "surface" (a recoverable stall the caller re-drives), NEVER a
// wall-clock kill. Callers pass the result as `RunnerCommand.watchdog`.
export function buildActivityWatchdog(input: WatchdogInput): ActivityWatchdog {
  const wantsProbe = (input.cls === "agent" || input.cls === "vcs") && input.workspace !== undefined;
  const watchdog: ActivityWatchdog = {
    probeIntervalMs: PROBE_CADENCE_MS,
    onQuiet: "surface",
    // CLASS-SPECIFIC identical-neighbor STREAK floor (apex v76/v77). The agent class widens
    // the floor to tolerate Codex's think-then-stream burst pattern (~9k bytes, then 30-60s
    // silent generation, then more streaming — a 2-neighbor floor fires a false-positive
    // wedge mid-generation). vcs/infra keep the historic 2-neighbor floor. STILL a streak
    // ceiling on signature identity, NEVER an elapsed-time budget.
    minNonAdvancingRepeats:
      input.cls === "agent" ? MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT : MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS,
  };
  if (wantsProbe) {
    watchdog.livenessProbe = buildWorkspaceLivenessProbe(input.substrate, input.target, input.workspace as string);
  }
  // Forward the optional cross-layer sign-of-life bridge (task #24). When the caller
  // (a writer adapter) supplies one, the substrate's tickWatchdog invokes it on every
  // tick the work signature advanced — see WatchdogProgressSignal in commandSubstrate.ts.
  if (input.onProgress !== undefined) {
    watchdog.onProgress = input.onProgress;
  }
  return watchdog;
}

// Convenience: the output-only watchdog for a call class with no workspace to probe
// (a capture, an answerer schema write, a usage read). Output remains the primary
// tick; on a genuine silent death the substrate surfaces a recoverable stall.
export function outputOnlyWatchdog(): ActivityWatchdog {
  return { probeIntervalMs: PROBE_CADENCE_MS, onQuiet: "surface" };
}
