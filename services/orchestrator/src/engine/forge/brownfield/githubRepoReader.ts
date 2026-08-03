// the real GitHub `RepoReader` behind the recon step. Reads the linked
// repo READ-ONLY through the SAME token resolution + injectable
// `GitHubHttpClient` as the rest of the brownfield reader — it lists the repo tree and
// pulls a small set of high-signal files (manifests, READMEs, CI workflows) for
// the recon Answerer to reason over. It NEVER writes to the target repo.
//
// The HTTP client + token are injected, so the orchestrator wires it from the
// App-token resolver and tests use the in-memory fake `RepoReader` instead.

import { parseGitHubRepository, type GitHubHttpClient, type GitHubRepository } from "../../providers/github.js";
import type { ResolvedGithubToken } from "../../credentials/githubTokenResolver.js";
import type { ReconIndex, ReconIndexedFile, RepoReader } from "./types.js";

// How many files to read content for (the rest are path-only in the index).
const MAX_CONTENT_FILES = 24;
// Per-file preview cap (kept small for prompt economy at the Answerer).
const PREVIEW_BYTES = 4 * 1024;

// High-signal path fragments worth pulling content for during recon, split into
// the tiers that decide WHICH of them get read when there are more matches than
// content slots. Recon always reads a bounded slice, so the selection RULE is
// load-bearing: reading "whatever the tree API listed first" is reading whatever
// sorts first alphabetically, which in any layered repo means the `.github/`
// directory and the earliest nested workspaces — the repo's OWN manifests never
// make the cut and are handed to the Answerer with empty previews.
//
// Manifests + build config describe how the repo is assembled; CI workflows
// describe the contracts it enforces repo-wide; per-package prose is the least
// dense of the three. Root-level files describe the WHOLE repo, so they lead
// regardless of class (and there are only ever a handful of them).
const MANIFEST_FRAGMENTS = ["package.json", "tsconfig", "prisma/schema.prisma"];
const CI_FRAGMENTS = [".github/workflows/", "codeowners"];
const DOC_FRAGMENTS = ["readme"];

// Every fragment recon pulls content for — the union of the tiers above.
const SIGNAL_FRAGMENTS = [...MANIFEST_FRAGMENTS, ...CI_FRAGMENTS, ...DOC_FRAGMENTS];

// Selection tiers, most-informative first (see the fragment split above).
const ROOT_TIER = 0;
const CI_TIER = 1;
const NESTED_MANIFEST_TIER = 2;
const NESTED_DOC_TIER = 3;

function repoApi(repo: GitHubRepository, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

function matchesAny(lowerPath: string, fragments: readonly string[]): boolean {
  return fragments.some((fragment) => lowerPath.includes(fragment));
}

function isSignalPath(path: string): boolean {
  return matchesAny(path.toLowerCase(), SIGNAL_FRAGMENTS);
}

// How many directories deep a path sits (0 == a root-level file).
function pathDepth(path: string): number {
  return path.split("/").length - 1;
}

function signalTier(path: string): number {
  const lower = path.toLowerCase();
  if (pathDepth(path) === 0) return ROOT_TIER;
  if (matchesAny(lower, CI_FRAGMENTS)) return CI_TIER;
  if (matchesAny(lower, MANIFEST_FRAGMENTS)) return NESTED_MANIFEST_TIER;
  return NESTED_DOC_TIER;
}

// The final tiebreak. Compares by CODE UNIT rather than `localeCompare` so the
// ordering is identical on every host — a locale-sensitive collation would make
// the selection depend on the machine recon happens to run on.
function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// The signal paths in the order recon should spend its content budget on them:
// tier first, then shallower before deeper (a workspace nearer the root
// describes more of the repo), then the path itself so a given tree always
// yields the SAME selection no matter what order the trees API returned it in.
function rankSignalPaths(paths: readonly string[]): string[] {
  return [...paths]
    .filter((path) => isSignalPath(path))
    .sort(
      (left, right) =>
        signalTier(left) - signalTier(right) || pathDepth(left) - pathDepth(right) || comparePaths(left, right),
    );
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
