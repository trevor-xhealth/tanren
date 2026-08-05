// THE OTHER HALF OF THE WORKSPACE ENVIRONMENT — `$TANREN_BIN`, the writable, run-scoped
// tool directory, and the path rules that decide where it lives.
//
// Split from `workspaceSetupVerb.test.ts` (which owns the `setup` VERB — when it runs, the
// latch, the failure attribution) to stay under the architecture line cap. The two are one
// change and only make sense together: a verb with nowhere to write is no verb at all.
//
// WHAT IS BEING PROVEN. A repository's own gates and commit hooks call native binaries by
// name — `gitleaks`, `shellcheck`, `terraform`, `protoc`, `hadolint` — that appear in no
// language manifest. Before this, a repo had nowhere to put one: the runner's PATH is
// `/usr/local/bin:/usr/bin:/bin:/usr/games`, every entry root-owned, the `tanren` user is
// non-root, and the image ships no `sudo` on purpose. mise activation exports only mise's
// OWN directories. So the binary could be installed and still be unreachable — which is
// exactly how a bench run reached `error: gitleaks is not installed or not on PATH` with a
// correctly provisioned toolchain.
//
// The path rules get the same scrutiny as the verb because they are a containment boundary:
// these strings are interpolated into shell inside DOUBLE quotes (so `$HOME` expands), they
// must never land inside a repository Tanren did not author, and three concurrent runs
// share one container as one unix user — so two runs must never resolve the same directory.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { captureGitStateAfterCodex } from "../src/engine/providers/codexGit.js";
import { miseRunScope, withMiseActivation } from "../src/engine/ssh/miseActivate.js";
import { workspaceScopeKey } from "../src/engine/ssh/workspaceScope.js";
import { TANREN_BIN_ENV, withWorkspaceToolPath, workspaceToolBinDir } from "../src/engine/ssh/workspaceToolPath.js";
import { ensureWorkspaceDepsInstalled, workspaceSetupMarkerFile } from "../src/engine/workspace/index.js";

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
const SETUP_RUN = 'curl -fsSL https://example.invalid/gitleaks.tgz | tar -xz -C "$TANREN_BIN" gitleaks';
const BOOTSTRAP_RUN = "pnpm install --frozen-lockfile && uv sync --group dev";

function isSetupStep(command: RunnerCommand): boolean {
  return command.command.includes("tanren: workspace-setup");
}

/** A runner that models the setup latch, so the two install doors behave as they do live. */
class ContractRunnerSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  latched = false;

  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (command.command.includes("; then cat ") && command.command.includes(".tanren/ci.yml")) return ok;
    if (isSetupStep(command)) {
      if (this.latched) return { ...ok, stdout: "tanren: workspace-setup no-op\n" };
      this.latched = true;
      return { ...ok, stdout: "tanren: workspace-setup running\n" };
    }
    if (command.command.includes("git rev-parse HEAD")) return { ...ok, stdout: `${HEAD_SHA}\n` };
    return ok;
  }
}

