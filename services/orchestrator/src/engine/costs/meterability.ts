// ROUTE METERABILITY — can THIS run's (cli × credential) route ever produce a
// real-spend FACT for `cost_records.cost_usd`?
//
// This is the single place tanren writes down what it can and cannot meter, and
// the single thing to delete when a harness gains the capability it lacks. It is
// deliberately a CAPABILITY question, not a pricing question: `sources.ts` decides
// what a captured fact MEANS, this decides whether a fact can exist at all.
//
// WHY IT EXISTS. `engine/dag/budgetGate.ts` fails CLOSED on any NULL-cost
// `per_token` row (BUDGET-SAFETY C1b) — correctly: spend it cannot count must not
// run under a ceiling. But a route with NO capture path produces NOTHING BUT such
// rows, so the gate latches permanently on the run's OWN rows and raising the
// ceiling cannot clear it. Knowing the route is unmeterable BEFORE the first call
// is what lets the run fail loud at setup instead of deadlocking mid-flight.
//
// THE CODEX CASE (the reason this file exists). Tanren routes every agent role
// through `codex exec --json` pointed at OpenRouter. OpenRouter puts both the
// generation id and the real per-call `usage.cost` on the wire — verified by a
// MITM capture of codex's own `base_url`:
//   {"type":"response.completed","response":{"id":"gen-1785730085-…",
//    "usage":{"cost":0.0011782784}}}
// The codex CLI re-emits its OWN event vocabulary and discards that envelope
// entirely. Verbatim from codex-cli 0.145.0:
//   {"type":"thread.started","thread_id":"019fc5dc-…"}
//   {"type":"item.completed","item":{"id":"item_0",…}}      ← an ORDINAL, not an
//                                                             upstream item id
//   {"type":"turn.completed","usage":{"input_tokens":17665,…}}  ← tokens, NO cost
// The same absence holds on codex's rollout session log and its OTEL events. So
// `providers/openRouterGenerationId.ts` finds nothing on 100% of codex calls, and
// by its own contract every such call records cost_usd = NULL.
//
// See docs/_design/openrouter-cost-attribution.md for the full evidence and the
// options that were rejected (a token→dollar estimate violates the REAL-SPEND-IS-
// A-FACT doctrine; time-correlation against OpenRouter's APIs is a guess wearing a
// fact's clothing; a metering shim is the fallback if upstream declines).

import { providerSlugForRef } from "../credentials/credentialType.js";
import { classifyAuthRef } from "./sources.js";

/**
 * The CLI harnesses that surface a provider generation id on their telemetry, so
 * `costs/generationCostCapture.ts` has an id to query `/api/v1/generation` with.
 *
 * EMPTY, and that is the finding — not an oversight. Every harness tanren drives
 * re-emits its own event vocabulary. The moment one surfaces the upstream id, add
 * it here and the whole capture path (already built and tested) starts working
 * unmodified.
 */
const HARNESSES_SURFACING_GENERATION_ID: ReadonlySet<string> = new Set([]);

/** The codex version the id-loss above was verified against, so the claim is dated. */
export const CODEX_VERSION_VERIFIED_WITHOUT_GENERATION_ID = "0.145.0";

/**
 * Why a route can produce no real-spend fact. A CLOSED set — an unmeterable route
 * must always be able to say WHICH known limitation it hit, never "unknown".
 *
 *  - `harness_discards_generation_id` — the provider (OpenRouter) reports the real
 *    per-call cost, but the CLI harness drops the generation id needed to fetch it.
 *    Fixable ONLY upstream in the harness.
 *  - `byok_upstream_invoice` — a raw provider key (`credential/anthropic/`,
 *    `credential/openai-api/`) whose real charge lands on the tenant's upstream
 *    invoice, which tanren cannot read. No provider surface returns a per-call
 *    dollar figure for these at all.
 */
export type UnmeterableReason = "harness_discards_generation_id" | "byok_upstream_invoice";

/**
 * How (or whether) a route's real spend reaches `cost_usd`.
 *
 *  - `provider_response` — a per-call FACT is capturable now (the harness surfaces
 *    the generation id and the credential's biller reports a per-call charge).
 *  - `run_reconcile` — no per-call fact, but a run-end probe (ccusage / credit
 *    drawdown) back-fills real dollars across the run's rows. Rows are NULL DURING
 *    the run, which is why this still does not make an in-run ceiling enforceable
 *    on its own — see `enforceable` below.
 *  - `unmeterable` — no path at all; every row stays NULL forever.
 */
