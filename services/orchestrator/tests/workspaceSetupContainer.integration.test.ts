// THE CONTAINER PROOF for the repo's declared workspace setup — a REAL runner container,
// over the REAL `SshCommandSubstrate`, with a REAL commit hook that shells out to a NATIVE
// BINARY no language manifest declares, and a REAL `setup.run` that builds and installs it.
//
// The sibling `workspaceSetupVerb.test.ts` pins the command STRINGS. Only this file can
// show what those strings DO on a runner, and that is exactly where the defect lived: the
// runner's PATH is `/usr/local/bin:/usr/bin:/bin:/usr/games`, every entry root-owned, the
// `tanren` user is non-root and the image installs no `sudo` — so a repository had nowhere
// to put a native binary that a later subprocess would find. A string test cannot see PATH,
// and cannot see that a directory is writable.
//
// It mirrors `writerCommitToolchain.integration.test.ts` (#1418), which proved the LANGUAGE
// half of the same environment on the same runner. This is the other half.
//
// WIRED, NOT HAND-RUN — `just smoke-toolchain-container` drives it alongside the toolchain
// proofs, against the runner container `just smoke` already stands up.
//
// THE CASES:
//   1. NEGATIVE CONTROL — the same repo with its `setup` verb REMOVED reproduces the exact
//      production failure: the hook cannot find the binary and blocks the commit. This is
//      what proves case 2 is not passing for some incidental reason.
//   2. THE FIX — the repo's declared `setup.run` runs, the binary lands in `$TANREN_BIN`,
//      and the real commit path succeeds with the hook RUNNING (evidenced by a file only
//      the hook writes, naming the binary it resolved). A hook that runs and passes is
//      evidence; a skipped hook is not.
//   3. LATCHED — a second install through the other door does not re-run setup, proven by
//      a counter the setup command itself increments on the runner.
//   4. UNAFFECTED — a repo that declares no setup verb prepares exactly as it always did.
//
// FIXTURE-NEUTRAL, and deliberately so. The binary here is a two-line C program compiled by
// the image's `build-essential` — no network, no named tool, nothing about it specific to
// any repository Tanren happens to be run against. `gitleaks` is what motivated the change;
// what is proven is the general mechanism, and the fixture names no real tool.

import { readFile } from "node:fs/promises";
import type { ServerHostKeyAlgorithm } from "ssh2";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { captureGitStateAfterCodex } from "../src/engine/providers/codexGit.js";
import { SshCommandSubstrate } from "../src/engine/ssh/index.js";
import { miseRunScope } from "../src/engine/ssh/miseActivate.js";
import { workspaceToolBinDir } from "../src/engine/ssh/workspaceToolPath.js";
import { bootstrapWorkspace, ensureWorkspaceDepsInstalled } from "../src/engine/workspace/bootstrap.js";
import { workspaceSetupMarkerFile, WorkspaceSetupError } from "../src/engine/workspace/setup.js";

// A real compile on the runner. This bounds VITEST's patience, not the runner's work.
vi.setConfig({ testTimeout: 600_000, hookTimeout: 60_000 });

const runContainer = process.env.TANREN_TOOLCHAIN_CONTAINER === "1";
const describeContainer = runContainer ? describe : describe.skip;

// The PRODUCTION workspace shape — `/workspace/runs/<runId>/repo`. Load-bearing, not
// cosmetic: `workspaceToolBinDir` and `workspaceSetupMarkerFile` only place a run's state
// in the run sandbox for this shape.
const RUN_DIR = "/workspace/runs/run_setup_proof";
const WORKSPACE = `${RUN_DIR}/repo`;
const BIN_DIR = workspaceToolBinDir(WORKSPACE);
const SETUP_MARKER = workspaceSetupMarkerFile(WORKSPACE);
const HOOK_EVIDENCE = "hook-ran.txt";
const SETUP_COUNTER = `${RUN_DIR}/setup-invocations`;

