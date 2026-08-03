// THE CONTAINER PROOF for toolchain enforcement — a REAL runner container, over the
// REAL `SshCommandSubstrate`, with the REAL `mise` on the golden image. The sibling
// `toolchainProvision.test.ts` pins the command STRINGS; only this file can show what
// those strings actually DO on a runner, which is where the defect lived: the strings
// were fine, the exit code was 0, and the repo got gated on a version it never declared.
//
// WIRED, NOT HAND-RUN. `just smoke-toolchain-container` drives this against the compose
// `runner` service, and `just smoke` (ci-heavy step 2) depends on that recipe. It needs
// no image build of its own — the runner container `just smoke` already stands up IS the
// image under test — so it costs one SSH session, not a Dockerfile.
//
// THE THREE CASES, and all three are load-bearing:
//   1. NEGATIVE CONTROL — a repo declaring a version Tanren cannot honor (`.nvmrc:
//      lts/iron`) HALTS, by class, and its bootstrap is proven never to have run. Before
//      this change the same fixture printed a notice, exited 0, and built on the image's
//      harness node.
//   2. The INVERSE — a repo whose declaration IS honorable still provisions, still
//      bootstraps, and reports which concrete version was in effect. An enforcement that
//      halted everything would satisfy (1) alone while making Tanren useless.
//   3. The OTHER inverse — a repo declaring nothing at all is untouched.
//
// IMAGE-AGNOSTIC: case 2 reads the node version the image's warm mise baseline actually
// carries and declares ITS major, so the fixture never encodes a version this repo (or
// that image) happens to pin.

import { readFile } from "node:fs/promises";
import type { ServerHostKeyAlgorithm } from "ssh2";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { miseRunScope } from "../src/engine/ssh/miseActivate.js";
import { SshCommandSubstrate } from "../src/engine/ssh/index.js";
import { ensureWorkspaceDepsInstalled } from "../src/engine/workspace/bootstrap.js";
import { WorkspaceToolchainUnhonoredError } from "../src/engine/workspace/toolchainEnforcement.js";
import { provisionMiseToolchain } from "../src/engine/workspace/toolchainProvision.js";

// Vitest's default per-test budget assumes a pure unit test. The honorable-declaration
// case makes a REAL toolchain install on a REAL runner — a download, over the network, of
// whatever the repo declared — so it is given the same generous budget the other
// real-substrate suites (`*.realjj.test.ts`) use. This bounds VITEST's patience, not the
// runner's work: the substrate itself still runs the command under the progress-based
// activity watchdog with no wall-clock kill.
vi.setConfig({ testTimeout: 600_000, hookTimeout: 60_000 });

const runContainer = process.env.TANREN_TOOLCHAIN_CONTAINER === "1";
const describeContainer = runContainer ? describe : describe.skip;

const WORKSPACE = "/home/tanren/tanren-toolchain-proof";
// The project's own lifecycle: it records the node it ran under. Its ABSENCE is the
// evidence that a halt really stopped the build, not merely logged about it.
const JUSTFILE = ["bootstrap:", '\t@node --version > bootstrap-ran.txt || echo "no-node" > bootstrap-ran.txt'].join(
  "\n",
);

let ssh: CommandSubstrate;
let target: RunnerHandle;

