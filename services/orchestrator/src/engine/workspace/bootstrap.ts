// per-repo workspace bootstrap. Runs clone the target repo into a
// runner workspace but never install its dependencies, so the cloned tree
// cannot build or test — the live acceptance-medium evidence showed the
// checker hitting `vitest: not found`. This step runs the project's install
// command over SSH in the workspace dir immediately after a successful clone
// and BEFORE the first writer iteration, so gating + intent-checking operate
// on a built tree.
import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandResult, CommandSubstrate } from "../contracts/commandSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { withAppEnv } from "../ssh/appEnvPrelude.js";
import { withMiseActivation } from "../ssh/miseActivate.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { combinedOutput, failureReason, tailOf } from "./outputTail.js";
import { classifyToolchainFault, resolveWorkspaceToolchain, toolchainProvisionCommand } from "./toolchainProvision.js";
import { parseToolchainResolutions, type ToolchainResolution } from "./toolchainEnforcement.js";
import { runWorkspaceSshCommand } from "./ssh.js";

// The commit message used for the synthetic post-bootstrap commit. Install
// artifacts (lockfiles, node_modules, etc.) created by the bootstrap step land
// in THIS commit, off the writer's base, so the writer's diff and the pushed PR
// branch carry only the writer's real changes — never bootstrap-generated files.
export const BOOTSTRAP_COMMIT_MESSAGE = "tanren: bootstrap";

// The path of the conventional lifecycle file (engine/forge/scaffold/skeleton.ts):
// a project declares its stack's bootstrap in `just bootstrap`. This LOUD-fallback
// probes for it before refusing to assume a stack.
const JUSTFILE_PATH = "justfile";

// The bootstrap command used ONLY when the repo declares NO install command — i.e.
// the run path resolved no `.tanren/ci.yml` `bootstrap.run` AND no
// `input.bootstrapCommand` override (the resolver yielded `undefined`). Tanren
// assumes NO tech stack: there is NO Node/pnpm/npm probe here. The project owns its
// stack via a `justfile` (the CONTRACT), so this fallback simply runs `just
// bootstrap` WHEN a justfile is present, and otherwise FAILS LOUDLY — never a silent
// Node assumption, never a silent skip. The greenfield-vs-frozen install concern
// (`--frozen-lockfile` vs a writer-added devDep) lives INSIDE the project's `just
// bootstrap`, not in Tanren.
//
// NO-OP (not loud) on a missing justfile: the cold bootstrap runs over a FRESHLY
// CLONED workspace — for a greenfield scaffold that is an EMPTY repo, BEFORE the
// writer has authored the justfile that declares the lifecycle. There is genuinely
// nothing to bootstrap yet, so this skips with a note (a legitimate-empty case, not
// a silent stack assumption — there is NO Node/pnpm/npm probe). Contract ENFORCEMENT
// lives at the GATE, not here: once the writer authors the justfile, the gate runs
// `just tier-1`/etc.; a repo that never declares a justfile fails the gate loudly,
// which surfaces as a P0 finding (worker-resilient, see gateConfigFailure / #443) the
// loop fixes — rather than bricking an empty repo before it can be scaffolded.
// Double-quoted message (no embedded single-quotes/parens) so the shell parses clean.
export const DEFAULT_BOOTSTRAP_COMMAND =
  `if [ -f ${JUSTFILE_PATH} ]; then just bootstrap; ` +
  `else echo "tanren: no justfile yet - skipping bootstrap (the writer authors the lifecycle justfile; the gate enforces the contract)"; fi`;

export interface BootstrapWorkspaceInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  // The install command, run in the workspace dir over SSH. Defaults to
  // DEFAULT_BOOTSTRAP_COMMAND when omitted.
  command?: string;
  // Plane B: the PROJECT's dev+test app env, materialized into the
  // EXECUTED command's environment ONLY (an `export K='v'; …` prelude built at
  // THIS substrate boundary). It is DELIBERATELY kept off the `command` field —
  // the original command (never the prelude) is what flows into
  // WorkspaceBootstrapError / bootstrapFailureMessage / any log, so a bootstrap
  // failure can never leak an app-secret VALUE into the error message or the
  // `workspace.failed` / `run.failed` event payloads. Distinct from Tanren's own
  // provider creds. Undefined ⇒ no app env (command unchanged).
  appEnv?: Record<string, string>;
}

// A typed, observable bootstrap failure. Carries the exit code and a bounded
// tail of the combined install output so the halting run outcome and the
// recovery surface have a concrete diagnostic to show. `stalled` is the
// progress-based no-life signal (the activity watchdog surfaced a recoverable
// stall), NOT a wall-clock kill.
export class WorkspaceBootstrapError extends Error {
  override readonly name = "WorkspaceBootstrapError";

