// The bounded diagnostic every workspace-step failure carries. Extracted from
// ./bootstrap.ts so the toolchain-provision path (./toolchainProvision.ts) surfaces
// byte-identical diagnostics without either module importing the other.
import type { CommandResult } from "../contracts/commandSubstrate.js";

// Output can be large; a typed workspace error keeps only the last N characters so the
// error and the recovery surface carry a useful, bounded diagnostic.
export const OUTPUT_TAIL_LIMIT = 4_000;

/** stdout + stderr (+ the substrate's own failure detail, when there is one). */
export function combinedOutput(result: CommandResult): string {
  if (result.failure !== undefined) {
    const detail = "message" in result.failure ? result.failure.message : result.failure.reason;
    return [result.stdout, result.stderr, detail].filter((part) => part !== undefined && part !== "").join("\n");
  }
  return [result.stdout, result.stderr].filter((part) => part !== "").join("\n");
}

/** The trailing {@link OUTPUT_TAIL_LIMIT} characters of `output`. */
export function tailOf(output: string): string {
  if (output.length <= OUTPUT_TAIL_LIMIT) {
    return output;
  }
  return output.slice(output.length - OUTPUT_TAIL_LIMIT);
}

/** The shared "why did this step not succeed" clause. */
export function failureReason(exitCode: number | null, stalled: boolean): string {
  return stalled ? "stalled (no sign of life)" : `exited ${exitCode ?? "unknown"}`;
}

/** True iff an SSH result is a clean, complete, zero-exit success. */
export function commandSucceeded(result: CommandResult): boolean {
  return result.failure === undefined && result.stalled !== true && result.exitCode === 0;
}
