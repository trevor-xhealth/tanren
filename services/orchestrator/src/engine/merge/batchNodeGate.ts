// The gate closures the §3 batch integration-node drive runs ON the open jj-local
// workspace (tanren-owns-the-engine.md §3b). With jj-local integration the prospective
// merged state is a LOCAL jj bookmark (no `tanren/batch` host ref), so the native gate
// must run on THAT workspace — NOT a separate fresh runner that clones a host ref. These
// closures reuse the SAME gate primitives the fresh-runner gate uses verbatim:
// `resolveGateConfig` (the gateConfigHash source + the proof-reuse key input — resolved
// FIRST so an invalid `.tanren/ci.yml` is a fail-closed FAIL verdict, never a throw-to-
// infra-hold, and the bootstrap command is derived from the parsed config),
// `seedWorkspaceLocalIgnore` + `ensureWorkspaceDepsInstalled` (the install the brownfield
// re-gate needs), and `runGateForWhen` over the `pre_merge` tiers (the verdict).

import { bootstrapCommand, type CiConfigV1, setupCommand } from "../ci/index.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { GovernancePosture } from "../config/shared.js";
import type { EventStore } from "../eventStore.js";
import type { LiveJjWorkspace } from "../providers/liveJjWorkspace.js";
import type { EventName, EventPayload } from "../events/index.js";
import {
  DEFAULT_BOOTSTRAP_COMMAND,
  ensureWorkspaceDepsInstalled,
  seedWorkspaceLocalIgnore,
} from "../workspace/index.js";
import {
  advisoryStepNamesForPosture,
  isInvalidCiConfigError,
  resolveGateConfig,
  runGateForWhen,
} from "../workflow/gate/index.js";
import { hashGateConfig } from "../dag/integrationProofKey.js";
import type { ResolveBatchGateConfig, GateBatchWorkspace } from "./batchIntegrationNodeDrive.js";
import type { NativeCiGateObservation } from "./gateProofBundleTypes.js";
export { buildBatchGateProofSealer, type BatchProofSubstrate } from "./batchGateProofProduction.js";

export interface BatchNodeGateClosureDeps {
  ssh: CommandSubstrate;
  eventStore: EventStore;
  governancePosture: GovernancePosture;
  /** The integration ref the batch verdict reports (the local bookmark name). */
  integrationRef: string;
  /** The project's tenant key — stamped onto every gate event for RLS (v68 fix). */
  orgId: string;
  projectId: string;
  tailSpecId: string;
  /** Exact active quarantine actuated by this integrated gate. */
  quarantinedStepNames?: ReadonlySet<string>;
  /** Exact test-filter environment covered by the proof's app-env hash. */
  appEnv?: Record<string, string>;
}

/**
 * The config-resolver closure: read the repo's CI config from the OPEN workspace (the
 * integrated head). Fail-closed — a read failure returns `undefined` (the drive forces a
 * recompute on an unresolvable gateConfigHash, never a stale reuse).
 */
export function batchNodeResolveConfig(deps: BatchNodeGateClosureDeps): ResolveBatchGateConfig {
  return async (live: LiveJjWorkspace): Promise<CiConfigV1 | undefined> => {
    try {
      return await resolveGateConfig({
        ssh: deps.ssh,
        target: live.target,
        workspacePath: live.workspacePath,
      });
    } catch {
      return undefined;
    }
  };
}

/**
 * The gate closure (RECOMPUTE only): install deps on the integrated workspace, then run
 * the `pre_merge` gate tiers over it. Returns the batch verdict + whether it passed (the
 * recorded proof). A gate that cannot RUN propagates (the caller maps a throw to an
 * infra-error hold — never a false verdict).
 */
