// LAYER-2 PROVISIONING + the infrastructure-fault boundary.
//
// These pin the two halves of the live failure, at the seam:
//   (1) a repo declaring its toolchain the standard way now gets a provision command
//       that installs AND VERIFIES its binaries — where before it got a skip notice;
//   (2) the exit-127 `command not found` that followed is classified as INFRASTRUCTURE,
//       so it halts legibly instead of dispatching a remediation writer at a loop no
//       source edit can win.
//
// The command STRINGS asserted here are the same strings driven against a real runner
// container — this file is the regression net, the container run is the proof. That proof
// is `services/orchestrator/tests/toolchainContainer.integration.test.ts`, driven by
// `just smoke-toolchain-container`, which `just smoke` (ci-heavy step 2) depends on. It is
// WIRED, not hand-run: this comment used to claim a proof that nothing executed.

import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { withMiseActivation } from "../src/engine/ssh/miseActivate.js";
import { detectToolchainRequirements } from "../src/engine/workspace/toolchainDeclarations.js";
import {
  classifyUnhonoredDeclarations,
  describeToolchainInEffect,
  parseToolchainResolutions,
  WorkspaceToolchainUnhonoredError,
} from "../src/engine/workspace/toolchainEnforcement.js";
import {
  classifyToolchainFault,
  NO_DECLARATION_NOTICE,
  parseToolchainDeclarationOutput,
  provisionMiseToolchain,
  toolchainDeclarationReadCommand,
  toolchainProvisionCommand,
  TOOLCHAIN_VERIFIED_NOTICE,
  WorkspaceMiseProvisionError,
  WorkspaceToolchainUnavailableError,
} from "../src/engine/workspace/toolchainProvision.js";

const target: RunnerHandle = { id: "r1", host: "h", port: 22, user: "tanren" } as unknown as RunnerHandle;
const workspacePath = "/ws/run/repo";

// The declaration set of the repository the live run could not gate.
const MAINSTREAM_DECLARATIONS = [
  { path: "package.json", contents: '{"packageManager":"pnpm@11.19.0"}' },
  { path: "uv.lock", contents: "" },
];

describe("toolchainDeclarationReadCommand · one bounded round-trip", () => {
  it("probes every declaration path, and round-trips through its own parser", () => {
    const command = toolchainDeclarationReadCommand();
    for (const path of ["mise.toml", "package.json", ".nvmrc", "uv.lock", "go.mod", "rust-toolchain.toml"]) {
      expect(command).toContain(`[ -f '${path}' ]`);
    }
    // Lockfiles are probed for PRESENCE only — never piped back (they can be huge or
    // binary); content paths are read with a byte bound.
    expect(command).not.toContain("head -c 65536 'uv.lock'");
    expect(command).toContain("head -c 65536 'package.json'");
  });

  it("parses framed output back into files, contents intact", () => {
    const stdout =
      "===TANREN-TOOLCHAIN-DECLARATION:uv.lock===\n" +
      "===TANREN-TOOLCHAIN-DECLARATION:package.json===\n" +
      '{"packageManager":"pnpm@11.19.0"}\n';
    const files = parseToolchainDeclarationOutput(stdout);
    expect(files.map((f) => f.path)).toEqual(["uv.lock", "package.json"]);
    expect(detectToolchainRequirements(files).requirements.map((r) => `${r.tool}@${r.spec}`)).toEqual([
      "pnpm@11.19.0",
      "uv@latest",
    ]);
  });
});

