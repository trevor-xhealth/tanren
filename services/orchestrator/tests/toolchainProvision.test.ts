// LAYER-2 PROVISIONING + the infrastructure-fault boundary.
//
// These pin the two halves of the change, at the seam:
//   (1) a repo declaring its toolchain the standard way — `packageManager`, `.nvmrc`, a
//       lockfile — now gets a provision command that installs AND VERIFIES its binaries,
//       where before it got a skip notice because it shipped no `mise.toml`;
//   (2) the exit-127 `command not found` that used to follow is classified as
//       INFRASTRUCTURE, so it halts legibly instead of dispatching a remediation writer
//       at a loop no source edit can win.
//
// This file asserts command STRINGS, which is exactly as far as a unit test can see. What
// those strings DO on a real runner is a separate proof:
// `services/orchestrator/tests/toolchainContainer.integration.test.ts`, driven by
// `just smoke-toolchain-container`, which `just smoke` (ci-heavy step 2) depends on. It is
// WIRED, not hand-run — a container proof nothing executes is a claim, not a proof.

import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import {
  MISE_LOCK_SLICE_SECONDS,
  MISE_LOCK_WAIT_SECONDS,
  MISE_SHARED_LOCK_FILE,
  miseRunScope,
  miseSharedDirPrelude,
  withMiseActivation,
} from "../src/engine/ssh/miseActivate.js";
import { detectToolchainRequirements } from "../src/engine/workspace/toolchainDeclarations.js";
import { WorkspaceToolchainUnhonoredError } from "../src/engine/workspace/toolchainEnforcement.js";
import {
  classifyToolchainFault,
  NO_DECLARATION_NOTICE,
  provisionMiseToolchain,
  toolchainProvisionCommand,
  TOOLCHAIN_VERIFIED_NOTICE,
  WorkspaceMiseProvisionError,
  WorkspaceToolchainUnavailableError,
} from "../src/engine/workspace/toolchainProvision.js";

const target: RunnerHandle = { id: "r1", host: "h", port: 22, user: "tanren" } as unknown as RunnerHandle;
const workspacePath = "/ws/run/repo";

// A fixed stand-in for the per-read nonce. In production it is fresh random bytes; here it
// is pinned so the framed fixtures stay readable. What matters is that the PARSER requires
// it, which is what stops repository content from forging a declaration frame.
// The nonce a REAL read command was built with. Tests that drive `provisionMiseToolchain`
// end-to-end cannot pre-frame their fixture: the nonce is minted per read, on purpose, so a
// substrate answering that read has to echo the one it was asked with — exactly as the
// runner does.
function frameFor(readCommand: string, path: string): string {
  const nonce = /'===TANREN-TOOLCHAIN-DECLARATION:' '([0-9a-f]+)'/u.exec(readCommand)?.[1];
  if (nonce === undefined) throw new Error(`no declaration nonce in: ${readCommand}`);
  return `===TANREN-TOOLCHAIN-DECLARATION:${nonce}:${path}===\n`;
}

// Two concurrent runs on ONE static runner container, as the SAME unix user.
const RUN_A = "/workspace/runs/run_alpha/repo";
const RUN_B = "/workspace/runs/run_bravo/repo";

// A mainstream polyglot declaration set: a corepack `packageManager` field plus a Python
// lockfile, and no `mise.toml` anywhere. This is the shape Tanren used to read as
// "declared no toolchain".
const MAINSTREAM_DECLARATIONS = [
  { path: "package.json", contents: '{"packageManager":"pnpm@11.19.0"}' },
  { path: "uv.lock", contents: "" },
];

