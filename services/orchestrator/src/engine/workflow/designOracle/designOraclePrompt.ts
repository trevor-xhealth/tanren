// Single source of truth for the Design-Oracle Answerer PROMPT TEXT (WS-D4 of
// docs/roadmap/native-design-subsystem.md). The design oracle judges whether the
// built output satisfies the project's first-class `DesignContract` (WS-D1). It is
// a NEW answerer in the mold of the checker/auditor/demo-run — it self-inspects the
// built output in a READ-ONLY sandbox and emits findings; it never has context
// injected as raw blobs beyond the RESOLVED contract + entity graph it must verify
// against (the contract is the durable artifact under test, not arbitrary context).
//
// THE MOAT — the prompt renders THREE things no standalone design tool has:
//   1. an EXHAUSTIVE BEHAVIOR-COVERAGE CHECKLIST — every `behaviorRef` (resolved to
//      its real given/when/then) must have a designed/implemented surface or flow;
//   2. PERSONA-SCOPED FIDELITY — each surface is verified for its RESOLVED persona
//      (no "assume default admin"); a dimension's `personaRefs` scope it to a
//      persona's view, the contract-level `personaRefs` are the all-surfaces set;
//   3. DOMAIN-AWARE MODE — the agent is given the contract's `domain` + each
//      dimension's `intent` and CHOOSES the verification mode (web → render/inspect
//      surfaces; novel → prose/typography; game → art/feel). Tanren never branches
//      on the domain; the prompt stays domain-general by construction.
//
// READ-ONLY: like the demo-run answerer, the oracle runs in a read-only sandbox and
// cannot start a server or render live. It probes STATICALLY (reads the surfaces /
// artifacts the contract names + the diff) and, when fidelity genuinely cannot be
// judged statically (it needs a live render the sandbox cannot do), emits a single
// `design-not-verifiable` info finding rather than fabricate a pass or a failure.
//
// SPEC-MODE AWARENESS (audit round-2 H1, mirroring PR #708's checker/auditor lift).
// The oracle independently judges the built output against the contract and can
// emit P1/P2 findings citing pre-existing seed surfaces (e.g. the contract's
// behaviorRefs vs the seed-shipped skeleton). When `specMode === "specialize_seed"`,
// the prompt appends a seeded-mode tail block that tells the oracle the composed
// seed is pre-existing + proven green and that pre-existing seed surfaces are NOT
// design-contract gaps THIS spec was asked to fill — only gaps in the PRODUCT-
// SPECIFIC surfaces this spec was supposed to deliver. Wording mirrors the writer's
// `WRITER_SPECIALIZE_SEED_GRADING_INSTRUCTION` (PR #704) + the checker/auditor
// seeded-mode block (PR #708) so all four answerers agree on what is in-scope for a
// `specialize_seed` spec. When `specMode === "from_scratch"` (the default) the
// block is ABSENT so brownfield/legacy specs see the byte-identical legacy prompt.

import type { SpecMode } from "../../state/spec.js";

export interface ResolvedPersona {
  id: string;
  name: string;
  description: string;
}

export interface ResolvedBehavior {
  id: string;
  // The persona this behavior belongs to (already resolved to the persona row's id),
  // so the checklist can attribute coverage per persona.
  personaId: string;
  title: string;
  given: string;
  when: string;
  then: string;
}

// One contract dimension as rendered for the oracle: the domain-declared key/label,
// the `intent` bar the oracle judges fidelity against, optional guidance, and the
// persona ids that scope it (empty ⇒ applies to every persona on the contract).
export interface ResolvedDimension {
  key: string;
  label: string;
  intent: string;
  guidance: string;
  personaRefs: ReadonlyArray<string>;
}