  constructor(
    readonly workspacePath: string,
    readonly command: string,
    readonly exitCode: number | null,
    readonly outputTail: string,
    readonly stalled: boolean,
  ) {
    super(bootstrapFailureMessage(command, exitCode, outputTail, stalled));
  }
}

// Installs the target repo's dependencies in the cloned workspace over SSH.
// Returns the raw SSH result on success; throws WorkspaceBootstrapError on a
// nonzero exit, timeout, or substrate failure.
export async function bootstrapWorkspace(input: BootstrapWorkspaceInput): Promise<CommandResult> {
  const command = input.command ?? DEFAULT_BOOTSTRAP_COMMAND;
  // SUBSTRATE BOUNDARY: the app-env prelude is prepended ONLY to the string handed
  // to `ssh.run` — never to `command`, which is the value that flows into the
  // error message / log below. So a bootstrap failure surfaces the ORIGINAL
  // command (prelude-free), and no app-secret value can reach the emitted
  // `workspace.failed` / `run.failed` events. Mirrors the gate path, which keeps
  // the original `step.run` in `gate.*` events.
  const result = await input.ssh.run(input.target, {
    // PROJECT-COMMAND path: mise-activate so the project's `just bootstrap` (a bare
    // `pnpm install`/`node`/etc) resolves to its `mise.toml`-declared toolchain (a
    // no-op when none was declared), THEN prepend the app-env prelude — both on the
    // EXECUTED string only, so the error/event command stays prelude-free. The codex
    // harness path never runs through here, so it keeps the runner's isolated node.
    command: withMiseActivation(withAppEnv(command, input.appEnv), input.workspacePath),
    cwd: input.workspacePath,
    // VCS/build op: output-driven + the workspace as the silent-stretch liveness
    // probe (a build/install writes files as it works). NEVER killed for elapsed time.
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
  });

  const succeeded = result.failure === undefined && result.stalled !== true && result.exitCode === 0;
  if (!succeeded) {
    throw new WorkspaceBootstrapError(
      input.workspacePath,
      command,
      result.exitCode,
      tailOf(combinedOutput(result)),
      result.stalled === true,
    );
  }
  return result;
}

// The toolchain-provisioning step (`provisionMiseToolchain`, `WorkspaceMiseProvisionError`)
// and the infrastructure-fault classifier live in ./toolchainProvision.ts, which carries
// the full rationale: Layer-1 detection over a repo's standard declaration files, Layer-2
// provisioning through mise, and the post-provision binary verification that turns a
// silently-skipped toolchain into a loud, attributable halt.

// The sentinel the guarded install prints on the NO-OP path (manifest absent, or
// deps already installed). It rides on stdout so the caller can distinguish a
// real install run from a skip without a second round-trip — used to cache the
// "deps installed" flag so the next gate's ensure call is a pure no-op.
const DEPS_NOOP_SENTINEL = "tanren: deps-ensure no-op";
// The sentinel the guarded install prints right before it runs the install
// command, so the caller can observe (and the diagnostic can reflect) that the
// install path was actually taken.
const DEPS_INSTALL_SENTINEL = "tanren: deps-ensure installing";

export interface EnsureWorkspaceDepsInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  // The install/bootstrap command run in the workspace dir over SSH whenever the
  // project CONTRACT is present (a `justfile` or `.tanren/ci.yml`). Defaults to
  // DEFAULT_BOOTSTRAP_COMMAND — the stack-agnostic `just bootstrap` LOUD-fallback —
  // when omitted. The caller (buildDefaultGate) PASSES the resolved command: the
  // repo's `.tanren/ci.yml` `bootstrap.run` (conventionally `just bootstrap`) or an
  // `input.bootstrapCommand` override, verbatim. The greenfield-vs-frozen install
  // concern lives inside the project's `just bootstrap`, NOT here — Tanren names no
  // stack.
  command?: string;
  // Plane B: same substrate-boundary handling as bootstrapWorkspace
  // — the `export K='v'; …` prelude is prepended to the EXECUTED command ONLY, never
  // to `command`, so a failure surfaces the ORIGINAL command (prelude-free) and no
  // app-secret value can reach the error message / events. Undefined ⇒ no app env.
  appEnv?: Record<string, string>;
}

