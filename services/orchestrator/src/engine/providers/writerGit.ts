import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { runWorkspaceSshCommand } from "../workspace/index.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { TANREN_GIT, withProjectHookToolchain } from "../ssh/miseActivate.js";
import type { Commit, WriterResult } from "./types.js";

// shared baseline/diff/commit capture for CLI writer adapters that,
// like Codex, edit the workspace in place and let us derive the result from git
// state after the CLI exits. Codex keeps its own copy (so the Codex path is not
// refactored); new adapters (Claude, opencode) share this module.
//
// These are workspace-bound VCS commands: each builds its `vcs` ActivityWatchdog
// (output-driven + workspace liveness probe) via the shared factory — never a
// wall-clock kill (feedback_no_timeouts_progress_based).

export async function captureBaselineSha(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
): Promise<string> {
  const result = await runWorkspaceSshCommand(ssh, target, {
    label: "capture baseline git sha",
    cwd: workspace,
    command: "git rev-parse HEAD",
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
  });
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`baseline git capture returned invalid sha: ${sha}`);
  }
  return sha;
}

export async function captureGitStateAfterWriter(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
  baselineSha: string,
  commitMessage: string,
): Promise<Pick<WriterResult, "diff" | "commits">> {
  await commitWorkspaceChanges(ssh, target, workspace, commitMessage);
  const diff = await runWorkspaceSshCommand(ssh, target, {
    label: "capture writer git diff",
    cwd: workspace,
    command: `git diff --no-color ${baselineSha}`,
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
  });
  const log = await runWorkspaceSshCommand(ssh, target, {
    label: "capture writer git commits",
    cwd: workspace,
    command: `git log --format='%H%x09%s' --reverse ${baselineSha}..HEAD`,
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
  });
  return { diff: diff.stdout, commits: parseGitLogCommits(log.stdout) };
}

async function commitWorkspaceChanges(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
  commitMessage: string,
): Promise<void> {
  // PROJECT-HOOK path (ssh/miseActivate.ts) — see the twin in codexGit.ts. This commit
  // keeps the repo's hooks LIVE because it carries the writer's content into the PR, so
  // the project's pre-commit hook is the project's own code and needs the project's
  // toolchain on PATH. A no-op for a repo that declared none.
  await runWorkspaceSshCommand(ssh, target, {
    label: "commit writer workspace changes",
    cwd: workspace,
    command: withProjectHookToolchain(
      [
        "set -eu",
        `${TANREN_GIT} add -A`,
        `if ! ${TANREN_GIT} diff --cached --quiet --exit-code; then`,
        `GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' ${TANREN_GIT} commit -m ${shellSingleQuote(commitMessage)}`,
        "fi",
      ].join("\n"),
      workspace,
    ),
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
  });
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function parseGitLogCommits(stdout: string): Commit[] {
  return stdout
    .trimEnd()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const separator = line.indexOf("\t");
      if (separator === -1) {
        throw new Error("git commit capture did not include sha/message separator");
      }
      const sha = line.slice(0, separator);
      const message = line.slice(separator + 1);
      if (!/^[0-9a-f]{40}$/u.test(sha)) {
        throw new Error(`git commit capture returned invalid sha: ${sha}`);
      }
      if (message === "") {
        throw new Error("git commit capture returned an empty commit message");
      }
      return { sha, message };
    });
}
