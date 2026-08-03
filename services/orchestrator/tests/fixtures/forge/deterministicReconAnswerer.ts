// the deterministic read-only recon Answerer fallback.
//
// Keeps the recon step LIVE without provider infra (same role the scripted
// interview answerer plays for greenfield). It does NOT call any model — it
// derives a plausible recon report from the repo index using cheap, observable
// signals (file paths, dependency manifests, the presence/absence of the
// integration files). Production wraps a provider read-only Answerer instead;
// tests inject a fake. All three implement the same `ReconTurnAnswerer` seam.
//
// It reports on its FIRST turn and never explores: with no model to reason with,
// there is nothing it could do with a file it asked for. That is a legitimate
// (degenerate) exploration — one turn, converged — not a special case in the loop.

import type {
  ReconArchitectureLine,
  ReconIndex,
  ReconReport,
  ReconRisk,
  ReconTurn,
  ReconTurnAnswerer,
  ReconTurnInput,
} from "../../../src/engine/forge/brownfield/types.js";

function slugFromRepoUrl(repoUrl: string): string {
  const tail = repoUrl
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "")
    .split("/")
    .pop();
  return tail !== undefined && tail !== "" ? tail : "linked-repo";
}

function hasFile(index: ReconIndex, suffix: string): boolean {
  return index.files.some((f) => f.path.toLowerCase().endsWith(suffix.toLowerCase()));
}

function hasPathContaining(index: ReconIndex, fragment: string): boolean {
  return index.files.some((f) => f.path.toLowerCase().includes(fragment.toLowerCase()));
}

function detectArchitecture(index: ReconIndex): ReconArchitectureLine[] {
  const lines: ReconArchitectureLine[] = [];
  if (hasFile(index, "package.json")) lines.push({ layer: "lang", detail: "node · typescript/javascript" });
  if (hasPathContaining(index, "next.config") || hasPathContaining(index, "/app/")) {
    lines.push({ layer: "web", detail: "next.js" });
  }
  if (hasFile(index, "prisma/schema.prisma")) lines.push({ layer: "data", detail: "postgres · prisma" });
  if (hasPathContaining(index, ".github/workflows/")) lines.push({ layer: "ci", detail: "github actions" });
  if (hasPathContaining(index, "vitest") || hasPathContaining(index, ".test.")) {
    lines.push({ layer: "tests", detail: "vitest" });
  }
  if (lines.length === 0) lines.push({ layer: "lang", detail: "unknown · inferred from layout" });
  return lines;
}

function detectRisks(index: ReconIndex): ReconRisk[] {
  const risks: ReconRisk[] = [];
  if (!hasFile(index, "codeowners")) {
    risks.push({
      severity: "warn",
      note: "no CODEOWNERS file — review-gate routing has no owners",
    });
  }
  if (!hasPathContaining(index, "tanren-ci")) {
    risks.push({
      severity: "warn",
      note: "no tanren-ci workflow — runs cannot gate on PR checks yet",
    });
  }
  return risks;
}

/**
 * Build the deterministic recon Answerer. The report is derived purely from the
 * repo index so it is reproducible and provider-free.
 */
export function createDeterministicReconAnswerer(): ReconTurnAnswerer {
  return {
    async turn(input: ReconTurnInput): Promise<ReconTurn> {
      return { status: "report", notes: "", requests: [], report: reportFor(input.index) };
    },
  };
}

/** The derived report itself — reproducible and provider-free. */
function reportFor(index: ReconIndex): ReconReport {
  const slug = slugFromRepoUrl(index.repoUrl);
  const architecture = detectArchitecture(index);
  const risks = detectRisks(index);
  return {
    identity: {
      slug,
      purpose: `linked repository ${slug} (recon-inferred)`,
      inferredFrom: index.files.some((f) => f.path.toLowerCase() === "readme.md")
        ? "README.md · package.json"
        : "repo layout",
    },
    personas: [
      {
        name: "developer · maintainer",
        description: "maintains the codebase and reviews changes",
        inferredFrom: "no other user roles found in code",
      },
    ],
    behaviors: [
      {
        persona: "developer · maintainer",
        title: "build & test the project",
        inferredFrom: "ci workflows",
      },
      {
        persona: "developer · maintainer",
        title: "review incoming changes",
        inferredFrom: "branch protection",
      },
    ],
    architecture,
    risks,
    gaps: [
      {
        id: "design-dna",
        chapter: "design dna",
        question: "The repo has no clear design system. Default to industrial (tanren-style) or import one?",
        options: ["use industrial", "import from url", "ask me later"],
      },
      {
        id: "test-coverage",
        chapter: "tests",
        question: "Test coverage looks thin. Should tanren's first specs include coverage work?",
        options: ["add coverage specs", "intentional · skip"],
      },
      {
        id: "external-pushes",
        chapter: "risks",
        question: "Contributors push directly to feature branches. Auto-spec their changes, or stay out of the way?",
        options: ["defer to governance"],
      },
    ],
  };
}
