// LAYER-2 PROVISIONING for a repository that declares its toolchain WITHOUT a
// `mise.toml` (environment-management.md §3 Layer 2). The provisioner is unchanged —
// it is still mise, the one general provisioner the doctrine names. What changes is
// WHAT it is asked to install: the requirements Layer-1 detection read out of the
// repo's own declaration files (./toolchainDeclarations.ts).
//
// The shell this module builds does three things, in order, and the third is the point:
//   1. `mise use --global <tool>@<spec> …` — install the detected tools AND record them
//      in THIS RUN's own mise config (ssh/miseActivate.ts `miseRunScope`), held under the
//      runner-wide mise lock because the installs tree behind it is shared by every
//      concurrent run. `--global` deliberately writes OUTSIDE the workspace: Tanren never
//      materializes a config file into a repository it did not author, so the writer's
//      diff, the bootstrap commit and the pushed branch stay exactly as clean as before.
//   2. activate, so the tools are on PATH for the verification below.
//   3. VERIFY every declared binary actually resolves — and exit NONZERO naming the
//      tool, its version and the FILE that declared it when one does not. This is the
//      whole remedy for the observed defect: provisioning that quietly did nothing,
//      followed by an opaque `pnpm: not found` exit 127 three layers downstream. There
//      is no path through this command that reports success without the binaries being
//      present on PATH.
//
// This module builds command STRINGS only — it executes nothing (the SSH round-trips
// live in ./bootstrap.ts), which is what keeps every branch of it unit-testable.

import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { miseProvisionCommand, miseRunScope, miseScopeExport, underMiseLock } from "../ssh/miseActivate.js";
import { combinedOutput, commandSucceeded, failureReason, tailOf } from "./outputTail.js";
import {
  newDeclarationNonce,
  parseToolchainDeclarationOutput,
  toolchainDeclarationReadCommand,
} from "./toolchainDeclarationRead.js";
import {
  detectToolchainRequirements,
  provisionableBinaries,
  TOOLCHAIN_CONTENT_DECLARATION_PATHS,
  TOOLCHAIN_PRESENCE_DECLARATION_PATHS,
  type ToolchainDetection,
  type ToolchainRequirement,
} from "./toolchainDeclarations.js";
import {
  classifyUnhonoredDeclarations,
  describeToolchainInEffect,
  parseToolchainResolutions,
  toolchainVerificationParts,
  type ToolchainResolution,
} from "./toolchainEnforcement.js";

// The declaration READ + its invocation-bound framing live in ./toolchainDeclarationRead.ts
// — the one seam in this area whose input is repository-controlled bytes. Re-exported so
// callers and tests keep a single import site.
export {
  newDeclarationNonce,
  parseToolchainDeclarationOutput,
  toolchainDeclarationReadCommand,
} from "./toolchainDeclarationRead.js";

/** Printed when a repo ships no declaration Tanren recognizes. Stated, not silent. */
export const NO_DECLARATION_NOTICE = "tanren: no toolchain declaration found - nothing to provision";

/** Printed when every declaration a repo DID ship was one Tanren could not honor. */
export const NOTHING_PROVISIONABLE_NOTICE =
  "tanren: no toolchain declaration could be provisioned - see the NOT honored lines above";

/** Printed only after every declared binary has been proven to resolve. */
export const TOOLCHAIN_VERIFIED_NOTICE = "tanren: declared toolchain provisioned and verified on PATH";

/** Printed when `mise env` — the step that puts the freshly-installed tools on PATH for
 * everything that follows in this shell — exits nonzero. Its status is invisible through
 * `eval "$(…)"`, so it is captured and reported rather than evaluated as an empty string. */
export const MISE_ENV_FAILED_MESSAGE =
  "tanren: toolchain provision FAILED - 'mise env' exited nonzero, so the provisioned toolchain could not be " +
  "put on PATH. Proceeding would run the project's own commands against an undeclared toolchain.";

/** The mise spec string handed to `mise use` for a requirement. */
export function toolchainSpec(requirement: ToolchainRequirement): string {
  return `${requirement.tool}@${requirement.spec}`;
}

/**
 * The shell that provisions + VERIFIES a detected toolchain. The caller runs it under
 * `set -e`, and every failure path exits nonzero with a message naming the tool, the
 * version and the declaration file — never a silent skip, never an unattributed error.
 *
 * When there is nothing to provision it emits a stated no-op line rather than a
 * fabricated success, so the run timeline records what Tanren concluded about the repo.
 */