describe("toolchainProvisionCommand · installs AND proves the binaries are there", () => {
  it("provisions a standard-declaration repo that ships no mise.toml", () => {
    const command = toolchainProvisionCommand(detectToolchainRequirements(MAINSTREAM_DECLARATIONS), RUN_A);
    // BEFORE this change the same repo produced only the skip notice and nothing else.
    expect(command).not.toContain("skipping mise install");
    // `--global`: the runner user's mise config, never a file written into the repo.
    expect(command).toContain("mise use --global 'pnpm@11.19.0' 'uv@latest'");
    expect(command).not.toContain("mise.toml");
    // VERIFICATION — the part that did not exist. Each declared binary must resolve…
    expect(command).toContain("command -v 'pnpm'");
    expect(command).toContain("command -v 'uv'");
    // …must BE the binary Tanren provisioned (not an image-baked copy earlier on PATH)…
    expect(command).toContain("mise which 'pnpm'");
    // …and must have a concrete resolved version, which is reported out of the run.
    expect(command).toContain("mise current 'pnpm'");
    expect(command).toContain("===TANREN-TOOLCHAIN-IN-EFFECT:");
    // …and the failure names the tool AND the file that declared it.
    expect(command).toContain("package.json declares pnpm@11.19.0");
    expect(command).toContain("uv.lock declares uv@latest");
    // The success notice is emitted only after every verification has passed.
    expect(command.indexOf("command -v 'uv'")).toBeLessThan(command.indexOf(TOOLCHAIN_VERIFIED_NOTICE));
  });

  it("says out loud when a tool's version was left unconstrained", () => {
    const command = toolchainProvisionCommand(detectToolchainRequirements(MAINSTREAM_DECLARATIONS), RUN_A);
    expect(command).toContain("uv@latest (declared in uv.lock, version unconstrained)");
  });

  it("defers to a repo's own mise.toml unchanged", () => {
    const command = toolchainProvisionCommand(
      detectToolchainRequirements([{ path: "mise.toml", contents: '[tools]\nnode="22"\n' }]),
      RUN_A,
    );
    expect(command).toContain("mise trust 'mise.toml'");
    expect(command).toContain("mise install");
    expect(command).not.toContain("mise use --global");
  });

  it("states the no-op rather than fabricating success", () => {
    const command = toolchainProvisionCommand(detectToolchainRequirements([]), RUN_A);
    expect(command).toContain(NO_DECLARATION_NOTICE);
    expect(command).not.toContain("mise use --global");
    expect(command).not.toContain(TOOLCHAIN_VERIFIED_NOTICE);
  });

  it("announces a declaration it read but could not RESOLVE to any tool", () => {
    // This is the kind that stays a notice: Tanren identified no provisionable tool, so
    // there is no version it could be running wrongly. (The `untranslatable-version`
    // kind never reaches this command at all — see the enforcement suite below.)
    const command = toolchainProvisionCommand(
      detectToolchainRequirements([{ path: "package.json", contents: "{ not json" }]),
      RUN_A,
    );
    expect(command).toContain("toolchain declaration NOT honored - package.json");
  });

  it("checks a DECLARED version for satisfaction, and leaves an unconstrained one alone", () => {
    const command = toolchainProvisionCommand(
      detectToolchainRequirements([
        { path: ".nvmrc", contents: "24\n" },
        { path: "uv.lock", contents: "" },
      ]),
      RUN_A,
    );
    // The component-wise-prefix policy, as two literal shell patterns: `24` is satisfied
    // by `24` itself or by anything under `24.` — never by `241.x`.
    expect(command).toContain(`case "$__tanren_version" in '24'|'24.'*) : ;;`);
    // A lockfile constrained no version, so there is nothing to satisfy — and Tanren does
    // not invent one to check against.
    expect(command).not.toContain(`in 'latest'|'latest.'*`);
  });
  // REGRESSION, and the reason this assertion exists at all. The detected-toolchain
  // provision is a THIRD mise seam beside the two that already source the image's
  // published shared data dir (the activation prelude, and the repo-owns-a-mise.toml
  // provision). If it does not source the same script, `mise use --global` installs into
  // mise's `$HOME` default while the later activation reads the image's shared dir — and
  // the divergence is invisible from inside this command, because its own verification
  // runs in the same shell as the install and therefore passes. The run then dies at the
  // project's bootstrap on the exact `pnpm: not found` this whole path exists to remove.
  it("sources the SAME shared-dir script the other two mise seams do, before mise runs", () => {
    const prelude = miseSharedDirPrelude();
    const detected = toolchainProvisionCommand(detectToolchainRequirements(MAINSTREAM_DECLARATIONS), RUN_A);
    expect(detected).toContain(prelude);
    expect(detected.indexOf("tanren-mise-shared-dir.sh")).toBeLessThan(detected.indexOf("mise use --global"));
    // The other two seams are asserted here too, so a change to either side of the
    // agreement fails a test that names the agreement rather than one that names a string.
    expect(withMiseActivation("just bootstrap", RUN_A)).toContain(prelude);
    expect(
      toolchainProvisionCommand(
        detectToolchainRequirements([{ path: "mise.toml", contents: '[tools]\nnode="22"\n' }]),
        RUN_A,
      ),
    ).toContain(prelude);
    // Never an invented path: the engine hard-codes no mise dir, it sources the script
    // the runner image itself wrote, so a host that publishes none keeps mise's defaults.
    expect(detected).not.toContain("MISE_DATA_DIR=");
  });

  it("emits no shared-dir sourcing when there is nothing to provision", () => {
    // The no-op path stays a stated no-op — it makes no mise call, so there is nothing
    // to point at a data dir.
    expect(toolchainProvisionCommand(detectToolchainRequirements([]), RUN_A)).not.toContain(
      "tanren-mise-shared-dir.sh",
    );
  });
});

