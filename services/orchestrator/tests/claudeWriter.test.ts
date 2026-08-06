import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import {
  buildClaudeWriterCommand,
  createClaudeWriter,
  parseClaudeStreamTelemetry,
} from "../src/engine/providers/claude.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const authJson = JSON.stringify({
  claudeAiOauth: { accessToken: "secret-access-token", refreshToken: "secret-refresh-token" },
});

const baselineSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("Claude writer adapter", () => {
  it("constructs claude -p with per-run CLAUDE_CONFIG_DIR, model, workspace, and stdin prompt", async () => {
    const usageLine = JSON.stringify({
      type: "assistant",
      message: {
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      },
    });
    const ssh = new ScriptedSsh([
      // materialize auth
      ok(""),
      // capture baseline sha
      ok(`${baselineSha}\n`),
      // claude run
      ok(`${usageLine}\n`),
      // commit
      ok(""),
      // diff
      ok("diff --git a/X.md b/X.md\n+done\n"),
      // log
      ok(""),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/claude/dev", value: authJson });

    const writer = createClaudeWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/claude/dev",
      runId: "run_claude_1",
      model: "claude-opus-4-8",
    });
    const result = await writer.runWriter({
      prompt: "make a tiny edit",
      workspace: "/workspace/repo",
    });

    expect(ssh.commands[0]?.command.command).toContain("/run_claude_1/claude-home");
    expect(ssh.commands[0]?.command.stdin).toBe(authJson);
    expect(ssh.commands[2]?.command.command).toContain("claude -p");
    expect(ssh.commands[2]?.command.command).toContain("--output-format stream-json");
    expect(ssh.commands[2]?.command.command).toContain("--permission-mode acceptEdits");
    expect(ssh.commands[2]?.command.command).toContain("--model 'claude-opus-4-8'");
    expect(ssh.commands[2]?.command.stdin).toBe("make a tiny edit");
    expect(ssh.commands[3]?.command.command).toContain("commit -m 'claude writer'");
    expect(result).toMatchObject({
      diff: "diff --git a/X.md b/X.md\n+done\n",
      commits: [],
      exitReason: "completed",
      tokenUsage: {
        inputTokens: 12,
        cachedInputTokens: 3,
        cacheCreationTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 22,
      },
    });
  });

  it("returns timeout and crashed without treating stdout as completion", async () => {
    const timeout = await runWithClaudeResult({
      exitCode: null,
      stdout: "{}\n",
      stderr: "",
      stalled: true,
    });
    const crashed = await runWithClaudeResult({
      exitCode: 1,
      stdout: "{}\n",
      stderr: "bad",
    });
    expect(timeout.exitReason).toBe("timeout");
    expect(crashed.exitReason).toBe("crashed");
  });

  it.each([
    ["usage-limit", '{"type":"result","result":"You have hit your usage limit. Try again at 8 PM."}'],
    ["429", '{"type":"error","error":{"status":429,"message":"Too Many Requests"}}'],
    ["OpenRouter 402 insufficient-credits", '{"type":"error","error":{"code":402,"message":"Insufficient credits"}}'],
  ])("returns window_exhausted (not crashed) for a %s rejection", async (_kind, stdout) => {
    const result = await runWithClaudeResult({
      exitCode: 1,
      stdout: `${stdout}\n`,
      stderr: "",
    });
    expect(result.exitReason).toBe("window_exhausted");
    expect(result.telemetry?.usageLimit).toBeDefined();
  });

  it("does not leak auth secrets through commands or writer results", async () => {
    const result = await runWithClaudeResult({
      exitCode: 0,
      stdout: "{}\n",
      stderr: "",
    });
    expect(JSON.stringify(result)).not.toContain("secret-access-token");
  });

  it("omits the --model flag when no model is pinned", () => {
    const command = buildClaudeWriterCommand({
      configDir: "/home/tanren/claude",
      workspace: "/workspace/repo",
    });
    expect(command).not.toContain("--model");
    expect(command).toContain("--add-dir '/workspace/repo'");
  });

  // SaaS Tier-B #5 (OpenRouter cookbook): a managed run sets ANTHROPIC_BASE_URL
  // (the `/api` form) + blanks ANTHROPIC_API_KEY on the command. The secret
  // ANTHROPIC_AUTH_TOKEN is in settings.json (asserted in the materializer test),
  // never on the command. BYOK (no override) leaves all three untouched.
  it("sets ANTHROPIC_BASE_URL + blanks ANTHROPIC_API_KEY for a managed run, without the secret token", () => {
    const command = buildClaudeWriterCommand({
      configDir: "/home/tanren/claude",
      workspace: "/workspace/repo",
      managed: true,
      anthropicBaseUrl: "https://openrouter.ai/api",
    });
    expect(command).toContain("ANTHROPIC_BASE_URL='https://openrouter.ai/api'");
    expect(command).toContain("ANTHROPIC_API_KEY=''");
    expect(command).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("does not set the OpenRouter env vars for a BYOK run", () => {
    const command = buildClaudeWriterCommand({
      configDir: "/home/tanren/claude",
      workspace: "/workspace/repo",
    });
    expect(command).not.toContain("ANTHROPIC_BASE_URL");
    expect(command).not.toContain("ANTHROPIC_API_KEY");
    expect(command).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  // SaaS Tier-B #5 (OpenRouter cookbook): a managed claude writer materializes a
  // settings.json carrying the OpenRouter env block (secret AUTH_TOKEN inside)
  // from the PLAIN OpenRouter key, sets the `/api` base + blank API key on the
  // command, and never leaks the key into the command string or the result.
  it("MANAGED writer materializes settings.json with the OpenRouter env block + sets the /api base", async () => {
    const ssh = new ScriptedSsh([
      // materialize settings.json
      ok(""),
      // capture baseline sha
      ok(`${baselineSha}\n`),
      // claude run
      ok("{}\n"),
      // commit
      ok(""),
      // diff
      ok("diff --git a/M.md b/M.md\n+m\n"),
      // log
      ok(""),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/openrouter/platform/default", value: "sk-or-v1-claude-managed" });

    const writer = createClaudeWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/openrouter/platform/default",
      runId: "run_claude_managed",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
    });
    const result = await writer.runWriter({ prompt: "managed edit", workspace: "/workspace/repo" });

    // settings.json is materialized (the secret AUTH_TOKEN arrives on stdin, not
    // in the command string).
    expect(ssh.commands[0]?.command.command).toContain("settings.json");
    expect(ssh.commands[0]?.command.command).not.toContain("sk-or-v1-claude-managed");
    const settings = JSON.parse(ssh.commands[0]?.command.stdin ?? "{}");
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-v1-claude-managed");
    expect(settings.env.ANTHROPIC_API_KEY).toBe("");
    // The claude run command carries the /api base + blank API key, no secret.
    expect(ssh.commands[2]?.command.command).toContain("ANTHROPIC_BASE_URL='https://openrouter.ai/api'");
    expect(ssh.commands[2]?.command.command).toContain("ANTHROPIC_API_KEY=''");
    expect(ssh.commands[2]?.command.command).not.toContain("sk-or-v1-claude-managed");
    expect(result.exitReason).toBe("completed");
    expect(JSON.stringify(result)).not.toContain("sk-or-v1-claude-managed");
  });

  it("maps the Claude disjoint usage shape straight across with no de-overlap", () => {
    const line = JSON.stringify({
      type: "result",
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    });
    expect(parseClaudeStreamTelemetry(`${line}\n`).tokenUsage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 10,
      cacheCreationTokens: 5,
      outputTokens: 40,
      reasoningOutputTokens: 0,
      totalTokens: 155,
    });
  });

  it("COUNTS a malformed non-empty stream-json line (loud), and reports zero for an all-valid stream", () => {
    // `stream-json` is one JSON object per line — a non-empty line that fails to
    // parse is contract drift, surfaced via malformedLineCount (not silently skipped).
    const malformed = parseClaudeStreamTelemetry('{"type":"x"}\noops not json\n');
    expect(malformed.malformedLineCount).toBe(1);
    expect(parseClaudeStreamTelemetry('{"type":"x"}\n{"type":"y"}\n').malformedLineCount).toBe(0);
  });
});

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

async function runWithClaudeResult(claudeResult: CommandResult) {
  const ssh = new ScriptedSsh([ok(""), ok(`${baselineSha}\n`), claudeResult, ok(""), ok(""), ok("")]);
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: "credential/claude/dev", value: authJson });
  const writer = createClaudeWriter({
    secrets,
    ssh,
    target,
    credentialRef: "credential/claude/dev",
    runId: "run_claude_2",
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