describeContainer("toolchain enforcement · real runner container", () => {
  beforeAll(async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({
      ref: "runner/toolchain/identity",
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
      identitySecretRef: "runner/toolchain/identity",
    } as unknown as RunnerHandle;
  });

  it("HALTS a repo declaring a version it cannot honor — and the bootstrap never runs", async () => {
    // `lts/iron` is a real, widely-used nvm alias. Tanren must not translate it, and the
    // image DOES carry a node, so before this change the run proceeded on that node.
    await seedWorkspace({ ".nvmrc": "lts/iron\n", justfile: JUSTFILE });

    // The workspace-prep provision: a terminal halt, by class.
    const prep = await captureRejection(provisionMiseToolchain({ ssh, target, workspacePath: WORKSPACE }));
    expect(prep).toBeInstanceOf(WorkspaceToolchainUnhonoredError);
    // What the OPERATOR sees: the file, the reason, and why Tanren stopped instead of
    // continuing on whatever was lying around.
    expect(prep?.message).toContain(".nvmrc");
    expect(prep?.message).toContain("lts/iron");
    expect(prep?.message).toContain("will not proceed on an undeclared version");
    expect(prep?.message).toContain("mise.toml");

    // The per-gate path halts identically — the two must not disagree about whether an
    // unhonored declaration is fatal.
    const gate = await captureRejection(ensureWorkspaceDepsInstalled({ ssh, target, workspacePath: WORKSPACE }));
    expect(gate).toBeInstanceOf(WorkspaceToolchainUnhonoredError);

    // THE OBSERVABLE OUTCOME, not a helper's return value: the project's bootstrap left
    // no trace, because it never ran. This is the assertion the pre-change tree fails.
    expect(await readWorkspaceFile("bootstrap-ran.txt")).toBe("");
  });

  it("still provisions and bootstraps a repo whose declaration IS honorable", async () => {
    // The repo declares only a MAJOR — the ordinary `.nvmrc` shape, and the case the
    // component-wise-prefix policy exists for. The major is read off the runner rather
    // than written here so the fixture encodes no version of its own.
    const major = await runnerNodeMajor();
    await seedWorkspace({ ".nvmrc": `${major}\n`, justfile: JUSTFILE });

    const outcome = await provisionMiseToolchain({ ssh, target, workspacePath: WORKSPACE });
    expect(outcome.detection.requirements.map((r) => r.tool)).toEqual(["node"]);
    // WHICH VERSION ACTUALLY RAN, carried out of the provision as a value — a concrete
    // patch the repo never wrote, satisfying the major it did. Reaching this line at all
    // is also the shadow proof: the provision command exits nonzero unless the `node` on
    // PATH is the one mise provisioned.
    expect(outcome.resolutions).toHaveLength(1);
    const resolution = outcome.resolutions[0];
    expect(resolution).toMatchObject({ tool: "node", declared: major, declaredIn: ".nvmrc", versionDeclared: true });
    expect(resolution?.resolved).toMatch(new RegExp(`^${major}\\.\\d`, "u"));

    const result = await ensureWorkspaceDepsInstalled({ ssh, target, workspacePath: WORKSPACE });
    expect(result.installed).toBe(true);
    expect(result.toolchain.map((r) => `${r.tool}@${r.resolved}`)).toEqual([`node@${resolution?.resolved ?? ""}`]);
    // The project's own bootstrap ran, and it ran under the PROVISIONED version.
    expect(await readWorkspaceFile("bootstrap-ran.txt")).toBe(`v${resolution?.resolved ?? ""}`);
  });

  it("leaves a repo that declares no toolchain completely unaffected", async () => {
    await seedWorkspace({ justfile: JUSTFILE });

    const outcome = await provisionMiseToolchain({ ssh, target, workspacePath: WORKSPACE });
    expect(outcome.detection.requirements).toEqual([]);
    expect(outcome.detection.unresolved).toEqual([]);
    expect(outcome.resolutions).toEqual([]);

    const result = await ensureWorkspaceDepsInstalled({ ssh, target, workspacePath: WORKSPACE });
    expect(result.installed).toBe(true);
    expect(result.toolchain).toEqual([]);
    // It bootstrapped on whatever node the image provides — which is correct: the repo
    // asked for nothing, so there is nothing to be wrong about.
    expect(await readWorkspaceFile("bootstrap-ran.txt")).toMatch(/^v\d+\./u);
  });
});

/** Recreate the workspace with exactly these files, and reset THIS workspace's mise scope
 * so each case starts from a fresh posture. The config + marker are per-workspace
 * (`miseRunScope`), so this removes only what this fixture owns — a concurrent run's
 * state is not this fixture's to delete, which is the whole point of that isolation. */
async function seedWorkspace(files: Readonly<Record<string, string>>): Promise<void> {
  const scope = miseRunScope(WORKSPACE);
  const writes = Object.entries(files).map(
    ([path, contents]) => `cat > ${shellQuote(path)} <<'TANREN_FIXTURE_EOF'\n${contents}\nTANREN_FIXTURE_EOF`,
  );
  const result = await ssh.run(target, {
    command: [
      "set -eu",
      `rm -rf ${shellQuote(WORKSPACE)}`,
      `mkdir -p ${shellQuote(WORKSPACE)}`,
      `cd ${shellQuote(WORKSPACE)}`,
      `rm -f "${scope.configFile}" "${scope.markerFile}"`,
      ...writes,
    ].join("\n"),
  });
  expect(result.exitCode, `workspace seed failed: ${result.stdout}${result.stderr}`).toBe(0);
}

/** A workspace file's trimmed contents, or `""` when it does not exist. */
async function readWorkspaceFile(path: string): Promise<string> {
  const result = await ssh.run(target, {
    command: `cat ${shellQuote(path)} 2>/dev/null || true`,
    cwd: WORKSPACE,
  });
  return result.stdout.trim();
}

/** A node MAJOR that certainly exists, read off the runner's own node rather than written
 * into the fixture — so this proof is not pinned to any version this repo or that image
 * happens to carry. */
async function runnerNodeMajor(): Promise<string> {
  const result = await ssh.run(target, { command: "node --version" });
  const major = /^v(\d+)\./u.exec(result.stdout.trim())?.[1] ?? "";
  expect(major, `the runner exposes no node to read a major from: ${result.stdout}${result.stderr}`).not.toBe("");
  return major;
}

async function captureRejection<T>(promise: Promise<T>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error: unknown) {
    return error as Error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required when TANREN_TOOLCHAIN_CONTAINER=1`);
  }
  return value;
}

function parseHostKeyAlgorithms(value: string | undefined): ServerHostKeyAlgorithm[] | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "") as ServerHostKeyAlgorithm[] | undefined;
}