// CONCURRENT RUNS, ONE RUNNER. A runner is a single long-lived container that every run
// on it shares as the SAME unix user (StaticRunnerAllocator, `fixed_pool`, worker
// concurrency 3 by default). Provisioning a toolchain into it introduces shared mutable
// state that did not exist before this change, and two runs provisioning at once produced,
// live:
//
//   mise WARN tracking config: failed to ln -sf
//     /home/tanren/.config/mise/config.toml … File exists
//   failed to ln -sf ./10.32.1 …/installs/pnpm/latest
//
// One run won, one lost. Three distinct bugs sit behind that — a WRITE race on the shared
// installs tree, SEMANTIC clobbering of one shared global config, and a run-agnostic
// marker — and these pin the fix for each. It is our own defect, created by this change,
// so it is fixed in the same change rather than left for a follow-up.
describe("toolchainProvisionCommand · concurrent runs on one runner do not share mise state", () => {
  const provision = (runPath: string): string =>
    toolchainProvisionCommand(detectToolchainRequirements(MAINSTREAM_DECLARATIONS), runPath);

  it("pins a PER-RUN MISE_GLOBAL_CONFIG_FILE, so run A never verifies against run B's config", () => {
    const a = provision(RUN_A);
    const b = provision(RUN_B);
    // BUG 2. `mise use --global` writes this file and the activation reads it back. One
    // shared file means last-writer-wins: A asks for pnpm@10, B asks for pnpm@11, and A
    // then bootstraps under B's answer. Serialising the writes does NOT fix this — the
    // config outlives the lock window.
    expect(a).toContain(`MISE_GLOBAL_CONFIG_FILE="${miseRunScope(RUN_A).configFile}"`);
    expect(b).toContain(`MISE_GLOBAL_CONFIG_FILE="${miseRunScope(RUN_B).configFile}"`);
    expect(a).not.toContain("run_bravo");
    expect(b).not.toContain("run_alpha");
    // Exported BEFORE the first mise invocation, so every mise call in the chain —
    // install, activate, verify — agrees on one config.
    expect(a.indexOf("MISE_GLOBAL_CONFIG_FILE=")).toBeLessThan(a.indexOf("mise use --global"));
    expect(a.indexOf("MISE_GLOBAL_CONFIG_FILE=")).toBeLessThan(a.indexOf("command -v 'pnpm'"));
  });

  it("keeps the per-run files OUT of the repository, in the run sandbox", () => {
    // The rule this change must not break: Tanren never materializes a file into a
    // repository it did not author. Per-run state lives in the RUN dir, which teardown
    // reclaims with the sandbox. A workspace path outside that shape (the
    // `rawInput.workspacePath` seam, fixtures) falls back to a deterministic per-workspace
    // name in the runner user's home rather than throwing.
    expect(miseRunScope(RUN_A).configFile).toBe("/workspace/runs/run_alpha/tanren-mise-config.toml");
    expect(miseRunScope(RUN_A).markerFile).toBe("/workspace/runs/run_alpha/tanren-mise-provisioned");
    expect(miseRunScope("/elsewhere/repo").configFile.startsWith("$HOME/.tanren-mise-")).toBe(true);
    expect(miseRunScope("/elsewhere/repo").configFile).not.toBe(miseRunScope("/other/repo").configFile);
  });

  it("writes a PER-RUN provisioned marker, so run B never activates on run A's success", () => {
    // BUG 3. The marker is `withMiseActivation`'s second trigger. Shared, run A's
    // verified provision sends run B down the `mise env -s bash` branch having
    // provisioned nothing at all.
    expect(provision(RUN_A)).toContain(`: > "${miseRunScope(RUN_A).markerFile}"`);
    expect(provision(RUN_B)).toContain(`: > "${miseRunScope(RUN_B).markerFile}"`);
    expect(miseRunScope(RUN_A).markerFile).not.toBe(miseRunScope(RUN_B).markerFile);
  });

  it("holds the SHARED flock across `mise use --global`, and both runs wait on the SAME file", () => {
    const a = provision(RUN_A);
    // BUG 1, the observed `ln -sf … File exists`. The mise DATA dir stays SHARED on
    // purpose — the runner image bakes a warm baseline into it, and a per-run data dir
    // would cold-download the whole toolchain every run — so the writes to it are
    // serialised instead. `9>` scopes the held fd to the brace group.
    expect(a).toContain(`flock -w ${String(MISE_LOCK_SLICE_SECONDS)} 9`);
    expect(a).toContain(`9>"${MISE_SHARED_LOCK_FILE}"`);
    expect(a.indexOf("flock")).toBeLessThan(a.indexOf("mise use --global"));
    expect(a.indexOf("mise use --global")).toBeLessThan(a.indexOf(`9>"${MISE_SHARED_LOCK_FILE}"`));
    // The lock is the one thing that must NOT be per-run: a per-run lock excludes nobody.
    expect(provision(RUN_B)).toContain(`9>"${MISE_SHARED_LOCK_FILE}"`);
    expect(MISE_SHARED_LOCK_FILE).toBe("$HOME/.tanren-mise.lock");
    // The critical section is the INSTALL only. Verification reads this run's own config,
    // which no other run can write, so holding the lock across it would serialise runs
    // for no benefit.
    expect(a.indexOf(`9>"${MISE_SHARED_LOCK_FILE}"`)).toBeLessThan(a.indexOf("command -v 'pnpm'"));
  });

  it("FAILS LOUD when the shared lock cannot be taken, rather than writing unsynchronised", () => {
    const a = provision(RUN_A);
    // No silent fallback: a timed-out (or missing) flock exits nonzero with a message
    // naming the lock and the wait, instead of racing the shared installs tree anyway.
    expect(a).toContain("could not take the shared mise lock");
    expect(a).toContain(`within ${String(MISE_LOCK_WAIT_SECONDS)}s`);
    expect(a).toContain(`[ "$__tanren_mise_waited" -lt ${String(MISE_LOCK_WAIT_SECONDS)} ]`);
    expect(a).toContain("exit 1");
    // BOUNDED, not indefinite — `flock` is given `-w`, never left to block forever.
    expect(a).not.toContain("flock 9");
    // THE SECOND WAY TO NOT HOLD IT, and the one `set -e` does not catch: a failed `9>`
    // redirection is not a fatal error in bash or dash — the shell skips the whole brace
    // group and continues with status 0, so the install would be SILENTLY skipped. The
    // sentinel is set inside the group and checked after it.
    expect(a).toContain("__tanren_mise_lock=0");
    expect(a).toContain("__tanren_mise_lock=1; break;");
    expect(a).toContain('[ "$__tanren_mise_lock" = 1 ] ||');
    expect(a).toContain("could not OPEN the shared mise lock");
    expect(a.indexOf(`9>"${MISE_SHARED_LOCK_FILE}"`)).toBeLessThan(a.indexOf('[ "$__tanren_mise_lock" = 1 ]'));
  });

  it("trusts its own per-run config, so mise actually loads it (the golden image does the same)", () => {
    const a = provision(RUN_A);
    // An off-default global config is subject to mise's config-trust gate; the runner
    // image trusts its own (`mise trust /opt/tanren/mise.baseline.toml`, runner/
    // Dockerfile). Untrusted, the per-run config would be ignored and the isolation
    // would silently collapse back onto the shared default.
    expect(a).toContain(`mise trust "${miseRunScope(RUN_A).configFile}"`);
    expect(a.indexOf("mise trust")).toBeLessThan(a.indexOf("mise use --global"));
    // …and the trust happens under the lock, with the rest of the shared-store writes.
    expect(a.indexOf("flock")).toBeLessThan(a.indexOf("mise trust"));
  });

  it("NEGATIVE CONTROL · a runner-wide marker or config appears nowhere", () => {
    // The unisolated shapes, spelled out literally so a re-introduction cannot pass.
    // Checked across every built command, including the repo-ships-its-own-mise.toml
    // branch, which writes the shared installs tree too and so needs the same lock.
    const commands = [
      provision(RUN_A),
      provision(RUN_B),
      toolchainProvisionCommand(detectToolchainRequirements([]), RUN_A),
      toolchainProvisionCommand(
        detectToolchainRequirements([{ path: "mise.toml", contents: '[tools]\nnode="22"\n' }]),
        RUN_A,
      ),
    ];
    for (const command of commands) {
      expect(command).not.toContain("$HOME/.tanren-toolchain-provisioned");
      expect(command).not.toContain(".tanren-toolchain-provisioned");
      expect(command).not.toContain("/home/tanren/.config/mise/config.toml");
      // A bare `export MISE_YES=1` with no config pin is the unisolated shape.
      expect(command).not.toContain("export MISE_YES=1;");
    }
  });
});

