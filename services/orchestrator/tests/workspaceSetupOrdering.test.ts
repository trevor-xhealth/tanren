// THE ORDER OF WORKSPACE PREPARATION, at the door that had it wrong.
//
// `workspace/setup.ts` states it: "after the declared toolchain is provisioned (setup may
// need node/python), before the project's bootstrap (bootstrap may need what setup
// installed)". `ensureWorkspaceDepsInstalled` ran setup FIRST and provisioned afterwards,
// inside the guarded install. The documented order therefore held only on the run-loop
// path, where `prepareRunWorkspace` had already provisioned — and NOT on the merge-gate
// path, which clones a fresh workspace and never sees workspace-prep. There the activation
// guard found no `mise.toml` and no marker, and a `setup.run` calling `pnpm`/`node`/
// `python` failed before the toolchain it needs existed.
//
// A comment stating an order is not an order. This file is the guard.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { SETUP_RUN_SENTINEL } from "../src/engine/workspace/setup.js";
import { ensureWorkspaceDepsInstalled } from "../src/engine/workspace/bootstrap.js";

const target: RunnerHandle = { id: "r1", host: "h", port: 22, user: "tanren" } as unknown as RunnerHandle;
const WORKSPACE = "/workspace/runs/run_order/repo";
const SETUP_RUN = "scripts/install-native-tools.sh";
const BOOTSTRAP_RUN = "pnpm install --frozen-lockfile";

/** A fresh MERGE-gate workspace: it has a contract, it declares `node` in a `.nvmrc`, and
 * nothing has been provisioned yet — the state in which the old order broke. */
class FreshMergeGateSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    if (command.command.includes("TANREN-TOOLCHAIN-DECLARATION:")) {
      // Answer the read with the nonce it was asked with, the way a runner does.
      const nonce = /'===TANREN-TOOLCHAIN-DECLARATION:' '([0-9a-f]+)'/u.exec(command.command)?.[1] ?? "";
      return { exitCode: 0, stdout: `===TANREN-TOOLCHAIN-DECLARATION:${nonce}:.nvmrc===\n24\n`, stderr: "" };
    }
    if (command.command.includes("provisioning declared toolchain")) {
      return { exitCode: 0, stdout: "===TANREN-TOOLCHAIN-IN-EFFECT:node|24|24.18.1|.nvmrc|pinned===\n", stderr: "" };
    }
    if (command.command.includes(SETUP_RUN)) {
      return { exitCode: 0, stdout: SETUP_RUN_SENTINEL, stderr: "" };
    }
    return { exitCode: 0, stdout: "tanren: deps-ensure installing", stderr: "" };
  }
  indexOf(needle: string): number {
    return this.commands.findIndex((c) => c.command.includes(needle));
  }
}

describe("ensureWorkspaceDepsInstalled · toolchain, THEN setup, THEN the project's bootstrap", () => {
  it("provisions the declared toolchain BEFORE the repo's setup command runs", async () => {
    const ssh = new FreshMergeGateSsh();

    const result = await ensureWorkspaceDepsInstalled({
      ssh,
      target,
      workspacePath: WORKSPACE,
      command: BOOTSTRAP_RUN,
      setupCommand: SETUP_RUN,
    });

    const probe = ssh.indexOf("TANREN-TOOLCHAIN-DECLARATION:");
    const provision = ssh.indexOf("mise use --global");
    const setup = ssh.indexOf(SETUP_RUN);
    const bootstrap = ssh.indexOf(BOOTSTRAP_RUN);
    for (const [name, index] of Object.entries({ probe, provision, setup, bootstrap })) {
      expect(index, `${name} did not run`).toBeGreaterThanOrEqual(0);
    }
    // THE ASSERTION. Under the previous order `setup` was index 0 and `provision` came
    // after it, so this line is what fails on a revert.
    expect(provision).toBeLessThan(setup);
    expect(setup).toBeLessThan(bootstrap);

    // …and the setup command is the one that actually gets the toolchain: by the time it
    // runs, the marker the provision wrote is what the activation prelude triggers on.
    expect(ssh.commands[setup]?.command).toContain("tanren-mise-provisioned");
    // The resolved versions come from the provision step that verified them.
    expect(result.toolchain).toEqual([
      { tool: "node", declared: "24", resolved: "24.18.1", declaredIn: ".nvmrc", versionDeclared: true },
    ]);
  });
});
