// P1c: the brownfield-recon ENTRY-POINT evidence renderer.
//
// Renders what recon knows about a repo BEFORE it has explored anything: the
// index the `RepoReader` built READ-ONLY, summarized the way an engineer reads
// an unfamiliar repo in the first 30 seconds. `explorationPrompt.ts` wraps this
// in the per-turn framing; the model navigates OUT from here (`recon.ts`), so
// this block is the map, not the territory.
//
// SHAPE. `ReconIndex.files` is the WHOLE tree: `githubRepoReader` pushes every
// blob path-only and only the ranked signal files carry a preview. Emitting one
// `### <path> (<n> bytes)` header per entry therefore spent the prompt on
// filenames — on a real 12k-file monorepo ~1.1 MB (~294k tokens) of nothing else
// before a single byte of content — and nothing bounded it. What replaces it is
// what an engineer actually reads in the first 30 seconds of an unfamiliar repo:
//
//   1. the ROOT files verbatim — few, and the most self-describing files a repo
//      has (`pnpm-workspace.yaml` + `justfile` + `ROADMAP.md` says a great deal);
//   2. a DIRECTORY ROLLUP — per top-level area: how many files, the extensions
//      that identify its ecosystem, and named example subdirectories. "40
//      TypeScript packages, 40 Python services, Terraform infra" in a dozen lines
//      rather than 12,110 literal paths;
//   3. NOTABLE FILES — ranked signal paths that did not win a content slot, named
//      individually and spread across areas so no one area crowds out the rest;
//   4. the PREVIEWS, whole.
//
// (1) and (3) are why this stays a summary rather than statistics: the model must
// still be able to NAME a specific file it wants to reason about, and the agentic
// pass that navigates from here must have somewhere concrete to go.
//
// PREVIEWS ARE RENDERED WHOLE. This module used to slice each preview to 1200
// chars while the reader fetched 4 KiB per signal file, so 71% of the content
// recon paid GitHub for was discarded before the model ever saw it. The bytes
// fetched are now the bytes used; size discipline lives in the reader's own
// content budget plus the single whole-prompt bound below — the same idiom every
// sibling authorer carries (`FRAGMENT_AUTHORER_PROMPT_MAX_CHARS` and friends).

import { rankSignalPaths } from "./reconSignalFiles.js";
import type { ReconIndex, ReconIndexedFile } from "./types.js";

/**
 * Defensive hard cap on ONE TURN's prompt size (chars). Sized to clear the
 * entry point's seed content (24 signal files × 4 KiB ≈ 98k) with room for the
 * rollup and the framing.
 *
 * This bounds a SINGLE TURN, never the exploration: what does not fit in this
 * turn is asked for in the next one. It exists so a drifting or hostile index —
 * or a turn's worth of observations — cannot hand the Answerer an unbounded
 * prompt, not to limit how much of a repository recon may read.
 */
export const RECON_PROMPT_MAX_CHARS = 120_000;

// Rollup shape. Each bound is small enough that the sections stay readable and
// large enough that a real monorepo's structure survives intact.
const TOP_LEVEL_ROWS = 30;
const CHILD_DIRECTORY_ROWS = 8;
const EXTENSION_ROWS = 4;
const ROOT_FILE_ROWS = 60;
const NOTABLE_FILE_ROWS = 40;
const NOTABLE_FILES_PER_AREA = 4;

const NO_EXTENSION = "(no extension)";

// Ordering tiebreak by CODE UNIT rather than `localeCompare`, for the same reason
// the signal-file policy does it: a locale-sensitive collation would make the
// rendered prompt depend on the host recon happens to run on.
function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Most-frequent first, then by name — the same order on every host. */
function byCountThenName(left: readonly [string, number], right: readonly [string, number]): number {
  return right[1] - left[1] || comparePaths(left[0], right[0]);
}

