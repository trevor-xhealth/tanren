// TOOLCHAIN ENFORCEMENT — "declared X, ran Y" is as loud as "X is missing".
//
// THE HOLE THIS CLOSES. Layer-1 detection (./toolchainDeclarations.ts) correctly refuses
// to GUESS at a version alias it cannot translate, and the provisioner announced it:
//
//   tanren: toolchain declaration NOT honored - .nvmrc "lts/iron" is not a version mise
//   can provision
//
// …and then exited 0. Measured in a real runner container: the repo's `just bootstrap`
// then succeeded on the IMAGE's harness node v24.16.0, a version the repo never asked
// for. The infrastructure-fault classifier fired only when a BINARY WAS MISSING, so
// "declared X, silently ran Y" walked straight through — Y is present. The gate IS the
// merge authority, so that is a merge decision taken against an environment nobody
// declared, announced once in a line that scrolls past. A check that announces a problem
// and then proceeds is a check that will be ignored.
//
// TWO MECHANISMS, and they cover different failures:
//
//   1. PRE-PROVISION (`classifyUnhonoredDeclarations`, pure): a declaration whose VERSION
//      Tanren could not translate for a tool it CAN provision halts BEFORE anything runs.
//      There is nothing to verify afterwards — Tanren never asked mise for anything — so
//      this is the only point at which it can be caught.
//   2. POST-PROVISION (`toolchainVerificationParts`, runner-side): for every requirement
//      Tanren DID hand to mise, prove that what is on PATH is the provisioned binary and
//      that its resolved version SATISFIES what the repo declared. This catches the
//      failures a pre-check cannot see: a provision that silently no-ops, a binary
//      shadowed by an image-baked copy earlier on PATH, a mise that resolved something
//      else.
//
// VERSION-SATISFACTION POLICY, stated once. A declared spec is satisfied by a resolved
// version iff the spec is a COMPONENT-WISE PREFIX of it: `24` is satisfied by `24.18.1`,
// `24.18` by `24.18.1`, `24.18.1` only by `24.18.1` — and `24` is NOT satisfied by
// `25.0.0` or by `241.0.0` (the boundary is a dot, not a character). That is exactly what
// a version FILE means in every ecosystem whose files the catalogue reads: a component
// the repo did not write is a component the repo did not constrain, and Tanren never
// widens a component the repo DID write. A tool declared by a LOCKFILE alone carries no
// version to satisfy (`latest`) — it is reported as unconstrained, never quietly pinned.
// An ALIAS is not a version at all: no concrete version can be shown to satisfy
// `lts/iron`, which is precisely why it is mechanism 1 and not mechanism 2.
//
// This module builds command STRINGS and classifies; it executes nothing.

import { quoteSshShellArg } from "../ssh/command.js";
import type { ToolchainDetection, ToolchainRequirement } from "./toolchainDeclarations.js";

/** Frame emitted for each tool whose version was verified. Long and Tanren-specific so
 * ordinary command output cannot be mistaken for one. Machine-read by
 * {@link parseToolchainResolutions} and human-read as-is by anyone tailing the run. */
const RESOLUTION_FRAME = "===TANREN-TOOLCHAIN-IN-EFFECT:";

/** What a declared tool ACTUALLY resolved to on the runner, against what was declared.
 * This is the answer to "which version really ran" — carried out of the provision as a
 * value rather than left as a console line that scrolls past. */
export interface ToolchainResolution {
  readonly tool: string;
  /** The spec Tanren handed mise — verbatim repo bytes, or `latest` for a lockfile. */
  readonly declared: string;
  /** The concrete version mise resolved, as reported by the runner. */
  readonly resolved: string;
  readonly declaredIn: string;
  /** False when the declaration named the tool but constrained no version. */
  readonly versionDeclared: boolean;
}

/**
 * A toolchain declaration Tanren READ, could not honor, and will not proceed past.
 *
 * WHY IT IS ITS OWN CLASS, AND NOT A `WorkspaceDepsInstallError`. The gate's writer-
 * routing boundary (workflow/gate/bootstrapFailure.ts) keys on THAT class and dispatches
 * a remediation writer. Routing this there would ask an LLM writer to rewrite the
 * operator's own toolchain pin — `.nvmrc: lts/iron` → `.nvmrc: 24` — to make Tanren
 * happy. Tanren must not silently RUN a version the repo did not declare, and it must
 * equally not silently REWRITE the version the repo did declare; both are the same
 * usurpation. So this halts and hands the decision back to the operator, exactly as
 * {@link WorkspaceToolchainUnavailableError} does for a missing binary.
 */
