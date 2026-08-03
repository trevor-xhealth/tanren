// the real GitHub adapter behind the `ConfigInjectionGitHub` port.
// Wraps the shared `GitHubHttpClient` to: read the base branch head
// SHA, create the head branch (idempotently), PUT each kept file via the
// contents API, then open (or reuse) the PR via `GitHubPullRequestService`.
// Modeled on the `FetchConfigGateGitHub` adapter — same branch/commit/
// PR shape, generalized to commit MULTIPLE files in one PR.
//
// The HTTP client + token are injected, so the orchestrator wires it from the
// App-token resolver and tests use the in-memory fake port instead.

import { GitHubPullRequestService } from "../../providers/githubPullRequestReuse.js";
import {
  decodeBase64Content,
  parseGitHubRepository,
  type GitHubHttpClient,
  type GitHubRepository,
} from "../../providers/github.js";
import { mergeFileContent } from "./configInjection.js";
import type { ConfigInjectionGitHub, FileMergeStrategy, InjectedConfigPullRequest } from "./configInjection.js";

/** One file as it reaches the write seam: the bytes plus how to reconcile them. */
interface InjectedFile {
  path: string;
  content: string;
  merge: FileMergeStrategy;
}

function repoApi(repo: GitHubRepository, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

function encodeRepoPath(path: string): string {
  return path
    .split("/")
    .map((piece) => encodeURIComponent(piece))
    .join("/");
}

export interface FetchConfigInjectionGitHubInput {
  http: GitHubHttpClient;
  token: string;
  refreshToken?: () => Promise<string>;
}

export class FetchConfigInjectionGitHub implements ConfigInjectionGitHub {
  private readonly prService: GitHubPullRequestService;

  constructor(private readonly deps: FetchConfigInjectionGitHubInput) {
    this.prService = new GitHubPullRequestService(deps.http);
  }

  async openConfigInjectionPr(input: {
    repoUrl: string;
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
    files: ReadonlyArray<InjectedFile>;
  }): Promise<InjectedConfigPullRequest> {
    const repo = parseGitHubRepository(input.repoUrl);
    await this.ensureBranch(repo, input.baseBranch, input.headBranch);
    const committed: string[] = [];
    const skipped: string[] = [];
    for (const file of input.files) {
      const wrote = await this.commitFile(repo, input.headBranch, file, input.title);
      (wrote ? committed : skipped).push(file.path);
    }
    // Every proposed file was already the repository's own — there is no diff to open a
    // PR for. Fail LOUDLY rather than let GitHub reject an empty PR with a bare 422.
    if (committed.length === 0) {
      throw new Error(
        `config-injection wrote nothing: the repo already owns every proposed file (${skipped.join(", ")})`,
      );
    }
    const pr = await this.prService.ensureDraftPullRequest({
      repo,
      token: this.deps.token,
      refreshToken: this.deps.refreshToken,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      title: input.title,
      body: input.body,
    });
    return {
      number: pr.number,
      url: pr.url,
      branch: input.headBranch,
      filesCommitted: committed,
      filesSkipped: skipped,
    };
  }

  /** Create `headBranch` at `baseBranch`'s head SHA; tolerate an existing ref. */
  private async ensureBranch(repo: GitHubRepository, baseBranch: string, headBranch: string): Promise<void> {
    const ref = await this.deps.http.request({
      method: "GET",
      path: repoApi(repo, `/git/ref/${encodeRepoPath(`heads/${baseBranch}`)}`),
      token: this.deps.token,
      refreshToken: this.deps.refreshToken,
    });
    if (ref.status !== 200) {
      throw new Error(`could not read base branch ${baseBranch}: HTTP ${ref.status}`);
    }
    const sha = baseRefSha(ref.body);
    const create = await this.deps.http.request({
      method: "POST",
      path: repoApi(repo, "/git/refs"),
      token: this.deps.token,
      refreshToken: this.deps.refreshToken,
      body: { ref: `refs/heads/${headBranch}`, sha },
    });
    if (create.status !== 201 && create.status !== 422) {
      throw new Error(`could not create branch ${headBranch}: HTTP ${create.status}`);
    }
  }

  /**
   * Reconcile `file` with whatever the repo holds at its path and PUT the result — the
   * ONE place a target repo's bytes are overwritten, so the proposal's merge strategy is
   * enforced HERE, against the file that actually exists (not against a guess made
   * earlier). Returns whether a write happened; `false` means the repo's copy stands.
   *
   * A path that exists but whose content cannot be read (a directory, a submodule, a
   * blob GitHub returns without inline content) is treated as the repo's: only a file
   * tanren owns outright (`replace`) is written over it.
   */
  private async commitFile(
    repo: GitHubRepository,
    headBranch: string,
    file: InjectedFile,
    message: string,
  ): Promise<boolean> {
    const existing = await this.deps.http.request({
      method: "GET",
      path: repoApi(repo, `/contents/${encodeRepoPath(file.path)}?ref=${encodeURIComponent(headBranch)}`),
      token: this.deps.token,
      refreshToken: this.deps.refreshToken,
    });
    const present = existing.status === 200;
    const current = present ? contentText(existing.body) : undefined;
    if (present && current === undefined && file.merge !== "replace") return false;
    const next = mergeFileContent(file, present ? (current ?? "") : undefined);
    if (next === undefined) return false;
    const sha = present ? contentSha(existing.body) : undefined;
    const put = await this.deps.http.request({
      method: "PUT",
      path: repoApi(repo, `/contents/${encodeRepoPath(file.path)}`),
      token: this.deps.token,
      refreshToken: this.deps.refreshToken,
      body: {
        message: `${message}: ${file.path}`,
        branch: headBranch,
        content: Buffer.from(next, "utf8").toString("base64"),
        ...(sha === undefined ? {} : { sha }),
      },
    });
    if (put.status !== 200 && put.status !== 201) {
      throw new Error(`could not commit ${file.path}: HTTP ${put.status}`);
    }
    return true;
  }
}

/** The decoded UTF-8 body of a `/contents` response, or `undefined` when unreadable. */
function contentText(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as { content?: unknown; encoding?: unknown };
  if (typeof record.content !== "string") return undefined;
  return record.encoding === "base64" ? decodeBase64Content(record.content) : record.content;
}

function baseRefSha(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const objectRef = (body as Record<string, unknown>)["object"];
    if (typeof objectRef === "object" && objectRef !== null) {
      const sha = (objectRef as Record<string, unknown>)["sha"];
      if (typeof sha === "string" && sha !== "") return sha;
    }
  }
  throw new Error("GitHub ref response missing object.sha");
}

function contentSha(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null) {
    const sha = (body as Record<string, unknown>)["sha"];
    if (typeof sha === "string" && sha !== "") return sha;
  }
  return undefined;
}
