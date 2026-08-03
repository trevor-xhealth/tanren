// Brownfield recon ARCHITECTURAL-RECALL tests — the three controls that have to
// hold together, driven through the REAL reader over its injected HTTP seam (no
// network, no module mocking).
//
// THE DEFECT. On a real polyglot monorepo the exploration converged honestly and
// with excellent precision — every cited path existed, nothing was invented — and
// still produced a two-line `architecture` chapter for a repository with a Python
// backend, a Terraform estate and a 4,387-file sibling product. It had been SHOWN
// `.py 2244` and `.tf 60` in the rollup and cited `.py` files as evidence; it
// never named Python, never named Terraform, and never treated either as a layer.
// Two mechanisms produced that:
//
//   1. NOTHING IN THE PROMPT NAMED THE ECOSYSTEM. An extension histogram is not a
//      language name. A model that refuses to invent has no grounded token to
//      emit from `.tf 60` alone, so silence is the CORRECT behaviour for it —
//      which is why "instruct it to try harder" is the wrong fix and would buy
//      recall with fabrication.
//   2. CONVERGENCE COULD NOT SEE COVERAGE. The fixed point is measured over the
//      evidence corpus, so a model that read 58 files in ONE subtree converged
//      with 36% of the tree untouched, and reported that as complete.
//
// THE MODEL STAND-IN. `groundedModel` is not scripted to pass: it is a model of a
// PRECISE model — it emits an architecture line only for an ecosystem NAMED in
// its own prompt beside a path, and only for an area it has actually read a file
// under. Both conditions are the real failure's mechanism, so the suite fails on
// pre-change code for the real reason rather than by assertion.
//
// The three controls, all of which matter:
//   • RECALL      — the secondary language + the infrastructure layer, both
//                   deliberately placed outside the subtree the entry point points
//                   at, are characterized with cited evidence.
//   • TERMINATION — coverage must not become "explore everything": an answerer
//                   that ignores the completeness turn still converges, promptly.
//   • FABRICATION — on a single-ecosystem tree nothing names a language that is
//                   not there. A confident wrong layer is worse than silence.

import { describe, expect, it } from "vitest";
import { runRecon } from "../src/engine/forge/brownfield/recon.js";
import { buildReconTurnPrompt } from "../src/engine/forge/brownfield/explorationPrompt.js";
import type {
  ReconObservation,
  ReconReport,
  ReconTurn,
  ReconTurnAnswerer,
  ReconTurnInput,
} from "../src/engine/forge/brownfield/types.js";
import {
  REPO_URL,
  TreeServingGitHubClient,
  largeMonorepoTree,
  padded,
  previewOf,
  readerOver,
  upTo,
} from "./brownfieldRepoReader.fixtures.js";

// ── The polyglot fixture ───────────────────────────────────────────────────
//
// A JS/TS product surface deep enough to consume every one of the entry point's
// content slots (30 workspaces × 2 depth-2 manifests outrank anything nested
// deeper), with the SECONDARY LANGUAGE and the INFRASTRUCTURE deliberately one
// directory further down — so neither is previewed, and a model that explores
// outward from the previews it was given never touches either.

const PY_MANIFEST = "etl/pipelines/job-01/pyproject.toml";
const TF_MANIFEST = "platform/deploy/stack-01/main.tf";

function polyglotTree(): string[] {
  const paths = ["README.md", "package.json", "pnpm-workspace.yaml", "tsconfig.json", "turbo.json", "justfile"];
  for (const n of upTo(30)) {
    const app = `apps/web-${padded(n)}`;
    paths.push(`${app}/package.json`, `${app}/tsconfig.json`, `${app}/README.md`);
    for (const f of upTo(40)) paths.push(`${app}/src/screen-${padded(f)}.tsx`);
  }
  for (const n of upTo(12)) {
    const job = `etl/pipelines/job-${padded(n)}`;
    paths.push(`${job}/pyproject.toml`, `${job}/README.md`);
    for (const f of upTo(30)) paths.push(`${job}/src/task_${padded(f)}.py`);
  }
  for (const n of upTo(10)) {
    const stack = `platform/deploy/stack-${padded(n)}`;
    paths.push(`${stack}/main.tf`, `${stack}/variables.tf`);
  }
  return paths;
}

