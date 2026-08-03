import type { SensitivityRule } from "./sensitivity.js";

// Cost / cost-safety sensitivity rules, split out of sensitivityRules.infra.ts to
// keep each file under the 500-line cap. Covers cost.resolved/failed and the
// BUDGET-SAFETY cost-misconfig events (cost.unattributed / cost.ceiling_unreachable).
// NONE carry a secret VALUE — a credential is named by its KIND/ref only (refKind
// is the secret-name-stripped path), so cost dollars + modes + counts are
// non-sensitive operational telemetry (public).
export const costSensitivityRules: SensitivityRule[] = [
  ...rulesFor("cost.resolved", [
    ["taskId", "public"],
    ["cli", "public"],
    ["provider", "public"],
    ["model", "public"],
    ["costUsd", "public"],
    ["notionalCostUsd", "public"],
    ["billingMode", "public"],
    ["costBasis", "public"],
  ]),
  ...rulesFor("cost.failed", [
    ["taskId", "public"],
    ["message", "public"],
  ]),
  // cost.unattributed (BUDGET-SAFETY C1) — refKind is the secret-free KIND label
  // (the credential-name segment stripped), reason is a fixed diagnosis string;
  // both safe to display to any project member. No secret value is carried.
  ...rulesFor("cost.unattributed", [
    ["taskId", "public"],
    ["cli", "public"],
    ["refKind", "public"],
    ["reason", "public"],
  ]),
  // cost.ceiling_unreachable (BUDGET-SAFETY M6) — refKind is secret-free, the
  // billing mode / ceiling / reason are non-sensitive config; all public.
  ...rulesFor("cost.ceiling_unreachable", [
    ["refKind", "public"],
    ["billingMode", "public"],
    ["ceilingUsd", "public"],
    ["reason", "public"],
  ]),
  // cost.ceiling_unenforceable (the codex→OpenRouter deadlock refusal) — refKind is
  // secret-free, cli/billingMode/reason are fixed enums, ceiling/detail/remedy are
  // non-sensitive config + diagnosis prose. No secret value; all public.
  ...rulesFor("cost.ceiling_unenforceable", [
    ["refKind", "public"],
    ["cli", "public"],
    ["billingMode", "public"],
    ["ceilingUsd", "public"],
    ["reason", "public"],
    ["detail", "public"],
    ["remedy", "public"],
  ]),
  // cost.route_unmeterable (standing metering limitation) — cli is a harness name,
  // refKind is the secret-free KIND label, reason is a closed enum and detail is a
  // fixed diagnosis string. No secret value; all public.
  ...rulesFor("cost.route_unmeterable", [
    ["cli", "public"],
    ["refKind", "public"],
    ["reason", "public"],
    ["detail", "public"],
  ]),
  // cost.generation_id_missing (harness-vocabulary drift) — cli is a harness name,
  // reason is a fixed diagnosis string; all public.
  ...rulesFor("cost.generation_id_missing", [
    ["cli", "public"],
    ["reason", "public"],
  ]),
  // cost.credit_rate_unknown (cost PR-C) — refKind is the secret-free KIND label,
  // creditsConsumed is an operational count, reason is a fixed diagnosis. No secret.
  ...rulesFor("cost.credit_rate_unknown", [
    ["refKind", "public"],
    ["creditsConsumed", "public"],
    ["reason", "public"],
  ]),
  // cost.overage_unobservable (cost PR-C) — provider/refKind/authoritativeSource are
  // secret-free identifiers, reason is a fixed diagnosis string; all public.
  ...rulesFor("cost.overage_unobservable", [
    ["provider", "public"],
    ["refKind", "public"],
    ["authoritativeSource", "public"],
    ["reason", "public"],
  ]),
  // cost.managed_metering_skipped (BYOK posture) — providerMode is a fixed enum,
  // reason is a fixed diagnosis string; no secret value. All public.
  ...rulesFor("cost.managed_metering_skipped", [
    ["providerMode", "public"],
    ["reason", "public"],
  ]),
  // cost.provider_capture_failed (silent-fallback hardening) — generationId is an
  // opaque OpenRouter id, detail is a bounded secret-free diagnostic tail, reason
  // is a fixed diagnosis. No secret value; all public operational telemetry.
  ...rulesFor("cost.provider_capture_failed", [
    ["generationId", "public"],
    ["detail", "public"],
    ["reason", "public"],
  ]),
  // cost.notional_unpriced (silent-fallback hardening) — provider/model/cli/taskId
  // are secret-free identifiers, reason is a fixed diagnosis string; all public.
  ...rulesFor("cost.notional_unpriced", [
    ["provider", "public"],
    ["model", "public"],
    ["cli", "public"],
    ["taskId", "public"],
    ["reason", "public"],
  ]),
  // cost.reconcile_failed (silent-fallback hardening) — basis/total/reason are
  // non-sensitive operational figures; no secret value. All public.
  ...rulesFor("cost.reconcile_failed", [
    ["basis", "public"],
    ["totalCostUsd", "public"],
    ["reason", "public"],
    ["reasonText", "public"],
  ]),
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
