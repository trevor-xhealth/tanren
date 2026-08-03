// Fail-closed boundary for an INVALID repo gate config (`.tanren/ci.yml`).
//
// The `.tanren/ci.yml` is BUILT-REPO / USER data. A malformed one (bad YAML, or a
// shape the `CiConfigV1` schema rejects) must NEVER escape as an unhandled throw —
// that is the v25-apex crash class (an invalid built-repo config crash-looped the
// shared worker, the same family as the v21 ssh2-'error' crash #342). It is instead
// a LOUD, RUN-SCOPED gate FAILURE: the gate did not pass (fail-closed — an
// unreadable/invalid gate config is NEVER "passed"), the run records the reason, and
// the in-loop triage turns the failed gate into a P0 finding ("the repo's
// `.tanren/ci.yml` is invalid: <issues>") via `gateFindings` so the spec loop can fix
// the config in-place (or escalate). The WORKER survives — one run's bad config can
// never take down the process that serves every run.
//
// This module performs no execution. It only classifies a config-resolution error and
// projects it onto the gate's existing `{ passed: false }` result shape.
import {
  CiConfigValidationError,
  CiYamlParseError,
  GateContractBaselineError,
  GateContractWeakenedError,
  type CiWhen,
} from "../../ci/index.js";
import type { GateAppendEvent } from "./runGateTier.js";
import type { GateOutcome } from "./runGateForWhen.js";

/**
 * The gate-contract errors this boundary projects onto a fail-closed gate FAILURE. All four are
 * "the repo's gate contract cannot be used to judge this head", and all four are writer/operator
 * fixable in-place — as opposed to a substrate read fault, which keeps its loud-throw semantics.
 */
export type UnusableCiConfigError =
  | CiConfigValidationError
  | CiYamlParseError
  | GateContractWeakenedError
  | GateContractBaselineError;

// The synthetic tier/step names the invalid-config failure surfaces under. They are
// STABLE so a recurring invalid-config failure dedupes across loop iterations (the
// `gateFindings` id is `gate-<tier>-<step>`), exactly like a real recurring gate
// failure — the convergence answerer reasons over the stable id.
export const CI_CONFIG_GATE_TIER = "tanren-ci-config";
export const CI_CONFIG_GATE_STEP = "validate";

/**
 * True iff `error` means the head's `.tanren/ci.yml` cannot legitimately judge this run — the
 * gate-config boundary's "the repo's contract is unusable" family: schema-invalid, YAML-syntax,
 * the head WEAKENING the contract it is graded by (`GateContractWeakenedError`), or an
 * explicitly-named contract baseline that could not be read (`GateContractBaselineError` — fail
 * closed: unable to tell whether the bar was lowered is not permission to lower it).
 *
 * A read FAILURE (substrate/timeout) is DELIBERATELY excluded: that is a transient substrate
 * fault (`GateConfigReadError`), not the repo shipping an unusable contract, and must keep its
 * existing loud-throw → run-fail semantics (no-silent-fallback: a substrate hiccup must never be
 * recast as a fixable config finding).
 */
export function isInvalidCiConfigError(error: unknown): error is UnusableCiConfigError {
  return (
    error instanceof CiConfigValidationError ||
    error instanceof CiYamlParseError ||
    error instanceof GateContractWeakenedError ||
    error instanceof GateContractBaselineError
  );
}

/**
 * Project an invalid-`.tanren/ci.yml` error onto a FAILED `GateOutcome`, and emit a
 * `gate.failed` event so the run timeline records the broken config loudly (the
 * verdict is NOT emitted — there is no validated config to gate a commit against, and
 * a verdict implies a tier actually ran). The returned outcome carries the validation
 * issues in `outputTail`, so both `gateReason` (writer-loop steering) and
 * `gateFindings` (the P0 finding body) surface WHICH config issues to fix.
 *
 * Fail-closed: `passed` is `false`. An invalid gate config can never be a vacuous
 * pass — the merge authority must see the gate as not-passed until the repo's config
 * is fixed.
 */
export async function invalidCiConfigGateOutcome(
  error: UnusableCiConfigError,
  when: CiWhen,
  appendEvent: GateAppendEvent,
  taskId?: string,
): Promise<Extract<GateOutcome, { passed: false }>> {
  const failure = {
    passed: false as const,
    tier: CI_CONFIG_GATE_TIER,
    when,
    failedStep: CI_CONFIG_GATE_STEP,
    // No process exit code: the config never RAN — it failed validation before any
    // tier could execute. `null` is the "no exit code" sentinel the finding renders.
    exitCode: null,
    steps: [
      {
        name: CI_CONFIG_GATE_STEP,
        run: "resolve .tanren/ci.yml",
        exitCode: null,
        passed: false,
        timedOut: false,
        // The full validation message (`invalid tanren-ci.yml: <issues>`) so the
        // finding/steering names exactly what to fix in the repo's config.
        outputTail: error.message,
      },
    ],
  };
  await appendEvent(
    "gate.failed",
    {
      tier: CI_CONFIG_GATE_TIER,
      when,
      failedStep: CI_CONFIG_GATE_STEP,
      exitCode: null,
      steps: failure.steps,
    },
    taskId,
  );
  return { passed: false, results: [failure], failure };
}
