// THE `setup` VERB AS A CONTRACT — it is DECLARED, never detected.
//
// Split from `workspaceSetupVerb.test.ts` (which owns the verb's EXECUTION — when it runs,
// the latch, the failure attribution) to stay under the architecture line cap. This file
// owns the other question: what the contract accepts, what absence means, and the design
// decision that Tanren does NOT go looking for a conventional bootstrap script.
//
// THE NEGATIVE CONTROL IS THE POINT. The obvious fix for "the repo's own hook needs
// gitleaks" is to detect and run `scripts/bootstrap.sh` / `script/bootstrap` / `bin/setup` /
// `make setup`. Against the very repository that motivated this verb, detection would have
// executed the exact script whose contract states, in writing, that it must not run — and
// would have died on its first `sudo` on the non-root runner anyway. A convention match is
// not consent. So the last case here asserts that NO conventional path is ever probed for,
// which is a claim about the design, not only the code. `workspace/setup.ts` carries the
// full argument.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { CiConfigV1, DEFAULT_CI_CONFIG, resolveCiConfig, setupCommand } from "../src/engine/ci/index.js";
import { resolveWorkspaceLifecycleCommands } from "../src/engine/workflow/gate/index.js";
import { ensureWorkspaceDepsInstalled } from "../src/engine/workspace/bootstrap.js";
import { ensureWorkspaceSetup } from "../src/engine/workspace/setup.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const WORKSPACE = "/workspace/runs/run_setup/repo";
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

/** Serves the repo's contract and records every command, so the no-detection assertion can
 * inspect everything that was ever sent to the runner. */
class ContractRunnerSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  constructor(private readonly yaml: string = CI_YAML) {}
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    return isCiConfigRead(command) ? { ...ok, stdout: this.yaml } : ok;
  }
}

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

    // THE PROBE ASSERTION HAS TO RUN AGAINST THE WHOLE PREPARATION PATH, not against the
    // resolver. `resolveWorkspaceLifecycleCommands` reads `.tanren/ci.yml` and returns two
    // strings; it has no code path that could ever emit a conventional-script probe, so
    // asserting the absence of one there is structurally guaranteed and would keep passing
    // if a LATER step — `ensureWorkspaceSetup`, `ensureWorkspaceDepsInstalled`, workspace
    // prep — started going looking for files nobody pointed at. That later step is the one
    // the design argument is about, so it is the one driven here.
    const prepared = new ContractRunnerSsh(yaml);
    await ensureWorkspaceSetup({ ssh: prepared, target, workspacePath: WORKSPACE });
    await ensureWorkspaceDepsInstalled({ ssh: prepared, target, workspacePath: WORKSPACE }).catch(() => {
      // A repo with no contract file makes the guard a no-op; any throw here is not the
      // subject of this test.
    });
    const everyCommand = [...ssh.commands, ...prepared.commands].map((c) => c.command).join("\n");
    for (const probe of ["scripts/bootstrap.sh", "script/bootstrap", "bin/setup", "make setup"]) {
      expect(everyCommand).not.toContain(probe);
    }
    // …and a repo that declared no setup verb makes NO round-trip for it at all: absence is
    // semantic here, not a fallback to something Tanren picked.
    expect(prepared.commands.map((c) => c.command).join("\n")).not.toContain("workspace-setup");
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
