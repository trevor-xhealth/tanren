// REGRESSION — Tanren must be able to prepare a workspace to the point where the target
// repository's OWN quality gates can run, including the parts of its toolchain that no
// language manifest declares.
//
// THE DEFECT, as observed on a live bench run. Tanren planned, invoked the writer, produced
// code, and reached the commit step with the project's toolchain correctly on PATH (#1418) —
// and lost it one gate later:
//
//   🔍 Running pre-commit checks...
//   🔍 Scanning staged changes for secrets...
//   error: gitleaks is not installed or not on PATH
//   ❌ Secret scan blocked the commit. See the remediation block above.
//   husky - pre-commit script failed (code 1)
//
// The hook is CORRECT to block: a secret scanner that silently degrades when it cannot scan
// is worse than useless, because "no secrets found" and "I did not look" become the same
// outcome. And `gitleaks` is not a Node or Python dependency, so it appears in no manifest
// Layer-1 detection reads (#1417) — no amount of widening toolchain DETECTION reaches it.
//
// WHAT WAS ACTUALLY MISSING, and why it is two things:
//
//  1. NO ONCE-PER-WORKSPACE PHASE. Tanren's only preparation verb was `bootstrap.run`, and
//     it is UNLATCHED by design — it runs before EVERY gate so a writer-added dependency is
//     always installed. That prices it per gate, which makes it the wrong home for a
//     one-time native-binary install. A repository facing that does not fail loudly; it
//     declares less. Verbatim from the target repo's own contract:
//         # Deliberately not scripts/bootstrap.sh, which wants sudo, network and a
//         # terraform/tflint/gitleaks install on every gate.
//     It was right about the cost. It had nowhere to say the other thing.
//  2. NO WRITABLE DESTINATION ON PATH. Even a repo that DID declare the install had nowhere
//     to put the binary: the runner's PATH is `/usr/local/bin:/usr/bin:/bin:/usr/games`, all
//     root-owned, and the `tanren` user is non-root with no `sudo` (runner/Dockerfile, on
//     purpose). mise activation exports only mise's OWN directories.
//
// So the tests below come in two halves, and BOTH are required: the repo's declared
// `setup.run` runs exactly once per workspace, and `$TANREN_BIN` is on PATH for every
// command that runs the project's code — including the commit whose hooks are live, which
// is the exact subprocess that failed.
//
// WHY NOT DETECT `scripts/bootstrap.sh`. The final describe block is the negative control
// for the design decision, not just the code: against this very repository, convention-based
// detection would have run the exact script whose contract says it must not run — and would
// have died on its first `sudo` anyway. Tanren executes what a repository DECLARES.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { CiConfigV1, DEFAULT_CI_CONFIG, resolveCiConfig, setupCommand } from "../src/engine/ci/index.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";
import { captureGitStateAfterCodex } from "../src/engine/providers/codexGit.js";
import { miseRunScope } from "../src/engine/ssh/miseActivate.js";
import { TANREN_BIN_ENV, withWorkspaceToolPath, workspaceToolBinDir } from "../src/engine/ssh/workspaceToolPath.js";
import { withMiseActivation } from "../src/engine/ssh/miseActivate.js";
import {
  ensureWorkspaceDepsInstalled,
  ensureWorkspaceSetup,
  WorkspaceDepsInstallError,
  WorkspaceSetupError,
  workspaceSetupMarkerFile,
} from "../src/engine/workspace/index.js";
import { resolveWorkspaceLifecycleCommands } from "../src/engine/workflow/gate/index.js";
import { prepareRunWorkspace } from "../src/engine/workflow/plannerRunWorkspace.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const WORKSPACE = "/workspace/runs/run_setup/repo";
const HEAD_SHA = "d".repeat(40);

// The repo's declared once-per-workspace setup — a native binary install into the directory
// Tanren provides. Tanren never parses this; it is opaque project shell.
const SETUP_RUN = 'curl -fsSL https://example.invalid/gitleaks.tgz | tar -xz -C "$TANREN_BIN" gitleaks';
const BOOTSTRAP_RUN = "pnpm install --frozen-lockfile && uv sync --group dev";

