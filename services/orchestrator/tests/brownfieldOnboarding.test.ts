// brownfield onboarding (full track) engine tests.
//
// Exercises the four engine pieces with MOCKED seams (no provider, no network):
//   - recon: a fake `RepoExplorer` + a mocked `ReconTurnAnswerer` pre-fill
//     chapters, plus the deterministic answerer derives chapters from the repo
//     index. (The EXPLORATION loop itself — reaching a file the entry-point budget
//     excludes, and terminating when nothing more is worth reading — is
//     `brownfieldReconReach.test.ts`, which drives the REAL reader.)
//   - config-injection: `proposeConfigFiles` builds the integration files (incl. the
//     stack-agnostic justfile skeleton when the repo ships none) + honors per-file
//     exclude; `openConfigInjectionPr` opens a PR through a fake `ConfigInjectionGitHub`
//     that records the committed files.
//   - seed-dag: recon gaps + GitHub issues become specs (created through the
//     existing `createSpec` path on an in-memory pool), de-duped.
//   - governance posture: the posture is a enum value persisted via the
//     project config (covered at the route layer; here we assert the policy
//     copy stays in lockstep with the posture).
//
// The pool is the same lightweight SQL-substring stub used by the greenfield
// vision-interview test. No migration is required.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  openConfigInjectionPr,
  proposeConfigFiles,
  runRecon,
  seedDagFromReconAndIssues,
  type ConfigInjectionGitHub,
  type InjectedConfigPullRequest,
  type ReconIndex,
  type ReconReport,
  type ReconTurnAnswerer,
  type RepoExplorer,
} from "../src/engine/forge/brownfield/index.js";
import { resolveCiConfig } from "../src/engine/ci/index.js";
import { createDeterministicReconAnswerer } from "./fixtures/forge/deterministicReconAnswerer.js";
import type { IngestedItem } from "../src/engine/forge/inbox/types.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

/** An explorer over a fixed index that has nothing further to offer. */
function fakeExplorer(index: ReconIndex): RepoExplorer {
  return {
    async index() {
      return index;
    },
    async explore(_repoUrl, request) {
      return { request, outcome: "not_found", body: "", total: 0, covered: 0 };
    },
  };
}

const SAMPLE_INDEX: ReconIndex = {
  repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
  filesIndexed: 3,
  files: [
    { path: "README.md", size: 100, preview: "# fixture" },
    { path: "package.json", size: 200, preview: "{}" },
    { path: ".github/workflows/ci.yml", size: 50, preview: "name: ci" },
  ],
};

const SAMPLE_REPORT: ReconReport = {
  identity: { slug: "tanren-fixture-easy", purpose: "smoke fixture", inferredFrom: "README.md" },
  personas: [{ name: "dev", description: "fixture operator", inferredFrom: "code" }],
  behaviors: [{ persona: "dev", title: "run the fixture", inferredFrom: "ci" }],
  architecture: [{ layer: "ci", detail: "github actions" }],
  risks: [{ severity: "warn", note: "no codeowners" }],
  gaps: [
    {
      id: "design-dna",
      chapter: "design dna",
      question: "default to industrial?",
      options: ["use industrial"],
    },
    { id: "coverage", chapter: "tests", question: "add coverage specs?", options: ["yes"] },
  ],
};

