// The COMMAND SUBSTRATE seam — the backend-neutral boundary at which the
// orchestrator runs a command inside an allocated runner. This is the single
// swappable boundary every backend must satisfy: the engine never knows whether
// the command runs over SSH to a container/VM, a native-exec API (Sprites /
// Daytona), or a micro-VM (Fly Machines). It only knows it hands a
// {@link RunnerHandle} + a {@link RunnerCommand} to a `CommandSubstrate` and
// gets a {@link CommandResult} back.
//
// The handle is OPAQUE at this contract: the substrate that produced it knows
// how to reach the runner (the SSH impl's handle carries host/port/identity;
// see {@link RunnerHandle} in ./allocator.js). Engine code threads the handle
// through unchanged — it never reads transport fields off it.
//
// SSH is the ONE concrete impl today ({@link SshCommandSubstrate} in
// engine/ssh/ssh2Substrate.ts). New backends slot in as a new `CommandSubstrate`
// impl (a documented seam arm), NOT a refactor of the consumers.
import type { Failure } from "../failure.js";
import type { RunnerHandle } from "./allocator.js";

// One command to run in a runner. Backend-neutral: stdin is piped, cwd scopes the
// working directory. The substrate redacts none of this into logs — the command
// string / stdin / any materialized identity never leave the substrate impl.
//
// HANG DETECTION — the doctrine (feedback_no_timeouts_progress_based, BINDING):
// Tanren has ZERO arbitrary wall-clock kills. A working process is NEVER killed,
// regardless of total elapsed time ("10 minutes is nothing to an AI agent"). A
// command bounds itself on SIGNS OF LIFE, not duration, via the `watchdog` — the
// SOLE hang detector. There is NO wall-clock kill of the running command: the only
// time bound in this contract is `connectTimeoutMs`, the legitimate TCP/SSH
// HANDSHAKE bound (a dead handshake has no work to lose).
// How much of a command's captured output the substrate RETAINS IN MEMORY. This is a
// memory-residency policy, NOT a safety budget — nothing here bounds, kills, or gives up
// on the running command (it still runs UNBOUNDED under the `watchdog`).
//
//   - `"full"`   (DEFAULT) — every byte, exactly as before. Required by the ~19 consumers
//                that reconstruct a whole file read back over SSH, parse the whole stream,
//                or COUNT regex matches across all of it. Several of those hard-throw on a
//                short/malformed stream, so completeness is load-bearing and must never be
//                taken away implicitly.
//   - `"bounded"` — retain a head + tail only (see engine/ssh/boundedOutput.ts). An
//                OPT-IN a call site may declare only when it can show the whole stream is
//                not load-bearing — e.g. a gate step whose sole output consumer is a
//                4 000-char `tailOf(...)`. The elision is reported OUT OF BAND on the
//                result; the retained body carries only real bytes, cut on line
//                boundaries, with no synthetic marker a parser could choke on.
export type OutputRetention = "full" | "bounded";

export interface RunnerCommand {
  command: string;
  cwd?: string;
  stdin?: string;
  // Memory-residency policy for this command's captured output. Defaults to `"full"`.
  // See {@link OutputRetention} — declaring `"bounded"` is a per-call-site assertion that
  // no consumer of THIS command's result needs the complete stream.
  outputRetention?: OutputRetention;
  // The legitimate connect-ESTABLISHMENT bound: how long to wait for the SSH
  // transport to come up (TCP connect + handshake/auth) before giving up on a
  // connection that never established. This is NOT a kill budget on the running
  // command — once the channel is up the command runs UNBOUNDED, governed only by
  // the `watchdog`. Optional; the substrate applies a sane default handshake bound.
  connectTimeoutMs?: number;
  // The PROGRESS-BASED hang detector (the doctrine's only safety mechanism for a
  // running command). The substrate bounds the command on the ABSENCE of all signs
  // of life (see ActivityWatchdog), never on elapsed time, and NEVER kills a process
  // that shows any activity. Construct it via the shared `buildActivityWatchdog`
  // factory (engine/ssh/activityWatchdog.ts) per call class. When omitted, the
  // substrate runs a default output-driven watchdog (no probe) — still no time kill.
  watchdog?: ActivityWatchdog;
}

