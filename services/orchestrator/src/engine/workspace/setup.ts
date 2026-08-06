// WORKSPACE SETUP — the repository's own ONCE-PER-WORKSPACE environment preparation.
//
// THE GAP THIS CLOSES. Tanren prepares a workspace in two documented steps: it provisions
// the LANGUAGE toolchain the repository declares (toolchainProvision.ts, environment-
// management.md §3), then it runs the repository's `bootstrap.run` before every gate
// (bootstrap.ts). Neither prepares the rest of a real repository's toolchain — the native
// binaries its own gates and commit hooks call by name (`gitleaks`, `shellcheck`,
// `terraform`, `protoc`, `hadolint`). Those appear in no manifest Layer 1 reads, and they
// are not per-gate work: they are a one-time, network-bound install.
//
// Given only `bootstrap`, a repository with such a toolchain does not fail loudly — it
// DECLARES LESS, because `bootstrap.run` is priced per gate. Measured, in a real target
// repository's own contract:
//
//   # Deliberately not scripts/bootstrap.sh, which wants sudo, network and a
//   # terraform/tflint/gitleaks install on every gate.
//   bootstrap:
//     run: pnpm install --frozen-lockfile && uv sync --group dev
//
// Tanren then reached the commit step and the repository's own `.husky/pre-commit` did
// exactly what a secret scanner should do:
//
//   error: gitleaks is not installed or not on PATH
//   Secret scan blocked the commit. See the remediation block above.
//   husky - pre-commit script failed (code 1)
//
// The hook was RIGHT — "no secrets found" and "I did not look" must not be the same
// outcome — and the repository was right about the per-gate cost. What was missing was a
// place to say the other thing. That is this verb.
//
// ---- CONFIGURATION, NOT DETECTION -----------------------------------------------------
//
// The obvious alternative is to DETECT and run a conventional bootstrap script
// (`scripts/bootstrap.sh`, `script/bootstrap`, `bin/setup`, `make setup`). It is rejected,
// on three grounds, the first of which is decisive:
//
//  1. IT GUESSES AT INTENT AND GETS IT WRONG. Against the repository above, detection
//     would have executed `scripts/bootstrap.sh` — the exact script that repository's
//     contract states, in writing, must not run. A convention match is not consent. It
//     would also not even have WORKED: that script is two dozen `sudo apt-get` /
//     `sudo install … /usr/local/bin` calls deep, and the runner's `tanren` user is
//     non-root with no `sudo` installed, by design (runner/Dockerfile). The fix that
//     "obviously" works would have failed on the first line of its first install.
//  2. IT IS A DIFFERENT TRUST ACT. Tanren already executes repository-authored shell —
//     `bootstrap.run`, `upgrade.run`, `deploy.run`, every `tiers[].run` — so the trust
//     boundary is genuinely crossed already, and a FOURTH verb read from the SAME
//     `.tanren/ci.yml` adds exactly zero new surface. Running a file Tanren went looking
//     for is not that: it executes bytes nobody pointed at, found by a pattern. The
//     boundary that is already crossed is "the repository's declared commands"; widening
//     it to "the repository's discovered files" is a decision, not a corollary.
//  3. IT CANNOT BE AUDITED. `setup.run` is in the contract, in git, in the diff a reviewer
//     reads, and under the same gate-contract history as every other verb.
//
// A convention-based FALLBACK for repositories that declare nothing was considered and
// also rejected: it reintroduces (1) for precisely the repositories that never opted in.
//
// ---- IDEMPOTENCE, COST, AND WHEN IT RUNS ----------------------------------------------
//
// LATCHED, once per workspace, on a marker written ONLY on success. A setup that fails
// leaves no latch, so the next workspace retries rather than inheriting a half-prepared
// tree — and a setup that half-succeeded is never recorded as done. The latch lives in the
// RUN dir (workspaceScopePrefix), outside the repository, so Tanren still materializes
// nothing into a repo it did not author and teardown reclaims it with the sandbox.
//
// The project is NOT asked to be idempotent here, which is the substantive difference from
// `bootstrap`: an unlatched `bootstrap.run` makes the project's recipe the idempotency
// authority, and that is exactly the demand a native-binary install cannot meet cheaply.
// Tanren owns the latch instead, because the "run once per workspace" lifecycle phase is
// Tanren's concept, not the repository's.
//
// ORDER: after the declared toolchain is provisioned (setup may need node/python), before
// the project's bootstrap (bootstrap may need what setup installed) and therefore before
// the first commit whose hooks are LIVE.
//
// ---- FAILURE ATTRIBUTION ---------------------------------------------------------------
//
// Every halt is a bug report and must name whose bug it is. A failure here is THE
// REPOSITORY'S SETUP COMMAND failing — not a Tanren fault, not a writer-fixable scaffold
// defect — and {@link WorkspaceSetupError} says so in those words. It is deliberately NOT
// routed to the remediation writer the way a `WorkspaceDepsInstallError` is: for the same
// reason a missing toolchain binary is not, no source edit makes an environment-preparation
// command succeed, so dispatching a writer at it spends the whole convergence budget on a
// loop that cannot be won. It halts.