describe("withMiseActivation · the provisioned toolchain reaches the project's shell", () => {
  it("activates on the Tanren-provisioned marker as well as on a repo mise.toml", () => {
    const wrapped = withMiseActivation("just bootstrap", RUN_A);
    expect(wrapped).toContain("[ -f 'mise.toml' ]");
    expect(wrapped).toContain(`[ -f "${miseRunScope(RUN_A).markerFile}" ]`);
    // The mise.toml branch keeps mise's own shim activation, byte for byte as before.
    expect(wrapped).toContain('eval "$(mise activate bash --shims)"');
    // The detected-toolchain branch uses `mise env`, which puts ONLY the resolved tools
    // on PATH. Using the shims dir here would shadow every other tool in the runner's
    // shared mise store with a version-less shim — measured on the golden image, a repo
    // declaring only pnpm loses its working `go` to `No version is set for shim: go`.
    expect(wrapped).toContain('eval "$(mise env -s bash)"');
    // BOTH branches carry the whole preamble, not just the mise.toml one: the detected-
    // toolchain branch reads back what the provision wrote, so if the two disagree on the
    // data dir or on the config file, the marker is present, the activation resolves
    // nothing, and `pnpm` is gone again.
    const preamble = `${miseSharedDirPrelude()}export MISE_YES=1 MISE_GLOBAL_CONFIG_FILE="${miseRunScope(RUN_A).configFile}"`;
    expect(wrapped).toContain(`${preamble}; eval "$(mise activate bash --shims)"`);
    expect(wrapped).toContain(`${preamble}; eval "$(mise env -s bash)"`);
    // Still a skip, not a gate: with neither trigger the command runs unchanged.
    expect(wrapped).toContain("fi; just bootstrap");
    expect(wrapped).not.toContain("fi && just bootstrap");
  });
});

