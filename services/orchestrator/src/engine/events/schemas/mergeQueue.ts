import { z } from "zod";
import { MergeIntegrationMode } from "./integrations.js";

// autonomy-engine.md §2d: the native intelligent merge queue. Under
// `native_queue`, a ready-to-merge run ENTERS Tanren's own queue instead of
// merging immediately; the MergeCoordinator then orders ready runs in DAG order
// (ancestor before dependent, priority within a layer) and SERIALIZES their merges
// (one at a time), driving the SAME per-run merge path. These events make the
// queue's decisions visible + feed queue/stack statistics.
//
//   - merge.queue.advanced  → the coordinator selected the next run to merge (the
//                             head of the DAG-ordered queue) and is driving its
//                             merge. Carries the queue depth + the chosen run's spec
//                             so the timeline shows WHY it was next.
//   - merge.dequeued        → a queue entry left the queue WITHOUT merging: it was
//                             routed back (conflict → recoverable hold) or removed
//                             so independent later items can proceed (liveness). The
//                             `reason` records which. NOT a merge — a dequeue.
//
// (merge.queued — the entry event — reuses MergeQueuedPayload with the
// `native_queue` integration; merge.completed reuses MergeCompletedPayload.)
//
//   - merge.scheduled       → a NEW PR was pushed (github.pr.created just fired) and the
//                             native-queue enqueue happened IMMEDIATELY at PR-create time
//                             (apex v67/v69 loop-close fix). DURABLE pre-merge signal that
//                             the merge coordinator now owns this PR; distinct from
//                             merge.queued (which fires when the writer's outer loop
//                             reaches the late-path enqueueNative — fragile to halt/throw
//                             in the intervening review/gate chain). The coordinator's
//                             `MergeAuthority.authorizeLand` still enforces every gate
//                             before the actual land, so an early-scheduled entry HOLDS
//                             until gate+review+mergeability+everything clears.

export const MergeScheduledPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
  })
  .strict();

export const MergeQueueAdvancedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    /** The spec whose run the coordinator selected as the queue head this pass. */
    specId: z.string(),
    /** The queue depth (ready entries) at selection time, for queue statistics. */
    queueDepth: z.number().int().nonnegative(),
  })
  .strict();

export const MergeDequeuedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    /** The spec whose entry left the queue. */
    specId: z.string(),
    /**
     * Why the entry was dequeued without merging:
     *   - `conflict`  — the merge hit a real conflict and was routed to the conflict resolver
     *                   resolver / recoverable hold (re-queued on the next signal).
     *   - `blocked`   — a governance/posture or speculative hold removed it from the
     *                   head so independent later items can proceed (re-queued later).
     *   - `failed`    — the merge failed terminally; the entry is removed.
     *   - `superseded`— a fresh percolation re-execution replaced this run; its entry
     *                   + PR are no longer a live merge candidate (§2c). NOT a real
     *                   conflict — the entry is retired so the spec has ONE live run.
     *   - `needs_attention` — the intent-preserving resolver judged the spec GENUINELY
     *                   irreconcilable; it parked at the terminal `needs_attention`
     *                   status (freeing its slot) and is NEVER re-queued (§2c — the
     *                   loud, non-bricking escalation). Distinct from recoverable
     *                   `conflict` (which re-queues) and infra `failed`.
     */
    reason: z.enum(["conflict", "blocked", "failed", "superseded", "needs_attention"]),
    /** The human-readable detail of the dequeue (the merge-stage message). */
    message: z.string(),
  })
  .strict();

// GitHub-5xx resilience (GAP #2d): a transient/transport INFRA error (a 5xx/timeout)
// blocked the per-PR coordinator's merge DRIVE — distinct from the recoverable
// conflict/blocked dequeue. The coordinator HOLDS the entry (it stays queued) + arms a
// delayed re-drive, bounded by a hold-attempt ceiling. This LOUD event fires when the
// short retry can no longer recover on its own or operator action is required:
//   - `kind: "ceiling"`     → the entry exhausted its consecutive infra re-drives (a
//                             persistent outage / a logic-bug-masquerading-as-infra);
//                             the entry stays queued and re-drives with longer backoff.
//   - `kind: "ambiguous"`   → the merge PUT hit a 5xx and the merged state could NOT be
//                             confirmed; auto-re-driving could double-merge, so the
//                             coordinator HALTS without re-PUTting (operator decides).
//   - `kind: "missing_required_credential"` → the merge drive cannot run until a
//                             required credential/config is repaired; the head is
//                             dequeued so later entries can proceed.
// It exists so a persistent infra error / an unconfirmable merge surfaces loudly instead
// of silently re-driving forever OR risking a double-merge.
export const MergeQueueInfraBlockedPayload = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    integration: MergeIntegrationMode,
    /** The spec whose entry the infra error blocked. */
    specId: z.string(),
    /** Which loud alert/halt case fired. */
    kind: z.enum(["ceiling", "ambiguous", "missing_required_credential"]),
    /** How many consecutive infra re-drives were attempted before the loud halt. */
    attempts: z.number().int().nonnegative(),
    /** The human-readable detail of the infra error / ambiguity. */
    message: z.string(),
  })
  .strict();

