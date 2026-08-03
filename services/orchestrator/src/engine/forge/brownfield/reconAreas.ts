// Brownfield recon's TOP-LEVEL AREA rollup, and the COVERAGE read over it.
//
// PURE — no I/O. `prompt.ts` renders these rows as the repository-shape section;
// `reconExploration.ts` reads the same rollup to ask a different question: which
// top-level areas has this exploration read NOTHING under?
//
// WHY COVERAGE IS A SEPARATE QUESTION FROM CONVERGENCE. The exploration's fixed
// point is measured over the EVIDENCE CORPUS: two consecutive turns that surface
// no file content recon has not already read is, correctly, "nothing further to
// learn by reading MORE OF WHAT I AM READING". It is silent about WHERE that
// reading happened. A model that opens 58 files inside one product subtree
// reaches that fixed point honestly while a third of the repository — a second
// language, an infrastructure estate, an embedded sibling product — has never
// been touched, and then reports the result as complete.
//
// The naive repair ("keep going until every area is read") is worse than the
// defect: it converts a terminating loop into "explore everything", it can be
// refused indefinitely by a model that judges an area irrelevant, and it spends
// unboundedly on vendored trees and generated output. So coverage is NOT a
// completion requirement here. It is a REASON NOT TO CONVERGE YET, offered at
// most once per genuine reduction of the uncovered set — see
// `reconExploration.ts`, where the offer is itself governed by progress.

/** One top-level area of the repository, and the shape of what lives under it. */
export interface ReconArea {
  readonly path: string;
  /** Files at or below this area, across the whole tree. */
  readonly files: number;
  /** Extension → count, most frequent first when rendered. */
  readonly extensions: ReadonlyMap<string, number>;
  /** Depth-2 directories under this area → files at or below each. */
  readonly children: ReadonlyMap<string, number>;
}

const NO_EXTENSION = "(no extension)";

/**
 * Ordering tiebreak by CODE UNIT rather than `localeCompare`: a locale-sensitive
 * collation would make every rendered rollup depend on the host recon ran on.
 */
export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Most-frequent first, then by name — the same order on every host. */
export function byCountThenName(left: readonly [string, number], right: readonly [string, number]): number {
  return right[1] - left[1] || comparePaths(left[0], right[0]);
}

function extensionOf(path: string): string {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? NO_EXTENSION : basename.slice(dot).toLowerCase();
}

/** The top-level directory a path sits under, or `""` for a root-level file. */
function areaOf(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

interface MutableArea {
  readonly path: string;
  files: number;
  readonly extensions: Map<string, number>;
  readonly children: Map<string, number>;
}

/**
 * Roll the whole tree up to one row per top-level directory, largest first.
 * Root-level files carry no directory of their own and are excluded (callers
 * list them verbatim — there are only ever a handful, and they are the most
 * self-describing files a repository has).
 */
export function rollUpAreas(paths: readonly string[]): ReconArea[] {
  const areas = new Map<string, MutableArea>();
  for (const path of paths) {
    const segments = path.split("/");
    const top = segments[0] ?? "";
    if (segments.length < 2 || top === "") continue;
    let area = areas.get(top);
    if (area === undefined) {
      area = { path: top, files: 0, extensions: new Map(), children: new Map() };
      areas.set(top, area);
    }
    area.files += 1;
    bump(area.extensions, extensionOf(path));
    if (segments.length > 2) bump(area.children, `${top}/${segments[1] ?? ""}`);
  }
  return [...areas.values()].sort((left, right) => right.files - left.files || comparePaths(left.path, right.path));
}

/** The extension histogram of an area, most frequent first, as `".py 2244"`. */
export function describeExtensions(area: ReconArea, rows: number): string {
  return [...area.extensions.entries()]
    .sort(byCountThenName)
    .slice(0, rows)
    .map(([extension, count]) => `${extension} ${count}`)
    .join(", ");
}

/**
 * The top-level areas the exploration has read NO file content under, largest
 * first. `read` is every path whose CONTENT recon has seen — the entry point's
 * seed previews included, since those bytes reached the model exactly as a
 * `read` would have.
 *
 * Takes the ALREADY-ROLLED-UP areas rather than the tree: the rollup is a fact
 * about the index, which does not change across an exploration, while this is
 * asked once per turn. The caller rolls up once and filters many times.
 *
 * A MONOTONE measure: `read` only ever grows, so the returned set only ever
 * shrinks. That is what makes it safe to gate a non-convergence offer on — the
 * offer can be repeated only while the set is strictly smaller than at the last
 * offer, which is a finite descent, not a budget.
 */
export function uncharacterizedAreas(areas: readonly ReconArea[], read: ReadonlySet<string>): ReconArea[] {
  const covered = new Set<string>();
  for (const path of read) {
    const area = areaOf(path);
    if (area !== "") covered.add(area);
  }
  return areas.filter((area) => !covered.has(area.path));
}
