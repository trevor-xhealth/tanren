/**
 * codexGit — the workspace git-state helpers used by the Codex writer adapter.
 * Extracted from codex.ts to keep that file under the 500-line architecture
 * cap. These run over the runner SSH substrate to capture the baseline sha,
 * commit the writer's changes, and diff/log the result into a WriterResult.
 *
 * These are workspace-bound VCS commands: each builds its `vcs` ActivityWatchdog
 * (output-driven, with the workspace as the silent-stretch liveness probe) via the
 * shared factory — never a wall-clock kill (feedback_no_timeouts_progress_based).
 */
import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { runWorkspaceSshCommand } from "../workspace/index.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { withProjectHookToolchain } from "../ssh/miseActivate.js";
import type { Commit, WriterResult } from "./types.js";

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

async function commitWorkspaceChangesAfterCodex(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
): Promise<void> {
  // PROJECT-HOOK path (ssh/miseActivate.ts): this commit leaves the repo's hook path
  // LIVE — deliberately, because it carries the writer's content into the PR — so the
  // project's pre-commit hook runs, and that hook is the PROJECT's code calling a bare
  // `pnpm`/`node`. Without the activation this subprocess has only the harness node on
  // PATH and every such repo's writer commit dies with `pnpm: not found`, losing the
  // work the writer just did. Self-guarding: a repo that declared no toolchain is a
  // no-op. Prelude on the EXECUTED string only; the label/command in any error is
  // unchanged.
  await runWorkspaceSshCommand(ssh, target, {
    label: "commit codex workspace changes",
    cwd: workspace,
    command: withProjectHookToolchain(
      [
        "set -eu",
        "git add -A",
        "if ! git diff --cached --quiet --exit-code; then",
        "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' git commit -m 'codex writer'",
        "fi",
      ].join("\n"),
    ),
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
  });
}

export async function captureGitStateAfterCodex(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
  baselineSha: string,
): Promise<Pick<WriterResult, "diff" | "commits">> {
  await commitWorkspaceChangesAfterCodex(ssh, target, workspace);
  return await captureGitStateAfterBaseline(ssh, target, workspace, baselineSha);
}

async function captureGitStateAfterBaseline(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
  baselineSha: string,
): Promise<Pick<WriterResult, "diff" | "commits">> {
  const diff = await runWorkspaceSshCommand(ssh, target, {
    label: "capture codex git diff",
    cwd: workspace,
    command: `git diff --no-color ${baselineSha}`,
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
  });
  const log = await runWorkspaceSshCommand(ssh, target, {
    label: "capture codex git commits",
    cwd: workspace,
    command: `git log --format='%H%x09%s' --reverse ${baselineSha}..HEAD`,
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
  });
  return { diff: diff.stdout, commits: parseGitLogCommits(log.stdout) };
}

function parseGitLogCommits(stdout: string): Commit[] {
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
