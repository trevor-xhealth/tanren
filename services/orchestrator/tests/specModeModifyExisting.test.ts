// The NEGATIVE CONTROL for the `modify_existing` (brownfield) authoring mode.
//
// THE DEFECT THIS PINS. `from_scratch` was LABELLED "the brownfield/legacy authoring
// path", but its standing writer instruction is:
//
//   "The project's DECLARED CONTRACT files are FIXED … Build everything ELSE — the
//    manifest/lockfile, sources, configs, tests, fixtures — so that the lifecycle
//    commands those contract files already declare PASS as written."
//
// with an IMMUTABLE_CONTRACT_FILES set of exactly TWO entries. Pointed at an empty repo
// that is authoring guidance. Pointed at a pre-existing 12k-file monorepo it is a
// standing invitation to regenerate the lockfile, rewrite the manifests, replace the
// configs and re-author the tests — to REBUILD the repository rather than make a scoped
// change to it. Before this mode existed there was no way to say otherwise: a spec
// carrying `modify_existing` produced a prompt BYTE-IDENTICAL to `from_scratch`, because
// the writer/checker/auditor/oracle dispatchers all fell through to the default arm.
//
// WHAT THIS FILE PROVES, in three parts:
//   1. POSITIVE — `from_scratch` still carries the rebuild instruction verbatim, and
//      `modify_existing` carries scoped-change guidance instead (read before writing,
//      smallest coherent change, existing tests are a contract, spec-gated surfaces).
//   2. NEGATIVE — the two are DISJOINT: neither mode's marker text leaks into the other,
//      and `modify_existing` never sees "Build everything ELSE".
//   3. ADDITIVE — the two PRE-EXISTING modes (`from_scratch`, `specialize_seed`) render
//      byte-identically across all four mode-aware prompts, and identically to the
//      absent-mode legacy shape where that was already true. This is what proves the
//      third arm changed nothing for greenfield.
//
// The IMMUTABILITY BOUNDARY is asserted here too, deliberately rather than left in prose:
// `IMMUTABLE_CONTRACT_FILES` (the ABSOLUTE ban, every mode) stays exactly two entries,
// and `SPEC_GATED_REPO_SURFACES` (the CONDITIONAL, brownfield-only boundary the spec
// itself unlocks) appears in the `modify_existing` prompt and in NO other mode's.

import { describe, expect, it } from "vitest";
import type { PlanSubtask } from "../src/engine/answerers/schemas/index.js";
import { DEFAULT_SPEC_MODE, SpecMode } from "../src/engine/state/spec.js";
import {
  IMMUTABLE_CONTRACT_FILES,
  SPEC_GATED_REPO_SURFACES,
  writerPromptFor,
} from "../src/engine/workflow/subtaskWriterPrompt.js";
import { buildAuditorPrompt, buildCheckerPrompt } from "../src/engine/workflow/answererPrompts.js";
import { buildDesignOraclePrompt } from "../src/engine/workflow/designOracle/designOraclePrompt.js";
import type { SubtaskLoopInput } from "../src/engine/workflow/subtaskLoop.js";

// The `from_scratch` REBUILD instruction — the exact phrases that make it wrong for a
// pre-existing repository. `modify_existing` must carry none of them.
const REBUILD_MARKERS = [
  "Build everything ELSE",
  "manifest/lockfile, sources, configs, tests, fixtures",
  "RECONCILE generated companions",
  "project's declared install or bootstrap step",
  "bump to newer PUBLISHED versions",
  "frozen-lockfile gate",
];

// The `modify_existing` SCOPED-CHANGE markers — one per rule the mode exists to state.
const SCOPED_CHANGE_MARKERS = [
  "MODIFY-EXISTING mode",
  "PRE-EXISTING, AUTHORITATIVE repository",
  "READ BEFORE YOU WRITE",
  "SMALLEST COHERENT CHANGE",
  "EXISTING TESTS ARE A CONTRACT",
  "SPEC-GATED",
];

// A minimal SubtaskLoopInput-shaped object — only the fields `writerPromptFor()` reads.
function inputWith(specMode?: SpecMode): SubtaskLoopInput {
  return {
    context: {
      specTitle: "Add a rate limit to the ingest endpoint",
      specDescription: "The existing ingest endpoint must reject bursts above the configured rate.",
      acceptanceCriteria: ["given a burst above the rate, when it arrives, then the endpoint rejects it"],
      behaviorIds: [],
      behaviorContext: [],
      runId: "run_test",
      specId: "spec_test",
      projectId: "project_test",
      workspacePath: "/workspace/runs/run_test/repo",
      ...(specMode !== undefined && { specMode }),
    },
  } as unknown as SubtaskLoopInput;
}

