// The RUN materializes the deterministic contract files into the workspace BEFORE
// the writer runs (the v27 fix). This pins the workspace-side behavior:
//   1. `materializeContractFilesInWorkspace` delivers each file's EXACT bytes over
//      stdin (never the command string) and write-iff-absent (never clobbering);
//   2. `prepareRunWorkspace` issues the materialize commands + a contract-files
//      commit when the run carries a contract manifest, and is a clean no-op when it
//      does not (a brownfield run that ships its own contract).
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { materializeContractFilesInWorkspace } from "../src/engine/workspace/index.js";
import { materializeContractFiles } from "../src/engine/forge/scaffold/index.js";
import type { ProjectLifecycle } from "../src/engine/config/index.js";
import { prepareRunWorkspace } from "../src/engine/workflow/plannerRunWorkspace.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const CLONE_HEAD = "a".repeat(40);

const TS_LIFECYCLE: ProjectLifecycle = {
  stack: "ts/pnpm",
  bootstrap: "pnpm install --frozen-lockfile",
  tier1: "pnpm lint",
  tier2: "pnpm test",
  tier3: "pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
  upgrade: "pnpm update --latest",
  toolchain: [],
};

// Records every command + stdin; yields the clone HEAD on every call (the trailing
// `git rev-parse HEAD` must resolve a sha). The `if [ -f ]` guard echoes nothing on
// stdout, so the file is treated as ABSENT (written) — the greenfield path.
// The `.tanren/ci.yml` READ specifically — `if [ -f <p> ]; then cat <p>; fi`. Matched on
// the `then cat` shape rather than the path, because the contract MATERIALIZATION command
// names the same path and must NOT be answered as a config read.
function isCiConfigRead(command: RunnerCommand): boolean {
  return command.command.includes("; then cat ") && command.command.includes(".tanren/ci.yml");
}

class RecordingSsh implements CommandSubstrate {
  readonly commands: Array<{ command: RunnerCommand }> = [];
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ command });
    // The `.tanren/ci.yml` read is a `cat`-if-present: no config file ⇒ empty stdout,
    // exit 0. A catch-all sha here is a shape no runner produces.
    if (isCiConfigRead(command)) {
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    }
    return { exitCode: 0, stdout: CLONE_HEAD, stderr: "", timedOut: false };
  }
}

// An SSH that reports each contract file ALREADY PRESENT (the skip marker on
// stdout), so the materialization writes nothing (the never-clobber path).
class PresentSsh implements CommandSubstrate {
  readonly commands: Array<{ command: RunnerCommand }> = [];
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ command });
    if (isCiConfigRead(command)) {
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    }
    return { exitCode: 0, stdout: "tanren: contract file present - skipping", stderr: "", timedOut: false };
  }
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

describe("materializeContractFilesInWorkspace · exact-bytes over stdin, write-iff-absent", () => {
  it("writes each contract file's exact bytes over stdin (never in the command string)", async () => {
    const ssh = new RecordingSsh();
    const files = materializeContractFiles(TS_LIFECYCLE);
    const result = await materializeContractFilesInWorkspace({
      ssh,
      target,
      files,
      workspacePath: "/workspace/runs/run_x/repo",
      timeoutMs: 500,
    });
    expect(result.written.sort()).toEqual([".tanren/ci.yml", "justfile"].sort());
    expect(result.skipped).toEqual([]);
    // One SSH command per file; the EXACT bytes ride on stdin, not the command.
    expect(ssh.commands).toHaveLength(2);
    for (const { command } of ssh.commands) {
      const cmd = command as RunnerCommand & { stdin?: string };
      const file = files.find((f) => cmd.stdin === f.content);
      expect(file).toBeDefined();
      // The content is NOT spliced into the executed command string.
      expect(cmd.command).not.toContain(file?.content ?? "<none>");
      // The guard writes via `cat >` only when the file is absent.
      expect(cmd.command).toContain("[ -f");
      expect(cmd.command).toContain("cat >");
    }
  });

  it("is a no-op when the files already exist (never clobbers a writer-enriched contract)", async () => {
    const ssh = new PresentSsh();
    const result = await materializeContractFilesInWorkspace({
      ssh,
      target,
      files: materializeContractFiles(TS_LIFECYCLE),
      workspacePath: "/workspace/runs/run_x/repo",
      timeoutMs: 500,
    });
    expect(result.written).toEqual([]);
    expect(result.skipped.sort()).toEqual([".tanren/ci.yml", "justfile"].sort());
  });
});

