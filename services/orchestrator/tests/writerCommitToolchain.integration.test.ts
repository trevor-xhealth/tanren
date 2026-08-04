// THE CONTAINER PROOF for the writer commit's toolchain — a REAL runner container, over
// the REAL `SshCommandSubstrate`, with the REAL `mise` on the golden image and a REAL
// husky-shaped pre-commit hook that shells out to `pnpm`.
//
// The sibling `writerCommitProjectHooks.test.ts` pins the command STRINGS. Only this file
// can show what those strings DO on a runner, and that is precisely where the defect
// lived: every string was correct, the toolchain WAS installed, and the writer's commit
// still died with `pnpm not found` because the provisioned toolchain was never on PATH
// for the commit's subprocess. A string test cannot see PATH.
//
// WIRED, NOT HAND-RUN — `just smoke-toolchain-container` drives it alongside the
// toolchain-enforcement proof, against the runner container `just smoke` already stands
// up, so it costs one SSH session and no image build.
//
// THE THREE CASES:
//   1. NEGATIVE CONTROL — the pre-fix command shape, on a workspace whose toolchain IS
//      provisioned, still fails with the exact production error. This is what proves the
//      case below is not passing for some incidental reason.
//   2. THE FIX — the real `captureGitStateAfterCodex` commits successfully AND the hook
//      RAN, evidenced by a file only the hook writes, recording the pnpm version it
//      resolved. A hook that runs and passes is evidence; a skipped hook is not.
//   3. UNAFFECTED — a repo that declares no toolchain and has no hook commits exactly as
//      it always did, so the activation is proven to be a guarded skip on a real shell.
//
// FIXTURE-NEUTRAL: the repo here declares its toolchain the ordinary way (a `mise.toml`,
// the one declaration form Tanren provisions from) and its hook is the stock husky shape.
// Nothing about it is specific to any repo Tanren happens to be run against, and the pnpm
// MAJOR is read off the runner's own warm baseline rather than written here — so the
// fixture pins no version this repo or that image happens to carry.

import { readFile } from "node:fs/promises";
import type { ServerHostKeyAlgorithm } from "ssh2";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { captureGitStateAfterCodex } from "../src/engine/providers/codexGit.js";
import { SshCommandSubstrate } from "../src/engine/ssh/index.js";
import { provisionMiseToolchain } from "../src/engine/workspace/index.js";

// A REAL toolchain install over the network, same budget the sibling container proof
// uses. This bounds VITEST's patience, not the runner's work.
vi.setConfig({ testTimeout: 600_000, hookTimeout: 60_000 });

const runContainer = process.env.TANREN_WRITER_COMMIT_CONTAINER === "1";
const describeContainer = runContainer ? describe : describe.skip;

// The PRODUCTION workspace shape — `/workspace/runs/<runId>/repo`.
const RUN_DIR = "/workspace/runs/run_writer_hook_proof";
const WORKSPACE = `${RUN_DIR}/repo`;
const HOOK_EVIDENCE = "hook-ran.txt";

// The stock husky pre-commit shape: it shells out to the project's package manager. This
// hook is CORRECT — a project is entitled to expect its own toolchain — which is why the
// fix satisfies it rather than bypassing it. It records the pnpm version it resolved, so
// the evidence proves not just that the hook ran but that it ran under a real toolchain.
const PRE_COMMIT_HOOK = [
  "#!/bin/sh",
  "if ! command -v pnpm > /dev/null 2>&1; then",
  '  echo "❌ pnpm not found. Please ensure pnpm is installed and in your PATH." >&2',
  "  exit 1",
  "fi",
  `printf 'ran-under-pnpm-%s\\n' "$(pnpm --version)" > ${HOOK_EVIDENCE}`,
].join("\n");

let ssh: CommandSubstrate;
let target: RunnerHandle;

describeContainer("the writer's commit runs the project's hooks WITH the project's toolchain · real runner", () => {
  beforeAll(async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({
      ref: "runner/writer-hook/identity",
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
      identitySecretRef: "runner/writer-hook/identity",
    } as unknown as RunnerHandle;
  });

  it("NEGATIVE CONTROL: the pre-fix commit shape fails with the exact production error", async () => {
    // The toolchain IS provisioned first — so this failure cannot be blamed on a missing
    // install. It is purely that the commit's shell never activated it.
    await seedHookedRepo();
    await provisionMiseToolchain({ ssh, target, workspacePath: WORKSPACE });
    // The install really happened — so the failure below cannot be blamed on it.
    expect(await miseResolvedPnpm()).toMatch(/^\d+\.\d+/u);

    const result = await ssh.run(target, {
      cwd: WORKSPACE,
      // The literal string codexGit.ts emitted before this change.
      command: [
        "set -eu",
        "git add -A",
        "if ! git diff --cached --quiet --exit-code; then",
        "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' git commit -m 'codex writer'",
        "fi",
      ].join("\n"),
    });

    // The production failure, reproduced on the runner that produced it.
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("pnpm not found");
    // The hook did not merely fail — nothing was committed, which is how the bench runs
    // lost several minutes of writer work.
    expect(await readWorkspaceFile(HOOK_EVIDENCE)).toBe("");
    expect(await countCommits()).toBe(1);
  });

  it("commits the writer's work, and the project's hook RAN under the provisioned toolchain", async () => {
    await seedHookedRepo();
    await provisionMiseToolchain({ ssh, target, workspacePath: WORKSPACE });
    const resolved = await miseResolvedPnpm();
    expect(resolved).toMatch(/^\d+\.\d+/u);

    const baselineSha = await headSha();
    await writeWorkspaceFile("src.txt", "the writer's change\n");

    // THE REAL PRODUCTION PATH — the same function the writer loop calls.
    const state = await captureGitStateAfterCodex(ssh, target, WORKSPACE, baselineSha);

    // The writer's work survived the commit step.
    expect(state.commits.map((c) => c.message)).toEqual(["codex writer"]);
    expect(state.diff).toContain("src.txt");
    expect(await countCommits()).toBe(2);
    // …and it survived because the hook was SATISFIED. The evidence file exists only if
    // the hook executed, and it names the pnpm the provision actually resolved — so this
    // is not a hook that was skipped, and not some other pnpm off the image.
    expect(await readWorkspaceFile(HOOK_EVIDENCE)).toBe(`ran-under-pnpm-${resolved}`);
  });

  it("leaves a repo that declares no toolchain committing exactly as before", async () => {
    // The activation is an `if … fi;` guard. With neither a mise.toml nor a provision
    // marker it must be a pure skip on a REAL shell — not a syntax error, not a stall.
    await seedPlainRepo();
    const baselineSha = await headSha();
    await writeWorkspaceFile("src.txt", "the writer's change\n");

    const state = await captureGitStateAfterCodex(ssh, target, WORKSPACE, baselineSha);

    expect(state.commits.map((c) => c.message)).toEqual(["codex writer"]);
    expect(await countCommits()).toBe(2);
  });
});