describe("classifyToolchainFault · a missing binary is INFRA, not a writer finding", () => {
  const detection = detectToolchainRequirements([]);
  const fault = (outputTail: string, d = detection): WorkspaceToolchainUnavailableError | undefined =>
    classifyToolchainFault({ workspacePath, command: "just bootstrap", exitCode: 127, outputTail, detection: d });

  it.each([
    ["sh: 1: pnpm: not found", "pnpm"],
    ["bash: line 1: uv: command not found", "uv"],
    ["/bin/sh: cargo: not found", "cargo"],
  ])("claims %s as infrastructure", (outputTail, binary) => {
    const classified = fault(outputTail);
    expect(classified).toBeInstanceOf(WorkspaceToolchainUnavailableError);
    expect(classified?.missingBinary).toBe(binary);
    // The message must tell the operator what to DO, not just that something broke.
    expect(classified?.message).toContain("INFRASTRUCTURE fault");
    expect(classified?.message).toContain("no code change installs a binary");
    expect(classified?.message).toContain("package.json");
  });

  it("does NOT claim a missing project program — that stays writer-fixable", () => {
    // A missing `vitest` means the writer's own dependency declaration is wrong, which
    // is exactly the loop the writer CAN win. Stealing it would be a regression.
    for (const outputTail of ["sh: 1: vitest: not found", "bash: line 1: tsc: command not found"]) {
      expect(fault(outputTail)).toBeUndefined();
    }
  });

  it("does NOT claim a failure that named no missing binary", () => {
    expect(fault("ERR_PNPM_LOCKFILE_BREAKING_CHANGE: lockfile not compatible")).toBeUndefined();
  });

  it("claims a tool the repo DID declare but Tanren could not honor", () => {
    const declared = detectToolchainRequirements([
      { path: "package.json", contents: '{"packageManager":"frobpm@3.2.1"}' },
    ]);
    const classified = fault("sh: 1: frobpm: not found", declared);
    expect(classified).toBeInstanceOf(WorkspaceToolchainUnavailableError);
    expect(classified?.message).toContain("WAS declared");
    expect(classified?.message).toContain('declares tool "frobpm"');
  });
});

