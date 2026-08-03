// Brownfield recon's EXPLORATION LOOP — the agentic replacement for the fixed
// content budget.
//
// THE DEFECT THIS RETIRES. Recon was one non-agentic call over 24 pre-chosen
// files. A constant decided, in advance and by heuristic, which two dozen files
// the model was allowed to read; it could not ask for anything else. If
// understanding a repository required the 25th file, recon simply could not.
// That is the same species of arbitrary cap `convergenceDetector.ts` exists to
// abolish — it merely predated the lint's reach.
//
// The naive fix (raise the constant) is wrong: twelve thousand files of content
// fit in no context window, would cost enormously per attempt, and offer no
// partial progress. "The entire repo" has to mean REACHABLE, not resident. So
// the model NAVIGATES — list, find, read — and the loop runs until it converges.
//
// CONVERGENCE, NOT A COUNT. This reuses the SHARED detector every other tanren
// loop uses (`decideConvergence` + `fixedPointRuleJudgment`), mapping the
// exploration onto its three axes:
//
//   • failureSignature — WHAT THIS TURN LEARNED: a digest of the file content
//     newly observed, or `learned:nothing`. Note that progress is keyed on what
//     came BACK, never on what was ASKED: a model issuing a fresh wrong guess
//     every turn would otherwise "progress" forever.
//   • workSignature    — the digest of the whole evidence corpus so far. Two
//     consecutive turns that add nothing leave it byte-identical: no new
//     information, which is exactly the detector's fixed point.
//   • magnitude        — files whose content recon has still never seen. It
//     shrinks with every genuinely new read, so a model steadily working through
//     a large repository reads as PROGRESS at every step, unbounded, and is
//     never cut off for taking many turns.
//
// COVERAGE, THE AXIS THE CORPUS CANNOT SEE. Those three axes are all read over
// the EVIDENCE, never over the repository, and that is a real blind spot: a
// model that opens 58 files inside one product subtree reaches the fixed point
// honestly while a second language, an infrastructure estate and a 4,387-file
// sibling product have never been touched — and then presents that as complete.
// So at the fixed point, and only there, the loop consults one more thing: the
// top-level areas it has read NO content under (`reconAreas.ts`). Where some
// remain, it spends ONE turn asking about them rather than finalizing.
//
// That ask is itself governed by progress, not by a budget: it may only repeat
// while the untouched set is STRICTLY SMALLER than at the previous ask. The set
// is monotone non-increasing and bounded below, so the asks form a finite
// descent whose length is bounded by the repository's own directory count; a
// model that ignores the ask costs exactly one extra turn, because the set is
// then unchanged and the next fixed point finalizes. Coverage can DELAY
// convergence while it is still improving and can never prevent it — "keep going
// until you have touched everything" is exactly what it must not become.
//
// WHY IT PROVABLY TERMINATES. Progress requires observing file content not
// already in the corpus, and (path × offset) is finite — so the loop either
// reports, or exhausts the repository and then converges. Two consecutive
// no-new-information turns is a fixed point; the loop responds by asking for the
// report with a NARROWED output schema that cannot express another request,
// after at most the finite run of coverage asks above. It never escalates to a
// human: an operator has nothing to add to "you have read enough", and a thin
// report that names its own gaps is the useful answer.
//
// WHY THIS STAYS AN ANSWERER (PROJECT_BRIEF §3.1/§3.2). Writers are the role
// with a filesystem; the target repository is not checked out anywhere, and
// cloning a customer's code into a runner to hand a write-capable agent a shell
// over it is a different — and far more dangerous — change. Here the model never
// touches a filesystem: it emits strict JSON naming what it wants, and the
// ENGINE fetches it over the same read-only GitHub surface recon always used.
// Read-only, strict-JSON, schema-validated: the Answerer contract, unweakened.

import { createHash } from "node:crypto";
import {
  type AttemptSignature,
  decideConvergence,
  fixedPointRuleJudgment,
} from "../../workflow/convergenceDetector.js";
import { createLogger } from "../../observability/logger.js";
import { rollUpAreas, uncharacterizedAreas, type ReconArea } from "./reconAreas.js";
import { reconcileCitations } from "./reconCitations.js";
import type { ReconIndex, ReconObservation, ReconReport, ReconTurnAnswerer, RepoExplorer } from "./types.js";

/**
 * The exploration produced no report even when asked for one directly. Only
 * reachable through an answerer that ignores the narrowed finalize schema, so it
 * is a LOUD contract breach rather than a silent empty report — recon's output
 * is consumed by the config-injection PR and the DAG seed, which cannot tell a
 * hollow report from a real one.
 */
