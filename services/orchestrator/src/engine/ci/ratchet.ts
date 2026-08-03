// THE GATE-CONTRACT RATCHET — a run may STRENGTHEN the gate that judges it, never weaken it.
//
// `.tanren/ci.yml` is repo-sourced, so the SAME agent that authors the change also has write
// access to the contract the change is graded against. Under sole merge authority (no human
// approval; tanren's native gate is the only required check) that is a structural hole, not a
// hygiene issue: "the gate is failing, let me relax it" is an extremely natural repair action
// for a model with no bad intent at all. `subtaskWriterPrompt.IMMUTABLE_CONTRACT_FILES` states
// the rule in prose; this module makes it a MEASUREMENT.
//
// The rule is a RATCHET rather than a prohibition, because a spec whose whole purpose is to
// improve the gate ("add a test tier", "raise the coverage bar") must stay possible. So:
//   - a head contract at least as demanding as its baseline PASSES, and the run is then graded
//     by the NEW (stronger) contract — the improvement takes effect immediately, on the very
//     run that introduced it;
//   - a head contract that demands LESS than its baseline FAILS the gate, loudly.
//
// WHAT "WEAKER" MEANS. Comparison is over the RESOLVED, schema-valid config, per lifecycle
// point, and ONLY over the EVIDENCE-GATED points ({@link RATCHETED_GATE_POINTS} — `pre_audit`
// and `pre_merge`). Those are the points that carry merge authority; `per_iteration` is a
// writer-productivity loop whose relaxation cannot land anything, and ratcheting it would
// reject ordinary lifecycle edits for no security gain.
//
// At each ratcheted point we reduce the whole tier/step set to a {@link GateStrengthProfile} of
// monotone counters, and require every counter to be >= its baseline. Counters (not per-step
// identity) is deliberate: it survives legitimate refactors — renaming a step, splitting one
// step into two, merging two tiers — while still catching every way a contract can demand less.
// Sums rather than maxima, so moving a threshold off one step and onto another is neutral but
// deleting it is not.
//
// The comparison is STACK-AGNOSTIC and names no project, tool, tier, or test runner: it reads
// only the declarative shape every tanren operator's contract already has.
import { type CiConfigV1, type CiStep, type CiWhen, evidenceForStep } from "./schema.js";
import { stepsFor } from "./resolve.js";

// The lifecycle points the ratchet defends: the EVIDENCE-GATED points, the same set
// `CiConfigV1`'s superRefine already singles out as the ones that must carry positive proof.
// `per_iteration` is deliberately excluded — see the module header.
export const RATCHETED_GATE_POINTS: ReadonlyArray<CiWhen> = ["pre_audit", "pre_merge"];

/**
 * The monotone reduction of everything a contract DEMANDS at one lifecycle point. Every field
 * is "more is stricter", so the ratchet is a field-wise `head >= baseline` test. A dropped
 * `pre_merge` mapping shows up here as `steps: 0`; a lowered `minTests` as a smaller
 * `junitMinTests`; a deleted `evidence:` block as a smaller `evidenceSteps`.
 */
export interface GateStrengthProfile {
  /** Steps that execute at this point across every mapped tier. */
  readonly steps: number;
  /** Steps judged on POSITIVE PROOF rather than exit code alone. */
  readonly evidenceSteps: number;
  /** Total tests the point's junit evidence demands actually ran. */
  readonly junitMinTests: number;
  /** Total stdout-pattern occurrences the point's evidence demands. */
  readonly stdoutMatches: number;
  /** Steps that must produce an artifact. */
  readonly artifactChecks: number;
  /** Total bytes those artifacts must together weigh. */
  readonly artifactBytes: number;
}

/** The profile fields, in the order a weakening report lists them. */
const PROFILE_FIELDS: ReadonlyArray<keyof GateStrengthProfile> = [
  "steps",
  "evidenceSteps",
  "junitMinTests",
  "stdoutMatches",
  "artifactChecks",
  "artifactBytes",
];

/** One dimension at one lifecycle point where the head demands strictly less than the baseline. */
export interface GateWeakening {
  readonly when: CiWhen;
  readonly dimension: keyof GateStrengthProfile;
  readonly baseline: number;
  readonly head: number;
}