export type RouteMetering =
  | { kind: "provider_response" }
  | { kind: "run_reconcile" }
  | { kind: "unmeterable"; reason: UnmeterableReason; detail: string };

export interface RouteMeteringInput {
  /** The harness that will make the calls (the writer's cli — the spend-bearing role). */
  cli: string;
  /** The run's primary LLM credential ref (the writer's authRef). Never the secret value. */
  authRef: string;
  /** Whether a run-end usage probe (ccusage / credit drawdown) covers THIS credential. */
  hasUsageProbe: boolean;
}

/**
 * Resolve how a route's real spend can reach `cost_usd`.
 *
 * Order matters. A run-end probe is consulted FIRST for the billing modes it
 * actually covers (subscription / self-hosted, where ccusage + credit drawdown are
 * the only real-spend sources) — that is the pre-existing, working path. A
 * `per_token` credential is then asked the capability question: is there a
 * per-call capture for it, or is it structurally unmeterable?
 *
 * An UNRECOGNIZED ref is deliberately NOT classified here. It is a MISCONFIGURATION
 * (`billing_mode='unattributed'`, BUDGET-SAFETY C1) with its own loud path; calling
 * it "unmeterable" would relabel a config error as a platform limitation.
 */
export function resolveRouteMetering(input: RouteMeteringInput): RouteMetering {
  const classification = classifyAuthRef(input.authRef);
  if (classification.billingMode === "per_token") {
    return perTokenMetering(input);
  }
  // subscription / self_hosted / absent / unrecognized: a probe is the only real-
  // spend source, and its absence is the SEPARATE "unreachable ceiling" failure
  // (budgetPreflight M6) — not a metering-capability limitation.
  return { kind: "run_reconcile" };
}

/**
 * A token-billed credential. Real spend exists and is being incurred, so the
 * question is purely whether tanren can OBSERVE it per call.
 */
function perTokenMetering(input: RouteMeteringInput): RouteMetering {
  const slug = providerSlugForRef(input.authRef);
  if (slug === "openrouter") {
    // OpenRouter is the ONLY provider that reports a real per-call charge — but
    // only against a generation id, which the harness must surface.
    if (HARNESSES_SURFACING_GENERATION_ID.has(input.cli)) {
      return { kind: "provider_response" };
    }
    return {
      kind: "unmeterable",
      reason: "harness_discards_generation_id",
      detail:
        `OpenRouter reports the real per-call cost inline (response.id = 'gen-…', usage.cost), but the ` +
        `${input.cli} CLI re-emits its own event vocabulary and discards the upstream response envelope ` +
        `(verified against codex-cli ${CODEX_VERSION_VERIFIED_WITHOUT_GENERATION_ID}: turn.completed carries ` +
        `token counts only, item ids are local ordinals, and no response/generation id appears on stdout, ` +
        `the rollout session log, or the OTEL events). With no generation id there is nothing to query ` +
        `/api/v1/generation with, so every call records cost_usd = NULL — real spend is a FACT or it is ` +
        `unknown, never a list-rate guess`,
    };
  }
  // A raw upstream-provider key: the charge lands on the tenant's own provider
  // invoice, which tanren has no read path to. No provider surface offers a
  // per-call dollar figure here, so this is unmeterable BY THE PROVIDER, not by
  // the harness — a different limitation with a different (absent) fix.
  return {
    kind: "unmeterable",
    reason: "byok_upstream_invoice",
    detail:
      `a raw ${slug ?? "provider"} API key is billed on the tenant's own upstream invoice, which tanren ` +
      `cannot read; no per-call dollar figure is returned by the provider, so cost_usd stays NULL`,
  };
}

/**
 * Whether an in-run DOLLAR CEILING can actually be enforced over this route.
 *
 * ONLY a per-call fact qualifies. A `run_reconcile` route prices its rows at run
 * END, so during the run every row is NULL and the gate's fail-closed
 * `unpriced_spend` would latch anyway — EXCEPT that ccusage/credit routes are
 * `subscription`/`self_hosted`, whose NULL rows the gate deliberately does NOT
 * count (only `per_token` / `unattributed` NULLs are unpriced). So a reconcile
 * route IS enforceable; an unmeterable `per_token` route is not.
 */
export function isCeilingEnforceable(metering: RouteMetering): boolean {
  return metering.kind !== "unmeterable";
}
