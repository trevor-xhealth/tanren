import { randomBytes } from "node:crypto";
import type { RunnerHandle } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandResult, CommandSubstrate } from "../contracts/commandSubstrate.js";
import { storeCodexAuthBundle } from "../credentials/codexAuth.js";
import { materializeCodexAuthBundle } from "../credentials/codexMaterializer.js";
import { buildActivityWatchdog, outputOnlyWatchdog, quoteSshShellArg } from "../ssh/index.js";
import type { AnswererAdapter, TokenUsage, UsageLimitSignal, WriterAdapter, WriterResult } from "./types.js";
import { findOpenRouterGenerationId, foldGenerationId } from "./openRouterGenerationId.js";
import { findTokenUsageBounded, parseJsonObject, splitNonEmptyJsonlLines } from "./findTokenUsage.js";
import { captureBaselineSha, captureGitStateAfterCodex } from "./codexGit.js";
// recordedCodexModel: the id the adapter DECLARES (WriterAdapter.model) →
// `cost_records.model`, from the SAME dispatch the exec/config path uses.
import { buildCodexAnswererExecCommand, buildCodexExecCommand, recordedCodexModel } from "./codexExecCommand.js";
import { createLogger } from "../observability/logger.js";
import { parseWithOneSchemaRepair } from "./answererRepair.js";
import {
  AnswererSchemaValidationError,
  AnswererStalledError,
  throwIfTransientSshFailure,
} from "./answererSchemaError.js";
import { answererWorkspacePath, safeSchemaFileName } from "./codexAnswererPaths.js";

const log = createLogger("codex");

// Re-exported so existing `from "./codex.js"` importers (the uniqueness test) stay stable.
export { safeSchemaFileName };

// Re-exported from codexExecCommand.ts (split out for the 500-line cap) so existing
// importers (and the command-builder tests) stay stable.
export { buildCodexAnswererExecCommand, buildCodexExecCommand };

export interface CodexWriterDependencies {
  secrets: SecretStore;
  ssh: CommandSubstrate;
  target: RunnerHandle;
  credentialRef: string;
  runId: string;
  // The routing-chain model. It overrides the direct and OpenRouter defaults.
  model?: string;
  codexHomeBaseDir?: string;
  // SaaS Tier-B #5: optional managed-endpoint base URL. When set (managed run), the
  // materializer writes codex's config.toml OpenRouter provider block (base_url =
  // this endpoint) + an OPENROUTER_API_KEY env file the exec sources, so codex routes
  // THROUGH OpenRouter. Absent ⇒ BYOK: no override (unchanged).
  endpointBaseUrl?: string;
}

export interface CodexEventTelemetry {
  rawEventCount: number;
  tokenUsage?: TokenUsage;
  usageLimit?: UsageLimitSignal;
  // The OpenRouter generation id (managed run); folded onto tokenUsage so the cost
  // recorder can query the REAL `usage.cost` (see TokenUsage.openRouterGenerationId).
  openRouterGenerationId?: string;
  // Count of NON-empty lines that failed to parse as JSON. Codex runs `--json`, so
  // every non-empty line MUST be a JSON event — a positive count is contract drift.
  malformedLineCount?: number;
}

// Raised by the Answerer path when Codex authenticated but the account's
// usage limit / subscription window is exhausted. Distinct from a generic
// Codex failure so the workflow can escalate it as window pressure
// (PROJECT_BRIEF §4.3) rather than treating it as a crash.
export class CodexUsageLimitError extends Error {
  constructor(
    readonly schemaName: string,
    readonly providerMessage: string,
  ) {
    super(`Codex usage limit reached for schema ${schemaName}: ${providerMessage}`);
    this.name = "CodexUsageLimitError";
  }
}

export interface CodexAnswererDependencies extends CodexWriterDependencies {
  answererWorkspaceBaseDir?: string;
}