function makeInput(ssh: CommandSubstrate, context: PlannerRunContext): RunPlannerLoopInput {
  return {
    ssh,
    secrets: new FakeSecretStore(),
    githubHttp: unusedHttp(),
    context,
    timeoutMs: 500,
    bootstrapCommand: "true",
    runBootstrap: async () => {},
    // A real (non-empty) bootstrap sha so the contract-files commit lands above it.
    commitBootstrap: async () => "b".repeat(40),
  } as unknown as RunPlannerLoopInput;
}

function makeContext(overrides: Partial<PlannerRunContext> = {}): PlannerRunContext {
  return {
    runId: "run_mat",
    specId: "spec_mat",
    projectId: "project_mat",
    orgId: "org_mat",
    repoUrl: "https://github.com/cat-cave/fixture",
    targetBranch: "main",
    runBranch: "tanren/run_mat",
    specTitle: "scaffold",
    specDescription: "d",
    acceptanceCriteria: [],
    runnerImage: "image",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "",
    ...overrides,
  };
}

describe("prepareRunWorkspace · materializes + commits the contract files when the run carries them", () => {
  it("issues the materialize commands + a contract-files commit on a greenfield run", async () => {
    const ssh = new RecordingSsh();
    const context = makeContext({ contractFiles: materializeContractFiles(TS_LIFECYCLE) });
    await prepareRunWorkspace(makeInput(ssh, context), target, "/workspace/runs/run_mat/repo");
    const labels = ssh.commands.map(({ command }) => (command as { label?: string }).label ?? "");
    // Two materialize commands (one per contract file) + the contract-files commit.
    expect(labels.filter((l) => l.startsWith("materialize contract file"))).toHaveLength(2);
    expect(labels).toContain("commit deterministic contract files");
    // The commit stages ONLY the contract files (not -A).
    const commit = ssh.commands.find(
      ({ command }) => (command as { label?: string }).label === "commit deterministic contract files",
    );
    expect(commit).toBeDefined();
    const commitCommand = (commit?.command as { command: string } | undefined)?.command ?? "";
    expect(commitCommand).toContain("add '.tanren/ci.yml' 'justfile'");
    // TANREN'S OWN GIT, resolved before the project's shims go on PATH. Only the HOOK
    // needed the project's toolchain; a project that declares `git` must not also decide
    // which binary writes Tanren's commit or prints the sha that becomes the review base.
    expect(commitCommand).toContain('TANREN_GIT="$(command -v git 2>/dev/null || true)"');
    expect(commitCommand).toContain(`"$TANREN_GIT" add`);
    expect(commitCommand).toContain(`"$TANREN_GIT" rev-parse HEAD`);
    // The commit's own stdout goes to STDERR: `-q` silences git, not the repo's live
    // pre-commit hook, and hook chatter on stdout would be read as the commit sha.
    expect(commitCommand).toMatch(/commit -q -m '[^']*' >&2/u);
  });

  it("is a clean no-op when the run carries NO contract manifest (brownfield ships its own)", async () => {
    const ssh = new RecordingSsh();
    await prepareRunWorkspace(makeInput(ssh, makeContext()), target, "/workspace/runs/run_mat/repo");
    const labels = ssh.commands.map(({ command }) => (command as { label?: string }).label ?? "");
    expect(labels.some((l) => l.startsWith("materialize contract file"))).toBe(false);
    expect(labels).not.toContain("commit deterministic contract files");
  });
});

// apex v28 fix: the ANSWERER review base (`baseSha`) is what the checker/auditor/
// convergence diff the writer's change against. It must sit ABOVE the Tanren-
// materialized contract-files commit so those Tanren-owned files (`.tanren/ci.yml` +
// `justfile`) are NOT in the writer's reviewed diff — otherwise the answerers misread
// them as writer-authored and flag `contract-files-authored` (the live v28 false
// finding). The contract files still ride into the PR; only the REVIEW base excludes them.
const BOOTSTRAP_SHA = "b".repeat(40);
const CONTRACT_SHA = "c".repeat(40);

