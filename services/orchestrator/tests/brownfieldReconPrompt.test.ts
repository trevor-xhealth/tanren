// Brownfield recon PROMPT-SHAPE tests.
//
// These run over the ENTRY-POINT turn (turn zero of the exploration: nothing
// observed yet), which is where the whole tree has to be summarized.
//
// The recon prompt used to render one `### <path> (<n> bytes)` header for EVERY
// blob in the tree — and `ReconIndex.files` is the WHOLE tree (only the ranked
// signal files carry a preview). On a real 12k-file monorepo that is ~1.1 MB of
// nothing but filenames before a single byte of content, and the prompt had no
// bound of any kind while every sibling authorer carries one.
//
// It was ALSO truncating in the wrong place: the reader fetches 4 KiB per signal
// file and the renderer sliced each preview to 1200 chars, so 71% of the content
// recon paid GitHub for never reached the model.
//
// No network and no module mocking: the tree + file contents are served through
// the reader's injected `GitHubHttpClient` seam (the shared brownfield reader
// fixture), so these assertions run over a REAL index built by the REAL reader.

import { describe, expect, it } from "vitest";
import { buildReconTurnPrompt } from "../src/engine/forge/brownfield/explorationPrompt.js";
import { RECON_PROMPT_MAX_CHARS } from "../src/engine/forge/brownfield/prompt.js";
import type { ReconIndex } from "../src/engine/forge/brownfield/types.js";
import {
  REPO_URL,
  TreeServingGitHubClient,
  contentsOf,
  largeMonorepoTree,
  previewOf,
  readerOver,
} from "./brownfieldRepoReader.fixtures.js";

// The reader's per-file preview budget (githubRepoReader `PREVIEW_BYTES`). The
// renderer must spend all of it — bytes fetched are bytes used.
const PREVIEW_BYTES = 4 * 1024;

const LARGE_TREE = largeMonorepoTree();

/** What the OLD renderer emitted before any preview: a header per blob. */
function pathEnumerationBytes(files: readonly { path: string; size: number }[]): number {
  return files.map((file) => `### ${file.path} (${file.size} bytes)\n`).join("\n").length;
}

/** Turn zero: the entry point, before the model has asked for anything. */
function entryPrompt(index: ReconIndex): string {
  return buildReconTurnPrompt({ index, observations: [], notes: "", finalize: false });
}

describe("buildReconTurnPrompt · shape on a large repository", () => {
  it("summarizes the tree instead of enumerating it, and stays inside the prompt bound", async () => {
    const http = new TreeServingGitHubClient(LARGE_TREE);
    const index = await readerOver(http).index(REPO_URL);
    const prompt = entryPrompt(index);

    // Sanity: this really is a large tree, and enumerating it really is huge —
    // nothing below can pass by the fixture being small.
    expect(index.files.length).toBeGreaterThan(12_000);
    const enumerated = pathEnumerationBytes(index.files);
    expect(enumerated).toBeGreaterThan(500_000);

    // BOUNDED. The absolute bounds come first so a regression to an enumeration
    // fails on the SIZE it produced, not on a missing constant: the tree section
    // is a rollup, so the whole prompt (previews included) is a fraction of what
    // the bare path enumeration alone used to cost.
    expect(prompt.length).toBeLessThan(enumerated / 4);
    expect(prompt.length).toBeLessThan(150_000);
    // …and the exported cap is the source of truth, pinned so it cannot drift up.
    expect(RECON_PROMPT_MAX_CHARS).toBeLessThanOrEqual(150_000);
    expect(prompt.length).toBeLessThanOrEqual(RECON_PROMPT_MAX_CHARS);

    // NOT VACUOUS — a prompt that says nothing would also be short. The
    // architecture must survive: every top-level area, with counts and the
    // extensions that identify its ecosystem.
    expect(prompt).toMatch(/^- packages — 4520 files \([^)]*\.ts 4400[^)]*\) in 40 director/mu);
    expect(prompt).toMatch(/^- services — 3320 files \([^)]*\.py 3200[^)]*\) in 40 director/mu);
    expect(prompt).toMatch(/^- apps — 2200 files \([^)]*\.tsx 2140[^)]*\) in 20 director/mu);
    expect(prompt).toMatch(/^- infra — 60 files \(\.tf 60\) in 1 director/mu);
    expect(prompt).toMatch(/^- docs — 200 files \(\.md 200\)$/mu);
    expect(prompt).toMatch(/^- vendor — 1800 files \(\.js 1800\) in 60 director/mu);
    // A rolled-up area that omits siblings says how many — bounded VISIBLY.
    expect(prompt).toContain("… +32 more");

    // NAVIGABLE — specific paths a follow-up agentic pass could open by name:
    // root files verbatim, named example directories, named signal files from
    // every ecosystem (the per-area bound is what keeps one workspace from
    // crowding the others out).
    for (const rootFile of ["ROADMAP.md", "pnpm-workspace.yaml", "turbo.json", "Makefile"]) {
      expect(prompt).toContain(rootFile);
    }
    for (const named of [
      "packages/pkg-01 (113)",
      "services/api-01 (83)",
      "infra/modules (60)",
      "packages/pkg-01/package.json",
      "services/api-01/pyproject.toml",
      "apps/web-01/package.json",
      "infra/modules/net-01/main.tf",
    ]) {
      expect(prompt).toContain(named);
    }

    // …but NOT one line per blob: ordinary sources stay inside their rollup.
    expect(prompt).not.toContain("packages/pkg-37/src/mod-42.ts");
    expect(prompt).not.toContain("services/api-12/src/handler_07.py");
    expect(prompt).not.toContain("vendor/lib-40/dist/chunk-11.js");
    expect(prompt).not.toContain("docs/guide-88.md");
  });

  it("renders every preview byte the reader paid to fetch", async () => {
    // Content longer than the reader's own 4 KiB budget, so the reader truncates
    // to exactly PREVIEW_BYTES and the renderer must pass all of it through.
    const http = new TreeServingGitHubClient(["README.md", "package.json", "src/index.ts"], {
      padContentsTo: PREVIEW_BYTES * 2,
    });
    const index = await readerOver(http).index(REPO_URL);
    const preview = previewOf(index.files, "package.json");

    expect(preview).toHaveLength(PREVIEW_BYTES);
    expect(preview.startsWith(contentsOf("package.json"))).toBe(true);

    // The regression: the renderer used to slice each preview to 1200 chars,
    // discarding 71% of every fetched file.
    const prompt = entryPrompt(index);
    expect(prompt).toContain(preview);
    expect(prompt).toContain(previewOf(index.files, "README.md"));
  });

  it("still reads sensibly on an empty index", () => {
    const prompt = entryPrompt({ repoUrl: REPO_URL, filesIndexed: 0, files: [] });

    expect(prompt).toContain(REPO_URL);
    expect(prompt).toContain("(no files indexed)");
    expect(prompt).not.toContain("## Repository shape");
  });
});