export class WorkspaceToolchainUnhonoredError extends Error {
  override readonly name = "WorkspaceToolchainUnhonoredError";

  constructor(
    readonly workspacePath: string,
    /** Every untranslatable declaration, so one halt reports all of them. */
    readonly unhonored: readonly { path: string; reason: string; tool?: string }[],
  ) {
    super(unhonoredMessage(unhonored));
  }
}

/**
 * Halt-or-proceed for the declarations Layer 1 could not honor.
 *
 * FIRES ON: `untranslatable-version` only — Tanren knows the tool, can provision it, and
 * cannot translate the version the repo wrote. Proceeding means running on whatever copy
 * of that tool the image happens to carry.
 *
 * DELIBERATELY DOES NOT FIRE ON: `unresolvable-declaration` — an unparseable
 * `package.json`, a malformed `packageManager` field, a tool name Tanren has no binary
 * for. Tanren never identified a provisionable tool there, so it cannot claim the run is
 * on the wrong VERSION of anything; these are ordinarily writer-fixable and halting on
 * them would strand a run on a mid-authoring typo. They keep their loud notice, and if
 * the bootstrap actually needed that tool the missing-binary classifier still halts.
 * That asymmetry IS the tolerance, and it is the only one.
 */
export function classifyUnhonoredDeclarations(
  workspacePath: string,
  detection: ToolchainDetection,
): WorkspaceToolchainUnhonoredError | undefined {
  const unhonored = detection.unresolved.filter((u) => u.kind === "untranslatable-version");
  if (unhonored.length === 0) return undefined;
  return new WorkspaceToolchainUnhonoredError(
    workspacePath,
    unhonored.map(({ path, reason, tool }) => ({ path, reason, ...(tool !== undefined && { tool }) })),
  );
}

function unhonoredMessage(unhonored: readonly { path: string; reason: string; tool?: string }[]): string {
  const listed = unhonored.map(
    ({ path, reason, tool }) => `${path} ${reason}${tool === undefined ? "" : ` (${tool})`}`,
  );
  return [
    `workspace toolchain declaration NOT honored, and the run will not proceed on an undeclared version: ${listed.join("; ")}.`,
    `Tanren provisions the toolchain a repository DECLARES and never guesses at an alias it cannot translate. ` +
      `Continuing would gate this repository against whatever version of that tool the runner image happens to carry — ` +
      `a merge decision taken against an environment nobody declared.`,
    `Fix it at the declaration: write a plain version (e.g. "24", "24.18.1"), or declare the toolchain in a mise.toml, ` +
      `which mise resolves directly including its own alias forms.`,
    `This HALTS rather than dispatching a remediation writer: rewriting the toolchain version a repository pinned is ` +
      `an operator decision, not a source defect for a writer to edit away.`,
  ].join("\n");
}

/**
 * The runner-side verification for ONE requirement Tanren handed to mise. Emitted after
 * `mise use --global` + activation, under `set -e`; every failure path exits nonzero
 * naming the tool, the declaration file, what was declared and what was actually there.
 *
 * It asks mise — the one provisioner Layer 2 uses — rather than probing `<bin> --version`
 * per ecosystem: `mise which` and `mise current` answer uniformly for every tool in the
 * catalogue, so nothing here hardcodes an ecosystem's version flag or output format.
 */
export function toolchainVerificationParts(requirement: ToolchainRequirement): string[] {
  const { tool, bin, spec, declaredIn } = requirement;
  const q = quoteSshShellArg;
  const parts = [
    `__tanren_bin="$(command -v ${q(bin)} 2>/dev/null || true)"`,
    `[ -n "$__tanren_bin" ] || { ${echoErr(missingBinaryMessage(requirement))}; exit 1; }`,
    `__tanren_provisioned="$(mise which ${q(bin)} 2>/dev/null || true)"`,
    `[ "$__tanren_bin" = "$__tanren_provisioned" ] || ` +
      `{ ${echoErrWith(shadowedMessage(requirement), '"$__tanren_bin"')}; exit 1; }`,
    `__tanren_version="$(mise current ${q(tool)} 2>/dev/null | head -n 1 | tr -d '[:space:]')"`,
    `[ -n "$__tanren_version" ] || { ${echoErr(unresolvedMessage(requirement))}; exit 1; }`,
  ];
  if (requirement.versionDeclared) {
    // The component-wise prefix test, in two literal `case` patterns: the spec exactly,
    // or the spec followed by a dot. `24` therefore matches `24` and `24.18.1` but not
    // `241.0.0` — the boundary is a dot, never a character.
    parts.push(
      `case "$__tanren_version" in ${q(spec)}|${q(`${spec}.`)}*) : ;; ` +
        `*) ${echoErrWith(mismatchMessage(requirement), '"$__tanren_version"')}; exit 1 ;; esac`,
    );
  }
  parts.push(
    `printf '%s%s|%s|%s|%s|%s===\\n' ${q(RESOLUTION_FRAME)} ${q(tool)} ${q(spec)} "$__tanren_version" ` +
      `${q(declaredIn)} ${q(requirement.versionDeclared ? "pinned" : "unconstrained")}`,
  );
  return parts;
}

