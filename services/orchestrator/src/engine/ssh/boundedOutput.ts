// BOUNDED OUTPUT RETENTION — the memory bound on what the ORCHESTRATOR holds for one
// in-flight SSH command (F-9). This is a MEMORY-residency policy, not a safety budget:
// nothing here bounds, kills, or gives up on the running command. The command still runs
// UNBOUNDED under the ActivityWatchdog (feedback_no_timeouts_progress_based, BINDING) —
// we only stop retaining bytes nobody reads.
//
// THE DEFECT: the substrate folded EVERY chunk of EVERY command into one JavaScript
// string (`state.stdout += chunk.toString("utf8")`) with no cap, no ring, no spill to
// disk. On a 12k-file monorepo a single gate step (`just ci`) emits hundreds of MB; a
// handful of concurrent runs is enough to OOM the control plane, and the OOM kills every
// run on the worker, not just the noisy one.
//
// WHY THIS IS OPT-IN AND NOT THE DEFAULT: a survey of every production consumer of
// `CommandResult.stdout`/`stderr` found ~19 sites that need the COMPLETE stream, not a
// tail — they reconstruct a whole file read back over SSH (`cat` of a JUnit XML, a
// conflicted source file, a rotated `auth.json`), parse the whole stream (`sem diff
// --json`, agent JSONL telemetry, `git log --format`, a NUL-framed `git diff
// --name-only -z`), or COUNT regex matches across all of it (the gate's `stdout-count`
// evidence contract). Several of those HARD THROW on a malformed/short stream rather
// than degrading. So the substrate DEFAULTS to `"full"` (today's behavior, byte for
// byte) and a call site opts INTO `"bounded"` only when it can show the whole stream is
// not load-bearing. See ssh2Substrate.ts for the seam and runGateTier.ts for the first
// opt-in.
//
// TWO PROPERTIES THE SHAPE MUST HAVE (both learned from that survey):
//   1. HEAD **and** TAIL. Head-only loses the tail every `tailOf(...)` consumer reads and
//      the last-wins token-usage event; tail-only loses the early sentinels
//      (`DEPS_INSTALL_SENTINEL`, the `__TANREN_*_ABSENT__` markers) that are echoed first.
//   2. NO SYNTHETIC MARKER IN THE BODY. An injected `[… N chars elided …]` line is a
//      non-JSON JSONL line (bumps `malformedLineCount` → a spurious
//      `usage.token_accounting_failed`), an unparseable `git log` line (a hard throw), an
//      invalid NUL-framed path (a hard throw) and a candidate for a `matchAll` count. The
//      elision is therefore reported OUT OF BAND on the result
//      (`stdoutElidedChars`/`stderrElidedChars`) and the retained body contains only real
//      bytes, cut on LINE BOUNDARIES so no line is ever bisected.

// The retention policy itself lives on the backend-neutral contract (every substrate impl
// honours it), not here.
import type { OutputRetention } from "../contracts/commandSubstrate.js";

// How much of the START of a stream is retained under `"bounded"`. Sized to comfortably
// hold a command's preamble + the early sentinels that are echoed before the bulk output.
export const RETAINED_HEAD_CHARS = 64_000;

// How much of the END of a stream is retained under `"bounded"`. Two orders of magnitude
// above the largest tail any consumer reads (runGateTier's `OUTPUT_TAIL_LIMIT = 4_000`),
// so the bytes downstream actually reads stay byte-identical with a wide margin.
export const RETAINED_TAIL_CHARS = 512_000;

// The trailing slice of output the ActivityWatchdog fingerprints per probe tick. This
// exists so the watchdog never has to concatenate the whole retained stream to find the
// new bytes (the old `state.stdout + state.stderr` per tick was an O(total) copy every
// cadence — the second, quieter half of the same memory defect). The window is drained on
// each tick, so it only ever holds one cadence's worth of output; the cap is the backstop
// for a step that floods faster than the cadence.
export const RECENT_OUTPUT_WINDOW_CHARS = 256_000;

