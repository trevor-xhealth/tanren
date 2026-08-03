// Brownfield recon TRUNCATED-TREE tests.
//
// `GET /git/trees/<ref>?recursive=1` is capped by GitHub at 100,000 entries /
// 7 MB. Past that it returns a PARTIAL `tree` and says so with a top-level
// `truncated: true` — the only signal there is. The reader used to read
// `body.tree` and ignore the flag, so a very large repository produced a
// silently partial index feeding a reconnaissance report that reads as
// authoritative over the whole codebase.
//
// No network and no module mocking: the shared brownfield reader fixture serves
// the tree through the reader's injected `GitHubHttpClient` seam.

import { describe, expect, it } from "vitest";
import {
  REPO_URL,
  TreeServingGitHubClient,
  contentsOf,
  previewOf,
  readerOver,
} from "./brownfieldRepoReader.fixtures.js";

const TREE = ["README.md", "package.json", "src/index.ts"];

describe("GithubRepoReader · truncated tree responses", () => {
  it("fails loud when GitHub truncated the tree instead of indexing the fragment", async () => {
    const http = new TreeServingGitHubClient(TREE, { truncated: true });

    await expect(readerOver(http).index(REPO_URL)).rejects.toThrow(/truncated/iu);
  });

  it("names the repository and the partial count so the operator can act on it", async () => {
    const http = new TreeServingGitHubClient(TREE, { truncated: true });

    const failure: unknown = await readerOver(http)
      .index(REPO_URL)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("ReconTreeTruncatedError");
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("acme/monorepo");
    expect(message).toContain(String(TREE.length));
    // The reader must not have gone on to spend content reads on a partial tree.
    expect(http.contentReads).toHaveLength(0);
  });

  it("still indexes a complete tree (the flag is absent or false)", async () => {
    const complete = await readerOver(new TreeServingGitHubClient(TREE)).index(REPO_URL);
    expect(complete.files).toHaveLength(TREE.length);
    expect(previewOf(complete.files, "README.md")).toBe(contentsOf("README.md"));

    const explicitlyComplete = await readerOver(new TreeServingGitHubClient(TREE, { truncated: false })).index(
      REPO_URL,
    );
    expect(explicitlyComplete.files).toHaveLength(TREE.length);
  });
});
