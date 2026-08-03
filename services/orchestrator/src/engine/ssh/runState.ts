// The PER-RUN capture state of one in-flight SSH command, and the shaping of that state
// into a `CommandResult`. Split out of ssh2Substrate.ts (which owns the ssh2 transport
// wiring and the watchdog tick) to keep both files under the 500-line cap.
//
// Everything here is BOUNDED by construction: the two retained streams honour the
// command's declared `outputRetention`, and the watchdog's view of output is a small
// drained window rather than a cursor into the retained buffers. See ssh/boundedOutput.ts
// for why (F-9). Nothing here bounds, kills, or gives up on the running command.
import type { SshRunnerHandle } from "../contracts/allocator.js";
import type { CommandResult, OutputRetention, StallKind } from "../contracts/commandSubstrate.js";
import { defineFailure } from "../failure.js";
import { RecentOutputWindow, RetainedOutput } from "./boundedOutput.js";

export interface RunState {
  // Captured output under the command's declared retention policy (F-9). `"full"` (the
  // default) is byte-for-byte the old `+=` accumulation; `"bounded"` retains a head + tail
  // and reports the elision out of band.
  stdout: RetainedOutput;
  stderr: RetainedOutput;
  // The trailing window of output the WATCHDOG fingerprints, drained on every probe tick.
  // It is a SEPARATE, bounded buffer rather than a cursor into the retained streams: the
  // old code re-concatenated `state.stdout + state.stderr` on EVERY tick (an O(total) copy
  // of a possibly hundreds-of-MB buffer every cadence) and indexed it by a char offset,
  // which additionally mis-tracked because stdout growth shifts the stderr region. Draining
  // a window is O(new output) and is unaffected by how much has been retained or elided.
  recentOutput: RecentOutputWindow;
  exitCode: number | null;
  signal?: string;
  settled: boolean;
  // Activity-watchdog state (the SOLE hang-detection path — there is no wall-clock kill
  // timer). `probeTimer` is the recurring work-signature poll tick. `lastActivityAt` marks
  // the most recent OUTPUT chunk (diagnostic only — feeds the `quietForMs` evidence);
  // `lastProbeTickAt` is when the watchdog last evaluated. `workSignatures` is the trailing
  // sequence of WORK SIGNATURES (new distinct output folded with the OBSERVED workspace
  // signature) the PROGRESS backstop reasons over via the shared convergence detector — a
  // CHANGING signature is genuine advancement (continue UNBOUNDED), a FIXED POINT is a wedge
  // (dead OR busy-but-not-advancing). None is a total-duration budget — the trigger is
  // signature identity, not elapsed time, so the command runs UNBOUNDED while it advances.
  probeTimer?: NodeJS.Timeout;
  lastActivityAt: number;
  lastProbeTickAt?: number;
  workSignatures: string[];
  // Is a liveness probe currently in flight? The tick runs on a `setInterval`, so without
  // this guard a probe slower than the cadence gets a SECOND probe stacked on top of it (and
  // a third, …), each opening its own SSH exec channel against an already-struggling runner
  // — the pile-up that made a slow walk slower still (F-10).
  probeInFlight: boolean;
  // Trailing run of CONSECUTIVE probe ticks that OBSERVED NOTHING. Kept apart from
  // `workSignatures` because "I could not see the workspace" is the ABSENCE of evidence, not
  // evidence of non-progress — see MIN_UNOBSERVABLE_PROBE_REPEATS in ssh/watchdogProgress.ts.
  unobservableProbeStreak: number;
}

export function createRunState(retention: OutputRetention): RunState {
  return {
    stdout: new RetainedOutput(retention),
    stderr: new RetainedOutput(retention),
    recentOutput: new RecentOutputWindow(),
    exitCode: null,
    settled: false,
    lastActivityAt: Date.now(),
    workSignatures: [],
    probeInFlight: false,
    unobservableProbeStreak: 0,
  };
}

// The captured-output fields of a result, materialized from the two retention buffers.
// `stdoutElidedChars`/`stderrElidedChars` are omitted when nothing was dropped, so a
// `"full"` result is byte-for-byte and field-for-field what it always was.
export function capturedOutput(
  state: RunState,
): Pick<CommandResult, "stdout" | "stderr" | "stdoutElidedChars" | "stderrElidedChars"> {
  const stdoutElided = state.stdout.elidedChars;
  const stderrElided = state.stderr.elidedChars;
  return {
    stdout: state.stdout.text(),
    stderr: state.stderr.text(),
    ...(stdoutElided > 0 ? { stdoutElidedChars: stdoutElided } : {}),
    ...(stderrElided > 0 ? { stderrElidedChars: stderrElided } : {}),
  };
}

// The `onQuiet: "kill"` failure message, which must name WHICH condition was observed — a
// wedged step and a runner we could not see are different incidents with different fixes,
// and conflating them is exactly the defect F-10 fixes.
export function stallKindMessage(stallKind: StallKind): string {
  return stallKind === "probe_unobservable"
    ? "SSH command's liveness probe could not observe the runner across successive checks and was terminated"
    : "SSH command showed no sign of life (dead/zombied/deadlocked) and was terminated";
}

export function sshFailureResult(target: SshRunnerHandle, message: string): CommandResult {
  return {
    exitCode: null,
    stdout: "",
    stderr: "",
    failure: defineFailure({ kind: "ssh_failed", target: formatTarget(target), message }),
  };
}

export function formatTarget(target: SshRunnerHandle): string {
  return `${target.username}@${target.host}:${target.port}`;
}

export function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
