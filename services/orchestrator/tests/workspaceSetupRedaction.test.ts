// APP-ENV REDACTION at the workspace doors (CWE-532). Split from ./workspaceSetupVerb.test.ts,
// which is at its file-length ceiling.

import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { ensureWorkspaceSetup, WorkspaceSetupError } from "../src/engine/workspace/setup.js";

const target: RunnerHandle = { id: "r1", host: "h", port: 22, user: "tanren" } as unknown as RunnerHandle;
const WORKSPACE = "/workspace/runs/run_redact/repo";
const SETUP_RUN = "scripts/install-native-tools.sh";

describe("a failed setup cannot print an app-env SECRET into the error or the events", () => {
  it("redacts every injected app-env value out of the captured output tail", async () => {
    // CWE-532. Each workspace door is careful that the app-env prelude never touches the
    // `command` field the typed error carries, and each says so in a comment — "no
    // app-secret value can reach the error message or the emitted event payload". That was
    // only ever true of the COMMAND. The same error carries `outputTail`, which is the
    // PROJECT's own stdout+stderr, and a `setup.run` that echoes a variable (a `set -x`, a
    // curl with the token on the argv, a stack trace quoting a DSN) put the value straight
    // into `WorkspaceSetupError.message` and from there into `workspace.failed`.
    const secret = "sk-live-9f2c4a8e1b7d";
    const ssh = new EchoingSetupSsh(`connecting with API_TOKEN=${secret}\ncurl: (6) Could not resolve host`);

    const error = await ensureWorkspaceSetup({
      ssh,
      target,
      workspacePath: WORKSPACE,
      command: SETUP_RUN,
      appEnv: { API_TOKEN: secret, MODE: "dev" },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkspaceSetupError);
    const typed = error as WorkspaceSetupError;
    expect(typed.outputTail).not.toContain(secret);
    expect(typed.message).not.toContain(secret);
    // Redacted, not deleted: the operator still gets a legible diagnostic, and is told
    // WHICH variable was removed so they know where to look.
    expect(typed.outputTail).toContain("[redacted:API_TOKEN]");
    expect(typed.outputTail).toContain("Could not resolve host");
    // A short, non-secret-shaped value is left alone — redacting `dev` would shred the
    // diagnostic everywhere those three bytes appear and protect nothing.
    expect(typed.outputTail).not.toContain("[redacted:MODE]");
  });
});

/** A substrate whose setup step FAILS having printed the given output. */
class EchoingSetupSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  constructor(private readonly output: string) {}
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    return { exitCode: 1, stdout: this.output, stderr: "" };
  }
}