import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { withAppEnv } from "../ssh/appEnvPrelude.js";
import { withMiseActivation } from "../ssh/miseActivate.js";
import { workspaceScopePrefix } from "../ssh/workspaceScope.js";
import { TANREN_BIN_ENV, workspaceToolBinDir } from "../ssh/workspaceToolPath.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { combinedOutput, failureReason, redactAppEnv, tailOf } from "./outputTail.js";

/** The success latch for a workspace's setup. Per-workspace, outside the repo tree. */
export function workspaceSetupMarkerFile(workspacePath: string): string {
  return `${workspaceScopePrefix(workspacePath, "setup")}-done`;
}

/** Printed when the latch was already present — the setup ran in an earlier step of this
 * workspace and is not re-run. Rides on stdout so the caller can report which happened
 * without a second round-trip. */
export const SETUP_NOOP_SENTINEL = "tanren: workspace-setup no-op";
/** Printed immediately before the project's setup command runs. */
export const SETUP_RUN_SENTINEL = "tanren: workspace-setup running";

export interface EnsureWorkspaceSetupInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  // The repository's declared `.tanren/ci.yml` `setup.run`, verbatim. UNDEFINED ⇒ the
  // repository declared no setup verb, and this step is a pure no-op that makes no SSH
  // round-trip at all. There is no fallback command: absence is semantic.
  command?: string;
  // Plane B: the project's dev+test app env. Same SUBSTRATE-BOUNDARY handling as
  // bootstrap.ts — the `export K='v'; …` prelude is prepended to the EXECUTED command
  // ONLY, never to `command`, so a failure surfaces the ORIGINAL command. The OUTPUT is a
  // separate exposure and a separate mechanism: the repository's own setup script can echo
  // a value, so the captured tail is redacted (`redactAppEnv`) before it reaches the error.
  appEnv?: Record<string, string>;
}

export interface EnsureWorkspaceSetupResult {
  /** Whether the project's setup command actually EXECUTED in this call (false when the
   * repository declared none, or when the latch from an earlier call was already there). */
  ran: boolean;
}

/**
 * A typed, observable failure of the REPOSITORY's declared setup command.
 *
 * Distinct from `WorkspaceBootstrapError` (the project's per-gate install) and
 * `WorkspaceDepsInstallError` (the writer-fixable scaffold defect) so the halt names the
 * right owner: this is the repo's environment preparation, and neither Tanren nor the
 * writer can fix it from here.
 */
export class WorkspaceSetupError extends Error {
  override readonly name = "WorkspaceSetupError";

