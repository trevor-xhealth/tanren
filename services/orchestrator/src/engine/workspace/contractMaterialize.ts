// DETERMINISTIC contract-file materialization in the workspace — the v27 fix.
//
// The run path writes the project's contract files (`.tanren/ci.yml` + `justfile`)
// into the cloned workspace VERBATIM, right after clone and BEFORE the writer
// authors any code, so the contract is established MECHANICALLY (no LLM). The bytes
// come from `materializeContractFiles(lifecycle)` (engine/forge/scaffold): the
// ci.yml is the stack-agnostic SKELETON_CI_CONFIG verbatim (always parses through
// `resolveCiConfig`), the justfile is the six conventional targets filled from the
// captured lifecycle. This takes contract-file authoring OUT of the LLM writer's
// hands — the v27 bug was the writer mangling the ci.yml YAML shape.
//
// IDEMPOTENT, NEVER-CLOBBER: each file is written ONLY when it is ABSENT. On the
// scaffold run (an empty greenfield repo) both files are absent, so both are
// materialized + committed into the bootstrap commit. On any later run that re-clones
// a repo which already ships the contract files (the scaffold landed them on `main`,
// and the writer may have ENRICHED the justfile with more recipes), the files exist,
// so this is a pure no-op and the existing, possibly-enriched versions are kept.
import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { ContractFile } from "../forge/scaffold/index.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { outputOnlyWatchdog } from "../ssh/activityWatchdog.js";
import { MISE_CONFIG_REL_PATH, TANREN_GIT, withProjectHookToolchain } from "../ssh/miseActivate.js";
import type { ProvisionMiseToolchainInput } from "./toolchainProvision.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { runWorkspaceSshCommand } from "./ssh.js";

export interface MaterializeContractFilesInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  // The deterministic contract-file manifest (from `materializeContractFiles`).
  files: ReadonlyArray<ContractFile>;
}

// The outcome of a materialization pass: the paths that were actually written (were
// absent) vs skipped (already present). Returned so the caller can observe whether
// the contract was newly established (scaffold run) or already in place.
export interface MaterializeContractFilesResult {
  written: string[];
  skipped: string[];
}

// Materialize the contract files into the workspace over SSH. Writes each file's
// EXACT bytes — fed over stdin so no shell escaping touches the content — only when
// the file is ABSENT (never clobbering a writer-enriched version). One SSH round-trip
// per file (stdin carries exactly one file's bytes).
export async function materializeContractFilesInWorkspace(
  input: MaterializeContractFilesInput,
): Promise<MaterializeContractFilesResult> {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of input.files) {
    const wrote = await writeIfAbsent(input, file);
    (wrote ? written : skipped).push(file.path);
  }
  return { written, skipped };
}

// Write ONE contract file iff absent. The content is delivered over stdin (`cat >`)
// so arbitrary bytes — tabs, YAML, `#` comments — never pass through shell quoting.
// `mkdir -p` first so a nested path (`.tanren/ci.yml`) lands. Returns whether the
// file was written (true) or already existed (false). Idempotency authority: the
// `[ -f ]` guard, so a re-clone of a repo that already ships the file is a no-op.
async function writeIfAbsent(
  input: Pick<MaterializeContractFilesInput, "ssh" | "target" | "workspacePath">,
  file: ContractFile,
): Promise<boolean> {
  // A marker echoed on the SKIP branch so the caller can tell "written" from
  // "already present" off stdout without a second round-trip.
  const skipMarker = "tanren: contract file present - skipping";
  const path = quoteSshShellArg(file.path);
  const command = [
    "set -eu",
    `if [ -f ${path} ]; then echo ${quoteSshShellArg(skipMarker)}; else ` +
      `mkdir -p "$(dirname ${path})" && cat > ${path}; fi`,
  ].join("\n");
  const result = await runWorkspaceSshCommand(input.ssh, input.target, {
    label: `materialize contract file ${file.path}`,
    cwd: input.workspacePath,
    // INFRA file write (a write-iff-absent heredoc): output-driven watchdog, no kill.
    watchdog: outputOnlyWatchdog(),
    command,
    // The exact file bytes. On the skip branch `cat` never runs, so the stdin is
    // simply not consumed — harmless.
    stdin: file.content,
  });
  return !result.stdout.includes(skipMarker);
}

/**
 * The shell that COMMITS the freshly-materialized contract files, as a dedicated commit
 * above the bootstrap base. Lives next to the materialization it commits (the caller,
 * workflow/plannerRunWorkspace.ts, only sequences the two).
 *
 * PROJECT-HOOK path (ssh/miseActivate.ts): unlike Tanren's bootstrap commit — which
 * disables the hook path because it is bookkeeping that never reaches the PR — this
 * commit's content DOES ship in the pushed tree, so the repo's hooks stay LIVE and must
 * therefore be given the project's provisioned toolchain. Same defect as the writer
 * commit; it only stays latent because a brownfield repo already ships both contract
 * files, writes nothing, and so never reaches a commit at all.
 */
