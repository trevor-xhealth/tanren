// Single source of truth for the Checker / Auditor Answerer PROMPT TEXT.
//
// Both answerer paths route through these two builders:
//   - the production run path (`checker.ts` / `auditor.ts`, via `subtaskStages`
//     / `subtaskLoop` and the conflict re-gate), and
//   - the structured-task path (`answererTasks.ts` → phase-1 fixture + the live
//     codex-answerer test).
// Collapsing the prompt text here means prompt-tuning the checker/auditor — a key
// forward activity — is a ONE-place edit.
//
// The output SCHEMAS still differ between the two paths (the production v2
// `passed`/`reasoning`/`behaviorIds*` shape vs the structured-task v1
// `done`/`suggested_fixes` shape), so only the small CLOSING output-field
// instruction differs — it is passed in as `outputInstructions`. Everything that
// is actually tuned (the role framing, the self-inspection `git diff` block, the
// hard boundaries, and the spec/criteria rendering) is single-sourced below.
//
// VERIFIED BEHAVIOR PRESERVED: no diff is injected; the agent self-inspects via
// `git diff <baselineSha> -- . ':(exclude)node_modules'`; the read-only /
// structured-output boundaries are intact.
//
// ENTITY-RISK ORACLE (docs/roadmap/entity-analysis-layer.md §3.1): the checker
// prompt MAY carry a deterministic entity-change risk STEER (engine/oracle) — a
// native, pre-LLM signal Tanren derives from the entity-change map that tells the
// agent WHERE to concentrate scrutiny (skip cosmetic, maximal on a public-API
// signature change). It is a STEER, not injected raw context: the agent still
// inspects the diff itself. When no risk signal is supplied — or it is the
// `unknown` class (sem absent / can't-parse) — NO steer is added and the prompt
// is byte-for-byte the same as the no-oracle path (the graceful fallback).
//
// SPEC-MODE AWARENESS (task #86 — v64 root-cause class one rung downstream from the
// writer fix in PR #704). The checker + auditor prompts MUST know whether the spec
// runs in `specialize_seed` mode — otherwise a mode-BLIND checker emits "you didn't
// set up tests/configs" for a tiny specialize-seed diff, or a mode-blind auditor
// emits a P1 about "no test coverage for the new entrypoint", which wedges merge for
// any spec whose surfaces pre-existed in the composed seed. When `specMode ===
// "specialize_seed"`, both prompts emit a tail block that tells the answerer the seed
// is pre-existing + proven green by composition and that pre-existing seed surfaces
// (manifest, lockfile, tsconfig, lint/test/build configs, contract files, source
// skeleton, demo) are NOT findings — only gaps in the product-specific surfaces this
// spec was supposed to deliver. `from_scratch` (the default) keeps today's prompt
// byte-identical so greenfield/legacy specs are unchanged. `modify_existing`
// (brownfield) emits its own tail block: pre-existing REPOSITORY surfaces are not
// findings, and SCOPE DRIFT is — see `specModeScopeBlock` below.

import { renderRiskPostureLines } from "../oracle/index.js";
import type { EntityRiskSignal } from "../oracle/index.js";
import type { SpecMode } from "../state/spec.js";

export interface CheckerPromptInput {
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  baselineSha: string;
  // Production passes the subtask under judgement; the structured-task path
  // judges the whole spec and omits it.
  subtask?: {
    index: number;
    title: string;
    intent: string;
    behaviorIds: ReadonlyArray<string>;
  };
  // The schema-specific closing instruction (one element per line). Each caller
  // passes the lines that name its own output schema's fields.
  outputInstructions: ReadonlyArray<string>;
  // OPTIONAL native entity-change risk signal (engine/oracle). When present and
  // NOT the `unknown` class, its posture STEER is appended after the
  // self-inspection block. Absent / `unknown` ⇒ no steer (graceful fallback).
  riskSignal?: EntityRiskSignal;
  // OPTIONAL spec writer-prompt MODE (task #86). When `specialize_seed`, the prompt
  // appends the seeded-mode tail block that scopes the checker off the pre-existing
  // seed surfaces. Absent / `from_scratch` ⇒ no block (byte-identical to the legacy
  // checker prompt), so brownfield/legacy specs are unchanged.
  //
  // BOTH BRANCHES ARE LOAD-BEARING: `specialize_seed` fires on greenfield's seeded
  // scaffold spec; `from_scratch` fires on every other spec (the brownfield/legacy
  // default). Regression-pinned in `tests/checkerAuditorContextMode.test.ts` (which
  // explicitly asserts `from_scratch` is byte-identical to the absent/legacy prompt).
  specMode?: SpecMode;
}

