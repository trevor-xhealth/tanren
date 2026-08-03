// WATCHDOG WORK-SIGNATURE PROGRESS — the backstop that closes the genuine-hang gap in the
// ActivityWatchdog (feedback_no_timeouts_progress_based, BINDING). The watchdog's primary
// signal is streamed output + an out-of-band liveness probe, both of which reset on ANY sign
// of life. That correctly NEVER kills working work — but on its own it cannot distinguish a
// process that is ALIVE-AND-ADVANCING from one that is ALIVE-BUT-WEDGED (an infinite loop
// spewing BYTE-IDENTICAL output forever, or burning CPU / touching files with no NEW work).
// The wedged-busy case reads "alive" forever and would run TRULY FOREVER with no escalation.
//
// This module adds a PROGRESS assessment LAYERED over liveness — using the convergence
// philosophy, NOT a clock. On the existing probe poll CADENCE (a legitimate interval, never a
// deadline) the substrate snapshots a WORK SIGNATURE of the exec (a fold of the NEW DISTINCT
// OUTPUT since the prior snapshot and the remote WORKSPACE signature) and folds the SEQUENCE
// of signatures into a pure STREAK read: the trailing count of CONSECUTIVE identical
// signatures at the trailing edge. A signature that keeps CHANGING (new distinct output OR
// an advancing workspace) is genuine progress -> continue UNBOUNDED (the common case — never
// kill working work). A signature that stays FIXED across enough successive checks (the
// class-specific `minNonAdvancingRepeats` streak floor) is a genuine wedge -> SURFACE a
// recoverable stall.
//
// KEY (so a reviewer and the architecture-timeouts lint both see it): the trigger is
// signature IDENTITY (non-advancement of a work signature), NOT elapsed time. A process
// emitting genuinely-new output / advancing the workspace resets it forever, no matter how
// long it has run. The poll cadence is a legitimate interval. There is no quiet-window, no
// duration threshold, no attempt cap — the decision is purely a structural read (a streak
// count) over the work-signature history.

import { createHash } from "node:crypto";

// The trailing window of work signatures kept in memory — a bound on the in-memory history,
// large enough to accommodate the widest class-specific streak floor with margin. NOT an
// attempt cap and NOT a give-up budget: the command runs UNBOUNDED while the signature
// advances regardless of how many checks elapse; the window only bounds how far back the
// trailing STREAK count can look (a still-advancing signature trajectory of any length is
// always progress). Must be strictly greater than MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT + 1
// (the widest floor requires that many identical signatures) so a wedge is always
// representable — currently 5 + 1 = 6 signatures suffice; the window keeps 8 for headroom.
export const WORK_SIGNATURE_WINDOW = 8;

// Fold the recent OUTPUT CONTENT and the remote WORKSPACE signature into one stable work-state
// fingerprint. `outputContent` is the distinctRecentOutput summary of the output seen since the
// prior snapshot; `workspaceSignature` is what the liveness probe OBSERVED (blocks/inodes
// consumed, folded with a depth-bounded digest of the workspace's top levels).
//
// `undefined` here means the watchdog has NO probe attached at all (the output-only class) —
// we fold a fixed sentinel so output alone decides. It does NOT mean "the probe could not
// see the runner": that case never reaches this function, because an UNOBSERVABLE probe is
// the absence of evidence rather than evidence of non-progress and is routed away from the
// work-signature history entirely (F-10 — see MIN_UNOBSERVABLE_PROBE_REPEATS below).
export function workSignature(outputContent: string, workspaceSignature: string | undefined): string {
  const hash = createHash("sha256");
  hash.update(outputContent);
  hash.update(" ");
  hash.update(workspaceSignature ?? " unreachable");
  return hash.digest("hex");
}

