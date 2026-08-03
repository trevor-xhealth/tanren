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
// container in the change's negative controls — this file is the regression net, the
// container run is the proof.

import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { withMiseActivation } from "../src/engine/ssh/miseActivate.js";
import { detectToolchainRequirements } from "../src/engine/workspace/toolchainDeclarations.js";
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
    // VERIFICATION — the part that did not exist. Each declared binary must resolve.
    expect(command).toContain("command -v 'pnpm' >/dev/null 2>&1 ||");
    expect(command).toContain("command -v 'uv' >/dev/null 2>&1 ||");
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

  it("announces a declaration it read but could not honor", () => {
    const command = toolchainProvisionCommand(
      detectToolchainRequirements([{ path: ".nvmrc", contents: "lts/iron\n" }]),
    );
    expect(command).toContain("toolchain declaration NOT honored - .nvmrc");
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
    const detection = await provisionMiseToolchain({ ssh, target, workspacePath });
    expect(detection.requirements.map((r) => r.bin)).toEqual(["pnpm"]);
    expect(ssh.commands[1]).toContain("set -e; ");
    expect(ssh.commands[1]).toContain("mise use --global 'pnpm@11.19.0'");
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