export interface AuditorPromptInput {
  specTitle: string;
  specDescription?: string;
  acceptanceCriteria: ReadonlyArray<string>;
  baselineSha: string;
  // Production passes the executed subtasks; the structured-task path passes the
  // checker's answer instead. Either (or neither) may be present.
  subtasks?: ReadonlyArray<{
    index: number;
    title: string;
    intent: string;
    behaviorIds: ReadonlyArray<string>;
  }>;
  checkAnswer?: unknown;
  // The schema-specific closing instruction (one element per line).
  outputInstructions: ReadonlyArray<string>;
  // OPTIONAL spec writer-prompt MODE (task #86). When `specialize_seed`, the prompt
  // appends the seeded-mode tail block that scopes the auditor off the pre-existing
  // seed surfaces. Absent / `from_scratch` ⇒ no block (byte-identical to the legacy
  // auditor prompt), so brownfield/legacy specs are unchanged.
  //
  // BOTH BRANCHES ARE LOAD-BEARING: `specialize_seed` fires on greenfield's seeded
  // scaffold spec; `from_scratch` fires on every other spec (the brownfield/legacy
  // default). Regression-pinned in `tests/checkerAuditorContextMode.test.ts` (which
  // explicitly asserts `from_scratch` is byte-identical to the absent/legacy prompt).
  specMode?: SpecMode;
}

// The canonical self-inspection block: the writer's change is committed on the
// current branch of the read-only workspace; the agent diffs it itself (so a huge
// diff is never injected into the prompt, the failure that motivated this).
//
// ENTITY-LEVEL ACCELERATOR (docs/roadmap/entity-analysis-layer.md, increment 1):
// `sem` (an entity-level diff tool on PATH in the runner image) lets the agent
// reason over WHICH functions/classes/types changed (structural vs cosmetic) and a
// change's blast radius, so the audit focuses on the structurally-impactful edits
// and can cheaply skip cosmetic-only ones. It is an OPTIONAL accelerator the agent
// RUNS ITSELF in its sandbox — never Tanren injecting context — and is NOT required:
// when `sem` is absent or cannot parse the stack (it covers many but not all
// languages), the agent falls back to the raw `git diff` below, which remains the
// authoritative inspection. This keeps the lane stack-flexible (no hard sem dep).
function selfInspectionBlock(baselineSha: string): string[] {
  return [
    "The writer's change is committed on the current branch of your read-only",
    "workspace. Inspect it yourself: run",
    `  git diff ${baselineSha} -- . ':(exclude)node_modules'`,
    "to see the change, then read the changed source files. Do NOT expect the diff",
    "to be provided inline — read it from the workspace.",
    "",
    "ACCELERATOR (optional): an entity-level diff tool, `sem`, may be on PATH. When",
    "available, prefer it to focus on what STRUCTURALLY changed before reading files:",
    `  sem diff --from ${baselineSha} --to HEAD --format json`,
    "gives the entity-level change map — which functions/classes/types/methods were",
    "added/modified/deleted/renamed, and which changes are cosmetic-only (formatting/",
    "comments/whitespace). Use it to skip cosmetic-only changes cheaply and to anchor",
    "your judgement on the structurally-impactful entities. For a changed entity, run",
    "  sem impact <entity> --json",
    "to see its blast radius (dependents + affected tests). `sem` is an ACCELERATOR,",
    "NOT a replacement: if `sem` is missing, errors, or reports it cannot parse the",
    "stack (it does not cover every language), fall back to the raw `git diff` above",
    "and the source files — that raw inspection is always authoritative.",
    "Never block or change your verdict because `sem` is unavailable.",
  ];
}

