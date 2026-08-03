import { z } from "zod";
import { FindingSeverityConfig } from "./auditPostureConfig.js";

// Shared building blocks for org- and project-level config. Zod is the
// single source of truth; persistence and JSON Schema artifacts are derived
// from these definitions.

// ---- Routing chain (the 6-role fallback chain shape) ----------------------

export const RoleId = z.enum(["plan", "write", "check", "audit", "demo", "forge"]);
export type RoleId = z.infer<typeof RoleId>;

export const HealthHint = z.enum(["ok", "warn", "rate_limited", "fail"]);
export type HealthHint = z.infer<typeof HealthHint>;

// A single fallback step. The schema is stable across providers — Codex,
// Claude, opencode, and other CLIs all populate it with no shape change.
export const RoutingChainEntry = z
  .object({
    cli: z.string().min(1),
    model: z.string().min(1),
    authRef: z.string().min(1),
    healthHint: HealthHint.optional(),
  })
  .strict();
export type RoutingChainEntry = z.infer<typeof RoutingChainEntry>;

export const RoutingChain = z
  .object({
    chain: z.array(RoutingChainEntry).default([]),
  })
  .strict();
export type RoutingChain = z.infer<typeof RoutingChain>;

// The routing table covers every role. Even when a role's chain is empty
// (Codex-only v0), every role is representable so the operator UI never sees
// an undefined column. `partial()` lets project-level overrides specify only
// the roles they want to redirect.
export const RoutingTable = z
  .object({
    plan: RoutingChain.default({ chain: [] }),
    write: RoutingChain.default({ chain: [] }),
    check: RoutingChain.default({ chain: [] }),
    audit: RoutingChain.default({ chain: [] }),
    demo: RoutingChain.default({ chain: [] }),
    forge: RoutingChain.default({ chain: [] }),
  })
  .strict();
export type RoutingTable = z.infer<typeof RoutingTable>;

// Returns the routing table with every role present and defaulted to an
// empty chain. Used as the org-level default and as the projection target
// when reading project rows that omit roles entirely.
export function emptyRoutingTable(): RoutingTable {
  return RoutingTable.parse({});
}

// ---- (removed) Retry budgets / escape hatches ----------------------------
//
// The old `EscapeHatches` config block (`maxWriterIterPerSubtask`,
// `maxRetriesPerTransientFailure`, `maxSpecDiscoveryRoundsWithForge`) is GONE (the
// v35 — intelligent non-convergence detection). They were hardcoded ATTEMPT CAPS: a
// flat number of iterations/retries/rounds that escalated regardless of whether the
// loop was making PROGRESS. The binding principle is that NO loop is bounded by a count
// — a loop continues UNBOUNDED while it is converging (its failure / produced work
// keeps changing, or its magnitude shrinks) and escalates ONLY at an
// intelligently-detected FIXED POINT (the shared `engine/workflow/convergenceDetector`).
// `maxWriterIterPerSubtask` (the writer inner loop) is replaced by that detector;
// `maxRetriesPerTransientFailure` + `maxSpecDiscoveryRoundsWithForge` were never wired
// to a convergence loop and are deleted outright. There is no replacement config knob:
// convergence is intelligence, not a tunable count.

// ---- Allocator settings --------------------------------------------------

export const AllocatorKind = z.enum(["local-docker"]);
export type AllocatorKind = z.infer<typeof AllocatorKind>;

