// Brownfield recon CITATION-INTEGRITY tests.
//
// THE DEFECT, from a real run. The report cited
// `docs/behaviors/B-0433-assign-and-track-patient-tasks-for-the-care-team.md`.
// The file is `B-0433-i-assign-and-track-…`. The exploration log shows recon
// asked for its guessed spelling, got a 404, and cited the guess anyway — in a
// report that was otherwise scrupulously grounded, with 31 of 33 cited paths
// resolving. A citation is the one thing a downstream reader is entitled to
// trust without re-checking, and the report feeds the config-injection PR and
// the DAG seed, neither of which can re-check a path for itself.
//
// Driven end-to-end through the REAL reader over its injected HTTP seam: the
// fixture 404s any path not in the tree exactly as GitHub's contents API does,
// so the not-found is genuinely observed rather than asserted.

import { describe, expect, it } from "vitest";
import { runRecon } from "../src/engine/forge/brownfield/recon.js";
import { unresolvedTargets } from "../src/engine/forge/brownfield/reconCitations.js";
import type {
  ReconObservation,
  ReconReport,
  ReconTurn,
  ReconTurnAnswerer,
  ReconTurnInput,
} from "../src/engine/forge/brownfield/types.js";
import { REPO_URL, TreeServingGitHubClient, readerOver } from "./brownfieldRepoReader.fixtures.js";

const REAL = "docs/behaviors/B-0433-i-assign-and-track-patient-tasks.md";
/** The same path with one segment dropped — the shape of the real miss. */
const GUESSED = "docs/behaviors/B-0433-assign-and-track-patient-tasks.md";

function treeWith(...extra: string[]): string[] {
  return ["README.md", "package.json", ...extra];
}

/** Probes `probe`, then cites `cite` in every citation-bearing field. */
function probeThenCite(probe: string, cite: string): ReconTurnAnswerer {
  let probed = false;
  return {
    async turn(input: ReconTurnInput): Promise<ReconTurn> {
      if (!probed) {
        probed = true;
        return { status: "explore", notes: "", requests: [{ kind: "read", target: probe, offset: 0 }] };
      }
      const report: ReconReport = {
        identity: { slug: "docs-repo", purpose: "a behaviour catalogue", inferredFrom: cite },
        personas: [{ name: "Care team", description: "runs the tasks", inferredFrom: cite }],
        behaviors: [{ persona: "Care team", title: "Assign and track tasks", inferredFrom: cite }],
        architecture: [{ layer: "docs", detail: `behaviour catalogue under ${cite}` }],
        risks: [],
        gaps: [],
      };
      return { status: "report", notes: input.notes, requests: [], report };
    },
  };
}

describe("recon citation integrity · a probed-and-missing path", () => {
  it("marks every citation naming a path recon probed and did not find", async () => {
    const explorer = readerOver(new TreeServingGitHubClient(treeWith(REAL)));

    const { report, exploration } = await runRecon({ explorer, answerer: probeThenCite(GUESSED, GUESSED) }, REPO_URL);

    // The guess 404'd, so no citation may carry it bare.
    expect(exploration.unverifiedCitations).toBe(4);
    expect(report.identity.inferredFrom).toBe(`${GUESSED} (unverified: not found)`);
    expect(report.personas[0]?.inferredFrom).toContain("(unverified: not found)");
    expect(report.behaviors[0]?.inferredFrom).toContain("(unverified: not found)");
    expect(report.architecture[0]?.detail).toContain("(unverified: not found)");
    // The CLAIM survives — deleting the citation would leave it unsourced, which
    // is worse than a flagged one.
    expect(report.behaviors[0]?.title).toBe("Assign and track tasks");
  });

  it("leaves a citation alone when the path resolved", async () => {
    const explorer = readerOver(new TreeServingGitHubClient(treeWith(REAL)));

    const { report, exploration } = await runRecon({ explorer, answerer: probeThenCite(REAL, REAL) }, REPO_URL);

    expect(exploration.unverifiedCitations).toBe(0);
    expect(report.identity.inferredFrom).toBe(REAL);
  });

  it("leaves a citation alone when a later probe corrected the guess", async () => {
    // A model that guesses wrong, notices, and re-asks correctly has done
    // nothing wrong — the path it CITES is the one that resolved.
    const explorer = readerOver(new TreeServingGitHubClient(treeWith(REAL)));
    let asked = 0;
    const answerer: ReconTurnAnswerer = {
      async turn(input: ReconTurnInput): Promise<ReconTurn> {
        asked += 1;
        if (asked <= 2) {
          const target = asked === 1 ? GUESSED : REAL;
          return { status: "explore", notes: "", requests: [{ kind: "read", target, offset: 0 }] };
        }
        return {
          status: "report",
          notes: input.notes,
          requests: [],
          report: {
            identity: { slug: "docs-repo", purpose: "a behaviour catalogue", inferredFrom: REAL },
            personas: [],
            behaviors: [],
            architecture: [],
            risks: [],
            gaps: [],
          },
        };
      },
    };

    const { report } = await runRecon({ explorer, answerer }, REPO_URL);

    expect(report.identity.inferredFrom).toBe(REAL);
  });
});

function read(target: string, outcome: ReconObservation["outcome"]): ReconObservation {
  return {
    request: { kind: "read", target, offset: 0 },
    outcome,
    body: outcome === "content" ? "x" : "",
    total: 1,
    covered: outcome === "content" ? 1 : 0,
  };
}

describe("unresolvedTargets · what counts as a dangling citation", () => {
  it("excludes a target a later read satisfied", () => {
    expect([...unresolvedTargets([read("a.md", "not_found"), read("a.md", "content")])]).toEqual([]);
  });

  it("ignores a search that matched nothing — a `find` is not a citation", () => {
    const search: ReconObservation = {
      request: { kind: "find", target: "*.tf", offset: 0 },
      outcome: "not_found",
      body: "",
      total: 0,
      covered: 0,
    };
    expect([...unresolvedTargets([search])]).toEqual([]);
  });

  it("keeps a read that never resolved", () => {
    expect([...unresolvedTargets([read("b.md", "not_found")])]).toEqual(["b.md"]);
  });
});
