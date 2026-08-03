// The prompt for ONE TURN of brownfield recon's exploration.
//
// Recon used to be a single call over a fixed budget: the reader pre-read the 24
// best-ranked signal files and the model got exactly those, forever. If
// understanding a repository required the 25th file, recon could not read it —
// the budget decided in advance, by heuristic, what the model was allowed to know.
//
// This module renders the prompt for a model that can ASK. Each turn shows:
//
//   1. the PROTOCOL — the three navigation requests and the two ways a turn ends;
//   2. the ENTRY POINT — the directory rollup + seed previews (`prompt.ts`), the
//      map every turn keeps, so the model always knows where it can navigate to;
//   3. the LEDGER — every request already answered, one compact line each, so the
//      model can see what it has covered without re-reading any of it;
//   4. its own NOTES — carried forward turn to turn. This is what lets recon read
//      more of a repository than fits in one context window: file bodies age out
//      of the window, the conclusions drawn from them do not;
//   5. the OBSERVATIONS — the most recent bodies, verbatim, newest kept first;
//   6. on a COMPLETENESS turn only, the top-level areas it has read nothing
//      under. See `completenessSection` — that turn exists because the
//      exploration's fixed point is measured over the evidence corpus and is
//      therefore blind to WHERE in the repository the reading happened.
//
// BUDGET DISCIPLINE. `RECON_PROMPT_MAX_CHARS` bounds ONE turn, not the
// exploration: the framing (1) and the tail directive are rendered FIRST and are
// never cut — a truncated protocol would leave the model unable to answer at all —
// and the evidence sections are then filled to whatever budget remains, newest
// observation first. What does not fit this turn is asked for in the next one.

import { renderReconEvidence, RECON_PROMPT_MAX_CHARS } from "./prompt.js";
import { describeExtensions, type ReconArea } from "./reconAreas.js";
import type { ReconObservation, ReconTurnInput } from "./types.js";

/** Extensions named per area on the completeness turn — enough to identify it. */
const AREA_EXTENSION_ROWS = 4;
/** Areas named on one completeness turn, largest first. Rendering width only. */
const AREA_ROWS = 15;

// How the model addresses the repository. Rendered every turn: an agent that has
// forgotten the protocol cannot recover by exploring harder.
const PROTOCOL = [
  "## How to explore",
  "You are reading a repository you cannot see directly. Name what you want and it",
  "is fetched for you, READ-ONLY, before your next turn. Three request kinds:",
  '  { "kind": "list", "target": "services/api" }   — the immediate children of a directory',
  '  { "kind": "find", "target": "*.tf" }           — every path matching a substring or one * wildcard',
  '  { "kind": "read", "target": "services/api/main.go" } — that file\'s contents',
  "`list` and `find` are FREE (served from the tree already fetched); `read` is the",
  "only one that costs anything, so narrow with list/find before you read.",
  "Add `offset` to page through a long file (bytes) or a long listing (entries) —",
  "nothing in this repository is out of reach.",
  "",
  "Set `status` to `explore` with your `requests` to keep going, or to `report`",
  "with the finished `report` when the evidence supports every chapter. There is NO",
  "turn limit: keep exploring while you are still learning something that changes",
  "the report, and stop when further reading would not.",
  "Keep `notes` as your working understanding — file contents scroll out of view",
  "between turns, your notes do not. Re-state in them anything you still need.",
];

const REPORT_DIRECTIVE = [
  "Return exactly one ReconReport: infer `identity` (slug + purpose, with",
  "`inferredFrom` naming the evidence), `personas`, `behaviors`, `architecture`,",
  "`risks`, and `gaps` (what's missing / under-tested). Ground every chapter in",
  "evidence you have actually read — this is reconstruction from evidence, not",
  "invention. The shape section is a rollup, so name the directory or file a",
  "chapter rests on whenever the evidence is structural rather than quoted.",
  "",
  // The architecture chapter's own contract. Everything else here is a product
  // chapter, and `architecture` was answering in that register: two
  // product-flavoured lines for a repository with a second language, a Terraform
  // estate and a whole second product in it. The other five chapters are about
  // WHO uses this and WHAT it does; this one is about WHAT IT IS MADE OF, and it
  // has to cover the repository rather than the product surface explored first.
  "`architecture` is the one chapter that is about the REPOSITORY rather than the",
  "product. It must account for the whole tree, not only the part you explored:",
  "  • the LANGUAGES and RUNTIMES in use — every ecosystem listed above, not just",
  "    the largest; a polyglot repository whose report names one language is wrong;",
  "  • how it is BUILT, tasked and tested (workspace, build and task tooling);",
  "  • how it is DEPLOYED — infrastructure-as-code, containers, CI;",
  "  • its DATA layer, if any;",
  "  • each top-level area substantial enough to matter, by name.",
  "Cite the path each line rests on. Name a language, tool or service ONLY where a",
  "path or a file you read shows it: the ecosystem list is path evidence, so what",
  "you can name from it is fair and what you cannot is not — do NOT name a",
  "framework, database or cloud you have not seen in a file.",
  "Where a layer or a substantial area could NOT be characterized from what you",
  "read, say so explicitly — an `architecture` line that states a layer is present",
  "but uncharacterized, or a `gap` asking what owns it, is the correct answer. A",
  "confident guess is not, and neither is silence.",
];

const FINALIZE_DIRECTIVE = [
  "## This turn must produce the report",
  "Your last turns stopped surfacing anything new, so exploration has converged.",
  "Write the report from what you have read. Where the evidence was thin, say so in",
  "`risks` or `gaps` rather than inventing — an honest gap is a useful answer.",
];