export function toolchainProvisionCommand(detection: ToolchainDetection, workspacePath: string): string {
  if (detection.deferToMiseConfig) {
    // The repo's OWN mise config outranks anything Tanren could read from its
    // conventions: trust + install it verbatim, through the SAME command as before.
    return miseProvisionCommand(workspacePath);
  }
  const scope = miseRunScope(workspacePath);
  const parts: string[] = [];
  for (const { path, reason } of detection.unresolved) {
    // A declaration Tanren READ but cannot honor is announced, never dropped. The
    // `untranslatable-version` ones never reach this command at all — the caller
    // (`resolveWorkspaceToolchain`) has already halted on them, because proceeding would
    // gate the repo against a version it never declared. What is left here is the
    // `unresolvable-declaration` remainder: Tanren identified no provisionable tool, so
    // there is no version to be wrong about. Those are surfaced and quoted again by the
    // missing-binary halt if it turns out the bootstrap needed that tool after all.
    parts.push(echo(`tanren: toolchain declaration NOT honored - ${path} ${reason}`));
  }
  if (detection.requirements.length === 0) {
    // Only claim "nothing was declared" when nothing was: with unhonored declarations
    // the lines above already said what was found and why it could not be provisioned.
    if (detection.unresolved.length === 0) parts.push(echo(NO_DECLARATION_NOTICE));
    else parts.push(echo(NOTHING_PROVISIONABLE_NOTICE));
    return parts.join("; ");
  }
  // `miseScopeExport` settles BOTH things this third mise seam has to agree with the
  // other two about: the shared data dir the image published (or the install lands where
  // the activation will not look — and this command's own verification would still pass,
  // because it runs in the same shell as the install), and THIS run's config file rather
  // than a runner-wide one two concurrent runs would overwrite for each other.
  parts.push(miseScopeExport(scope));
  parts.push(echo(`tanren: provisioning declared toolchain - ${describeRequirements(detection.requirements)}`));
  // `--global`: recorded in THIS RUN's mise config (miseRunScope — never the runner-wide
  // one two concurrent runs would fight over), and never in the repository. Held under
  // the shared lock because `mise use` also INSTALLS, and the installs tree is shared:
  // unsynchronised, two runs race on `installs/<tool>/latest` (`ln -sf … File exists`).
  // `mise trust` clears mise's config-trust gate for the Tanren-authored config, exactly
  // as the golden image does for its own off-default global config (runner/Dockerfile).
  //
  // EVERY STEP BELOW FAILS CLOSED ON ITS OWN, and none of them may lean on the caller's
  // `set -e`. `provisionMiseToolchain` supplies one; the per-gate caller
  // (`ensureWorkspaceDepsInstalled`) deliberately does NOT, because the provision must
  // leave its `export`s and its `mise env` PATH in the SAME shell that then runs the
  // project's bootstrap — a subshell or an `exit`-on-first-error wrapper would discard
  // exactly the environment the whole step exists to establish. So the chain is `&&`-ed
  // where a later step depends on an earlier one, and each remaining step carries its own
  // `|| { …; exit 1; }`. Under a `;`-joined list the group's status is only its LAST
  // element's, which is how a failed install used to be reported as a successful provision.
  const specs = detection.requirements.map((r) => quoteSshShellArg(toolchainSpec(r))).join(" ");
  parts.push(
    underMiseLock(
      scope,
      `{ [ -f "${scope.configFile}" ] || : > "${scope.configFile}"; } && ` +
        `mise trust "${scope.configFile}" && mise use --global ${specs}`,
    ),
  );
  // `eval "$(…)"` reports the status of `eval`, NEVER of the command substitution: a
  // `mise env` that died leaves an EMPTY eval that "succeeds", and the verification below
  // would then be probing the un-updated PATH. Capture, check, then evaluate.
  parts.push(
    `__tanren_mise_env="$(mise env -s bash)" || { ${echoErr(MISE_ENV_FAILED_MESSAGE)}; exit 1; }`,
    'eval "$__tanren_mise_env"',
  );
  for (const requirement of detection.requirements) {
    // VERIFICATION (./toolchainEnforcement.ts): the binary must resolve, it must BE the
    // one Tanren provisioned (not an image-baked copy earlier on PATH), mise must have
    // resolved a concrete version for it, and that version must SATISFY what the repo
    // declared. Each check exits nonzero naming the file, the declaration and what was
    // actually found; on success it emits the machine-readable "in effect" frame that
    // carries the resolved version out of the run.
    parts.push(...toolchainVerificationParts(requirement));
  }
  // The marker is the ACTIVATION TRIGGER for every later command in this run
  // (ssh/miseActivate.ts branch 2). A marker that silently failed to write means every
  // subsequent gate command runs without the toolchain that was just installed, so the
  // write is checked like any other provisioning step.
  parts.push(`: > "${scope.markerFile}" || { ${echoErr(markerWriteFailedMessage(scope.markerFile))}; exit 1; }`);
  parts.push(echo(TOOLCHAIN_VERIFIED_NOTICE));
  return parts.join("; ");
}