export interface DesignOraclePromptInput {
  // The descriptive design domain label — the signal the oracle uses to CHOOSE its
  // verification mode (never a Tanren branch). E.g. "saas-web", "novel-translation".
  domain: string;
  // The universal contract core (domain-independent).
  identity: string;
  intent: string;
  principles: ReadonlyArray<string>;
  constraints: ReadonlyArray<string>;
  // The domain-adaptive dimension set (the project's own declaration).
  dimensions: ReadonlyArray<ResolvedDimension>;
  // The RESOLVED personas the contract binds to (the moat — typed, not guessed).
  personas: ReadonlyArray<ResolvedPersona>;
  // The RESOLVED behaviors the design is responsible for COVERING (the moat — the
  // exhaustive coverage checklist).
  behaviors: ReadonlyArray<ResolvedBehavior>;
  // The run base the writer's change is diffed against; the oracle self-inspects.
  baselineSha: string;
  // OPTIONAL spec writer-prompt MODE (audit round-2 H1, mirroring PR #708's
  // checker/auditor lift). When `specialize_seed`, the prompt appends the seeded-
  // mode tail block that scopes the oracle off the pre-existing seed surfaces (a
  // false design finding against a seed-owned skeleton wedges merge exactly like a
  // false checker/auditor finding). Absent / `from_scratch` ⇒ no block (byte-
  // identical to the legacy oracle prompt), so brownfield/legacy specs are unchanged.
  //
  // BOTH BRANCHES ARE LOAD-BEARING: `specialize_seed` fires on greenfield's seeded
  // scaffold spec; `from_scratch` fires on every other spec (the brownfield/legacy
  // default). Regression-pinned in `tests/designOracleStage.test.ts` (which
  // explicitly asserts `from_scratch` produces NO seeded-mode block — legacy shape).
  specMode?: SpecMode;
}

function renderPersona(persona: ResolvedPersona): string {
  const desc = persona.description.trim() === "" ? "(no description)" : persona.description;
  return `- [${persona.id}] ${persona.name}: ${desc}`;
}

function renderBehavior(behavior: ResolvedBehavior): string {
  // The given/when/then is the design acceptance criterion the surface must cover.
  return [
    `- [${behavior.id}] (persona ${behavior.personaId}) ${behavior.title}`,
    `    Given ${behavior.given}`,
    `    When ${behavior.when}`,
    `    Then ${behavior.then}`,
  ].join("\n");
}

function renderDimension(dimension: ResolvedDimension): string {
  const scope =
    dimension.personaRefs.length === 0
      ? "all personas on the contract"
      : `personas ${dimension.personaRefs.join(", ")}`;
  const lines = [`- [${dimension.key}] ${dimension.label} (scope: ${scope})`, `    Intent: ${dimension.intent}`];
  if (dimension.guidance.trim() !== "") {
    lines.push(`    Guidance: ${dimension.guidance}`);
  }
  return lines.join("\n");
}

// The seeded-mode tail block for the designOracle prompt (audit round-2 H1). Mirrors
// the writer's `WRITER_SPECIALIZE_SEED_GRADING_INSTRUCTION` (PR #704) + the
// checker/auditor seeded-mode block (PR #708) so all four answerers agree on what is
// in-scope for a `specialize_seed` spec. The composed seed is pre-existing + proven
// green by composition; this block tells the oracle NOT to cite design-contract gaps
// that are properties of the pre-existing seed surfaces (e.g. a missing component the
// spec wasn't tasked with adding) — only design-contract gaps in the PRODUCT-SPECIFIC
// surfaces this spec was supposed to deliver. EMPTY for `from_scratch` (the default)
// so brownfield/legacy specs see a byte-identical legacy oracle prompt.
//
// THIRD ARM — `modify_existing` (brownfield). Same false-finding class against a
// pre-existing REPOSITORY: a mode-blind oracle cites design-contract gaps that are
// properties of code the writer was forbidden to touch, and the only way to clear them
// is the over-broad rebuild the mode exists to prevent. Leaving one of the four
// mode-aware prompts blind is exactly the gap PR #708 had to close for the checker +
// auditor one release after PR #704 fixed the writer, so the arm lands with the others.
function specModeScopeBlock(specMode: SpecMode | undefined): string[] {
  if (specMode === "modify_existing") {
    return modifyExistingModeBlock;
  }
  if (specMode !== "specialize_seed") {
    return [];
  }
  return [
    "",
    "SPECIALIZE-SEED mode: this spec's composed seed is PRE-EXISTING and PROVEN GREEN",
    "by composition. The manifest, lockfile, tsconfig, lint/test/build configs, contract",
    "files (justfile + .tanren/ci.yml), source skeleton, and demo were ALL shipped by",
    "the seed before the writer touched anything. Do NOT cite design-contract gaps that",
    "are properties of the PRE-EXISTING SEED SURFACE (e.g. a missing component the spec",
    "wasn't tasked with adding, a behavior the seed-shipped skeleton doesn't yet cover) —",
    "the writer's job here is to SPECIALIZE the seed for THIS product, not to extend the",
    "seed's behavior coverage. Only cite design-contract gaps in the PRODUCT-SPECIFIC",
    "surfaces this spec was supposed to deliver (the acceptance criteria name them —",
    "typically: product identity in the manifest's `name`, deploy descriptor's slug,",
    ".env.example placeholders, README + product metadata, the product-specific demo or",
    'entrypoint). A finding like "behavior X has no covering surface" against a seed-',
    "owned skeleton is a FALSE finding in this mode — the seed already ships that",
    "surface, and the writer is explicitly forbidden from rebuilding it. Re-elaboration",
    "gaps (behaviors added to the project AFTER the design phase) are still surfaced",
    "normally — those are loud structural gaps the seed cannot have shipped.",
  ];
}