// The repo's contract, in the minimal-YAML dialect Tanren's own reader accepts.
const CI_YAML = [
  "version: 1",
  "setup:",
  `  run: ${SETUP_RUN}`,
  "bootstrap:",
  `  run: ${BOOTSTRAP_RUN}`,
  "tiers:",
  "  fast:",
  "    - name: lint",
  "      run: pnpm lint",
  "  slow:",
  "    - name: test",
  "      run: pnpm test",
  "      junitReport: reports/junit.xml",
  "  merge:",
  "    - name: merge-test",
  "      run: pnpm test",
  "      junitReport: reports/junit.xml",
  "when:",
  "  fast:",
  "    - per_iteration",
  "  slow:",
  "    - pre_audit",
  "  merge:",
  "    - pre_merge",
  "",
].join("\n");

/** The `.tanren/ci.yml` READ (`if [ -f <p> ]; then cat <p>; fi`) — matched on the `then cat`
 * shape rather than the path, because the contract MATERIALIZATION names the same path. */
function isCiConfigRead(command: RunnerCommand): boolean {
  return command.command.includes("; then cat ") && command.command.includes(".tanren/ci.yml");
}

function isSetupStep(command: RunnerCommand): boolean {
  return command.command.includes("tanren: workspace-setup");
}

/**
 * A runner that serves the repo's contract and models the ONE thing the whole fix turns on:
 * the marker latch. `setupRuns` counts how many times the project's setup command was
 * actually executed, which is what "once per workspace" means operationally.
 */
class ContractRunnerSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  /** Runner-side state: has the latch been written? */
  latched = false;
  /** How many times the project's declared setup command actually ran. */
  setupRuns = 0;
  /** Set when the setup step is asked to run and fails (see `failSetup`). */
  constructor(
    private readonly yaml: string = CI_YAML,
    private readonly failSetup = false,
  ) {}

  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (isCiConfigRead(command)) return { ...ok, stdout: this.yaml };
    if (isSetupStep(command)) {
      // The runner-side `if [ -f "<marker>" ]` branch, modelled honestly.
      if (this.latched) return { ...ok, stdout: "tanren: workspace-setup no-op\n" };
      this.setupRuns += 1;
      if (this.failSetup) {
        return {
          exitCode: 1,
          stdout: "tanren: workspace-setup running\n",
          stderr: "curl: (6) Could not resolve host: example.invalid",
          timedOut: false,
        };
      }
      // The latch is `&&`-chained AFTER the command, so it is written only on success.
      this.latched = true;
      return { ...ok, stdout: "tanren: workspace-setup running\n" };
    }
    if (command.command.includes("git rev-parse HEAD")) return { ...ok, stdout: `${HEAD_SHA}\n` };
    return ok;
  }
}