export interface CodexAnswererTelemetry extends CodexEventTelemetry {
  schemaName: string;
}

// Re-exported from answererSchemaError.ts (split out to break the import cycle with
// answererRepair.ts) so existing `from "./codex.js"` importers stay stable.
export { AnswererSchemaValidationError, AnswererStalledError, throwIfTransientSshFailure };

export function createCodexWriter(dependencies: CodexWriterDependencies): WriterAdapter {
  return {
    kind: "writer",
    cli: "codex",
    authRef: dependencies.credentialRef,
    model: recordedCodexModel(dependencies),
    async runWriter(opts): Promise<WriterResult> {
      // SaaS Tier-B #5: a MANAGED run carries an endpointBaseUrl (the platform
      // OpenRouter shell). In managed mode the credential is a plain OpenRouter
      // API key, so the materializer writes codex's config.toml OpenRouter
      // provider block + an OPENROUTER_API_KEY env file (the cookbook path)
      // instead of validating a ChatGPT bundle.
      const managed = dependencies.endpointBaseUrl !== undefined;
      const auth = await materializeCodexAuthBundle({
        secrets: dependencies.secrets,
        ssh: dependencies.ssh,
        target: dependencies.target,
        ref: dependencies.credentialRef,
        runId: dependencies.runId,
        baseDir: dependencies.codexHomeBaseDir,
        managed,
        endpointBaseUrl: dependencies.endpointBaseUrl,
        model: dependencies.model,
      });
      // The diff/log baseline. In a production run this is the run's BASE sha
      // (the clone point), threaded via opts.baseSha and captured ONCE after the
      // clone — so each subtask is judged against the CUMULATIVE workspace state
      // vs the run base, not the per-subtask HEAD delta. That keeps a replanned,
      // already-satisfied subtask's diff non-empty (the file a prior subtask
      // committed still shows) so the checker passes instead of false-rejecting
      // an empty per-iteration delta. When no baseSha is threaded (no production
      // caller; only a non-threaded/unit caller) we fall back to HEAD-at-start.
      const baselineSha =
        opts.baseSha ?? (await captureBaselineSha(dependencies.ssh, dependencies.target, opts.workspace));
      const codex = await dependencies.ssh.run(dependencies.target, {
        command: buildCodexExecCommand({
          codexHome: auth.CODEX_HOME,
          workspace: opts.workspace,
          model: dependencies.model,
          managed: auth.managed,
          nativeApiKeyEnvFile: auth.nativeApiKeyEnvFile,
        }),
        stdin: opts.prompt,
        // AGENT exec: codex `--json` streams telemetry continuously (every line is a sign of life → the watchdog resets), with a workspace liveness probe as the backstop for a long silent tool call. NEVER killed for elapsed time. `onWatchdogProgress` (task #24, apex v52/v53) is the cross-layer sign-of-life bridge — every advancing tick emits `writer.subtask.progress`; composes with the substrate's `MIN_NON_ADVANCING_NEIGHBOR_REPEATS_*` streak floor (ssh/watchdogProgress.ts — the agent class widens to the 5-neighbor floor for Codex's think-then-stream burst pattern), which is signature identity, never elapsed time.
        watchdog: buildActivityWatchdog({
          substrate: dependencies.ssh,
          target: dependencies.target,
          cls: "agent",
          workspace: opts.workspace,
          onProgress: opts.onWatchdogProgress,
        }),
      });
      const telemetry = parseCodexJsonlTelemetry(codex.stdout);
      // Auth write-back is a ChatGPT-bundle refresh: codex rotates its
      // access/refresh tokens during a run and we persist the new bundle. Only the
      // BYOK bundle path writes an auth.json codex rotates; a managed or BYOK api_key
      // run authenticates with a static key (no token rotation), and its env/config
      // is not a codex bundle, so there is nothing to write back — skip it
      // (storeCodexAuthBundle would reject the non-codex ref anyway).
      if (auth.bundleAuth) {
        await persistRefreshedCodexAuth({
          secrets: dependencies.secrets,
          ssh: dependencies.ssh,
          target: dependencies.target,
          ref: dependencies.credentialRef,
          codexHome: auth.CODEX_HOME,
        });
      }

      const gitState = await captureGitStateAfterCodex(
        dependencies.ssh,
        dependencies.target,
        opts.workspace,
        baselineSha,
      );
      if (codex.stalled === true) {
        return failedResult("timeout", telemetry, gitState);
      }
      // Usage-limit exhaustion is an authenticated-but-out-of-quota state, not
      // a crash. Surface it distinctly so the workflow escalates window
      // pressure (PROJECT_BRIEF §4.3) instead of retrying a doomed call.
      if (telemetry.usageLimit !== undefined) {
        return failedResult("window_exhausted", telemetry, gitState);
      }
      if (codex.failure !== undefined || codex.exitCode !== 0) {
        return failedResult("crashed", telemetry, gitState);
      }

      return {
        ...gitState,
        exitReason: "completed",
        tokenUsage: telemetry.tokenUsage,
        telemetry,
      };
    },
  };
}