// An OUT-OF-BAND WORK-SIGNATURE probe: between bursts of output, the watchdog ticks
// this to read the remote work's current SIGNATURE for SILENT ops (a `jj rebase` that
// emits nothing for minutes is still legitimately working). It returns a STABLE STRING
// fingerprint of the work's observable state — the newest workspace mtime (a build/jj
// writes files as it advances), optionally folded with a tree/size summary. The
// substrate compares the SEQUENCE of these signatures (folded with the output tail) for
// genuine ADVANCEMENT via the convergence detector, NOT merely "did a timer elapse":
//   - a CHANGING signature (mtime advanced / new output) = real progress → continue UNBOUNDED;
//   - a FIXED signature across successive checks (no new output AND no workspace advance)
//     = a wedged process — busy-but-not-advancing (an infinite loop spewing identical
//     lines, a CPU-burn) OR dead/zombied — and SURFACES a recoverable stall.
// It returns `undefined` when the runner is UNREACHABLE (the side-channel itself could
// not run / the workspace is gone): no signal at all, which the substrate treats as an
// absence of life. This is the PRIMARY progress mechanism for silent ops — it reads an
// actual work signal, never a clock.
export type LivenessProbe = () => Promise<string | undefined>;

// How the watchdog reacts when it observes a GENUINE absence of all signs of life
// (no output, the probe reports no liveness): SURFACE a recoverable `stalled` result
// the caller can re-drive (default — preferred over destroying possibly-recoverable
// work), or KILL the transport (a hard `client.destroy()`, only where a stalled
// connection has demonstrably nothing left to do).
export type OnQuiet = "surface" | "kill";

// The PROGRESS-BASED hang detector for one command — the doctrine's replacement for a
// wall-clock kill. It is driven by ADVANCEMENT of a WORK SIGNATURE, never by elapsed time:
//
//   - It RESETS on genuine PROGRESS: every stdout/stderr output chunk that adds NEW content
//     (the primary tick — for a streaming agent like `codex --json` every telemetry line is
//     a token/log = forward motion), AND every workspace-signature ADVANCE the `livenessProbe`
//     reports (the primary mechanism for SILENT ops — mtime advanced, files written). Any
//     genuine advance → reset → continue UNBOUNDED, no matter the total elapsed time.
//   - It FIRES only when the WORK SIGNATURE is at a FIXED POINT across successive checks: no
//     new output AND no workspace advance. That covers BOTH a dead / zombied / deadlocked
//     process (no signal) AND a WEDGED-BUT-BUSY process (alive — an infinite loop emitting
//     BYTE-IDENTICAL output forever, or burning CPU touching nothing — but making NO new
//     work). The fixed-point verdict is a pure STREAK read over the work-signature sequence
//     (the trailing count of consecutive identical signatures reaching the class-specific
//     `minNonAdvancingRepeats` floor — see `isWedgedNonAdvancing` in ssh/watchdogProgress.ts) —
//     signature IDENTITY, not a duration. A process producing genuinely-new output / advancing
//     the workspace is NEVER flagged.
//
// `livenessProbe` is the PRIMARY mechanism, not an afterthought: the interface returns a
// WORK SIGNATURE (a fingerprint of the remote work state), NOT a duration. A bare "no output
// for N ms" gauge alone is a DISGUISED timeout (forbidden + lint-flagged). The watchdog ticks
// the probe between output; `probeIntervalMs` is the cadence of those checks (a poll INTERVAL,
// not a budget — it never accumulates toward a kill), and the surface/kill decision is made
// only when the convergence detector reads the work signature as a fixed point (non-advancing).
// `onQuiet` defaults to `"surface"`.
export interface ActivityWatchdog {
  livenessProbe?: LivenessProbe;
  // How often to consult `livenessProbe` between output chunks (poll cadence, NOT a
  // total-duration budget — it resets the same as output does). Defaults to a modest
  // cadence in the substrate. Bless this as an interval, never a deadline.
  probeIntervalMs?: number;
  onQuiet?: OnQuiet;
  // CROSS-LAYER sign-of-life bridge (task #24, apex v52/v53). On every probe tick the
  // watchdog reads the work signature as ADVANCING (new distinct output OR an advancing
  // workspace count+bytes), it invokes `onProgress`. The writer pipeline binds this to a
  // `writer.subtask.progress` event — a durable per-tick advancement signal any parent
  // progress reader can observe. Composes with the substrate-internal
  // `MIN_NON_ADVANCING_NEIGHBOR_REPEATS_*` streak floor (see below): the watchdog tolerates
  // a legitimately slow writer turn whose work signature briefly plateaus across a single
  // mid-IO-burst probe (the `pnpm install` case) via the streak floor, and the bridged
  // event lets any parent reader observe the writer as still advancing across ticks. The
  // callback is FIRE-AND-FORGET (sync); a throw is caught by the substrate so an
  // event-emit failure cannot bubble into the tick.
  onProgress?: (signal: WatchdogProgressSignal) => void;
  // The CLASS-SPECIFIC identical-neighbor STREAK floor the substrate applies before declaring
  // the work signature at a fixed point (apex v76/v77). NOT an elapsed-time budget: it is the
  // minimum count of consecutive identical-neighbor probe pairs required before the wedge
  // fires. The `buildActivityWatchdog` factory sets this per-class:
  //   - vcs / infra → the historic 2-neighbor floor (a `pnpm install` plateau tolerated)
  //   - agent      → the widened 5-neighbor floor (Codex's think-then-stream burst pattern:
  //                  ~9k bytes then 30-60s silent generation — a 2 floor false-positives)
  // Optional; the substrate defaults to the vcs floor when omitted.
  // arch-allow: timeout-class — STREAK ceiling on signature identity, not elapsed time.
  minNonAdvancingRepeats?: number;
}

