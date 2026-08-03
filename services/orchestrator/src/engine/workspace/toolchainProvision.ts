// LAYER-2 PROVISIONING for a repository that declares its toolchain WITHOUT a
// `mise.toml` (environment-management.md §3 Layer 2). The provisioner is unchanged —
// it is still mise, the one general provisioner the doctrine names. What changes is
// WHAT it is asked to install: the requirements Layer-1 detection read out of the
// repo's own declaration files (./toolchainDeclarations.ts).
//
// The shell this module builds does three things, in order, and the third is the point:
//   1. `mise use --global <tool>@<spec> …` — install the detected tools AND record them
//      in the runner user's own mise config. `--global` deliberately writes OUTSIDE the
//      workspace: Tanren never materializes a config file into a repository it did not
//      author, so the writer's diff, the bootstrap commit and the pushed branch stay
//      exactly as clean as before.
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
import { MISE_CONFIG_REL_PATH, miseProvisionCommand, TOOLCHAIN_PROVISIONED_MARKER } from "../ssh/miseActivate.js";
import { combinedOutput, commandSucceeded, failureReason, tailOf } from "./outputTail.js";
import {
  detectToolchainRequirements,
  provisionableBinaries,
  TOOLCHAIN_CONTENT_DECLARATION_PATHS,
  TOOLCHAIN_PRESENCE_DECLARATION_PATHS,
  type ToolchainDeclarationFile,
  type ToolchainDetection,
  type ToolchainRequirement,
} from "./toolchainDeclarations.js";

/** Frame emitted around each declaration file the read command finds. Long and
 * Tanren-specific so ordinary file content cannot be mistaken for a frame. */
const DECLARATION_FRAME = "===TANREN-TOOLCHAIN-DECLARATION:";

// Bounded per-file read. Root manifests are small; the bound exists so a pathological
// file can never flood the substrate, not as a policy on file size.
const DECLARATION_READ_BYTES = 65_536;

/** Printed when a repo ships no declaration Tanren recognizes. Stated, not silent. */
export const NO_DECLARATION_NOTICE = "tanren: no toolchain declaration found - nothing to provision";

/** Printed when every declaration a repo DID ship was one Tanren could not honor. */
export const NOTHING_PROVISIONABLE_NOTICE =
  "tanren: no toolchain declaration could be provisioned - see the NOT honored lines above";

/** Printed only after every declared binary has been proven to resolve. */
export const TOOLCHAIN_VERIFIED_NOTICE = "tanren: declared toolchain provisioned and verified on PATH";

/**
 * One round-trip that emits every toolchain declaration file the workspace ships.
 * Content paths are emitted with their bytes; presence paths (lockfiles, which name a
 * tool but no version) are emitted as an empty frame, so a large or binary lockfile is
 * never piped back. A repo `mise.toml` is probed too because its presence short-
 * circuits detection entirely.
 */
export function toolchainDeclarationReadCommand(): string {
  const frame = (path: string): string =>
    `printf '%s%s===\\n' ${quoteSshShellArg(DECLARATION_FRAME)} ${quoteSshShellArg(path)}`;
  const parts: string[] = [];
  for (const path of [MISE_CONFIG_REL_PATH, ...TOOLCHAIN_PRESENCE_DECLARATION_PATHS]) {
    parts.push(`if [ -f ${quoteSshShellArg(path)} ]; then ${frame(path)}; fi`);
  }
  for (const path of TOOLCHAIN_CONTENT_DECLARATION_PATHS) {
    parts.push(
      `if [ -f ${quoteSshShellArg(path)} ]; then ${frame(path)}; ` +
        `head -c ${String(DECLARATION_READ_BYTES)} ${quoteSshShellArg(path)}; printf '\\n'; fi`,
    );
  }
  return parts.join("; ");
}