/**
 * The COMPLETENESS turn: the areas of the repository this exploration has read
 * nothing under, named.
 *
 * The exploration's fixed point says "reading more of what I am reading teaches
 * me nothing", which is true and is silent about WHERE the reading happened. On
 * a real monorepo that produced an honest convergence with a third of the tree
 * untouched. This is the one place recon says so out loud, and it deliberately
 * asks a QUESTION rather than issuing an order: some of these areas are vendored
 * drops or generated output that genuinely need no characterizing, and forcing a
 * read of each would be the "explore everything" loop this must not become. An
 * answer of "that is a vendor tree, it needs no chapter" is a good answer.
 */
function completenessSection(areas: readonly ReconArea[]): string[] {
  const lines = [
    "## Areas you have not characterized",
    "You have stopped learning from what you are reading, but you have read NO file",
    "content under these top-level areas — largest first:",
  ];
  for (const area of areas.slice(0, AREA_ROWS)) {
    const noun = area.files === 1 ? "file" : "files";
    lines.push(`- ${area.path} — ${area.files} ${noun} (${describeExtensions(area, AREA_EXTENSION_ROWS)})`);
  }
  const hidden = areas.length - Math.min(areas.length, AREA_ROWS);
  if (hidden > 0) lines.push(`- … +${hidden} further unread areas.`);
  lines.push(
    "",
    "For EACH: either open something under it now (`list` it, then `read` the file",
    "that describes it) or decide it needs no chapter — a vendored dependency drop,",
    "generated output, or fixtures. Say which in your notes. If a substantial area",
    "stays uncharacterized, it belongs in `risks` or `gaps` by name, never omitted.",
    "Ask for what you want this turn; you are not being asked to finish the repo.",
  );
  return lines;
}

/** One ledger line: what was asked, and what came back. */
function ledgerLine(observation: ReconObservation): string {
  const { request, outcome, total, covered } = observation;
  const at = request.offset === 0 ? "" : ` @${request.offset}`;
  if (outcome === "not_found") return `- ${request.kind} ${request.target}${at} → nothing`;
  if (outcome === "content") {
    const rest = request.offset + covered < total ? `, ${total - request.offset - covered} more` : ", complete";
    return `- read ${request.target}${at} → ${covered} bytes${rest}`;
  }
  const rest = request.offset + covered < total ? `, ${total - request.offset - covered} more` : "";
  return `- ${request.kind} ${request.target}${at} → ${covered} of ${total} entries${rest}`;
}

/** One observation, verbatim — the body the model actually reasons over. */
function observationBlock(observation: ReconObservation): string {
  return `### ${observation.request.kind} ${observation.request.target}\n${observation.body}`;
}

/**
 * Fill `budget` chars with observation blocks, NEWEST FIRST (recency wins when
 * the budget bites), then emit them oldest→newest so the model reads them in the
 * order it asked for them. An observation that does not fit stays in the ledger,
 * and the model can re-request it.
 */
function recentObservations(observations: readonly ReconObservation[], budget: number): string[] {
  // Walk backwards to find the OLDEST observation that still fits, then render
  // forwards from it — same selection, chronological order, no array reversal.
  let spent = 0;
  let oldestKept = observations.length;
  for (let i = observations.length - 1; i >= 0; i -= 1) {
    const observation = observations[i];
    if (observation === undefined || observation.body === "") continue;
    const cost = observationBlock(observation).length + 1;
    if (spent + cost > budget) break;
    spent += cost;
    oldestKept = i;
  }
  return observations
    .slice(oldestKept)
    .filter((observation) => observation.body !== "")
    .map((observation) => observationBlock(observation));
}

/** Trim a section to what is left of the budget, saying so where it cut. */
function fitted(section: string, budget: number): string {
  if (section.length <= budget) return section;
  return budget <= 0 ? "" : `${section.slice(0, budget)}\n… (section trimmed to this turn's prompt budget)`;
}

export function buildReconTurnPrompt(input: ReconTurnInput): string {
  const head = [
    "You are Forge, running a READ-ONLY reconnaissance of an existing (brownfield)",
    "repository to reconstruct its product chapters before tanren onboards it.",
    `Repository: ${input.index.repoUrl} (${input.index.filesIndexed} files indexed)`,
    "",
    ...(input.finalize ? FINALIZE_DIRECTIVE : PROTOCOL),
  ].join("\n");
  const tail = REPORT_DIRECTIVE.join("\n");

  // The framing is never cut; everything else shares what remains.
  let budget = RECON_PROMPT_MAX_CHARS - head.length - tail.length - 32;
  const sections: string[] = [];
  const push = (section: string): void => {
    const rendered = fitted(section, budget);
    if (rendered === "") return;
    budget -= rendered.length + 2;
    sections.push(rendered);
  };

  if (input.notes !== "") push(`## Your notes so far\n${input.notes}`);
  // The completeness ask leads the evidence: it is the reason THIS turn exists,
  // and it is a dozen lines the budget must never trim away underneath it.
  const unexplored = input.unexploredAreas ?? [];
  if (unexplored.length > 0) push(completenessSection(unexplored).join("\n"));
  push(renderReconEvidence(input.index));
  if (input.observations.length > 0) {
    push(`## What you have already asked for\n${input.observations.map(ledgerLine).join("\n")}`);
    // Observations last: the freshest evidence sits closest to the question.
    const blocks = recentObservations(input.observations, Math.max(0, budget - 64));
    if (blocks.length > 0) push(`## What you read most recently\n${blocks.join("\n\n")}`);
  }

  return [head, ...sections, tail].join("\n\n");
}
