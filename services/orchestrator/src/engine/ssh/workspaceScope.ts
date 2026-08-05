// PER-RUN WORKSPACE SCOPE — the one place that answers "where may Tanren keep
// run-scoped state for this workspace, outside the repository it did not author?".
//
// Every run on a runner executes as the SAME unix user against ONE long-lived container
// (StaticRunnerAllocator, `fixed_pool`, worker concurrency 3 by default). Anything Tanren
// keeps at a runner-wide path is therefore SHARED MUTABLE STATE between concurrent runs —
// the defect class that made run A verify its toolchain against run B's mise config. So
// run-scoped state is named from the WORKSPACE PATH, which is unique per run.
//
// Extracted from `miseActivate.ts` (which owned the only copy) because a second consumer
// arrived: the workspace TOOL DIRECTORY (./workspaceToolPath.ts) needs exactly the same
// "a path only this run owns, outside the repo tree" rule. Two copies of that rule would
// be two chances to place one of them inside the repo, or runner-wide.
//
// The emitted strings are shell fragments meant to be interpolated INSIDE DOUBLE QUOTES
// (so `$HOME` expands on the fallback shape); {@link workspaceScopeKey} reduces the slug
// to `[A-Za-z0-9-]` so no other shell metacharacter can ever appear in one.

/** The run sandbox shape (`workspace/paths.ts`). Matched so run-scoped state lands in the
 * RUN dir — a sibling of the repo checkout, never inside it. */
const RUN_WORKSPACE_PATTERN = /^(\/workspace\/runs\/run_[A-Za-z0-9_-]+)\/repo$/u;

/**
 * The path prefix a run owns for state of the given `kind`. Pure.
 *
 * For the production shape `/workspace/runs/<runId>/repo` the prefix is
 * `/workspace/runs/<runId>/tanren-<kind>` — OUTSIDE the repo, so Tanren still never
 * materializes a file into a repository it did not author, and end-of-run teardown
 * reclaims it with the sandbox. Any other shape (the `rawInput.workspacePath` override
 * seam, fixtures) falls back to a deterministic per-workspace name in the runner user's
 * home rather than throwing.
 *
 * The two shapes are byte-for-byte what `miseRunScope` produced before this module
 * existed; `kind` is the only thing that varies between consumers.
 */
export function workspaceScopePrefix(workspacePath: string, kind: string): string {
  const runDir = RUN_WORKSPACE_PATTERN.exec(workspacePath)?.[1];
  return runDir === undefined
    ? `$HOME/.tanren-${kind}-${workspaceScopeKey(workspacePath)}`
    : `${runDir}/tanren-${kind}`;
}

// A readable slug plus a hash of the FULL path, so two workspaces that slugify alike
// still get distinct files. Reduced to `[A-Za-z0-9-]` because these paths are emitted
// inside double quotes (to let `$HOME` expand) and must carry no other shell metachar.
export function workspaceScopeKey(workspacePath: string): string {
  const slug = workspacePath
    .replaceAll(/[^A-Za-z0-9]+/gu, "-")
    .slice(-40)
    .replaceAll(/^-+|-+$/gu, "");
  return `${slug === "" ? "workspace" : slug}-${stableHash(workspacePath)}`;
}

// A plain polynomial rolling hash — deterministic across processes, which is all that is
// asked of it. Not a checksum and not security-bearing: it only keeps two workspaces
// whose slugs collide from sharing one scope.
function stableHash(value: string): string {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 0xff_ff_ff_ff;
  }
  return hash.toString(16).padStart(8, "0");
}