describe("runRecon · read-only recon pre-fills chapters", () => {
  it("uses a mocked answerer over the indexed repo", async () => {
    let sawIndex: ReconIndex | undefined;
    const answerer: ReconTurnAnswerer = {
      async turn(input) {
        sawIndex = input.index;
        return { status: "report", notes: "", requests: [], report: SAMPLE_REPORT };
      },
    };
    const { index, report, exploration } = await runRecon(
      { explorer: fakeExplorer(SAMPLE_INDEX), answerer },
      SAMPLE_INDEX.repoUrl,
    );
    expect(sawIndex?.filesIndexed).toBe(3);
    // Reported on its first turn: no exploration turns, nothing read.
    expect(exploration).toEqual({ turns: [], filesRead: 0, bytesRead: 0, endedBy: "reported" });
    expect(index.repoUrl).toBe(SAMPLE_INDEX.repoUrl);
    expect(report.identity.slug).toBe("tanren-fixture-easy");
    expect(report.gaps).toHaveLength(2);
  });

  it("deterministic answerer derives chapters + flags missing integration files", async () => {
    const { report } = await runRecon(
      { explorer: fakeExplorer(SAMPLE_INDEX), answerer: createDeterministicReconAnswerer() },
      SAMPLE_INDEX.repoUrl,
    );
    expect(report.identity.slug).toBe("tanren-fixture-easy");
    expect(report.architecture.length).toBeGreaterThan(0);
    // No CODEOWNERS / tanren-ci in the index → risks flagged.
    expect(report.risks.some((r) => r.note.toLowerCase().includes("codeowners"))).toBe(true);
    expect(report.gaps.length).toBeGreaterThanOrEqual(3);
  });

  it("deterministic answerer is what createDeterministicReconAnswerer returns", async () => {
    const answerer = createDeterministicReconAnswerer();
    const turn = await answerer.turn({ index: SAMPLE_INDEX, observations: [], notes: "", finalize: false });
    expect(turn.status).toBe("report");
    expect(turn.report?.personas.length).toBeGreaterThan(0);
  });
});