/**
 * Reduce a resolved contract to what it DEMANDS at one lifecycle point. Uses
 * {@link evidenceForStep}, so a legacy `junitReport:` with no explicit `evidence:` block counts
 * as the junit evidence it is promoted to (`minTests: 1`) — dropping the declaration is
 * therefore a measurable weakening, exactly as dropping an explicit block is.
 */
export function gateStrengthProfile(config: CiConfigV1, when: CiWhen): GateStrengthProfile {
  const steps = stepsFor(config, when);
  return {
    steps: steps.length,
    evidenceSteps: steps.filter((step) => evidenceForStep(step) !== undefined).length,
    junitMinTests: sumOver(steps, (evidence) => (evidence.kind === "junit" ? evidence.minTests : 0)),
    stdoutMatches: sumOver(steps, (evidence) => (evidence.kind === "stdout-count" ? evidence.min : 0)),
    artifactChecks: sumOver(steps, (evidence) => (evidence.kind === "artifact" ? 1 : 0)),
    artifactBytes: sumOver(steps, (evidence) => (evidence.kind === "artifact" ? (evidence.minBytes ?? 0) : 0)),
  };
}

function sumOver(
  steps: ReadonlyArray<CiStep>,
  score: (evidence: NonNullable<ReturnType<typeof evidenceForStep>>) => number,
): number {
  return steps.reduce((total, step) => {
    const evidence = evidenceForStep(step);
    return evidence === undefined ? total : total + score(evidence);
  }, 0);
}

/**
 * Every way `head` demands LESS than `baseline` at a ratcheted lifecycle point. An EMPTY result
 * means the head is at least as strict as the baseline everywhere it matters — the head is then
 * used verbatim, so a strengthening change grades its own run.
 *
 * Note what is NOT compared: the `run` command strings, `bootstrap`/`upgrade`/`deploy`, and the
 * `per_iteration` point. Command bodies are opaque shell by design (tanren names no stack), so
 * their strength is not measurable here — see the module header of `gate/contractRatchet.ts` for
 * what that leaves exposed.
 */
export function detectGateWeakening(baseline: CiConfigV1, head: CiConfigV1): GateWeakening[] {
  const findings: GateWeakening[] = [];
  for (const when of RATCHETED_GATE_POINTS) {
    const before = gateStrengthProfile(baseline, when);
    const after = gateStrengthProfile(head, when);
    for (const dimension of PROFILE_FIELDS) {
      if (after[dimension] < before[dimension]) {
        findings.push({ when, dimension, baseline: before[dimension], head: after[dimension] });
      }
    }
  }
  return findings;
}

/** A human/answerer-readable rendering of a weakening set, used as the gate finding body. */
export function describeGateWeakening(findings: ReadonlyArray<GateWeakening>): string {
  return findings
    .map((finding) => `${finding.when}.${finding.dimension}: ${String(finding.baseline)} -> ${String(finding.head)}`)
    .join("; ");
}

/**
 * Thrown when the head `.tanren/ci.yml` demands less than the baseline one. Carries the
 * measured findings so the gate boundary can project them onto a fail-closed gate outcome whose
 * message names `.tanren/ci.yml` — which is also what makes the writer loop's existing
 * `contractViolationSteering` fire and tell the writer to revert exactly that file.
 */
export class GateContractWeakenedError extends Error {
  readonly findings: ReadonlyArray<GateWeakening>;
  constructor(findings: ReadonlyArray<GateWeakening>) {
    super(
      "the head `.tanren/ci.yml` WEAKENS the gate that judges it, relative to the contract this run " +
        `is based on: ${describeGateWeakening(findings)}. A run may strengthen its gate, never lower ` +
        "its own bar — restore the contract file and satisfy it instead.",
    );
    this.name = "GateContractWeakenedError";
    this.findings = findings;
  }
}

/**
 * Thrown when the baseline contract could not be established from a revision the caller
 * EXPLICITLY named (the run's own base commit). Fail-closed: if we cannot tell whether the head
 * lowered its bar, we do not let it be graded — a writer that could make the baseline
 * unreadable would otherwise have a free bypass.
 */
export class GateContractBaselineError extends Error {
  constructor(revision: string, detail: string) {
    super(
      `could not read the baseline \`.tanren/ci.yml\` at ${revision} (the gate-contract ratchet's floor): ${detail}`,
    );
    this.name = "GateContractBaselineError";
  }
}
