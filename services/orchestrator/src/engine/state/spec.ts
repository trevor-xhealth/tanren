import { z } from "zod";

/**
 * The execution priority of a spec (autonomy-engine.md §1b). It is NOT a state
 * machine value (no transitions) — it is the ordering key the DagWalker honors
 * when choosing which ready specs to enqueue first: P0 before P1 before P2 before
 * `tbd` (not yet triaged). It originates on a `ProposedSpec` (discovery/triage) and is
 * persisted onto the spec at create time. `priorityRank` maps it to a sortable
 * integer (lower = scheduled first); the DB CHECK in `db/src/schemaCore.ts`
 * mirrors these literals. `tbd` means not-yet-triaged and sorts last.
 */
export const SpecPriority = z.enum(["P0", "P1", "P2", "tbd"]);
export type SpecPriority = z.infer<typeof SpecPriority>;

/** The default priority a not-yet-triaged spec carries (matches the DB column default). */
export const DEFAULT_SPEC_PRIORITY: SpecPriority = "tbd";

/**
 * The WRITER-PROMPT MODE for a spec (task #86 — v64 root cause). Selects which standing
 * instructions `writerPromptFor()` emits for this spec's writer iterations:
 *
 * - `from_scratch` (default — greenfield's non-scaffold specs): the workspace is an empty
 *   or near-empty repo. The writer scaffolds the manifest, sources, configs, tests,
 *   regenerates the lockfile after manifest edits, etc.
 * - `modify_existing` (brownfield): the workspace is a PRE-EXISTING, AUTHORITATIVE
 *   repository — written by other people, green today, with its own conventions. The
 *   spec is a SCOPED AMENDMENT to it, never a rebuild of it. The writer is told to read
 *   before writing, follow the repo's established patterns, make the smallest coherent
 *   change, treat the existing tests as a contract, and leave high-blast-radius surfaces
 *   (dependency manifests + lockfiles, build/lint/test config, CI definitions, ownership
 *   policy, schema/migration history) alone UNLESS the spec explicitly requires them.
 *   `from_scratch` was labelled "the brownfield path" but instructed the writer to "Build
 *   everything ELSE — the manifest/lockfile, sources, configs, tests, fixtures", which
 *   against a real 12k-file repository is an instruction to REBUILD it. This arm is the
 *   fix; nothing opts into it by default except the brownfield onboarding seed path
 *   (`engine/forge/brownfield/seed.ts`), so no existing project type changes behavior.
 * - `specialize_seed` (greenfield's scaffold spec, post-PR-G): the workspace's initial
 *   commit IS the composed VFS — manifest, lockfile, tsconfig, contract files, source
 *   skeleton are already in place AND proven green by composition. The writer
 *   specializes the seed (renames product identity, wires deploy/env, updates READMEs)
 *   and MUST NOT rebuild the manifest, regenerate the lockfile, edit configs, add new
 *   tests/lint configs, etc. The contradictory `WRITER_GRADING_INSTRUCTION` ("Build
 *   everything ELSE — the manifest/lockfile, sources, configs, tests, fixtures") was
 *   v64's writer-checker non-convergence root cause (6 hours, 61 writer iterations,
 *   ZERO merges — each iteration a different over-broad diff, so the fixed-point
 *   detector never fired).
 *
 * The DB CHECK in `db/src/schemaCore.ts` mirrors these literals (migration 0113 widened
 * it for `modify_existing`); the column default is `from_scratch` and STAYS there —
 * every non-default arm is opted into explicitly by the path that creates the spec.
 */
export const SpecMode = z.enum(["specialize_seed", "from_scratch", "modify_existing"]);
export type SpecMode = z.infer<typeof SpecMode>;

/** The default spec mode (matches the DB column default): the from-scratch authoring
 * the writer guidance was originally written for. UNCHANGED by the `modify_existing`
 * arm — adding a third mode must not move any existing project type. EVERY foundation
 * spec (greenfield's `scaffold` · `build` · `deploy`) opts INTO `specialize_seed`
 * explicitly at `scaffoldSpecsFor()` — each specializes a surface the composed seed
 * already shipped (justfile recipes, the toolchain) for THIS product. Brownfield
 * onboarding opts INTO `modify_existing` explicitly at `seedDagFromReconAndIssues()` —
 * a property of the brownfield CREATION path, deliberately not a global default flip. */