export const AllocatorConfig = z
  .object({
    kind: AllocatorKind.default("local-docker"),
    concurrency: z.number().int().min(1).default(3),
    memoryMb: z.number().int().min(256).default(4096),
    cpus: z.number().int().min(1).default(2),
    runnerImage: z.string().min(1).default("ghcr.io/cat-cave/tanren-runner:v0"),
    // Run-sandbox reaper (the ≈204 GB disk-leak safety net). A STATIC / long-lived
    // reused runner keeps `/workspace` across runs, so a run dir the per-run
    // teardown missed (e.g. the orchestrator crashed mid-run) leaks forever. The
    // reaper sweeps `/workspace/runs/*` and removes any dir OLDER than the retention
    // window whose run is not still active. These are GOVERNED CONFIG KNOBS on the
    // (system/infra-level) allocator config — never `process.env.X ?? default` — with
    // a sane documented default, the same shape as `concurrency`.
    //
    // Retention is a grace window, not a hard TTL: it only protects against deleting a
    // dir whose run is between terminal-state and the next active-set read; an ACTIVE
    // run is protected absolutely regardless of age. 60 min is comfortably longer than
    // any single run dir lives untracked.
    runWorkspaceRetentionMinutes: z.number().int().min(1).default(60),
    /** How often the reaper sweeps the long-lived runner's `/workspace/runs/*`. */
    runWorkspaceReapIntervalMinutes: z.number().int().min(1).default(30),
  })
  .strict();
export type AllocatorConfig = z.infer<typeof AllocatorConfig>;

/**
 * The single canonical runner image — the ONE source of truth every runner
 * allocation site (the in-loop run, the merge-coordinator fresh-runner re-gate,
 * the batch checker, the drive-path conflict resolver, the live-jj workspace,
 * the base-shift live context, the greenfield Forge surface) falls back to when a
 * project sets none. Derived from the `AllocatorConfig.runnerImage` schema default
 * so it can NEVER drift from the project-config / DB-column default. A wrong image
 * makes the runner alloc pull a non-existent image → an infra-hold, so this is
 * deliberately NOT a per-file literal: there is exactly one place to change it.
 */
export const CANONICAL_RUNNER_IMAGE: string = AllocatorConfig.parse({}).runnerImage;

/**
 * The `allocator.concurrency` a caller resolved from each governed config layer.
 * `undefined` means that layer configures none (a project that never set the knob,
 * or a layer the caller has no row for) — NOT "zero slots".
 */
export interface WorkerConcurrencyLayers {
  /** The PROJECT's `allocator.concurrency` (`PartialAllocatorConfig` — optional). */
  project?: number | undefined;
  /** The ORG's `allocator.concurrency` (the org-level default every project inherits). */
  org?: number | undefined;
}

/**
 * The max in-flight run-slot ceiling, resolved from the config surface
 * (`AllocatorConfig.concurrency`) — NOT from an env var (autonomy-engine.md
 * §1.4: "concurrency is a governed config knob, never an env var").
 *
 * Precedence is PROJECT over ORG over the schema default — the same layering
 * `resolveEffectiveBudget` / `resolveCreditUsdRate` apply to the other governed
 * knobs. Called with NO layers it yields the schema default, which is the
 * process-wide ceiling the run-executor worker boots with: that worker serves
 * every tenant in the process, so no single project's knob may set it. The
 * per-project ceiling is resolved (and spent) by the DagWalker, which knows the
 * project it is walking — see `buildConcurrencyResolver` in `dag/walkerConfigResolvers.ts`.
 */
export function resolveWorkerConcurrency(layers: WorkerConcurrencyLayers = {}): number {
  return layers.project ?? layers.org ?? AllocatorConfig.parse({}).concurrency;
}

/** The reaper's retention + sweep cadence, resolved from the same governed config surface. */
export interface RunWorkspaceReaperConfig {
  retentionMs: number;
  reapIntervalMs: number;
}

/**
 * Resolve the run-sandbox reaper's retention window + sweep cadence from
 * `AllocatorConfig` (the single schema default is the one source of truth), never
 * from `process.env`. Mirrors `resolveWorkerConcurrency`.
 */
export function resolveRunWorkspaceReaperConfig(): RunWorkspaceReaperConfig {
  const config = AllocatorConfig.parse({});
  return {
    retentionMs: config.runWorkspaceRetentionMinutes * 60_000,
    reapIntervalMs: config.runWorkspaceReapIntervalMinutes * 60_000,
  };
}