export function createCodexAnswerer<TOutput>(dependencies: CodexAnswererDependencies): AnswererAdapter<TOutput> {
  // Captures the MOST RECENT call's per-call token usage so the cost path can read
  // it right after the awaited runAnswerer (same adapter instance) and record REAL
  // tokens → REAL notional cost, instead of an all-zero answerer row. Codex emits
  // usage in its `--json` JSONL stream; parseCodexJsonlTelemetry already extracts it.
  let lastTokenUsage: TokenUsage | undefined;
  return {
    kind: "answerer",
    cli: "codex",
    authRef: dependencies.credentialRef,
    model: recordedCodexModel(dependencies),
    lastTokenUsage: () => lastTokenUsage,
    async runAnswerer(opts): Promise<TOutput> {
      // SaaS Tier-B #5: managed ⇒ config.toml OpenRouter provider block + an
      // OPENROUTER_API_KEY env file (see the writer path for the rationale).
      const managed = dependencies.endpointBaseUrl !== undefined;
      const auth = await materializeCodexAuthBundle({
        secrets: dependencies.secrets,
        ssh: dependencies.ssh,
        target: dependencies.target,
        ref: dependencies.credentialRef,
        runId: dependencies.runId,
        baseDir: dependencies.codexHomeBaseDir,
        managed,
        endpointBaseUrl: dependencies.endpointBaseUrl,
        model: dependencies.model,
      });
      // Per-call uniqueness suffix: the schema/output file names derive from the
      // schema NAME, shared across answerers (Checker + Auditor answer the same
      // verdict schema). Two answerers sharing a CODEX_HOME / workspace base would
      // otherwise write the SAME `<name>.schema.json` / `.response.json` and clobber
      // each other; a random per-call token keeps each answerer's files distinct.
      const fileBase = safeSchemaFileName(opts.outputSchema.name, randomBytes(6).toString("hex"));
      const workspace =
        opts.workspace ?? answererWorkspacePath(dependencies.runId, fileBase, dependencies.answererWorkspaceBaseDir);
      const schemaPath = `${auth.CODEX_HOME}/${fileBase}.schema.json`;
      const outputPath = `${auth.CODEX_HOME}/${fileBase}.response.json`;
      await prepareCodexAnswererWorkspace(dependencies, workspace, schemaPath, opts.outputSchema.jsonSchema);
      // Run one codex answerer exec for `prompt` and return the captured response
      // file text — closed over so the schema-repair pass can re-run it once with a
      // repair prompt. Each invocation refreshes lastTokenUsage + auth write-back.
      const runOnce = async (prompt: string): Promise<string> => {
        const result = await dependencies.ssh.run(dependencies.target, {
          command: buildCodexAnswererExecCommand({
            codexHome: auth.CODEX_HOME,
            workspace,
            schemaPath,
            outputPath,
            model: dependencies.model,
            managed: auth.managed,
            nativeApiKeyEnvFile: auth.nativeApiKeyEnvFile,
          }),
          stdin: prompt,
          // AGENT answerer exec (codex `--json` streaming) — output-driven, with the
          // answerer workspace as the silent-stretch liveness probe. Unbounded in time.
          watchdog: buildActivityWatchdog({
            substrate: dependencies.ssh,
            target: dependencies.target,
            cls: "agent",
            workspace,
          }),
        });
        const telemetry = parseCodexJsonlTelemetry(result.stdout);
        // Surface this call's per-call token usage for the cost path (lastTokenUsage).
        lastTokenUsage = telemetry.tokenUsage;
        // Only the BYOK bundle path has a rotating token — managed / BYOK api_key
        // auth is a static key, so skip the write-back (mirrors the writer path).
        if (auth.bundleAuth) {
          await persistRefreshedCodexAuth({
            secrets: dependencies.secrets,
            ssh: dependencies.ssh,
            target: dependencies.target,
            ref: dependencies.credentialRef,
            codexHome: auth.CODEX_HOME,
          });
        }
        // A TRANSIENT stall or SSH-connect failure → the typed transient the loop-stage recovery RE-DRIVES (not terminal).
        if (result.stalled === true) throw new AnswererStalledError(opts.outputSchema.name);
        throwIfTransientSshFailure(result.failure, opts.outputSchema.name);
        if (telemetry.usageLimit !== undefined) {
          throw new CodexUsageLimitError(opts.outputSchema.name, telemetry.usageLimit.message);
        }
        if (result.failure !== undefined || result.exitCode !== 0) {
          throw new Error(
            `Codex Answerer failed for schema ${opts.outputSchema.name}: exit ${result.exitCode ?? "unknown"}` +
              (result.failure === undefined ? "" : ` failure=${JSON.stringify(result.failure)}`) +
              ` | stderr: ${harnessOutputTail(result.stderr)} | stdout: ${harnessOutputTail(result.stdout)}`,
          );
        }
        const response = await dependencies.ssh.run(dependencies.target, {
          command: `cat ${quoteSshShellArg(outputPath)}`,
          watchdog: outputOnlyWatchdog(),
        });
        if (response.exitCode !== 0 || response.failure !== undefined || response.stalled === true) {
          throw new Error(`Codex Answerer response capture failed for schema ${opts.outputSchema.name}`);
        }
        return response.stdout;
      };
      const firstRawText = await runOnce(opts.prompt);
      // ONE bounded schema-repair pass: a malformed-then-valid
      // answer repairs in a single cheap re-call instead of throwing the stage (or,
      // for the auditor, becoming a synthetic P0 that drives a FULL loop iteration).
      // A second miss throws LOUD. Behavior is unchanged for a well-formed answer.
      return parseWithOneSchemaRepair({
        schema: opts.outputSchema,
        parse: (rawText) => parseStructuredAnswererOutput(rawText, opts.outputSchema),
        firstRawText,
        originalPrompt: opts.prompt,
        rerun: runOnce,
      });
    },
  };
}

