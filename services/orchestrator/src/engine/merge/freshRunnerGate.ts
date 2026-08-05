// FRESH-RUNNER NATIVE MERGE GATE (the no-Actions delivery model). The native gate
// is the merge authority. At merge-drive time the run's original runner is GONE, so
// re-gating a queued run's PR head — or a speculative batch's integration ref —
// cannot reuse the in-loop gate closure. This block provisions a SHORT-LIVED runner,
// clones the given ref, installs deps, runs the repo's `pre_merge` gate tiers over
// SSH, and returns the verdict + the gated head sha. There is NO forge check-run
// poll: the verdict comes from the gate's exit codes, exactly like the in-loop gate.
//
// Reused by:
//   - the queued-run re-gate (merge/driveCi.ts `buildReGateCiForQueuedRun`) — clones
//     the PR HEAD branch after an auto-rebase advanced it;
//   - the speculative batch-checker (merge/batchChecker.ts) — clones the EPHEMERAL
//     batch integration ref to verify the prospective merged state.
//
// SECURITY: the App-first / static token is resolved once and fed to the clone over
// SSH stdin via the shared git credential helper — never on the command line, never
// logged. The runner is ALWAYS released (loud-on-leak in the finally).

import { randomUUID } from "node:crypto";
import { runWithJobOrgId } from "@tanren/db";
import type { Allocator, RunnerHandle } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { GovernancePosture } from "../config/shared.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { EventStore } from "../eventStore.js";
import type { EventName, EventPayload } from "../events/index.js";
import { githubHttpsRemote, parseGitHubRepository, type GitHubHttpClient } from "../providers/github.js";
import { resolveVcsToken } from "../credentials/vcsCredentials.js";
import { gitAuthedCommand, gitTokenAuthPrelude } from "../workspace/githubPush.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import {
  DEFAULT_BOOTSTRAP_COMMAND,
  ensureWorkspaceDepsInstalled,
  runWorkspaceSshCommand,
  seedWorkspaceLocalIgnore,
  workspaceRepoPathForRun,
} from "../workspace/index.js";
import {
  advisoryStepNamesForPosture,
  type GateOutcome,
  resolveWorkspaceLifecycleCommands,
  resolveGateConfig,
  runGateForWhen,
} from "../workflow/gate/index.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("merge");

/** The resolved repo + ref + run context a fresh-runner gate clones and reasons over. */
export interface FreshRunnerGateContext {
  repoUrl: string;
  /** The ref to clone + gate (a PR head branch, or an ephemeral integration ref). */
  ref: string;
  runnerImage: string;
  governancePosture: GovernancePosture;
  installation?: OrgGithubAppInstallation;
  /** The static GitHub credential ref (used when no App installation). */
  githubCredentialRef: string;
  /** The org the runner allocation + events scope to. */
  orgId: string;
  projectId: string;
  /** A stable run-id handle for runner/workspace naming + event correlation. */
  runId: string;
  specId?: string;
}

export interface FreshRunnerGateDeps {
  allocator: Allocator;
  ssh: CommandSubstrate;
  secrets: SecretStore;
  /** The shared (timed) GitHub HTTP client the gate's push-token resolution reads through. */
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  eventStore: EventStore;
  /** The runner identity key ref (same value the worker boot seeds). */
  identitySecretRef: string;
}

/** The verdict of a fresh-runner gate run: the combined outcome + the gated head sha. */
export interface FreshRunnerGateResult {
  outcome: GateOutcome;
  /** The commit the gate actually verified (the cloned ref's HEAD). */
  headSha: string;
}

/**
 * Provision a short-lived runner, clone `ctx.ref`, install deps, and run the repo's
 * `pre_merge` gate over the cloned workspace. Returns the combined gate outcome + the
 * gated head sha. The runner is always released. Throwing propagates (the caller maps
 * a throw to a non-pass / hold so an unverified ref never merges).
 */
