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
import { withProjectHookToolchain } from "../ssh/miseActivate.js";
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
export function buildContractFilesCommitCommand(writtenPaths: readonly string[]): string {
  return withProjectHookToolchain(
    [
      "set -eu",
      // Stage ONLY the contract files (not -A) so this commit carries the contract
      // and nothing else — the bootstrap commit already absorbed install artifacts.
      `git add ${writtenPaths.map((p) => quoteSshShellArg(p)).join(" ")}`,
      "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' " +
        `git commit -q -m ${quoteSshShellArg("tanren: project contract files (.tanren/ci.yml + justfile)")}`,
      // Echo the contract-commit sha LAST so it is the command's stdout — it becomes
      // the answerer review base. A fake SSH yields ""; the real runner a 40-hex sha.
      "git rev-parse HEAD",
    ].join(" && "),
  );
}