const subtask: PlanSubtask = {
  index: 0,
  title: "Rate-limit the ingest endpoint",
  intent: "Reject bursts above the configured rate",
  behaviorIds: [],
};

const ANSWERER_SHARED = {
  specTitle: "Add a rate limit to the ingest endpoint",
  specDescription: "The existing ingest endpoint must reject bursts above the configured rate.",
  acceptanceCriteria: ["given a burst above the rate, when it arrives, then the endpoint rejects it"],
  baselineSha: "abc123",
  outputInstructions: ["(stub output instructions for the test)"],
};

const ORACLE_SHARED = {
  domain: "saas-web",
  identity: "Ingest",
  intent: "Ingest events reliably",
  principles: ["fast"],
  constraints: ["no data loss"],
  dimensions: [],
  personas: [],
  behaviors: [],
  baselineSha: "abc123",
};

function writerPrompt(specMode?: SpecMode): string {
  return writerPromptFor(inputWith(specMode), subtask, 0, "");
}

function checkerPrompt(specMode?: SpecMode): string {
  return buildCheckerPrompt({ ...ANSWERER_SHARED, ...(specMode !== undefined && { specMode }) });
}

function auditorPrompt(specMode?: SpecMode): string {
  return buildAuditorPrompt({ ...ANSWERER_SHARED, ...(specMode !== undefined && { specMode }) });
}

function oraclePrompt(specMode?: SpecMode): string {
  return buildDesignOraclePrompt({ ...ORACLE_SHARED, ...(specMode !== undefined && { specMode }) });
}

// Every mode-aware prompt builder, so the disjointness + additivity assertions run over
// the WHOLE surface rather than the writer alone.
const MODE_AWARE_PROMPTS: ReadonlyArray<{ role: string; build: (mode?: SpecMode) => string }> = [
  { role: "writer", build: writerPrompt },
  { role: "checker", build: checkerPrompt },
  { role: "auditor", build: auditorPrompt },
  { role: "designOracle", build: oraclePrompt },
];

describe("SpecMode — the modify_existing arm exists and is reachable", () => {
  // The enum is the contract every downstream decoder (the DB CHECK, the row schema, the
  // conflict-resolver's literal compare) mirrors. If this fails, nothing below is meaningful.
  it("SpecMode carries exactly the three authoring arms, and the default is UNCHANGED", () => {
    expect([...SpecMode.options].sort()).toEqual(["from_scratch", "modify_existing", "specialize_seed"]);
    expect(SpecMode.parse("modify_existing")).toBe("modify_existing");
    // The whole point of an ADDITIVE change: no existing project type moves.
    expect(DEFAULT_SPEC_MODE).toBe("from_scratch");
  });
});