describe("toolchainProvisionCommand · installs AND proves the binaries are there", () => {
  it("provisions a standard-declaration repo that ships no mise.toml", () => {
    const command = toolchainProvisionCommand(detectToolchainRequirements(MAINSTREAM_DECLARATIONS));
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
    const command = toolchainProvisionCommand(detectToolchainRequirements(MAINSTREAM_DECLARATIONS));
    expect(command).toContain("uv@latest (declared in uv.lock, version unconstrained)");
  });

  it("defers to a repo's own mise.toml unchanged", () => {
    const command = toolchainProvisionCommand(
      detectToolchainRequirements([{ path: "mise.toml", contents: '[tools]\nnode="22"\n' }]),
    );
    expect(command).toContain("mise trust 'mise.toml'");
    expect(command).toContain("mise install");
    expect(command).not.toContain("mise use --global");
  });

  it("states the no-op rather than fabricating success", () => {
    const command = toolchainProvisionCommand(detectToolchainRequirements([]));
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
    );
    expect(command).toContain("toolchain declaration NOT honored - package.json");
  });

  it("checks a DECLARED version for satisfaction, and leaves an unconstrained one alone", () => {
    const command = toolchainProvisionCommand(
      detectToolchainRequirements([
        { path: ".nvmrc", contents: "24\n" },
        { path: "uv.lock", contents: "" },
      ]),
    );
    // The component-wise-prefix policy, as two literal shell patterns: `24` is satisfied
    // by `24` itself or by anything under `24.` — never by `241.x`.
    expect(command).toContain(`case "$__tanren_version" in '24'|'24.'*) : ;;`);
    // A lockfile constrained no version, so there is nothing to satisfy — and Tanren does
    // not invent one to check against.
    expect(command).not.toContain(`in 'latest'|'latest.'*`);
  });
});

describe("classifyUnhonoredDeclarations · an unhonored VERSION halts; an unreadable file does not", () => {
  it("HALTS on a version alias for a tool Tanren could otherwise have provisioned", () => {
    const detection = detectToolchainRequirements([{ path: ".nvmrc", contents: "lts/iron\n" }]);
    const error = classifyUnhonoredDeclarations(workspacePath, detection);
    expect(error).toBeInstanceOf(WorkspaceToolchainUnhonoredError);
    // What the operator is told: the file, the reason, the consequence, and the fix.
    expect(error?.message).toContain(".nvmrc");
    expect(error?.message).toContain("will not proceed on an undeclared version");
    expect(error?.message).toContain("whatever version of that tool the runner image happens to carry");
    expect(error?.message).toContain("mise.toml");
    // NOT a deps-install error: the writer-routing boundary must not claim it.
    expect(error).not.toBeInstanceOf(WorkspaceMiseProvisionError);
  });

  it("does NOT halt a repo whose declaration it simply could not read", () => {
    // A typo'd package.json mid-run is writer-fixable; halting on it would strand runs.
    for (const contents of ["{ not json", '{"packageManager":"pnpm"}', '{"packageManager":"frobpm@3.2.1"}']) {
      const detection = detectToolchainRequirements([{ path: "package.json", contents }]);
      expect(detection.unresolved.length).toBeGreaterThan(0);
      expect(classifyUnhonoredDeclarations(workspacePath, detection)).toBeUndefined();
    }
  });

  it("does NOT halt an ordinary repo, or one that declares nothing", () => {
    expect(classifyUnhonoredDeclarations(workspacePath, detectToolchainRequirements([]))).toBeUndefined();
    expect(
      classifyUnhonoredDeclarations(workspacePath, detectToolchainRequirements(MAINSTREAM_DECLARATIONS)),
    ).toBeUndefined();
    expect(
      classifyUnhonoredDeclarations(
        workspacePath,
        detectToolchainRequirements([{ path: "mise.toml", contents: '[tools]\nnode="lts/iron"\n' }]),
      ),
    ).toBeUndefined();
  });
});