/** The same product surface with the other two ecosystems removed entirely. */
function monoglotTree(): string[] {
  return polyglotTree().filter((path) => !path.startsWith("etl/") && !path.startsWith("platform/"));
}

// ── The grounded model stand-in ────────────────────────────────────────────

/**
 * A generic ecosystem vocabulary. The stand-in may only ever emit one of these,
 * and only when its own prompt puts the word beside a path — the same discipline
 * a calibrated model applies, and the reason a prompt that shows `.tf 60` and
 * never says "Terraform" yields silence rather than a guess.
 */
const ECOSYSTEM_WORDS = [
  "python",
  "typescript",
  "javascript",
  "terraform",
  "docker",
  "kubernetes",
  "go",
  "rust",
  "ruby",
  "java",
  "php",
];

const PATH_TOKEN = /(?:^|[\s(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/u;

function areaOf(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(0, slash);
}

/** Every ecosystem word the prompt names ON A LINE THAT ALSO CARRIES A PATH. */
function groundedEcosystems(prompt: string): Map<string, string> {
  const grounded = new Map<string, string>();
  for (const line of prompt.split("\n")) {
    const path = PATH_TOKEN.exec(line)?.[1];
    if (path === undefined) continue;
    for (const word of ECOSYSTEM_WORDS) {
      if (grounded.has(word)) continue;
      if (new RegExp(`\\b${word}\\b`, "iu").test(line)) grounded.set(word, path);
    }
  }
  return grounded;
}

/** The paths the entry point named but did not read — the stand-in's only menu. */
function notablePaths(prompt: string): string[] {
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## Other notable files"));
  if (start === -1) return [];
  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("##")) break;
    if (line.includes("/") && !line.startsWith("- ") && line.trim() !== "") paths.push(line.trim());
  }
  return paths;
}

/**
 * Top-level areas the prompt EXPLICITLY asks the model to account for. A model
 * that is told "you have not characterized `etl`" acts on it; one that is never
 * told cannot. This is the only channel by which the stand-in ever widens its
 * exploration beyond the subtree it started in.
 */
function areasAskedAbout(prompt: string): string[] {
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## Areas you have not characterized"));
  if (start === -1) return [];
  const areas: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("##")) break;
    const area = /^- ([A-Za-z0-9_.-]+) —/u.exec(line)?.[1];
    if (area !== undefined) areas.push(area);
  }
  return areas;
}

function readAreasOf(observations: readonly ReconObservation[]): Set<string> {
  return new Set(
    observations
      .filter((observation) => observation.outcome === "content")
      .map((observation) => areaOf(observation.request.target)),
  );
}

interface GroundedModelOptions {
  /** Ignore every completeness prompt — the termination control's hostile model. */
  readonly refuseToWiden?: boolean;
  /**
   * Accept only ONE new area per completeness turn. The slowest good-faith model
   * there is, and the one that proves the ask is a finite DESCENT rather than a
   * single shot: each ask must leave the untouched set strictly smaller, or the
   * loop finalizes.
   */
  readonly widenOneAreaPerAsk?: boolean;
}

/**
 * The stand-in. It explores OUTWARD from the area the entry point previewed, and
 * writes a report it can defend: an architecture line per grounded ecosystem
 * whose evidence sits in an area it has read a file under. Nothing here is
 * scripted per-turn — the same object drives every tree in this suite.
 */