// The `modify_existing` tail block for the designOracle prompt. Mirrors the writer's
// `WRITER_MODIFY_EXISTING_GRADING_INSTRUCTION` + the checker/auditor block so all four
// answerers agree on what is in-scope for a scoped amendment to a pre-existing
// repository: design-contract gaps that are properties of the PRE-EXISTING code are not
// this spec's job, only the surfaces this spec was asked to deliver are judged, and
// re-elaboration gaps still surface normally (they are loud structural gaps the
// pre-existing repository cannot have covered).
const modifyExistingModeBlock: string[] = [
  "",
  "MODIFY-EXISTING mode: this spec's repository is PRE-EXISTING and AUTHORITATIVE. Other",
  "people built it, it is green today, and the writer's job was a SCOPED AMENDMENT to it —",
  "not a rebuild of it. Do NOT cite design-contract gaps that are properties of the",
  "PRE-EXISTING code (a persona journey the repository never covered, a behavior its",
  "existing surfaces don't yet serve) — the writer was explicitly forbidden to widen the",
  "diff onto them, so such a finding can only be cleared by the over-broad rebuild this",
  "mode prevents. Only cite design-contract gaps in the surfaces THIS spec was supposed to",
  'deliver (the acceptance criteria name them). A finding like "behavior X has no covering',
  'surface" against a pre-existing part of the repository is a FALSE finding in this mode.',
  "Re-elaboration gaps (behaviors added to the project AFTER the design phase) are still",
  "surfaced normally — those are loud structural gaps the pre-existing repository cannot",
  "have covered.",
];

// The canonical self-inspection block — the writer's change is committed on the
// current branch of the read-only workspace; the oracle inspects it itself (no diff
// is injected). Mirrors the checker/demo-run self-inspection contract.
function selfInspectionBlock(baselineSha: string): string[] {
  return [
    "The built output is committed on the current branch of your READ-ONLY workspace.",
    "Inspect it yourself: run",
    `  git diff ${baselineSha} -- . ':(exclude)node_modules'`,
    "to see what changed, then READ the surfaces / artifacts the contract is about",
    "(for a web UI: the components, styles, routes, and rendered markup; for a novel:",
    "the prose/typography files; for a game: the art / UI / feel assets). Do NOT expect",
    "the output to be provided inline — read it from the workspace.",
  ];
}