describe("toolchain resolutions · which version actually ran, as a value", () => {
  it("round-trips the frame the verification emits", () => {
    const stdout = [
      "some unrelated build output",
      "===TANREN-TOOLCHAIN-IN-EFFECT:node|24|24.18.1|.nvmrc|pinned===",
      "===TANREN-TOOLCHAIN-IN-EFFECT:uv|latest|0.9.2|uv.lock|unconstrained===",
    ].join("\n");
    expect(parseToolchainResolutions(stdout)).toEqual([
      { tool: "node", declared: "24", resolved: "24.18.1", declaredIn: ".nvmrc", versionDeclared: true },
      { tool: "uv", declared: "latest", resolved: "0.9.2", declaredIn: "uv.lock", versionDeclared: false },
    ]);
    expect(parseToolchainResolutions("nothing framed here")).toEqual([]);
  });

  it("renders declared-vs-actual for a human", () => {
    expect(
      describeToolchainInEffect(
        parseToolchainResolutions("===TANREN-TOOLCHAIN-IN-EFFECT:node|24|24.18.1|.nvmrc|pinned==="),
      ),
    ).toBe('node 24.18.1 (declared "24" in .nvmrc)');
    expect(describeToolchainInEffect([])).toBe("nothing was provisioned");
  });
});

describe("withMiseActivation · the provisioned toolchain reaches the project's shell", () => {
  it("activates on the Tanren-provisioned marker as well as on a repo mise.toml", () => {
    const wrapped = withMiseActivation("just bootstrap");
    expect(wrapped).toContain("[ -f 'mise.toml' ]");
    expect(wrapped).toContain('[ -f "$HOME/.tanren-toolchain-provisioned" ]');
    // The mise.toml branch keeps mise's own shim activation, byte for byte as before.
    expect(wrapped).toContain('eval "$(mise activate bash --shims)"');
    // The detected-toolchain branch uses `mise env`, which puts ONLY the resolved tools
    // on PATH. Using the shims dir here would shadow every other tool in the runner's
    // shared mise store with a version-less shim — measured on the golden image, a repo
    // declaring only pnpm loses its working `go` to `No version is set for shim: go`.
    expect(wrapped).toContain('eval "$(mise env -s bash)"');
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
    const stdout = '===TANREN-TOOLCHAIN-DECLARATION:package.json===\n{"packageManager":"pnpm@11.19.0"}\n';
    const ssh = new ScriptedSsh([ok(stdout), ok("")]);
    const outcome = await provisionMiseToolchain({ ssh, target, workspacePath });
    expect(outcome.detection.requirements.map((r) => r.bin)).toEqual(["pnpm"]);
    expect(ssh.commands[1]).toContain("set -e; ");
    expect(ssh.commands[1]).toContain("mise use --global 'pnpm@11.19.0'");
  });

  it("HALTS before provisioning anything when a declared version cannot be honored", async () => {
    // The whole point: the second round-trip never happens. Tanren does not run a
    // provision, print a notice and then let the project build on an undeclared version.
    const ssh = new ScriptedSsh([ok("===TANREN-TOOLCHAIN-DECLARATION:.nvmrc===\nlts/iron\n")]);
    await expect(provisionMiseToolchain({ ssh, target, workspacePath })).rejects.toBeInstanceOf(
      WorkspaceToolchainUnhonoredError,
    );
    expect(ssh.commands).toHaveLength(1);
  });

  it("carries the versions that were actually in effect back out of the provision", async () => {
    const ssh = new ScriptedSsh([
      ok("===TANREN-TOOLCHAIN-DECLARATION:.nvmrc===\n24\n"),
      ok("===TANREN-TOOLCHAIN-IN-EFFECT:node|24|24.18.1|.nvmrc|pinned===\n"),
    ]);
    const outcome = await provisionMiseToolchain({ ssh, target, workspacePath });
    expect(outcome.resolutions).toEqual([
      { tool: "node", declared: "24", resolved: "24.18.1", declaredIn: ".nvmrc", versionDeclared: true },
    ]);
  });

  it("throws when the provision itself fails — a LOUD halt, never a silent skip", async () => {
    const ssh = new ScriptedSsh([
      ok('===TANREN-TOOLCHAIN-DECLARATION:package.json===\n{"packageManager":"pnpm@9"}\n'),
      fail("mise: no such tool"),
    ]);
    await expect(provisionMiseToolchain({ ssh, target, workspacePath })).rejects.toBeInstanceOf(
      WorkspaceMiseProvisionError,
    );
  });
});