// autonomy-engine.md §2d — speculative batch-check + bisect: the
// intelligence layer ON TOP OF the native queue. The coordinator forms a BATCH of
// mutually-eligible entries, speculatively integrates `default_branch + batch PRs`,
// and CI-checks that PROSPECTIVE merged state BEFORE any real merge — catching a bad
// *interaction* (PRs that pass alone but break together) without touching `main`. On
// a failed batch it BISECTS to isolate the offending PR (rather than failing the
// whole batch), removes it, and re-checks the innocent remainder.
//
//   - merge.batch.checking  → the coordinator formed a batch + is speculatively
//                             integrating + CI-checking the prospective merged state.
//   - merge.batch.passed    → the batch check is GREEN; the coordinator will merge
//                             every batch entry in DAG order (no re-surprises).
//   - merge.batch.bisecting → the batch check FAILED; the coordinator is binary-
//                             searching the batch to isolate the offending PR.
//   - merge.batch.culprit_set_identified (rv-25 runtime vocabulary) → bisection
//                             isolated the culprit SET (ddmin/QuickXPlain minimal
//                             failing subset); each member is dequeued to a
//                             recoverable outcome (re-execution, NOT dropped) and
//                             the innocent remainder is re-checked. The schema
//                             lives in runtimeVocabulary.ts (the runtime
//                             behavior-proof vocabulary freeze).

/** The batch member shape echoed on the batch events (the PRs in the batch). */
const BatchMember = z
  .object({
    specId: z.string(),
    prNumber: z.number().int(),
  })
  .strict();

export const MergeBatchCheckingPayload = z
  .object({
    integration: MergeIntegrationMode,
    /** The entries in the formed batch, in DAG (merge) order. */
    members: z.array(BatchMember),
    /** The total eligible count this pass (≥ members.length when the batch was capped). */
    eligibleCount: z.number().int().nonnegative(),
    /** True when more entries were eligible than the configured cap (the batch was capped). */
    capped: z.boolean(),
    /** The configured max batch size (the cap). */
    maxBatchSize: z.number().int().positive(),
  })
  .strict();

export const MergeBatchPassedPayload = z
  .object({
    integration: MergeIntegrationMode,
    /** The validated batch members the coordinator will now merge in DAG order. */
    members: z.array(BatchMember),
    /** The ephemeral integration ref the prospective merged state was checked on. */
    integrationBranch: z.string(),
  })
  .strict();

export const MergeBatchBisectingPayload = z
  .object({
    integration: MergeIntegrationMode,
    /** The failed batch being bisected, in DAG order. */
    members: z.array(BatchMember),
    /** The human-readable detail of the batch-check failure that triggered the bisect. */
    message: z.string(),
  })
  .strict();

// merge.batch.infra_blocked → the batch check could NOT be run/set up at all: a
// transient/transport INFRA error (e.g. the speculative integration ref reset threw an
// HTTP 422). This is NOT a CI failure and NOT a merge conflict — so NO PR is bisected,
// blamed, or dequeued. The coordinator bounded-retried the SAME batch and, on
// exhaustion, emits this LOUD event + HOLDS (entries stay queued, recovered on a
// delayed re-drive). It exists so a persistent infra error surfaces loudly instead of
// silently retrying forever OR wrongly dequeuing a clean PR.
export const MergeBatchInfraBlockedPayload = z
  .object({
    integration: MergeIntegrationMode,
    /** The held batch members (still queued — NONE dequeued), in DAG order. */
    members: z.array(BatchMember),
    /** The human-readable detail of the infra error that blocked the check. */
    message: z.string(),
    /** How many check attempts were made before holding (the exhausted retry budget). */
    attempts: z.number().int().nonnegative(),
    /**
     * The alert threshold fired (optional; absent ⇒ the recoverable in-pass hold).
     * A recoverable infra hold re-drives every `INFRA_HOLD_RETRY_AFTER_MS` — but a
     * PERSISTENT outage would otherwise stay quiet. After `consecutiveHolds` CROSS-PASS
     * consecutive infra holds the coordinator emits this TERMINAL alert
     * (`terminal: true`) — operator attention required — while retriable infra entries
     * remain queued and continue to re-drive with a longer backoff.
     */
    terminal: z.boolean().optional(),
    /** When terminal: the count of consecutive cross-pass infra holds that hit the cap. */
    consecutiveHolds: z.number().int().nonnegative().optional(),
    /**
     * Machine-readable terminal cause. Missing required credentials are repairable
     * by a later credential.github.configured/credential.configured event. Ambiguous
     * merge state stays terminal because auto-retry could double-merge.
     */
    kind: z.enum(["missing_required_credential", "ambiguous_merge_state"]).optional(),
  })
  .strict();

