// Brownfield recon REACH + TERMINATION tests — the two halves of "the entire
// repository", proven against the REAL reader over its injected HTTP seam (no
// network, no module mocking; the answerer is a scripted stand-in for the model,
// exactly as the sibling provider-wrapper tests use a scripted adapter).
//
// REACH (the negative control). The tree below is built so the file that
// actually names what the repository IS ranks BELOW the entry point's 24-slot
// content budget: 4 root files + CODEOWNERS + 5 workflows outrank every nested
// manifest, and 33 sibling manifests outrank this one. The suite ASSERTS that
// exclusion first — the reader never fetches it, its preview is empty, the
// entry-point prompt does not contain a byte of it — so the test cannot pass by
// the fixture being small or the budget being generous. Before the agentic
// conversion that was the end of the story and the content was unreachable;
// the exploration now navigates to it and the report carries its contents.
//
// TERMINATION (the opposite failure). "Converges" must not mean "runs forever".
// A repository where nothing further is worth reading, driven by an answerer
// that keeps asking anyway, must still stop — and stop by CONVERGENCE (the loop
// detects it is learning nothing and narrows the next turn to a report), not by
// a counter.

import { describe, expect, it } from "vitest";
import { runRecon } from "../src/engine/forge/brownfield/recon.js";
import { buildReconTurnPrompt } from "../src/engine/forge/brownfield/explorationPrompt.js";
import type {
  ReconReport,
  ReconTurn,
  ReconTurnAnswerer,
  ReconTurnInput,
} from "../src/engine/forge/brownfield/types.js";
import {
  REPO_URL,
  TreeServingGitHubClient,
  contentsOf,
  padded,
  previewOf,
  readerOver,
  upTo,
} from "./brownfieldRepoReader.fixtures.js";

/** The decisive file — the 34th nested manifest, far below the 24-slot cutoff. */
const DECISIVE = "packages/pkg-40/package.json";

function workspaceTree(): string[] {
  const paths = ["README.md", "package.json", "pnpm-workspace.yaml", "tsconfig.json", ".github/CODEOWNERS"];
  for (const n of upTo(5)) paths.push(`.github/workflows/wf-${padded(n)}.yml`);
  for (const n of upTo(40)) {
    const pkg = `packages/pkg-${padded(n)}`;
    paths.push(`${pkg}/README.md`, `${pkg}/package.json`, `${pkg}/tsconfig.json`);
    for (const f of upTo(6)) paths.push(`${pkg}/src/mod-${padded(f)}.ts`);
  }
  return paths;
}

function reportCiting(evidence: string): ReconReport {
  return {
    identity: { slug: "monorepo", purpose: "a workspace monorepo", inferredFrom: evidence },
    personas: [],
    behaviors: [],
    architecture: [],
    risks: [],
    gaps: [],
  };
}

/**
 * A scripted stand-in for the model. Each entry answers one turn; the recorded
 * prompts are what the real provider seam would have sent, so the assertions
 * below are over what a model would ACTUALLY have been able to see.
 */
function scriptedAnswerer(script: readonly ((input: ReconTurnInput) => ReconTurn)[]): ReconTurnAnswerer & {
  prompts: string[];
  finalizeTurns: number[];
} {
  const prompts: string[] = [];
  const finalizeTurns: number[] = [];
  return {
    prompts,
    finalizeTurns,
    async turn(input: ReconTurnInput): Promise<ReconTurn> {
      prompts.push(buildReconTurnPrompt(input));
      if (input.finalize) {
        finalizeTurns.push(prompts.length);
        // The provider seam narrows the finalize schema to a report; a scripted
        // answerer honors the same contract.
        return { status: "report", notes: input.notes, requests: [], report: reportCiting(input.notes) };
      }
      const step = script[Math.min(prompts.length - 1, script.length - 1)];
      if (step === undefined) throw new Error("script exhausted");
      return step(input);
    },
  };
}