export const DEFAULT_SPEC_MODE: SpecMode = "from_scratch";

const SPEC_PRIORITY_RANK: Record<SpecPriority, number> = { P0: 0, P1: 1, P2: 2, tbd: 3 };

/** Sortable rank for a priority — lower sorts first (P0=0 … tbd=3). */
export function priorityRank(priority: SpecPriority): number {
  return SPEC_PRIORITY_RANK[priority];
}

// The single, canonical spec-status vocabulary (v21). A spec is `open` (ready to
// schedule, not yet started), `in_flight` (occupying a DAG slot — claimed or
// running), `review` (PR open, awaiting merge), or `merged` (the satisfied
// terminal). `halted`/`cancelled` are terminal-blocked; `needs_attention` is the
// bounded-escalation terminal. There is NO second `pending/active/done` vocabulary
// — every producer and consumer speaks THIS one, so `classifySpecStatus` no longer
// normalizes two enums.
export const SpecStatus = z.enum([
  "open",
  "in_flight",
  "review",
  "merged",
  "halted",
  "cancelled",
  // NEVER-STRAND escalation (the safety-net reconciler): a spec the
  // strand-reconciler re-enqueued more than the bounded number of times is moved
  // to `needs_attention` — a TERMINAL escalation status that frees the DAG slot
  // and blocks ONLY its dependents (never the whole DAG), surfacing a loud,
  // bounded ask-for-help rather than re-enqueuing forever. (Also reused for
  // genuine-conflict escalation.)
  "needs_attention",
]);
export type SpecStatus = z.infer<typeof SpecStatus>;

const allowedSpecTransitions: Record<SpecStatus, ReadonlyArray<SpecStatus>> = {
  // A fresh spec is `open`; claiming a slot moves it `in_flight`. The operator
  // cancel-spec action (workflow/cancelSpec) can cancel a not-yet-started `open`
  // spec directly (`open → cancelled`) — the operator decided it should not run.
  // A still-`open` dependent of a CANCELLED ancestor is escalated to
  // `needs_attention` for a human decision (the escalation discipline — never a
  // silent cascade-cancel), so `open → needs_attention` is also legal.
  open: ["in_flight", "cancelled", "needs_attention"],
  // The strand-reconciler flips `in_flight → open` (re-enqueue) and, on bounded
  // escalation, `in_flight → needs_attention` (give up loudly). A merge can also
  // land an in-flight spec directly at `merged` (the native-queue drive path).
  in_flight: ["review", "merged", "halted", "cancelled", "open", "needs_attention"],
  // A spec whose PR is open + awaiting merge can still be operator-cancelled
  // (`review → cancelled`) — the operator abandons the in-review work — or parked
  // for a human decision when its ancestor was cancelled (`review → needs_attention`).
  review: ["merged", "halted", "cancelled", "needs_attention"],
  halted: ["in_flight", "cancelled"],
  merged: [],
  cancelled: [],
  // A spec surfaced for human attention is not AUTO-transitioned onward by any
  // background loop (the strand reconciler / merge coordinator never re-touch it).
  // The ONE permitted exit is the operator's explicit human-in-the-loop resolution
  // (the `requeue` endpoint, workflow/requeueAttentionSpec): once the human has
  // ADDRESSED the underlying blocker they re-enter the spec at `open` so the
  // DagWalker re-picks it up. This is the escalation discipline's "addressed,
  // proceed" — the only transition out of the bounded-escalation terminal.
  needs_attention: ["open"],
};

export function isAllowedSpecTransition(from: SpecStatus, to: SpecStatus): boolean {
  return allowedSpecTransitions[from].includes(to);
}

export class IllegalSpecTransitionError extends Error {
  constructor(
    readonly from: SpecStatus,
    readonly to: SpecStatus,
  ) {
    super(`illegal spec transition: ${from} -> ${to}`);
  }
}

export function transitionSpec(from: SpecStatus, to: SpecStatus): asserts to is SpecStatus {
  if (!isAllowedSpecTransition(from, to)) {
    throw new IllegalSpecTransitionError(from, to);
  }
}
