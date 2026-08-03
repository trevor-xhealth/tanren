// candidate inbox: typed contracts for the intake → triage flow.
//
// A configurable SOURCE (connector kind + config) ingests CANDIDATES. Each
// external candidate is TRIAGED by Forge (dedupe → match-to-spec/milestone →
// propose DAG placement → verdict). System sources (e.g. scheduled audits)
// carry `autoRoute` and skip manual triage. The triage itself runs over an
// injectable answerer seam (mirrors the conversation answerer) so the Forge call is
// mockable and nothing here couples to a provider.

import { z } from "zod";
import { SpecPriority } from "../../state/spec.js";
import { assertNoSourceCredentialOverride, resolveIssuesProvider } from "./connectorErrors.js";

// The connector kinds — mirror the hi-fi `INBOX_SOURCES` glyph keys. `system`
// and `scheduled_audit` are the auto-routing system sources.
export const SourceKind = z.enum(["issues", "errors", "system", "manual", "scheduled_audit"]);
export type SourceKind = z.infer<typeof SourceKind>;

export const InboxSourceState = z.enum(["active", "needs_attention"]);
export type InboxSourceState = z.infer<typeof InboxSourceState>;

/** Durable, sanitized reason an external source requires operator repair. */
export const InboxSourceAttention = z
  .object({
    code: z.enum([
      "unsupported_provider",
      "invalid_config",
      "credential_unavailable",
      "authority_unavailable",
      "resource_unavailable",
    ]),
    message: z.string().min(1).max(300),
    observedAt: z.string().datetime(),
  })
  .strict();
export type InboxSourceAttention = z.infer<typeof InboxSourceAttention>;

/** The sole active persisted shape for a GitHub issues source. */
export const ActiveGitHubIssuesConfig = z
  .object({
    owner: z.string().trim().min(1),
    repo: z.string().trim().min(1),
    labels: z.array(z.string().trim().min(1)),
    pollIntervalMs: z.number().int().positive().optional(),
  })
  .strict();
export type ActiveGitHubIssuesConfig = z.infer<typeof ActiveGitHubIssuesConfig>;

/**
 * The sole active persisted shape for a Linear issues source.
 *
 * `provider` is REQUIRED and is the discriminator the `issues` kind dispatches on
 * (see `resolveIssuesProvider`). `teamKey` is the Linear team key — e.g. `ENG` in
 * `ENG-412` — and doubles as the grant's `resourceId`, so the organization's
 * integration selection scopes intake to exactly the teams it authorized. There is
 * NO credential coordinate here: the token is resolved per fetch from the org's
 * Linear integration grant.
 */
export const ActiveLinearIssuesConfig = z
  .object({
    provider: z.literal("linear"),
    teamKey: z.string().trim().min(1),
    labels: z.array(z.string().trim().min(1)),
    pollIntervalMs: z.number().int().positive().optional(),
  })
  .strict();
export type ActiveLinearIssuesConfig = z.infer<typeof ActiveLinearIssuesConfig>;

/** Either canonical `issues` shape, discriminated by the presence of `provider`. */
export const ActiveIssuesConfig = z.union([ActiveGitHubIssuesConfig, ActiveLinearIssuesConfig]);
export type ActiveIssuesConfig = z.infer<typeof ActiveIssuesConfig>;

/** The sole active persisted shape for a Sentry error source. */
export const ActiveSentryConfig = z
  .object({
    org: z.string().trim().min(1),
    project: z.string().trim().min(1),
    baseUrl: z.string().url(),
    query: z.string().min(1).optional(),
    level: z.enum(["debug", "info", "warning", "error", "fatal", "sample"]).optional(),
    pollIntervalMs: z.number().int().positive().optional(),
    managedBy: z.literal("integration-provisioner").optional(),
  })
  .strict();
export type ActiveSentryConfig = z.infer<typeof ActiveSentryConfig>;

export const ManualSourceConfig = z.object({}).strict();
export const ScheduledAuditSourceConfig = z.object({}).strict();
export const SystemSourceConfig = z.object({ ciInsights: z.literal(true) }).strict();

const CreateGitHubIssuesConfig = ActiveGitHubIssuesConfig.extend({
  labels: z.array(z.string().trim().min(1)).default([]),
});
const CreateLinearIssuesConfig = ActiveLinearIssuesConfig.extend({
  labels: z.array(z.string().trim().min(1)).default([]),
});
const CreateSentryConfig = ActiveSentryConfig.omit({ managedBy: true }).extend({
  baseUrl: z.string().url().default("https://sentry.io"),
});

