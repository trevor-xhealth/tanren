// Brownfield recon POLYGLOT SIGNAL-SET tests.
//
// Recon's ranking decides the ORDER it spends its content budget in; this suite
// pins the CANDIDATE SET it ranks over. The set used to be Node-only
// (`package.json` / `tsconfig` / `prisma` / `.github/workflows` / README /
// CODEOWNERS), so a Python, Go, Rust, JVM, Ruby, PHP, .NET or Terraform repo —
// or any polyglot monorepo — had its most informative files invisible to
// reconnaissance: they never matched the filter, so no amount of reordering
// could reach them and they reached the Answerer with EMPTY previews.
//
// No network and no module mocking: the reader's injected `GitHubHttpClient`
// seam serves the tree and the file contents, and the assertions are on the
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
 * A synthetic POLYGLOT monorepo — Python services, Go modules, Terraform
 * infrastructure, Helm charts and a JS/TS workspace — listed in the order the
 * GitHub trees API returns it (git sorts by byte value, so `.`-prefixed and
 * upper-case names lead and the lower-case root manifests land at the very
 * END of the listing, after every nested subtree).
 */
function polyglotTreePaths(input: { apps: number; services: number; workflows: number }): string[] {
  const paths = [".circleci/config.yml"];
  for (const n of upTo(input.workflows)) paths.push(`.github/workflows/wf-${padded(n)}.yml`);
  paths.push("Dockerfile", "Makefile", "README.md");
  for (const n of upTo(input.apps)) {
    paths.push(`apps/web-${padded(n)}/package.json`, `apps/web-${padded(n)}/src/index.ts`);
    paths.push(`apps/web-${padded(n)}/tsconfig.json`);
  }
  for (const n of upTo(input.services)) {
    paths.push(`deploy/charts/svc-${padded(n)}/Chart.yaml`);
    paths.push(`infra/modules/net-${padded(n)}/main.tf`);
    paths.push(`services/api-${padded(n)}/pyproject.toml`, `services/api-${padded(n)}/src/main.py`);
  }
  // The repo's OWN root manifests — one per ecosystem — dead last in tree order.
  paths.push("go.mod", "go.work", "main.tf", "package.json", "pnpm-lock.yaml");
  paths.push("pyproject.toml", "requirements.txt", "turbo.json", "uv.lock");
  return paths;
}

// Far more signal files than the reader has content slots, and every nested
// subtree sorts ahead of the root manifests: the polyglot roots can only be
// reached by RECOGNIZING them, never by luck.
const CONTESTED_TREE = polyglotTreePaths({ apps: 10, services: 10, workflows: 6 });

// The repo's own project-definition files, one per ecosystem present. NONE of
// these were candidates before: a Node-only filter cannot see any of them.
const POLYGLOT_ROOT_MANIFESTS = [
  "Dockerfile",
  "Makefile",
  "go.mod",
  "go.work",
  "main.tf",
  "pyproject.toml",
  "requirements.txt",
  "turbo.json",
];

// Large, near-zero-information files. They must stay VISIBLE to the Answerer as
// indexed paths (that alone establishes "this repo is a pnpm / uv repo") while
// never consuming a content slot that a real manifest could use.
const LOCKFILES = ["pnpm-lock.yaml", "uv.lock"];

describe("GithubRepoReader · polyglot project manifests", () => {
  it("previews every ecosystem's root manifest, not just Node's", async () => {
    const http = new TreeServingGitHubClient(CONTESTED_TREE);
    const index = await readerOver(http).index(REPO_URL);

    // Sanity: the whole tree is indexed path-only, and the budget really IS
    // contested — the reader stopped well short of the signal files available,
    // so nothing here can pass by "everything got selected".
    expect(index.files).toHaveLength(CONTESTED_TREE.length);
    const previewed = index.files.filter((file) => file.preview !== "");
    expect(previewed.length).toBeLessThan(CONTESTED_TREE.length / 3);
    expect(http.contentReads).toHaveLength(previewed.length);
    // Proof the budget SATURATED rather than merely fitting: nested manifests of
    // exactly the kinds recognized below were still left path-only.
    expect(previewOf(index.files, "services/api-10/pyproject.toml")).toBe("");
    expect(previewOf(index.files, "infra/modules/net-10/main.tf")).toBe("");

    // The regression itself: each ecosystem's own root manifest carries content.
    for (const manifest of POLYGLOT_ROOT_MANIFESTS) {
      expect(previewOf(index.files, manifest)).toBe(contentsOf(manifest));
    }
    // …alongside the Node ones recon already knew about.
    expect(previewOf(index.files, "package.json")).toBe(contentsOf("package.json"));
    expect(previewOf(index.files, "README.md")).toBe(contentsOf("README.md"));
  });

  it("spends no content slot on lockfiles, but still indexes them as ecosystem evidence", async () => {
    const http = new TreeServingGitHubClient(CONTESTED_TREE);
    const index = await readerOver(http).index(REPO_URL);

    for (const lockfile of LOCKFILES) {
      expect(index.files.map((file) => file.path)).toContain(lockfile);
      expect(previewOf(index.files, lockfile)).toBe("");
      expect(http.contentReads).not.toContain(lockfile);
    }
    // Nor on ordinary source files, which the path index already covers.
    expect(http.contentReads.some((path) => path.endsWith("/src/index.ts"))).toBe(false);
    expect(http.contentReads.some((path) => path.endsWith("/src/main.py"))).toBe(false);
  });

  it("slots the new manifests and CI providers into the existing tier ladder", async () => {
    // Every signal file in this small polyglot repo fits the budget, so the
    // whole ladder (root → CI + ownership → nested manifests → nested prose) is
    // observable rather than truncated by the budget.
    const http = new TreeServingGitHubClient([
      ".circleci/config.yml",
      ".github/CODEOWNERS",
      ".gitlab-ci.yml",
      "Cargo.toml",
      "Jenkinsfile",
      "README.md",
      "crates/parser/Cargo.toml",
      "crates/parser/README.md",
      "crates/parser/src/lib.rs",
      "infra/main.tf",
      "services/api/pyproject.toml",
    ]);
    await readerOver(http).index(REPO_URL);

    expect(http.contentReads).toEqual([
      ".gitlab-ci.yml",
      "Cargo.toml",
      "Jenkinsfile",
      "README.md",
      ".circleci/config.yml",
      ".github/CODEOWNERS",
      "infra/main.tf",
      "crates/parser/Cargo.toml",
      "services/api/pyproject.toml",
      "crates/parser/README.md",
    ]);
  });

  it("matches project files by name rather than by bare substring", async () => {
    // The old filter was a raw substring test over the whole path, so any path
    // merely CONTAINING "readme" or "package.json" burned a content slot. The
    // decoys below must stay path-only; the real files beside them must not.
    const http = new TreeServingGitHubClient([
      "README.md",
      "docs/readme-generator/src/build.ts",
      "go.mod",
      "tools/package.json.template",
      "vendor/upstream/README.md",
    ]);
    const index = await readerOver(http).index(REPO_URL);

    expect(http.contentReads).not.toContain("docs/readme-generator/src/build.ts");
    expect(http.contentReads).not.toContain("tools/package.json.template");
    expect(previewOf(index.files, "README.md")).toBe(contentsOf("README.md"));
    expect(previewOf(index.files, "go.mod")).toBe(contentsOf("go.mod"));
    expect(previewOf(index.files, "vendor/upstream/README.md")).toBe(contentsOf("vendor/upstream/README.md"));
  });
});