describe("config-injection · 6 files + per-file exclude + open PR", () => {
  const proposeInput = {
    repoSlug: "tanren-fixture-easy",
    orgLogin: "cat-cave",
    repoUrl: SAMPLE_INDEX.repoUrl,
    report: SAMPLE_REPORT,
    posture: "strict" as const,
    generatedAt: "2026-05-28T00:00:00.000Z",
  };

  it("proposes the 6 integration files (incl. the stack-agnostic justfile) when the repo ships none", () => {
    const files = proposeConfigFiles(proposeInput);
    expect(files).toHaveLength(6);
    expect(files[0]?.path).toBe(".tanren/PROJECT.md");
    expect(files[0]?.snapshot).toBe(true);
    // NATIVE delivery: the gate definition is `.tanren/ci.yml` (a CiConfigV1), NOT a
    // GitHub Actions workflow.
    expect(files.map((f) => f.path)).toContain(".tanren/ci.yml");
    expect(files.map((f) => f.path)).not.toContain(".github/workflows/tanren-ci.yml");
    // STACK-AGNOSTIC: the justfile (the project's lifecycle contract) is seeded so the
    // injected ci.yml's `just <target>` steps have something to defer to.
    expect(files.map((f) => f.path)).toContain("justfile");
    expect(files.map((f) => f.path)).toContain("CODEOWNERS");
    // The native merge queue drives merges — no `.mergify.yml` is injected.
    expect(files.map((f) => f.path)).not.toContain(".mergify.yml");
    // The snapshot mirrors the recon report.
    expect(files[0]?.content).toContain("tanren-fixture-easy");
    expect(files[0]?.content).toContain("smoke fixture");
  });

  it("omits the justfile when the repo already ships one (never clobbers the lifecycle)", () => {
    const files = proposeConfigFiles({ ...proposeInput, existingPaths: ["justfile"] });
    expect(files).toHaveLength(5);
    expect(files.map((f) => f.path)).not.toContain("justfile");
    // The ci.yml is still injected (Tanren's gate definition).
    expect(files.map((f) => f.path)).toContain(".tanren/ci.yml");
  });

  it("generalizes the guard: every skip-if-present file the repo owns is dropped", () => {
    const owned = ["justfile", "CODEOWNERS", ".github/PULL_REQUEST_TEMPLATE.md", ".tanren/ci.yml"];
    const files = proposeConfigFiles({ ...proposeInput, existingPaths: owned });
    for (const path of owned) {
      expect(files.map((f) => f.path)).not.toContain(path);
    }
    // `.gitignore` is ADDITIVE, so it is still proposed even though the repo has one —
    // the write seam appends the missing lines instead of replacing the file.
    const paths = files.map((f) => f.path);
    expect(proposeConfigFiles({ ...proposeInput, existingPaths: [...owned, ".gitignore"] }).map((f) => f.path)).toEqual(
      paths,
    );
    expect(paths).toEqual([".tanren/PROJECT.md", ".gitignore"]);
  });

  it("the injected justfile is a STACK-AGNOSTIC skeleton whose targets fail LOUDLY until filled", () => {
    const just = proposeConfigFiles(proposeInput).find((f) => f.path === "justfile");
    expect(just).toBeDefined();
    const body = just?.content ?? "";
    // The conventional lifecycle targets are present as stubs.
    for (const target of ["bootstrap:", "tier-1:", "tier-2:", "tier-3:", "build:", "deploy:"]) {
      expect(body).toContain(target);
    }
    // Every stub is LOUD (exit 1) — an unfilled target can never silently pass a gate.
    expect(body).toContain("exit 1");
    // The recipe BODIES name NO tech stack — the project fills in pnpm/cargo/… itself
    // (a leading comment may list example stacks as guidance — not an executed command).
    for (const recipe of body.split("\n").filter((l) => l.startsWith("\t"))) {
      expect(recipe).not.toMatch(/\bpnpm\b|\bnpm\b|\bcargo\b|\buv\b/u);
    }
  });

  it("the injected .tanren/ci.yml is a STACK-AGNOSTIC native CiConfigV1 gate (no Actions, no stack)", () => {
    const files = proposeConfigFiles(proposeInput);
    const ci = files.find((f) => f.path === ".tanren/ci.yml");
    expect(ci).toBeDefined();
    const yaml = ci?.content ?? "";
    // It is a CiConfigV1: versioned, with a bootstrap, tiers, and a `when` policy.
    expect(yaml).toContain("version: 1");
    expect(yaml).toContain("bootstrap:");
    expect(yaml).toMatch(/tiers:/u);
    // THREE tiers (the 3-tier CI requirement): fast/slow/merge.
    expect(yaml).toContain("fast:");
    expect(yaml).toContain("slow:");
    expect(yaml).toContain("merge:");
    // The `when` policy maps merge → pre_merge (the native gate is the merge authority).
    expect(yaml).toContain("pre_merge");
    // STACK-AGNOSTIC: every executable line defers to `just <target>` — NO pnpm/npm/corepack
    // in a `run:` (a leading comment may list example stacks as guidance).
    expect(yaml).toContain("just bootstrap");
    for (const run of yaml
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("run:"))) {
      expect(run).toMatch(/run: just /u);
      expect(run).not.toMatch(/pnpm|npm|corepack/u);
    }
    // It is NOT a GitHub Actions workflow and carries NO forge-CI / JUnit-upload plumbing.
    expect(yaml).not.toContain("runs-on:");
    expect(yaml).not.toContain("actions/checkout");
    expect(yaml).not.toContain("/webhooks/ci/junit");
    expect(yaml).not.toContain("x-hub-signature-256");
    // CRUCIAL: it resolves as a valid CiConfigV1 — the three tiers map 1:1 to the
    // three lifecycle points, and each tier defers to `just tier-N`.
    const config = resolveCiConfig(yaml);
    expect(config.version).toBe(1);
    expect(config.when.fast).toEqual(["per_iteration"]);
    expect(config.when.slow).toEqual(["pre_audit"]);
    expect(config.when.merge).toEqual(["pre_merge"]);
    expect((config.tiers.fast ?? []).map((s) => s.run)).toEqual(["just tier-1"]);
    expect((config.tiers.slow ?? []).map((s) => s.run)).toEqual(["just tier-2"]);
    expect((config.tiers.merge ?? []).map((s) => s.run)).toEqual(["just tier-3"]);
  });

  it("honors per-file exclude", () => {
    const files = proposeConfigFiles(proposeInput, [".tanren/ci.yml", "CODEOWNERS"]);
    // 6 proposed (incl. justfile) minus the 2 excluded = 4.
    expect(files).toHaveLength(4);
    expect(files.map((f) => f.path)).not.toContain(".tanren/ci.yml");
    expect(files.map((f) => f.path)).not.toContain("CODEOWNERS");
  });

  it("opens ONE PR through a mocked github with the kept files", async () => {
    const committed: string[] = [];
    const github: ConfigInjectionGitHub = {
      async openConfigInjectionPr(input): Promise<InjectedConfigPullRequest> {
        committed.push(...input.files.map((f) => f.path));
        expect(input.body).toContain("No runs happen until this PR is merged");
        return {
          number: 48,
          url: "https://github.com/cat-cave/tanren-fixture-easy/pull/48",
          branch: input.headBranch,
          filesCommitted: input.files.map((f) => f.path),
        };
      },
    };
    const files = proposeConfigFiles(proposeInput, [".gitignore"]);
    const pr = await openConfigInjectionPr({
      github,
      repoUrl: SAMPLE_INDEX.repoUrl,
      baseBranch: "main",
      files,
    });
    expect(pr.number).toBe(48);
    expect(pr.branch).toBe("tanren/integrate");
    expect(committed).toHaveLength(5);
    expect(committed).not.toContain(".gitignore");
  });

  it("rejects opening a PR when every file is excluded", async () => {
    const github: ConfigInjectionGitHub = {
      async openConfigInjectionPr(): Promise<InjectedConfigPullRequest> {
        throw new Error("should not be called");
      },
    };
    await expect(
      openConfigInjectionPr({
        github,
        repoUrl: SAMPLE_INDEX.repoUrl,
        baseBranch: "main",
        files: [],
      }),
    ).rejects.toThrow(/at least one file/u);
  });
});