// See PartialEscapeHatches for why this is not `AllocatorConfig.partial()`.
export const PartialAllocatorConfig = z
  .object({
    kind: AllocatorKind.optional(),
    concurrency: z.number().int().min(1).optional(),
    memoryMb: z.number().int().min(256).optional(),
    cpus: z.number().int().min(1).optional(),
    runnerImage: z.string().min(1).optional(),
    runWorkspaceRetentionMinutes: z.number().int().min(1).optional(),
    runWorkspaceReapIntervalMinutes: z.number().int().min(1).optional(),
  })
  .strict();
export type PartialAllocatorConfig = z.infer<typeof PartialAllocatorConfig>;

// ---- Dollar budget ceiling (autonomy-engine.md §3 proof 6) ---------------

// The PERIOD a budget ceiling sums spend over:
//   - `monthly`   — the CURRENT CALENDAR MONTH (UTC): spend recorded since the
//                   first of this month (`date_trunc('month', now())`). A fresh
//                   window opens automatically each month boundary — the rolling
//                   operating budget for a continuously-running project.
//   - `quarterly` — the CURRENT CALENDAR QUARTER (UTC): spend recorded since
//                   `date_trunc('quarter', now())`. A coarser rolling window.
//   - `annual`    — the CURRENT CALENDAR YEAR (UTC): spend recorded since
//                   `date_trunc('year', now())`. The coarsest rolling window.
//   - `total`     — the project's LIFETIME: every cost record ever attributed to
//                   the project. A hard lifetime cap (e.g. a fixed run budget).
//
// All non-`total` values are CALENDAR-anchored rolling windows. The period lives
// in config jsonb; an absent value defaults to `monthly`.
export const BudgetPeriod = z.enum(["monthly", "quarterly", "annual", "total"]);
export type BudgetPeriod = z.infer<typeof BudgetPeriod>;

export const DEFAULT_BUDGET_PERIOD: BudgetPeriod = "monthly";

// The per-project/org DOLLAR BUDGET CEILING — a governed SETTING (lives in
// project/org config JSON), never an env var. When the project's cumulative
// spend over `period` reaches `ceilingUsd`, the DagWalker STOPS enqueuing new
// spec runs (the genuine `budget_paused` outcome → `dag.budget.paused`);
// in-flight runs are NOT killed (they are bounded by the escape hatches). The
// SAME ceiling feeds the Forge narration budget-warning card, so the warning
// and the gate read one config — there is no second parallel budget concept.
//
// Optional + additive everywhere it is referenced: an absent budget means NO
// ceiling (unlimited — today's behavior, byte-identical). `ceilingUsd` is a
// non-negative dollar amount; `period` defaults to `monthly`. The gate ALWAYS sums
// REAL spend (`cost_records.cost_usd`) — that is the doctrine (budgets account for
// real money out the door, never notional/tokens), so there is no "which figure"
// knob to configure; the notional figure is SURFACED for observability but never
// gated.
export const ProjectBudget = z
  .object({
    ceilingUsd: z.number().nonnegative(),
    period: BudgetPeriod.default(DEFAULT_BUDGET_PERIOD),
  })
  .strict();
export type ProjectBudget = z.infer<typeof ProjectBudget>;

// ---- Per-credential credit/overage USD rate ------------------------------

// The DOLLAR VALUE OF ONE prepaid credit, keyed by the credential's SAFE
// PROVIDER-SLUG label (the `credential/<slug>` prefix, secret name + scope
// stripped — see `credentialSlugOf` in costs/sources.ts; e.g.
// `credential/codex/org/o1/default` keys under `credential/codex`). This is the
// REAL drawdown rate the run-end reconcile multiplies a positive credit-drawdown
// delta by to land subscription-OVERAGE spend (`cost_basis='credits'`).
//
// It is per-CREDENTIAL CONFIG, NOT a magic constant: a subscription's
// credit→USD rate is account/plan-specific (e.g. Codex Pro observed at $0.04
// /credit) and MUST be configured per credential kind, never hardcoded. A
// credential that DID draw down credits but has NO configured rate is a LOUD
// unknown — the run-end reconcile records NULL real spend + emits
// `cost.credit_rate_unknown`, NEVER a silent guess (REAL SPEND IS A FACT).
//
// Keyed by provider-SLUG so one rate covers every credential of that provider
// (`credential/codex` → 0.04). Resolution is project-config over org-config
// (the org `defaultCreditRates` is the fallback layer). Optional: an absent key
// parses to an EMPTY map — the rate is then UNKNOWN for every credential, so a
// drawdown lands NULL-and-loud rather than silently priced at a default.
// `.strict()` round-trips it on save. `usdPerCredit` is a positive dollar amount.
export const CreditRates = z.record(z.string().min(1), z.number().positive());
export type CreditRates = z.infer<typeof CreditRates>;

