import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import {
  buildOpencodeWriterCommand,
  createOpencodeWriter,
  parseOpencodeStreamTelemetry,
  resolveOpencodeModel,
  ZAI_GLM_MODEL,
} from "../src/engine/providers/opencode.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const authJson = JSON.stringify({ zai: { key: "secret-zai-key" } });

const baselineSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("opencode writer adapter", () => {
  it("constructs opencode run with per-run XDG_DATA_HOME, the Zai GLM model, workspace, and stdin prompt", async () => {
    const usageLine = JSON.stringify({
      type: "completion",
      usage: { input_tokens: 20, output_tokens: 8, cache_read: 4 },
    });
    const ssh = new ScriptedSsh([
      // materialize auth
      ok(""),
      // baseline sha
      ok(`${baselineSha}\n`),
      // opencode run
      ok(`${usageLine}\n`),
      // commit
      ok(""),
      // diff
      ok("diff --git a/Y.md b/Y.md\n+done\n"),
      // log
      ok(""),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/opencode/dev", value: authJson });

    const writer = createOpencodeWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/opencode/dev",
      runId: "run_oc_1",
    });
    const result = await writer.runWriter({
      prompt: "make a tiny edit",
      workspace: "/workspace/repo",
    });

    expect(ssh.commands[0]?.command.command).toContain("/run_oc_1/opencode-home");
    expect(ssh.commands[0]?.command.stdin).toBe(authJson);
    expect(ssh.commands[2]?.command.command).toContain("opencode run");
    expect(ssh.commands[2]?.command.command).toContain(`--model '${ZAI_GLM_MODEL}'`);
    expect(ssh.commands[2]?.command.command).toContain("--cwd '/workspace/repo'");
    expect(ssh.commands[2]?.command.stdin).toBe("make a tiny edit");
    expect(ssh.commands[3]?.command.command).toContain("commit -m 'opencode writer'");
    expect(writer.cli).toBe("opencode");
    expect(result).toMatchObject({
      diff: "diff --git a/Y.md b/Y.md\n+done\n",
      exitReason: "completed",
      tokenUsage: {
        inputTokens: 20,
        cachedInputTokens: 4,
        cacheCreationTokens: 0,
        outputTokens: 8,
        reasoningOutputTokens: 0,
        totalTokens: 32,
      },
    });
  });

  it("defaults to the Zai GLM 5.1 model when none is pinned", () => {
    expect(ZAI_GLM_MODEL).toBe("zai/glm-5.1");
    const command = buildOpencodeWriterCommand({
      dataHome: "/data",
      workspace: "/workspace/repo",
      model: ZAI_GLM_MODEL,
    });
    expect(command).toContain("--model 'zai/glm-5.1'");
  });

  // SaaS Tier-B #5 (OpenRouter cookbook): a managed run exports XDG_CONFIG_HOME
  // (so opencode reads the OpenRouter provider opencode.json) and selects the
  // openrouter provider via the model namespace; BYOK leaves both untouched.
  it("exports XDG_CONFIG_HOME for a managed run; omits it for BYOK", () => {
    const managed = buildOpencodeWriterCommand({
      dataHome: "/data",
      workspace: "/workspace/repo",
      model: "openrouter/anthropic/claude-sonnet-latest",
      configHome: "/config",
    });
    expect(managed).toContain("XDG_CONFIG_HOME='/config'");
    expect(managed).toContain("--model 'openrouter/anthropic/claude-sonnet-latest'");
    const byok = buildOpencodeWriterCommand({
      dataHome: "/data",
      workspace: "/workspace/repo",
      model: ZAI_GLM_MODEL,
    });
    expect(byok).not.toContain("XDG_CONFIG_HOME");
  });

  it("namespaces a managed model under the openrouter provider", () => {
    expect(resolveOpencodeModel("anthropic/claude-sonnet-latest", true)).toBe(
      "openrouter/anthropic/claude-sonnet-latest",
    );
    // An already-namespaced model is left alone.
    expect(resolveOpencodeModel("openrouter/google/gemini-flash-latest", true)).toBe(
      "openrouter/google/gemini-flash-latest",
    );
    // BYOK passes the model through unchanged (defaulting to Zai GLM).
    expect(resolveOpencodeModel(undefined, false)).toBe(ZAI_GLM_MODEL);
  });

  // SaaS Tier-B #5 (OpenRouter cookbook): a managed opencode writer materializes
  // auth.json ({"openrouter":{"type":"api","key":<key>}}) + opencode.json
  // (provider.openrouter), exports XDG_CONFIG_HOME, and selects the openrouter
  // provider. The key arrives on stdin, never in a command string or the result.
  it("MANAGED writer materializes the openrouter auth.json + opencode.json and selects the provider", async () => {
    const ssh = new ScriptedSsh([
      // materialize auth.json (openrouter)
      ok(""),
      // materialize opencode.json (provider config)
      ok(""),
      // baseline sha
      ok(`${baselineSha}\n`),
      // opencode run
      ok("{}\n"),
      // commit
      ok(""),
      // diff
      ok("diff --git a/M.md b/M.md\n+m\n"),
      // log
      ok(""),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/openrouter/platform/default", value: "sk-or-v1-oc-managed" });

    const writer = createOpencodeWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/openrouter/platform/default",
      runId: "run_oc_managed",
      model: "anthropic/claude-sonnet-latest",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
    });
    const result = await writer.runWriter({ prompt: "managed edit", workspace: "/workspace/repo" });

    // auth.json: the openrouter provider entry, key on stdin (not in the command).
    expect(ssh.commands[0]?.command.command).toContain("opencode/auth.json");
    expect(ssh.commands[0]?.command.command).not.toContain("sk-or-v1-oc-managed");
    expect(JSON.parse(ssh.commands[0]?.command.stdin ?? "{}")).toEqual({
      openrouter: { type: "api", key: "sk-or-v1-oc-managed" },
    });
    // opencode.json: declares the openrouter provider.
    expect(ssh.commands[1]?.command.command).toContain("opencode.json");
    expect(ssh.commands[1]?.command.command).toContain("openrouter");
    // The run exports XDG_CONFIG_HOME + selects the openrouter-namespaced model.
    expect(ssh.commands[3]?.command.command).toContain("XDG_CONFIG_HOME=");
    expect(ssh.commands[3]?.command.command).toContain("--model 'openrouter/anthropic/claude-sonnet-latest'");
    expect(result.exitReason).toBe("completed");
    expect(JSON.stringify(result)).not.toContain("sk-or-v1-oc-managed");
  });

  it("returns timeout, crashed, and window_exhausted distinctly", async () => {
    const timeout = await runWith({ exitCode: null, stdout: "{}\n", stderr: "", stalled: true });
    const crashed = await runWith({ exitCode: 3, stdout: "{}\n", stderr: "boom" });
    const limit = await runWith({
      exitCode: 0,
      stdout: '{"type":"error","error":{"message":"You have hit your rate limit."}}\n',
      stderr: "",
    });
    expect(timeout.exitReason).toBe("timeout");
    expect(crashed.exitReason).toBe("crashed");
    expect(limit.exitReason).toBe("window_exhausted");
  });

  it("does not leak the Zai key through commands or results", async () => {
    const result = await runWith({ exitCode: 0, stdout: "{}\n", stderr: "" });
    expect(JSON.stringify(result)).not.toContain("secret-zai-key");
  });

  it("maps opencode disjoint usage straight across with no de-overlap", () => {
    const line = JSON.stringify({
      usage: { input_tokens: 50, output_tokens: 30, cache_read: 5, cache_write: 2 },
    });
    expect(parseOpencodeStreamTelemetry(`${line}\n`).tokenUsage).toEqual({
      inputTokens: 50,
      cachedInputTokens: 5,
      cacheCreationTokens: 2,
      outputTokens: 30,
      reasoningOutputTokens: 0,
      totalTokens: 87,
    });
  });

  it("counts a JSON-shaped-but-malformed line LOUD, but treats human log text as BENIGN (quiet)", () => {
    // `--print-logs` interleaves human log lines with JSON events: a plain-text log
    // line is benign (NOT counted); only a `{`-leading line that fails to parse is
    // contract drift, surfaced via malformedLineCount.
    const out = parseOpencodeStreamTelemetry(
      'INFO booting up\n{"usage":{"input_tokens":1,"output_tokens":1}}\n{ broken json\n',
    );
    expect(out.malformedLineCount).toBe(1);
    // A run with only valid JSON + benign log text reports zero.
    expect(parseOpencodeStreamTelemetry('INFO ready\n{"type":"x"}\n').malformedLineCount).toBe(0);
  });
});

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

async function runWith(opencodeResult: CommandResult) {
  const ssh = new ScriptedSsh([ok(""), ok(`${baselineSha}\n`), opencodeResult, ok(""), ok(""), ok("")]);
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: "credential/opencode/dev", value: authJson });
  const writer = createOpencodeWriter({
    secrets,
    ssh,
    target,
    credentialRef: "credential/opencode/dev",
    runId: "run_oc_2",
  });
  return await writer.runWriter({ prompt: "write", workspace: "/workspace/repo" });
}

class ScriptedSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];

  constructor(private readonly results: CommandResult[]) {}

  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target: sshTarget, command });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error(`unexpected SSH command: ${command.command}`);
    }
    return result;
  }
}