describe("writerPromptFor — from_scratch REBUILDS, modify_existing AMENDS (the negative control)", () => {
  // POSITIVE control: the rebuild instruction is still there in `from_scratch`. Without
  // this the disjointness assertion below would pass vacuously (a prompt that lost the
  // phrase everywhere trivially satisfies "modify_existing does not contain it").
  it("from_scratch STILL carries the rebuild instruction verbatim", () => {
    const prompt = writerPrompt("from_scratch");
    for (const marker of REBUILD_MARKERS) {
      expect(prompt).toContain(marker);
    }
    expect(prompt).toContain(
      "Build everything ELSE — the manifest/lockfile, sources, configs, tests, fixtures — so that the",
    );
  });

  // THE FIX: in `modify_existing` the rebuild instruction is GONE and scoped-change
  // guidance is in its place.
  it("modify_existing carries NONE of the rebuild instruction", () => {
    const prompt = writerPrompt("modify_existing");
    for (const marker of REBUILD_MARKERS) {
      expect(prompt).not.toContain(marker);
    }
    // Nor the OTHER mode's framing — the three arms are mutually exclusive.
    expect(prompt).not.toContain("SPECIALIZE-SEED mode");
  });

  it("modify_existing carries scoped-change guidance instead", () => {
    const prompt = writerPrompt("modify_existing");
    for (const marker of SCOPED_CHANGE_MARKERS) {
      expect(prompt).toContain(marker);
    }
    // The repository is authoritative — its conventions outrank the writer's taste.
    expect(prompt).toContain("OUTRANK your own preferences");
    // Read-before-writing is stated as a concrete action, not a platitude: locate the
    // nearest existing implementation and follow it.
    expect(prompt).toContain("the code that already does the nearest thing to what this spec asks");
    expect(prompt).toContain("follow ITS");
    // The smallest-coherent-change rules, each stated explicitly.
    expect(prompt).toContain("do not refactor adjacent code");
    expect(prompt).toContain("do not reformat files you did not otherwise have to touch");
    expect(prompt).toContain("do not add or upgrade dependencies");
    expect(prompt).toContain("do not regenerate lockfiles, manifests");
    // Existing tests are a contract; new behavior needs new tests in the repo's idiom.
    expect(prompt).toContain("never a test to");
    expect(prompt).toContain("delete, skip, weaken, or rewrite to match");
    expect(prompt).toContain("repository's existing test idiom");
    // Scope is graded — an over-broad diff is a rejection, not a bonus.
    expect(prompt).toContain("is a rejection, not a bonus");
  });

  // The rebuild instruction and the scoped-change guidance never co-occur in ANY mode.
  // A prompt carrying both is the v64 contradiction class: the writer follows whichever
  // it read last and the checker rejects it for following the other.
  it("no mode ever emits BOTH the rebuild instruction and the scoped-change guidance", () => {
    for (const mode of SpecMode.options) {
      const prompt = writerPrompt(mode);
      const hasRebuild = REBUILD_MARKERS.some((marker) => prompt.includes(marker));
      const hasScoped = SCOPED_CHANGE_MARKERS.some((marker) => prompt.includes(marker));
      expect(hasRebuild && hasScoped, `mode ${mode} emitted a contradictory prompt`).toBe(false);
    }
  });

  // Same defensive placement doctrine as the other two modes: on a re-iteration the
  // concrete failing reason is the LAST thing the writer reads, so it outweighs the
  // standing instruction it would otherwise contradict.
  it("places the rework reason AFTER the modify-existing standing instructions on iter > 0", () => {
    const prompt = writerPromptFor(inputWith("modify_existing"), subtask, 1, "you reformatted 400 untouched files");
    const standingIndex = prompt.indexOf("MODIFY-EXISTING mode");
    const reworkIndex = prompt.indexOf("Previous attempt was rejected:");
    expect(standingIndex).toBeGreaterThan(0);
    expect(reworkIndex).toBeGreaterThan(standingIndex);
    expect(prompt).toContain("you reformatted 400 untouched files");
  });
});

describe("the immutability boundary is explicit and testable, not implicit in prose", () => {
  // The ABSOLUTE ban stays exactly Tanren's own two contract files, in EVERY mode. It is
  // deliberately NOT widened for brownfield: a blanket immutability list over lockfiles /
  // manifests / CI config would make legitimate specs ("add dependency X", "bump the CI
  // runner", "add a migration") structurally impossible, and an impossible instruction is
  // what produced the v40 violate → revert-everything → violate oscillation.
  it("IMMUTABLE_CONTRACT_FILES stays the two-entry ABSOLUTE ban, and every mode names it", () => {
    expect([...IMMUTABLE_CONTRACT_FILES]).toEqual(["justfile", ".tanren/ci.yml"]);
    for (const mode of SpecMode.options) {
      const prompt = writerPrompt(mode);
      expect(prompt).toContain("DECLARED CONTRACT files are FIXED");
      for (const file of IMMUTABLE_CONTRACT_FILES) {
        expect(prompt).toContain(file);
      }
    }
  });

  // The WIDER boundary is CONDITIONAL — the spec itself is the gate. Every category is
  // named verbatim in the modify_existing prompt (so the writer can act on it) and the
  // gating rule is stated in both directions.
  it("SPEC_GATED_REPO_SURFACES is a spec-gated boundary named verbatim in modify_existing", () => {
    const prompt = writerPrompt("modify_existing");
    for (const surface of SPEC_GATED_REPO_SURFACES) {
      expect(prompt).toContain(surface);
    }
    expect(prompt).toContain("ONLY when this spec's description or acceptance");
    expect(prompt).toContain("criteria explicitly require it");
    expect(prompt).toContain("leave them byte-for-byte unchanged");
    expect(prompt).toContain("change the minimum");
  });

  // …and it belongs to `modify_existing` ALONE. A greenfield prompt that started naming
  // spec-gated repo surfaces would be a silent behavior change to the existing modes.
  it("the spec-gated surfaces appear in NO other mode", () => {
    for (const mode of SpecMode.options.filter((option) => option !== "modify_existing")) {
      const prompt = writerPrompt(mode);
      for (const surface of SPEC_GATED_REPO_SURFACES) {
        expect(prompt, `mode ${mode} leaked a spec-gated surface`).not.toContain(surface);
      }
    }
  });
});