// The outcome of an ensure call: whether the guarded install actually RAN the
// bootstrap command (the project CONTRACT was present) or was a no-op (a
// contract-less clone HEAD). The command runs whenever a `justfile` or
// `.tanren/ci.yml` exists — the project's `just bootstrap` is the idempotency
// authority, so re-running on an already-prepared tree is a cheap no-op — which is
// what lets a writer-added dependency (authored AFTER an earlier iteration's
// install) actually get installed before the gate. `installed` therefore reports
// "the bootstrap command ran", NOT "the tree was prepared for the first time"; the
// greenfield caller re-runs ensure each gate (the contract/deps mutate between
// iterations) rather than latching on this flag.
export interface EnsureWorkspaceDepsResult {
  installed: boolean;
  // Which version each DECLARED tool actually resolved to on the runner for THIS gate.
  // Empty when the repo declared nothing Tanren provisions (or the guard took the no-op
  // branch). Re-read every gate for the same reason the declarations are: a writer may
  // have added or changed one since the last one.
  toolchain: readonly ToolchainResolution[];
}

// A typed, observable deps-install failure, mirroring WorkspaceBootstrapError.
// Carries the exit code and a bounded output tail so a halting run outcome has a
// concrete diagnostic. The ORIGINAL command (never the app-env prelude) is what
// flows into the message, so no app-secret value can leak into an event payload.
export class WorkspaceDepsInstallError extends Error {
  override readonly name = "WorkspaceDepsInstallError";

  constructor(
    readonly workspacePath: string,
    readonly command: string,
    readonly exitCode: number | null,
    readonly outputTail: string,
    readonly stalled: boolean,
  ) {
    super(depsInstallFailureMessage(command, exitCode, outputTail, stalled));
  }
}