// How much slack a buffer may carry above its bound before it is re-trimmed. Trimming on
// every chunk would copy the whole retained tail per chunk (O(chunks x tail)); trimming at
// 2x and finalizing exactly on read keeps the amortized cost linear while the resident set
// stays bounded by a constant factor.
const TRIM_SLACK_FACTOR = 2;

/**
 * A head+tail bounded accumulator for one stream (stdout or stderr) of one command.
 *
 * Under `"full"` it is a plain accumulator — identical bytes to the `+=` it replaces.
 * Under `"bounded"` it retains the first {@link RETAINED_HEAD_CHARS} and the last
 * {@link RETAINED_TAIL_CHARS}, cutting on line boundaries, and reports how many chars it
 * dropped via {@link elidedChars} — it NEVER writes a marker into the body.
 */
export class RetainedOutput {
  #head = "";
  #tail = "";
  #headSealed = false;
  #total = 0;
  readonly #bounded: boolean;

  constructor(retention: OutputRetention) {
    this.#bounded = retention === "bounded";
  }

  append(chunk: string): void {
    this.#total += chunk.length;
    if (!this.#bounded) {
      this.#tail += chunk;
      return;
    }
    let rest = chunk;
    if (!this.#headSealed) {
      const room = RETAINED_HEAD_CHARS - this.#head.length;
      if (rest.length <= room) {
        this.#head += rest;
        return;
      }
      this.#head += rest.slice(0, room);
      this.#sealHead();
      rest = rest.slice(room);
    }
    this.#tail += rest;
    if (this.#tail.length > RETAINED_TAIL_CHARS * TRIM_SLACK_FACTOR) {
      this.#trimTail();
    }
  }

  /** The retained body: real bytes only, cut on line boundaries, no synthetic marker. */
  text(): string {
    if (this.#bounded) {
      this.#trimTail();
    }
    return this.#head + this.#tail;
  }

  /** How many chars were dropped between the retained head and the retained tail. */
  get elidedChars(): number {
    if (this.#bounded) {
      this.#trimTail();
    }
    return this.#total - this.#head.length - this.#tail.length;
  }

  /**
   * Seal the head at a LINE boundary, carrying the trailing partial line into the tail so
   * the two halves never bisect a line and no byte is lost while the tail still fits.
   */
  #sealHead(): void {
    this.#headSealed = true;
    const lastNewline = this.#head.lastIndexOf("\n");
    if (lastNewline === -1) {
      // A head with no newline at all (a NUL-framed or single-giant-line stream). Nothing
      // to cut on; keep the raw prefix. Such streams should not be opting into "bounded".
      return;
    }
    this.#tail = this.#head.slice(lastNewline + 1);
    this.#head = this.#head.slice(0, lastNewline + 1);
  }

  /** Drop the oldest chars of the tail down to the bound, cutting on a line boundary. */
  #trimTail(): void {
    if (this.#tail.length <= RETAINED_TAIL_CHARS) {
      return;
    }
    const overflow = this.#tail.length - RETAINED_TAIL_CHARS;
    const boundary = this.#tail.indexOf("\n", overflow);
    this.#tail = boundary === -1 ? this.#tail.slice(overflow) : this.#tail.slice(boundary + 1);
  }
}

/**
 * The trailing window of output the ActivityWatchdog fingerprints. Drained once per probe
 * tick, so it normally holds one cadence's output; the cap bounds the pathological case of
 * a step flooding faster than the cadence. Keeping the MOST RECENT chars (not the oldest)
 * preserves the watchdog's semantic exactly: "is there NEW distinct work since the last
 * check?".
 */
export class RecentOutputWindow {
  #buffer = "";

  append(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > RECENT_OUTPUT_WINDOW_CHARS * TRIM_SLACK_FACTOR) {
      this.#buffer = this.#buffer.slice(this.#buffer.length - RECENT_OUTPUT_WINDOW_CHARS);
    }
  }

  /** Take everything seen since the last drain and reset the window. */
  drain(): string {
    const seen =
      this.#buffer.length > RECENT_OUTPUT_WINDOW_CHARS
        ? this.#buffer.slice(this.#buffer.length - RECENT_OUTPUT_WINDOW_CHARS)
        : this.#buffer;
    this.#buffer = "";
    return seen;
  }
}