describe("checker / auditor / designOracle — mode-blind judging is what wedges merge", () => {
  // A mode-BLIND checker judging a scoped amendment emits "the project has no integration
  // tests" against a surface the writer was forbidden to touch; the only way the writer
  // can clear that finding is the over-broad rebuild the mode exists to prevent. So each
  // downstream answerer gets the matching arm.
  it.each([
    ["checker", checkerPrompt],
    ["auditor", auditorPrompt],
    ["designOracle", oraclePrompt],
  ])("%s emits the modify-existing scope block", (_role, build) => {
    const prompt = build("modify_existing");
    expect(prompt).toContain("MODIFY-EXISTING mode");
    expect(prompt).toContain("PRE-EXISTING and AUTHORITATIVE");
    expect(prompt).toContain("SCOPED AMENDMENT");
    expect(prompt).toContain("FALSE finding");
    expect(prompt).not.toContain("SPECIALIZE-SEED mode");
  });

  // The checker/auditor also gain the INVERSE duty the other modes don't need: in this
  // mode an over-broad diff is itself the defect, so they must report scope drift rather
  // than reward it.
  it.each([
    ["checker", checkerPrompt],
    ["auditor", auditorPrompt],
  ])("%s is told to police SCOPE DRIFT in modify_existing", (_role, build) => {
    const prompt = build("modify_existing");
    expect(prompt).toContain("SCOPE DRIFT");
    expect(prompt).toContain("an over-broad");
    expect(prompt).toContain("Do NOT cite PRE-EXISTING repository surfaces");
  });
});

describe("ADDITIVITY — the two pre-existing modes are byte-identical after the third arm", () => {
  // THE LOAD-BEARING ASSERTION. `modify_existing` is a NEW early return in each
  // dispatcher, so both pre-existing arms must return exactly what they returned before
  // it landed. Verified out-of-band against origin/main by rendering all four prompts in
  // both modes and comparing SHA-256; pinned here as the standing regression guard by
  // asserting neither pre-existing arm carries any modify-existing marker, and that
  // `from_scratch` remains byte-identical to the absent-mode legacy shape.
  it.each(MODE_AWARE_PROMPTS.map((entry) => [entry.role, entry.build] as const))(
    "%s: an absent specMode is byte-identical to an explicit from_scratch",
    (_role, build) => {
      // The no-argument call IS the absent-mode path (`specMode` omitted entirely).
      expect(build("from_scratch")).toBe(build());
    },
  );

  it.each(MODE_AWARE_PROMPTS.map((entry) => [entry.role, entry.build] as const))(
    "%s: neither pre-existing mode carries any modify-existing text",
    (_role, build) => {
      for (const mode of ["from_scratch", "specialize_seed"] as const) {
        const prompt = build(mode);
        for (const marker of SCOPED_CHANGE_MARKERS) {
          expect(prompt, `mode ${mode} leaked "${marker}"`).not.toContain(marker);
        }
      }
    },
  );

  // `specialize_seed` keeps its own arm intact — the third mode must not have been
  // grafted onto the seeded branch.
  it.each(MODE_AWARE_PROMPTS.map((entry) => [entry.role, entry.build] as const))(
    "%s: specialize_seed still renders its own seeded-mode text",
    (_role, build) => {
      expect(build("specialize_seed")).toContain("SPECIALIZE-SEED mode");
    },
  );

  // The three arms are pairwise DISTINCT for every role — no mode silently collapses onto
  // another, which is exactly what `modify_existing` did before this change existed
  // (it rendered byte-for-byte the `from_scratch` prompt via the fall-through default).
  it.each(MODE_AWARE_PROMPTS.map((entry) => [entry.role, entry.build] as const))(
    "%s: all three modes render pairwise-distinct prompts",
    (_role, build) => {
      const rendered = SpecMode.options.map((mode) => build(mode));
      expect(new Set(rendered).size).toBe(SpecMode.options.length);
    },
  );
});