// Idempotently ensures the workspace is bootstrapped (deps installed / tree
// prepared) before a gate runs. This closes the greenfield gap: prepareRunWorkspace
// bootstraps ONCE, right after clone — but a greenfield clone HEAD ships no project
// CONTRACT yet, so that cold bootstrap is a no-op; the writer THEN authors the
// `justfile` + dependency manifest, and a per-iteration gate would otherwise run
// `just tier-1` against an unprepared tree.
//
// INSTALL-TRIGGER (the P0 fix): the guarded bootstrap runs the resolved command
// whenever the project CONTRACT EXISTS (`justfile` / `.tanren/ci.yml`) — it does NOT
// gate on whether deps were already installed. Running it on every gate (with the
// project's `just bootstrap` as the idempotency authority — a no-op bootstrap is
// cheap) means a writer-added dependency authored AFTER an earlier iteration's
// install is always present at the gate. When NO contract exists yet (greenfield
// clone HEAD, pre-writer) it is a pure no-op (exit 0). Tanren names no stack: the
// resolved command is the project's `just bootstrap` (from `.tanren/ci.yml`
// `bootstrap.run`), and the greenfield-vs-frozen concern lives inside that recipe.
// Safe to call before every gate.
//
// On a nonzero exit / timeout / substrate failure it throws WorkspaceDepsInstallError
// (mirroring bootstrapWorkspace) so the failure halts the run loudly with a typed,
// bounded diagnostic — never a silent skip.
export async function ensureWorkspaceDepsInstalled(
  input: EnsureWorkspaceDepsInput,
): Promise<EnsureWorkspaceDepsResult> {
  const command = input.command ?? DEFAULT_BOOTSTRAP_COMMAND;
  // The guard runs entirely runner-side in ONE round-trip: if the project CONTRACT
  // (`justfile` / `.tanren/ci.yml`) is present, print the install sentinel then run
  // the bootstrap; otherwise print the no-op sentinel and exit 0. It runs whenever
  // the contract is present (no deps-present gate) so a writer-added dependency
  // installs even when an earlier iteration already prepared the tree — the
  // project's `just bootstrap` is the idempotency authority, so a redundant run is a
  // cheap no-op. `set -e` is intentionally NOT used at the top — the `if`/`else`
  // already controls flow and the bootstrap command surfaces its own nonzero exit.
  // TOOLCHAIN PROVISION (environment-management.md §3): inside the contract-present
  // branch, BEFORE the project's bootstrap, provision the toolchain the repo DECLARES —
  // its own `mise.toml` if it ships one, otherwise whatever its standard declaration
  // files say (`package.json#packageManager`, `.nvmrc`, `.python-version`, a lockfile,
  // …). Detection needs the repo's bytes, so it is resolved here, in its own round-trip,
  // BEFORE the guard is built; the resulting command verifies each declared binary is on
  // PATH and exits nonzero naming the file that declared it if not.
  //
  // Re-detected every gate on purpose: a writer that ADDS a declaration mid-run (a new
  // `packageManager` field, a new lockfile) must get that toolchain provisioned before
  // the next gate, exactly as a writer-added dependency must get installed.
  //
  // Chained with `&&` so a failed provision ABORTS the branch — the project's bootstrap
  // never runs against a tree whose toolchain is not there.
  //
  // WHY THERE IS NO `set -e` HERE, AND WHY THE PROVISION STILL FAILS CLOSED. The provision
  // must run IN THIS SHELL: it leaves behind the `export`s and the `mise env` PATH the
  // bootstrap chained after it depends on, and a `( set -e; … )` subshell would discard
  // exactly that. It would not even fail closed — POSIX ignores `-e` for any command of an
  // AND-OR list other than the last, and that extends into the subshell, so
  // `( set -e; false; echo x ) && y` runs both in sh, bash and dash. The abort semantics
  // therefore live INSIDE `toolchainProvisionCommand` (and `underMiseLock`), where every
  // step carries its own nonzero exit, rather than in a wrapper here that cannot deliver
  // them. The `&&` below is what turns that nonzero into "the bootstrap does not run".
  const detection = await resolveWorkspaceToolchain({
    ssh: input.ssh,
    target: input.target,
    workspacePath: input.workspacePath,
  });
  const guarded =
    `if [ -f ${JUSTFILE_PATH} ] || [ -f .tanren/ci.yml ]; then ` +
    `echo ${quoteSshShellArg(DEPS_INSTALL_SENTINEL)}; ` +
    `{ ${toolchainProvisionCommand(detection, input.workspacePath)}; } && { ${command}; }; ` +
    `else echo ${quoteSshShellArg(DEPS_NOOP_SENTINEL)}; fi`;
  // SUBSTRATE BOUNDARY: the app-env prelude is prepended to the EXECUTED guard
  // ONLY, never to `command` (the value carried into the error below), so a
  // failed install surfaces the ORIGINAL install command and no app-secret value
  // reaches WorkspaceDepsInstallError or the run's event payloads.
  const result = await input.ssh.run(input.target, {
    // PROJECT-COMMAND path: mise-activate the guarded install (so a writer-added dep
    // installs under the project's declared toolchain — a no-op when none declared),
    // THEN prepend the app-env prelude. Both on the EXECUTED string only; the error
    // command stays the ORIGINAL (prelude-free). Codex never runs through this path.
    command: withMiseActivation(withAppEnv(guarded, input.appEnv), input.workspacePath),
    cwd: input.workspacePath,
    // VCS/build op: output-driven + the workspace as the silent-stretch liveness
    // probe (the install writes files as it works). NEVER killed for elapsed time.
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
  });

  const succeeded = result.failure === undefined && result.stalled !== true && result.exitCode === 0;
  if (!succeeded) {
    const outputTail = tailOf(combinedOutput(result));
    // INFRASTRUCTURE-FAULT TRIAGE (the second half of the fix). A deps-install that died
    // because a TOOLCHAIN BINARY is missing is not a scaffold defect: no source edit
    // installs a program. Routing it to the writer — which is what a
    // `WorkspaceDepsInstallError` does — spends the whole convergence budget on a loop
    // that cannot be won. Classified as infra, it halts here with a message that names
    // the missing binary, what the repo declared, and how to declare it. A missing
    // `vitest`/`tsc`/project script is NOT claimed by this and keeps its writer route.
    const infraFault = classifyToolchainFault({
      workspacePath: input.workspacePath,
      command,
      exitCode: result.exitCode,
      outputTail,
      // A stall is not a missing binary — see the `stalled` note on classifyToolchainFault.
      stalled: result.stalled === true,
      detection,
      // Whatever the provision managed to verify before the bootstrap died, so the halt
      // reports the toolchain that WAS in effect alongside the binary that was not.
      resolutions: parseToolchainResolutions(result.stdout),
    });
    if (infraFault !== undefined) {
      throw infraFault;
    }
    throw new WorkspaceDepsInstallError(
      input.workspacePath,
      command,
      result.exitCode,
      outputTail,
      result.stalled === true,
    );
  }
  // The install branch echoes DEPS_INSTALL_SENTINEL before running; its presence
  // on stdout tells the caller the install path was taken (vs the no-op skip), so
  // it can cache "deps installed" and skip the stat round-trip on the next gate.
  return {
    installed: result.stdout.includes(DEPS_INSTALL_SENTINEL),
    toolchain: parseToolchainResolutions(result.stdout),
  };
}

function depsInstallFailureMessage(
  command: string,
  exitCode: number | null,
  outputTail: string,
  stalled: boolean,
): string {
  const tail = outputTail === "" ? "" : `: ${outputTail}`;
  return `workspace deps install (${command}) ${failureReason(exitCode, stalled)}${tail}`;
}