function describeRequirements(requirements: readonly ToolchainRequirement[]): string {
  return requirements
    .map(
      (r) => `${toolchainSpec(r)} (declared in ${r.declaredIn}${r.versionDeclared ? "" : ", version unconstrained"})`,
    )
    .join(", ");
}

function missingBinaryMessage(requirement: ToolchainRequirement): string {
  return (
    `tanren: toolchain provision FAILED - ${requirement.declaredIn} declares ` +
    `${toolchainSpec(requirement)} but the '${requirement.bin}' binary is still not on PATH after ` +
    `'mise use --global'. The declared toolchain could not be provisioned on this runner.`
  );
}

function markerWriteFailedMessage(markerFile: string): string {
  return (
    `tanren: toolchain provision FAILED - could not write the provisioned marker (${markerFile}). Without it no ` +
    `later command in this run activates the toolchain that was just installed, so the run halts here instead.`
  );
}

function echo(message: string): string {
  return `printf '%s\\n' ${quoteSshShellArg(message)}`;
}

// ---- Execution ------------------------------------------------------------------

// A typed, observable toolchain-provisioning failure (environment-management.md §3).
// Carries the exit code + a bounded output tail so a halting run has a concrete
// diagnostic. Per the no-silent-fallback doctrine a failed provision HALTS the run
// loudly — never a silent skip of the toolchain the project declared. It is
// deliberately NOT a `WorkspaceDepsInstallError`: the writer-routing boundary
// (workflow/gate/bootstrapFailure.ts) keys on that class, and a toolchain that will not
// install is not something a source edit can fix.
export class WorkspaceMiseProvisionError extends Error {
  override readonly name = "WorkspaceMiseProvisionError";

  constructor(
    readonly workspacePath: string,
    readonly exitCode: number | null,
    readonly outputTail: string,
    readonly stalled: boolean,
  ) {
    super(`workspace toolchain provision ${failureReason(exitCode, stalled)}${suffix(outputTail)}`);
  }
}

export interface ProvisionMiseToolchainInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
}

/**
 * Read the toolchain declarations the workspace ships, resolve them into requirements,
 * and ENFORCE that every version declaration Tanren read is one it can honor. ONE
 * round-trip. A substrate/transport failure is NOT read as "the repo declares nothing" —
 * it throws {@link WorkspaceMiseProvisionError}, so a transient hiccup can never be
 * mistaken for a no-toolchain repo (the precise mistake, in its silent form, that this
 * whole change exists to remove).
 *
 * THE ENFORCEMENT LIVES HERE, at the single choke point BOTH provisioning paths pass
 * through (workspace-prep's `provisionMiseToolchain` and the per-gate
 * `ensureWorkspaceDepsInstalled`) — one place, so the two can never drift into disagreeing
 * about whether an unhonored declaration is fatal. A declaration whose VERSION Tanren
 * cannot translate for a tool it CAN provision throws {@link WorkspaceToolchainUnhonoredError}
 * BEFORE any provision command is built: proceeding would run the repo's own gate against
 * whatever copy of that tool the image happens to carry, which is the silent degradation
 * this closes. See ./toolchainEnforcement.ts for what is deliberately NOT claimed.
 */
export async function resolveWorkspaceToolchain(input: ProvisionMiseToolchainInput): Promise<ToolchainDetection> {
  // ONE nonce per read: the frames the runner emits back are trusted only if they carry it,
  // so bytes committed to the repository cannot forge a declaration file. See the note on
  // {@link DECLARATION_FRAME}.
  const nonce = newDeclarationNonce();
  const result = await input.ssh.run(input.target, {
    command: toolchainDeclarationReadCommand(nonce),
    cwd: input.workspacePath,
    watchdog: watchdogFor(input),
  });
  if (!commandSucceeded(result)) {
    throw new WorkspaceMiseProvisionError(
      input.workspacePath,
      result.exitCode,
      tailOf(combinedOutput(result)),
      result.stalled === true,
    );
  }
  const detection = detectToolchainRequirements(parseToolchainDeclarationOutput(result.stdout, nonce));
  const unhonored = classifyUnhonoredDeclarations(input.workspacePath, detection);
  if (unhonored !== undefined) {
    throw unhonored;
  }
  return detection;
}