function groundedModel(options: GroundedModelOptions = {}): ReconTurnAnswerer & { prompts: string[] } {
  const prompts: string[] = [];
  const committed = new Set<string>();
  const requested = new Set<string>();
  return {
    prompts,
    async turn(input: ReconTurnInput): Promise<ReconTurn> {
      const prompt = buildReconTurnPrompt(input);
      prompts.push(prompt);
      const menu = notablePaths(prompts[0] ?? "");
      if (committed.size === 0 && menu.length > 0) committed.add(areaOf(menu[0] ?? ""));
      if (options.refuseToWiden !== true) {
        const asked = areasAskedAbout(prompt);
        for (const area of options.widenOneAreaPerAsk === true ? asked.slice(0, 1) : asked) committed.add(area);
      }

      if (!input.finalize) {
        const wanted = menu.filter((path) => committed.has(areaOf(path)) && !requested.has(path)).slice(0, 6);
        if (wanted.length > 0) {
          for (const path of wanted) requested.add(path);
          return {
            status: "explore",
            notes: `exploring ${[...committed].join(", ")}`,
            requests: wanted.map((path) => ({ kind: "read" as const, target: path, offset: 0 })),
          };
        }
        // Nothing left it is willing to open: re-list what it already knows. This
        // is the shape that must converge rather than spin.
        return {
          status: "explore",
          notes: `exploring ${[...committed].join(", ")}`,
          requests: [{ kind: "list" as const, target: menu[0] ?? "README.md", offset: 0 }],
        };
      }

      const read = readAreasOf(input.observations);
      const architecture = [...groundedEcosystems(prompt)]
        .filter(([, evidence]) => read.has(areaOf(evidence)))
        .map(([word, evidence]) => ({ layer: word, detail: `${word} layer, evidenced by ${evidence}` }));
      const report: ReconReport = {
        identity: { slug: "polyglot", purpose: "a workspace monorepo", inferredFrom: "package.json" },
        personas: [],
        behaviors: [],
        architecture,
        risks: [],
        gaps: [],
      };
      return { status: "report", notes: input.notes, requests: [], report };
    },
  };
}

function layers(report: ReconReport): string[] {
  return report.architecture.map((line) => line.layer.toLowerCase());
}

describe("recon architectural recall · a polyglot tree's secondary layers", () => {
  it("does not preview the secondary language or the infrastructure at all", async () => {
    const index = await readerOver(new TreeServingGitHubClient(polyglotTree())).index(REPO_URL);

    // THE EXCLUSION IS REAL: both are indexed path-only, so nothing below can
    // pass by the fixture handing the model the answer for free.
    expect(index.files.some((file) => file.path === PY_MANIFEST)).toBe(true);
    expect(index.files.some((file) => file.path === TF_MANIFEST)).toBe(true);
    expect(previewOf(index.files, PY_MANIFEST)).toBe("");
    expect(previewOf(index.files, TF_MANIFEST)).toBe("");
  });

  it("characterizes the secondary language and the infrastructure layer", async () => {
    const http = new TreeServingGitHubClient(polyglotTree());
    const explorer = readerOver(http);
    const answerer = groundedModel();

    const { report, exploration } = await runRecon({ explorer, answerer }, REPO_URL);

    // THE RECALL CLAIM. Both layers named, both with evidence, both from areas
    // the exploration actually opened.
    expect(layers(report)).toContain("python");
    expect(layers(report)).toContain("terraform");
    expect(JSON.stringify(report.architecture)).toContain("etl/");
    expect(JSON.stringify(report.architecture)).toContain("platform/");
    // …and it really did read there, rather than naming an area from the rollup.
    expect(http.contentReads.some((path) => path.startsWith("etl/"))).toBe(true);
    expect(http.contentReads.some((path) => path.startsWith("platform/"))).toBe(true);
    expect(exploration.endedBy).toBe("converged");

    // WHAT IT COST, pinned. The same model over the same tree converged in 3
    // turns before this change, having read 4 files inside `apps` and nothing
    // else. The completeness turn buys the other two ecosystems for 4 more turns
    // and ~3.5x the bytes — visible here so a regression that makes the loop
    // wander shows up as a number rather than as a slow bill.
    expect(exploration.turns).toHaveLength(7);
    expect(exploration.filesRead).toBe(12);
    expect(exploration.turns.at(-1)?.unreadAreas).toBe(0);
  });
});

