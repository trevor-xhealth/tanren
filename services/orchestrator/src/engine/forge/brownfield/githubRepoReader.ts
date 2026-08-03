// the real GitHub `RepoReader` behind the recon step. Reads the linked
// repo READ-ONLY through the SAME token resolution + injectable
// `GitHubHttpClient` as the rest of the brownfield reader — it lists the repo tree and
// pulls a small set of high-signal files (project manifests and build config
// across ecosystems, READMEs, CI pipelines) for the recon Answerer to reason
// over. It NEVER writes to the target repo.
//
// The HTTP client + token are injected, so the orchestrator wires it from the
// App-token resolver and tests use the in-memory fake `RepoReader` instead.

import { parseGitHubRepository, type GitHubHttpClient, type GitHubRepository } from "../../providers/github.js";
import type { ResolvedGithubToken } from "../../credentials/githubTokenResolver.js";
import { rankSignalPaths } from "./reconSignalFiles.js";
import type { ReconIndex, ReconIndexedFile, RepoReader } from "./types.js";

// How many files to read content for (the rest are path-only in the index).
const MAX_CONTENT_FILES = 24;
// Per-file preview cap (kept small for prompt economy at the Answerer).
const PREVIEW_BYTES = 4 * 1024;

// WHICH files fill those slots — the candidate set and the ranking over it — is
// the load-bearing judgement here, and it lives in `reconSignalFiles.ts`. This
// class is the I/O: list the tree, then pull previews for what the policy chose.

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

export class GithubRepoReader implements RepoReader {
  constructor(private readonly deps: GithubRepoReaderInput) {}

  async index(repoUrl: string): Promise<ReconIndex> {
    const repo = parseGitHubRepository(repoUrl);
    const entries = await this.listTree(repo);
    const blobs = entries.filter((e) => e.type === "blob" && typeof e.path === "string");
    const signalPaths = rankSignalPaths(blobs.map((e) => String(e.path))).slice(0, MAX_CONTENT_FILES);

    const files: ReconIndexedFile[] = [];
    // Path-only entries for the full tree (size from the tree listing).
    for (const entry of blobs) {
      const path = String(entry.path);
      files.push({ path, size: typeof entry.size === "number" ? entry.size : 0, preview: "" });
    }
    // Pull content for the high-signal files.
    for (const path of signalPaths) {
      const preview = await this.readPreview(repo, path);
      const existing = files.find((f) => f.path === path);
      if (existing !== undefined) existing.preview = preview;
    }

    return { repoUrl, filesIndexed: files.length, files };
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

  private async readPreview(repo: GitHubRepository, path: string): Promise<string> {
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
      return "";
    }
    const body = response.body as { content?: unknown; encoding?: unknown };
    if (typeof body.content !== "string") return "";
    const decoded =
      body.encoding === "base64"
        ? Buffer.from(body.content.replaceAll("\n", ""), "base64").toString("utf8")
        : body.content;
    return decoded.slice(0, PREVIEW_BYTES);
  }
}