  constructor(
    readonly workspacePath: string,
    readonly command: string,
    readonly exitCode: number | null,
    readonly outputTail: string,
    readonly stalled: boolean,
  ) {
    super(setupFailureMessage(command, exitCode, outputTail, stalled));
  }
}

/**
 * Run the repository's declared workspace setup, at most once per workspace.
 *
 * Safe to call before every gate and at workspace-prep: after the first success the latch
 * makes it a single `[ -f ]` test. Returns `{ ran: false }` without touching the substrate
 * when the repository declares no `setup` verb.
 */
export async function ensureWorkspaceSetup(input: EnsureWorkspaceSetupInput): Promise<EnsureWorkspaceSetupResult> {
  const command = input.command;
  // NO DECLARATION ⇒ NO ROUND-TRIP. Not a silent fallback: there is nothing to fall back
  // to, because this verb has no default (see ci/resolve.ts `setupCommand`).
  if (command === undefined || command.trim() === "") {
    return { ran: false };
  }
  const marker = workspaceSetupMarkerFile(input.workspacePath);
  const bin = workspaceToolBinDir(input.workspacePath);
  // ONE round-trip, entirely runner-side. `mkdir -p` the tool directory FIRST so the
  // project's setup has somewhere to install into ($TANREN_BIN is already exported and on
  // PATH by withMiseActivation). The latch is written LAST and only on success: the
  // `&&` chain means a nonzero setup leaves no marker, and the `if` compound's status is
  // the failing command's, so the failure propagates to the substrate result.
  const guarded =
    `if [ -f "${marker}" ]; then echo ${quoteSshShellArg(SETUP_NOOP_SENTINEL)}; ` +
    `else mkdir -p "${bin}" && echo ${quoteSshShellArg(SETUP_RUN_SENTINEL)} && ` +
    `{ ${command}; } && : > "${marker}"; fi`;
  const result = await input.ssh.run(input.target, {
    // PROJECT-COMMAND path: the project's environment (the tool directory + the declared
    // mise toolchain) then the app-env prelude — both on the EXECUTED string only, so the
    // error/event command stays the ORIGINAL, prelude-free `setup.run`.
    command: withMiseActivation(withAppEnv(guarded, input.appEnv), input.workspacePath),
    cwd: input.workspacePath,
    // Environment prep: output-driven + the workspace as the silent-stretch liveness
    // probe. A cold native-binary install is legitimately slow; NEVER killed for elapsed
    // time, only for a genuine absence of progress.
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
  });

  const succeeded = result.failure === undefined && result.stalled !== true && result.exitCode === 0;
  if (!succeeded) {
    throw new WorkspaceSetupError(
      input.workspacePath,
      command,
      result.exitCode,
      // REDACTED (./outputTail.ts): the prelude discipline keeps app-env values out of the
      // `command`, but the repository's own setup script can PRINT one, and this tail is
      // pasted into the error message and every event that carries it.
      redactAppEnv(tailOf(combinedOutput(result)), input.appEnv),
      result.stalled === true,
    );
  }
  return { ran: result.stdout.includes(SETUP_RUN_SENTINEL) };
}

// Names the OWNER of the failure in the first clause, before any diagnostic detail: this
// is the repository's own environment-preparation command, and the operator reading the
// halt needs to know that before they read the exit code.
function setupFailureMessage(command: string, exitCode: number | null, outputTail: string, stalled: boolean): string {
  const tail = outputTail === "" ? "" : `: ${outputTail}`;
  return (
    `the repository's declared workspace setup (.tanren/ci.yml setup.run) ${failureReason(exitCode, stalled)}` +
    ` — this is the REPO's environment preparation, not a Tanren fault and not a writer-fixable` +
    ` source defect; run it yourself to reproduce. Command: ${command}. Native binaries belong in` +
    ` $${TANREN_BIN_ENV}, which Tanren creates and puts on PATH for the project's commands and hooks${tail}`
  );
}
