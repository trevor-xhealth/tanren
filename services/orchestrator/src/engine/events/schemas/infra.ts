import { z } from "zod";

// Infrastructure-side events: runner, allocator, workspace, credential, cost.
// These payloads describe state of the underlying runtime substrate.

const SshTargetSummary = z
  .object({
    host: z.string(),
    port: z.number().int(),
    username: z.string(),
    hostKeyFingerprint: z.string(),
  })
  .strict();

const RunnerAllocationSummary = z
  .object({
    runnerId: z.string(),
    imageSha: z.string(),
    target: SshTargetSummary,
  })
  .strict();

export const AllocatorRequestedPayload = z
  .object({
    allocator: z.string(),
    runnerImage: z.string(),
    identitySecretRef: z.string(),
  })
  .strict();

export const AllocatorAllocatedPayload = RunnerAllocationSummary;

export const AllocatorFailedPayload = z
  .object({
    message: z.string(),
  })
  .strict();

export const RunnerAllocatedPayload = RunnerAllocationSummary;

export const RunnerReleasedPayload = z
  .object({
    runnerId: z.string(),
  })
  .strict();

// RUNNER-SWEEPER RECLAIM PROOF. The periodic allocator sweeper reconciles STUCK /
// LEAKED runners the normal release path missed — a runner whose owning run went
// terminal without a release, a runner past the run-hours TTL ceiling, or a wedged
// allocation never tied to a live run. Reclaiming one emits this durable, org-scoped
// audit event so a leak that the per-run `finally` missed is NEVER silent: `reason`
// is the discriminated stuck-state, the runner id + (nullable) run id are the
// NON-SECRET resource handles, and the event proves the reclaim actually fired.
export const RunnerSweptPayload = z
  .object({
    /** The reclaimed runner's id (the resource the sweep targeted). */
    runnerId: z.string(),
    /** The owning run id, or null for an unclaimed allocation. */
    runId: z.string().nullable(),
    /** The allocator's actual reclamation decision. */
    reason: z.enum(["terminal_run", "lease_lapsed", "unclaimed_grace"]),
  })
  .strict();

// SECURITY-BASELINE CLEANUP-PROOF (tanren-direction.md § "Security Baseline":
// "Release events prove cleanup and list residual resources, if any."). A runner is
// an untrusted-code execution surface; when a run ends, the allocator's release MUST
// tear it down, and the audit trail must record WHETHER the teardown actually
// succeeded — not assume it. `release.finalized` is the audit EVENT of the finalize
// outcome (it does NOT replace the allocator's release mechanism): `cleanedUp` is the
// proof the release call completed without error; `residualResources` lists any
// resource references that may NOT have been torn down (the release threw) so an
// orphan sweeper / an operator can reconcile them. A clean release records
// `cleanedUp: true` + an empty `residualResources`. SECURITY: a residual reference is
// a non-secret RESOURCE HANDLE (a runner id / a server id), never a credential value.
export const ReleaseFinalizedPayload = z
  .object({
    /** The released runner's id (the resource the release targeted). */
    runnerId: z.string(),
    /** True ⇒ the allocator's release completed without error (teardown proven). */
    cleanedUp: z.boolean(),
    /**
     * Resource references that may remain after a FAILED release (the release threw),
     * for orphan reconciliation. Empty on a clean release. Each entry is a NON-SECRET
     * resource handle (e.g. `runner:<id>`), never a credential or secret value.
     */
    residualResources: z.array(z.string()),
    /** When the release failed: the non-secret error summary (no stack, no secret). */
    failureReason: z.string().optional(),
  })
  .strict();

const SshCommandFailure = z
  .union([
    z.object({ reason: z.string(), message: z.string().optional() }).strict(),
    z.object({ reason: z.string() }).strict(),
  ])
  .or(z.record(z.string(), z.unknown()));

const SshCommandResultSummary = z
  .object({
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    signal: z.string().optional(),
    timedOut: z.boolean(),
    failure: SshCommandFailure.optional(),
  })
  .strict();

export const RunnerFailedPayload = z
  .object({
    runnerId: z.string(),
    command: z.string(),
    result: SshCommandResultSummary,
  })
  .strict();