// The sign-of-life signal the substrate emits to `onProgress` on every probe tick the
// WORK SIGNATURE advances. `outputBytesAdvanced` is the byte length of the new-distinct
// output snapshotted into the tick's work signature (zero on a probe-only advance — a
// silent op whose workspace signature alone moved). `workspaceSignature` is the workspace
// count+bytes pair the liveness probe returned this tick (undefined on an output-only
// watchdog with no probe attached, or when the probe was unreachable this tick).
// `workSignatureAdvanced` is a literal `true` — the substrate only invokes `onProgress`
// when the signature genuinely advanced; the field is the type-level proof of that
// invariant for downstream readers.
export interface WatchdogProgressSignal {
  outputBytesAdvanced: number;
  workspaceSignature?: string;
  workSignatureAdvanced: true;
}

// The outcome of one command. A substrate (transport) failure is reported
// IN-BAND via `failure` rather than thrown, so consumers branch on the result
// shape uniformly across backends. `exitCode` is the runner process's code
// (null when the command never produced one — e.g. a connection failure).
//
// `stalled` is the SOLE no-progress flag (the wall-clock `timedOut` is gone): the
// watchdog observed a genuine absence of all signs of life — a dead/zombied/
// deadlocked process or a dead connection — and SURFACED a recoverable stall (the
// caller re-drives). It is NEVER a time-based kill of working work. `quietForMs` is
// evidence — how long since the last observed sign of life when the watchdog fired
// (diagnostic only; NOT the trigger, which is the probe verdict).
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal?: string;
  stalled?: boolean;
  quietForMs?: number;
  failure?: Failure;
  // OUT-OF-BAND elision accounting (F-9). Present and > 0 only when the command declared
  // `outputRetention: "bounded"` AND the stream exceeded the retained head + tail. The
  // count is deliberately NOT a marker inside the body: an injected `[… elided …]` line
  // would be parsed as a JSONL event, a `git log` record, or a NUL-framed path by real
  // consumers, and would be counted by a `matchAll` evidence check. A consumer that needs
  // to know its view is partial reads THIS, and `stdout.length + stdoutElidedChars` is the
  // exact number of chars the command emitted.
  stdoutElidedChars?: number;
  stderrElidedChars?: number;
}

// THE seam. `run()` executes one command in the runner the handle addresses.
// Backend-neutral vocabulary: an SSH backend speaks ssh2, a native-exec backend
// calls its exec API — the engine sees only this method.
export interface CommandSubstrate {
  run(handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult>;
}

// A no-op CommandSubstrate for unit paths that drive the workflow with fake
// writers (the command output is irrelevant to the assertion). TEST FIXTURE
// ONLY — never the live path.
export class FakeCommandSubstrate implements CommandSubstrate {
  async run(_handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    return {
      exitCode: 0,
      stdout: `fake command: ${command.command}`,
      stderr: "",
    };
  }
}
