import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { defineFailure } from "../src/engine/failure.js";
import { createFakeWriter } from "./fixtures/fakeWriter.js";
import { parseGitLogCommit, prepareGitWorkspace } from "./fixtures/workspaceGit.js";
import {
  bootstrapWorkspace,
  DEFAULT_BOOTSTRAP_COMMAND,
  ensureWorkspaceDepsInstalled,
  runWorkspaceSshCommand,
  WorkspaceBootstrapError,
  WorkspaceCommandError,
  WorkspaceDepsInstallError,
  WorkspaceMiseProvisionError,
  WorkspaceToolchainUnavailableError,
  workspaceRepoPathForRun,
} from "../src/engine/workspace/index.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

describe("workspace git contract", () => {
  it("builds only run-scoped workspace paths", () => {
    expect(workspaceRepoPathForRun("run_1234-abcd")).toBe("/workspace/runs/run_1234-abcd/repo");
    expect(() => workspaceRepoPathForRun("spec_123")).toThrow("unsafe run id");
    expect(() => workspaceRepoPathForRun("run_../escape")).toThrow("unsafe run id");
    expect(() => workspaceRepoPathForRun("run_bad/path")).toThrow("unsafe run id");
  });

  it("turns nonzero, timeout, and substrate failures into workspace command errors", async () => {
    const nonzero = new ScriptedSsh([{ exitCode: 7, stdout: "", stderr: "bad" }]);
    await expect(
      runWorkspaceSshCommand(nonzero, target, {
        label: "git step",
        command: "git status",
      }),
    ).rejects.toThrow(WorkspaceCommandError);

    const timedOut = new ScriptedSsh([{ exitCode: null, stdout: "", stderr: "", stalled: true }]);
    await expect(
      runWorkspaceSshCommand(timedOut, target, {
        label: "slow step",
        command: "sleep 10",
      }),
    ).rejects.toThrow("slow step failed: stalled (no sign of life)");

    const failed = new ScriptedSsh([
      {
        exitCode: null,
        stdout: "",
        stderr: "",
        failure: defineFailure({
          kind: "ssh_failed",
          target: "tanren@runner:22",
          message: "connection failed",
        }),
      },
    ]);
    await expect(runWorkspaceSshCommand(failed, target, { label: "ssh step", command: "true" })).rejects.toThrow(
      "ssh step failed: connection failed",
    );
  });

  it("surfaces the FAILED COMMAND + stderr tail on a workspace command failure (no opaque `failed: exit 1`)", async () => {
    // The exact apex-v23 shape: a bootstrap commit that exits 1 with the git
    // auto-detect-email error on stderr. The loud message must name the command
    // that failed AND carry its stderr — not just `… failed: exit 1`.
    const stderr = "fatal: unable to auto-detect email address (got 'tanren@host.(none)')";
    const ssh = new ScriptedSsh([{ exitCode: 1, stdout: "", stderr }]);
    let error: unknown;
    try {
      await runWorkspaceSshCommand(ssh, target, {
        label: "commit bootstrap state",
        command: "git add -A && git commit -m bootstrap",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkspaceCommandError);
    const message = (error as WorkspaceCommandError).message;
    expect(message).toContain("commit bootstrap state failed: exit 1");
    // The failed command is surfaced.
    expect(message).toContain("command: git add -A && git commit -m bootstrap");
    // The stderr tail is surfaced (the actual root-cause line).
    expect(message).toContain(`stderr: ${stderr}`);
  });

  it("parses captured git commit metadata", () => {
    expect(parseGitLogCommit("0123456789abcdef0123456789abcdef01234567\thello world\n")).toEqual({
      sha: "0123456789abcdef0123456789abcdef01234567",
      message: "hello world",
    });
    expect(() => parseGitLogCommit("not-a-sha\thello world\n")).toThrow("invalid sha");
    expect(() => parseGitLogCommit("0123456789abcdef0123456789abcdef01234567\n")).toThrow("separator");
  });

  it("prepares a repo and runs the fake writer through SSH git commands", async () => {
    const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const diff = "diff --git a/HELLO.md b/HELLO.md\nnew file mode 100644\n+hello world\n";
    const ssh = new ScriptedSsh([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: diff, stderr: "" },
      { exitCode: 0, stdout: `${sha}\thello world\n`, stderr: "" },
    ]);
    const workspacePath = workspaceRepoPathForRun("run_git_contract");

    await prepareGitWorkspace({ ssh, target, workspacePath });
    const writer = createFakeWriter({ ssh, target });
    const result = await writer.runWriter({
      prompt: "write",
      workspace: workspacePath,
    });

    expect(result.diff).toBe(diff);
    expect(result.commits).toEqual([{ sha, message: "hello world" }]);
    expect(ssh.commands.map((item) => item.command.cwd)).toEqual([
      undefined,
      workspacePath,
      workspacePath,
      workspacePath,
    ]);
    expect(ssh.commands[0]?.command.command).toContain("git init -b main");
    expect(ssh.commands[1]?.command.command).toContain("HELLO.md");
    expect(ssh.commands[2]?.command.command).toBe("git diff --no-color HEAD~1..HEAD");
    expect(ssh.commands[3]?.command.command).toBe("git log -1 --format='%H%x09%s' HEAD");
  });
});

describe("workspace bootstrap (P3-0006)", () => {
  const workspacePath = workspaceRepoPathForRun("run_bootstrap");

  it("runs the install command in the workspace dir and returns success", async () => {
    const ssh = new ScriptedSsh([{ exitCode: 0, stdout: "Packages: +120", stderr: "" }]);
    const result = await bootstrapWorkspace({
      ssh,
      target,
      workspacePath,
      command: "pnpm install",
    });

    expect(result.exitCode).toBe(0);
    expect(ssh.commands).toHaveLength(1);
    // The EXECUTED command is mise-activated (project path) so a bare `pnpm` resolves
    // to the declared toolchain; the project's own command runs verbatim at the tail.
    expect(ssh.commands[0]?.command.command.endsWith("pnpm install")).toBe(true);
    expect(ssh.commands[0]?.command.command).toContain("mise activate bash");
    expect(ssh.commands[0]?.command.cwd).toBe(workspacePath);
  });

  it("falls back to the stack-agnostic `just bootstrap` LOUD-fallback when none is given", async () => {
    const ssh = new ScriptedSsh([{ exitCode: 0, stdout: "", stderr: "" }]);
    await bootstrapWorkspace({ ssh, target, workspacePath });

    expect(ssh.commands[0]?.command.command.endsWith(DEFAULT_BOOTSTRAP_COMMAND)).toBe(true);
    // `just bootstrap` when a justfile is present — and NO baked-in stack command.
    expect(DEFAULT_BOOTSTRAP_COMMAND).toContain("just bootstrap");
    expect(DEFAULT_BOOTSTRAP_COMMAND).not.toMatch(/pnpm|npm|corepack|node/u);
  });

  it("the fallback NO-OPs (exit 0) when no justfile is present — an empty greenfield repo, contract enforced at the gate", () => {
    // The cold bootstrap runs over a freshly-cloned workspace; a greenfield scaffold
    // is an EMPTY repo BEFORE the writer authors the justfile, so there is nothing to
    // bootstrap yet — it skips with a note (a legitimate-empty case, NOT a guessed
    // stack: no pnpm/npm/node probe). Contract enforcement lives at the GATE
    // (`just tier-1` fails → a P0 finding the loop fixes), never bricking an empty repo.
    expect(DEFAULT_BOOTSTRAP_COMMAND).not.toContain("exit 1");
    expect(DEFAULT_BOOTSTRAP_COMMAND).toMatch(/justfile/u);
    expect(DEFAULT_BOOTSTRAP_COMMAND).toMatch(/skipping bootstrap/u);
    // Shell-parse safety: no embedded single-quote (the v27 syntax-error regression).
    expect(DEFAULT_BOOTSTRAP_COMMAND).not.toContain("\\'");
  });

  it("throws a typed WorkspaceBootstrapError with exit code + output tail on failure", async () => {
    const ssh = new ScriptedSsh([
      {
        exitCode: 1,
        stdout: "resolving",
        stderr: "ERR_PNPM_NO_LOCKFILE\nvitest: not found",
      },
    ]);

    const error = await bootstrapWorkspace({
      ssh,
      target,
      workspacePath,
      command: "pnpm install",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceBootstrapError);
    const typed = error as WorkspaceBootstrapError;
    expect(typed.exitCode).toBe(1);
    expect(typed.workspacePath).toBe(workspacePath);
    expect(typed.outputTail).toContain("vitest: not found");
    expect(typed.message).toContain("exited 1");
  });

  it("treats a timeout and a substrate failure as bootstrap errors", async () => {
    const timedOut = new ScriptedSsh([{ exitCode: null, stdout: "", stderr: "", stalled: true }]);
    const timeoutError = await bootstrapWorkspace({
      ssh: timedOut,
      target,
      workspacePath,
    }).catch((caught: unknown) => caught);
    expect(timeoutError).toBeInstanceOf(WorkspaceBootstrapError);
    expect((timeoutError as WorkspaceBootstrapError).message).toContain("stalled (no sign of life)");

    const failed = new ScriptedSsh([
      {
        exitCode: null,
        stdout: "",
        stderr: "",
        failure: defineFailure({
          kind: "ssh_failed",
          target: "tanren@runner:22",
          message: "connection reset",
        }),
      },
    ]);
    const substrateError = await bootstrapWorkspace({
      ssh: failed,
      target,
      workspacePath,
    }).catch((caught: unknown) => caught);
    expect(substrateError).toBeInstanceOf(WorkspaceBootstrapError);
    expect((substrateError as WorkspaceBootstrapError).outputTail).toContain("connection reset");
  });
});

describe("ensureWorkspaceDepsInstalled (greenfield deps-ensure)", () => {
  const workspacePath = workspaceRepoPathForRun("run_ensure");

  // Interprets the guarded bootstrap command against a virtual workspace: is the
  // project CONTRACT (a `justfile` / `.tanren/ci.yml`) present? The guard runs the
  // bootstrap WHENEVER the contract exists — the project's `just bootstrap` is the
  // idempotency authority, so a redundant run is a cheap no-op. So `prepared` is
  // tracked only to PROVE the bootstrap still runs when the tree was already
  // prepared (the core regression). The bootstrap branch echoes the install
  // sentinel; the no-contract branch echoes the no-op sentinel — matching the guard.
  class FsAwareSsh implements CommandSubstrate {
    readonly commands: RunnerCommand[] = [];
    installRan = false;
    constructor(
      private readonly fs: { contract: boolean; prepared: boolean },
      // When the bootstrap runs, the exit code it returns (0 = success, else fail).
      private readonly installExit: number = 0,
    ) {}
    // The guarded install is the SECOND round-trip: deps-ensure first probes the repo's
    // toolchain DECLARATION files (the widening that lets a repo without a mise.toml be
    // provisioned at all), then builds the guard from what it found. `guard` names that
    // second command so these assertions stay about the guard, not the probe.
    get guard(): RunnerCommand | undefined {
      return this.commands[1];
    }
    get declarationProbe(): RunnerCommand | undefined {
      return this.commands[0];
    }
    async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
      this.commands.push(command);
      // The declaration probe: this virtual workspace ships no toolchain declaration,
      // so it emits nothing (exit 0) — the "repo declared nothing" case.
      if (command.command.includes("TANREN-TOOLCHAIN-DECLARATION")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // The guard: bootstrap whenever the contract exists (prepared state is
      // irrelevant — a redundant bootstrap is a cheap no-op the project's recipe owns).
      const shouldInstall = this.fs.contract;
      if (shouldInstall) {
        this.installRan = true;
        const failed = this.installExit !== 0;
        return {
          exitCode: this.installExit,
          stdout: `tanren: deps-ensure installing\n${failed ? "" : "Packages: +120"}`,
          stderr: failed ? "vitest: not found" : "",
        };
      }
      return { exitCode: 0, stdout: "tanren: deps-ensure no-op", stderr: "" };
    }
  }

  it("runs the bootstrap when the project contract is present", async () => {
    const ssh = new FsAwareSsh({ contract: true, prepared: false });
    const result = await ensureWorkspaceDepsInstalled({
      ssh,
      target,
      workspacePath,
      command: "just bootstrap",
    });
    expect(result.installed).toBe(true);
    expect(ssh.installRan).toBe(true);
    // The guard runs in the workspace dir and embeds the resolved bootstrap command.
    expect(ssh.guard?.command).toContain("just bootstrap");
    expect(ssh.guard?.cwd).toBe(workspacePath);
    // …and it was preceded by the toolchain-declaration probe, in the same dir.
    expect(ssh.declarationProbe?.command).toContain("TANREN-TOOLCHAIN-DECLARATION");
    expect(ssh.declarationProbe?.cwd).toBe(workspacePath);
  });

  // P0 CORE REGRESSION: the bootstrap re-runs whenever the contract exists, EVEN when
  // the tree was already prepared, so a writer-added dependency authored after an
  // earlier iteration's install is actually present at the gate.
  it("re-runs when the contract exists even though the tree was already prepared", async () => {
    const ssh = new FsAwareSsh({ contract: true, prepared: true });
    const result = await ensureWorkspaceDepsInstalled({ ssh, target, workspacePath });
    expect(result.installed).toBe(true);
    expect(ssh.installRan).toBe(true);
    // The guard probes for the project CONTRACT (justfile / .tanren/ci.yml), NO stack
    // manifest (package.json / node_modules).
    expect(ssh.guard?.command).toMatch(/justfile|\.tanren\/ci\.yml/u);
    expect(ssh.guard?.command).not.toMatch(/node_modules/u);
  });

  it("no-ops when no contract exists yet (greenfield clone HEAD, pre-writer)", async () => {
    const ssh = new FsAwareSsh({ contract: false, prepared: false });
    const result = await ensureWorkspaceDepsInstalled({ ssh, target, workspacePath });
    expect(result.installed).toBe(false);
    expect(ssh.installRan).toBe(false);
  });

  it("defaults to the stack-agnostic `just bootstrap` LOUD-fallback", async () => {
    const ssh = new FsAwareSsh({ contract: true, prepared: false });
    await ensureWorkspaceDepsInstalled({ ssh, target, workspacePath });
    expect(ssh.guard?.command).toContain(DEFAULT_BOOTSTRAP_COMMAND);
    // No baked-in stack command — the project's `just bootstrap` owns the install.
    // (This workspace declares no toolchain, so nothing is provisioned either: Tanren
    // still names no stack of its own, it only honors what a repo declares.)
    expect(ssh.guard?.command).not.toMatch(/pnpm|npm|corepack/u);
  });

  it("keeps the app-env prelude OFF the command field — no secret in the typed error", async () => {
    // A failing bootstrap with an app env present: the prelude is applied to the
    // EXECUTED guard, but the thrown error must surface the ORIGINAL bootstrap
    // command only (no secret value).
    const ssh = new FsAwareSsh({ contract: true, prepared: false }, 1);
    const error = await ensureWorkspaceDepsInstalled({
      ssh,
      target,
      workspacePath,
      command: "just bootstrap",
      appEnv: { API_TOKEN: "super-secret-value" },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceDepsInstallError);
    const typed = error as WorkspaceDepsInstallError;
    expect(typed.exitCode).toBe(1);
    expect(typed.command).toBe("just bootstrap");
    // The secret VALUE must not appear in the error message / command.
    expect(typed.message).not.toContain("super-secret-value");
    expect(typed.command).not.toContain("super-secret-value");
    expect(typed.outputTail).toContain("vitest: not found");
    // The EXECUTED guard carried the prelude (the substrate boundary), so the env
    // is materialized for the bootstrap but never leaks into the error.
    expect(ssh.guard?.command).toContain("super-secret-value");
  });

  it("throws a typed error on a timeout / substrate failure", async () => {
    // Round-trip 1 (the declaration probe) succeeds with no declarations; round-trip 2
    // (the guarded install) stalls.
    const timedOut = new ScriptedSsh([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: null, stdout: "", stderr: "", stalled: true },
    ]);
    const timeoutError = await ensureWorkspaceDepsInstalled({
      ssh: timedOut,
      target,
      workspacePath,
    }).catch((caught: unknown) => caught);
    expect(timeoutError).toBeInstanceOf(WorkspaceDepsInstallError);
    expect((timeoutError as WorkspaceDepsInstallError).message).toContain("stalled (no sign of life)");
  });

  it("routes a MISSING TOOLCHAIN BINARY to the infrastructure halt, not to the writer", async () => {
    // The direct classifier tests cover the pattern; this one covers the WIRING. The whole
    // point of the class is which error leaves this function: a `WorkspaceDepsInstallError`
    // dispatches a remediation writer at a loop no source edit can win, so the boundary has
    // to be exercised through the real call, not only through `classifyToolchainFault`.
    const ssh = new ScriptedSsh([
      // Round-trip 1: the declaration probe. This repo declares nothing Tanren recognizes…
      { exitCode: 0, stdout: "", stderr: "" },
      // …and round-trip 2 is its own bootstrap dying on a toolchain binary nobody declared.
      { exitCode: 127, stdout: "", stderr: "sh: 1: pnpm: not found" },
    ]);
    const error = await ensureWorkspaceDepsInstalled({
      ssh,
      target,
      workspacePath,
      command: "just bootstrap",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceToolchainUnavailableError);
    expect(error).not.toBeInstanceOf(WorkspaceDepsInstallError);
    const typed = error as WorkspaceToolchainUnavailableError;
    expect(typed.missingBinary).toBe("pnpm");
    // The halt says what the repo declared (nothing) and how to declare it — an operator
    // reading it does not have to go find the declaration catalogue.
    expect(typed.message).toContain("ships no toolchain declaration Tanren recognizes");
    expect(typed.message).toContain("Declare 'pnpm'");
  });

  it("returns the toolchain each declared tool RESOLVED to for this gate", async () => {
    // `EnsureWorkspaceDepsResult.toolchain` is how "which version actually ran" leaves the
    // per-gate door. Nothing covered it: a regression that dropped the field, or parsed the
    // wrong stream, would have passed this suite while the gate reported an empty toolchain.
    const ssh = new ScriptedSsh([
      { exitCode: 0, stdout: "", stderr: "" },
      {
        exitCode: 0,
        stdout: "tanren: deps-ensure installing\n===TANREN-TOOLCHAIN-IN-EFFECT:node|24|24.18.1|.nvmrc|pinned===\n",
        stderr: "",
      },
    ]);
    const result = await ensureWorkspaceDepsInstalled({ ssh, target, workspacePath, command: "just bootstrap" });
    expect(result.installed).toBe(true);
    expect(result.toolchain).toEqual([
      { tool: "node", declared: "24", resolved: "24.18.1", declaredIn: ".nvmrc", versionDeclared: true },
    ]);
  });

  it("a FAILED declaration probe halts — it is never read as `this repo declares nothing`", async () => {
    // The original defect in miniature: concluding "no toolchain" from something that
    // was not actually a clean read is how a silent skip becomes a downstream exit 127.
    // A probe that stalls must throw, not shrug.
    const probeStalled = new ScriptedSsh([{ exitCode: null, stdout: "", stderr: "", stalled: true }]);
    const error = await ensureWorkspaceDepsInstalled({ ssh: probeStalled, target, workspacePath }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WorkspaceMiseProvisionError);
    // And it is NOT the writer-routable class — an unreadable runner is not a scaffold defect.
    expect(error).not.toBeInstanceOf(WorkspaceDepsInstallError);
  });
});

class ScriptedSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];

  constructor(private readonly results: CommandResult[]) {}

  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target: sshTarget, command });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error(`unexpected SSH command: ${command.command}`);
    }
    return result;
  }
}