const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", exitCode: 0 }) as CommandResult;
const fail = (stderr: string): CommandResult => ({ stdout: "", stderr, exitCode: 3 }) as CommandResult;

// A scripted substrate: returns one prepared result per round-trip, in order, and
// records the commands so the two-round-trip shape (read, then provision) is assertable.
class ScriptedSsh implements CommandSubstrate {
  readonly commands: string[] = [];
  constructor(private readonly results: CommandResult[]) {}
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command.command);
    return this.results[this.commands.length - 1] ?? ok("");
  }
}

/** A substrate that ANSWERS the declaration read the way a runner does — echoing frames
 * built from the nonce it was actually asked with — then succeeds at the provision. */
class AnsweringSsh implements CommandSubstrate {
  readonly commands: string[] = [];
  constructor(
    private readonly declarations: (readCommand: string) => string,
    private readonly provisionResult: CommandResult = ok(""),
  ) {}
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command.command);
    return this.commands.length === 1 ? ok(this.declarations(command.command)) : this.provisionResult;
  }
}

describe("provisionMiseToolchain · a substrate failure is never read as no-toolchain", () => {
  it("throws when the declaration READ fails, rather than concluding the repo declares nothing", async () => {
    // The exact shape of the original defect, one layer up: a failed read must never be
    // mistaken for "no declarations" — that is how a skip becomes an exit 127.
    const ssh = new ScriptedSsh([fail("connection reset")]);
    await expect(provisionMiseToolchain({ ssh, target, workspacePath })).rejects.toBeInstanceOf(
      WorkspaceMiseProvisionError,
    );
  });

  it("reads, then provisions, and returns what it detected", async () => {
    const ssh = new AnsweringSsh((read) => frameFor(read, "package.json") + '{"packageManager":"pnpm@11.19.0"}\n');
    const outcome = await provisionMiseToolchain({ ssh, target, workspacePath });
    expect(outcome.detection.requirements.map((r) => r.bin)).toEqual(["pnpm"]);
    // EXACTLY two round-trips — read, then provision. The scripted substrate answers a
    // bare success past the end of its script, so without this an added third call would
    // pass every other assertion in this test silently.
    expect(ssh.commands).toHaveLength(2);
    expect(ssh.commands[1]).toContain("set -e; ");
    expect(ssh.commands[1]).toContain("mise use --global 'pnpm@11.19.0'");
  });

  it("HALTS before provisioning anything when a declared version cannot be honored", async () => {
    // The whole point: the second round-trip never happens. Tanren does not run a
    // provision, print a notice and then let the project build on an undeclared version.
    const ssh = new AnsweringSsh((read) => `${frameFor(read, ".nvmrc")}lts/iron\n`);
    await expect(provisionMiseToolchain({ ssh, target, workspacePath })).rejects.toBeInstanceOf(
      WorkspaceToolchainUnhonoredError,
    );
    expect(ssh.commands).toHaveLength(1);
  });

  it("carries the versions that were actually in effect back out of the provision", async () => {
    const ssh = new AnsweringSsh(
      (read) => `${frameFor(read, ".nvmrc")}24\n`,
      ok("===TANREN-TOOLCHAIN-IN-EFFECT:node|24|24.18.1|.nvmrc|pinned===\n"),
    );
    const outcome = await provisionMiseToolchain({ ssh, target, workspacePath });
    expect(outcome.resolutions).toEqual([
      { tool: "node", declared: "24", resolved: "24.18.1", declaredIn: ".nvmrc", versionDeclared: true },
    ]);
  });

  it("throws when the provision itself fails — a LOUD halt, never a silent skip", async () => {
    const ssh = new ScriptedSsh([ok(""), fail("mise: no such tool")]);
    await expect(provisionMiseToolchain({ ssh, target, workspacePath })).rejects.toBeInstanceOf(
      WorkspaceMiseProvisionError,
    );
  });
});