describe("recon architectural recall · termination survives", () => {
  it("converges promptly even when the model refuses to widen", async () => {
    const http = new TreeServingGitHubClient(polyglotTree());
    const explorer = readerOver(http);
    const answerer = groundedModel({ refuseToWiden: true });

    const { report, exploration } = await runRecon({ explorer, answerer }, REPO_URL);

    // Coverage is a REASON NOT TO CONVERGE YET, never a requirement to finish the
    // repository: a model that declines the completeness turn still stops, and
    // stops by convergence rather than by a counter.
    expect(exploration.endedBy).toBe("converged");
    // EXACTLY ONE extra turn over the pre-change 3: the ask changes nothing, so
    // the untouched set does not shrink, so it is never repeated. This is the
    // number that must not grow — it is the whole difference between "a reason
    // not to converge yet" and "explore everything".
    expect(exploration.turns).toHaveLength(4);
    expect(http.contentReads.every((path) => !path.startsWith("etl/"))).toBe(true);
    // It reports what it can defend and stays silent about the rest — the
    // calibration this change must not trade away.
    expect(layers(report)).not.toContain("python");
    expect(layers(report)).not.toContain("terraform");
  });

  it("re-asks only while the untouched set is shrinking, and stops when it is not", async () => {
    const http = new TreeServingGitHubClient(polyglotTree());
    const explorer = readerOver(http);
    // The slowest good-faith model: one new area per ask. Two untouched areas so
    // the ask must fire twice — each time on a STRICTLY smaller set — and then
    // never again. A repeat on an unchanged set would be a loop, not a descent.
    const answerer = groundedModel({ widenOneAreaPerAsk: true });

    const { report, exploration } = await runRecon({ explorer, answerer }, REPO_URL);

    expect(exploration.endedBy).toBe("converged");
    // Read the ask itself, not the whole prompt — the repository-shape rollup
    // names every area in the same `- area — n files` form.
    const asks = answerer.prompts.map(areasAskedAbout).filter((areas) => areas.length > 0);
    expect(asks).toHaveLength(2);
    // Strictly descending: 2 untouched at the first ask, 1 at the second.
    expect(asks[0]).toEqual(["etl", "platform"]);
    expect(asks[1]).toEqual(["platform"]);
    expect(exploration.turns.at(-1)?.unreadAreas).toBe(0);
    expect(layers(report)).toEqual(expect.arrayContaining(["python", "terraform"]));
  });
});

describe("recon architectural recall · what it costs on a real-scale tree", () => {
  it("stays a handful of turns on a 12k-file polyglot monorepo", async () => {
    // The shape of the repository that surfaced this: a JS/TS workspace, 40
    // Python services, a Terraform estate, a docs tree and a vendored drop.
    const http = new TreeServingGitHubClient(largeMonorepoTree());
    const explorer = readerOver(http);
    const answerer = groundedModel();

    const { report, exploration } = await runRecon({ explorer, answerer }, REPO_URL);

    // THE BILL, visible. The whole exploration is still under a dozen turns —
    // not "read the repository".
    expect(exploration.turns.length).toBeLessThan(16);
    expect(exploration.bytesRead).toBeLessThan(2_000_000);
    // Coverage improved substantially and then STOPPED: what remains untouched
    // is the vendored drop and the docs tree, neither of which exposes a signal
    // file to open. The loop declines to force a read there, which is the whole
    // difference between "a reason not to converge yet" and a completion demand.
    expect(exploration.turns[0]?.unreadAreas).toBe(6);
    expect(exploration.turns.at(-1)?.unreadAreas).toBeLessThanOrEqual(2);
    // …and a tree of 12k files is nowhere near exhausted, which is the point.
    expect(exploration.filesRead).toBeLessThan(200);
    expect(exploration.turns.at(-1)?.unreadFiles).toBeGreaterThan(11_000);
    // Every ecosystem the tree actually contains is characterized.
    expect(layers(report)).toEqual(expect.arrayContaining(["python", "terraform", "typescript", "javascript"]));
  });
});

describe("recon architectural recall · fabrication control", () => {
  it("names no ecosystem the repository does not contain", async () => {
    const http = new TreeServingGitHubClient(monoglotTree());
    const explorer = readerOver(http);
    const answerer = groundedModel();

    const { report } = await runRecon({ explorer, answerer }, REPO_URL);

    const serialized = JSON.stringify(report).toLowerCase();
    for (const absent of ["python", "terraform", "kubernetes", "rust", "ruby"]) {
      expect(serialized).not.toContain(absent);
    }
    // The prompt itself must not name them either — a fabricated ecosystem in the
    // evidence block would be the same defect one layer earlier.
    const entry = answerer.prompts[0] ?? "";
    for (const absent of ["Python", "Terraform", "Kubernetes", "Rust"]) {
      expect(entry).not.toContain(absent);
    }
  });
});