describe("the run-scoped paths hold up outside the production workspace shape", () => {
  // MUTATION-DRIVEN. Every case above uses `/workspace/runs/<runId>/repo`, so the entire
  // `$HOME` FALLBACK — the shape the `rawInput.workspacePath` override seam and fixtures
  // actually take — was unexercised, and so was the pattern that chooses between them.
  const FALLBACK = "/home/tanren/scratch/checkout";

  it("falls back to a $HOME path, still outside the repo tree, when the shape is not a run sandbox", () => {
    const bin = workspaceToolBinDir(FALLBACK);
    expect(bin.startsWith("$HOME/.tanren-bin-")).toBe(true);
    expect(bin.startsWith(FALLBACK)).toBe(false);
    expect(workspaceSetupMarkerFile(FALLBACK).startsWith("$HOME/.tanren-setup-")).toBe(true);
    // The mise scope takes the SAME fallback — one rule, so the two can never disagree
    // about which run owns a path.
    expect(miseRunScope(FALLBACK).configFile.startsWith("$HOME/.tanren-mise-")).toBe(true);
  });

  it("only the exact run-sandbox shape takes the run-dir branch", () => {
    // A near-miss must NOT be treated as a run sandbox — that would put Tanren's state in
    // a directory it does not own. Each of these differs from the pattern in one way.
    for (const near of [
      "/workspace/runs/run_abc/repo/nested",
      "/workspace/runs/run_abc",
      "/workspace/runs/other_abc/repo",
      "/workspace/run/run_abc/repo",
      "workspace/runs/run_abc/repo",
    ]) {
      expect(workspaceToolBinDir(near).startsWith("$HOME/.tanren-bin-")).toBe(true);
    }
    expect(workspaceToolBinDir("/workspace/runs/run_abc/repo")).toBe("/workspace/runs/run_abc/tanren-bin");
  });

  it("a run sandbox NESTED under another path is not a run sandbox", () => {
    // The pattern is anchored on purpose. Unanchored, any path merely CONTAINING the run
    // shape would be read as one — so a checkout at `<somewhere>/workspace/runs/run_x/repo`
    // would have Tanren write its state into a directory belonging to a different tree.
    expect(workspaceToolBinDir("/srv/workspace/runs/run_abc/repo").startsWith("$HOME/.tanren-bin-")).toBe(true);
  });

  it("the fallback key normalizes exactly: runs collapse, separators become one dash, edges trim", () => {
    // Each assertion pins one clause of the normalization, because each is separately
    // wrong-able: dropping `+` stops collapsing runs (a longer, different filename for the
    // same path), replacing with "" instead of "-" welds path segments together (two
    // different paths can then collide), and losing either edge anchor leaves a leading or
    // trailing dash in a filename.
    expect(workspaceScopeKey("/tmp/a//b/repo")).toMatch(/^tmp-a-b-repo-[0-9a-f]{8}$/u);
    expect(workspaceScopeKey("/tmp/a   b/repo")).toMatch(/^tmp-a-b-repo-[0-9a-f]{8}$/u);
    // A separator must become a dash, not vanish: `ab` and `a/b` are different workspaces.
    expect(workspaceScopeKey("/ab/repo")).not.toBe(workspaceScopeKey("/a/b/repo"));
    // Both edges trim, and they trim RUNS, not a single character.
    expect(workspaceScopeKey("///tmp///")).toMatch(/^tmp-[0-9a-f]{8}$/u);
    // The slug is genuinely USED — a constant here would give every workspace one name.
    expect(workspaceScopeKey("/alpha/repo").startsWith("alpha-repo-")).toBe(true);
    expect(workspaceScopeKey("/alpha/repo")).not.toBe(workspaceScopeKey("/beta/repo"));
  });

  it("the fallback key is shell-safe, bounded, and distinct per workspace", () => {
    // These strings are interpolated inside DOUBLE quotes (so `$HOME` expands), so any
    // surviving shell metacharacter is a command-injection surface, not a cosmetic issue.
    const key = workspaceScopeKey("/tmp/a b/c$(id)'x\"y;rm -rf/**/repo");
    expect(key).toMatch(/^[A-Za-z0-9-]+$/u);
    expect(key.startsWith("-")).toBe(false);
    expect(key.endsWith("-")).toBe(false);
    // Bounded: the slug is the tail of the path, so an arbitrarily long path cannot make
    // an arbitrarily long filename.
    const long = workspaceScopeKey(`/tmp/${"x".repeat(500)}/repo`);
    expect(long.length).toBeLessThanOrEqual(60);
    // A path whose slug reduces to NOTHING still yields a usable name.
    expect(workspaceScopeKey("///")).toMatch(/^workspace-[0-9a-f]{8}$/u);
  });

  it("two workspaces with the same slug still get distinct scopes", () => {
    // The whole reason the key carries a hash of the FULL path: the slug is only the last
    // 40 characters, so two different runs can reduce to the same slug.
    const a = `/alpha/${"p".repeat(60)}/repo`;
    const b = `/beta/${"p".repeat(60)}/repo`;
    expect(workspaceScopeKey(a)).not.toBe(workspaceScopeKey(b));
    // …and it is deterministic: the same path must resolve to the same scope on every
    // call, or a later step looks for state an earlier one did not write there.
    expect(workspaceScopeKey(a)).toBe(workspaceScopeKey(a));
    expect(workspaceScopeKey(a)).toMatch(/-[0-9a-f]{8}$/u);
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

  it("the env var is named `TANREN_BIN` — it is the contract a repo's setup.run is written against", () => {
    // Asserted as a LITERAL, not via the constant: a repo's `setup.run` says `"$TANREN_BIN"`
    // in its own committed contract, so renaming this silently breaks every declaration.
    expect(TANREN_BIN_ENV).toBe("TANREN_BIN");
    expect(withWorkspaceToolPath("x", WORKSPACE)).toContain('export TANREN_BIN="');
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