describe("seed-dag · recon gaps + GitHub issues become specs", () => {
  it("creates one spec per issue + per gap, de-duped by title, through createSpec", async () => {
    const { pool, specs } = seedStubPool();
    const issues: IngestedItem[] = [
      {
        externalId: "gh-cat-cave/tanren-fixture-easy#142",
        title: "writer hangs on long writes",
        body: "bug",
        severity: "fail",
        projectId: "p",
      },
      {
        externalId: "gh-cat-cave/tanren-fixture-easy#138",
        title: "support claude as answerer",
        body: "",
        severity: "info",
        projectId: "p",
      },
    ];
    const result = await seedDagFromReconAndIssues(pool, {
      projectId: "p",
      orgId: "org_a",
      report: SAMPLE_REPORT,
      issues,
      actor,
    });
    expect(result.fromIssues).toBe(2);
    expect(result.fromGaps).toBe(2);
    expect(result.seeded).toHaveLength(4);
    expect(specs.size).toBe(4);
    // Each spec carries provenance for the source legend.
    expect(result.seeded.filter((s) => s.source === "github_issue")).toHaveLength(2);
    expect(result.seeded.filter((s) => s.source === "agent_gap")).toHaveLength(2);
  });

  it("drops a gap that duplicates an issue title", async () => {
    const { pool } = seedStubPool();
    const report: ReconReport = {
      ...SAMPLE_REPORT,
      gaps: [{ id: "dup", chapter: "x", question: "writer hangs on long writes", options: [] }],
    };
    const issues: IngestedItem[] = [
      {
        externalId: "gh#142",
        title: "writer hangs on long writes",
        body: "",
        severity: "fail",
        projectId: "p",
      },
    ];
    const result = await seedDagFromReconAndIssues(pool, {
      projectId: "p",
      orgId: "org_a",
      report,
      issues,
      actor,
    });
    expect(result.fromIssues).toBe(1);
    expect(result.fromGaps).toBe(0);
    expect(result.duplicatesDropped).toBe(1);
  });
});

// In-memory pool covering just the createSpec path (project existence +
// access + dependency check + insert), mirroring the vision-interview stub.
function seedStubPool(): { pool: pg.Pool; specs: Map<string, unknown> } {
  const specs = new Map<string, unknown>();
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("SELECT project_id FROM projects")) return { rows: [{ project_id: params[0] }], rowCount: 1 };
    if (sql.includes("FROM project_members")) return { rows: [{ role: "admin" }], rowCount: 1 };
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id")) {
      const ids = (params[1] as string[]) ?? [];
      const present = ids.filter((id) => specs.has(id)).map((id) => ({ spec_id: id }));
      return { rows: present, rowCount: present.length };
    }
    // v68 fix: createSpec now loads org_id off projects (NOT NULL).
    if (sql.startsWith("SELECT org_id FROM projects")) return { rows: [{ org_id: "org_test" }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO specs")) {
      specs.set(String(params[0]), { id: params[0] });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    pool: { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool,
    specs,
  };
}
