// START A RUN the way the worker does, for tests that need the OBSERVABLE
// "does this configuration actually run?" answer rather than a helper's verdict.
//
// `resolveRunAdaptersWithBudgetPreflight` is the run-setup chokepoint: it builds the
// run's role adapters, reads the WRITER's (cli × credential) route, and puts it
// through `runBudgetCeilingPreflight` — the function that fails a run CLOSED before a
// runner is burned. Resolving = the run starts; throwing = the run is refused.
//
// The budget gate is the PRODUCTION `PgBudgetGate` over the caller's pool, so the
// ceiling this reads is the one actually persisted on the org/project row — not a
// stubbed number. The only fakes are the SSH substrate (no runner in a unit test)
// and the secret store the caller passes in.

import { emptyRoutingTable, type RoutingChainEntry } from "../../src/engine/config/shared.js";
import type { RunnerHandle } from "../../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../../src/engine/contracts/commandSubstrate.js";
import type { SecretStore } from "../../src/engine/contracts/secretStore.js";
import { PgBudgetGate } from "../../src/engine/dag/budgetGate.js";
import { buildEffectiveRouting } from "../../src/engine/worker/runExecutionContext.js";
import type { PlannerRunAdapterContext, RunPlannerLoopInput } from "../../src/engine/workflow/plannerRun.js";
import { resolveRunAdaptersWithBudgetPreflight } from "../../src/engine/workflow/plannerRunAdapters.js";
import type { AppendEvent } from "../../src/engine/workflow/subtaskLoop.js";
import type { RoutesPool } from "./routesPool.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

class NoopSsh implements CommandSubstrate {
  async run(_target: RunnerHandle, _command: RunnerCommand): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

const adapterCtx: PlannerRunAdapterContext = { runId: "run_1", target, codexHome: "/home/tanren/.codex/run_1" };
const noopAppend: AppendEvent = async () => {};

export interface StartRunSetupInput {
  pool: RoutesPool;
  secrets: SecretStore;
  /** The org/project default LLM entry the run's empty role chains inherit. */
  route: RoutingChainEntry;
  projectId?: string;
}

/**
 * Drive the run-setup path for a project. Resolves with the run's adapters + usage
 * probe when the run starts; REJECTS with the setup refusal when it does not.
 */
export function startRunSetup(input: StartRunSetupInput): ReturnType<typeof resolveRunAdaptersWithBudgetPreflight> {
  const projectId = input.projectId ?? "project_acme";
  const loopInput = {
    secrets: input.secrets,
    ssh: new NoopSsh(),
    budgetGate: new PgBudgetGate(input.pool.asPgPool()),
    context: {
      runId: "run_1",
      specId: "spec_1",
      projectId,
      repoUrl: "https://example.invalid/repo",
      targetBranch: "main",
      runBranch: "tanren/x",
      specTitle: "t",
      specDescription: "d",
      acceptanceCriteria: [],
      runnerImage: "img",
      identitySecretRef: "id",
      githubCredentialRef: "cred/gh",
      // Exactly the production default-application: the org/project default entry
      // heads every role chain the project leaves empty.
      routing: buildEffectiveRouting(emptyRoutingTable(), input.route),
    },
  } as unknown as RunPlannerLoopInput;
  return resolveRunAdaptersWithBudgetPreflight(loopInput, adapterCtx, noopAppend);
}
