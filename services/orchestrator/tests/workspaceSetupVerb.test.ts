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
// WHAT WAS ACTUALLY MISSING. Tanren's only preparation verb was `bootstrap.run`, and it is
// UNLATCHED by design — it runs before EVERY gate so a writer-added dependency is always
// installed. That prices it per gate, which makes it the wrong home for a one-time native
// install. A repository facing that does not fail loudly; it QUIETLY DECLARES LESS. Verbatim
// from the target repo's own contract:
//     # Deliberately not scripts/bootstrap.sh, which wants sudo, network and a
//     # terraform/tflint/gitleaks install on every gate.
// It was right about the cost. It had nowhere to say the other thing. (The second half of
// the gap — that a repo which DID declare the install had nowhere on PATH to put the binary
// — is proven in `workspaceToolPath.test.ts`. `workspace/setup.ts` carries the full
// argument for both.)
//
// WHY NOT DETECT `scripts/bootstrap.sh`. The final describe block is the negative control
// for the design decision, not just the code: against this very repository, convention-based
// detection would have run the exact script whose contract says it must not run — and would
// have died on its first `sudo` anyway. Tanren executes what a repository DECLARES.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";
import { workspaceToolBinDir } from "../src/engine/ssh/workspaceToolPath.js";
import {
  ensureWorkspaceDepsInstalled,
  ensureWorkspaceSetup,
  SETUP_NOOP_SENTINEL,
  SETUP_RUN_SENTINEL,
  WorkspaceDepsInstallError,
  WorkspaceSetupError,
  workspaceSetupMarkerFile,
} from "../src/engine/workspace/index.js";
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

  it("a whitespace-only `setup.run` is not a declaration, and makes no round-trip", async () => {
    // MUTATION-DRIVEN: the `command.trim() === ""` guard could be deleted unnoticed. A
    // blank declaration must be treated as absent rather than executed as an empty shell —
    // running `{ ; }` would write the latch and record a workspace as prepared by nothing.
    const ssh = new ContractRunnerSsh();
    expect(await ensureWorkspaceSetup({ ssh, target, workspacePath: WORKSPACE, command: "   \n\t " })).toEqual({
      ran: false,
    });
    expect(ssh.commands).toEqual([]);
  });

  it("reports `ran` from what the RUNNER did, and the latched branch announces itself", async () => {
    // The two sentinels are the only way the caller learns which runner-side branch was
    // taken, so both are pinned. A latched call must report `ran: false` even though the
    // command exited 0 — "the step succeeded" and "the setup executed" are different facts.
    const ssh = new ContractRunnerSsh();
    const first = await ensureWorkspaceSetup({ ssh, target, workspacePath: WORKSPACE, command: SETUP_RUN });
    expect(first.ran).toBe(true);
    const second = await ensureWorkspaceSetup({ ssh, target, workspacePath: WORKSPACE, command: SETUP_RUN });
    expect(second.ran).toBe(false);
    // Both sentinels appear in the emitted shell, and they are DISTINCT strings.
    const emitted = ssh.commands.map((c) => c.command).join("\n");
    expect(emitted).toContain("tanren: workspace-setup running");
    expect(emitted).toContain("tanren: workspace-setup no-op");
    expect(SETUP_RUN_SENTINEL).not.toBe(SETUP_NOOP_SENTINEL);
  });

  it("runs in the workspace, under an activity watchdog and never a wall-clock kill", async () => {
    // A cold native-binary install is legitimately slow. It must be judged on PROGRESS, in
    // the repo's cwd — a missing cwd would run the project's setup somewhere else entirely.
    const ssh = new ContractRunnerSsh();
    await ensureWorkspaceSetup({ ssh, target, workspacePath: WORKSPACE, command: SETUP_RUN });
    const step = ssh.commands.find(isSetupStep);
    expect(step?.cwd).toBe(WORKSPACE);
    expect(step?.watchdog).toBeDefined();
    expect(step?.connectTimeoutMs).toBeUndefined();
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

  it("claims a SUBSTRATE fault and a STALL, not only a nonzero exit", async () => {
    // MUTATION-DRIVEN. Only the nonzero-exit branch was covered, so the other two thirds of
    // the success predicate could be inverted without a single test noticing — and both are
    // real: a transport fault or a no-sign-of-life stall must never be read as "setup done"
    // and must never write the latch.
    const substrate = await ensureWorkspaceSetup({
      ssh: fixedSsh({
        exitCode: 0,
        stdout: "",
        stderr: "",
        failure: { kind: "transport", message: "connection reset" },
      }),
      target,
      workspacePath: WORKSPACE,
      command: SETUP_RUN,
    }).catch((e: unknown) => e);
    expect(substrate).toBeInstanceOf(WorkspaceSetupError);
    expect((substrate as WorkspaceSetupError).stalled).toBe(false);

    const stalled = (await ensureWorkspaceSetup({
      ssh: fixedSsh({ exitCode: 0, stdout: "", stderr: "", stalled: true }),
      target,
      workspacePath: WORKSPACE,
      command: SETUP_RUN,
    }).catch((e: unknown) => e)) as WorkspaceSetupError;
    expect(stalled).toBeInstanceOf(WorkspaceSetupError);
    // The stall is CARRIED, not flattened into a generic failure: "no sign of life" and
    // "exited nonzero" are different bug reports about different owners.
    expect(stalled.stalled).toBe(true);
    expect(stalled.message).toContain("stalled");
  });

  it("says WHY with no tail, and appends the tail when there is one", async () => {
    // The message must stay legible when the command produced no output at all — the
    // no-output case is itself a signal, and it must not render a dangling separator.
    const quiet = (await ensureWorkspaceSetup({
      ssh: fixedSsh({ exitCode: 3, stdout: "", stderr: "" }),
      target,
      workspacePath: WORKSPACE,
      command: SETUP_RUN,
    }).catch((e: unknown) => e)) as WorkspaceSetupError;
    expect(quiet.message).toContain("exited 3");
    expect(quiet.exitCode).toBe(3);
    expect(quiet.message.endsWith("PATH for the project's commands and hooks")).toBe(true);

    const noisy = (await ensureWorkspaceSetup({
      ssh: fixedSsh({ exitCode: 3, stdout: "", stderr: "disk full" }),
      target,
      workspacePath: WORKSPACE,
      command: SETUP_RUN,
    }).catch((e: unknown) => e)) as WorkspaceSetupError;
    expect(noisy.message).toContain(": disk full");
  });

  it("carries the workspace it failed in, and is named for what it is", async () => {
    const error = (await ensureWorkspaceSetup({
      ssh: fixedSsh({ exitCode: 1, stdout: "", stderr: "x" }),
      target,
      workspacePath: WORKSPACE,
      command: SETUP_RUN,
    }).catch((e: unknown) => e)) as WorkspaceSetupError;
    expect(error.workspacePath).toBe(WORKSPACE);
    // The `name` is what a log line and an `instanceof`-less consumer key on.
    expect(error.name).toBe("WorkspaceSetupError");
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

/** A substrate that answers EVERY command with one fixed result — for driving the failure
 * branches (substrate fault, stall, exit code, empty output) that a runner-shaped fake
 * cannot reach. */
function fixedSsh(result: Record<string, unknown>): CommandSubstrate {
  return { run: async () => result as never };
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
