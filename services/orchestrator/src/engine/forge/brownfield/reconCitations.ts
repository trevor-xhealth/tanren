// Brownfield recon's CITATION INTEGRITY pass.
//
// PURE — no I/O. Given the report a turn produced and the observations the
// engine actually made on its behalf, it reconciles the two: a citation naming a
// path recon PROBED AND DID NOT FIND may not survive into the report unmarked.
//
// THE DEFECT. A real recon cited `docs/behaviors/B-0433-assign-and-track-….md`.
// The file is `B-0433-i-assign-and-track-….md`. The exploration log shows recon
// asked for its guessed spelling, received a 404, and cited the guess anyway —
// so a report that was otherwise scrupulously grounded carried one path that
// resolves to nothing. That is a small defect with an outsized cost: the report
// is consumed by the config-injection PR and the DAG seed, and a citation is the
// one thing a downstream reader is entitled to trust without re-checking. One
// dangling path makes every other path worth re-checking.
//
// WHY MARK RATHER THAN DELETE. The claim may well be right — the file usually
// exists under a name recon guessed slightly wrong, and silently deleting the
// citation would leave an UNSOURCED claim, which is worse than a flagged one.
// Marking it preserves both the claim and the fact that its source did not
// resolve, which is the same calibration the report already shows when it says
// outright that two architecture docs yielded no content.
//
// SCOPE, deliberately narrow. Only a `read` that came back `not_found` and was
// NEVER satisfied at that exact target counts: a model that probes `foo`, 404s,
// then reads `foo.md` has done nothing wrong, and a `find` that matched nothing
// is a search, not a citation. Nothing here judges whether the CLAIM is true —
// only whether the path behind it resolved.

import type { ReconObservation, ReconReport } from "./types.js";

/**
 * The annotation appended in place of a dangling path. Short, so annotating a
 * near-full citation field rarely overflows it.
 */
const UNVERIFIED = " (unverified: not found)";

/** Replaces a dangling path outright when annotating in place would not fit. */
const ELIDED = "(unverified path)";

/**
 * The longest citation any report field admits (`ReconReport`'s `inferredFrom`
 * and `ReconArchitectureLine.detail` both bound at 200). Reconciliation must not
 * push a field past what the schema accepts — the report is re-parsed at the
 * engine boundary, and a marked citation that fails validation would trade one
 * defect for a louder one.
 */
const CITATION_FIELD_CHARS = 200;

/**
 * Paths recon asked to READ and never got content for. Targets that were later
 * satisfied are excluded — a corrected second guess is not a dangling citation.
 */
export function unresolvedTargets(observations: readonly ReconObservation[]): Set<string> {
  const missing = new Set<string>();
  const found = new Set<string>();
  for (const observation of observations) {
    if (observation.request.kind !== "read") continue;
    if (observation.outcome === "not_found") missing.add(observation.request.target);
    else found.add(observation.request.target);
  }
  for (const target of found) missing.delete(target);
  return missing;
}

/**
 * Mark every dangling path inside one citation field. Annotates in place where
 * the field has room; where it does not, the path is replaced by the shorter
 * `ELIDED` marker so the field still says the citation did not resolve.
 */
function reconcileField(text: string, unresolved: ReadonlySet<string>): string {
  let reconciled = text;
  for (const target of unresolved) {
    if (!reconciled.includes(target)) continue;
    if (reconciled.includes(`${target}${UNVERIFIED}`)) continue;
    const annotated = reconciled.replaceAll(target, `${target}${UNVERIFIED}`);
    reconciled = annotated.length <= CITATION_FIELD_CHARS ? annotated : reconciled.replaceAll(target, ELIDED);
  }
  return reconciled;
}

export interface ReconciledReport {
  readonly report: ReconReport;
  /** Citation fields that named a path recon probed and did not find. */
  readonly unverifiedCitations: number;
}

/**
 * Reconcile every citation-bearing field of a report against what the engine
 * actually observed. Returns the report unchanged (and a count of zero) when no
 * citation names an unresolved path, which is the overwhelmingly common case.
 */
export function reconcileCitations(report: ReconReport, observations: readonly ReconObservation[]): ReconciledReport {
  const unresolved = unresolvedTargets(observations);
  if (unresolved.size === 0) return { report, unverifiedCitations: 0 };
  let unverifiedCitations = 0;
  const mark = (text: string): string => {
    const reconciled = reconcileField(text, unresolved);
    if (reconciled !== text) unverifiedCitations += 1;
    return reconciled;
  };
  const reconciled: ReconReport = {
    ...report,
    identity: { ...report.identity, inferredFrom: mark(report.identity.inferredFrom) },
    personas: report.personas.map((persona) => ({ ...persona, inferredFrom: mark(persona.inferredFrom) })),
    behaviors: report.behaviors.map((behavior) => ({ ...behavior, inferredFrom: mark(behavior.inferredFrom) })),
    architecture: report.architecture.map((line) => ({ ...line, detail: mark(line.detail) })),
  };
  return { report: reconciled, unverifiedCitations };
}