export async function persistRefreshedCodexAuth(input: {
  secrets: SecretStore;
  ssh: CommandSubstrate;
  target: RunnerHandle;
  ref: string;
  codexHome: string;
}): Promise<void> {
  const result = await input.ssh.run(input.target, {
    command: `cat ${quoteSshShellArg(`${input.codexHome}/auth.json`)}`,
    // INFRA auth-bundle read: output-driven watchdog, no wall-clock kill.
    watchdog: outputOnlyWatchdog(),
  });
  if (result.exitCode !== 0 || result.stalled === true || result.failure !== undefined) {
    return;
  }
  // no_silent_fallbacks: a failed auth-bundle store is NOT benign. Codex rotated its
  // access/refresh tokens during the run; if we cannot persist the new bundle the
  // NEXT run authenticates with the stale (possibly already-revoked) refresh token —
  // a real credential corruption. Log LOUD and PROPAGATE so the rotation failure is
  // visible, never silently swallowed into a future auth break.
  try {
    await storeCodexAuthBundle(input.secrets, { ref: input.ref, authJson: result.stdout });
  } catch (error) {
    log.error(
      "failed to persist rotated auth bundle; the next run would reuse the stale token",
      { ref: input.ref },
      error,
    );
    throw error;
  }
}

// The tail of a harness stream, whitespace-collapsed, for surfacing the real
// reason an Answerer failed (e.g. an OpenAI structured-output 400) in the error.
function harnessOutputTail(stream: string | undefined): string {
  return (stream ?? "").slice(-1000).replaceAll(/\s+/gu, " ").trim();
}

