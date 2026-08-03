/**
 * Integrations display formatters — pure string helpers for the two-plane panel.
 * Guard null/unknown so an uncomputable figure never renders a fabricated zero
 * or a leaked secret.
 */

import type { OrgIntegrationSummary } from "../../api/integrations.js";

/** Human label for a provider kind. Unknown kinds pass through. */
export function providerLabel(providerKind: string): string {
  switch (providerKind) {
    case "sentry":
      return "sentry";
    case "slack":
      return "slack";
    case "linear":
      return "linear";
    case "deploy.vercel":
      return "deploy · vercel";
    case "deploy.flyio":
      return "deploy · fly.io";
    default:
      return providerKind;
  }
}

/** Short status chip text. Unknown statuses pass through; never invents "ok". */
export function statusLabel(status: string | undefined): string {
  if (status === undefined || status === "") return "—";
  return status;
}

/** True when the org grant list includes this provider kind as linked. */
export function isProviderLinked(
  integrations: readonly OrgIntegrationSummary[] | undefined,
  providerKind: string,
): boolean {
  if (integrations === undefined) return false;
  return integrations.some(
    (row) => row.providerKind === providerKind && row.connectionStatus === "active" && row.grantStatus === "active",
  );
}

/** Capability list joined for a grant card, or "—" when empty. */
export function capabilitiesLabel(capabilities: readonly string[] | undefined): string {
  if (capabilities === undefined || capabilities.length === 0) return "—";
  return capabilities.join(" · ");
}