describe("the repo's declared workspace setup runs — once per workspace, before its bootstrap", () => {
  it("runs the repo's `setup.run` at workspace-prep, BEFORE the project's bootstrap", async () => {
    // THE REGRESSION. Before the `setup` verb existed there was no step here at all: the
    // repo's native toolchain was simply never installed, and the failure surfaced later,
    // in the repo's own pre-commit hook, as `gitleaks is not installed or not on PATH`.
    // The real bootstrap step runs (no `runBootstrap` stub), because the setup is ensured
    // BY that step — the invariant is "no install without setup", enforced at the install
    // door rather than at whichever site happens to call it.
    const ssh = new ContractRunnerSsh();

    await prepareRunWorkspace(makeInput(ssh), target, WORKSPACE);

    expect(ssh.setupRuns).toBe(1);
    const setupIndex = ssh.commands.findIndex(isSetupStep);
    const bootstrapIndex = ssh.commands.findIndex((c) => c.command.includes(BOOTSTRAP_RUN) && !isSetupStep(c));
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    // The project's own setup command rides verbatim inside the step — Tanren never
    // rewrites the shell it was handed.
    expect(ssh.commands[setupIndex]?.command).toContain(SETUP_RUN);
    // …and the repo's own bootstrap follows it, unchanged.
    expect(bootstrapIndex).toBeGreaterThan(setupIndex);
  });

  it("runs AFTER the declared toolchain is provisioned, so setup may use node/python", async () => {
    // Ordering is load-bearing in both directions: a setup command may legitimately need
    // the language toolchain the repo declared, and the bootstrap after it may need what
    // setup installed.
    const ssh = new ContractRunnerSsh();
    let provisionedAt = -1;

    await prepareRunWorkspace(
      makeInput(ssh, {
        provisionMise: async () => {
          provisionedAt = ssh.commands.length;
        },
      }),
      target,
      WORKSPACE,
    );

    const setupAt = ssh.commands.findIndex(isSetupStep);
    const bootstrapAt = ssh.commands.findIndex((c) => c.command.includes(BOOTSTRAP_RUN) && !isSetupStep(c));
    expect(provisionedAt).toBeGreaterThanOrEqual(0);
    expect(setupAt).toBeGreaterThanOrEqual(provisionedAt);
    expect(bootstrapAt).toBeGreaterThan(setupAt);
  });

  it("is LATCHED: a second workspace step does not re-run the repo's setup", async () => {
    // The substantive difference from `bootstrap`. `bootstrap.run` is unlatched on purpose
    // and asks the project to be the idempotency authority; a native-binary install cannot
    // meet that demand cheaply, so Tanren owns this latch instead.
    const ssh = new ContractRunnerSsh();
    await ensureWorkspaceSetup({ ssh, target, workspacePath: WORKSPACE, command: SETUP_RUN });
    const second = await ensureWorkspaceSetup({ ssh, target, workspacePath: WORKSPACE, command: SETUP_RUN });

    expect(ssh.setupRuns).toBe(1);
    expect(second.ran).toBe(false);
  });

  it("writes the latch ONLY on success — a failed setup is retried, never recorded as done", async () => {
    // A half-prepared workspace must not be inherited as prepared. The latch is
    // `&&`-chained after the project's command, so a nonzero setup writes no marker.
    const ssh = new ContractRunnerSsh(CI_YAML, true);
    await expect(
      ensureWorkspaceSetup({ ssh, target, workspacePath: WORKSPACE, command: SETUP_RUN }),
    ).rejects.toBeInstanceOf(WorkspaceSetupError);
    expect(ssh.latched).toBe(false);

    // Proven on the emitted shell too, since the latch resolves on the runner: the marker
    // write hangs off `&&`, never `;`.
    const step = ssh.commands.find(isSetupStep);
    const marker = workspaceSetupMarkerFile(WORKSPACE);
    expect(step?.command).toContain(`&& : > "${marker}"`);
    expect(step?.command).not.toContain(`; : > "${marker}"`);
  });

  it("a repo that declares NO setup verb makes no round-trip at all", async () => {
    // Absence is semantic. There is no default `just setup` and no convention probe, so a
    // repo that declared nothing is untouched — not "silently skipped", genuinely absent.
    const ssh = new ContractRunnerSsh();
    const result = await ensureWorkspaceSetup({ ssh, target, workspacePath: WORKSPACE });

    expect(result.ran).toBe(false);
    expect(ssh.commands).toEqual([]);
  });

  it("the latch and the tool dir live OUTSIDE the repo tree, scoped to this run", async () => {
    // Tanren never materializes a path into a repository it did not author, and three runs
    // share one container as one unix user — a runner-wide `bin` would let run A's
    // terraform satisfy run B, which pinned a different version.
    const marker = workspaceSetupMarkerFile(WORKSPACE);
    const bin = workspaceToolBinDir(WORKSPACE);
    expect(marker).toBe("/workspace/runs/run_setup/tanren-setup-done");
    expect(bin).toBe("/workspace/runs/run_setup/tanren-bin");
    expect(marker.startsWith(WORKSPACE)).toBe(false);
    expect(bin.startsWith(WORKSPACE)).toBe(false);
    expect(workspaceToolBinDir("/workspace/runs/run_other/repo")).not.toBe(bin);
  });
});