export async function runFreshRunnerMergeGate(
  deps: FreshRunnerGateDeps,
  ctx: FreshRunnerGateContext,
): Promise<FreshRunnerGateResult> {
  // UNIQUE re-gate handle. The allocators derive the runner primary key as
  // `runner_${runId}`, but the ORIGINAL run already allocated `runner_${ctx.runId}`
  // and only RELEASED it (release sets status='released', it does NOT delete the
  // `runners` row). Reusing `ctx.runId` here re-inserts the SAME pkey → a
  // `runners_pkey` unique-constraint violation that bricked the live batch gate
  // (and would also collide across this re-gate's own batch retries). So derive a
  // synthetic, per-attempt-unique handle for BOTH the allocation (→ a unique
  // `runner_…` row) AND the workspace path (→ its own clone dir). The REAL
  // `ctx.runId` is still used for run-scoped events + credentials. randomUUID is
  // fine here — this is engine code, not a deterministic workflow script.
  const regateRunId = `${ctx.runId}-regate-${randomUUID()}`;
  const allocation = await deps.allocator.allocate({
    // Runless: the original run's runner is gone, so allocate a fresh short-lived
    // runner for THIS re-gate only under the UNIQUE handle (so the derived
    // `runner_${regateRunId}` pkey never collides with the original run's retained
    // row or a prior re-gate attempt). The persisted FK columns come from persisted*
    // (no runs-row FK for a re-gate).
    runId: regateRunId,
    projectId: ctx.projectId,
    runnerImage: ctx.runnerImage,
    identitySecretRef: deps.identitySecretRef,
    orgId: ctx.orgId,
    runless: true,
    persistedRunId: null,
    persistedProjectId: ctx.projectId,
  });
  const workspacePath = workspaceRepoPathForRun(regateRunId);
  try {
    const headSha = await cloneRefForGate(deps, ctx, allocation.target, workspacePath);
    // node_modules guard BEFORE any install, mirroring the run-loop workspace prep.
    await seedWorkspaceLocalIgnore({
      ssh: deps.ssh,
      target: allocation.target,
      workspacePath,
    });
    await installDepsForGate(deps, allocation.target, workspacePath);
    const outcome = await gateClonedRef(deps, ctx, allocation.target, workspacePath, headSha);
    return { outcome, headSha };
  } finally {
    // LOUD on release error: a leaked runner is a real fault (cost + capacity).
    // ORG-SCOPE THE RELEASE: the `finally` fires after the gate completes, in the same
    // async context — but the caller (driveCi.ts `buildReGateCiForQueuedRun`) does NOT
    // wrap `runFreshRunnerMergeGate` in `runWithJobOrgId`, so there is NO ambient org
    // scope here. `allocator.release()` writes the tenant `runners` table through
    // `withJobOrgScope`, which FAILS LOUDLY with no ambient scope → leaked runner. Re-
    // establish `ctx.orgId` around the release so the write is admitted by RLS regardless
    // of which caller invokes this gate — identical to the liveJjWorkspace fix.
    await runWithJobOrgId(ctx.orgId, () => deps.allocator.release(allocation.runnerId, "completed")).catch(
      (error: unknown) => {
        log.error(
          "FAILED to release fresh-runner re-gate runner — leaked runner",
          {
            runnerId: allocation.runnerId,
            runId: ctx.runId,
          },
          error,
        );
        throw error;
      },
    );
  }
}

/**
 * Clone `ctx.ref` into the runner workspace (App-first auth, like the run-loop clone)
 * and return its HEAD sha. The token is fed over SSH stdin via the git credential
 * helper, never on the command line. Returns the 40-hex head sha (the gated commit).
 */
async function cloneRefForGate(
  deps: FreshRunnerGateDeps,
  ctx: FreshRunnerGateContext,
  target: RunnerHandle,
  workspacePath: string,
): Promise<string> {
  const staticRef = ctx.githubCredentialRef;
  const token =
    ctx.installation === undefined && staticRef.trim() === ""
      ? undefined
      : (
          await resolveVcsToken(deps.githubHttp, {
            secrets: deps.secrets,
            orgId: ctx.orgId,
            ...(ctx.installation !== undefined && { installation: ctx.installation }),
            ...(staticRef.trim() !== "" && { staticRef }),
            ...(deps.githubAppMinter !== undefined && { minter: deps.githubAppMinter }),
          })
        ).token;
  const result = await runWorkspaceSshCommand(deps.ssh, target, {
    label: "clone ref for native re-gate",
    // VCS op (a clone): output-driven + the clone target as the silent-stretch
    // liveness probe (the clone writes the tree as it works). Never killed for time.
    watchdog: buildActivityWatchdog({ substrate: deps.ssh, target, cls: "vcs", workspace: workspacePath }),
    command: buildCloneRefCommand(ctx.repoUrl, ctx.ref, token, workspacePath),
    ...(token === undefined ? {} : { stdin: token }),
  });
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`re-gate clone of ${ctx.ref} did not resolve a head sha`);
  }
  return sha;
}