// The `issues` kind serves two providers, so its schema is chosen by the same
// fail-closed resolver the connectors use — one authority, not two. An
// unsupported provider throws here, BEFORE any shape is decoded or persisted.
function schemaForIssuesConfig(config: unknown, trusted: boolean): z.ZodType<Record<string, unknown>> {
  if (resolveIssuesProvider(config) === "linear") {
    return trusted ? ActiveLinearIssuesConfig : CreateLinearIssuesConfig;
  }
  return trusted ? ActiveGitHubIssuesConfig : CreateGitHubIssuesConfig;
}

function schemaForSourceKind(kind: SourceKind, config: unknown, trusted: boolean): z.ZodType<Record<string, unknown>> {
  if (kind === "issues") return schemaForIssuesConfig(config, trusted);
  if (kind === "errors") return trusted ? ActiveSentryConfig : CreateSentryConfig;
  if (kind === "system") return SystemSourceConfig;
  if (kind === "scheduled_audit") return ScheduledAuditSourceConfig;
  return ManualSourceConfig;
}

/**
 * Decode an external source request into its one canonical active persisted
 * shape. Internal lifecycle/secret metadata cannot be caller-authored.
 */
export function parseInboxSourceCreateConfig(kind: SourceKind, config: unknown): Record<string, unknown> {
  assertNoSourceCredentialOverride(config);
  return schemaForSourceKind(kind, config, false).parse(config);
}

/** Normalize a trusted internal write to the canonical persisted shape. */
export function parsePersistedInboxSourceConfig(kind: SourceKind, config: unknown): Record<string, unknown> {
  assertNoSourceCredentialOverride(config);
  return schemaForSourceKind(kind, config, true).parse(config);
}

const InboxSourceBase = z
  .object({
    id: z.string().min(1),
    orgId: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    name: z.string().min(1).max(120),
    detail: z.string().max(200).default(""),
    enabled: z.boolean().default(true),
    // System sources whose findings skip manual triage (verdict auto-routable).
    autoRoute: z.boolean().default(false),
    state: InboxSourceState.default("active"),
    attention: InboxSourceAttention.nullable().default(null),
    retryNotBefore: z.string().datetime().nullable().default(null),
    // Public/engine-safe projection only. The reusable secret coordinate remains
    // in an internal DB column and is fetched through a dedicated repository seam.
    webhookConfigured: z.boolean().default(false),
  })
  .strict();

// A configured source. Every kind owns one strict provider-only config. Lifecycle,
// retry timing, and secret metadata are independent first-class columns.
export const InboxSource = z
  .discriminatedUnion("kind", [
    InboxSourceBase.extend({ kind: z.literal("issues"), config: ActiveIssuesConfig.nullable() }),
    InboxSourceBase.extend({ kind: z.literal("errors"), config: ActiveSentryConfig.nullable() }),
    InboxSourceBase.extend({ kind: z.literal("system"), config: SystemSourceConfig.nullable() }),
    InboxSourceBase.extend({ kind: z.literal("manual"), config: ManualSourceConfig.nullable() }),
    InboxSourceBase.extend({ kind: z.literal("scheduled_audit"), config: ScheduledAuditSourceConfig.nullable() }),
  ])
  .superRefine((source, ctx) => {
    if ((source.state === "needs_attention") !== (source.attention !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attention"],
        message: "needs-attention state and attention details must change together",
      });
    }
    if (source.state === "needs_attention" && source.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enabled"],
        message: "a source needing attention must be disabled",
      });
    }
    if (source.state === "active" && source.config === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config"],
        message: "an active source must have a canonical provider config",
      });
    }
  });
export type InboxSource = z.infer<typeof InboxSource>;

// The Forge triage read-out (the hi-fi `TriageReadout`): three reasoning rows
// plus a verdict that drives the surface's available actions.
export const TriageVerdict = z.enum(["auto_routable", "needs_call", "dedupe_close"]);
export type TriageVerdict = z.infer<typeof TriageVerdict>;

// The committable spec the model proposes for an `auto_routable` candidate — the
// exact shape the discovery accept path (`acceptProposals`) commits into the DAG.
// Carries the dependency edges + priority (P1b) the DagWalker orders by, so an
// autonomously-ingested issue becomes a real, prioritized, dependency-aware spec
// with NO operator click. Present ONLY when `verdict === "auto_routable"`; null
// otherwise (the candidate then rests in the inbox for operator review).
export const TriageRoutableSpec = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(4000),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    // Existing spec-ids in the live DAG this spec builds on (mirrors `dependsOn`).
    dependsOn: z.array(z.string().min(1)).default([]),
    priority: SpecPriority.default("tbd"),
  })
  .strict();
export type TriageRoutableSpec = z.infer<typeof TriageRoutableSpec>;