// EMPTY-INCREMENTAL-DIFF (v35): judge the RESULTING STATE, not the diff's size. A
// spec can be RE-DRIVEN (the unified finalize re-drive) — or a scaffold spec whose
// whole job is an already-committed template seed — so its prior iteration's work is
// already committed in the base. Then `git diff <baselineSha> HEAD` is correctly
// EMPTY even though the criteria ARE satisfied by the committed tree. An empty diff
// is "no new regression to review", NOT an incompleteness: a checker that emitted a
// finding here ("no change delivers the intent") would loop the writer (which
// correctly adds nothing → the diff stays empty → the same finding) into a false
// `persistent_failure` escalation. So: when the diff is empty, INSPECT THE COMMITTED
// TREE (read the files the criteria name, e.g. `ls`/`cat`/read the package manifest)
// and emit findings ONLY for criteria the TREE genuinely fails to satisfy — never a
// finding whose only basis is "the incremental diff is empty".
const emptyDiffBlock: string[] = [
  "",
  "EMPTY-DIFF RULE: judge the RESULTING STATE against the criteria, not the size of",
  "the diff. If the diff is EMPTY (the work was already committed in a prior",
  "iteration, or this is a scaffold spec whose seed is already in the tree), that is",
  "NOT an incompleteness — it means there is no new regression to review. Inspect the",
  "COMMITTED TREE directly (read the files the criteria name) and emit a finding ONLY",
  "for a criterion the TREE genuinely fails to satisfy. NEVER emit a finding whose",
  "only basis is that the diff is empty / has no changes — if the criteria are met by",
  "the tree, emit an EMPTY findings list (the task is complete).",
];

// Render the optional entity-risk posture STEER as a leading-blank-line block, or
// EMPTY when no signal is supplied or the signal is the `unknown` class (sem
// absent / can't-parse). Empty ⇒ the prompt is byte-identical to the no-oracle
// path, so the graceful fallback is verifiable.
function riskSteerBlock(riskSignal: EntityRiskSignal | undefined): string[] {
  if (riskSignal === undefined) {
    return [];
  }
  const lines = renderRiskPostureLines(riskSignal);
  return lines.length === 0 ? [] : ["", ...lines];
}

// The seeded-mode tail block for the checker/auditor prompts (task #86). Mirrors the
// writer's `WRITER_SPECIALIZE_SEED_GRADING_INSTRUCTION` from PR #704 so the three
// answerers (writer + checker + auditor) agree on what is in-scope for a
// `specialize_seed` spec. The composed seed is pre-existing + proven green by
// composition; this block tells the checker/auditor NOT to cite pre-existing seed
// surfaces (manifest, lockfile, tsconfig, lint/test/build configs, contract files,
// source skeleton, demo) as completeness/quality findings — only gaps in the
// product-specific surfaces this spec was supposed to deliver. EMPTY for
// `from_scratch` (the default) so brownfield/legacy specs see a byte-identical prompt.
//
// THIRD ARM — `modify_existing` (brownfield). Same failure class one domain over: a
// mode-blind checker judging a scoped amendment to a pre-existing repository emits
// "the project has no integration tests" / "the lint config is weak" against surfaces
// the writer was explicitly forbidden to touch, and the only way the writer can clear
// those findings is the over-broad rebuild the mode exists to prevent. So the block
// scopes the answerer off pre-existing repo surfaces AND adds the inverse duty the
// other two modes don't need: police SCOPE DRIFT, because in this mode an over-broad
// diff is itself the defect.
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
    "the seed before the writer touched anything. Do NOT cite any of those pre-existing",
    "seed surfaces as a completeness or quality finding — they are not the writer's job",
    "in this spec, and the gate already proved them green. The writer's job here is to",
    "SPECIALIZE the seed for THIS product. Emit findings ONLY for gaps in the PRODUCT-",
    "SPECIFIC surfaces this spec was supposed to deliver (the acceptance criteria name",
    "them — typically: product identity in the manifest's `name`, deploy descriptor's",
    "slug, .env.example placeholders, README + product metadata, the product-specific",
    'demo or entrypoint). A finding like "no tests for the new entrypoint" or "missing',
    'lint config" against a seed-owned surface is a FALSE finding — the seed already',
    "ships those, and the writer is explicitly forbidden from adding new tests or",
    "editing configs in this mode.",
  ];
}