/** A git repo that declares pnpm the ordinary way and installs a husky-shaped
 * pre-commit hook that needs it. Resets this workspace's mise scope so each case starts
 * from a fresh posture (per-workspace files only — a concurrent run's state is not this
 * fixture's to delete). */
async function seedHookedRepo(): Promise<void> {
  await seedRepo({
    // The ordinary declaration shape, at the MAJOR the runner already warmed.
    "mise.toml": `[tools]\npnpm = "${await runnerBaselinePnpmMajor()}"\n`,
    ".husky/pre-commit": PRE_COMMIT_HOOK,
  });
  const result = await ssh.run(target, {
    cwd: WORKSPACE,
    command: ["set -eu", "chmod +x .husky/pre-commit", "git config core.hooksPath .husky"].join(" && "),
  });
  expect(result.exitCode, `hook install failed: ${result.stdout}${result.stderr}`).toBe(0);
}

/** A git repo that declares no toolchain and installs no hook. */
async function seedPlainRepo(): Promise<void> {
  await seedRepo({ "README.md": "# plain\n" });
}

async function seedRepo(files: Readonly<Record<string, string>>): Promise<void> {
  const writes = Object.entries(files).flatMap(([path, contents]) => [
    `mkdir -p "$(dirname ${shellQuote(path)})"`,
    // The closing delimiter MUST start its own line: a `contents` without a trailing
    // newline would otherwise glue it to the last line, leaving the heredoc unterminated
    // and silently swallowing the rest of the seed script (git init included) at exit 0.
    `cat > ${shellQuote(path)} <<'TANREN_FIXTURE_EOF'\n${endWithNewline(contents)}TANREN_FIXTURE_EOF`,
  ]);
  const result = await ssh.run(target, {
    command: [
      "set -eu",
      `rm -rf ${shellQuote(RUN_DIR)}`,
      `mkdir -p ${shellQuote(WORKSPACE)}`,
      `cd ${shellQuote(WORKSPACE)}`,
      ...writes,
      "git init -q -b main",
      "git config user.name 'Tanren Proof'",
      "git config user.email 'proof@tanren.invalid'",
      // The baseline commit predates any hook wiring, so seeding never depends on the
      // very behaviour under test.
      "git add -A",
      "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' git commit -q -m baseline",
    ].join("\n"),
  });
  expect(result.exitCode, `workspace seed failed: ${result.stdout}${result.stderr}`).toBe(0);
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
  const result = await ssh.run(target, {
    cwd: WORKSPACE,
    command: `cat ${shellQuote(path)} 2>/dev/null || true`,
  });
  return result.stdout.trim();
}

/** The pnpm MAJOR the runner's own warm mise baseline carries, read off the image's
 * published baseline config rather than written into this fixture — so the proof is not
 * pinned to a version this repo (or that image) happens to hold, and the install is a
 * warm cache hit rather than a cold download. */
async function runnerBaselinePnpmMajor(): Promise<string> {
  const result = await ssh.run(target, {
    command: `awk -F'"' '/^pnpm[[:space:]]*=/ { print $2 }' /opt/tanren/mise.baseline.toml`,
  });
  const major = result.stdout.trim();
  expect(major, `the runner publishes no baseline pnpm to read: ${result.stdout}${result.stderr}`).toMatch(/^\d+/u);
  return major;
}

/** The concrete pnpm version mise resolved FOR THIS WORKSPACE — asked of mise itself,
 * inside an activated shell, which is the same authority the hook resolves through. */
async function miseResolvedPnpm(): Promise<string> {
  const result = await ssh.run(target, {
    cwd: WORKSPACE,
    command: 'export MISE_YES=1; eval "$(mise activate bash --shims)"; pnpm --version',
  });
  return result.stdout.trim();
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
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required when TANREN_WRITER_COMMIT_CONTAINER=1`);
  }
  return value;
}

function parseHostKeyAlgorithms(value: string | undefined): ServerHostKeyAlgorithm[] | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "") as ServerHostKeyAlgorithm[] | undefined;
}