// The DISTINCT-CONTENT summary of the output that arrived SINCE the prior snapshot — the
// rate-independent "is there NEW distinct work?" signal fed into workSignature. `priorLen` is
// how many chars of the combined stdout+stderr had already been snapshotted; we look only at
// the increment [priorLen, end). We DEDUP the increment's non-blank lines so the signal is
// independent of HOW FAST the process repeats: a wedged loop spewing the SAME line — whether 1
// copy or 1000 copies this tick — collapses to the SAME distinct set -> an unchanging
// signature. A genuinely-streaming process emits NEW distinct lines -> a changing set ->
// advancement. Returns the new combined length too, so the caller advances its `priorLen`.
export function distinctRecentOutput(combined: string, priorLen: number): { content: string; length: number } {
  const increment = priorLen < combined.length ? combined.slice(priorLen) : "";
  const distinct = [...new Set(increment.split("\n").filter((line) => line.length > 0))].sort();
  return { content: distinct.join("\n"), length: combined.length };
}

// Append a work signature to a trailing history, clamped to {@link WORK_SIGNATURE_WINDOW}.
// Clamping keeps the in-memory history bounded WITHOUT being an attempt cap (the window is the
// cycle look-back, not a budget — a still-advancing trajectory of any length is progress).
export function appendWorkSignature(history: ReadonlyArray<string>, signature: string): string[] {
  const next = [...history, signature];
  return next.length > WORK_SIGNATURE_WINDOW ? next.slice(next.length - WORK_SIGNATURE_WINDOW) : next;
}

// The count of CONSECUTIVE identical work signatures at the trailing edge of the history —
// i.e. how many of the most recent immediate-neighbor pairs are byte-identical. A pair that
// genuinely advances (a distinct new signature) breaks the run. PURE (no I/O, no clock): the
// verdict is signature IDENTITY, never elapsed time. Returns 0 when the trailing pair is
// itself advancing. This is the SOLE fixed-point diagnostic the watchdog uses — cycle
// detection (an A→B→A→B oscillation across intervening attempts) is deliberately NOT applied
// here because the convergence-detector cycle branch double-fires on pure identical sequences
// (an all-identical history reads as both an immediate-neighbor identity streak AND a cycle
// with itself as the intervening state), which would collapse the widened AGENT streak floor
// back onto the historic 3-identical wedge point and defeat the whole apex v76/v77 fix. The
// watchdog's stall semantic IS "no new distinct work for N consecutive probe ticks" — the
// streak count directly encodes that, no convergence-detector layering required.
function trailingIdenticalPairStreak(signatures: ReadonlyArray<string>): number {
  let streak = 0;
  for (let i = signatures.length - 1; i >= 1; i -= 1) {
    if (signatures[i] !== signatures[i - 1]) break;
    streak += 1;
  }
  return streak;
}

// The MINIMUM trailing run of CONSECUTIVE identical work-signature probes the watchdog
// requires before declaring a fixed point. NOT an elapsed-time budget and NOT an attempt cap
// — it is a STREAK ceiling on the trailing identical-neighbor-pair count. The floor is
// CLASS-SPECIFIC (apex v76/v77) because different call classes have different LEGITIMATE
// flat-signature windows:
//
//   - VCS (git/jj/gate; the `pnpm install` case — apex v50): a 1-neighbor floor killed
//     legitimate writers running `pnpm install` because codex is silent while the bash
//     subprocess runs (its stdout captured BY codex, not streamed) AND the workspace
//     count+bytes probe can read identical signature across a single 15s probe tick
//     mid-IO-burst (the filesystem batches flushes, the install resolves before extracting).
//     The 2-neighbor floor (≈30s of signature identity) is the honest floor for a vcs op
//     whose work signature legitimately holds flat across a single tick.
//
//   - AGENT (LLM writer/answerer — codex/claude/opencode; apex v76/v77): the vcs 2-neighbor
//     floor was ALSO killing legitimate agent execs, at ~60% rate on tiny 350-char subtasks
//     in apex v77 (10 failed / 6 completed). Root cause: Codex CLI is a BURST-STREAM — it
//     emits ~9k bytes in one tick, then goes internally silent for 30-60s while generating
//     the next chunk, then emits more. During the silent-generation phase distinctRecentOutput
//     is empty (no new distinct lines) AND the workspace is unchanged, so the work signature
//     holds flat across 2 consecutive probe ticks (~30s) → the vcs floor fires a false-positive
//     wedge → writer.subtask.failed with failureKind="timeout". A 5-neighbor floor (≈75s of
//     signature identity, streak of 5 pairs across the 15s cadence) tolerates the burst-stream
//     cycle with margin, still surfacing a wedge on a genuinely dead agent — still progress /
//     sign-of-life-based (a genuinely-advancing signature resets it forever regardless of
//     length), just tuned for the empirical Codex think-then-stream pattern.
//
// arch-allow: timeout-class — STREAK ceiling on signature identity, not elapsed time.
export const MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS = 2;
// arch-allow: timeout-class — STREAK ceiling on signature identity, not elapsed time.
// EMPIRICAL BASIS (apex v77): Codex CLI streams ~9k bytes in one tick, then generates silently
// for 30-60s, then streams more. A 2-neighbor floor (30s) fires a false-positive wedge mid
// silent-generation; a 5-neighbor floor (75s) tolerates the burst-stream cycle with margin.
// DO NOT tighten this back to 2 without new evidence — the Codex burst pattern has not changed.
export const MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT = 5;