// The `modify_existing` tail block for the checker/auditor prompts. Mirrors the writer's
// `WRITER_MODIFY_EXISTING_GRADING_INSTRUCTION` so all the answerers agree on what is
// in-scope for a scoped amendment to a pre-existing repository. Two duties: (a) do NOT
// cite pre-existing repo surfaces as findings — they are not this spec's job and the
// repository was green before the writer started; (b) DO cite scope drift — in this mode
// an over-broad diff (adjacent refactors, reformatted untouched files, regenerated
// manifests/lockfiles the spec never asked for) is itself the defect, so the answerers
// are the enforcement the writer instruction alone cannot provide.
const modifyExistingModeBlock: string[] = [
  "",
  "MODIFY-EXISTING mode: this spec's repository is PRE-EXISTING and AUTHORITATIVE. Other",
  "people built it, it is green today, and the writer's job was a SCOPED AMENDMENT to it —",
  "not a rebuild of it. Everything the writer did not touch was already there and already",
  "passing. Do NOT cite PRE-EXISTING repository surfaces — its dependency manifests and",
  "lockfiles, build/lint/format/test configuration, CI definitions, directory layout,",
  "existing tests, or established code style — as a completeness or quality finding: they",
  "are not this spec's job, and a finding against one of them can only be cleared by the",
  "over-broad rebuild this mode exists to prevent. Emit findings ONLY for (a) gaps in what",
  "this spec's acceptance criteria asked the change to deliver, (b) new behavior shipped",
  "without a new test in the repository's OWN existing test idiom, or an existing test",
  "deleted/skipped/weakened instead of satisfied, and (c) SCOPE DRIFT — the diff touching",
  "files the spec never asked for, refactoring adjacent code, reformatting untouched code,",
  "or regenerating manifests/lockfiles the spec did not require. In this mode an over-broad",
  'diff IS a defect: report it. A finding like "the project has no integration tests" or',
  '"the lint config is weak" against a pre-existing surface is a FALSE finding.',
];

// Render the acceptance-criteria block under `header`. When the criteria list is EMPTY,
// emit an explicit "(none ...)" guard line instead of a dangling header followed by
// nothing — otherwise the prompt reads as "judge each one:" then silence, which misleads
// the agent into hunting for criteria that do not exist. With no explicit criteria the
// agent judges against the subtask INTENT alone.
function criteriaBlock(header: string, criteria: ReadonlyArray<string>): string[] {
  if (criteria.length === 0) {
    return [header, "- (none — judge against the subtask intent only)"];
  }
  return [header, ...criteria.map((criterion) => `- ${criterion}`)];
}

export function buildCheckerPrompt(input: CheckerPromptInput): string {
  return [
    "You are the Tanren Checker Answerer. Your ONLY job is to judge COMPLETENESS for",
    "downstream tasks: does the writer's change deliver the subtask intent and each",
    "explicit acceptance criterion that LATER tasks build on? Judge by reading the",
    "change and the spec — nothing else. Emit a completeness finding per incompleteness.",
    "",
    ...selfInspectionBlock(input.baselineSha),
    ...riskSteerBlock(input.riskSignal),
    ...emptyDiffBlock,
    "",
    "Hard boundaries (a separate deterministic gate, not you, owns correctness):",
    "- Do NOT run, simulate, invoke, or shell out to tests, builds, type checks,",
    "  linters, or any command. The workspace may be unbuilt; that is expected",
    "  and is NOT your concern.",
    "- Do NOT assert, claim, predict, or report whether tests/build/lint pass or",
    "  fail. A separate in-loop deterministic gate verifies correctness; never",
    "  base your verdict on it or speculate about its result.",
    "- Do NOT edit files, run mutation commands, create commits, or write to the",
    "  workspace.",
    "- Judge intent only. 'The code looks like it might fail to compile/test' is",
    "  out of scope: if the intent and criteria are addressed by the diff, that",
    "  satisfies you.",
    "- An acceptance criterion that is INHERENTLY a test/build/lint OUTCOME (e.g.",
    "  'the test suite passes', 'the build succeeds', 'CI is green', 'lint is",
    "  clean') is owned by the deterministic gate, NOT by you. Treat such a",
    "  criterion as DEFERRED — note it in `reasoning` as gate-owned, and do NOT",
    "  emit a finding for it. You verify only that the diff implements the behavior",
    "  such a test would exercise.",
    "",
    "Return only the structured JSON required by the provided schema.",
    "",
    `Spec title: ${input.specTitle}`,
    `Spec description: ${input.specDescription}`,
    ...criteriaBlock("Explicit acceptance criteria (judge each one):", input.acceptanceCriteria),
    ...(input.subtask === undefined
      ? []
      : [
          "",
          `Subtask [${input.subtask.index}]: ${input.subtask.title}`,
          `Subtask intent: ${input.subtask.intent}`,
          `Subtask behavior ids: ${input.subtask.behaviorIds.join(", ") || "(none)"}`,
        ]),
    // SEEDED-MODE tail block (task #86). Placed AFTER the spec/criteria/subtask block
    // so the agent reads "this spec is specialize_seed; pre-existing seed surfaces are
    // NOT findings" LAST — the position writer/checker prompts treat as the strongest
    // signal on a re-iteration. EMPTY for `from_scratch` (the legacy byte-shape).
    ...specModeScopeBlock(input.specMode),
    "",
    ...input.outputInstructions,
  ].join("\n");
}