// The native binary the project's hook needs. It is a REAL compiled ELF, not a shell
// script, because the whole class of tool this change exists for (`gitleaks`, `shellcheck`,
// `terraform`, `protoc`, `hadolint`) is a native binary — and because a compiled artifact
// proves the directory is genuinely writable and genuinely executable-from.
const TOOL = "repo-scan";
const TOOL_SOURCE = ["#include <stdio.h>", 'int main(void){ printf("repo-scan 1.4.2\\n"); return 0; }'].join("\n");

// The repo's declared ONCE-PER-WORKSPACE setup: compile the tool and install it into the
// directory Tanren provides. It appends to a counter first, so the LATCH is measurable as
// "how many times did this command actually execute", not merely "was a marker written".
// Note it names `$TANREN_BIN` — the only thing a repository has to know.
const SETUP_RUN = [`echo x >> ${SETUP_COUNTER}`, 'cc -O0 -o "$TANREN_BIN"/' + TOOL + " tools/repo-scan.c"].join(" && ");

// The project's pre-commit hook, in the shape the production failure wore: it resolves a
// native binary off PATH and BLOCKS when it cannot. The hook is CORRECT — a scanner that
// silently degrades when it cannot scan is worse than useless — which is why the fix
// satisfies it rather than bypassing it.
const PRE_COMMIT_HOOK = [
  "#!/bin/sh",
  "set -e",
  `if ! command -v ${TOOL} > /dev/null 2>&1; then`,
  `  echo "error: ${TOOL} is not installed or not on PATH" >&2`,
  '  echo "Secret scan blocked the commit. See the remediation block above." >&2',
  "  exit 1",
  "fi",
  `printf 'ran-under-%s\\n' "$(${TOOL})" > ${HOOK_EVIDENCE}`,
].join("\n");

let ssh: CommandSubstrate;
let target: RunnerHandle;