export function parseCodexJsonlTelemetry(stdout: string): CodexEventTelemetry {
  const lines = splitNonEmptyJsonlLines(stdout);
  let tokenUsage: TokenUsage | undefined;
  let usageLimit: UsageLimitSignal | undefined;
  let openRouterGenerationId: string | undefined;
  // Codex runs with `--json`: EVERY non-empty line is a JSON event. A line that
  // fails to parse is contract drift (a malformed NON-empty line), NOT a benign
  // blank — count it so a silent skip becomes a VISIBLE signal the adapter surfaces
  // (`usage.token_accounting_failed` upstream) rather than quietly losing usage.
  let malformedLineCount = 0;
  for (const line of lines) {
    const parsed = parseJsonObject(line);
    if (parsed === undefined) {
      malformedLineCount += 1;
      continue;
    }
    tokenUsage = findTokenUsage(parsed) ?? tokenUsage;
    usageLimit = detectUsageLimit(parsed) ?? usageLimit;
    openRouterGenerationId = findOpenRouterGenerationId(parsed) ?? openRouterGenerationId;
  }
  return {
    rawEventCount: lines.length,
    tokenUsage: foldGenerationId(tokenUsage, openRouterGenerationId),
    usageLimit,
    openRouterGenerationId,
    malformedLineCount,
  };
}

// detectUsageLimit recognizes the Codex JSONL events emitted when the account
// hits a subscription-window limit:
//   {"type":"error","message":"You've hit your usage limit. ... try again at ..."}
//   {"type":"turn.failed","error":{"message":"You've hit your usage limit. ..."}}
// Matched on stable usage, rate-limit, and OpenRouter billing wording rather
// than the event type so a minor CLI wording change still surfaces it.
function detectUsageLimit(event: Record<string, unknown>): UsageLimitSignal | undefined {
  const candidates: unknown[] = [event["message"], event["error"], event["status"], event["statusCode"], event["code"]];
  const errorField = event["error"];
  if (typeof errorField === "object" && errorField !== null && !Array.isArray(errorField)) {
    const error = errorField as Record<string, unknown>;
    candidates.push(error["message"], error["status"], error["statusCode"], error["code"]);
  }
  for (const candidate of candidates) {
    if (
      (typeof candidate === "number" && (candidate === 402 || candidate === 429)) ||
      (typeof candidate === "string" &&
        /usage limit|rate limit|insufficient credits|quota|\b(?:402|429)\b/iu.test(candidate))
    ) {
      return { message: String(candidate) };
    }
  }
  return undefined;
}

export function parseStructuredAnswererOutput<TOutput>(
  stdout: string,
  schema: { name: string; parse(value: unknown): TOutput },
  _telemetry?: CodexAnswererTelemetry | CodexEventTelemetry,
): TOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new AnswererSchemaValidationError(schema.name, `invalid JSON: ${messageFromUnknown(error)}`);
  }
  try {
    return schema.parse(parsed);
  } catch (error) {
    throw new AnswererSchemaValidationError(schema.name, messageFromUnknown(error));
  }
}

