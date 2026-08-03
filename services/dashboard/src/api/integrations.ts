/**
 * Org integrations two-plane response types. Kept in their own module (not the
 * shared `types.ts` / `orchestrator.ts`) so the surface owns its contract and
 * the product client stays under the 500-line cap. Mirrors the orchestrator
 * routes under `routes/integrations/index.ts`.
 *
 * Plane A — org grants (`GET/POST /orgs/:orgId/integrations…`): link a provider
 * once. Credential REF names + metadata KEYS only — never secret values.
 *
 * Plane B — project capability enable (`POST …/provision`, `GET …/discover`):
 * enable sentry/slack/deploy for a project from the org grant. `not_linked` is
 * a structured **200** (branch on `body.status`), never a crash.
 */

/** A single org grant as returned by `GET /orgs/:orgId/integrations`. */
export interface OrgIntegrationSummary {
  connectionId: string;
  grantId?: string;
  orgId: string;
  providerKind: string;
  providerPrincipalId: string;
  principalKind: string;
  displayName: string;
  health: string;
  connectionStatus: string;
  currentAuthGeneration?: number;
  grantGeneration?: number;
  grantStatus?: string;
  authExpiresAt?: string;
  providerScopes: string[];
  pendingOperation?: { operationId: string; stage: string; status: string };
  selectedForProject: boolean;
}

export interface IntegrationLifecycleInventory {
  projectId: string;
  requirements: { total: number; needsAttention: number };
  capabilityNodes: { total: number; awaitingGrant: number; ready: number; needsAttention: number };
  bindings: { total: number; ready: number; drifted: number; needsAttention: number };
  deliveries: { total: number; completed: number; degraded: number; needsAttention: number };
}

/** `GET /orgs/:orgId/integrations` envelope. */
export interface OrgIntegrationsList {
  integrations: OrgIntegrationSummary[];
  lifecycle?: IntegrationLifecycleInventory;
}

/**
 * Structured outcomes of provision / discover. Callers MUST branch on
 * `status` — `not_linked` is a successful 200, not an error.
 */
export interface NotLinkedOutcome {
  status: "not_linked";
  capability?: string;
  providerKind: string;
  message?: string;
  linkAffordance?: {
    kind: string;
    providerKind: string;
    orgId: string;
  };
}

export interface LinkedProvisionOutcome {
  status: "provisioned";
  capability?: string;
  providerKind?: string;
  /** Opaque refs / surface ids — never secret material. */
  [key: string]: unknown;
}

export interface GrantSelectionCandidate {
  connectionId: string;
  grantId: string;
  providerKind: string;
  providerPrincipalId: string;
  displayName?: string;
  ineligibilityReasons?: string[];
  health: string;
  authGeneration: number;
  grantGeneration: number;
}

export interface SelectionRequiredOutcome {
  status: "selection_required";
  capability?: string;
  providerKind: string;
  reason: "selection_missing" | "multiple_eligible" | "selected_grant_unavailable";
  message?: string;
  candidates: GrantSelectionCandidate[];
}

export type ProvisionOutcome = NotLinkedOutcome | SelectionRequiredOutcome | LinkedProvisionOutcome;

export interface DiscoverOutcome {
  status: string;
  capability?: string;
  providerKind?: string;
  resources?: unknown[];
  message?: string;
  reason?: SelectionRequiredOutcome["reason"];
  candidates?: GrantSelectionCandidate[];
  linkAffordance?: {
    kind: string;
    providerKind: string;
    orgId: string;
  };
}

/** Sanitized multi-principal candidate — never secret refs or generations. */
export interface PrincipalSelectionCandidate {
  providerPrincipalId: string;
  principalKind: string;
  displayName: string;
  metadata?: Record<string, string>;
}

export const PUBLIC_LINK_OP_STATUSES = [
  "awaiting_principal_selection",
  "provider_unavailable",
  "verification_in_progress",
  "finalize_pending",
  "activate_pending",
  "completed",
  "failed",
  "malformed",
  "unknown",
] as const;

export type PublicLinkOpStatus = (typeof PUBLIC_LINK_OP_STATUSES)[number];

export interface LinkOperationRead {
  operationId: string;
  providerKind: string;
  connectionId?: string;
  operationKind: string;
  status: string;
  stage: string;
  publicStatus: PublicLinkOpStatus;
  candidates: PrincipalSelectionCandidate[];
  failureClassification?: string;
  retryAfter?: string;
}

/** Result of POST link — refs only; never tokens/generation display authority. */
export interface LinkOutcome {
  status: string;
  providerKind?: string;
  operationId?: string;
  operationUrl?: string;
  connectionId?: string;
  grantId?: string;
  authGeneration?: number;
  grantGeneration?: number;
  capabilities?: string[];
  metadataKeys?: string[];
  candidates?: PrincipalSelectionCandidate[];
  reason?: string;
  displayName?: string;
  providerPrincipalId?: string;
  idempotentReplay?: boolean;
}

export interface SelectPrincipalOutcome {
  status: string;
  operationId?: string;
  connectionId?: string;
  providerPrincipalId?: string;
  reason?: string;
  error?: string;
}

export interface SelectGrantOutcome {
  status: "selected";
  providerKind: string;
  connectionId: string;
  grantId: string;
  providerPrincipalId: string;
  displayName?: string;
  ineligibilityReasons?: string[];
  authGeneration: number;
  grantGeneration: number;
}

/**
 * Provider kinds the two-plane UI can link at org level.
 * Hetzner is the allocator plane — NOT this surface.
 */
export const LINKABLE_PROVIDER_KINDS = ["sentry", "slack", "linear", "deploy.vercel", "deploy.flyio"] as const;

/**
 * Capabilities the project-enable plane exposes. Deploy requires an explicit
 * `deploy.vercel` / `deploy.flyio` providerKind (no single default).
 */
export const PROJECT_CAPABILITIES = [
  { capability: "errors", label: "error tracking", providerKind: "sentry", glyph: "×" },
  { capability: "notify", label: "slack notify", providerKind: "slack", glyph: "✉" },
  { capability: "issues", label: "linear intake", providerKind: "linear", glyph: "≡" },
  {
    capability: "deploy",
    label: "deploy · vercel",
    providerKind: "deploy.vercel",
    glyph: "↗",
  },
  {
    capability: "deploy",
    label: "deploy · fly.io",
    providerKind: "deploy.flyio",
    glyph: "↗",
  },
] as const;