describe("$TANREN_BIN is on PATH wherever the project's own code runs", () => {
  it("the project-HOOK commit sees it — the exact subprocess the secret scan failed in", async () => {
    // THE REGRESSION, at its real site. The pre-commit hook resolves `gitleaks` off PATH in
    // a subprocess whose PATH is `/usr/local/bin:/usr/bin:/bin:/usr/games`. Installing the
    // binary is worthless unless THIS command can see it.
    const ssh = new ContractRunnerSsh();
    await captureGitStateAfterCodex(ssh, target, WORKSPACE, HEAD_SHA);

    const commit = ssh.commands.find((c) => /git (?:-c [^ ]+ )?commit /u.test(c.command));
    expect(commit?.command).toContain(`export ${TANREN_BIN_ENV}="${workspaceToolBinDir(WORKSPACE)}"`);
    expect(commit?.command).toContain(`export PATH="${workspaceToolBinDir(WORKSPACE)}:$PATH"`);
    // And it is still not a hook bypass — the point is that the hook RUNS and PASSES.
    expect(commit?.command).not.toContain("core.hooksPath=/dev/null");
  });

  it("the setup step itself, the bootstrap and the deps-ensure all carry it", async () => {
    const ssh = new ContractRunnerSsh();
    await ensureWorkspaceDepsInstalled({
      ssh,
      target,
      workspacePath: WORKSPACE,
      command: BOOTSTRAP_RUN,
      setupCommand: SETUP_RUN,
    });

    const bin = workspaceToolBinDir(WORKSPACE);
    // Every command that RUNS THE PROJECT'S SHELL carries it. Tanren's own pure reads (the
    // toolchain-declaration read, the ci.yml read) deliberately do not: they execute no
    // project code, so giving them the project's environment would widen the blast radius
    // of the project's own PATH for nothing.
    const projectCommands = ssh.commands.filter((c) => c.command.includes(BOOTSTRAP_RUN) || isSetupStep(c));
    expect(projectCommands.length).toBeGreaterThanOrEqual(2);
    for (const command of projectCommands) {
      expect(command.command).toContain(`export PATH="${bin}:$PATH"`);
    }
    // The setup step also CREATES the directory before handing it to the project — a
    // destination that does not exist is not a destination.
    expect(ssh.commands.find(isSetupStep)?.command).toContain(`mkdir -p "${bin}"`);
  });

  it("the DECLARED toolchain still wins: mise's PATH prepend lands on top of the tool dir", async () => {
    // Precedence, and it is deliberate. The tool dir extends the project's environment; it
    // must never silently override the node/pnpm/python version the repository PINNED.
    const command = withMiseActivation("run-me", WORKSPACE);
    const bin = workspaceToolBinDir(WORKSPACE);
    const scope = miseRunScope(WORKSPACE);

    const binAt = command.indexOf(`export PATH="${bin}:$PATH"`);
    const miseAt = command.indexOf(`[ -f "${scope.markerFile}" ]`);
    expect(binAt).toBeGreaterThanOrEqual(0);
    expect(miseAt).toBeGreaterThan(binAt);
  });

  it("the export is UNGUARDED — an empty tool dir must not silently drop off PATH", async () => {
    // Unlike the mise activation next to it, there is no `[ -f … ]` guard: a guard would
    // mean setup could install into a directory a LATER command does not have on PATH,
    // which is precisely the failure being closed.
    const command = withWorkspaceToolPath("run-me", WORKSPACE);
    expect(command).not.toContain("if [");
    expect(command.endsWith("run-me")).toBe(true);
  });
});