/** What a provision concluded: the declarations Tanren read, and — the part an operator
 * needs and previously could not get — the concrete version each declared tool ACTUALLY
 * resolved to on the runner. Carried as a value so "which version ran" survives the
 * console line scrolling past; the run's `workspace.prepared` event records it. */
export interface ToolchainProvisionOutcome {
  readonly detection: ToolchainDetection;
  readonly resolutions: readonly ToolchainResolution[];
}

/**
 * Provision the project's DECLARED toolchain at workspace-prep, BEFORE the project's
 * bootstrap runs (environment-management.md §3 Layer 2).
 *
 * Detection is Layer 1 (./toolchainDeclarations.ts): a repo `mise.toml` if it ships one,
 * otherwise the standard declaration files it does ship. Provisioning is Layer 2, and is
 * mise either way. VERIFICATION now covers the version, not only the binary: a declaration
 * Tanren could not translate never gets this far (`resolveWorkspaceToolchain` throws
 * {@link WorkspaceToolchainUnhonoredError}), and for everything it DID provision the
 * command exits nonzero if the binary is missing, is not the one Tanren provisioned, or
 * resolved to a version that does not satisfy what the repo declared. A nonzero exit /
 * stall / substrate failure throws {@link WorkspaceMiseProvisionError} so the run halts
 * LOUDLY. This is the PROJECT path; it never touches Tanren's harness (codex keeps the
 * runner's isolated node — mise is still never globally activated).
 *
 * Returns the detection so the caller can attribute a later missing-binary failure to
 * what the repo did (and did not) declare, plus the RESOLVED versions so the run can
 * record which toolchain was actually in effect.
 */
export async function provisionMiseToolchain(input: ProvisionMiseToolchainInput): Promise<ToolchainProvisionOutcome> {
  const detection = await resolveWorkspaceToolchain(input);
  const result = await input.ssh.run(input.target, {
    // `set -e` so any failing step in the provision chain surfaces a nonzero exit.
    command: `set -e; ${toolchainProvisionCommand(detection, input.workspacePath)}`,
    cwd: input.workspacePath,
    watchdog: watchdogFor(input),
  });
  if (!commandSucceeded(result)) {
    throw new WorkspaceMiseProvisionError(
      input.workspacePath,
      result.exitCode,
      tailOf(combinedOutput(result)),
      result.stalled === true,
    );
  }
  return { detection, resolutions: parseToolchainResolutions(result.stdout) };
}

// ---- Infrastructure-fault classification ----------------------------------------

// A missing binary named by a shell that could not find it. Covers the two POSIX
// wordings (`sh: 1: pnpm: not found`, `bash: line 1: pnpm: command not found`) and the
// `just`/`make` re-emissions of them. Deliberately generic — no tool is named here.
const MISSING_BINARY_PATTERN = /(?:^|[\s/])([A-Za-z0-9._+-]+): (?:command )?not found/mu;

/**
 * A deps-install failure that is an INFRASTRUCTURE fault rather than a source defect:
 * the project's bootstrap called a toolchain binary that is not on the runner.
 *
 * WHY THIS CLASS EXISTS. The gate's writer-routing boundary turns a failed deps-install
 * into a P0 finding and dispatches a remediation writer at it. For a genuine scaffold
 * defect (a lockfile that will not install) that is right. For a MISSING BINARY it is an
 * unwinnable loop: no edit to any source file installs a program, so the writer burns
 * budget re-reading the same error until the convergence answerer gives up. Carrying a
 * distinct class lets that boundary decline it and halt legibly instead.
 */
export class WorkspaceToolchainUnavailableError extends Error {
  override readonly name = "WorkspaceToolchainUnavailableError";

  constructor(
    readonly workspacePath: string,
    readonly command: string,
    readonly missingBinary: string,
    readonly exitCode: number | null,
    readonly outputTail: string,
    readonly detection: ToolchainDetection,
    /** What the declared tools ACTUALLY resolved to on this runner, when the run got far
     * enough to verify them. Quoted in the message so a missing-binary halt also answers
     * "…and which versions WERE in effect" without the operator hunting for the line. */
    readonly resolutions: readonly ToolchainResolution[] = [],
  ) {
    super(toolchainUnavailableMessage(command, missingBinary, detection, exitCode, outputTail, resolutions));
  }
}