export const WorkspacePreparedPayload = z
  .object({
    runnerId: z.string().optional(),
    workspacePath: z.string(),
    repoUrl: z.string().optional(),
    targetBranch: z.string().optional(),
    // The toolchain ACTUALLY in effect for the run: per declared tool, the concrete
    // version the runner resolved (`resolved`) against what the repository declared
    // (`declared`, in `declaredIn`). Recorded here because the provision's console line
    // scrolls past, and "the gate ran on the version the repo asked for" has to be
    // checkable after the fact. Absent when the repo declares no toolchain.
    toolchain: z
      .array(
        z
          .object({
            tool: z.string(),
            declared: z.string(),
            resolved: z.string(),
            declaredIn: z.string(),
            versionDeclared: z.boolean(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const WorkspaceGitCapturedPayload = z
  .object({
    workspacePath: z.string(),
    commits: z.array(z.object({ sha: z.string(), message: z.string() }).strict()),
    diffBytes: z.number().int(),
  })
  .strict();

export const WorkspaceFailedPayload = z
  .object({
    runnerId: z.string().optional(),
    workspacePath: z.string(),
    message: z.string(),
  })
  .strict();

// workspace.bootstrap_deferred — the workspace-PREP `just bootstrap` (deps install)
// exited nonzero, but rather than terminally strand the spec (the old behavior), the
// deps-install authority is DEFERRED to the gate's already-self-healing
// `ensureWorkspaceDepsInstalled` (apex v35, mirroring #562's gate-bootstrap handling).
// The prep deps-install is REDUNDANT with the per-gate one (same `just bootstrap`), so a
// writer-fixable failure here is best-effort: workspace-prep continues, the writer loop
// runs, and the gate re-runs the bootstrap — a still-failing one routes to the writer as
// a P0 finding (bounded by convergence). This event records the deferral loudly so the
// timeline shows the prep bootstrap was skipped-not-fatal. The mise PROVISION step (the
// declared toolchain) is NOT writer-fixable and keeps its terminal halt — it never reaches
// here. The `command` is prelude-free + the `outputTail` is bounded (substrate boundary),
// but the tail is marked secret out of caution (mirroring gate.failed steps[].outputTail).
export const WorkspaceBootstrapDeferredPayload = z
  .object({
    runnerId: z.string().optional(),
    workspacePath: z.string(),
    // The original prep bootstrap command (prelude-free — see bootstrap.ts substrate
    // boundary), so no app-secret value can reach the payload.
    command: z.string(),
    // The bootstrap process exit code, or null on a timeout / no-exit substrate result.
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    // The bounded bootstrap stdout/stderr tail (the install error detail).
    outputTail: z.string(),
  })
  .strict();

const CredentialReference = z
  .object({
    credentialKind: z.string(),
    ref: z.string(),
    redacted: z.literal(true),
  })
  .strict();

export const CredentialRequestedPayload = CredentialReference;
export const CredentialLoadedPayload = CredentialReference;
export const CredentialFailedPayload = z
  .object({
    ref: z.string().optional(),
    message: z.string(),
  })
  .strict();

// credential.configured — a credential was connected through a product API
// surface. This is a generic repair signal for terminal missing-credential
// holds; it carries only a credential REF, never the secret value.
export const CredentialConfiguredPayload = z
  .object({
    provider: z.string(),
    credentialKind: z.enum(["codex_chatgpt_auth", "github_app", "github_token", "opaque"]),
    ref: z.string(),
    redacted: z.literal(true),
  })
  .strict();

// credential.github.configured — the operator connected GitHub through the
// product API. This is a repair signal for previously-terminal missing-GitHub
// merge holds; it carries only a credential REF, never the secret value.
export const CredentialGithubConfiguredPayload = z
  .object({
    mode: z.enum(["app", "token"]),
    credentialKind: z.enum(["github_app", "github_token"]),
    ref: z.string(),
    redacted: z.literal(true),
  })
  .strict();

// Managed-hosting dimension D (per-run scoped credentials): a short-lived Vault
// CHILD token was minted, scoped to read ONLY this run's credential ref paths,
// with a bounded TTL + use count. The audit record carries the SCOPE — the ref
// paths the policy covers, the policy name, the TTL and num_uses — but NEVER the
// token value (and never the broad VAULT_TOKEN). The ref paths are redacted (they
// embed the tenant), the bounds are public.
export const CredentialScopedTokenMintedPayload = z
  .object({
    policyName: z.string(),
    refPaths: z.array(z.string()),
    // The subset of refPaths the policy ALSO granted create+update on — the rotating
    // credentials the run writes back (the BYOK Codex ChatGPT bundle). Always ⊆ refPaths;
    // empty when the run has no rotating credential. Redacted like refPaths (tenant-embedded).
    writableRefPaths: z.array(z.string()),
    ttlSeconds: z.number().int(),
    numUses: z.number().int(),
  })
  .strict();

export const CostResolvedPayload = z
  .object({
    taskId: z.string(),
    cli: z.string(),
    provider: z.string(),
    model: z.string(),
    // REAL SPEND (FOCUS BilledCost): null when no reliable real-cost basis exists.
    costUsd: z.string().nullable(),
    // NOTIONAL VALUE (FOCUS ListCost): the tokens' COMPUTED value from the maintained
    // LiteLLM model-price source (keyed by model id); null when the model is unpriced.
    notionalCostUsd: z.string().nullable(),
    billingMode: z.string(),
    costBasis: z.string(),
  })
  .strict();

export const CostFailedPayload = z
  .object({
    taskId: z.string().optional(),
    message: z.string(),
  })
  .strict();

// cost.unattributed (BUDGET-SAFETY C1): a real priced call ran against an
// UNRECOGNIZED credential ref (no known `credential/<kind>/` prefix), so its
// cost could not be priced and the row was recorded as cost_usd=NULL with
// billing_mode/cost_basis='unattributed'. This is a MISCONFIGURATION — an
// unrecognized LLM credential that must NOT silently count as $0 spend. The
// event names the ref KIND only (`refKind`, e.g. `credential/mystery`), NEVER
// the secret value, and the budget gate FAILS CLOSED on the NULL row it created.
export const CostUnattributedPayload = z
  .object({
    taskId: z.string(),
    cli: z.string(),
    // The SAFE ref-kind label (leading path segments, secret name stripped).
    refKind: z.string(),
    // Why it could not be attributed (a fixed, secret-free diagnosis string).
    reason: z.string(),
  })
  .strict();

// cost.ceiling_unreachable (BUDGET-SAFETY M6): a run was set up with a configured
// DOLLAR ceiling but a subscription/self-hosted credential (no per-call dollar
// basis) and NO usage probe wired to reconcile real cost — so the ceiling can
// never fire (the run accrues $0). Surfaced LOUDLY at run setup; the run then
// fails closed. Names the ref KIND only (`refKind`), never the secret value.
export const CostCeilingUnreachablePayload = z
  .object({
    // The SAFE ref-kind label (leading path segments, secret name stripped).
    refKind: z.string(),
    // The credential's billing mode (subscription / self_hosted) that has no basis.
    billingMode: z.string(),
    // The configured dollar ceiling that can never be reached, in USD.
    ceilingUsd: z.number().nonnegative(),
    // A fixed, secret-free diagnosis string.
    reason: z.string(),
  })
  .strict();

// cost.credit_rate_unknown (cost PR-C): a run's subscription credential DREW DOWN
// prepaid credits (a real, positive drawdown delta) but NO per-credential credit→USD
// rate is configured for its ref-KIND at either the project or org layer. The
// drawdown's REAL dollar spend is therefore UNKNOWN — recorded as NULL, NOT priced
// at a removed magic constant (REAL SPEND IS A FACT). Surfaced LOUDLY so an operator
// configures the rate (`config.creditRates[<refKind>]`). Names the ref KIND only
// (`refKind`, secret-free), never the secret value; carries the consumed credits so
// the operator sees the unpriced drawdown's magnitude.
export const CostCreditRateUnknownPayload = z
  .object({
    // The SAFE ref-kind label the rate lookup missed (e.g. `credential/codex`).
    refKind: z.string(),
    // The positive credit-drawdown delta whose USD value is unknown.
    creditsConsumed: z.number().positive(),
    // A fixed, secret-free diagnosis string.
    reason: z.string(),
  })
  .strict();

// cost.overage_unobservable (cost PR-C): a run executed under a SUBSCRIPTION
// credential whose "extra usage"/OVERAGE real dollar spend is NOT reachable from
// the local CLI path (today: the Claude CLI subscription bundle — Claude reports
// only window percentages + a local-ESTIMATE cost locally; the authoritative
// overage figure lives in the Anthropic Console / Admin API, an org integration not
// wired here). The overage real spend is therefore UNKNOWN/NULL — NOT approximated
// from the local estimate (REAL SPEND IS A FACT). Surfaced LOUDLY as an honest gap.
// Names the provider + the authoritative source that WOULD carry the figure.
export const CostOverageUnobservablePayload = z
  .object({
    // The subscription provider whose overage is uncaptured (e.g. "anthropic").
    provider: z.string(),
    // The SAFE ref-kind label of the credential (secret-free).
    refKind: z.string(),
    // The authoritative source that WOULD carry the real figure (a fixed,
    // secret-free identifier, e.g. "anthropic-admin-api-cost-report").
    authoritativeSource: z.string(),
    // A fixed, secret-free diagnosis string.
    reason: z.string(),
  })
  .strict();

// cost.managed_metering_skipped (BYOK posture): a run executed in BYOK mode, so
// there is NO PLATFORM METERING credential to query the per-call real
// `usage.cost` with — that capture is a MANAGED-ONLY step (the platform IS the
// biller and owns the OpenRouter key). This is the EXPLICIT, intentional "no
// BYOK analog" branch (honoring no_silent_fallbacks): real spend stays a metered
// FACT-or-NULL from the BYOK credential's own ledger (ccusage / credit drawdown),
// never an empty managed ref shoved through the validator (the apex v30 class of
// crash) and never a silent $0. A MANAGED run never emits this — it builds the
// capturer and meters every call.
export const CostManagedMeteringSkippedPayload = z
  .object({
    // The run's provider mode for this run — always "byok" where this fires
    // (managed builds the capturer). Recorded so the skip is self-describing.
    providerMode: z.literal("byok"),
    // A fixed, secret-free diagnosis string.
    reason: z.string(),
  })
  .strict();

// Usage monitoring: codexbar (live subscription windows)
// and ccusage (token-consumption accounting), captured in the runner over SSH.

// One concurrent rolling subscription window, mirroring the codexbar shape.
const SubscriptionWindowSummary = z
  .object({
    slot: z.enum(["primary", "secondary", "tertiary"]),
    usedPercent: z.number(),
    resetsAt: z.string(),
    windowMinutes: z.number().int(),
    resetDescription: z.string(),
  })
  .strict();

// usage.window.observed — the live subscription-window state for a provider.
export const UsageWindowObservedPayload = z
  .object({
    provider: z.string(),
    windows: z.array(SubscriptionWindowSummary),
    creditsRemaining: z.number().nullable(),
    source: z.string(),
    capturedAt: z.string(),
  })
  .strict();

// usage.window.pressure — a window is at/over the configured pressure
// threshold; carries the offending slot so the workflow can escalate.
export const UsageWindowPressurePayload = z
  .object({
    provider: z.string(),
    slot: z.enum(["primary", "secondary", "tertiary"]),
    usedPercent: z.number(),
    resetsAt: z.string(),
  })
  .strict();

// task #82 — usage.window.refreshed lives in schemas/windowPause.ts.

// usage.accounting.observed — token-consumption accounting from ccusage. The
// token buckets are disjoint (same convention as the cost schema); costUsd is
// best-effort and null unless ccusage reports a positive figure.
export const UsageAccountingObservedPayload = z
  .object({
    cli: z.string(),
    totals: z
      .object({
        inputTokens: z.number().int(),
        cachedInputTokens: z.number().int(),
        cacheCreationTokens: z.number().int(),
        outputTokens: z.number().int(),
        reasoningOutputTokens: z.number().int(),
        totalTokens: z.number().int(),
      })
      .strict(),
    costUsd: z.number().nullable(),
    capturedAt: z.string(),
  })
  .strict();

// usage.read_failed (silent-fallback hardening, finding 1/2) — a usage probe
// read (codexbar window state / ccusage accounting) FAILED: a timeout, an SSH
// transport failure, a non-zero exit, or malformed NON-empty output. This is the
// LOUD discriminated signal that must NEVER be conflated with a legitimately-empty
// read — an erased read would otherwise silently become a normal zero-usage run
// (no window pressure, no ccusage reconcile, lost notional visibility). Carries
// NO secret value: `target` is a provider/cli label, `detail` is a bounded,
// whitespace-collapsed stderr/stdout tail.
export const UsageReadFailedPayload = z
  .object({
    tool: z.enum(["codexbar", "ccusage"]),
    target: z.string(),
    reason: z.enum(["timeout", "ssh_failure", "nonzero_exit", "malformed_output"]),
    exitCode: z.number().int().nullable(),
    detail: z.string(),
    reasonText: z.string(),
  })
  .strict();

// usage.token_accounting_failed (silent-fallback hardening, finding 4) — a REAL
// CLI call (writer / answerer, NOT a fake fixture) recorded its cost with NO token
// telemetry. Token accounting is mandatory; a real call missing it is parser /
// adapter drift that would silently land as a zero-token, zero-notional row — so
// it is surfaced LOUDLY rather than conflated with a genuine zero-token call.
// Carries the role + cli + model (secret-free), never a secret value.
export const UsageTokenAccountingFailedPayload = z
  .object({
    // The agent role whose real call lacked token telemetry. Includes the spec-loop
    // redesign answerer stages (triage/convergence/demoRun) — they are real CLI calls
    // whose accounting drift must surface as loudly as the planner/checker/auditor's.
    role: z.enum(["planner", "checker", "auditor", "writer", "triage", "convergence", "demoRun", "designOracle"]),
    cli: z.string(),
    model: z.string(),
    reason: z.string(),
  })
  .strict();

export * from "./costFailures.js";
export { UsageAccountingFailedPayload } from "./usage.js";