// merge.batch.culprit_set_identified lives in runtimeVocabulary.ts (rv-25 freeze);
// the legacy singular `merge.batch.culprit` schema was removed (clean-replace)
// and the name retained in `RETAINED_HISTORICAL_EVENTS` so historical rows
// don't violate the `events.event_type` FK.

// merge.batch.gate_rework_routed → the batch check's GATE/CI failed on the prospective
// MERGED state (an integration-only failure — code that passed its OWN branch gates but
// breaks integrated, e.g. a config file outside the integrated tsconfig), bisect isolated
// ONE culprit PR, and the coordinator routed that culprit back to the WRITER for rework
// (carrying the batch gate's failing output as steering) rather than stranding it. This is
// DISTINCT from a batch CONFLICT (which routes to the conflict resolver / replan): a
// gate-fail is fixed by re-authoring the code. It is the bounded-rework budget KEY: a spec
// re-worked `disposition: "escalated"` has exhausted that budget and was parked
// `needs_attention` instead of re-worked again (no strand, no hot-loop).
export const MergeBatchGateReworkRoutedPayload = z
  .object({
    integration: MergeIntegrationMode,
    /** The culprit spec routed back to the writer to fix the integrated-tree gate failure. */
    specId: z.string(),
    /** The run id whose work failed the integrated gate (the run being re-authored). */
    runId: z.string(),
    prNumber: z.number().int(),
    /** Whether a fresh rework run was enqueued, or the bounded budget escalated to needs_attention. */
    disposition: z.enum(["reworked", "escalated"]),
    /** The batch gate's failing tier/step/output — the steering the writer re-authors against. */
    gateError: z.string(),
    /** How many prior gate-reworks this spec had before this routing (the bounded-budget count). */
    priorReworks: z.number().int().nonnegative(),
  })
  .strict();

// mq-8 EAGER beam lifecycle. These events narrate build preparation only; neither
// payload is an authority decision and neither can advance a queue entry.
export const MergeBeamPlannedPayload = z
  .object({
    projectId: z.string(),
    beamId: z.string(),
    frontierRunId: z.string(),
    frontierSpecId: z.string(),
    planDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    integrationNodeId: z.string(),
    rank: z.number().int().positive(),
    generation: z.number().int().positive(),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
    memberShas: z.array(z.string().regex(/^[0-9a-f]{40}$/u)).min(1),
  })
  .strict();

export const MergeBeamStalePayload = z
  .object({
    projectId: z.string(),
    beamId: z.string(),
    frontierRunId: z.string(),
    reason: z.string().min(1),
    planDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/u)
      .optional(),
  })
  .strict();

// merge.regate.gate_rework_routed → a PRE-MERGE re-gate (a base-shift / queued-merge
// re-gate of a cleanly-rebased-or-resolved tree) FAILED a deterministic GATE TIER
// (lint/test/build) — the rebase itself was CLEAN (no merge conflict), the code just
// fails a gate on the new base. The resolver routes the merging spec back to the WRITER
// for REWORK (carrying the re-gate's failing tier/step/output as steering) instead of
// mis-classifying it as `merge.conflict.irreconcilable` + escalating. DISTINCT from a
// genuine merge conflict (which routes to replan): a clean-rebase + failed-gate is fixed
// by re-authoring the code. `disposition: "escalated"` means the convergence detector
// proved a FIXED POINT (the SAME gate error recurs after re-authoring) and parked it
// `needs_attention` instead of re-working identically forever (no strand, no count).
export const MergeReGateGateReworkRoutedPayload = z
  .object({
    integration: MergeIntegrationMode,
    /** The merging spec routed back to the writer to fix the re-gate's GATE-tier failure. */
    specId: z.string(),
    /** The run id whose rebased/resolved tree failed the re-gate (the run being re-authored). */
    runId: z.string(),
    prNumber: z.number().int(),
    /** Whether a fresh rework run was enqueued, or the convergence detector escalated to needs_attention. */
    disposition: z.enum(["reworked", "escalated"]),
    /** The re-gate's failing tier/step/output — the steering the writer re-authors against. */
    gateError: z.string(),
    /** How many prior gate-reworks this spec had before this routing (a diagnostic, NOT a cap). */
    priorReworks: z.number().int().nonnegative(),
  })
  .strict();

