// the real GitHub `RepoExplorer` behind the recon step. Reads the linked
// repo READ-ONLY through the SAME token resolution + injectable
// `GitHubHttpClient` as the rest of the brownfield reader — it lists the repo tree,
// pulls a small set of high-signal files (project manifests and build config
// across ecosystems, READMEs, CI pipelines) as the ENTRY POINT, and then answers
// whatever the exploring Answerer asks for next. It NEVER writes to the target repo.
//
// The HTTP client + token are injected, so the orchestrator wires it from the
// App-token resolver and tests use the in-memory fake `RepoReader` instead.

import { parseGitHubRepository, type GitHubHttpClient, type GitHubRepository } from "../../providers/github.js";
import type { ResolvedGithubToken } from "../../credentials/githubTokenResolver.js";
import { rankSignalPaths } from "./reconSignalFiles.js";
import type { ReconIndex, ReconIndexedFile, ReconObservation, ReconRequest, RepoExplorer } from "./types.js";

/**
 * How many files the ENTRY POINT pre-reads content for. This is the SEED, not
 * the ceiling: it sizes turn zero's prompt (the best-ranked files an engineer
 * would open first), and everything else in the repository is reachable from
 * there by `explore` — so no file is excluded from recon, only from turn zero.
 */
const ENTRY_PREVIEW_FILES = 24;
// Per-file preview cap on those seed files (kept small for prompt economy).
const PREVIEW_BYTES = 4 * 1024;
// One `read` request's slice. Bigger than a seed preview because a read is a
// DELIBERATE ask; `offset` reaches the rest of a file larger than this.
const READ_SLICE_BYTES = 32 * 1024;
// One `list`/`find` response's width. `offset` reaches the rest of a listing.
const LISTING_ENTRIES = 200;

// WHICH files fill the seed slots — the candidate set and the ranking over it —
// is the load-bearing judgement here, and it lives in `reconSignalFiles.ts`. This
// class is the I/O: list the tree, pull previews for what the policy chose, and
// then serve whatever the exploration asks for over the same read-only surface.

/** Case-insensitive match of a `find` pattern against a path: substring, or one `*` wildcard. */
function pathMatches(lowerPath: string, lowerPattern: string): boolean {
  const star = lowerPattern.indexOf("*");
  if (star === -1) return lowerPath.includes(lowerPattern);
  const prefix = lowerPattern.slice(0, star);
  const suffix = lowerPattern.slice(star + 1);
  return (
    lowerPath.length >= prefix.length + suffix.length && lowerPath.startsWith(prefix) && lowerPath.endsWith(suffix)
  );
}

/** Normalize a directory target to a `""`-or-`"dir/"` prefix (`.`/`/` mean the root). */
function directoryPrefix(target: string): string {
  const trimmed = target.replace(/^\.?\/*/u, "").replace(/\/+$/u, "");
  return trimmed === "" || trimmed === "." ? "" : `${trimmed}/`;
}

/** Compared by CODE UNIT, never `localeCompare` — host-independent ordering. */
function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The immediate children of `prefix`: files verbatim, subdirectories as `name/`. */
function childrenOf(paths: readonly string[], prefix: string): string[] {
  const children = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === "") continue;
    const slash = rest.indexOf("/");
    children.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
  }
  return [...children].sort(comparePaths);
}