/**
 * Classify a failed deps-install as an infrastructure fault, or return `undefined` to
 * leave it on the writer-routable path.
 *
 * DELIBERATELY NARROW. It fires on exactly two conditions, and only when the shell
 * actually named a missing binary:
 *   - the binary is one Tanren knows how to provision from a declaration (`pnpm`, `uv`,
 *     `go`, `cargo`, …) — so "your bootstrap needs a toolchain nobody declared";
 *   - or the binary is one the repo DID declare and Tanren could NOT honor (an
 *     unresolved declaration naming that tool) — the repo asked, Tanren could not
 *     deliver, and no writer can close that gap either.
 *
 * A missing `vitest`/`tsc`/project script is NOT claimed: those really are scaffold
 * defects the writer can fix by declaring the dependency, and they keep their existing
 * route into the loop.
 */
export function classifyToolchainFault(input: {
  workspacePath: string;
  command: string;
  exitCode: number | null;
  outputTail: string;
  /** Whether the activity watchdog surfaced a no-sign-of-life stall. A STALL IS A LIVENESS
   * FAULT, never a missing-binary one, and the two must not be confused: a guard that
   * stalled can carry a partial `pnpm: not found` written by the project's bootstrap
   * moments before it wedged, and reading that as "the toolchain is not on this runner"
   * both halts a run the writer path could have re-driven and prints `exited unknown`
   * (the exit code of a stall is `null`) instead of saying the command stopped responding. */
  stalled: boolean;
  detection: ToolchainDetection;
  resolutions?: readonly ToolchainResolution[];
}): WorkspaceToolchainUnavailableError | undefined {
  if (input.stalled) {
    return undefined;
  }
  const missing = MISSING_BINARY_PATTERN.exec(input.outputTail)?.[1];
  if (missing === undefined) {
    return undefined;
  }
  const declaredButUnhonored = input.detection.unresolved.some((u) => u.tool === missing);
  if (!declaredButUnhonored && !provisionableBinaries().includes(missing)) {
    return undefined;
  }
  return new WorkspaceToolchainUnavailableError(
    input.workspacePath,
    input.command,
    missing,
    input.exitCode,
    input.outputTail,
    input.detection,
    input.resolutions ?? [],
  );
}

function toolchainUnavailableMessage(
  command: string,
  missingBinary: string,
  detection: ToolchainDetection,
  exitCode: number | null,
  outputTail: string,
  resolutions: readonly ToolchainResolution[],
): string {
  const declared =
    detection.requirements.length === 0
      ? "nothing — this repository ships no toolchain declaration Tanren recognizes"
      : describeRequirements(detection.requirements);
  const notHonored =
    detection.unresolved.length === 0
      ? ""
      : `\nDeclarations read but NOT honored: ${detection.unresolved
          .map(({ path, reason }) => `${path} ${reason}`)
          .join("; ")}.`;
  return [
    `workspace bootstrap (${command}) needs the '${missingBinary}' binary, which is not available on this runner ` +
      `(${failureReason(exitCode, false)}).`,
    `Tanren provisions a toolchain from what a repository DECLARES: its own mise.toml, or the standard ` +
      `declaration files (${[...TOOLCHAIN_CONTENT_DECLARATION_PATHS, ...TOOLCHAIN_PRESENCE_DECLARATION_PATHS].join(", ")}).`,
    `Detected here: ${declared}.${notHonored}`,
    `Toolchain actually in effect on this runner: ${describeToolchainInEffect(resolutions)}.`,
    detection.unresolved.some((u) => u.tool === missingBinary)
      ? `'${missingBinary}' WAS declared, but Tanren could not turn that declaration into a provisionable tool. ` +
        `Declare it in a mise.toml, which mise resolves directly, or make it available on the runner image.`
      : `Declare '${missingBinary}' in one of those files — or in a mise.toml — and the run can proceed.`,
    `This is an INFRASTRUCTURE fault, not a source defect: no code change installs a binary, so the run halts ` +
      `here rather than dispatching a remediation writer at an unwinnable loop.${suffix(outputTail)}`,
  ].join("\n");
}

function suffix(outputTail: string): string {
  return outputTail === "" ? "" : `: ${outputTail}`;
}

function watchdogFor(input: ProvisionMiseToolchainInput): ReturnType<typeof buildActivityWatchdog> {
  // VCS/provision op: output-driven + the workspace as the silent-stretch liveness
  // probe (a provision writes the toolchain as it works). Never killed for elapsed time.
  return buildActivityWatchdog({
    substrate: input.ssh,
    target: input.target,
    cls: "vcs",
    workspace: input.workspacePath,
  });
}