export class ReconExplorationStalledError extends Error {
  constructor(readonly repoUrl: string) {
    super(
      `recon aborted: the recon answerer was asked to finalize its report for ${repoUrl} and asked to ` +
        `keep exploring instead. The finalize turn's output schema admits only a report, so this is a ` +
        `broken answerer, not a long exploration.`,
    );
    this.name = "ReconExplorationStalledError";
  }
}

/** What one turn cost and what it bought — the per-turn observability record. */
export interface ReconExplorationTurn {
  /** 1-based ordinal. A DIAGNOSTIC for the operator; nothing reads it as a budget. */
  readonly ordinal: number;
  readonly requests: number;
  /** Content observations this turn that were not already in the corpus. */
  readonly newContent: number;
  /** Cumulative content bytes fetched — the exploration's running cost. */
  readonly bytesRead: number;
  /** Indexed files whose content recon has still never seen. Shrinks with progress. */
  readonly unreadFiles: number;
  /** Top-level areas recon has read NO content under. The COVERAGE magnitude. */
  readonly unreadAreas: number;
  readonly learned: boolean;
}

/** The whole exploration, as the route reports it back to the operator. */
export interface ReconExplorationTrace {
  readonly turns: readonly ReconExplorationTurn[];
  readonly filesRead: number;
  readonly bytesRead: number;
  /** `reported` — the model finished; `converged` — it stopped learning and was asked to. */
  readonly endedBy: "reported" | "converged";
  /** Citations naming a path recon probed and did not find (`reconCitations.ts`). */
  readonly unverifiedCitations: number;
}

export interface ExploreReconInput {
  explorer: RepoExplorer;
  answerer: ReconTurnAnswerer;
  /** The entry point: the rollup + seed previews the exploration navigates out from. */
  index: ReconIndex;
  repoUrl: string;
}

export interface ExploreReconResult {
  report: ReconReport;
  exploration: ReconExplorationTrace;
}

// An unbounded loop that silently spends is worse than the cap it replaced, so
// every turn emits one structured line naming what it asked for, what it learned
// and how much of the repository it has left — live, not only in the summary the
// route returns at the end.
const log = createLogger("brownfield-recon");