export function buildDesignOraclePrompt(input: DesignOraclePromptInput): string {
  return [
    "You are the Tanren Design Oracle. Your ONLY job is to judge DESIGN FIDELITY: does",
    "the built output satisfy the project's DESIGN CONTRACT? This is distinct from the",
    "checker (per-task completeness), the auditor (quality/security), and the demo-run",
    "answerer (does the user-flow work) — you verify the output LOOKS AND FEELS like the",
    "contract demands, covers every behavior the design is responsible for, and is",
    "correct for each RESOLVED persona.",
    "",
    "DOMAIN-AWARE — you are NOT assuming a web UI. Choose HOW to verify from the",
    `contract's domain and dimensions. The design domain is: ${input.domain}. A web UI is`,
    "verified by inspecting the rendered surfaces; a novel translation by its prose and",
    "typography; a game by its art direction and feel. Decide the verification mode that",
    "fits THIS domain and its dimensions, and report it in `verificationMode`.",
    "",
    ...selfInspectionBlock(input.baselineSha),
    "",
    "IMPORTANT — you run in a READ-ONLY sandbox: you CANNOT start a server, render live,",
    "or perform live I/O. Probe STATICALLY: read the surfaces/artifacts + the diff and",
    "reason about fidelity. Emit findings ONLY for gaps you can SUBSTANTIATE from what you",
    "read. If a fidelity judgement genuinely CANNOT be made statically (it needs a live",
    "render you cannot perform), emit a SINGLE info-severity finding with id",
    "`design-not-verifiable` saying so — do NOT invent a pass or a failure.",
    "",
    "Render NO pass/fail verdict and do NOT edit files, run mutation commands, create",
    "commits, or write to the workspace. Return only the structured JSON required by the",
    "provided schema.",
    "",
    "==== THE DESIGN CONTRACT (the bar you judge against) ====",
    `Design identity: ${input.identity}`,
    `Design intent (north star): ${input.intent}`,
    ...(input.principles.length === 0
      ? ["Design principles: (none)"]
      : ["Design principles:", ...input.principles.map((p) => `- ${p}`)]),
    ...(input.constraints.length === 0
      ? ["Design constraints (non-negotiable): (none)"]
      : ["Design constraints (non-negotiable):", ...input.constraints.map((c) => `- ${c}`)]),
    "",
    "Design dimensions (the project's domain-declared facets; verify each against its",
    "intent — a dimension scoped to specific personas is THAT persona's view of the",
    "surface):",
    ...(input.dimensions.length === 0 ? ["(no dimensions declared)"] : input.dimensions.map(renderDimension)),
    "",
    "==== PERSONAS (resolved — no guessing; each surface must be correct for ITS persona) ====",
    ...(input.personas.length === 0 ? ["(no personas bound)"] : input.personas.map(renderPersona)),
    "",
    "==== BEHAVIOR-COVERAGE CHECKLIST (exhaustive — every behavior MUST have a designed surface/flow) ====",
    "For EACH behavior below, verify the built output provides a designed/implemented",
    "surface or flow that covers it FOR THAT BEHAVIOR'S PERSONA. A behavior with NO",
    "covering surface is a COVERAGE GAP — emit a finding citing the behavior id. A surface",
    "that exists but is wrong for its resolved persona is a PERSONA-SCOPED FIDELITY miss —",
    "emit a finding citing the persona id.",
    ...(input.behaviors.length === 0
      ? ["(no behaviors bound — there is no coverage obligation; do not invent one)"]
      : input.behaviors.map(renderBehavior)),
    "",
    "==== HOW TO ANSWER ====",
    "Emit `findings` (each with an explicit severity P0-P3): one per behavior-coverage",
    "gap, persona-scoped fidelity miss, or violated contract dimension/principle/",
    "constraint. Give each a stable slug `id`, a `title`, and a `body` that names the",
    "behavior id / persona id / dimension key it concerns and what is wrong. Emit an",
    "EXPLICIT empty `findings: []` when the output is design-faithful — never invent a",
    "finding. Set `verificationMode` to the domain-derived mode you used, and `summary`",
    "to what you inspected (surfaces/artifacts read + behaviors/personas/dimensions",
    "verified).",
    // SEEDED-MODE tail block (audit round-2 H1) — placed AFTER the answer instructions
    // so the agent reads "this spec is specialize_seed; pre-existing seed surfaces are
    // NOT findings" LAST. Mirrors the checker/auditor's last-position-strongest-signal
    // placement (PR #708) — defensive on a re-iteration. EMPTY for `from_scratch`.
    ...specModeScopeBlock(input.specMode),
  ].join("\n");
}
