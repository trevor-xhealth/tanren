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
    const tree = (response.body as Record<string, unknown>)["tree"];
    return Array.isArray(tree) ? (tree as TreeEntry[]) : [];
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