// §3.3 entity-anchored Claims: when a candidate targets a specific code ENTITY,
// the triage agent reports its STRUCTURAL-HASH IDENTITY here (via `sem`'s entity
// identity — the §2.3 staleness primitive) so the engine can anchor a DURABLE
// Claim in the defect ledger (engine/repositories/entityClaims.ts). `entityId` is
// the identity that survives a rename/move (NOT a file:line, which a refactor
// orphans); `kind`/`name`/`path` are the display anchor + the raw-grep fallback
// locator. Null/absent when the candidate has no single target entity (a broad
// feature request, a non-code project the agent couldn't anchor) — no Claim is
// anchored then. GENERAL: `kind` is a free-form producer label, never an enum.
export const TriageEntityAnchor = z
  .object({
    entityId: z.string().min(1).max(400),
    kind: z.string().min(1).max(80).default("unknown"),
    name: z.string().max(200).default(""),
    path: z.string().max(400).default(""),
  })
  .strict();
export type TriageEntityAnchor = z.infer<typeof TriageEntityAnchor>;

export const CandidateTriage = z
  .object({
    // dedupe: prose on whether this matches an existing spec/candidate.
    dedupe: z.string().min(1).max(400),
    // match: which behavior / spec / milestone it fits.
    match: z.string().min(1).max(400),
    // placement: the proposed DAG placement (or "auto → … queued").
    placement: z.string().min(1).max(400),
    verdict: TriageVerdict,
    // When dedupe found an existing spec, its id (so close-as-dup links to it).
    duplicateOfSpecId: z.string().min(1).nullable().default(null),
    // The discovery variant the accept→discovery hand-off should open with.
    discoveryVariant: z.enum(["feature", "bug", "strategic"]).default("feature"),
    // The spec to commit into the DAG when (and only when) the verdict is
    // `auto_routable` — the autonomous-intake hand-off (autonomy-engine.md §1d).
    // The model fills this for an auto-routable candidate; otherwise null and the
    // candidate lands in the inbox for operator review.
    routableSpec: TriageRoutableSpec.nullable().default(null),
    // §3.3: the target ENTITY the candidate is about, by structural-hash identity,
    // so the engine anchors a durable Claim in the defect ledger. Null when the
    // candidate has no single target entity (the agent could not anchor one).
    entityAnchor: TriageEntityAnchor.nullable().default(null),
  })
  .strict();
export type CandidateTriage = z.infer<typeof CandidateTriage>;

// One ingested candidate. `externalId` is the connector's own id (issue number,
// audit-finding key, manual nonce) — unique per source so re-polling is idempotent.
export const CandidateStatus = z.enum([
  "new",
  "triaged",
  "auto_routed",
  "accepted",
  "folded",
  "dismissed",
  "closed_duplicate",
]);
export type CandidateStatus = z.infer<typeof CandidateStatus>;

export const Candidate = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    orgId: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    externalId: z.string().min(1),
    title: z.string().min(1).max(300),
    body: z.string().max(8000).default(""),
    severity: z.enum(["info", "warn", "fail"]).default("info"),
    status: CandidateStatus.default("new"),
    triage: CandidateTriage.nullable().default(null),
    resolvedSpecId: z.string().min(1).nullable().default(null),
    // Display label of the source (denormalised for the surface readout).
    sourceName: z.string().max(120).default(""),
    sourceKind: SourceKind.default("manual"),
  })
  .strict();
export type Candidate = z.infer<typeof Candidate>;

// A raw item a connector produces before it is persisted as a candidate. The
// store stamps ids/org/source; the connector only knows the external content.
export interface IngestedItem {
  externalId: string;
  title: string;
  body: string;
  severity: "info" | "warn" | "fail";
  projectId: string | null;
}

// The injectable connector seam: a source kind's read implementation. The
// GitHub Issues connector reads through the App token resolver in prod; tests
// inject a fake. `fetch` returns the raw items; the engine persists them.
export interface SourceConnector {
  readonly kind: SourceKind;
  fetch(source: InboxSource): Promise<IngestedItem[]>;
}

// The triage answerer seam — mirrors the `ForgeConversationAnswerer` and
// the `DiscoveryAnswerer`. The real impl wraps a provider Answerer; tests
// inject a fake; the engine falls back to a deterministic grounded answerer.
export interface TriageAnswererContext {
  candidate: Pick<Candidate, "title" | "body" | "severity" | "sourceKind" | "projectId">;
  source: InboxSource;
  // Existing specs (id/title/status) to ground dedupe + match + placement.
  existingSpecs: ReadonlyArray<{ specId: string; title: string; status: string }>;
}

export interface TriageAnswerer {
  triage(context: TriageAnswererContext): Promise<CandidateTriage>;
}