describe("recon reach · beyond the entry-point content budget", () => {
  it("reaches the decisive file the fixed 24-slot budget provably excludes", async () => {
    const http = new TreeServingGitHubClient(workspaceTree());
    const explorer = readerOver(http);
    const index = await explorer.index(REPO_URL);

    // THE EXCLUSION IS REAL: indexed path-only, never fetched, absent from the
    // prompt a single non-agentic call would have been given.
    expect(index.files.some((file) => file.path === DECISIVE)).toBe(true);
    expect(previewOf(index.files, DECISIVE)).toBe("");
    expect(http.contentReads).not.toContain(DECISIVE);
    const entryPrompt = buildReconTurnPrompt({ index, observations: [], notes: "", finalize: false });
    expect(entryPrompt).not.toContain(contentsOf(DECISIVE));

    const answerer = scriptedAnswerer([
      // Turn 1: the entry point named `packages/` but not this file — find it.
      () => ({
        status: "explore",
        notes: "locating the workspace manifests",
        requests: [{ kind: "find", target: "pkg-40/package.json", offset: 0 }],
      }),
      // Turn 2: it is in the match list, so read it.
      (input) => {
        expect(input.observations.at(-1)?.body).toContain(DECISIVE);
        return {
          status: "explore",
          notes: "reading the decisive manifest",
          requests: [{ kind: "read", target: DECISIVE, offset: 0 }],
        };
      },
      // Turn 3: report, citing what it read.
      (input) => ({
        status: "report",
        notes: "",
        requests: [],
        report: reportCiting(input.observations.at(-1)?.body ?? "nothing"),
      }),
    ]);

    const { report, exploration } = await runRecon({ explorer, answerer }, REPO_URL);

    // THE REPORT RESTS ON CONTENT THE OLD BUDGET COULD NOT REACH.
    expect(report.identity.inferredFrom).toBe(contentsOf(DECISIVE));
    expect(http.contentReads).toContain(DECISIVE);
    // …and the model genuinely saw it: turn 3's prompt carried the bytes.
    expect(answerer.prompts.at(-1)).toContain(contentsOf(DECISIVE));

    // Converged by REPORTING, and the cost of doing so is observable.
    expect(exploration.endedBy).toBe("reported");
    expect(exploration.turns).toHaveLength(2);
    expect(exploration.filesRead).toBe(1);
    expect(exploration.bytesRead).toBe(contentsOf(DECISIVE).length);
    // Progress is measured as repository left unread, and it shrank.
    const [, second] = exploration.turns;
    expect(second?.learned).toBe(true);
    expect(second?.unreadFiles).toBeLessThan(index.files.length);
  });

  it("pages through a file larger than one read slice, so nothing is unreachable", async () => {
    // 96 KiB of content against a 32 KiB read slice: three offsets cover it.
    const http = new TreeServingGitHubClient(["README.md", DECISIVE], { padContentsTo: 96 * 1024 });
    const explorer = readerOver(http);

    const first = await explorer.explore(REPO_URL, { kind: "read", target: DECISIVE, offset: 0 });
    expect(first.total).toBe(96 * 1024);
    expect(first.covered).toBe(32 * 1024);

    const last = await explorer.explore(REPO_URL, { kind: "read", target: DECISIVE, offset: 64 * 1024 });
    expect(last.covered).toBe(32 * 1024);
    expect(last.request.offset + last.covered).toBe(last.total);
  });
});

describe("recon termination · exploration converges rather than running forever", () => {
  it("stops when nothing further is being learned, and asks for the report", async () => {
    // A repository with nothing left to discover: both files are seed previews.
    const http = new TreeServingGitHubClient(["README.md", "package.json"]);
    const explorer = readerOver(http);

    // An answerer that NEVER volunteers a report — it re-reads what it has
    // already read, forever. Only convergence can stop this.
    const answerer = scriptedAnswerer([
      () => ({
        status: "explore",
        notes: "re-reading the readme",
        requests: [{ kind: "read", target: "README.md", offset: 0 }],
      }),
    ]);

    const { report, exploration } = await runRecon({ explorer, answerer }, REPO_URL);

    expect(report.identity.slug).toBe("monorepo");
    // Ended by CONVERGENCE — the loop detected it was learning nothing.
    expect(exploration.endedBy).toBe("converged");
    // The first re-read did deliver content (a `read` returns more than the 4 KiB
    // seed preview, so it is genuinely new); the two after it delivered nothing,
    // and two consecutive no-new-information turns IS the fixed point. Pinned
    // exactly: a regression that let it wander shows up here as a larger number,
    // and one that gave up early as a smaller one.
    expect(exploration.turns.map((turn) => turn.learned)).toEqual([true, false, false]);
    expect(answerer.finalizeTurns).toEqual([4]);
    expect(answerer.prompts).toHaveLength(4);
    expect(answerer.prompts.at(-1)).toContain("This turn must produce the report");
  });

  it("a fruitless search does not read as progress", async () => {
    const http = new TreeServingGitHubClient(["README.md", "package.json"]);
    const explorer = readerOver(http);
    // Distinct requests every turn — but they find nothing, so nothing is
    // learned. Progress is keyed on what came BACK, never on what was asked,
    // which is exactly what stops an endlessly-guessing model.
    let guess = 0;
    const answerer = scriptedAnswerer([
      () => {
        guess += 1;
        return {
          status: "explore",
          notes: `guess ${guess}`,
          requests: [{ kind: "read", target: `does-not-exist-${guess}.md`, offset: 0 }],
        };
      },
    ]);

    const { exploration } = await runRecon({ explorer, answerer }, REPO_URL);

    expect(exploration.endedBy).toBe("converged");
    expect(exploration.filesRead).toBe(0);
    expect(exploration.turns).toHaveLength(2);
  });
});
