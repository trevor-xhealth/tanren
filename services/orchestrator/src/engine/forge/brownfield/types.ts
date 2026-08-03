// brownfield onboarding (full track): typed contracts for the
// read-only recon step.
//
// The brownfield "full track" goes beyond the minimal repo-link:
//   1. read-only RECON — a read-only Answerer EXPLORES the linked repo (the
//      engine fetches what the model asks for, turn by turn, until it converges)
//      and pre-fills the onboarding chapters (identity / personas / behaviors /
//      architecture / risks) plus the gap questions the operator must answer.
//   2. config-injection PR — propose 6 integration files, let the operator
//      exclude any, then open ONE PR in the target repo (no runs until merge).
//   3. DAG seed — turn recon gaps + GitHub issues into seed specs.
//   4. governance picker — wire the posture modes into onboarding.
//
// The recon Answerer is INJECTABLE/MOCKABLE — the same seam shape as the
// conversation + interview answerers: production wraps a
// provider read-only Answerer, tests inject a fake, and a deterministic
// fallback keeps the step live without provider infra. NOTHING here is
// persisted as a new entity-shape: the recon report is transient (carried on
// the request, like the greenfield capture) so there is NO migration.

import { z } from "zod";

// ── Repo index (what the read-only Answerer reads) ─────────────────────────

// A single indexed file the recon pass observed (path + size + a short head
// snippet for the Answerer to reason over). Read-only — recon never writes.
export const ReconIndexedFile = z
  .object({
    path: z.string().min(1).max(400),
    size: z.number().int().min(0).default(0),
    /** Decoded UTF-8 preview, truncated for prompt economy. */
    preview: z.string().max(8000).default(""),
  })
  .strict();
export type ReconIndexedFile = z.infer<typeof ReconIndexedFile>;

// The repo index handed to the Answerer: the files it read + summary counts.
export const ReconIndex = z
  .object({
    repoUrl: z.string().min(1).max(400),
    filesIndexed: z.number().int().min(0).default(0),
    files: z.array(ReconIndexedFile).default([]),
  })
  .strict();
export type ReconIndex = z.infer<typeof ReconIndex>;

// ── Recon chapters (the "what the agent extracted" panel) ──────────────────

export const ReconPersona = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(280),
    inferredFrom: z.string().max(200).default(""),
  })
  .strict();
export type ReconPersona = z.infer<typeof ReconPersona>;

export const ReconBehavior = z
  .object({
    persona: z.string().min(1).max(80),
    title: z.string().min(1).max(160),
    inferredFrom: z.string().max(200).default(""),
  })
  .strict();
export type ReconBehavior = z.infer<typeof ReconBehavior>;

export const ReconArchitectureLine = z
  .object({
    layer: z.string().min(1).max(40),
    detail: z.string().min(1).max(200),
  })
  .strict();
export type ReconArchitectureLine = z.infer<typeof ReconArchitectureLine>;

// A flagged risk. `severity` mirrors the inbox/notification levels so the UI
// can render it with the shared status glyphs.
export const ReconRisk = z
  .object({
    severity: z.enum(["info", "warn", "fail"]).default("warn"),
    note: z.string().min(1).max(280),
  })
  .strict();
export type ReconRisk = z.infer<typeof ReconRisk>;

// A gap the Answerer could not decide on its own — surfaced as a question the
// operator answers (the hi-fi "3 things I couldn't decide" cards). It also
// feeds the DAG-seed step (each unresolved gap can become a seed spec).
export const ReconGap = z
  .object({
    id: z.string().min(1).max(80),
    chapter: z.string().min(1).max(80),
    question: z.string().min(1).max(400),
    options: z.array(z.string().min(1).max(80)).max(4).default([]),
  })
  .strict();
export type ReconGap = z.infer<typeof ReconGap>;

// The full recon report the Answerer returns for a linked repo.
export const ReconReport = z
  .object({
    identity: z
      .object({
        slug: z.string().min(1).max(80),
        purpose: z.string().min(1).max(280),
        inferredFrom: z.string().max(200).default(""),
      })
      .strict(),
    personas: z.array(ReconPersona).default([]),
    behaviors: z.array(ReconBehavior).default([]),
    architecture: z.array(ReconArchitectureLine).default([]),
    risks: z.array(ReconRisk).default([]),
    gaps: z.array(ReconGap).default([]),
  })
  .strict();
export type ReconReport = z.infer<typeof ReconReport>;