export function batchNodeGate(deps: BatchNodeGateClosureDeps): GateBatchWorkspace {
  return async (live: LiveJjWorkspace) => {
    // Resolve + CLASSIFY the repo gate config FIRST, before any seed/install work. An
    // INVALID `.tanren/ci.yml` (built-repo data) is a fail-closed gate FAIL verdict —
    // NOT a throw-to-infra-hold (which would hot-loop the retry timer on a permanent
    // config error) and NEVER a pass. The merge cannot proceed until the repo's config
    // is fixed; the bisect/triage surfaces the issue. A substrate READ failure still
    // propagates (its loud infra-error hold semantics are preserved — a transient
    // hiccup is genuinely retryable, distinct from a broken config). Resolving the
    // config up front (and deriving the bootstrap command from it) means a bad config
    // can never escape from the LATER `resolveBootstrapCommand` read either.
    let config: CiConfigV1;
    try {
      config = await resolveGateConfig({
        ssh: deps.ssh,
        target: live.target,
        workspacePath: live.workspacePath,
      });
    } catch (error) {
      if (isInvalidCiConfigError(error)) {
        return {
          verdict: {
            result: "fail",
            message: `batch gate cannot run on ${deps.integrationRef}: the repo's \`.tanren/ci.yml\` is invalid: ${error.message}`,
          },
          passed: false,
        };
      }
      throw error;
    }
    await seedWorkspaceLocalIgnore({
      ssh: deps.ssh,
      target: live.target,
      workspacePath: live.workspacePath,
    });
    // The repo's once-per-workspace `setup.run`, from the SAME already-parsed config. This
    // path clones its own workspace and never runs `prepareRunWorkspace`, so it is where
    // THIS workspace's environment preparation is honored — a merge gate must not run
    // against a tree whose environment was never prepared. Absent ⇒ no round-trip.
    const workspaceSetup = setupCommand(config);
    await ensureWorkspaceDepsInstalled({
      ssh: deps.ssh,
      target: live.target,
      workspacePath: live.workspacePath,
      // The bootstrap command from the already-parsed config (no second file read that
      // could re-throw the same validation error), or — when the config omits
      // `bootstrap.run` — the stack-agnostic DEFAULT_BOOTSTRAP_COMMAND LOUD-fallback.
      command: bootstrapCommand(config) ?? DEFAULT_BOOTSTRAP_COMMAND,
      ...(workspaceSetup === undefined ? {} : { setupCommand: workspaceSetup }),
    });
    const outcome = await runGateForWhen({
      ssh: deps.ssh,
      target: live.target,
      workspacePath: live.workspacePath,
      config,
      when: "pre_merge",
      appendEvent: async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => {
        await deps.eventStore.append({
          projectId: deps.projectId,
          orgId: deps.orgId,
          specId: deps.tailSpecId,
          ...(taskId !== undefined && { taskId }),
          eventType,
          payload,
        });
      },
      advisoryStepNames: advisoryStepNamesForPosture(deps.governancePosture),
      ...(deps.quarantinedStepNames === undefined ? {} : { quarantinedStepNames: deps.quarantinedStepNames }),
      ...(deps.appEnv === undefined ? {} : { appEnv: deps.appEnv }),
    });
    if (outcome.passed) {
      return {
        verdict: { result: "pass", integrationBranch: deps.integrationRef },
        passed: true,
        nativeCi: nativeCiObservation(config, outcome),
      };
    }
    return {
      verdict: {
        result: "fail",
        message: `batch gate failed on ${deps.integrationRef}: tier ${outcome.failure.tier} step ${outcome.failure.failedStep}`,
      },
      passed: false,
      nativeCi: nativeCiObservation(config, outcome),
    };
  };
}

/**
 * The native section is composed directly from the real `runGateForWhen` result. It
 * records the executed tiers, every step outcome, and the already-parsed JUnit totals;
 * an empty tier/step set is intentionally retained for the V2 composer to classify as
 * unknown rather than silently treating a vacuous gate as evidence.
 */
function nativeCiObservation(
  config: CiConfigV1,
  outcome: Awaited<ReturnType<typeof runGateForWhen>>,
): NativeCiGateObservation {
  const reports = outcome.results.flatMap((tier) => [...(tier.parsedJunitReports?.values() ?? [])]);
  return {
    gateConfigHash: hashGateConfig(config),
    tiers: outcome.results.map((tier) => tier.tier),
    steps: outcome.results.flatMap((tier) =>
      tier.steps.map((step) => ({ name: step.name, tier: tier.tier, passed: step.passed })),
    ),
    junit: {
      total: reports.reduce((total, report) => total + report.results.length, 0),
      failures: reports.reduce(
        (total, report) => total + report.results.filter((result) => result.outcome === "failed").length,
        0,
      ),
      skipped: reports.reduce(
        (total, report) => total + report.results.filter((result) => result.outcome === "skipped").length,
        0,
      ),
    },
    verdict: outcome.passed ? "passed" : "failed",
  };
}
