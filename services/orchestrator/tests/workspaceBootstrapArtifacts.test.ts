// Proves the live-validation fix: the workspace bootstrap (e.g. `npm install`)
// creates install artifacts AFTER the clone, and those must not leak into the
// writer's captured diff nor into the branch pushed as the PR.
//
// The invariant (per the bug report): given a bootstrap that creates an
// UNTRACKED file X and a writer that changes a tracked file Y,
//   (a) the writer's captured diff (vs the post-bootstrap baseSha) shows only Y,
//   (b) the branch prepared for the PR contains only Y — X is absent.
//
// The runner runs git over SSH, so the helpers emit git command strings rather
// than touching a local repo (the architecture gate confines host process spawn
// to the cli-runner). We drive those strings through a ScriptedSsh that returns
// real `git`-shaped output, and assert BOTH the emitted git plumbing (so the
// rebase/commit semantics are exercised) AND the values the helpers return.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { captureGitStateAfterCodex } from "../src/engine/providers/codexGit.js";
import {
  BOOTSTRAP_COMMIT_MESSAGE,
  commitBootstrapState,
  seedWorkspaceLocalIgnore,
} from "../src/engine/workspace/bootstrap.js";
import { WORKSPACE_LOCAL_IGNORE_PATHS } from "../src/engine/workspace/localIgnorePaths.js";
import { PR_CLEAN_REF, prepareCleanPrBranch } from "../src/engine/workspace/githubPush.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner",
  identitySecretRef: "runner/test/identity",
};

const CLONE_HEAD = "1".repeat(40);
const BOOTSTRAP_SHA = "2".repeat(40);
const WRITER_SHA = "3".repeat(40);

// Returns scripted stdout per command, keyed by a substring match, and records
// every command the helpers emit so the git plumbing can be asserted.
class ScriptedSsh implements CommandSubstrate {
  readonly commands: string[] = [];

  constructor(private readonly replies: Array<{ match: string; stdout: string }>) {}

  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command.command);
    const reply = this.replies.find((entry) => command.command.includes(entry.match));
    return { exitCode: 0, stdout: reply?.stdout ?? "", stderr: "", timedOut: false };
  }
}

const timeoutMs = 1_000;
const workspacePath = "/workspace/runs/run_x/repo";

describe("workspace local git ignore", () => {
  it("appends every polyglot build/cache path to the checkout's .git/info/exclude (never a committed file)", async () => {
    // The durable install-tree guard: a per-checkout ignore so a later `git add -A`
    // (bootstrap commit / writer commit) never sweeps an install tree into the repo
    // — the 46MB checker-prompt failure mode. This must run AFTER clone, so it is a
    // workspace-local exclude rather than a committed `.gitignore`.
    const ssh = new ScriptedSsh([]);
    await seedWorkspaceLocalIgnore({ ssh, target, workspacePath, timeoutMs });

    expect(ssh.commands).toHaveLength(1);
    const cmd = ssh.commands[0] ?? "";
    // Resolves the worktree-correct exclude path and appends (>>) to it — never a
    // committed .gitignore.
    expect(cmd).toContain("git rev-parse --git-path info/exclude");
    expect(cmd).toContain(">>");
    expect(cmd).toContain("info/exclude");
    expect(cmd).not.toContain(".gitignore");
    // Every configured path is emitted, single-quoted so glob entries (`*.egg-info/`)
    // reach git as literals rather than being expanded by the remote shell.
    for (const path of WORKSPACE_LOCAL_IGNORE_PATHS) {
      expect(cmd).toContain(`'${path}'`);
    }
    // The stack coverage the list has to carry — Node was never the only ecosystem.
    expect(WORKSPACE_LOCAL_IGNORE_PATHS).toEqual(
      expect.arrayContaining(["node_modules/", "dist/", ".venv/", "__pycache__/", ".terraform/", ".gradle/"]),
    );
    // Ambiguous names (also legitimate SOURCE directory names) are ROOT-ANCHORED, so a
    // `packages/parser/target/` or `src/build/` of real source is never swallowed.
    for (const ambiguous of ["/build/", "/target/", "/out/", "/vendor/", "/deps/"]) {
      expect(WORKSPACE_LOCAL_IGNORE_PATHS).toContain(ambiguous);
      expect(WORKSPACE_LOCAL_IGNORE_PATHS).not.toContain(ambiguous.slice(1));
    }
  });
});