// ── Navigation: what an EXPLORING recon may ask the engine to fetch ────────
//
// Recon used to see a fixed slice of the repository — the ranked signal files
// that won one of the reader's content slots — and nothing else, ever. If
// understanding a repo required the 25th file, recon could not read it.
//
// The fix is NOT a bigger slice (twelve thousand files of content fit in no
// context window, cost enormously, and lose everything on one failure). It is
// NAVIGATION: the model NAMES what it wants next, turn by turn, and the ENGINE
// fetches it. "Entire repo" therefore means REACHABLE, not resident.
//
// The three primitives are the ones an engineer actually uses in an unfamiliar
// repo, and only one of them costs a network round-trip:
//   • `list`  — the immediate children of a directory (free: served from the
//               already-fetched tree);
//   • `find`  — every path matching a substring or a `*` wildcard (free, same);
//   • `read`  — a slice of one file's CONTENT (the only request that costs a
//               GitHub call).
// `offset` pages through everything — a byte offset for `read`, an entry
// offset for `list` / `find` — so a file or a listing larger than one turn's
// slice is still reachable IN FULL across turns. Nothing is unreachable.
export const ReconRequestKind = z.enum(["read", "list", "find"]);
export type ReconRequestKind = z.infer<typeof ReconRequestKind>;

export const ReconRequest = z
  .object({
    kind: ReconRequestKind,
    /** A repo-relative path (`read`/`list`) or a path pattern (`find`). */
    target: z.string().min(1).max(400),
    /** Byte offset for `read`; entry offset for `list`/`find`. */
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export type ReconRequest = z.infer<typeof ReconRequest>;

/**
 * How many requests one turn may batch. This bounds a SINGLE TURN's width (so
 * one turn's observations still fit the prompt budget) — it is NOT a bound on
 * how much recon may read: the number of turns, and so the number of requests,
 * is decided by convergence, not by a constant.
 */
export const RECON_REQUEST_BATCH_WIDTH = 20;

/** What the engine observed on recon's behalf. Host-produced, never parsed. */
export interface ReconObservation {
  readonly request: ReconRequest;
  readonly outcome: "content" | "listing" | "matches" | "not_found";
  /** File slice (`read`) or newline-joined paths (`list`/`find`). */
  readonly body: string;
  /** Total available: file bytes for `read`, matching entries otherwise. */
  readonly total: number;
  /** How much of `total` this observation covers, starting at `offset`. */
  readonly covered: number;
}

// ── The injectable recon Answerer + repo reader seams ──────────────────────

/**
 * ONE turn of the exploration: either the next batch of navigation requests, or
 * the finished report. Strict JSON, exactly like every other Answerer output —
 * the model never touches a filesystem; it NAMES what it wants and the engine
 * fetches it read-only (PROJECT_BRIEF §3.2).
 */
export const ReconTurn = z
  .object({
    status: z.enum(["explore", "report"]),
    /**
     * The model's own carried-forward understanding. This is what lets recon
     * read more of a repository than fits in one context: file bodies age out
     * of the window, the conclusions drawn from them do not.
     */
    notes: z.string().max(4000).default(""),
    requests: z.array(ReconRequest).max(RECON_REQUEST_BATCH_WIDTH).default([]),
    report: ReconReport.nullish(),
  })
  .strict();
export type ReconTurn = z.infer<typeof ReconTurn>;

/** What one turn is shown: the entry-point index, what it has seen, its notes. */
export interface ReconTurnInput {
  index: ReconIndex;
  /** Every observation so far, oldest→newest. The prompt renders what fits. */
  observations: readonly ReconObservation[];
  notes: string;
  /**
   * Exploration converged (nothing further is being learned) — this turn MUST
   * return the report. The provider seam narrows the output schema so the model
   * cannot ask for more, which is why the loop provably cannot run forever.
   */
  finalize: boolean;
}

// The read-only Answerer, one turn at a time: given the evidence so far, either
// ask for more or return the chapters + gaps. Mirrors the conversation/interview
// answerer shape so it slots into the same seam.
export interface ReconTurnAnswerer {
  turn(input: ReconTurnInput): Promise<ReconTurn>;
}

// Injectable repo reader — production resolves an App token + reads the repo
// over the `GitHubHttpClient`; tests inject a fake index. Kept as a port so the
// recon engine never reaches into the provider HTTP surface directly.
export interface RepoReader {
  index(repoUrl: string): Promise<ReconIndex>;
}

/**
 * A `RepoReader` that can also be NAVIGATED. `index` stays the entry point (the
 * directory rollup + the ranked previews); `explore` answers one request against
 * the same READ-ONLY surface. Recon never writes through either.
 */
export interface RepoExplorer extends RepoReader {
  explore(repoUrl: string, request: ReconRequest): Promise<ReconObservation>;
}