describeContainer("a repo's declared setup prepares the workspace its own hooks need · real runner", () => {
  beforeAll(async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({
      ref: "runner/setup-proof/identity",
      value: await readFile(requiredEnv("TANREN_SSH_KEY_PATH"), "utf8"),
    });
    ssh = new SshCommandSubstrate(secrets, {
      serverHostKeyAlgorithms: parseHostKeyAlgorithms(process.env.TANREN_SSH_HOST_KEY_ALGORITHMS),
    });
    target = {
      backend: "ssh",
      host: process.env.TANREN_SSH_HOST ?? "127.0.0.1",
      port: Number(process.env.TANREN_SSH_PORT ?? "22"),
      username: process.env.TANREN_SSH_USER ?? "tanren",
      hostKeyFingerprint: requiredEnv("TANREN_SSH_HOST_FINGERPRINT"),
      identitySecretRef: "runner/setup-proof/identity",
    } as unknown as RunnerHandle;
  });

  it("NEGATIVE CONTROL: with no setup verb the repo's own hook blocks the commit", async () => {
    // The repo is identical except that it declares no `setup.run`, so nothing installs the
    // binary. This is the production failure, on the runner that produced it.
    await seedHookedRepo();
    await bootstrapWorkspace({ ssh, target, workspacePath: WORKSPACE, command: "true" });

    const baselineSha = await headSha();
    await writeWorkspaceFile("src.txt", "the writer's change\n");

    await expect(captureGitStateAfterCodex(ssh, target, WORKSPACE, baselineSha)).rejects.toThrow(
      `${TOOL} is not installed or not on PATH`,
    );
    // The hook did not merely fail — nothing was committed, which is how the bench run lost
    // its writer work.
    expect(await readWorkspaceFile(HOOK_EVIDENCE)).toBe("");
    expect(await countCommits()).toBe(1);
  });

  it("with the setup verb declared, the binary lands on PATH and the hook RUNS and PASSES", async () => {
    await seedHookedRepo();

    await bootstrapWorkspace({
      ssh,
      target,
      workspacePath: WORKSPACE,
      command: "true",
      setupCommand: SETUP_RUN,
    });

    // The binary is really there, in the run-scoped directory, and really executes.
    const installed = await run(`"${BIN_DIR}/${TOOL}"`);
    expect(installed.exitCode, `${installed.stdout}${installed.stderr}`).toBe(0);
    expect(installed.stdout.trim()).toBe("repo-scan 1.4.2");
    // …and OUTSIDE the repository, so no `git add -A` can ever stage it.
    expect(BIN_DIR.startsWith(WORKSPACE)).toBe(false);
    expect((await run(`cd ${shellQuote(WORKSPACE)} && git status --porcelain`)).stdout).not.toContain(TOOL);

    const baselineSha = await headSha();
    await writeWorkspaceFile("src.txt", "the writer's change\n");

    // THE REAL PRODUCTION PATH — the same function the writer loop calls.
    const state = await captureGitStateAfterCodex(ssh, target, WORKSPACE, baselineSha);

    expect(state.commits.map((c) => c.message)).toEqual(["codex writer"]);
    expect(await countCommits()).toBe(2);
    // The commit survived because the hook was SATISFIED. The evidence file exists only if
    // the hook executed, and it names the binary version it resolved — so this is not a
    // hook that was skipped, and not some other copy off the image.
    expect(await readWorkspaceFile(HOOK_EVIDENCE)).toBe("ran-under-repo-scan 1.4.2");
  });

  it("is LATCHED on the runner: the second install door does not re-run setup", async () => {
    await seedHookedRepo();

    await bootstrapWorkspace({ ssh, target, workspacePath: WORKSPACE, command: "true", setupCommand: SETUP_RUN });
    expect(await existsOnRunner(SETUP_MARKER)).toBe(true);
    await ensureWorkspaceDepsInstalled({
      ssh,
      target,
      workspacePath: WORKSPACE,
      command: "true",
      setupCommand: SETUP_RUN,
    });

    // The setup command itself counted its executions. Two doors, one execution.
    expect((await readFileOnRunner(SETUP_COUNTER)).split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("a FAILED setup writes no latch and halts, naming the repository as the owner", async () => {
    await seedHookedRepo();

    const error = await bootstrapWorkspace({
      ssh,
      target,
      workspacePath: WORKSPACE,
      command: "true",
      setupCommand: 'cc -o "$TANREN_BIN"/broken tools/does-not-exist.c',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkspaceSetupError);
    expect((error as WorkspaceSetupError).message).toContain("the repository's declared workspace setup");
    // No latch ⇒ the next workspace retries rather than inheriting a half-prepared tree.
    expect(await existsOnRunner(SETUP_MARKER)).toBe(false);
  });

  it("a repo that declares no setup verb prepares exactly as it always did", async () => {
    // No declaration ⇒ no round-trip, no directory demanded, no behaviour change. Proven on
    // a real shell so a stray `mkdir`/`export` cannot hide behind a string assertion.
    await seedPlainRepo();

    const result = await bootstrapWorkspace({ ssh, target, workspacePath: WORKSPACE, command: "true" });

    expect(result.exitCode).toBe(0);
    expect(await existsOnRunner(SETUP_MARKER)).toBe(false);
    const baselineSha = await headSha();
    await writeWorkspaceFile("src.txt", "the writer's change\n");
    const state = await captureGitStateAfterCodex(ssh, target, WORKSPACE, baselineSha);
    expect(state.commits.map((c) => c.message)).toEqual(["codex writer"]);
  });
});

/** A git repo whose pre-commit hook needs a native binary, shipping the source its declared
 * setup compiles. Resets this workspace's own run-scoped state so each case starts from a
 * fresh posture (per-workspace files only — a concurrent run's state is not ours to delete). */
async function seedHookedRepo(): Promise<void> {
  await seedRepo({
    "tools/repo-scan.c": TOOL_SOURCE,
    "README.md": "# setup-proof\n",
    ".husky/pre-commit": PRE_COMMIT_HOOK,
  });
  const result = await run(
    [
      `cd ${shellQuote(WORKSPACE)}`,
      "chmod +x .husky/pre-commit",
      "git config core.hooksPath .husky",
      "git add -A",
      "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' " +
        "git -c core.hooksPath=/dev/null commit -q --amend --no-edit",
    ].join(" && "),
  );
  expect(result.exitCode, `hook install failed: ${result.stdout}${result.stderr}`).toBe(0);
}

/** A git repo that declares no setup and installs no hook. */
async function seedPlainRepo(): Promise<void> {
  await seedRepo({ "README.md": "# plain\n" });
}

async function seedRepo(files: Readonly<Record<string, string>>): Promise<void> {
  const scope = miseRunScope(WORKSPACE);
  const writes = Object.entries(files).flatMap(([path, contents]) => [
    `mkdir -p "$(dirname ${shellQuote(path)})"`,
    // The closing delimiter MUST start its own line, or a `contents` without a trailing
    // newline leaves the heredoc unterminated and silently swallows the rest of the script.
    `cat > ${shellQuote(path)} <<'TANREN_FIXTURE_EOF'\n${endWithNewline(contents)}TANREN_FIXTURE_EOF`,
  ]);
  const result = await run(
    [
      "set -eu",
      `rm -rf ${shellQuote(RUN_DIR)}`,
      `mkdir -p ${shellQuote(WORKSPACE)}`,
      `cd ${shellQuote(WORKSPACE)}`,
      `rm -f "${scope.configFile}" "${scope.markerFile}" "${SETUP_MARKER}" "${SETUP_COUNTER}"`,
      `rm -rf "${BIN_DIR}"`,
      ...writes,
      "git init -q -b main",
      "git config user.name 'Tanren Proof'",
      "git config user.email 'proof@tanren.invalid'",
      // The baseline commit predates any hook wiring, so seeding never depends on the very
      // behaviour under test.
      "git add -A",
      "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' git commit -q -m baseline",
    ].join("\n"),
  );
  expect(result.exitCode, `workspace seed failed: ${result.stdout}${result.stderr}`).toBe(0);
}

async function run(command: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await ssh.run(target, { command });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function writeWorkspaceFile(path: string, contents: string): Promise<void> {
  const result = await ssh.run(target, {
    cwd: WORKSPACE,
    command: `cat > ${shellQuote(path)} <<'TANREN_FIXTURE_EOF'\n${endWithNewline(contents)}TANREN_FIXTURE_EOF`,
  });
  expect(result.exitCode, `workspace write failed: ${result.stdout}${result.stderr}`).toBe(0);
}

function endWithNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

/** A workspace file's trimmed contents, or `""` when it does not exist. */
async function readWorkspaceFile(path: string): Promise<string> {
  const result = await ssh.run(target, { cwd: WORKSPACE, command: `cat ${shellQuote(path)} 2>/dev/null || true` });
  return result.stdout.trim();
}

/** An absolute runner path's trimmed contents, or `""` when it does not exist. */
async function readFileOnRunner(path: string): Promise<string> {
  return (await run(`cat "${path}" 2>/dev/null || true`)).stdout.trim();
}

/** Whether an absolute runner path EXISTS. The setup latch is an EMPTY file (`: > marker`),
 * so `cat` cannot tell "present" from "absent" — only a `[ -f ]` can. */
async function existsOnRunner(path: string): Promise<boolean> {
  return (await run(`[ -f "${path}" ] && echo yes || echo no`)).stdout.trim() === "yes";
}

async function headSha(): Promise<string> {
  const result = await ssh.run(target, { cwd: WORKSPACE, command: "git rev-parse HEAD" });
  const sha = result.stdout.trim();
  expect(sha, `could not read HEAD: ${result.stdout}${result.stderr}`).toMatch(/^[0-9a-f]{40}$/u);
  return sha;
}

async function countCommits(): Promise<number> {
  const result = await ssh.run(target, { cwd: WORKSPACE, command: "git rev-list --count HEAD" });
  return Number(result.stdout.trim());
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set for the container proof`);
  }
  return value;
}

function parseHostKeyAlgorithms(value: string | undefined): ServerHostKeyAlgorithm[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) as ServerHostKeyAlgorithm[];
}