// The MINIMUM run of CONSECUTIVE probe ticks that OBSERVED NOTHING AT ALL before the substrate
// surfaces a distinguishable `probe_unobservable` stall (F-10). NOT an elapsed-time budget and
// NOT a retry cap — it is a STREAK ceiling on OBSERVATION OUTCOMES, the same structural read as
// the two floors above, over a different (and strictly weaker) kind of evidence.
//
// WHY THIS EXISTS AT ALL. The probe used to return `undefined` for BOTH "the workspace is
// genuinely flat" and "I could not see the workspace", and the substrate folded both into the
// same fixed sentinel. So two consecutive SLOW OR FAILED walks over a large tree reached the
// vcs 2-neighbor floor and aborted a perfectly healthy step — infrastructure slowness wearing
// the costume of a stalled agent. The fix separates the two: an OBSERVED flat workspace is
// evidence of non-progress and feeds the streak above; an UNOBSERVABLE probe is NO evidence
// either way and feeds nothing.
//
// WHY IT IS NOT ZERO (i.e. why "no evidence" is not simply ignored forever). If the probe were
// permanently blind — a workspace deleted underneath the step, a runner that answers SSH
// keepalive pings but can no longer exec — a genuinely wedged step would run forever with nothing
// left watching it. So a LONG consecutive run of blind ticks is itself a reportable condition,
// surfaced under its OWN kind so a caller can tell "the agent wedged" from "we lost sight of
// the runner" and re-drive accordingly. It is deliberately WIDER than either progress floor:
// absence of observation is weaker evidence than an observed fixed point, so it must take
// strictly longer to escalate. Any genuinely-new output resets it (a talking step is alive
// regardless of whether we can see its workspace).
export const MIN_UNOBSERVABLE_PROBE_REPEATS = 6;

// Is the exec WEDGED — its work signature at a FIXED POINT (non-advancing) across the trailing
// checks? Given the work-signature history (oldest->newest, the latest snapshot included),
// returns `true` iff the trailing identical-neighbor streak has reached the caller-supplied
// `minNonAdvancingRepeats` floor (defaulting to the vcs value — a single mid-IO-burst
// identical probe is not yet a wedge; see the constants above). The agent-class watchdog
// passes the widened `MIN_NON_ADVANCING_NEIGHBOR_REPEATS_AGENT` to tolerate Codex's
// think-then-stream burst pattern; vcs/infra keep the default. A first snapshot, or a
// CHANGING (advancing) signature, reads as progress -> `false` (continue UNBOUNDED). PURE
// (no I/O, no clock) so it is reproducible + property-testable — the decision is signature
// IDENTITY, never elapsed time.
export function isWedgedNonAdvancing(
  history: ReadonlyArray<string>,
  opts?: { minNonAdvancingRepeats?: number },
): boolean {
  const floor = Math.max(1, opts?.minNonAdvancingRepeats ?? MIN_NON_ADVANCING_NEIGHBOR_REPEATS_VCS);
  return trailingIdenticalPairStreak(history) >= floor;
}