// The paths added to the workspace's LOCAL git ignore (`.git/info/exclude`)
// right after clone. This is a per-checkout ignore (NOT a committed `.gitignore`)
// so a later `git add -A` — the bootstrap commit and every writer commit — NEVER
// sweeps an install/build tree into the repo, regardless of whether the cloned
// repo ships a `.gitignore`. This is the durable fix for the 46MB checker-prompt
// failure: a prior gate's `pnpm install` left `node_modules/` in the tree, and
// `git add -A` committed it, ballooning the writer diff past the model's input
// limit. The greenfield scaffold ALSO mandates a committed `.gitignore` (so the
// produced repo is correct); this exclude is the workspace-side belt-and-braces.
export const WORKSPACE_LOCAL_IGNORE_PATHS = ["node_modules/", "dist/"] as const;

export interface SeedWorkspaceLocalIgnoreInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
}

// Appends WORKSPACE_LOCAL_IGNORE_PATHS to the cloned repo's `.git/info/exclude`
// (idempotently — duplicate lines there are harmless and git de-dupes the match).
// Runs over SSH in the workspace dir. Must be called AFTER the clone and BEFORE
// the first install/commit so no `git add -A` can ever stage node_modules/dist.
export async function seedWorkspaceLocalIgnore(input: SeedWorkspaceLocalIgnoreInput): Promise<void> {
  const lines = WORKSPACE_LOCAL_IGNORE_PATHS.map((p) => quoteSshShellArg(p)).join(" ");
  await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "seed workspace local git ignore",
    cwd: input.workspacePath,
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
    // `git rev-parse --git-path info/exclude` resolves the exclude file for the
    // checkout (worktree-safe) and `mkdir -p` ensures its dir exists before we
    // append. printf one path per line.
    command: [
      "set -eu",
      'exclude="$(git rev-parse --git-path info/exclude)"',
      'mkdir -p "$(dirname "$exclude")"',
      `printf '%s\\n' ${lines} >> "$exclude"`,
    ].join("\n"),
  });
}

export interface CommitBootstrapStateInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
}

// Commits whatever the bootstrap step produced (lockfiles, node_modules, any
// generated tree) as ONE synthetic commit on the workspace branch, and returns
// its sha. This commit becomes the writer's diff base (run baseSha), so the
// writer iterations — which diff vs this sha — see only their own changes, not
// bootstrap artifacts.
//
// `--allow-empty` so the no-manifest / artifact-free case still yields a real
// commit, keeping the run base a concrete sha and the later PR-branch cleanup
// (drop-the-bootstrap-commit rebase) symmetric in every case.
export async function commitBootstrapState(input: CommitBootstrapStateInput): Promise<string> {
  const result = await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "commit bootstrap state",
    cwd: input.workspacePath,
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
    command: [
      "set -eu",
      "git add -A",
      // -q so the commit summary stays off stdout; git rev-parse is then the
      // only stdout-producing step and its output is the bootstrap commit sha.
      "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' " +
        `git commit -q --allow-empty -m ${quoteSshShellArg(BOOTSTRAP_COMMIT_MESSAGE)}`,
      "git rev-parse HEAD",
    ].join(" && "),
  });
  const sha = result.stdout.trim();
  // "" only on a fake SSH that yields no output (unit paths drive the loop with
  // fake writers that ignore baseSha), mirroring prepareWorkspace. The real
  // runner always returns a 40-hex sha.
  if (sha !== "" && !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`bootstrap commit returned invalid sha: ${sha}`);
  }
  return sha;
}

// Resolve the workspace HEAD commit sha over SSH — the commit the native gate is
// verifying when it runs. The native `gate.verdict` is anchored on this sha (the
// headSha CI-intelligence reduces). Returns "" on a fake SSH that yields no output
// (unit paths), in which case the caller emits no verdict; a real runner always
// returns a 40-hex sha and a malformed value is a LOUD throw (never a guessed sha).
export async function resolveWorkspaceHeadSha(input: {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
}): Promise<string> {
  const result = await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "resolve workspace head sha",
    cwd: input.workspacePath,
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
    command: "git rev-parse HEAD",
  });
  const sha = result.stdout.trim();
  if (sha !== "" && !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`workspace head resolution returned invalid sha: ${sha}`);
  }
  return sha;
}

function bootstrapFailureMessage(
  command: string,
  exitCode: number | null,
  outputTail: string,
  stalled: boolean,
): string {
  const tail = outputTail === "" ? "" : `: ${outputTail}`;
  return `workspace bootstrap (${command}) ${failureReason(exitCode, stalled)}${tail}`;
}
