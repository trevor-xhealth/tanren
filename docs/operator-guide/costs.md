# Costs

Tanren records every real Codex planner/writer/checker/auditor call in the
`cost_records` table. Two things matter, and they are kept separate:

- **Token accounting is mandatory.** Every call records its full, typed token
  breakdown (disjoint buckets — see below). A completed task without a
  `cost_records` row is an invariant violation.
- **Cost in dollars is best-effort.** When no reliable cost basis exists, the
  row stores `cost_usd = NULL` and `cost_basis = 'unknown'`. This is an HONEST,
  ALLOWED state — it does NOT fail the task or halt the run. There is no
  fabricated estimate.

## Disjoint token buckets

`cost_records` stores six mutually-exclusive token columns that sum to
`total_tokens`:

| Column                    | Meaning                                   |
| ------------------------- | ----------------------------------------- |
| `input_tokens`            | uncached prompt tokens                    |
| `cached_input_tokens`     | cache-read tokens                         |
| `cache_creation_tokens`   | cache-write/creation (Anthropic; 0 Codex) |
| `output_tokens`           | non-reasoning completion tokens           |
| `reasoning_output_tokens` | reasoning tokens                          |
| `total_tokens`            | provider total, else the sum of the five  |

Codex reports `cached_input_tokens ⊆ input_tokens` and
`reasoning_output_tokens ⊆ output_tokens` (inclusive); the Codex parser
de-overlaps these into the disjoint buckets so totals never double-count.

## Billing mode and cost basis

Two orthogonal axes describe each row:

| `billing_mode` | When                           | Credential prefix                                                                    |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| `per_token`    | token-billed API key           | `credential/openai-api/...`, `credential/anthropic/...`, `credential/openrouter/...` |
| `subscription` | server-enforced rolling window | `credential/codex/...`                                                               |
| `self_hosted`  | local GPU / fixed-fee endpoint | `credential/self-hosted/...`                                                         |

| `cost_basis`        | Meaning                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `provider_response` | the provider's OWN authoritative per-call charge (OpenRouter's `usage.cost`) — the REAL deduction |
| `ccusage`           | dollar figure from the ccusage tool (only when ccusage reports a positive `costUSD`)              |
| `credits`           | prepaid-credit drawdown reconciled to USD at the configured per-credential rate                   |
| `unknown`           | no reliable basis → `cost_usd IS NULL`                                                            |
| `unattributed`      | BUDGET-SAFETY C1: an unrecognized credential ref → `cost_usd IS NULL`, flagged loud               |

Real spend is a metered FACT: `cost_usd` is written only from a real-spend basis
(`provider_response` / `ccusage` / `credits`). There is **no** static list-rate
table — a per-token call with no captured fact records `cost_usd = NULL` /
`cost_basis = 'unknown'`. (The forecastable list-rate value lives separately on
`notional_cost_usd`, never on `cost_usd`.)

Subscription windows are **percent-of-window limits, not token budgets** — there
is no fixed token denominator, so subscription and self-hosted calls record
`cost_usd = NULL` / `cost_basis = 'unknown'`. We never invent a
"$20 / 50M tokens" estimate.

## Attribution rules

The recorder reads the adapter's `authRef` and classifies its `billing_mode`:

1. `credential/codex/...` → `subscription` (never per-token, even though the
   underlying provider is OpenAI).
2. `credential/anthropic/...`, `credential/openai-api/...`,
   `credential/openrouter/...` → `per_token`. A captured authoritative per-call
   charge yields `cost_basis = 'provider_response'`; a positive ccusage figure
   yields `'ccusage'`; with neither real-spend fact the row is `'unknown'`.
3. `credential/self-hosted/...` → `self_hosted` (cost unknown).
4. Anything else → `self_hosted` billing with `cost_basis = 'unknown'`. The
   recorder still writes the row; it never throws for missing cost.

## Usage monitors (codexbar + ccusage)

Two distinct tools observe usage, both run **runner-side over SSH** against the
per-run materialized `CODEX_HOME` (the orchestrator engine never spawns host
processes). Both are CLI/provider-agnostic and are always invoked with an
explicit provider/cli parameter:

- **codexbar** reports LIVE subscription-window state — one or more concurrent
  rolling windows (`primary`/`secondary`/`tertiary`) as percent-of-window
  consumed + reset time. There is no token denominator. Surfaced as
  `usage.window.observed`; a window at/over the pressure threshold surfaces as
  `usage.window.pressure`.