async function prepareCodexAnswererWorkspace(
  dependencies: CodexAnswererDependencies,
  workspace: string,
  schemaPath: string,
  jsonSchema: Record<string, unknown>,
): Promise<void> {
  const made = await dependencies.ssh.run(dependencies.target, {
    command: `mkdir -p ${quoteSshShellArg(workspace)}`,
    // INFRA workspace prep: output-driven watchdog, no wall-clock kill.
    watchdog: outputOnlyWatchdog(),
  });
  assertAnswererWorkspaceStep(made, `mkdir -p ${workspace}`);
  const wrote = await dependencies.ssh.run(dependencies.target, {
    command: `cat > ${quoteSshShellArg(schemaPath)}`,
    stdin: JSON.stringify(jsonSchema),
    watchdog: outputOnlyWatchdog(),
  });
  assertAnswererWorkspaceStep(wrote, `write ${schemaPath}`);
}

// A failed workspace-prep SSH step (e.g. mkdir denied on a non-writable base) must
// be LOUD: otherwise codex `--cd`s into a dir that was never created and surfaces a
// cryptic `os error 2`, masking the real cause. (no-silent-fallbacks doctrine.)
function assertAnswererWorkspaceStep(result: CommandResult, step: string): void {
  if (result.exitCode !== 0 || result.failure !== undefined || result.stalled === true) {
    throw new Error(
      `Codex Answerer workspace prep failed (${step}): exit ${result.exitCode ?? "unknown"}` +
        `${result.stalled === true ? " (stalled — no sign of life)" : ""} | stderr: ${harnessOutputTail(result.stderr)}`,
    );
  }
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Walks one parsed Codex JSONL event for its usage record. BOUNDED on depth +
// node count (a hostile/buggy deeply-nested event must not blow the stack); on
// hitting a bound it emits a LOUD `usage-parse-bounded` signal rather than
// silently dropping usage. The Codex de-overlap shape is `tokenUsageFromRecord`.
function findTokenUsage(value: unknown): TokenUsage | undefined {
  return findTokenUsageBounded("codex", value, tokenUsageFromRecord);
}

// Transforms Codex's INCLUSIVE token shape into the disjoint TokenUsage buckets. In
// Codex JSONL, cached_input_tokens ⊆ input_tokens and reasoning_output_tokens ⊆
// output_tokens, so we subtract the overlaps to keep the buckets mutually exclusive.
function tokenUsageFromRecord(record: Record<string, unknown>): TokenUsage | undefined {
  const rawInput = numberField(record, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const rawOutput = numberField(record, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  if (rawInput === undefined || rawOutput === undefined) {
    return undefined;
  }
  const cachedInputTokens =
    numberField(record, ["cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens"]) ?? 0;
  const cacheCreationTokens =
    numberField(record, ["cache_creation_input_tokens", "cacheCreationTokens", "cache_creation_tokens"]) ?? 0;
  const reasoningOutputTokens = numberField(record, ["reasoning_output_tokens", "reasoningOutputTokens"]) ?? 0;
  // de-overlap: codex input includes cached
  const inputTokens = Math.max(0, rawInput - cachedInputTokens);
  // de-overlap: codex output includes reasoning
  const outputTokens = Math.max(0, rawOutput - reasoningOutputTokens);
  const totalTokens =
    numberField(record, ["total_tokens", "totalTokens"]) ??
    inputTokens + cachedInputTokens + cacheCreationTokens + outputTokens + reasoningOutputTokens;
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function failedResult(
  exitReason: "timeout" | "crashed" | "window_exhausted",
  telemetry: CodexEventTelemetry,
  gitState: Pick<WriterResult, "diff" | "commits">,
): WriterResult {
  return { ...gitState, exitReason, tokenUsage: telemetry.tokenUsage, telemetry };
}