describe("a failed setup is attributed to the REPOSITORY, and halts", () => {
  it("names the repo's own setup command as the owner of the failure", async () => {
    // Every halt is a bug report and must name whose bug it is. This one is neither a
    // Tanren fault nor a writer-fixable source defect.
    const ssh = new ContractRunnerSsh(CI_YAML, true);
    const error = await ensureWorkspaceSetup({
      ssh,
      target,
      workspacePath: WORKSPACE,
      command: SETUP_RUN,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkspaceSetupError);
    const message = (error as WorkspaceSetupError).message;
    expect(message).toContain("the repository's declared workspace setup");
    expect(message).toContain("setup.run");
    expect(message).toContain("not a Tanren fault");
    // It carries the diagnostic an operator needs to reproduce it: the command and the tail.
    expect(message).toContain(SETUP_RUN);
    expect(message).toContain("Could not resolve host");
    // …and it points at the destination contract, so the next declaration is a correct one.
    expect(message).toContain("$TANREN_BIN");
  });

  it("is NOT a WorkspaceDepsInstallError, so the gate cannot route it to a remediation writer", async () => {
    // The gate's writer-routing boundary claims `WorkspaceDepsInstallError` and turns it
    // into a P0 finding. Claiming this one too would spend the whole convergence budget on
    // a loop that cannot be won: no source edit makes an environment-setup command succeed.
    const ssh = new ContractRunnerSsh(CI_YAML, true);
    const error = await ensureWorkspaceDepsInstalled({
      ssh,
      target,
      workspacePath: WORKSPACE,
      command: BOOTSTRAP_RUN,
      setupCommand: SETUP_RUN,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkspaceSetupError);
    expect(error).not.toBeInstanceOf(WorkspaceDepsInstallError);
  });

  it("HALTS workspace-prep — it is not deferred to the gate's self-healing path", async () => {
    // A failed `just bootstrap` at prep IS deferred (it is usually a writer-authored
    // scaffold defect the loop can fix). This is the opposite case and must not inherit
    // that treatment.
    const ssh = new ContractRunnerSsh(CI_YAML, true);
    await expect(prepareRunWorkspace(makeInput(ssh), target, WORKSPACE)).rejects.toBeInstanceOf(WorkspaceSetupError);
    // The deferral catches `WorkspaceBootstrapError` only, so this one escapes it — and the
    // run halts instead of carrying a workspace whose environment was never prepared.
    expect(ssh.commands.some((c) => c.command.includes(BOOTSTRAP_RUN) && !isSetupStep(c))).toBe(false);
  });

  it("never leaks an app-env VALUE into the failure message or the carried command", async () => {
    // Substrate-boundary discipline, same as bootstrap: the `export K='v'` prelude is
    // prepended to the EXECUTED string only, so no app secret can reach an event payload.
    const ssh = new ContractRunnerSsh(CI_YAML, true);
    const error = (await ensureWorkspaceSetup({
      ssh,
      target,
      workspacePath: WORKSPACE,
      command: SETUP_RUN,
      appEnv: { APP_DB_PASSWORD: "s3cr3t-value" },
    }).catch((e: unknown) => e)) as WorkspaceSetupError;

    expect(error.message).not.toContain("s3cr3t-value");
    expect(error.command).toBe(SETUP_RUN);
    // It WAS injected into the executed command, though — otherwise the test proves nothing.
    expect(ssh.commands.find(isSetupStep)?.command).toContain("s3cr3t-value");
  });
});

describe("the verb is DECLARED, never detected", () => {
  it("`setup.run` parses off the repo's contract, verbatim", () => {
    expect(setupCommand(resolveCiConfig(CI_YAML))).toBe(SETUP_RUN);
  });

  it("has NO default — DEFAULT_CI_CONFIG declares no setup, unlike bootstrap/upgrade/deploy", () => {
    // A `just setup` default would make every repo that ships no `.tanren/ci.yml` — every
    // greenfield scaffold, on its first prep — run a recipe that does not exist, and halt.
    expect(DEFAULT_CI_CONFIG.setup).toBeUndefined();
    expect(setupCommand(DEFAULT_CI_CONFIG)).toBeUndefined();
    expect(DEFAULT_CI_CONFIG.bootstrap?.run).toBe("just bootstrap");
  });

  it("a repo that omits it resolves to undefined, and NO conventional script is probed for", async () => {
    // THE DESIGN'S NEGATIVE CONTROL. The obvious alternative — detect and run
    // `scripts/bootstrap.sh` / `script/bootstrap` / `bin/setup` / `make setup` — would, on
    // the very repository that motivated this change, have executed the exact script that
    // repository's contract states must not run ("Deliberately not scripts/bootstrap.sh").
    // A convention match is not consent. It would also not have worked: that script is two
    // dozen `sudo apt-get`/`sudo install` calls deep and the runner has no sudo.
    const yaml = CI_YAML.replace(`setup:\n  run: ${SETUP_RUN}\n`, "");
    const ssh = new ContractRunnerSsh(yaml);

    const lifecycle = await resolveWorkspaceLifecycleCommands({ ssh, target, workspacePath: WORKSPACE });

    expect(lifecycle.setup).toBeUndefined();
    expect(lifecycle.bootstrap).toBe(BOOTSTRAP_RUN);
    for (const probe of ["scripts/bootstrap.sh", "script/bootstrap", "bin/setup", "make setup"]) {
      expect(ssh.commands.map((c) => c.command).join("\n")).not.toContain(probe);
    }
  });

  it("resolves BOTH preparation commands from ONE read of the contract", async () => {
    // Two reads would double the round-trip and — worse — let the two verbs be resolved
    // from different bytes of a file a writer may be editing.
    const ssh = new ContractRunnerSsh();
    const lifecycle = await resolveWorkspaceLifecycleCommands({ ssh, target, workspacePath: WORKSPACE });

    expect(lifecycle).toEqual({ setup: SETUP_RUN, bootstrap: BOOTSTRAP_RUN });
    expect(ssh.commands.filter(isCiConfigRead)).toHaveLength(1);
  });

  it("the schema is strict: `setup` takes a run string and nothing else", () => {
    expect(CiConfigV1.safeParse(parsed({ setup: { run: "x" } })).success).toBe(true);
    expect(CiConfigV1.safeParse(parsed({ setup: { run: "x", when: "once" } })).success).toBe(false);
    expect(CiConfigV1.safeParse(parsed({ setup: { run: "" } })).success).toBe(false);
  });
});

function parsed(extra: Record<string, unknown>): unknown {
  return {
    version: 1,
    tiers: {
      fast: [{ name: "l", run: "l" }],
      slow: [{ name: "t", run: "t", junitReport: "reports/junit.xml" }],
      merge: [{ name: "m", run: "m", junitReport: "reports/junit.xml" }],
    },
    when: { fast: ["per_iteration"], slow: ["pre_audit"], merge: ["pre_merge"] },
    ...extra,
  };
}

function makeInput(ssh: CommandSubstrate, overrides: Record<string, unknown> = {}): RunPlannerLoopInput {
  return {
    ssh,
    secrets: new FakeSecretStore(),
    githubHttp: unusedHttp(),
    context: {
      runId: "run_setup",
      specId: "spec_setup",
      projectId: "project_setup",
      orgId: "org_setup",
      repoUrl: "https://github.com/cat-cave/fixture",
      targetBranch: "main",
      runBranch: "tanren/run_setup",
      specTitle: "setup",
      specDescription: "d",
      acceptanceCriteria: [],
      runnerImage: "image",
      identitySecretRef: "runner/test/identity",
      githubCredentialRef: "",
    } as unknown as PlannerRunContext,
    timeoutMs: 500,
    provisionMise: async () => {},
    commitBootstrap: async () => HEAD_SHA,
    ...overrides,
  } as unknown as RunPlannerLoopInput;
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