/** Parse {@link toolchainDeclarationReadCommand}'s stdout back into files. Pure. */
export function parseToolchainDeclarationOutput(stdout: string): ToolchainDeclarationFile[] {
  const files: ToolchainDeclarationFile[] = [];
  let current: { path: string; lines: string[] } | undefined;
  const flush = (): void => {
    if (current !== undefined) files.push({ path: current.path, contents: current.lines.join("\n") });
  };
  for (const line of stdout.split("\n")) {
    if (line.startsWith(DECLARATION_FRAME) && line.endsWith("===")) {
      flush();
      current = { path: line.slice(DECLARATION_FRAME.length, line.length - 3), lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  flush();
  return files;
}

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
export function toolchainProvisionCommand(detection: ToolchainDetection): string {
  if (detection.deferToMiseConfig) {
    // The repo's OWN mise config outranks anything Tanren could read from its
    // conventions: trust + install it verbatim, through the SAME command as before.
    return miseProvisionCommand();
  }
  const parts: string[] = [];
  for (const { path, reason } of detection.unresolved) {
    // A declaration Tanren READ but cannot honor is announced, never dropped. It is
    // not fatal on its own — the tool may not be one this repo's bootstrap needs — but
    // it is surfaced here and quoted again by the missing-binary halt if it turns out
    // that it was.
    parts.push(echo(`tanren: toolchain declaration NOT honored - ${path} ${reason}`));
  }
  if (detection.requirements.length === 0) {
    // Only claim "nothing was declared" when nothing was: with unhonored declarations
    // the lines above already said what was found and why it could not be provisioned.
    if (detection.unresolved.length === 0) parts.push(echo(NO_DECLARATION_NOTICE));
    else parts.push(echo(NOTHING_PROVISIONABLE_NOTICE));
    return parts.join("; ");
  }
  parts.push("export MISE_YES=1");
  parts.push(echo(`tanren: provisioning declared toolchain - ${describeRequirements(detection.requirements)}`));
  // `--global`: recorded in the runner user's mise config, NOT in the repository.
  parts.push(`mise use --global ${detection.requirements.map((r) => quoteSshShellArg(toolchainSpec(r))).join(" ")}`);
  parts.push('eval "$(mise env -s bash)"');
  for (const requirement of detection.requirements) {
    parts.push(
      `command -v ${quoteSshShellArg(requirement.bin)} >/dev/null 2>&1 || ` +
        `{ ${echoErr(missingBinaryMessage(requirement))}; exit 1; }`,
    );
  }
  parts.push(`: > "${TOOLCHAIN_PROVISIONED_MARKER}"`);
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

function echo(message: string): string {
  return `printf '%s\\n' ${quoteSshShellArg(message)}`;
}

function echoErr(message: string): string {
  return `printf '%s\\n' ${quoteSshShellArg(message)} >&2`;
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
 * Read the toolchain declarations the workspace ships and resolve them into
 * requirements. ONE round-trip. A substrate/transport failure is NOT read as "the repo
 * declares nothing" — it throws {@link WorkspaceMiseProvisionError}, so a transient
 * hiccup can never be mistaken for a no-toolchain repo (the precise mistake, in its
 * silent form, that this whole change exists to remove).
 */
export async function resolveWorkspaceToolchain(input: ProvisionMiseToolchainInput): Promise<ToolchainDetection> {
  const result = await input.ssh.run(input.target, {
    command: toolchainDeclarationReadCommand(),
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
  return detectToolchainRequirements(parseToolchainDeclarationOutput(result.stdout));
}

/**
 * Provision the project's DECLARED toolchain at workspace-prep, BEFORE the project's
 * bootstrap runs (environment-management.md §3 Layer 2).
 *
 * Detection is Layer 1 (./toolchainDeclarations.ts): a repo `mise.toml` if it ships one,
 * otherwise the standard declaration files it does ship. Provisioning is Layer 2, and is
 * mise either way. Verification is the part that did not exist before: the command exits
 * nonzero, naming the tool and the file that declared it, if a declared binary is not on
 * PATH afterwards. A nonzero exit / stall / substrate failure throws
 * {@link WorkspaceMiseProvisionError} so the run halts LOUDLY. This is the PROJECT path;
 * it never touches Tanren's harness (codex keeps the runner's isolated node — mise is
 * still never globally activated).
 *
 * Returns the detection so the caller can attribute a later missing-binary failure to
 * what the repo did (and did not) declare.
 */
export async function provisionMiseToolchain(input: ProvisionMiseToolchainInput): Promise<ToolchainDetection> {
  const detection = await resolveWorkspaceToolchain(input);
  const result = await input.ssh.run(input.target, {
    // `set -e` so any failing step in the provision chain surfaces a nonzero exit.
    command: `set -e; ${toolchainProvisionCommand(detection)}`,
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
  return detection;
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
  ) {
    super(toolchainUnavailableMessage(command, missingBinary, detection, exitCode, outputTail));
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
  detection: ToolchainDetection;
}): WorkspaceToolchainUnavailableError | undefined {
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
  );
}

function toolchainUnavailableMessage(
  command: string,
  missingBinary: string,
  detection: ToolchainDetection,
  exitCode: number | null,
  outputTail: string,
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