// apex v79/v80 IN-SCOPE FOCUS block. On v79 the auditor emitted CROSS-SCOPE findings
// (e.g. `entrypoint-not-deployed` on a `scaffold` spec — a deploy concern) that
// downstream triage kept in-spec as `kind: task`, so this spec's `findings.length`
// never reached 0 across 5 iterations, the subtask loop never returned "passed",
// and zero github.pr.created events fired. The auditor's job is defects that block
// THIS spec's acceptance criteria — a cross-scope concern belongs in a NEW spec,
// which triage routes as `kind: spec` from the finding you emit here. v80 CLOSURE:
// the earlier prompt said "either OMIT or emit as OUT-OF-SCOPE" — but OMIT was a
// black hole (triage never sees the finding; nothing routes it to a new spec; the
// defect vanishes). So the choice is gone: a real cross-scope defect you observe
// MUST be emitted (never omitted), with the OUT-OF-SCOPE tag explicit in the title
// and body so downstream triage routes it as `kind: spec`.
const auditorInScopeFocusBlock: string[] = [
  "",
  "IN-SCOPE FOCUS (apex v79/v80): only emit findings that block THIS spec's stated",
  "title/description/acceptance criteria. Cross-scope concerns — e.g. a deploy",
  'defect surfaced by a "scaffold" spec, or an analytics-view defect surfaced by',
  'a "redirect route" spec — belong in a NEW spec, not on this one. When you',
  "observe such a cross-scope defect, you MUST emit it as a finding — DO NOT omit",
  "it (omission is a black hole: triage never sees it, nothing routes it to a new",
  "spec, and the defect vanishes). Write the `title` + `body` to explicitly name",
  "that the finding is OUT-OF-SCOPE for this spec — so downstream triage routes it",
  "as `kind: spec` (a new DAG spec) rather than `kind: task` (a bounded fix in this",
  "spec). The rotating-findings anti-pattern this prevents: cross-scope findings",
  "kept in-spec as tasks NEVER converge — each iteration surfaces a NEW out-of-scope",
  'defect, findings.length never reaches 0, and the loop never returns "passed".',
];

export function buildAuditorPrompt(input: AuditorPromptInput): string {
  return [
    "You are the Tanren Auditor Answerer. Audit whether the executed subtask plan satisfies the spec.",
    "Return only the structured JSON required by the provided schema.",
    "Do not edit files, run mutation commands, create commits, or write to the workspace.",
    "",
    ...selfInspectionBlock(input.baselineSha),
    ...auditorInScopeFocusBlock,
    "",
    `Spec title: ${input.specTitle}`,
    ...(input.specDescription === undefined ? [] : [`Spec description: ${input.specDescription}`]),
    ...criteriaBlock("Acceptance criteria:", input.acceptanceCriteria),
    ...(input.subtasks === undefined
      ? []
      : [
          "",
          "Executed subtasks:",
          ...input.subtasks.map(
            (subtask) =>
              `- [${subtask.index}] ${subtask.title} (intent: ${subtask.intent}, behaviors: ${subtask.behaviorIds.join(", ") || "(none)"})`,
          ),
        ]),
    ...(input.checkAnswer === undefined ? [] : ["", "Checker answer:", JSON.stringify(input.checkAnswer, null, 2)]),
    // SEEDED-MODE tail block (task #86). Placed AFTER the spec/criteria/subtasks/check
    // block — same defensive last-position placement as the checker. EMPTY for
    // `from_scratch` (the legacy byte-shape).
    ...specModeScopeBlock(input.specMode),
    "",
    ...input.outputInstructions,
  ].join("\n");
}