function extensionOf(path: string): string {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? NO_EXTENSION : basename.slice(dot).toLowerCase();
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** One top-level area of the repo, plus the shape of what lives under it. */
interface AreaRollup {
  readonly path: string;
  files: number;
  readonly extensions: Map<string, number>;
  /** Depth-2 directories under this area → files at or below each. */
  readonly children: Map<string, number>;
}

function rollUpAreas(files: readonly ReconIndexedFile[]): AreaRollup[] {
  const areas = new Map<string, AreaRollup>();
  for (const file of files) {
    const segments = file.path.split("/");
    const top = segments[0] ?? "";
    // Root files carry no directory of their own; they are listed verbatim.
    if (segments.length < 2 || top === "") continue;
    let area = areas.get(top);
    if (area === undefined) {
      area = { path: top, files: 0, extensions: new Map(), children: new Map() };
      areas.set(top, area);
    }
    area.files += 1;
    bump(area.extensions, extensionOf(file.path));
    if (segments.length > 2) bump(area.children, `${top}/${segments[1] ?? ""}`);
  }
  return [...areas.values()].sort((left, right) => right.files - left.files || comparePaths(left.path, right.path));
}

function renderExtensions(extensions: Map<string, number>): string {
  return [...extensions.entries()]
    .sort(byCountThenName)
    .slice(0, EXTENSION_ROWS)
    .map(([extension, count]) => `${extension} ${count}`)
    .join(", ");
}

function renderArea(area: AreaRollup): string[] {
  const children = [...area.children.entries()].sort(byCountThenName);
  const plural = children.length === 1 ? "directory" : "directories";
  const scope = children.length === 0 ? "" : ` in ${children.length} ${plural}`;
  const noun = area.files === 1 ? "file" : "files";
  const lines = [`- ${area.path} — ${area.files} ${noun} (${renderExtensions(area.extensions)})${scope}`];
  if (children.length === 0) return lines;
  const named = children.slice(0, CHILD_DIRECTORY_ROWS).map(([path, count]) => `${path} (${count})`);
  const hidden = children.length - named.length;
  lines.push(`    e.g. ${named.join(", ")}${hidden > 0 ? `, … +${hidden} more` : ""}`);
  return lines;
}

function renderRollup(files: readonly ReconIndexedFile[]): string[] {
  const areas = rollUpAreas(files);
  const lines = areas.slice(0, TOP_LEVEL_ROWS).flatMap((area) => renderArea(area));
  const hidden = areas.slice(TOP_LEVEL_ROWS);
  if (hidden.length > 0) {
    const hiddenFiles = hidden.reduce((total, area) => total + area.files, 0);
    lines.push(`- … ${hidden.length} further top-level directories (${hiddenFiles} files) not listed.`);
  }
  return lines.length === 0 ? ["(every indexed file sits at the repository root)"] : lines;
}

function renderRootFiles(files: readonly ReconIndexedFile[]): string {
  const roots = files
    .map((file) => file.path)
    .filter((path) => !path.includes("/"))
    .sort(comparePaths);
  if (roots.length === 0) return "(none)";
  const hidden = roots.length - ROOT_FILE_ROWS;
  const shown = roots.slice(0, ROOT_FILE_ROWS).join(", ");
  return hidden > 0 ? `${shown}, … +${hidden} more` : shown;
}

/**
 * Signal-ranked paths that did NOT win a content slot, named so the model can
 * ask for them. Bounded PER top-level area as well as overall, so one crowded
 * area (a workspace with 40 sibling manifests) cannot push every other ecosystem
 * out of the list.
 */
function notableFiles(files: readonly ReconIndexedFile[], ranked: readonly string[]): string[] {
  const previewed = new Set(files.filter((file) => file.preview !== "").map((file) => file.path));
  const perArea = new Map<string, number>();
  const notable: string[] = [];
  for (const path of ranked) {
    if (notable.length >= NOTABLE_FILE_ROWS) break;
    if (previewed.has(path) || !path.includes("/")) continue;
    const area = path.slice(0, path.indexOf("/"));
    const taken = perArea.get(area) ?? 0;
    if (taken >= NOTABLE_FILES_PER_AREA) continue;
    perArea.set(area, taken + 1);
    notable.push(path);
  }
  return notable;
}

/** Previewed files, most-informative first, so a cap bite drops the least useful. */
function renderPreviews(files: readonly ReconIndexedFile[], ranked: readonly string[]): string {
  const rankOf = new Map(ranked.map((path, position) => [path, position]));
  const previewed = files
    .filter((file) => file.preview !== "")
    .sort((left, right) => (rankOf.get(left.path) ?? ranked.length) - (rankOf.get(right.path) ?? ranked.length));
  if (previewed.length === 0) return "(no file contents were read)";
  return previewed.map((file) => `### ${file.path} (${file.size} bytes)\n${file.preview}`).join("\n\n");
}

/**
 * The entry-point evidence block: what recon can see about a repository before
 * it has asked for anything. Root files verbatim, the directory rollup, the
 * notable paths it has NOT read, and the seed previews.
 *
 * UNBOUNDED here on purpose — the single turn bound lives in
 * `explorationPrompt.ts`, which composes this with the framing it must never cut.
 */
export function renderReconEvidence(index: ReconIndex): string {
  if (index.files.length === 0) return "(no files indexed)";
  const ranked = rankSignalPaths(index.files.map((file) => file.path));
  const notable = notableFiles(index.files, ranked);
  const lines = [
    "## Root files",
    renderRootFiles(index.files),
    "",
    "## Repository shape",
    "One line per top-level directory: files at or below it, its most common file",
    "extensions, and named example subdirectories. Counts cover the whole tree.",
    ...renderRollup(index.files),
  ];
  if (notable.length > 0) {
    lines.push("", "## Other notable files (indexed by path; contents NOT read)", ...notable);
  }
  lines.push("", "## File previews (highest-signal files, as fetched)", renderPreviews(index.files, ranked));
  return lines.join("\n");
}