export function buildContractFilesCommitCommand(writtenPaths: readonly string[], workspacePath: string): string {
  return withProjectHookToolchain(
    [
      "set -eu",
      // Stage ONLY the contract files (not -A) so this commit carries the contract
      // and nothing else — the bootstrap commit already absorbed install artifacts.
      `${TANREN_GIT} add ${writtenPaths.map((p) => quoteSshShellArg(p)).join(" ")}`,
      // `>&2` ON THE COMMIT, and it is not cosmetic. `-q` silences GIT, not the repo's
      // pre-commit HOOK — and this commit keeps that hook LIVE on purpose. A hook that
      // prints its progress (husky and lefthook both do) writes to the commit's stdout,
      // which the caller reads as the contract-commit sha and installs as the answerer's
      // review base. The output still reaches the operator; it just cannot be mistaken for
      // a revision. This is why `git rev-parse` below can be trusted as the ONLY stdout.
      "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' " +
        `${TANREN_GIT} commit -q -m ` +
        `${quoteSshShellArg("tanren: project contract files (.tanren/ci.yml + justfile)")} >&2`,
      // Echo the contract-commit sha LAST so it is the command's stdout — it becomes
      // the answerer review base. A fake SSH yields ""; the real runner a 40-hex sha.
      `${TANREN_GIT} rev-parse HEAD`,
    ].join(" && "),
    workspacePath,
  );
}

// Materialize the deterministic contract files into the workspace + commit them as a
// dedicated commit above the bootstrap base, so they become part of the writer's PR
// diff. Returns the new contract-commit sha (the answerer review base anchors ABOVE it,
// so the Tanren-owned files are kept out of the writer's reviewed diff — apex v28 fix),
// or "" when no commit was made: the run carries no contract manifest (the project
// captured no lifecycle), a fake SSH yields no sha, OR the files were already present
// (a brownfield re-clone — write-iff-absent left nothing newly written). On a "" the
// caller keeps the bootstrap base, so the answerers diff from the same place as before.
export interface MaterializeContractFilesCommitInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  /** The run's contract manifest, or `undefined` when it carries none. */
  files: readonly ContractFile[] | undefined;
  /** The workspace-prep provisioning step, re-run when this materialization is what
   * introduced the repository's toolchain declaration. Injected rather than imported so
   * the caller's test seam (`input.provisionMise`) reaches this step too. */
  provisionMise: (stepInput: ProvisionMiseToolchainInput) => Promise<unknown>;
}

export async function materializeContractFilesCommit(input: MaterializeContractFilesCommitInput): Promise<string> {
  const { ssh, target, workspacePath, files } = input;
  if (files === undefined || files.length === 0) return "";
  const result = await materializeContractFilesInWorkspace({ ssh, target, files, workspacePath });
  // Nothing newly written (every file already present) ⇒ no commit, no base shift.
  if (result.written.length === 0) return "";
  // A CONTRACT FILE CAN BE THE `mise.toml` ITSELF (forge/scaffold/contractFiles.ts writes
  // one whenever the project's lifecycle declares a toolchain). The provision above ran
  // BEFORE this materialization, so on a brownfield repo that shipped no mise.toml it saw
  // nothing to install and skipped — and the commit below keeps the repo's hooks LIVE, so
  // a pre-commit hook that needs the newly declared toolchain fails during workspace prep,
  // which is exactly the failure the hook-toolchain activation exists to prevent. The
  // activation is not enough on its own: it puts a toolchain on PATH, it does not INSTALL
  // one. Re-provision when the toolchain declaration is something we just wrote.
  if (result.written.includes(MISE_CONFIG_REL_PATH)) {
    await input.provisionMise({ ssh, target, workspacePath });
  }
  const committed = await runWorkspaceSshCommand(ssh, target, {
    label: "commit deterministic contract files",
    cwd: workspacePath,
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace: workspacePath }),
    // Built in workspace/contractMaterialize.ts, next to the materialization it commits.
    // It runs with the project's toolchain active because this commit — unlike Tanren's
    // bootstrap commit — keeps the repo's hooks LIVE and ships its content in the PR.
    command: buildContractFilesCommitCommand(result.written, workspacePath),
  });
  // VALIDATED, like every other sha-returning workspace step (`commitBootstrapState`,
  // `resolveWorkspaceHeadSha`, the writer/codex commit captures). This value becomes the
  // answerer's review base; a stray line on stdout must be a LOUD failure here, not a
  // malformed revision three steps downstream. "" only on a fake SSH that yields no output.
  const contractSha = committed.stdout.trim();
  if (contractSha !== "" && !/^[0-9a-f]{40}$/u.test(contractSha)) {
    throw new Error(`contract-files commit returned invalid sha: ${contractSha}`);
  }
  return contractSha;
}
