// Fail-into-the-writer-loop boundary for a WRITER-AUTHORED workspace deps-install
// failure (`just bootstrap`).
//
// The per-gate `ensureWorkspaceDepsInstalled` runs the project's `just bootstrap`
// (deps install) over SSH before every gate. When that command exits nonzero it is
// almost always a defect in the WRITER's OWN authored scaffold — a `package.json`
// that does not install cleanly (e.g. pnpm 11's `ERR_PNPM_IGNORED_BUILDS`, a
// missing `pnpm.onlyBuiltDependencies`, a bad lockfile, a typo'd dependency). That
// is WRITER-FIXABLE: the writer re-authors the scaffold and bootstrap is retried.
//
// Today a `WorkspaceDepsInstallError` thrown inside the gate callback ESCAPES the
// run loop and terminally strands the spec (`needs_attention`) — denying the writer
// the chance to fix its own scaffold. Instead, exactly like the invalid-`.tanren/
// ci.yml` boundary (`gateConfigFailure.ts`), it is projected onto a LOUD, RUN-SCOPED
// gate FAILURE: the gate did not pass (fail-closed — an unbuildable tree is NEVER
// "passed"), the run records the bootstrap output, and the in-loop triage turns the
// failed gate into a P0 finding ("your `just bootstrap` failed: <output>") via
// `gateFindings` so the writer loop re-authors the scaffold in-place. The loop is
// bounded by the SAME convergence answerer that bounds every gate-fix loop, so a
// scaffold the writer cannot fix within budget terminates as a normal non-convergence
// — never an infinite loop.
//
// CRITICAL DISTINCTION — this is ONLY the project's `just bootstrap` (deps install),
// the WRITER-OWNED scaffold. TWO sibling failures are deliberately NOT writer-fixable
// and keep their loud terminal halt; this boundary never touches either:
//   - the TOOLCHAIN PROVISION step (`WorkspaceMiseProvisionError`) — the declared
//     toolchain / network / runner, and it runs at workspace-prep before the writer loop;
//   - a MISSING TOOLCHAIN BINARY (`WorkspaceToolchainUnavailableError`, classified in
//     workspace/toolchainProvision.ts). This one used to arrive here disguised as an
//     ordinary deps-install failure — the live `pnpm: command not found` / exit 127 —
//     and got a remediation writer dispatched at it. That is an UNWINNABLE loop: no edit
//     to any source file installs a binary, so the writer re-reads the same error until
//     the convergence budget runs out. Infrastructure faults halt; they do not route.
//
// STACK-AGNOSTIC: Tanren names no stack here. It does NOT special-case pnpm/esbuild —
// it routes the bootstrap output to the writer, who handles its stack's specifics.
//
// This module performs no execution. It only classifies a deps-install error and
// projects it onto the gate's existing `{ passed: false }` result shape.
import type { CiWhen } from "../../ci/index.js";
import { WorkspaceDepsInstallError } from "../../workspace/index.js";
import type { GateAppendEvent } from "./runGateTier.js";
import type { GateOutcome } from "./runGateForWhen.js";

// The synthetic tier/step names a deps-install failure surfaces under. STABLE so a
// recurring bootstrap failure dedupes across loop iterations (the `gateFindings` id
// is `gate-<tier>-<step>`), exactly like a real recurring gate failure — the
// convergence answerer reasons over the stable id to bound the loop.
export const BOOTSTRAP_GATE_TIER = "tanren-bootstrap";
export const BOOTSTRAP_GATE_STEP = "deps-install";

/**
 * True iff `error` is a `WorkspaceDepsInstallError` — the project's `just bootstrap`
 * (deps install) exited nonzero / timed out: a WRITER-FIXABLE scaffold defect.
 *
 * DELIBERATELY narrow. A `WorkspaceMiseProvisionError` (the declared-toolchain
 * provision) and a `WorkspaceToolchainUnavailableError` (the project's bootstrap called
 * a toolchain binary no declaration provisions) are NOT writer-fixable and are excluded
 * by class — both keep their loud terminal halt.
 * Any other throw (a substrate/transport fault) is also excluded so a transient
 * runner hiccup is never recast as a fixable scaffold finding (no-silent-fallback) —
 * it keeps its loud-throw → run-fail semantics, identical to how `gateConfigFailure`
 * excludes a config READ failure.
 */
export function isWorkspaceDepsInstallError(error: unknown): error is WorkspaceDepsInstallError {
  return error instanceof WorkspaceDepsInstallError;
}

/**
 * Project a `WorkspaceDepsInstallError` onto a FAILED `GateOutcome`, and emit a
 * `gate.failed` event so the run timeline records the broken scaffold loudly (no
 * verdict is emitted — no tier actually ran; the deps install failed before the gate
 * could execute). The bootstrap output tail rides in the synthetic step's
 * `outputTail`, so both `gateReason` (writer-loop steering) and `gateFindings` (the
 * P0 finding body) feed the writer EXACTLY which bootstrap error to fix — mirroring
 * how a real gate failure's step output is fed to the writer. The original command
 * (never the app-env prelude) is what the error carries, so no app-secret value can
 * reach the event payload (the substrate-boundary guarantee in `bootstrap.ts`).
 *
 * Fail-closed: `passed` is `false`. An unbuildable tree can never be a vacuous pass —
 * the merge authority must see the gate as not-passed until the scaffold installs.
 */
export async function workspaceDepsInstallGateOutcome(
  error: WorkspaceDepsInstallError,
  when: CiWhen,
  appendEvent: GateAppendEvent,
  taskId?: string,
): Promise<Extract<GateOutcome, { passed: false }>> {
  const failure = {
    passed: false as const,
    tier: BOOTSTRAP_GATE_TIER,
    when,
    failedStep: BOOTSTRAP_GATE_STEP,
    exitCode: error.exitCode,
    steps: [
      {
        name: BOOTSTRAP_GATE_STEP,
        // The ORIGINAL bootstrap command (prelude-free — see bootstrap.ts substrate
        // boundary), so the timeline/finding names what failed without any secret.
        run: error.command,
        exitCode: error.exitCode,
        passed: false,
        // The gate-step schema's `timedOut` field records "did not complete"; the
        // bootstrap error's progress-based no-life flag (`stalled`) feeds it.
        timedOut: error.stalled,
        // The bootstrap stdout/stderr tail (the `ERR_PNPM_…` detail) so the writer
        // sees exactly what to fix in its scaffold.
        outputTail: error.outputTail,
      },
    ],
  };
  await appendEvent(
    "gate.failed",
    {
      tier: BOOTSTRAP_GATE_TIER,
      when,
      failedStep: BOOTSTRAP_GATE_STEP,
      exitCode: error.exitCode,
      steps: failure.steps,
    },
    taskId,
  );
  return { passed: false, results: [failure], failure };
}
