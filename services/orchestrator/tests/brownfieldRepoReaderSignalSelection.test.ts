// Brownfield recon SIGNAL-FILE SELECTION tests.
//
// Recon reads content for only a bounded slice of a repo's files, so WHICH
// files it reads is the whole game. This suite pins that selection to
// informational PRIORITY (root-level manifests + build config, then CI
// workflows, then per-package prose; shallower before deeper) rather than to
// the raw git-tree listing order the GitHub trees API happens to return.
//
// The fixture is a synthetic monorepo tree in real git-tree order: `.github/`
// sorts first, the root README next, then a large `apps/` subtree of nested
// `package.json` + `README.md` files, and the ROOT manifests dead last. That
// ordering is exactly the pathology observed against a real monorepo — every
// content slot consumed by CI workflows plus nested per-package READMEs while
// the repo's own `package.json` / `tsconfig.json` were indexed with EMPTY
// previews, which in turn starves the downstream package-script intent
// extractor (it bails on an empty preview).
//
// No network and no module mocking: the reader's injected `GitHubHttpClient`
// seam (shared with the polyglot suite via `brownfieldRepoReader.fixtures.ts`)
// serves the tree and the file contents, and the assertions are on the
// observable outcome (the returned index's previews) plus the order in which
// the reader actually asked for content.

import { describe, expect, it } from "vitest";
import {
  REPO_URL,
  TreeServingGitHubClient,
  contentsOf,
  padded,
  previewOf,
  readerOver,
  upTo,
} from "./brownfieldRepoReader.fixtures.js";

/**
 * A synthetic monorepo tree, in the order the GitHub trees API returns it (git
 * sorts each tree's entries by name and expands recursively) — so `.github/`
 * leads, the whole `apps/` subtree follows, and the ROOT manifests are the very
 * LAST blobs in the listing.
 */
function syntheticTreePaths(input: { workspaces: number; workflows: number }): string[] {
  const paths: string[] = [".github/CODEOWNERS"];
  for (const n of upTo(input.workflows)) {
    paths.push(`.github/workflows/wf-${padded(n)}.yml`);
  }
  paths.push("README.md");
  for (const n of upTo(input.workspaces)) {
    paths.push(`apps/pkg-${padded(n)}/README.md`);
    paths.push(`apps/pkg-${padded(n)}/package.json`);
    paths.push(`apps/pkg-${padded(n)}/src/index.ts`);
    paths.push(`apps/pkg-${padded(n)}/tsconfig.json`);
  }
  paths.push("package.json");
  paths.push("tsconfig.json");
  return paths;
}

// The pathological tree: far more nested `package.json` / `README.md` pairs than
// the reader has content slots, all of them sorting ahead of the root manifests.
// The root manifests can only be reached by RANKING, never by luck.
const CONTESTED_TREE = syntheticTreePaths({ workspaces: 40, workflows: 12 });
// A small tree whose signal files ALL fit inside the content budget, so the full
// tier ladder (root → CI → nested manifests → nested READMEs) is observable
// rather than truncated by the budget.
const UNCONTESTED_TREE = syntheticTreePaths({ workspaces: 2, workflows: 2 });

const ROOT_MANIFESTS = ["package.json", "tsconfig.json"];

const isNestedReadme = (path: string): boolean => path.includes("/") && path.toLowerCase().endsWith("readme.md");
const isWorkflow = (path: string): boolean => path.startsWith(".github/workflows/");

describe("GithubRepoReader · signal-file selection under a bounded content budget", () => {
  it("previews the ROOT manifests even when the whole nested tree sorts ahead of them", async () => {
    const http = new TreeServingGitHubClient(CONTESTED_TREE);
    const index = await readerOver(http).index(REPO_URL);

    // Sanity: the whole tree is indexed path-only, and the budget really IS
    // contested — far more signal files exist than the reader pulled content for.
    expect(index.files).toHaveLength(CONTESTED_TREE.length);
    const signalCount = CONTESTED_TREE.filter((path) => !path.endsWith("/src/index.ts")).length;
    expect(http.contentReads.length).toBeGreaterThan(0);
    expect(http.contentReads.length).toBeLessThan(signalCount);

    // The regression itself: the repo's OWN manifests must carry content.
    for (const manifest of ROOT_MANIFESTS) {
      expect(previewOf(index.files, manifest)).toBe(contentsOf(manifest));
    }
    expect(previewOf(index.files, "README.md")).toBe(contentsOf("README.md"));

    // …and they are read FIRST, ahead of the CI workflows that used to crowd
    // them out entirely.
    const lastRootManifest = Math.max(...ROOT_MANIFESTS.map((path) => http.contentReads.indexOf(path)));
    expect(lastRootManifest).toBeGreaterThanOrEqual(0);
    expect(lastRootManifest).toBeLessThan(http.contentReads.findIndex(isWorkflow));
  });

  it("ranks root manifests, then CI workflows, then per-package READMEs", async () => {
    // Every signal file in this tree fits the budget, so the whole ladder is
    // observable instead of being cut off partway down.
    const http = new TreeServingGitHubClient(UNCONTESTED_TREE);
    await readerOver(http).index(REPO_URL);

    expect(http.contentReads).toEqual([
      "README.md",
      "package.json",
      "tsconfig.json",
      ".github/CODEOWNERS",
      ".github/workflows/wf-01.yml",
      ".github/workflows/wf-02.yml",
      "apps/pkg-01/package.json",
      "apps/pkg-01/tsconfig.json",
      "apps/pkg-02/package.json",
      "apps/pkg-02/tsconfig.json",
      "apps/pkg-01/README.md",
      "apps/pkg-02/README.md",
    ]);
    // Restated as the ordering INVARIANT, so the ladder is the thing under test
    // rather than this one fixture's spelling.
    expect(http.contentReads.indexOf("package.json")).toBeLessThan(http.contentReads.findIndex(isWorkflow));
    expect(http.contentReads.findIndex(isWorkflow)).toBeLessThan(http.contentReads.findIndex(isNestedReadme));
  });

  it("selects the same files in the same order regardless of the order the tree API returns", async () => {
    const ordered = new TreeServingGitHubClient(CONTESTED_TREE);
    await readerOver(ordered).index(REPO_URL);

    // A different-but-equivalent listing order (the trees API gives no ordering
    // guarantee, and a paged/reordered response must not change what recon reads).
    const descending = [...CONTESTED_TREE].sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
    const shuffled = new TreeServingGitHubClient(descending);
    await readerOver(shuffled).index(REPO_URL);

    expect(shuffled.contentReads).toEqual(ordered.contentReads);
  });
});