- **ccusage** reports token-consumption accounting (disjoint buckets, matching
  the cost schema) plus a best-effort `costUSD`. Surfaced as
  `usage.accounting.observed`. A subscription usually reports `costUSD: 0`;
  only a **positive** figure becomes a `cost_basis = 'ccusage'` cost — a zero
  is treated as NULL, never an invented estimate.

The runner image bundles both (pinned via the `CODEXBAR_VERSION` /
`CCUSAGE_VERSION` build args in `runner/Dockerfile`). Operators can eyeball the
tools against a host `CODEX_HOME` with `just usage [provider] [cli]`.

The monitors live in `services/orchestrator/src/engine/usage/` and the
planner/writer loop consumes them: `workflow/budgetPreflight.ts` checks the
subscription-window pressure before a subtask runs, and `workflow/subtaskLoop.ts`
threads the ccusage accounting through to the cost-basis on the recorded
`cost_records` row.

## When a dollar ceiling is required — and when it is refused

A tanren dollar ceiling is only meaningful over a route whose spend tanren can
meter. On a route it cannot meter (today: **any harness driving OpenRouter** —
the CLI discards the generation id, so `cost_usd` is NULL on every call), a
configured ceiling makes the budget gate latch permanently on the run's own
unpriced rows, so `runBudgetCeilingPreflight` **refuses the run at setup**. That
refusal is correct and stays.

`GET /orgs/:orgId/onboarding-status` therefore asks the *same* question the
refusal answers (`classifyCeilingEnforceability`) and reports it on
`budget.ceilingRequirement`:

| `ceilingRequirement` | Meaning | Effect on `ready` |
| --- | --- | --- |
| `required` | The org's default route meters real spend, so a ceiling is enforceable. | `ready:false` until `PUT /orgs/:orgId/budget` sets one. |
| `refused` | Tanren would refuse a ceiling on this route at run setup. | An **advisory**, not a step — `ready:true` with no ceiling. If a ceiling *is* set, that becomes a blocking step to **remove** it. |
| `undetermined` | No AI provider connected yet, so there is no route to judge. | No budget step; the connect-provider step already blocks. |

`budget.ceilingRequirementReason` always states which case applies and where
spend *is* bounded instead (for OpenRouter: the spend limit on the API key
itself, which OpenRouter enforces at the biller). The verdict is computed from
the **org's default** route; a project that overrides the routing table or its
own `defaultLlm` is judged on its own route when the run starts.

## Operational checks

- `SELECT cost_basis, COUNT(*) FROM cost_records GROUP BY cost_basis`. Every
  value must be one of `ccusage`, `provider_response`, `credits`, `unknown`,
  `unattributed`.
- `SELECT billing_mode, COUNT(*) FROM cost_records GROUP BY billing_mode`. Every
  value must be one of `per_token`, `subscription`, `self_hosted`.
- `SELECT t.task_id FROM tasks t LEFT JOIN cost_records c ON c.task_id = t.task_id
WHERE t.status = 'done' AND c.id IS NULL`. A successful task without a cost row
  is an invariant violation (token accounting is mandatory).
- `cost_usd IS NULL` rows are expected and fine for subscription/self-hosted
  calls.

## Notional rates (no pinned table)

`cost_usd` is only ever a metered FACT (`provider_response` / `ccusage` /
`credits`). There is **no** static per-provider list-rate table anywhere in the
cost engine. When a COMPUTED figure is needed — the notional/equivalent value on
`notional_cost_usd`, or a forward spec/DAG estimate — its rates come from a
vendored LiteLLM snapshot, not a hardcoded constant:

- `services/orchestrator/src/engine/costs/pricing/model_prices.json` is the
  vendored copy of LiteLLM's `model_prices_and_context_window.json` (the same
  per-model price data ccusage consumes: input / output / cache-read /
  cache-creation per model).
- `pricing/modelPriceSource.ts` loads that snapshot at import and exposes
  per-model rates keyed by model id. A model that is not in the snapshot resolves
  to `null` (loud-unknown) — never a fallback guess.

To update rates, refresh the snapshot rather than editing a constant:

```sh
just refresh-model-prices   # runs scripts/refresh-model-prices.mjs
```

Commit the refreshed `model_prices.json` with the upstream source date in the
commit message (see AGENTS.md "Version Verification").