function repoApi(repo: GitHubRepository, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

interface TreeEntry {
  path?: unknown;
  type?: unknown;
  size?: unknown;
}

/**
 * GitHub truncated the recursive tree listing, so the index would be PARTIAL.
 *
 * `GET /git/trees/<ref>?recursive=1` is capped at 100,000 entries / 7 MB. Past
 * that GitHub returns a prefix of the tree and sets a top-level `truncated:
 * true` — the only signal there is that anything is missing.
 *
 * Recon FAILS here rather than indexing the fragment. Reconnaissance's whole
 * output is a report that reads as authoritative over a codebase, and its
 * consumers (the config-injection PR, the DAG seed) act on it; a report built
 * from an arbitrary alphabetical prefix of a repository is confidently wrong
 * about everything it never saw, and nothing downstream can tell. Recon is
 * read-only and nothing has been written when this throws, so failing costs the
 * operator a retry and buys them the truth. Indexing the prefix and flagging it
 * would leave the honest signal buried inside a plausible-looking report.
 *
 * The real fix for a repository this size is walking subtrees page by page; this
 * error is what keeps that requirement visible instead of hiding it.
 */
export class ReconTreeTruncatedError extends Error {
  constructor(
    readonly repo: GitHubRepository,
    readonly branch: string,
    readonly entriesReturned: number,
  ) {
    super(
      `recon aborted: GitHub truncated the recursive tree for ${repo.owner}/${repo.name}@${branch}. ` +
        `It returned ${entriesReturned} entries and set "truncated": true, so the listing is a PARTIAL ` +
        `prefix of the repository (the trees API caps a recursive listing at 100,000 entries / 7 MB). ` +
        `Indexing it would produce a reconnaissance report that reads as authoritative over files it ` +
        `never saw, so recon stops here. Onboard a smaller subtree, or extend the reader to walk ` +
        `subtrees page by page.`,
    );
    this.name = "ReconTreeTruncatedError";
  }
}

export interface GithubRepoReaderInput {
  http: GitHubHttpClient;
  resolved: ResolvedGithubToken;
  /** The repo's default branch (the ref recon reads the tree at). */
  defaultBranch: string;
}

export class GithubRepoReader implements RepoExplorer {
  /** Blob paths per repo, memoized from the tree listing `index` already paid for. */
  private readonly treePaths = new Map<string, string[]>();

  constructor(private readonly deps: GithubRepoReaderInput) {}

  async index(repoUrl: string): Promise<ReconIndex> {
    const repo = parseGitHubRepository(repoUrl);
    const entries = await this.listTree(repo);
    const blobs = entries.filter((e) => e.type === "blob" && typeof e.path === "string");
    const signalPaths = rankSignalPaths(blobs.map((e) => String(e.path))).slice(0, ENTRY_PREVIEW_FILES);

    const files: ReconIndexedFile[] = [];
    // Path-only entries for the full tree (size from the tree listing).
    for (const entry of blobs) {
      const path = String(entry.path);
      files.push({ path, size: typeof entry.size === "number" ? entry.size : 0, preview: "" });
    }
    this.treePaths.set(
      repoUrl,
      files.map((file) => file.path),
    );
    // Pull content for the high-signal files.
    for (const path of signalPaths) {
      const preview = (await this.readContent(repo, path))?.slice(0, PREVIEW_BYTES) ?? "";
      const existing = files.find((f) => f.path === path);
      if (existing !== undefined) existing.preview = preview;
    }

    return { repoUrl, filesIndexed: files.length, files };
  }

  /**
   * Answer ONE navigation request over the same read-only surface. `list` and
   * `find` are served from the memoized tree (no network at all); only `read`
   * costs a GitHub call — which is what makes exploring a repository cheap
   * enough to do properly.
   */
  async explore(repoUrl: string, request: ReconRequest): Promise<ReconObservation> {
    if (request.kind === "read") return this.observeRead(repoUrl, request);
    const paths = await this.pathsFor(repoUrl);
    const lowerTarget = request.target.toLowerCase();
    const matched =
      request.kind === "list"
        ? childrenOf(paths, directoryPrefix(request.target))
        : paths.filter((path) => pathMatches(path.toLowerCase(), lowerTarget));
    if (matched.length === 0) return { request, outcome: "not_found", body: "", total: 0, covered: 0 };
    const page = matched.slice(request.offset, request.offset + LISTING_ENTRIES);
    return {
      request,
      outcome: request.kind === "list" ? "listing" : "matches",
      body: page.join("\n"),
      total: matched.length,
      covered: page.length,
    };
  }

  private async observeRead(repoUrl: string, request: ReconRequest): Promise<ReconObservation> {
    const decoded = await this.readContent(parseGitHubRepository(repoUrl), request.target);
    if (decoded === undefined) return { request, outcome: "not_found", body: "", total: 0, covered: 0 };
    const slice = decoded.slice(request.offset, request.offset + READ_SLICE_BYTES);
    return { request, outcome: "content", body: slice, total: decoded.length, covered: slice.length };
  }

  /** The repo's blob paths, listing the tree on first use if `index` has not run. */
  private async pathsFor(repoUrl: string): Promise<string[]> {
    const cached = this.treePaths.get(repoUrl);
    if (cached !== undefined) return cached;
    const entries = await this.listTree(parseGitHubRepository(repoUrl));
    const paths = entries.filter((e) => e.type === "blob" && typeof e.path === "string").map((e) => String(e.path));
    this.treePaths.set(repoUrl, paths);
    return paths;
  }

  private async listTree(repo: GitHubRepository): Promise<TreeEntry[]> {
    const response = await this.deps.http.request({
      method: "GET",
      path: repoApi(repo, `/git/trees/${encodeURIComponent(this.deps.defaultBranch)}?recursive=1`),
      token: this.deps.resolved.token,
      refreshToken: this.deps.resolved.refresh,
    });
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
      return [];
    }
    const body = response.body as Record<string, unknown>;
    const tree = Array.isArray(body["tree"]) ? (body["tree"] as TreeEntry[]) : [];
    // The ONLY signal that the listing is short. Checked BEFORE anything is read
    // from it, so a truncated response never reaches the index (or costs a
    // content fetch) — see `ReconTreeTruncatedError` for why this fails loud.
    if (body["truncated"] === true) {
      throw new ReconTreeTruncatedError(repo, this.deps.defaultBranch, tree.length);
    }
    return tree;
  }

  /**
   * One file's WHOLE decoded body, or `undefined` when the path does not exist
   * / is not readable text. Callers slice it: the entry point to `PREVIEW_BYTES`,
   * an explicit `read` request to its own window. Slicing at the CALL SITE is
   * what lets a deliberate read see more than a seed preview does.
   */
  private async readContent(repo: GitHubRepository, path: string): Promise<string | undefined> {
    const encoded = path
      .split("/")
      .map((piece) => encodeURIComponent(piece))
      .join("/");
    const response = await this.deps.http.request({
      method: "GET",
      path: repoApi(repo, `/contents/${encoded}?ref=${encodeURIComponent(this.deps.defaultBranch)}`),
      token: this.deps.resolved.token,
      refreshToken: this.deps.resolved.refresh,
    });
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
      return undefined;
    }
    const body = response.body as { content?: unknown; encoding?: unknown };
    if (typeof body.content !== "string") return undefined;
    return body.encoding === "base64"
      ? Buffer.from(body.content.replaceAll("\n", ""), "base64").toString("utf8")
      : body.content;
  }
}