// Returns the CONTRACT-commit sha for the contract-files commit's `git rev-parse HEAD`
// (so the answerer base is distinguishable from the clone/bootstrap shas), and the
// clone HEAD for every other command. Greenfield: each `[ -f ]` guard echoes nothing,
// so the contract files are treated ABSENT (written) and a real commit is made.
class ShaRoutingSsh implements CommandSubstrate {
  readonly commands: Array<{ command: RunnerCommand }> = [];
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ command });
    if (isCiConfigRead(command)) {
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    }
    const label = (command as { label?: string }).label ?? "";
    const stdout = label === "commit deterministic contract files" ? CONTRACT_SHA : CLONE_HEAD;
    return { exitCode: 0, stdout, stderr: "", timedOut: false };
  }
}

// PR-G (task #77) — the workspace-prep template-seed clone step is GONE: the
// composed VFS now lands DIRECTLY in the project repo's default branch at
// derive time (via `materializeTemplate`), so the workspace-prep clone of a
// separate seed repo is no longer needed. The describe block that asserted
// the seed-clone-and-commit workspace step was deleted with this collapse.

describe("prepareRunWorkspace · NO seed-clone step (PR-G — task #77 collapsed it)", () => {
  it("never issues a `materialize template seed` or `commit template seed` command", async () => {
    const ssh = new RecordingSsh();
    await prepareRunWorkspace(makeInput(ssh, makeContext()), target, "/workspace/runs/run_mat/repo");
    const labels = ssh.commands.map(({ command }) => (command as { label?: string }).label ?? "");
    expect(labels).not.toContain("materialize template seed");
    expect(labels).not.toContain("commit template seed");
  });
});

describe("prepareRunWorkspace · the answerer review base sits ABOVE the contract-files commit (apex v28)", () => {
  it("returns the contract-commit sha as baseSha on a greenfield run (writer diff excludes the contract files)", async () => {
    const ssh = new ShaRoutingSsh();
    const context = makeContext({ contractFiles: materializeContractFiles(TS_LIFECYCLE) });
    const prepared = await prepareRunWorkspace(makeInput(ssh, context), target, "/workspace/runs/run_mat/repo");
    // The answerer base is the contract commit — NOT the bootstrap commit — so the
    // contract files are below the review base and never appear as writer changes.
    expect(prepared.baseSha).toBe(CONTRACT_SHA);
    expect(prepared.baseSha).not.toBe(BOOTSTRAP_SHA);
    // But the PUSH drop boundary is still the bootstrap commit, so the contract commit
    // (above it) replays into the PR — the human/merge still sees the contract files.
    expect(prepared.bootstrapSha).toBe(BOOTSTRAP_SHA);
    // The contract-files commit was actually made (the files were absent → written).
    const labels = ssh.commands.map(({ command }) => (command as { label?: string }).label ?? "");
    expect(labels).toContain("commit deterministic contract files");
  });

  it("falls back to the bootstrap base when the contract files are already present (brownfield re-clone)", async () => {
    // PresentSsh reports the contract files present (skip marker) so nothing is written
    // and NO contract commit is made — baseSha stays the bootstrap commit.
    const ssh = new PresentSsh();
    const context = makeContext({ contractFiles: materializeContractFiles(TS_LIFECYCLE) });
    const prepared = await prepareRunWorkspace(makeInput(ssh, context), target, "/workspace/runs/run_mat/repo");
    expect(prepared.baseSha).toBe(BOOTSTRAP_SHA);
    const labels = ssh.commands.map(({ command }) => (command as { label?: string }).label ?? "");
    expect(labels).not.toContain("commit deterministic contract files");
  });

  it("falls back to the bootstrap base when the run carries NO contract manifest", async () => {
    const ssh = new RecordingSsh();
    const prepared = await prepareRunWorkspace(makeInput(ssh, makeContext()), target, "/workspace/runs/run_mat/repo");
    // No manifest → no contract commit → the answerer base is the bootstrap commit.
    expect(prepared.baseSha).toBe(BOOTSTRAP_SHA);
  });
});
