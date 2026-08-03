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

/** How a served tree/file departs from the simple default. */
export interface TreeServingOptions {
  /** Serve GitHub's `truncated: true` flag alongside a PARTIAL `tree`. */
  readonly truncated?: boolean;
  /** Pad every served file body out to this many chars (still `contentsOf`-prefixed). */
  readonly padContentsTo?: number;
}

/** Serves a synthetic tree + per-file contents, recording what was asked for. */
export class TreeServingGitHubClient implements GitHubHttpClient {
  /** Paths the reader pulled CONTENT for, in the order it pulled them. */
  readonly contentReads: string[] = [];

  constructor(
    private readonly treePaths: readonly string[],
    private readonly options: TreeServingOptions = {},
  ) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    if (input.path.includes("/git/trees/")) {
      return {
        status: 200,
        body: {
          tree: this.treePaths.map((path) => ({ path, type: "blob", size: path.length })),
          truncated: this.options.truncated ?? false,
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
      // A path that is not in the tree 404s, exactly as GitHub's contents API
      // does. Serving content for ANY requested path would let a suite "read" a
      // file the repository does not contain — and would let an exploring recon
      // treat an endless stream of invented paths as endless new evidence.
      if (!this.treePaths.includes(path)) return { status: 404, body: {} };
      return {
        status: 200,
        body: { encoding: "utf-8", content: this.bodyFor(path) },
      };
    }
    return { status: 404, body: {} };
  }

  /** `contentsOf(path)`, optionally padded so the reader's own byte budget bites. */
  private bodyFor(path: string): string {
    const head = contentsOf(path);
    const padTo = this.options.padContentsTo ?? 0;
    return head.length >= padTo ? head : `${head}\n${"x".repeat(padTo - head.length - 1)}`;
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

/**
 * A synthetic monorepo at REAL scale: a pnpm/turbo JS workspace, a fleet of
 * Python services, Terraform infrastructure, a docs tree and a vendored drop —
 * ~12k blobs, the size of the repository that surfaced both the prompt-shape
 * defect and the architectural-recall one. Shared, because the prompt-shape
 * suite and the exploration-cost suite must reason about the SAME tree: what
 * one turn costs and what a whole exploration costs are the two halves of the
 * same question.
 */
export function largeMonorepoTree(): string[] {
  const paths = [
    ".gitignore",
    "Dockerfile",
    "LICENSE",
    "Makefile",
    "README.md",
    "ROADMAP.md",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "turbo.json",
  ];
  for (const n of upTo(20)) paths.push(`.github/workflows/wf-${padded(n)}.yml`);
  for (const n of upTo(40)) {
    const pkg = `packages/pkg-${padded(n)}`;
    paths.push(`${pkg}/README.md`, `${pkg}/package.json`, `${pkg}/tsconfig.json`);
    for (const f of upTo(80)) paths.push(`${pkg}/src/mod-${padded(f)}.ts`);
    for (const f of upTo(30)) paths.push(`${pkg}/tests/mod-${padded(f)}.test.ts`);
  }
  for (const n of upTo(40)) {
    const svc = `services/api-${padded(n)}`;
    paths.push(`${svc}/README.md`, `${svc}/pyproject.toml`, `${svc}/requirements.txt`);
    for (const f of upTo(60)) paths.push(`${svc}/src/handler_${padded(f)}.py`);
    for (const f of upTo(20)) paths.push(`${svc}/tests/test_${padded(f)}.py`);
  }
  for (const n of upTo(20)) {
    const app = `apps/web-${padded(n)}`;
    paths.push(`${app}/README.md`, `${app}/next.config.js`, `${app}/package.json`);
    for (const f of upTo(80)) paths.push(`${app}/src/screen-${padded(f)}.tsx`);
    for (const f of upTo(27)) paths.push(`${app}/tests/screen-${padded(f)}.test.tsx`);
  }
  for (const n of upTo(30)) {
    paths.push(`infra/modules/net-${padded(n)}/main.tf`, `infra/modules/net-${padded(n)}/variables.tf`);
  }
  for (const n of upTo(200)) paths.push(`docs/guide-${padded(n)}.md`);
  for (const n of upTo(60)) {
    for (const f of upTo(30)) paths.push(`vendor/lib-${padded(n)}/dist/chunk-${padded(f)}.js`);
  }
  return paths;
}
