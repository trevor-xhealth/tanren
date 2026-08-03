import type { WatchdogProgressSignal } from "../contracts/commandSubstrate.js";

// Token consumption by TYPE. Disjoint buckets — never fold into one number.
// All buckets are mutually exclusive and sum to totalTokens.
export interface TokenUsage {
  // uncached prompt tokens
  inputTokens: number;
  // cache-read tokens
  cachedInputTokens: number;
  // cache-write/creation (Anthropic; 0 for Codex)
  cacheCreationTokens: number;
  // non-reasoning completion tokens
  outputTokens: number;
  // reasoning tokens
  reasoningOutputTokens: number;
  // provider-reported total, else sum of the five
  totalTokens: number;
  // The provider's generation/response id, when the managed adapter surfaced one
  // (codex/claude/opencode response streams carry a top-level id when routed
  // THROUGH OpenRouter). Threaded to the cost recorder so a managed OpenRouter run
  // can post-call query `/api/v1/generation` for the REAL `usage.cost` and record
  // cost_usd as a metered FACT (`provider_response`). Absent on BYOK / non-managed
  // calls (no id surfaced) → cost_usd stays NULL/`unknown` (no list-rate estimate).
  openRouterGenerationId?: string;
}

// Zero-token usage with the full disjoint shape — used as the default when an
// adapter does not report usage (e.g. fake fixtures).
export const emptyTokenUsage: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

export interface Commit {
  sha: string;
  message: string;
}

export interface WriterResult {
  diff: string;
  commits: Commit[];
  // `window_exhausted`: the provider authenticated successfully but the
  // subscription window / usage quota is spent (PROJECT_BRIEF §4.3). This is
  // an expected, recoverable condition — distinct from `crashed` — so the
  // workflow can escalate it as window pressure rather than a hard failure.
  // `timeout`: the agent exec did not finish — the activity watchdog surfaced a
  // genuine absence of all signs of life (a recoverable stall), NOT a wall-clock
  // kill. (The name is the durable workflow/event classification for "did not
  // complete"; the SUBSTRATE-level no-progress flag is `CommandResult.stalled`.)
  exitReason: "completed" | "timeout" | "crashed" | "token_limit" | "window_exhausted";
  tokenUsage?: TokenUsage;
  telemetry?: {
    rawEventCount: number;
    tokenUsage?: TokenUsage;
    usageLimit?: UsageLimitSignal;
  };
}

// UsageLimitSignal is parsed from the Codex JSONL `turn.failed` / `error`
// event when the account hits its usage limit. Carries the provider's
// human-readable message (which usually names the reset time) so the
// operator gets an actionable signal instead of a generic crash.
export interface UsageLimitSignal {
  message: string;
}

export interface WriterAdapter {
  readonly kind: "writer";
  readonly cli: "claude" | "codex" | "opencode" | "aider" | "pi" | "reasonix" | "fake";
  // authRef is the credential reference that this adapter will use at call
  // time. The orchestrator reads it at task completion to attribute the
  // resulting cost record to one of the three v0 cost models.
  // Adapters that do not consume an LLM (e.g. fake fixtures) still declare
  // an authRef so the CostRecorder can run uniformly.
  readonly authRef: string;
  // The REAL model id this adapter sends — the id the recorder writes to
  // `cost_records.model` and the NOTIONAL price source looks up. Each adapter
  // resolves it the same way the exec/config path does (e.g. codex's
  // OpenRouter-namespaced `openai/gpt-5.6-luna` on the config.toml paths vs the bare
  // `gpt-5.6-luna` on the direct paths), so the recorded id is what was actually
  // requested. OPTIONAL by design: the ~40 test fixtures implementing this interface
  // legitimately have no model, and the recorder already treats an absent/empty
  // model as the honest "notional NULL, stay quiet" path — so a fixture needs no
  // change and can never be mistaken for a priced call.
  readonly model?: string;
  // `baseSha` is the run's BASE commit (the clone point / base-branch tip),
  // captured once after the workspace clone. When provided, the adapter diffs
  // the workspace against it so each subtask is judged against the CUMULATIVE
  // state vs the run base — not the per-subtask HEAD delta. This makes a
  // no-op-but-already-satisfied subtask (e.g. a replanned "create FILE" whose
  // work a prior subtask already committed) still show the file in its diff, so
  // the checker passes instead of false-rejecting an empty per-iteration delta.
  // The production run path always threads it; fake test adapters ignore it.
  //
  // `onWatchdogProgress` is the CROSS-LAYER sign-of-life bridge (task #24, apex
  // v52/v53): each writer adapter forwards it to `buildActivityWatchdog` so the
  // substrate invokes it on every probe tick the work signature advances. The
  // writerStage binds a closure that emits `writer.subtask.progress` — a durable
  // per-tick advancement signal any parent progress reader can observe. Composes
  // with the substrate-internal `MIN_NON_ADVANCING_NEIGHBOR_REPEATS_*` streak floor
  // (ssh/watchdogProgress.ts) — a wedge fires only after N consecutive
  // identical-neighbor probe pairs, so a legitimately slow writer (a `pnpm install`
  // window) whose signature briefly plateaus does not trip a spurious wedge.
  // Optional; fake test adapters ignore it.
  runWriter(opts: {
    prompt: string;
    workspace: string;
    baseSha?: string;
    onWatchdogProgress?: (signal: WatchdogProgressSignal) => void;
  }): Promise<WriterResult>;
}

export interface AnswererRunOptions<TOutput> {
  prompt: string;
  workspace?: string;
  outputSchema: {
    name: string;
    jsonSchema: Record<string, unknown>;
    parse(value: unknown): TOutput;
  };
}

export interface AnswererAdapter<TOutput> {
  readonly kind: "answerer";
  readonly cli: "claude" | "codex" | "fake";
  // See WriterAdapter.authRef: attribution applies uniformly to
  // every real Codex planner/writer/checker/auditor call.
  readonly authRef: string;
  // The REAL model id this adapter sends — see WriterAdapter.model.
  readonly model?: string;
  runAnswerer(opts: AnswererRunOptions<TOutput>): Promise<TOutput>;
  // The token telemetry parsed from the MOST RECENT runAnswerer call's harness
  // output (codex/claude emit per-call usage in their JSONL/stream-json events),
  // or undefined when the call surfaced none. The cost path reads this right
  // after the awaited call (same adapter instance) to record the REAL per-call
  // TokenUsage — so notional cost is computed from actual tokens (LiteLLM rates)
  // INDEPENDENT of the separate codexbar/ccusage window probe. Absent on a `fake`
  // fixture (legitimately zero-token). A real call that returns undefined here is
  // genuine token-telemetry breakage → the loud `usage.token_accounting_failed`.
  lastTokenUsage?(): TokenUsage | undefined;
}