// ---- Notification target ref ---------------------------------------------

// References a row in the (future) `notification_targets` table delivered by
//. Stored as a uuid so the contract is stable before the table
// lands; the parser does not look the value up.
export const NotificationTargetRef = z.string().uuid();
export type NotificationTargetRef = z.infer<typeof NotificationTargetRef>;

// ---- Forge persona ------------------------------------------------------

export const ForgePersona = z
  .object({
    systemPromptOverride: z.string().nullable().default(null),
    enableTools: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ForgePersona = z.infer<typeof ForgePersona>;

// See PartialEscapeHatches for why this is not `ForgePersona.partial()`.
export const PartialForgePersona = z
  .object({
    systemPromptOverride: z.string().nullable().optional(),
    enableTools: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type PartialForgePersona = z.infer<typeof PartialForgePersona>;

// ---- Governance posture / merge integration ------------------------------

// Governance posture. `strict`/`open`/`audit_only` govern how Tanren coexists
// with EXTERNAL (non-Tanren) contributors at the merge point (see
// workflow/reviewMerge/governancePosture.ts). `lenient` additionally relaxes the
// in-loop GATE: under it, `lint`/`typecheck` failures are ADVISORY (warn,
// non-blocking) while `build`/`test` stay BLOCKING — the functional-but-weak autonomous-run
// doctrine, so an autonomous greenfield build lands imperfect code and improves it
// via the issue loop rather than stalling on first-pass quality. For the
// external-contributor decision, `lenient` behaves like `strict` (Tanren-only PRs
// proceed; external commits block). An absent value parses to the `strict` default.
export const GovernancePosture = z.enum(["strict", "open", "audit_only", "lenient"]);
export type GovernancePosture = z.infer<typeof GovernancePosture>;

// The per-repo merge integration mode (autonomy-engine.md §2d):
//   - `native_queue`      — Tanren's OWN intelligent merge queue. A ready run
//                           ENTERS the queue instead of merging immediately; the
//                           native MergeCoordinator then orders ready runs in DAG
//                           order (ancestor before dependent, priority within a
//                           layer) and SERIALIZES their merges (one at a time),
//                           driving the SAME per-run merge path (up-to-date +
//                           conflict-resolution + retarget). This is the
//                           queue — native, provider-agnostic, intent-preserving.
//   - `external_reviewer` — stop at ready-for-review; a human merges (no auto-merge).
//   - `not_configured`    — treated as `external_reviewer` (never auto-merge a repo
//                           that has not opted in).
//
// `direct_merge` was an old automatic route that could synthesize an unpersisted
// integration-node subject. It is deliberately absent: a stored legacy value is a
// validation error, never a permissive fallback.
export const MergeIntegration = z.enum(["native_queue", "external_reviewer", "not_configured"]);
export type MergeIntegration = z.infer<typeof MergeIntegration>;

// ---- Review policy -------------------------------------------------------

// Per-project gate on whether the review stage requires a real human verdict
// before merge. `human` (the default) preserves today's behavior: the review
// stage polls GitHub for an approval/changes-requested verdict and hands off to
// an operator if none arrives. `auto` is the no-review tier (easy/medium): the
// review stage short-circuits to an approved verdict immediately so the merge
// dispatch proceeds. `simulated` is the HARD tier's in-the-loop reviewer
// exercised WITHOUT a human: an orchestrator-managed reviewer Answerer reads the
// PR diff + acceptance criteria, decides approve/request_changes, and posts that
// as a REAL GitHub review — so the same human-verdict path then proceeds
// (approve→merge) or loops back (changes_requested→rework). The default MUST be
// `human` — never auto-merge without a review unless a project explicitly opts in.
export const ReviewPolicy = z.enum(["human", "auto", "simulated"]);
export type ReviewPolicy = z.infer<typeof ReviewPolicy>;

// ---- Speculative execution (autonomy-engine.md §2c) ----------------------

// The SPECULATION THRESHOLD: how far along an ancestor must be before a dependent
// may START BUILDING speculatively (against the ancestor's prospective merged
// world) rather than waiting for the ancestor to genuinely merge. Per-project;
// the default is `moderate` (the §2c/§6 resolved default — routes around the
// human-review bottleneck while staying off genuinely-unstable ancestors):
//
//   - `conservative` — a dependent may start only once its ancestor is MERGED.
//                      Zero speculative rework; human review serializes the DAG.
//   - `moderate`     — a dependent may start once its ancestor is CI-GREEN +
//                      AUDITED with NO open P0/P1 finding (P2/P3 are OK), EVEN IF
//                      human/simulated review is still pending. An ancestor that
//                      is "technically complete but pending automated audits" is
//                      NOT ready (audits gate); only-P2/P3 findings ARE ready.
//   - `aggressive`   — a dependent may start as soon as the ancestor's PR is OPEN
//                      (pre-CI). Maximum parallelism, highest invalidation risk.
//
// The dependent's MERGE always still waits for the ancestor to genuinely merge
// (no unreviewed code reaches `main` early) — the threshold gates WORK, not MERGE.
export const SpeculationThreshold = z.enum(["conservative", "moderate", "aggressive"]);
export type SpeculationThreshold = z.infer<typeof SpeculationThreshold>;

export const DEFAULT_SPECULATION_THRESHOLD: SpeculationThreshold = "moderate";

// The MAX SPECULATIVE-INTEGRATION DEPTH (§2c open decision §6): how many UNMERGED
// ancestors deep a speculative integration branch may stack before the rework
// risk outweighs the velocity. When a ready dependent's unmerged-ancestor depth
// would EXCEED this cap, the spec is HELD (not silently truncated — the walker
// emits a `dag.spec.speculation_held` event and treats it as not-yet-ready) until
// enough ancestors merge. Default 2 (the §6 resolved default); a positive int.
export const DEFAULT_SPECULATIVE_INTEGRATION_DEPTH = 2;

// The MAX BATCH SIZE (§2d — speculative batch-check + bisect): how many
// mutually-eligible queued entries the native MergeCoordinator speculatively
// integrates + CI-checks as a combined unit before merging. A larger batch amortizes
// the (expensive) integration-CI run; a smaller one shrinks the bisect cost of a bad
// interaction. Default 5 (the §2d resolved default). When more entries are eligible
// the batch is CAPPED to the DAG-ordered prefix + the cap is LOGGED (never a silent
// truncation); the dropped entries keep their queue position for the next pass.
export const DEFAULT_MAX_BATCH_SIZE = 5;

// ---- Audit posture (the DORA knob — tanren-owns-the-engine.md §4) ---------
// Split into ./auditPostureConfig.ts (the 500-line cap); re-exported so the import
// surface (shared.ts + config/index.ts) is unchanged. `FindingSeverityConfig` is also
// used locally below (the convergence policy's `velocityDeferMaxSeverity`).
export {
  AUTONOMOUS_AUDIT_POSTURE,
  AuditPostureConfig,
  DEFAULT_AUDIT_POSTURE,
  P2P3HandlingConfig,
} from "./auditPostureConfig.js";
export { FindingSeverityConfig };

// ---- Convergence policy (spec-loop-redesign.md) ---------------------------

// The CONVERGENCE policy for the spec-implementation loop (docs/roadmap/spec-loop-redesign.md).
// There is NO retry cap / per-spec rerun limit / timeout halt AND NO `maxConsecutiveStalls`
// count (apex v35): the loop iterates UNBOUNDED while it is CONVERGING and halts ONLY when
// the convergence answerer's INTELLIGENT escalation verdict judges a human would add value
// beyond "keep going" (a genuine decision/blocker/dead-end). Convergence is intelligence, not
// a tunable count — so this config holds only the velocity-defer + demo-run STRATEGY knobs.
//
// `demoRunEnabled` flags the OPTIONAL demo-run stage (the "does the thing the spec was
// written for actually work" gate, after the auditor). It is hard for some project
// types, so it is OFF by default; a project/spec that can be e2e-exercised opts in.
//
// The VELOCITY-DEFER policy (spec-loop-redesign.md §convergence (c)) — the
// "leftovers are mild → defer them as specs + ALLOW the merge" middle-ground —
// is a CONFIGURABLE strategy, not a hard-coded one:
//   - `velocityDeferEnabled` — master switch for honoring a `velocity_defer`
//     assessment (default ON: today's behavior is to honor it).
//   - `velocityDeferMaxSeverity` — the WORST leftover severity that may be
//     deferred. A `velocity_defer` is honored only when EVERY kept leftover finding
//     is at-or-below this severity; a finding above it forbids the defer (the loop
//     keeps iterating instead of passing). Default `P3` — only P3-mild leftovers
//     defer, the documented "only P3 after several rounds" strategy.
//   - `velocityDeferAfterStalls` — the round count (consecutive non-progress reads
//     SO FAR) at-or-above which a `velocity_defer` may be honored. Default `0` — a
//     defer is allowed from the first round (today's behavior); raise it to require
//     the loop to grind for N rounds before mild leftovers are deferred.
// The defaults reproduce today's behavior EXACTLY: any `velocity_defer` the answerer
// emits is honored (enabled, P3-leftovers, from round 0).
export const ConvergencePolicyConfig = z
  .object({
    demoRunEnabled: z.boolean().default(false),
    velocityDeferEnabled: z.boolean().default(true),
    velocityDeferMaxSeverity: FindingSeverityConfig.default("P3"),
    velocityDeferAfterStalls: z.number().int().min(0).default(0),
  })
  .strict();
export type ConvergencePolicyConfig = z.infer<typeof ConvergencePolicyConfig>;

// The default convergence policy: demo-run off; velocity-defer ON, honoring up to
// P3-mild leftovers from the first round. The halt is the agent's intelligent escalation
// verdict (no count knob).
export const DEFAULT_CONVERGENCE_POLICY: ConvergencePolicyConfig = {
  demoRunEnabled: false,
  velocityDeferEnabled: true,
  velocityDeferMaxSeverity: "P3",
  velocityDeferAfterStalls: 0,
};

// ---- Errors --------------------------------------------------------------

// Thrown by the migration helpers when the persisted `version` discriminator
// is a value this build does not know how to read. Distinct from a plain
// parse failure so the caller can decide whether to refuse-start, warn, or
// hand the raw blob to an out-of-process migrator.
export class UnknownConfigVersionError extends Error {
  readonly observedVersion: unknown;
  readonly supportedVersions: ReadonlyArray<number>;
  constructor(observedVersion: unknown, supportedVersions: ReadonlyArray<number>) {
    super(`unknown config version: observed=${String(observedVersion)} supported=[${supportedVersions.join(",")}]`);
    this.observedVersion = observedVersion;
    this.supportedVersions = supportedVersions;
  }
}

// Helper used by both migration helpers: returns the observed version if
// present as a number, or undefined if the input is a legacy versionless
// object that should be migrated into V1 defaults.
export function readObservedVersion(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const candidate = (raw as { version?: unknown }).version;
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== "number" || !Number.isInteger(candidate)) {
    return Number.NaN;
  }
  return candidate;
}