/** Parse {@link toolchainVerificationParts}' frames back out of a command's stdout. Pure;
 * a stream carrying no frames yields an empty list (nothing was verified). */
export function parseToolchainResolutions(stdout: string): ToolchainResolution[] {
  const out: ToolchainResolution[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(RESOLUTION_FRAME) || !trimmed.endsWith("===")) continue;
    const fields = trimmed.slice(RESOLUTION_FRAME.length, trimmed.length - 3).split("|");
    const [tool, declared, resolved, declaredIn, constrained] = fields;
    if (fields.length !== 5 || tool === undefined || declared === undefined || resolved === undefined) continue;
    out.push({
      tool,
      declared,
      resolved,
      declaredIn: declaredIn ?? "",
      versionDeclared: constrained === "pinned",
    });
  }
  return out;
}

/** The operator-facing rendering of "which version actually ran vs which was declared".
 * Used for the run's `workspace.prepared` payload and quoted in every toolchain failure,
 * so the answer survives the console line scrolling past. */
export function describeToolchainInEffect(resolutions: readonly ToolchainResolution[]): string {
  if (resolutions.length === 0) return "nothing was provisioned";
  return resolutions
    .map(
      (r) =>
        `${r.tool} ${r.resolved} (declared ${r.versionDeclared ? `"${r.declared}"` : "unconstrained"} in ${r.declaredIn})`,
    )
    .join(", ");
}

function missingBinaryMessage(requirement: ToolchainRequirement): string {
  return (
    `tanren: toolchain provision FAILED - ${requirement.declaredIn} declares ` +
    `${requirement.tool}@${requirement.spec} but the '${requirement.bin}' binary is still not on PATH after ` +
    `'mise use --global'. The declared toolchain could not be provisioned on this runner.`
  );
}

function shadowedMessage(requirement: ToolchainRequirement): string {
  return (
    `tanren: toolchain provision FAILED - ${requirement.declaredIn} declares ` +
    `${requirement.tool}@${requirement.spec}, but the '${requirement.bin}' that resolves on PATH is NOT the one ` +
    `Tanren provisioned. The run would have used an undeclared copy. Resolved:`
  );
}

function unresolvedMessage(requirement: ToolchainRequirement): string {
  return (
    `tanren: toolchain provision FAILED - ${requirement.declaredIn} declares ` +
    `${requirement.tool}@${requirement.spec}, but mise resolved NO concrete version for '${requirement.tool}' ` +
    `after 'mise use --global'. Provisioning reported success while installing nothing.`
  );
}

function mismatchMessage(requirement: ToolchainRequirement): string {
  return (
    `tanren: toolchain provision FAILED - ${requirement.declaredIn} declares ` +
    `${requirement.tool}@${requirement.spec}, but the version on this runner does not satisfy it. ` +
    `A declared version is satisfied only by a version it is a component-wise prefix of. Resolved:`
  );
}

function echoErr(message: string): string {
  return `printf '%s\\n' ${quoteSshShellArg(message)} >&2`;
}

// The variant whose message ends in a colon: the OBSERVED value is reported alongside what
// was asked for, so the operator never has to infer it.
//
// The value is passed IN rather than appended by the caller. Appended, the expansion was
// `printf '%s %s\n' 'msg' >&2 "$value"` — a redirection sitting between two arguments.
// POSIX accepts it and it works, but it reads as though the value belongs to the
// redirection, and any future reorder silently drops either the value or the `>&2` with no
// error. The helper now owns the whole word order.
function echoErrWith(message: string, valueExpression: string): string {
  return `printf '%s %s\\n' ${quoteSshShellArg(message)} ${valueExpression} >&2`;
}