/** The git clone of a ref (authenticated via stdin when a token is present). */
function buildCloneRefCommand(repoUrl: string, ref: string, token: string | undefined, workspacePath: string): string {
  const branch = quoteSshShellArg(ref);
  const dest = quoteSshShellArg(workspacePath);
  const post = [`cd ${dest}`, "git rev-parse HEAD"];
  if (token === undefined) {
    return [
      "set -eu",
      `rm -rf ${dest}`,
      `git clone --branch ${branch} ${quoteSshShellArg(repoUrl)} ${dest}`,
      ...post,
    ].join(" && ");
  }
  const remote = quoteSshShellArg(githubHttpsRemote(parseGitHubRepository(repoUrl)));
  return [
    "set -eu",
    ...gitTokenAuthPrelude(),
    `rm -rf ${dest}`,
    gitAuthedCommand(["clone", "--branch", branch, remote, dest]),
    ...post,
  ].join(" && ");
}

/**
 * Install deps on the freshly-cloned workspace before the gate runs — a re-gate
 * needs a built tree for the build/test tiers. The bootstrap command is the repo's
 * `.tanren/ci.yml` `bootstrap.run` (conventionally `just bootstrap`) when present,
 * else the stack-agnostic DEFAULT_BOOTSTRAP_COMMAND LOUD-fallback. Tanren names no
 * stack; the greenfield-vs-frozen concern lives in the project's `just bootstrap`. A
 * failure throws (no silent skip).
 */
async function installDepsForGate(
  deps: FreshRunnerGateDeps,
  target: RunnerHandle,
  workspacePath: string,
): Promise<void> {
  // Both preparation commands from ONE read: the per-gate `bootstrap.run` and the
  // once-per-workspace `setup.run`. This path clones its OWN workspace and never runs
  // `prepareRunWorkspace`, so it is where THIS workspace's setup is honored — without it a
  // merge gate would run against a tree whose environment was never prepared, and the repo's
  // own hooks/steps would fail on binaries no manifest declares.
  const lifecycle = await resolveWorkspaceLifecycleCommands({
    ssh: deps.ssh,
    target,
    workspacePath,
  });
  await ensureWorkspaceDepsInstalled({
    ssh: deps.ssh,
    target,
    workspacePath,
    command: lifecycle.bootstrap ?? DEFAULT_BOOTSTRAP_COMMAND,
    ...(lifecycle.setup === undefined ? {} : { setupCommand: lifecycle.setup }),
  });
}

/**
 * Run the repo's `pre_merge` gate tiers over the cloned workspace. Resolves the CI
 * config (tanren-ci.yml, else the documented default) and runs the mapped tiers,
 * emitting `gate.*` + the headSha-carrying `gate.verdict` through the event store.
 */
async function gateClonedRef(
  deps: FreshRunnerGateDeps,
  ctx: FreshRunnerGateContext,
  target: RunnerHandle,
  workspacePath: string,
  headSha: string,
): Promise<GateOutcome> {
  const config = await resolveGateConfig({ ssh: deps.ssh, target, workspacePath });
  return runGateForWhen({
    ssh: deps.ssh,
    target,
    workspacePath,
    config,
    when: "pre_merge",
    appendEvent: gateEventAppender(deps, ctx),
    advisoryStepNames: advisoryStepNamesForPosture(ctx.governancePosture),
    headSha,
  });
}

/** The gate event-append seam, scoped to the re-gate's run/spec/project. */
function gateEventAppender(deps: FreshRunnerGateDeps, ctx: FreshRunnerGateContext) {
  return async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void> => {
    await deps.eventStore.append({
      runId: ctx.runId,
      projectId: ctx.projectId,
      orgId: ctx.orgId,
      ...(ctx.specId !== undefined && { specId: ctx.specId }),
      ...(taskId !== undefined && { taskId }),
      eventType,
      payload,
    });
  };
}