describe("bootstrap-artifact isolation", () => {
  it("commits the bootstrap state as the writer's diff base, off the writer's commit", async () => {
    // commitBootstrapState commits the bootstrap-generated tree (lockfiles,
    // node_modules) and returns the commit sha — this becomes the writer baseSha.
    const ssh = new ScriptedSsh([{ match: "git rev-parse HEAD", stdout: `${BOOTSTRAP_SHA}\n` }]);
    const bootstrapSha = await commitBootstrapState({ ssh, target, workspacePath, timeoutMs });

    expect(bootstrapSha).toBe(BOOTSTRAP_SHA);
    const cmd = ssh.commands[0] ?? "";
    // `git add -A` stages ALL bootstrap artifacts INTO the bootstrap commit, so
    // they land BELOW the writer's diff base (and never in the writer's diff).
    expect(cmd).toContain("git add -A");
    expect(cmd).toContain(`-m '${BOOTSTRAP_COMMIT_MESSAGE}'`);
    // --allow-empty so the no-manifest case still yields a concrete base sha.
    expect(cmd).toContain("--allow-empty");
    // -q so the commit summary stays off stdout; rev-parse is the sha source.
    expect(cmd).toContain("git commit -q");
  });

  it("(a) captures the writer diff against the post-bootstrap base", async () => {
    // The codex writer commits its change and diffs vs the baseSha it was given.
    // Pointing baseSha at the bootstrap commit means the diff is bootstrapSha..
    // worktree — only the writer's file, never the bootstrap artifacts below it.
    const ssh = new ScriptedSsh([
      { match: "git diff --no-color", stdout: "diff --git a/src/status.ts b/src/status.ts\n+ok()\n" },
      { match: "git log", stdout: `${WRITER_SHA}\twriter change\n` },
    ]);
    const state = await captureGitStateAfterCodex(ssh, target, workspacePath, BOOTSTRAP_SHA, timeoutMs);

    // The diff/log are taken relative to the bootstrap base, not the clone HEAD.
    const diffCmd = ssh.commands.find((c) => c.includes("git diff --no-color")) ?? "";
    const logCmd = ssh.commands.find((c) => c.includes("git log")) ?? "";
    expect(diffCmd).toContain(`git diff --no-color ${BOOTSTRAP_SHA}`);
    expect(logCmd).toContain(`${BOOTSTRAP_SHA}..HEAD`);
    expect(state.diff).toContain("src/status.ts");
    expect(state.diff).not.toContain("package-lock.json");
  });

  it("(b) prepares the PR branch by overlaying writer-vs-bootstrap onto cloneHead into ONE composed commit (apex v85 direct-overlay; supersedes v71 rebase)", async () => {
    // prepareCleanPrBranch builds ONE composed commit parented on cloneHead whose tree is
    // cloneHead + (writer − bootstrap): private index seeded from cloneHead, then each
    // path in `git diff-tree bootstrap..HEAD` takes the writer blob/delete. No rebase, no
    // checkout, no HEAD move — drops bootstrap artifacts, collapses writer drafts, and
    // cannot 3-way-conflict (apex v85: single composed commit still conflicted under
    // squash-then-rebase). Trailing `git rev-parse PR_CLEAN_REF` is the COMMIT-BINDING sha.
    const CLEAN_SHA = "4".repeat(40);
    const ssh = new ScriptedSsh([{ match: "git write-tree", stdout: `${CLEAN_SHA}\n` }]);
    const pushSource = await prepareCleanPrBranch({
      ssh,
      target,
      workspacePath,
      cloneHeadSha: CLONE_HEAD,
      bootstrapSha: BOOTSTRAP_SHA,
      runId: "run_apex_v85",
      timeoutMs,
    });

    // The ref pushed AND the exact sha it resolves to (the PR head the gate binds to).
    expect(pushSource.ref).toBe(PR_CLEAN_REF);
    expect(pushSource.headSha).toBe(CLEAN_SHA);
    const cmd = ssh.commands[0] ?? "";
    // Private index overlay: seed cloneHead, apply writer-vs-bootstrap delta, write-tree.
    expect(cmd).toContain(`git read-tree '${CLONE_HEAD}'`);
    expect(cmd).toContain(`git diff-tree -r --name-status --no-renames '${BOOTSTRAP_SHA}' HEAD`);
    expect(cmd).toContain("git write-tree");
    // `|| exit 1` is required: set -e does not abort mid-list while bodies.
    expect(cmd).toContain("git update-index --add --cacheinfo");
    expect(cmd).toContain('git update-index --add --cacheinfo "${mode},${sha},${path}" || exit 1');
    // Composed commit parented on cloneHead (NOT bootstrap) — no rebase needed.
    expect(cmd).toContain(`git log --reverse --format='- %s' '${BOOTSTRAP_SHA}..HEAD'`);
    expect(cmd).toContain(`git commit-tree "$clean_tree" -p '${CLONE_HEAD}'`);
    expect(cmd).toContain("run_apex_v85");
    // No rebase / no detached checkout — those were the v65/v71/v85 halt surfaces.
    expect(cmd).not.toContain("git rebase");
    expect(cmd).not.toContain("git checkout");
    // Stage into the push ref; HEAD is never moved (writer tip stays for rework).
    expect(cmd).toContain(`git update-ref '${PR_CLEAN_REF}' "$composed"`);
    // The cleaned tip is echoed LAST so it is the command's stdout (the PR-head sha).
    expect(cmd).toContain(`git rev-parse '${PR_CLEAN_REF}'`);
  });

  it("(b) apex v65 — clean-PR prep never requires a clean working tree (object-DB overlay; no rebase)", async () => {
    // Regression: v65 halted on `cannot rebase: You have unstaged changes` after gates
    // dirtied the tree. v71 kept rebase + --autostash. v85 drops rebase entirely: the
    // overlay uses a private GIT_INDEX_FILE + object-DB reads, so a dirty working tree
    // cannot block the prep. Pin the absence of rebase/checkout and the private index.
    const CLEAN_SHA = "5".repeat(40);
    const ssh = new ScriptedSsh([{ match: "git write-tree", stdout: `${CLEAN_SHA}\n` }]);
    await prepareCleanPrBranch({
      ssh,
      target,
      workspacePath,
      cloneHeadSha: CLONE_HEAD,
      bootstrapSha: BOOTSTRAP_SHA,
      runId: "run_apex_v65",
      timeoutMs,
    });
    const cmd = ssh.commands[0] ?? "";
    expect(cmd).toContain("GIT_INDEX_FILE=");
    expect(cmd).toContain("git read-tree");
    expect(cmd).not.toContain("git rebase");
    expect(cmd).not.toContain("git checkout");
    expect(cmd).not.toContain("--autostash");
  });

  it("(b) no-ops the PR-branch cleanup when there is no real bootstrap commit", async () => {
    // Fake-SSH unit paths yield empty shas (and the no-bootstrap case yields a
    // bootstrapSha equal to the clone HEAD) — nothing to drop, push the working HEAD.
    // The helper STILL resolves the working HEAD sha (a single `git rev-parse HEAD`)
    // so the merge gate can bind its verdict to the exact pushed commit.
    const empty = await prepareCleanPrBranch({
      ssh: new ScriptedSsh([]),
      target,
      workspacePath,
      cloneHeadSha: "",
      bootstrapSha: "",
      runId: "run_fake",
      timeoutMs,
    });
    // No real workspace on a fake SSH ⇒ "" sha (the gate emits no verdict).
    expect(empty.ref).toBe("HEAD");
    expect(empty.headSha).toBe("");

    const equalSsh = new ScriptedSsh([{ match: "git rev-parse HEAD", stdout: `${WRITER_SHA}\n` }]);
    const equal = await prepareCleanPrBranch({
      ssh: equalSsh,
      target,
      workspacePath,
      cloneHeadSha: CLONE_HEAD,
      bootstrapSha: CLONE_HEAD,
      runId: "run_no_bootstrap",
      timeoutMs,
    });
    // No bootstrap commit to drop, but the working HEAD IS the PR head — its sha is
    // resolved so the merge gate binds to it (rather than re-resolving the same HEAD).
    expect(equal.ref).toBe("HEAD");
    expect(equal.headSha).toBe(WRITER_SHA);
    // Only the single rev-parse ran (no rebase) in the no-drop case.
    expect(equalSsh.commands).toEqual(["git rev-parse HEAD"]);
  });
});