export const MergeMemberIsolatedPayload = z
  .object({
    projectId: z.string().min(1),
    partitionId: z.string().min(1),
    groupId: z.string().min(1),
    memberId: z.string().min(1),
    reason: z.enum(["audit_policy", "member_gate", "behavior_proof", "design_proof"]),
    findingIds: z.array(z.string().min(1)),
  })
  .strict();

export const MergePartitionLeasedPayload = z
  .object({
    projectId: z.string().min(1),
    partitionId: z.string().min(1),
    leaseOwner: z.string().min(1),
    leaseHeartbeatAt: z.string().datetime({ offset: true }),
    generation: z.number().int().nonnegative(),
    scopeFingerprint: z.string().min(1).optional(),
  })
  .strict();

export const MergePartitionReleasedPayload = z
  .object({
    projectId: z.string().min(1),
    partitionId: z.string().min(1),
    leaseOwner: z.string().min(1),
    generation: z.number().int().nonnegative(),
  })
  .strict();

// mq-10 — the autonomous-repair router's decision on an isolated member. EVERY routing
// emits `merge.repair.routed` (the exhaustive decision record); a `respec` ALSO emits
// `merge.member.respec_routed` (the behavior-proof chain's event) carrying the RespecPacketV1
// lineage. `disposition` is exhaustive + fail-closed: an unclassifiable failure routes to
// `blocked_needs_attention`, never a silent drop.
export const MergeRepairRoutedPayload = z
  .object({
    projectId: z.string().min(1),
    sourceSpecId: z.string().min(1),
    groupId: z.string().min(1),
    evaluationId: z.string().min(1),
    disposition: z.enum(["repair_in_place", "respec", "blocked_needs_attention"]),
    failureClass: z.enum([
      "deterministic_policy",
      "needs_product_decision",
      "unknown_fail_closed",
      "transient_infrastructure",
    ]),
    failureSignature: z.string().min(1),
    /** The non-shrinking finding count (a DIAGNOSTIC of the fixed point, never a retry cap). */
    magnitude: z.number().int().nonnegative(),
    /** Why a `blocked_needs_attention` routing fell closed (empty otherwise). */
    blockedReason: z.string().optional(),
  })
  .strict();

export const MergeMemberRespecRoutedPayload = z
  .object({
    projectId: z.string().min(1),
    sourceSpecId: z.string().min(1),
    groupId: z.string().min(1),
    evaluationId: z.string().min(1),
    /** The RespecPacketV1 content hash (= `respec_routes.packet_hash`). */
    packetHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    /** The route that reached the fixed point in place. */
    priorAgentRoute: z.string().min(1),
    /** The DIFFERENT agent the respec routes to (never equal to `priorAgentRoute`). */
    nextAgentRoute: z.string().min(1),
    /** The respec generation this packet minted (>= 1). */
    generation: z.number().int().positive(),
    /** The replacement spec(s) the re-drive materialized (>= 1: the intent survives). */
    replacementSpecIds: z.array(z.string().min(1)).min(1),
    /**
     * The AUTHORING MODE (`SpecMode`) the replacement spec carries — inherited from the stuck
     * parent, because the mode describes the WORKSPACE the writer opens and a re-spec targets
     * the same project. Present so the mode a re-spec hands its replacement is OBSERVABLE at
     * the moment it is decided: a re-spec used to silently flip a brownfield spec back to
     * `from_scratch`, and the first symptom was an enormous scope-violating diff. The literal
     * set is pinned to `engine/state/spec.ts`'s `SpecMode` (and thus the `specs_mode_check`
     * CHECK) by `respecInheritsSpecMode.test.ts`, so a widened enum cannot drift past the
     * event contract in silence — the exact failure mode this whole change is about.
     */
    specMode: z.enum(["specialize_seed", "from_scratch", "modify_existing"]),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.priorAgentRoute === p.nextAgentRoute) {
      ctx.addIssue({ code: "custom", path: ["nextAgentRoute"], message: "respec must route to a DIFFERENT agent" });
    }
  });

export const mergeQueueWave3EventRegistry = {
  "merge.member.isolated": MergeMemberIsolatedPayload,
  "merge.partition.leased": MergePartitionLeasedPayload,
  "merge.partition.released": MergePartitionReleasedPayload,
  "merge.repair.routed": MergeRepairRoutedPayload,
  "merge.member.respec_routed": MergeMemberRespecRoutedPayload,
} as const;
