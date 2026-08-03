// Shared fixtures for the brownfield recon `GithubRepoReader` suites.
//
// Both suites drive the REAL reader through its injected `GitHubHttpClient`
// seam — no network and no module mocking — so this module owns the one seam
// implementation they share: a client that serves a synthetic git tree plus
// per-file contents while recording exactly which paths the reader asked to
// read content for, and in what order.

import type { ResolvedGithubToken } from "../src/engine/credentials/githubTokenResolver.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { GithubRepoReader } from "../src/engine/forge/brownfield/githubRepoReader.js";

const DEFAULT_BRANCH = "main";
export const REPO_URL = "https://github.com/acme/monorepo";

/** The body a served file previews as, so assertions can name it exactly. */
export function contentsOf(path: string): string {
  return `contents of ${path}`;
}

/** Serves a synthetic tree + per-file contents, recording what was asked for. */
export class TreeServingGitHubClient implements GitHubHttpClient {
  /** Paths the reader pulled CONTENT for, in the order it pulled them. */
  readonly contentReads: string[] = [];

  constructor(private readonly treePaths: readonly string[]) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    if (input.path.includes("/git/trees/")) {
      return {
        status: 200,
        body: {
          tree: this.treePaths.map((path) => ({ path, type: "blob", size: path.length })),
        },
      };
    }
    const contents = /\/contents\/(?<path>[^?]+)/u.exec(input.path);
    if (contents?.groups?.["path"] !== undefined) {
      // The reader percent-encodes each path SEGMENT and rejoins on "/", so undo
      // it the same way (a whole-string decode would turn an encoded %2F into a
      // separator).
      const path = contents.groups["path"]
        .split("/")
        .map((segment) => decodeURIComponent(segment))
        .join("/");
      this.contentReads.push(path);
      return {
        status: 200,
        body: { encoding: "utf-8", content: contentsOf(path) },
      };
    }
    return { status: 404, body: {} };
  }
}

const resolved: ResolvedGithubToken = {
  token: "gh_test_token",
  source: "static",
  async refresh() {
    return "gh_test_token";
  },
};

export function readerOver(http: GitHubHttpClient): GithubRepoReader {
  return new GithubRepoReader({ http, resolved, defaultBranch: DEFAULT_BRANCH });
}

export function previewOf(files: { path: string; preview: string }[], path: string): string {
  return files.find((file) => file.path === path)?.preview ?? "";
}

/** Zero-padded index, so synthetic sibling paths sort the way git sorts them. */
export function padded(n: number): string {
  return String(n).padStart(2, "0");
}

export function upTo(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}
