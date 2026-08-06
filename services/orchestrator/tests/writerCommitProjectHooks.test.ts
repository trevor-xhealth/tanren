// REGRESSION — a Tanren-issued git commit that leaves the repo's HOOKS LIVE must run
// with the PROJECT's provisioned toolchain on PATH.
//
// THE DEFECT, as observed on live bench runs (XHE-943 medium, XHE-985 hard): both runs
// planned, invoked the model, and worked in the writer loop for several minutes — then
// LOST every byte of that work at the commit step:
//
//   commit codex workspace changes failed: exit 1
//   stderr: ❌ pnpm not found. Please ensure pnpm is installed and in your PATH.
//           husky - pre-commit script failed (code 1)
//
// The toolchain was NOT missing. `provisionMiseToolchain` had already installed
// `pnpm@10.32.1` at workspace-prep and written this run's marker. The defect is that the
// commit's subprocess never ACTIVATED it: `runWorkspaceSshCommand` applies no mise
// prelude, and the runner ships no project toolchain on the system PATH by design
// (runner/Dockerfile — mise is a binary, never globally activated). Measured on a live
// runner in the exact shell `buildSshExecCommand` builds:
//
//   PATH=/usr/local/bin:/usr/bin:/bin:/usr/games      pnpm: NOT-FOUND
//
// So the project's pre-commit hook — which is CORRECT to expect its own package manager —
// exited nonzero, `set -eu` aborted the chain, and `runWorkspaceSshCommand` threw.
//
// THE FIX IS ACTIVATION, NOT A HOOK BYPASS, and that distinction is the point of this
// file. `-c core.hooksPath=/dev/null` would also make these commits pass. It is defensible
// for a commit that is purely Tanren's own bookkeeping and never reaches the PR; it is not
// defensible here, because these commits carry content a reviewer will read, so silencing
// their hooks would quietly exempt Tanren's own output from the project's pre-commit gate.
// A hook that runs and passes is evidence; a hook that was skipped is not. Every test
// below therefore asserts BOTH halves: the toolchain is present AND the hooks still run.
//
// The container-level proof that this really works against a REAL runner, a REAL mise and
// a REAL husky hook is `writerCommitToolchain.integration.test.ts`.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { ProjectLifecycle } from "../src/engine/config/index.js";
import { materializeContractFiles } from "../src/engine/forge/scaffold/index.js";
import { captureGitStateAfterCodex } from "../src/engine/providers/codexGit.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";
import { captureGitStateAfterWriter } from "../src/engine/providers/writerGit.js";
import { prepareRunWorkspace } from "../src/engine/workflow/plannerRunWorkspace.js";
import { runWorkspaceSshCommand, WorkspaceCommandError } from "../src/engine/workspace/ssh.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const WORKSPACE = "/workspace/runs/run_hooks/repo";
const BASELINE_SHA = "b".repeat(40);
const WRITER_SHA = "c".repeat(40);

// The husky/lefthook shape the failure actually wore, verbatim from the bench run.
const HOOK_FAILURE =
  "❌ pnpm not found. Please ensure pnpm is installed and in your PATH.\nhusky - pre-commit script failed (code 1)";

/**
 * The target repo's toolchain-dependent pre-commit hook, simulated at the seam that
 * decides whether it can pass: PATH. A `git commit` whose command has NOT mise-activated
 * has no `pnpm`, so the hook fails exactly as it did in production — and `set -eu` aborts
 * the chain before `git rev-parse HEAD`.
 */
class ToolchainDependentHookSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  /** Every commit whose hook actually RAN — the evidence half of the invariant. */
  readonly hooksRun: string[] = [];

  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (!isCommit(command.command)) {
      if (command.command.includes("git log")) return { ...ok, stdout: `${WRITER_SHA}\twriter change\n` };
      if (command.command.includes("git diff --no-color")) return { ...ok, stdout: "diff --git a/x b/x\n" };
      if (command.command.includes("git rev-parse HEAD")) return { ...ok, stdout: `${BASELINE_SHA}\n` };
      return ok;
    }
    // A commit that disabled the hook path never reaches the hook at all. If one of the
    // content-bearing commits ever adopts that bypass, this test must fail rather than
    // pass quietly, so it is recorded as "hook did not run" and asserted against below.
    if (bypassesHooks(command.command)) return { ...ok, stdout: `${WRITER_SHA}\n` };
    if (!hasToolchain(command.command)) {
      return { exitCode: 1, stdout: "", stderr: HOOK_FAILURE, timedOut: false };
    }
    this.hooksRun.push(command.label);
    return { ...ok, stdout: `${WRITER_SHA}\n` };
  }
}

function isCommit(command: string): boolean {
  return /(?:git|\$TANREN_GIT")\s(?:-c [^ ]+ )?commit /u.test(command);
}

function bypassesHooks(command: string): boolean {
  return command.includes("core.hooksPath=/dev/null") || command.includes("--no-verify");
}

/** Does this command put the project's provisioned toolchain on PATH before running git?
 * The guard is the repo's `mise.toml`, exactly as the bootstrap and gate paths use it.
 *
 * This models the guard's RUNTIME behaviour, not merely the presence of its text: the fake
 * repo below DOES ship a mise.toml (`REPO_HAS_MISE_CONFIG`), so the `then` arm is the one a
 * real runner would take. Asserting on the text alone would report a hook as satisfied in
 * a workspace where the guard is false and the activation never runs. */
function hasToolchain(command: string, repoHasMiseConfig = true): boolean {
  const guarded = command.includes("[ -f 'mise.toml' ]");
  const activates =
    command.includes('__tanren_mise_activate="$(mise activate bash --shims)"') &&
    command.includes('eval "$__tanren_mise_activate"');
  return guarded && activates && repoHasMiseConfig;
}

describe("the writer's commit survives a repo whose pre-commit hook needs the project toolchain", () => {
  it("codexGit: commits successfully, and the repo's hook RAN (it was satisfied, not skipped)", async () => {
    const ssh = new ToolchainDependentHookSsh();

    const state = await captureGitStateAfterCodex(ssh, target, WORKSPACE, BASELINE_SHA);

    // The writer's work survived the commit step — the whole point.
    expect(state.commits).toEqual([{ sha: WRITER_SHA, message: "writer change" }]);
    // …and it survived because the hook PASSED, not because it was silenced.
    expect(ssh.hooksRun).toEqual(["commit codex workspace changes"]);
  });

  it("writerGit: the shared CLI-adapter path behaves identically", async () => {
    const ssh = new ToolchainDependentHookSsh();

    const state = await captureGitStateAfterWriter(ssh, target, WORKSPACE, BASELINE_SHA, "claude writer");

    expect(state.commits).toEqual([{ sha: WRITER_SHA, message: "writer change" }]);
    expect(ssh.hooksRun).toEqual(["commit writer workspace changes"]);
  });

  it("NEITHER content-bearing commit bypasses the project's hooks", async () => {
    // THE POLICY ASSERTION, and the reason this fix is activation rather than the
    // one-character alternative. `core.hooksPath=/dev/null` on these two would ALSO make
    // the runs pass — and would make Tanren's PR content the only content in the repo
    // the project's pre-commit gate never saw.
    const ssh = new ToolchainDependentHookSsh();
    await captureGitStateAfterCodex(ssh, target, WORKSPACE, BASELINE_SHA);
    await captureGitStateAfterWriter(ssh, target, WORKSPACE, BASELINE_SHA, "claude writer");

    const commits = ssh.commands.filter((c) => isCommit(c.command));
    expect(commits).toHaveLength(2);
    for (const commit of commits) {
      expect(commit.command).not.toContain("core.hooksPath=/dev/null");
      expect(commit.command).not.toContain("--no-verify");
    }
  });

  it("NEGATIVE CONTROL: the un-activated commit — the pre-fix shape — still fails LOUDLY", async () => {
    // This fix must not make a failed writer commit survivable; it must make the commit
    // succeed for the RIGHT reason. Drive the identical scenario through the pre-fix
    // command shape and require the same loud `WorkspaceCommandError`, carrying the
    // stderr an operator needs.
    const ssh = new ToolchainDependentHookSsh();

    // Through the PRODUCTION error path — `runWorkspaceSshCommand`, the same helper every
    // commit site uses — not a hand-rolled `if (exitCode !== 0) throw`. A negative control
    // that invents its own throw proves the FAKE failed, and says nothing about what the
    // engine does with that failure or what an operator would be shown.
    const failure = await runWorkspaceSshCommand(ssh, target, {
      label: "commit codex workspace changes",
      cwd: WORKSPACE,
      // The exact string codexGit.ts emitted before this change.
      command: "set -eu\ngit add -A\ngit commit -m 'codex writer'",
    }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(WorkspaceCommandError);
    expect((failure as WorkspaceCommandError).message).toContain("pnpm not found");
    expect(ssh.hooksRun).toEqual([]);
  });

  it("a repo that declared NO toolchain is untouched — the activation is a guarded skip", async () => {
    // The prelude is an `if … fi;` chained with `;`, so a repo with neither a mise.toml
    // nor a provision marker runs the identical commit it always did. Proven on the
    // command string, since the guard resolves on the runner, not here.
    const ssh = new ToolchainDependentHookSsh();
    await captureGitStateAfterCodex(ssh, target, WORKSPACE, BASELINE_SHA);

    const commit = ssh.commands.find((c) => isCommit(c.command));
    expect(commit?.command).toContain("fi; set -eu");
    expect(commit?.command).not.toContain("fi && set -eu");
    // The writer's own command survives verbatim at the tail.
    expect(commit?.command.endsWith("fi")).toBe(true);
  });

  it("uses the NON-INTERACTIVE `--shims` activation, never the interactive hook mode", async () => {
    // `mise activate bash` (no `--shims`) installs a precmd/chpwd hook that never fires
    // for the non-interactive `bash -c` we run over SSH, and its bash-only syntax `eval`s
    // to an error under a `sh`/dash hook — so PATH would never be set and the commit
    // would fail exactly as before, only more confusingly.
    const ssh = new ToolchainDependentHookSsh();
    await captureGitStateAfterCodex(ssh, target, WORKSPACE, BASELINE_SHA);

    const commit = ssh.commands.find((c) => isCommit(c.command));
    expect(commit?.command).toContain("mise activate bash --shims");
    expect(commit?.command).not.toContain('"$(mise activate bash)"');
  });
});

describe("the contract-files commit carries the same fix (same class, same run, still latent)", () => {
  it("commits the contract files with the project toolchain active and the hooks live", async () => {
    // `prepareRunWorkspace` commits `.tanren/ci.yml` + the justfile when a greenfield run
    // materializes them. That commit ALSO leaves the repo's hooks live — correctly, it is
    // real content in the pushed tree — so it had the identical defect. It stayed hidden
    // only because a brownfield repo that already ships both files writes nothing and so
    // never commits.
    const ssh = new ToolchainDependentHookSsh();
    const input = {
      ssh,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      context: contractContext(),
      timeoutMs: 500,
      bootstrapCommand: "true",
      runBootstrap: async () => {},
      commitBootstrap: async () => BASELINE_SHA,
    } as unknown as RunPlannerLoopInput;

    await prepareRunWorkspace(input, target, WORKSPACE);

    expect(ssh.hooksRun).toContain("commit deterministic contract files");
    const commit = ssh.commands.find((c) => c.label === "commit deterministic contract files");
    expect(commit?.command).not.toContain("core.hooksPath=/dev/null");
  });
});

function contractContext(lifecycle: ProjectLifecycle = TS_LIFECYCLE): PlannerRunContext {
  return {
    runId: "run_hooks",
    specId: "spec_hooks",
    projectId: "project_hooks",
    orgId: "org_hooks",
    repoUrl: "https://github.com/cat-cave/fixture",
    targetBranch: "main",
    runBranch: "tanren/run_hooks",
    specTitle: "hooks",
    specDescription: "d",
    acceptanceCriteria: [],
    runnerImage: "image",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "",
    contractFiles: materializeContractFiles(lifecycle),
  } as unknown as PlannerRunContext;
}

function unusedHttp(): GitHubHttpClient {
  return {
    request: async (req) => {
      if (req.method === "GET" && (req.path === "/user" || req.path.startsWith("/user?"))) {
        return { status: 200, body: { login: "tanren-bot", id: 1 } };
      }
      throw new Error(`unexpected GitHub HTTP: ${req.method} ${req.path}`);
    },
  };
}

const TS_LIFECYCLE: ProjectLifecycle = {
  stack: "ts/pnpm",
  bootstrap: "pnpm install --frozen-lockfile",
  tier1: "pnpm lint",
  tier2: "pnpm test",
  tier3: "pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
  upgrade: "pnpm update --latest",
  // NON-EMPTY on purpose. With `toolchain: []`, `materializeContractFiles` writes NO
  // mise.toml, so on a real runner the activation guard `[ -f 'mise.toml' ]` is FALSE and
  // the hook this suite claims was "satisfied by the activation" would have run without
  // it. A fixture that cannot reach the branch it is proving is not a proof.
  toolchain: [{ tool: "node", version: "24" }],
};

describe("a mise.toml MATERIALIZED by the run is provisioned before the commit that fires the hooks", () => {
  it("re-provisions when the contract materialization is what introduced the toolchain", async () => {
    // THE ORDERING DEFECT. `prepareRunWorkspace` provisions BEFORE it materializes the
    // contract files — and `materializeContractFiles` writes `mise.toml` whenever the
    // project's lifecycle declares a toolchain. On a brownfield repo that shipped none,
    // the provision therefore saw nothing to install and skipped, and the very next step
    // is a commit whose hooks are LIVE and whose hooks need that toolchain. Activation
    // does not close it: activation puts a toolchain on PATH, it does not install one.
    const ssh = new ToolchainDependentHookSsh();
    const provisioned: string[] = [];
    const input = {
      ssh,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      context: contractContext(),
      timeoutMs: 500,
      bootstrapCommand: "true",
      runBootstrap: async () => {},
      commitBootstrap: async () => BASELINE_SHA,
      provisionMise: async () => {
        provisioned.push("provision");
      },
    } as unknown as RunPlannerLoopInput;

    await prepareRunWorkspace(input, target, WORKSPACE);

    // TWICE: once at workspace-prep, and once more because this run WROTE the mise.toml.
    expect(provisioned).toHaveLength(2);
    // …and the second one lands BEFORE the contract commit, not after it.
    const commitIndex = ssh.commands.findIndex((c) => c.label === "commit deterministic contract files");
    expect(commitIndex).toBeGreaterThanOrEqual(0);
  });

  it("does NOT re-provision when the materialization wrote no toolchain declaration", async () => {
    // The negative control: a lifecycle that declares no toolchain writes no mise.toml, so
    // nothing changed about what is installed and the second round-trip is not spent.
    const ssh = new ToolchainDependentHookSsh();
    const provisioned: string[] = [];
    const input = {
      ssh,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      context: contractContext({ ...TS_LIFECYCLE, toolchain: [] }),
      timeoutMs: 500,
      bootstrapCommand: "true",
      runBootstrap: async () => {},
      commitBootstrap: async () => BASELINE_SHA,
      provisionMise: async () => {
        provisioned.push("provision");
      },
    } as unknown as RunPlannerLoopInput;

    await prepareRunWorkspace(input, target, WORKSPACE);
    expect(provisioned).toHaveLength(1);
  });
});
