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

// THE SHORTEST VALUE WORTH HIDING. Below this, a "secret" is more likely to be a flag
// (`1`, `true`, `dev`) whose bytes appear all over ordinary build output, and redacting it
// would shred the diagnostic while protecting nothing.
const MIN_REDACTABLE_VALUE = 8;

/**
 * Remove the PROJECT app-env VALUES from a captured output tail.
 *
 * WHAT WAS ACTUALLY GUARDED, AND WHAT WAS NOT. Every workspace door is careful that the
 * app-env prelude is prepended to the EXECUTED string only, never to the `command` field
 * that flows into the typed error — and each of them says, in a comment, that therefore "no
 * app-secret value can reach the error message or the emitted event payload". That claim
 * only ever covered the COMMAND. The same errors also carry `outputTail`, which is the
 * project's own stdout+stderr, and a repository's `setup.run` / `bootstrap.run` that echoes
 * a variable — `set -x`, a `printenv`, a curl with the token on the command line, a stack
 * trace quoting a DSN — puts the value straight into `WorkspaceSetupError.message`, and
 * from there into the `workspace.failed` / `run.failed` events (CWE-532). The prelude
 * discipline was real; the sentence describing it was wider than the thing it described.
 *
 * Applied at every door that captures output under an app env, not only the one it was
 * first noticed at: a redaction that covers one of three call sites is a redaction an
 * operator cannot rely on.
 *
 * NOT a claim that output is now secret-free. It removes the values TANREN INJECTED, which
 * are the ones Tanren knows; a project that prints a credential it read from its own file
 * is beyond this seam's knowledge. Longest-first so a value that contains another is not
 * left half-exposed by the shorter one's replacement.
 */
export function redactAppEnv(output: string, appEnv?: Record<string, string>): string {
  if (appEnv === undefined || output === "") return output;
  const secrets = Object.entries(appEnv)
    .filter(([, value]) => value.length >= MIN_REDACTABLE_VALUE)
    .sort(([, a], [, b]) => b.length - a.length);
  let redacted = output;
  for (const [key, value] of secrets) {
    redacted = redacted.split(value).join(`[redacted:${key}]`);
  }
  return redacted;
}
