import { z } from "zod";

// Loud cost-observability failures remain separate from the substrate schemas so
// that both domains retain room for future fail-closed payload additions.
export const CostProviderCaptureFailedPayload = z
  .object({
    generationId: z.string(),
    detail: z.string(),
    reason: z.string(),
  })
  .strict();

export const CostNotionalUnpricedPayload = z
  .object({
    provider: z.string(),
    model: z.string(),
    cli: z.string(),
    taskId: z.string(),
    reason: z.string(),
  })
  .strict();

// The CLOSED set of reasons a route can produce no real-spend FACT. Mirrors
// `costs/meterability.ts` UnmeterableReason — an unmeterable route must always name
// WHICH known limitation it hit, never "unknown".
const UnmeterableReason = z.enum(["harness_discards_generation_id", "byok_upstream_invoice"]);

// cost.route_unmeterable — emitted ONCE at run setup, ceiling or no ceiling,
// whenever the run's (cli × credential) route can produce no per-call real-spend
// fact. Without it an operator on an unbudgeted project has no signal that
// `cost_usd` will be NULL for the whole run until a spend report reads $0.
export const CostRouteUnmeterablePayload = z
  .object({
    cli: z.string(),
    // The SAFE ref-kind label (leading path segments, secret name stripped).
    refKind: z.string(),
    reason: UnmeterableReason,
    // The secret-free evidence for the limitation (which layer drops what).
    detail: z.string(),
  })
  .strict();

// cost.ceiling_unenforceable — a configured dollar ceiling over a per_token route
// with NO real-spend capture. Every call lands cost_usd = NULL / per_token, which
// the budget gate counts as unpriced and fails CLOSED on; because the rows are the
// run's OWN, raising the ceiling cannot clear the pause. The run is refused at
// SETUP instead of deadlocking mid-flight, and `remedy` names the fix that works.
export const CostCeilingUnenforceablePayload = z
  .object({
    refKind: z.string(),
    cli: z.string(),
    billingMode: z.string(),
    ceilingUsd: z.number().nonnegative(),
    reason: UnmeterableReason,
    detail: z.string(),
    remedy: z.string(),
  })
  .strict();

// cost.generation_id_missing — DRIFT DETECTION in the other direction: a route
// classified METERABLE made a real call that surfaced no generation id, so the
// per-call capture silently could not fire. Emitted once per run so a harness
// vocabulary change is LOUD rather than a quiet reversion to NULL cost.
export const CostGenerationIdMissingPayload = z
  .object({
    cli: z.string(),
    reason: z.string(),
  })
  .strict();

export const CostReconcileFailedPayload = z
  .object({
    basis: z.enum(["ccusage", "credits"]),
    totalCostUsd: z.number(),
    reason: z.enum(["no_rows", "zero_token_denominator"]),
    reasonText: z.string(),
  })
  .strict();
