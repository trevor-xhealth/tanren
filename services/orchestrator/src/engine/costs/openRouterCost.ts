// openRouterCost — the post-call query that captures OpenRouter's OWN
// authoritative per-call charge, the only provider surface that hands back a
// REAL-dollar figure per generation.
//
// WHAT OPENROUTER RETURNS. After a completion, OpenRouter exposes the actual
// amount it deducted from the account balance via
// `GET /api/v1/generation?id=<generationId>`:
//   - `total_cost`         — the REAL charge in credits/USD for that generation,
//                            computed by OpenRouter from the provider's native
//                            token usage with NO inference markup, so it ≈ the
//                            real provider charge. This is what we want.
//   - `usage`              — OpenRouter's own usage figure (informational).
//   - `cache_discount`     — any cache savings already folded into total_cost.
// The same figure rides on a streamed/non-streamed completion's `usage.cost`
// when `usage: { include: true }` is requested; this client is the post-call
// fetch for the (common) case where the harness only learns the generation id
// afterward. It feeds `CostRecorder.record`'s `realProviderCostUsd` →
// cost_basis `provider_response`, which OUTRANKS the static rate table.
//
// REACHABILITY TODAY (honest gap, see CostRecordContext.realProviderCostUsd and
// costs/meterability.ts): tanren runs models through CLI adapters
// (codex/aider/pi/opencode) that do NOT surface OpenRouter's generation id in their
// output — verified against codex-cli 0.145.0, whose `exec --json` stream re-emits
// its own vocabulary and discards the upstream response envelope entirely. So there
// is no id to query per call right now. This client is the REAL, tested capture path
// the moment a harness surfaces that id; until then an OpenRouter per_token row with
// no captured charge records cost_usd NULL with cost_basis 'unknown' — real spend is
// a metered FACT, NEVER a list-rate estimate.
//
// OPENROUTER-BYOK CAVEAT (now DATA-DRIVEN). When the tenant has attached their own
// UPSTREAM provider keys inside OpenRouter, OpenRouter charges only a routing fee —
// the real inference cost lands on the upstream provider's invoice — so `total_cost`
// is NOT the full real spend and must never be recorded as the real deduction (it
// would UNDER-count against a ceiling).
//
// This used to be decided by a caller-declared `billingModel: 'platform' | 'byok'`
// flag, which the run wiring fed from tanren's OWN sense of "BYOK" (the tenant's
// credential vs the platform's) — a completely different question, and therefore a
// guess wearing a fact's clothing. It is now read from OpenRouter's OWN report:
// `cost_details.upstream_inference_cost` is documented as 0/null for a non-BYOK
// request and positive when an upstream provider did the billing. A positive value
// FLAGS the row `upstreamBilled` and disqualifies it as authoritative real spend.

// One generation's cost as OpenRouter reports it. `totalCostUsd` is what OpenRouter
// charged the account; `upstreamBilled` marks a generation whose real inference cost
// was billed by an UPSTREAM provider (OpenRouter-BYOK), so `totalCostUsd` is only a
// routing fee and NOT the authoritative real spend.
export interface OpenRouterGenerationCost {
  generationId: string;
  totalCostUsd: number;
  upstreamBilled: boolean;
  /**
   * OpenRouter's reported upstream-provider charge for this generation
   * (`cost_details.upstream_inference_cost`), when positive. Null when OpenRouter
   * itself was the biller (the ordinary case) — the evidence behind
   * `upstreamBilled`, kept so a caller can narrate WHY a figure was refused.
   */
  upstreamInferenceCostUsd: number | null;
}

// The injectable transport (mirrors the inbox connectors' HttpClient shape) so
// tests drive it with a fake — no live OpenRouter key, no network.
export interface OpenRouterHttpRequest {
  method: "GET";
  path: string;
  token: string;
  baseUrl: string;
}

export interface OpenRouterHttpResponse {
  status: number;
  body: unknown;
}

