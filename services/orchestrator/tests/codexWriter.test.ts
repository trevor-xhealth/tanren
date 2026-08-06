import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { buildCodexExecCommand, createCodexWriter, parseCodexJsonlTelemetry } from "../src/engine/providers/codex.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const authJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "secret-access-token",
    refresh_token: "secret-refresh-token",
  },
});

describe("Codex writer adapter", () => {
  it("constructs codex exec with per-run CODEX_HOME, workspace-write, JSONL, and stdin prompt", async () => {
    const ssh = new ScriptedSsh([
      ok(""),
      ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),
      ok('{"type":"usage","usage":{"input_tokens":12,"output_tokens":5,"cached_input_tokens":3}}\n'),
      ok(refreshedAuthJson()),
      ok(""),
      ok("diff --git a/LIVE.md b/LIVE.md\n+done\n"),
      ok(""),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });

    const writer = createCodexWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_codex_1",
    });
    const result = await writer.runWriter({
      prompt: "make a tiny edit",
      workspace: "/workspace/repo",
    });

    expect(ssh.commands[0]?.command.command).toContain("/run_codex_1/codex-home");
    expect(ssh.commands[0]?.command.stdin).toBe(authJson);
    expect(ssh.commands[2]?.command.command).toBe(
      `CODEX_HOME='/home/tanren/.tanren/runs/run_codex_1/codex-home' codex exec --sandbox workspace-write --json -m 'gpt-5.6-luna' -c 'model_reasoning_effort="high"' --ignore-user-config --cd '/workspace/repo' -`,
    );
    expect(ssh.commands[2]?.command.stdin).toBe("make a tiny edit");
    expect(ssh.commands[4]?.command.command).toContain("commit -m 'codex writer'");
    expect(result).toMatchObject({
      diff: "diff --git a/LIVE.md b/LIVE.md\n+done\n",
      commits: [],
      exitReason: "completed",
      tokenUsage: {
        inputTokens: 9,
        cachedInputTokens: 3,
        cacheCreationTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 17,
      },
      telemetry: {
        rawEventCount: 1,
        tokenUsage: {
          inputTokens: 9,
          cachedInputTokens: 3,
          cacheCreationTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
          totalTokens: 17,
        },
      },
    });
  });

  it("returns timeout and crashed results without treating stdout as completion", async () => {
    const timeout = await runWithCodexResult(
      { exitCode: null, stdout: '{"type":"done"}\n', stderr: "", stalled: true },
      {
        diff: "diff --git a/PARTIAL.md b/PARTIAL.md\n+partial\n",
        log: `${commitSha("d")}\tcodex writer\n`,
      },
    );
    const nonzero = await runWithCodexResult({
      exitCode: 2,
      stdout: '{"type":"done"}\n',
      stderr: "bad",
    });

    expect(timeout).toMatchObject({
      diff: "diff --git a/PARTIAL.md b/PARTIAL.md\n+partial\n",
      commits: [{ sha: commitSha("d"), message: "codex writer" }],
      exitReason: "timeout",
      telemetry: { rawEventCount: 1 },
    });
    expect(nonzero).toMatchObject({
      diff: "",
      commits: [],
      exitReason: "crashed",
      telemetry: { rawEventCount: 1 },
    });
  });

  it("judges successful completion from git state after Codex exits", async () => {
    const completedCommitSha = "cccccccccccccccccccccccccccccccccccccccc";
    const result = await runWithCodexResult(ok("{}\n"), {
      diff: "diff --git a/CODEX.md b/CODEX.md\n+codex\n",
      log: `${completedCommitSha}\tcodex change\n`,
    });

    expect(result.diff).toContain("+codex");
    expect(result.commits).toEqual([{ sha: completedCommitSha, message: "codex change" }]);
    expect(result.exitReason).toBe("completed");
  });

  // SaaS Tier-B #5 (OpenRouter cookbook): a MANAGED codex writer
  // (endpointBaseUrl set) materializes the OpenRouter config.toml provider block
  // + an OPENROUTER_API_KEY env file from the PLAIN OpenRouter key — it must NOT
  // run the codex-bundle validators, the exec must source the env file + drop
  // --ignore-user-config, and the key VALUE must never enter the command string.
  // It also skips the ChatGPT-bundle auth write-back (no token to rotate).
  it("MANAGED writer materializes the OpenRouter config.toml + key env file, skipping the bundle path and write-back", async () => {
    const baseSha = "a".repeat(40);
    // Managed script order: no baseline capture (baseSha threaded) AND no
    // auth write-back cat (managed) ⇒ 0 materialize-config, 1 codex exec,
    // 2 commit, 3 diff, 4 log.
    const ssh = new ScriptedSsh([
      ok(""),
      ok("{}\n"),
      ok(""),
      ok("diff --git a/MANAGED.md b/MANAGED.md\n+managed\n"),
      ok(`${commitSha("f")}\tcodex writer\n`),
    ]);
    const secrets = new InMemorySecretStore();
    // The stored secret is the PLAIN OpenRouter key (not a codex bundle).
    await secrets.put({ ref: "credential/openrouter/platform/default", value: "sk-or-v1-managed" });

    const writer = createCodexWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/openrouter/platform/default",
      runId: "run_managed_writer",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
    });
    const result = await writer.runWriter({
      prompt: "make a managed edit",
      workspace: "/workspace/repo",
      baseSha,
    });

    // The materialization command writes config.toml (provider block) + the key
    // env file; the secret key arrives on stdin (the export line), never in the
    // command string.
    expect(ssh.commands[0]?.command.command).toContain("config.toml");
    expect(ssh.commands[0]?.command.command).toContain("openrouter.env");
    expect(ssh.commands[0]?.command.command).not.toContain("sk-or-v1-managed");
    expect(ssh.commands[0]?.command.stdin).toBe("export OPENROUTER_API_KEY='sk-or-v1-managed'\n");
    // codex exec sources the env file + honors CODEX_HOME config.toml (no
    // --ignore-user-config) so it routes through the OpenRouter provider.
    expect(ssh.commands[1]?.command.command).toContain("openrouter.env' && CODEX_HOME=");
    expect(ssh.commands[1]?.command.command).not.toContain("--ignore-user-config");
    expect(ssh.commands[1]?.command.stdin).toBe("make a managed edit");
    // No auth write-back: a managed run must NOT cat auth.json back into the
    // secret store. With the script above, command[2] is the commit, not a cat.
    const commandText = ssh.commands.map((item) => item.command.command);
    expect(commandText.some((c) => c.includes("/codex-home/auth.json'") && c.startsWith("cat "))).toBe(false);
    expect(result.exitReason).toBe("completed");
    expect(result.diff).toContain("MANAGED.md");
    // The key never leaks into the result.
    expect(JSON.stringify(result)).not.toContain("sk-or-v1-managed");
  });

  // SaaS Tier-B #5: a managed codex exec sources the OPENROUTER_API_KEY env file
  // and drops --ignore-user-config so CODEX_HOME/config.toml is honored. A BYOK
  // run keeps --ignore-user-config and sources nothing.
  it("sources the OpenRouter env file + drops --ignore-user-config for a managed run", () => {
    const command = buildCodexExecCommand({
      codexHome: "/home/tanren/.codex",
      workspace: "/workspace/repo",
      managed: true,
    });
    expect(command).toContain(". '/home/tanren/.codex/openrouter.env' && CODEX_HOME=");
    expect(command).not.toContain("--ignore-user-config");
  });

  it("keeps --ignore-user-config and sources nothing for a BYOK bundle run", () => {
    const command = buildCodexExecCommand({ codexHome: "/home/tanren/.codex", workspace: "/workspace/repo" });
    expect(command).toContain("--ignore-user-config");
    expect(command).not.toContain("openrouter.env");
    expect(command).not.toContain("OPENROUTER_API_KEY");
  });

  // BYOK native-OpenAI api_key: sources the OPENAI_API_KEY env file but KEEPS
  // --ignore-user-config (codex hits OpenAI directly, no config.toml).
  it("sources the native OPENAI_API_KEY env file + keeps --ignore-user-config for a BYOK openai-api key", () => {
    const command = buildCodexExecCommand({
      codexHome: "/home/tanren/.codex",
      workspace: "/workspace/repo",
      nativeApiKeyEnvFile: "/home/tanren/.codex/openai.env",
    });
    expect(command).toContain(". '/home/tanren/.codex/openai.env' && CODEX_HOME=");
    expect(command).toContain("--ignore-user-config");
    expect(command).not.toContain("openrouter.env");
  });

  it("does not leak auth secrets through commands or writer results", async () => {
    const ssh = new ScriptedSsh([
      ok(""),
      ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),
      ok("{}\n"),
      ok(authJson),
      ok(""),
      ok("diff\n"),
      ok(""),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });

    const writer = createCodexWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_secret",
    });
    const result = await writer.runWriter({
      prompt: "do work",
      workspace: "/workspace/repo",
    });
    const commandText = ssh.commands.map((item) => item.command.command).join("\n");

    expect(commandText).not.toContain("secret-access-token");
    expect(commandText).not.toContain("secret-refresh-token");
    expect(JSON.stringify(result)).not.toContain("secret-access-token");
    expect(JSON.stringify(result)).not.toContain("secret-refresh-token");
  });

  // no_silent_fallbacks: the rotated-auth write-back is NOT best-effort — the new
  // bundle is PERSISTED (a store failure propagates; see codexAuthRotationPersist.test.ts).
  it("PERSISTS the refreshed auth bundle the codex run rotated (not a silent skip)", async () => {
    const rotatedAuthJson = refreshedAuthJson();
    const ssh = new ScriptedSsh([
      ok(""),
      ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),
      ok("{}\n"),
      ok(rotatedAuthJson),
      ok(""),
      ok("diff --git a/CODEX.md b/CODEX.md\n+codex\n"),
      ok(`${commitSha("e")}\tcodex writer\n`),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });

    const writer = createCodexWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_refresh",
    });
    const result = await writer.runWriter({
      prompt: "do work",
      workspace: "/workspace/repo",
    });

    expect(result.exitReason).toBe("completed");
    // The rotated bundle replaced the prior value — the write-back actually happened.
    await expect(secrets.get("credential/codex/dev")).resolves.toMatchObject({ value: rotatedAuthJson });
  });

  it("parses raw Codex JSONL count and optional token usage; COUNTS a malformed non-empty line (loud, not silent)", () => {
    expect(parseCodexJsonlTelemetry('{}\nnot-json\n{"usage":{"promptTokens":7,"completionTokens":4}}\n')).toEqual({
      rawEventCount: 3,
      tokenUsage: {
        inputTokens: 7,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 4,
        reasoningOutputTokens: 0,
        totalTokens: 11,
      },
      // `--json` means every non-empty line is a JSON event — `not-json` is counted.
      malformedLineCount: 1,
    });
  });

  it("a fully-valid Codex JSONL stream reports ZERO malformed lines (legitimate, quiet)", () => {
    const out = parseCodexJsonlTelemetry('{"type":"x"}\n{"usage":{"promptTokens":1,"completionTokens":1}}\n');
    expect(out.malformedLineCount).toBe(0);
  });

  it("de-overlaps Codex inclusive token shape into disjoint buckets", () => {
    // Real Codex shape: cached_input_tokens ⊆ input_tokens and
    // reasoning_output_tokens ⊆ output_tokens, so input/output must shed the
    // overlap to keep the buckets mutually exclusive.
    const line = JSON.stringify({
      type: "usage",
      usage: {
        input_tokens: 11460,
        cached_input_tokens: 4480,
        output_tokens: 461,
        reasoning_output_tokens: 316,
        total_tokens: 11921,
      },
    });
    expect(parseCodexJsonlTelemetry(`${line}\n`).tokenUsage).toEqual({
      inputTokens: 6980,
      cachedInputTokens: 4480,
      cacheCreationTokens: 0,
      outputTokens: 145,
      reasoningOutputTokens: 316,
      totalTokens: 11921,
    });
  });

  it("detects a usage-limit signal from the turn.failed error envelope", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"You\'ve hit your usage limit. Visit ... or try again at May 30th, 2026 8:19 PM."}',
      '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. ... try again at May 30th, 2026 8:19 PM."}}',
    ].join("\n");
    const telemetry = parseCodexJsonlTelemetry(stdout);
    expect(telemetry.usageLimit?.message).toContain("usage limit");
    expect(telemetry.usageLimit?.message).toContain("May 30th");
  });

  it.each([
    ["usage-limit", '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}'],
    ["429", '{"type":"turn.failed","error":{"status":429,"message":"Too Many Requests"}}'],
    [
      "OpenRouter 402 insufficient-credits",
      '{"type":"turn.failed","error":{"code":402,"message":"Insufficient credits"}}',
    ],
  ])("returns window_exhausted (not crashed) for a %s rejection", async (_kind, stdout) => {
    // A nonzero exit proves the parsed signal wins over the generic crash path.
    const result = await runWithCodexResult({
      exitCode: 1,
      stdout,
      stderr: "",
    });
    expect(result.exitReason).toBe("window_exhausted");
    expect(result.telemetry?.usageLimit).toBeDefined();
  });

  // The cumulative-diff fix: when a run base sha is threaded, the writer diffs
  // the workspace against the RUN BASE — not a freshly-captured per-subtask
  // HEAD. It must NOT issue a `git rev-parse HEAD` baseline capture, and the
  // diff/log commands must target the provided base sha.
  it("diffs against the threaded run-base sha and skips the per-subtask HEAD capture", async () => {
    const baseSha = "a".repeat(40);
    // Script order when baseSha is provided (no baseline capture step):
    //   0 materialize-auth, 1 codex exec, 2 persist-auth cat, 3 commit,
    //   4 diff, 5 log.
    const ssh = new ScriptedSsh([
      ok(""),
      ok("{}\n"),
      ok(refreshedAuthJson()),
      ok(""),
      ok("diff --git a/GREETING.md b/GREETING.md\n+hello\n"),
      ok(`${commitSha("c")}\tcodex writer\n`),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });

    const writer = createCodexWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_base_sha",
    });
    const result = await writer.runWriter({
      prompt: "create GREETING.md",
      workspace: "/workspace/repo",
      baseSha,
    });

    const commandText = ssh.commands.map((item) => item.command.command);
    // No standalone baseline capture: the writer must not re-read HEAD when a
    // run base is threaded (that is the per-subtask HEAD this fix removes).
    expect(commandText).not.toContain("git rev-parse HEAD");
    // The diff + log baseline is the threaded run base, not a captured HEAD.
    expect(commandText).toContain(`git diff --no-color ${baseSha}`);
    expect(commandText.some((c) => c.includes(`${baseSha}..HEAD`))).toBe(true);
    expect(result.diff).toContain("GREETING.md");
    expect(result.exitReason).toBe("completed");
  });

  // The bug this fix closes: a REPLANNED subtask whose work a prior subtask
  // already committed. Codex no-ops (the file already exists) so there is no NEW
  // delta this iteration — but because the diff is taken vs the RUN BASE, the
  // already-created file still appears, so the checker would pass instead of
  // false-rejecting an empty per-iteration diff.
  it("still shows a prior-iteration-created file in the diff when this iteration no-ops (cumulative vs base)", async () => {
    const baseSha = "b".repeat(40);
    // codex no-ops (empty stdout event), `git add -A` finds nothing new so no
    // new commit is made, but `git diff <base>` still surfaces the file a prior
    // subtask committed on top of the base.
    const cumulativeDiff = "diff --git a/GREETING.md b/GREETING.md\nnew file mode 100644\n+hello\n";
    const ssh = new ScriptedSsh([
      ok(""),
      ok("{}\n"),
      ok(refreshedAuthJson()),
      ok(""),
      ok(cumulativeDiff),
      ok(`${commitSha("d")}\tcreate GREETING.md\n`),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });

    const writer = createCodexWriter({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_replanned",
    });
    const result = await writer.runWriter({
      prompt: "create GREETING.md",
      workspace: "/workspace/repo",
      baseSha,
    });

    // The diff handed to the checker is non-empty and shows the file, so a
    // no-op-but-already-satisfied subtask is NOT rejected for an empty diff.
    expect(result.diff).toContain("GREETING.md");
    expect(result.diff.length).toBeGreaterThan(0);
    expect(result.exitReason).toBe("completed");
  });
});

function commitSha(char: string): string {
  return char.repeat(40);
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function refreshedAuthJson(): string {
  return JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "new-token" } });
}

const EMPTY_GIT_STATE: { diff: string; log: string } = { diff: "", log: "" };

async function runWithCodexResult(
  codexResult: CommandResult,
  gitState: { diff: string; log: string } = EMPTY_GIT_STATE,
) {
  const ssh = new ScriptedSsh([
    ok(""),
    ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),
    codexResult,
    ok(refreshedAuthJson()),
    ok(""),
    ok(gitState.diff),
    ok(gitState.log),
  ]);
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: "credential/codex/dev", value: authJson });
  const writer = createCodexWriter({
    secrets,
    ssh,
    target,
    credentialRef: "credential/codex/dev",
    runId: "run_codex_2",
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