function digest(parts: readonly string[]): string {
  // NUL-joined: no path, pattern or file body can contain it, so two different
  // observations can never collide into the same digest by concatenation.
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/** The corpus key of one observation: what was asked, and exactly what came back. */
function evidenceKey(observation: ReconObservation): string {
  return digest([
    observation.request.kind,
    observation.request.target,
    String(observation.request.offset),
    observation.body,
  ]);
}

/**
 * Did this turn LEARN anything? Only newly-observed file CONTENT counts.
 *
 * `list` and `find` are navigation over a tree the model already has a rollup
 * of — they shape the next read without themselves being new knowledge. Counting
 * them would let an endless stream of distinct-but-useless queries read as
 * perpetual progress, which is precisely the failure mode "converges" must not
 * be allowed to mean. One orienting turn costs nothing (a single non-learning
 * turn is never a fixed point); two in a row means it is time to write.
 */
function learningKeysOf(observations: readonly ReconObservation[], corpus: ReadonlySet<string>): string[] {
  return observations
    .filter((observation) => observation.outcome === "content" && observation.body !== "")
    .map((observation) => evidenceKey(observation))
    .filter((key) => !corpus.has(key));
}

/**
 * Should recon SPEND ANOTHER TURN on coverage before it finalizes?
 *
 * Only when the untouched set has genuinely shrunk since the last time it asked.
 * That predicate is the whole termination argument for this addition, and it is
 * the same shape every other loop here uses — forward motion, not a budget:
 *
 *   • `uncovered` is MONOTONE non-increasing (read paths only ever accumulate),
 *     and it is bounded below by zero, so a sequence of asks each requiring a
 *     STRICTLY smaller set is a finite descent. Its length is bounded by the
 *     repository's own top-level directory count — a fact about the tree, not a
 *     constant anyone chose.
 *   • an ask that changes nothing does not repeat: the set is unchanged, the
 *     strict-decrease test fails, and the very next fixed point finalizes. The
 *     worst case for a model that ignores the ask entirely is ONE extra turn.
 *   • a model that acts on it re-enters ordinary exploration, where the existing
 *     evidence fixed point governs exactly as before.
 *
 * So this can DELAY convergence while coverage is still improving and can never
 * prevent it. "Explore everything" is precisely what it must not become.
 */
function shouldAskAboutCoverage(uncovered: readonly ReconArea[], askedAt: number | undefined): boolean {
  if (uncovered.length === 0) return false;
  return askedAt === undefined || uncovered.length < askedAt;
}

export async function exploreUntilConverged(input: ExploreReconInput): Promise<ExploreReconResult> {
  const { explorer, answerer, index, repoUrl } = input;
  // Seeded with the entry-point previews: content recon has ALREADY seen, so
  // re-reading a seed file is not progress and the magnitude starts honest.
  const readPaths = new Set(index.files.filter((file) => file.preview !== "").map((file) => file.path));
  const seeded = readPaths.size;
  // The area rollup is a fact about the INDEX, which does not change across an
  // exploration — rolled up once here and filtered per turn.
  const areas = rollUpAreas(index.files.map((file) => file.path));
  const corpus = new Set<string>();
  const observations: ReconObservation[] = [];
  const attempts: AttemptSignature[] = [];
  const turns: ReconExplorationTurn[] = [];
  let bytesRead = 0;
  let notes = "";
  let finalize = false;
  // The areas named on THIS turn's completeness ask (empty on an ordinary turn),
  // and how many were outstanding at the last ask — the descent measure above.
  let unexploredAreas: readonly ReconArea[] = [];
  let askedAt: number | undefined;

  for (;;) {
    const turn = await answerer.turn({ index, observations, notes, finalize, unexploredAreas });
    if (turn.notes !== "") notes = turn.notes;
    if (turn.report !== undefined && turn.report !== null) {
      // A citation naming a path recon probed and did NOT find is marked before
      // the report leaves the loop: the report is consumed by the config-injection
      // PR and the DAG seed, neither of which can re-check a path for itself.
      const { report, unverifiedCitations } = reconcileCitations(turn.report, observations);
      if (unverifiedCitations > 0) log.info("recon.citations.unverified", { repoUrl }, { unverifiedCitations });
      return {
        report,
        exploration: {
          turns,
          filesRead: readPaths.size - seeded,
          bytesRead,
          endedBy: finalize ? "converged" : "reported",
          unverifiedCitations,
        },
      };
    }
    // The finalize turn's schema admits only a report, so reaching here means an
    // answerer that ignored it. Fail loud rather than loop.
    if (finalize) throw new ReconExplorationStalledError(repoUrl);

    const observed: ReconObservation[] = [];
    for (const request of turn.requests) {
      const observation = await explorer.explore(repoUrl, request);
      observations.push(observation);
      observed.push(observation);
    }

    const learned = learningKeysOf(observed, corpus);
    // ONLY learning observations enter the corpus. A `find` that matched nothing
    // or a re-read of a file already in it must leave the corpus byte-identical —
    // otherwise a model guessing a fresh wrong path every turn would keep moving
    // the work signature and never reach a fixed point.
    for (const key of learned) corpus.add(key);
    for (const observation of observed) {
      if (observation.outcome !== "content") continue;
      bytesRead += observation.body.length;
      readPaths.add(observation.request.target);
    }
    const unreadFiles = Math.max(0, index.files.length - readPaths.size);
    const uncovered = uncharacterizedAreas(areas, readPaths);
    turns.push({
      ordinal: turns.length + 1,
      requests: turn.requests.length,
      newContent: learned.length,
      bytesRead,
      unreadFiles,
      unreadAreas: uncovered.length,
      learned: learned.length > 0,
    });

    log.info("recon.exploration.turn", { repoUrl }, turns.at(-1));

    attempts.push({
      failureSignature: learned.length === 0 ? "learned:nothing" : `learned:${digest([...learned].sort())}`,
      workSignature: digest([...corpus].sort()),
      magnitude: unreadFiles,
    });
    const decision = await decideConvergence(attempts, (history) =>
      fixedPointRuleJudgment(
        history,
        () =>
          `recon's exploration of ${repoUrl} reached a FIXED POINT — consecutive turns surfaced no ` +
          `file content it had not already read, so there is nothing further to learn by reading`,
      ),
    );
    // "Escalate" here means "stop reading and write", NOT "wake a human": the
    // model has all the evidence it is going to get, and the next turn's narrowed
    // schema makes the report the only thing it can produce.
    //
    // Unless COVERAGE says otherwise. The fixed point above is measured over the
    // evidence corpus, so it fires just as confidently for a model that has read
    // one subtree deeply as for one that has read the repository — and on a real
    // 12k-file monorepo it did exactly that, converging honestly with 36% of the
    // tree never opened. Where areas remain untouched AND the untouched set has
    // shrunk since recon last raised it, spend one more turn asking about them
    // instead. `shouldAskAboutCoverage` is why that stays a finite descent.
    const stopped = decision.decision === "escalate";
    const ask = stopped && shouldAskAboutCoverage(uncovered, askedAt);
    if (ask) {
      askedAt = uncovered.length;
      log.info("recon.exploration.coverage", { repoUrl }, { unreadAreas: uncovered.length });
    }
    unexploredAreas = ask ? uncovered : [];
    finalize = stopped && !ask;
  }
}