export interface OpenRouterHttpClient {
  request(input: OpenRouterHttpRequest): Promise<OpenRouterHttpResponse>;
}

export interface OpenRouterCostQueryInput {
  // The generation id from the completion (OpenRouter's response `id`). The CLI
  // adapters do not surface this yet — see this module's REACHABILITY note.
  generationId: string;
  // The resolved OpenRouter API key (the platform key for managed, the tenant's
  // for a tenant-imported OpenRouter credential). Either way, whoever owns this key
  // is the party OpenRouter bills — so no caller-declared billing-model flag is
  // needed or accepted: whether an UPSTREAM provider did the billing instead is read
  // from OpenRouter's own `cost_details.upstream_inference_cost` on the response.
  token: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

// queryGenerationCost fetches one generation's REAL OpenRouter charge. Returns
// the cost when OpenRouter reports a positive `total_cost`, else null (an absent/
// non-positive figure is an honest no-capture — NEVER a fabricated $0). Throws on
// a non-200 so a transport/auth failure is LOUD, not a silent miss.
export async function queryGenerationCost(
  client: OpenRouterHttpClient,
  input: OpenRouterCostQueryInput,
): Promise<OpenRouterGenerationCost | null> {
  if (input.generationId === "") {
    throw new Error("openRouterCost: generationId is required");
  }
  const baseUrl = input.baseUrl ?? DEFAULT_BASE_URL;
  const response = await client.request({
    method: "GET",
    path: `/generation?id=${encodeURIComponent(input.generationId)}`,
    token: input.token,
    baseUrl,
  });
  if (response.status !== 200) {
    throw new Error(`openRouterCost: query failed (status ${response.status}) for generation ${input.generationId}`);
  }
  const row = generationRow(response.body);
  const totalCostUsd = positiveNumberField(row, ["total_cost", "cost"]);
  if (totalCostUsd === null) {
    return null;
  }
  // OPENROUTER-BYOK, read from OpenRouter's OWN report rather than a caller flag:
  // a positive upstream inference cost means an upstream provider billed the real
  // inference and OpenRouter charged only a routing fee, so `total_cost` is NOT the
  // authoritative real deduction.
  const upstreamInferenceCostUsd = positiveNumberField(costDetails(row), [
    "upstream_inference_cost",
    "upstreamInferenceCost",
  ]);
  return {
    generationId: input.generationId,
    totalCostUsd,
    upstreamBilled: upstreamInferenceCostUsd !== null,
    upstreamInferenceCostUsd,
  };
}

// The authoritative real-spend figure to record as `provider_response`, or null
// when none is available. An UPSTREAM-BILLED figure is DELIBERATELY null here: its
// total_cost is a routing fee, not the upstream bill, so it must NOT set real spend
// (it would undercount the actual charge). Only a figure OpenRouter itself billed in
// full is the real deduction.
export function realProviderCostFrom(cost: OpenRouterGenerationCost | null): number | null {
  if (cost === null || cost.upstreamBilled) {
    return null;
  }
  return cost.totalCostUsd > 0 ? cost.totalCostUsd : null;
}

// The generation row inside a `/api/v1/generation` body. OpenRouter wraps it under
// `data`; a bare body is tolerated so a future unwrapped shape still parses.
function generationRow(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const data = record["data"];
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : record;
}

// The `cost_details` sub-object (the per-generation cost breakdown), or null.
function costDetails(row: Record<string, unknown> | null): Record<string, unknown> | null {
  const details = row?.["cost_details"] ?? row?.["costDetails"];
  return typeof details === "object" && details !== null ? (details as Record<string, unknown>) : null;
}

// The first POSITIVE finite number under any of `keys`. Tolerant by contract: a
// missing/non-finite/non-positive figure → null (an honest no-capture, never a
// fabricated $0 and never a negative treated as a charge).
function positiveNumberField(row: Record<string, unknown> | null, keys: ReadonlyArray<string>): number | null {
  if (row === null) {
    return null;
  }
  for (const key of keys) {
    const candidate = row[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return null;
}
