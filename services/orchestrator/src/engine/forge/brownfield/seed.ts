// the DAG-seed step. Turns the recon report's GAPS + the repo's open
// GitHub ISSUES into seed specs, created through the SAME `createSpec`
// path as every other spec (so authz + dependency checks are unchanged). The
// hi-fi shows a source legend (issue vs. gap) + dedupe — we carry each spec's
// `source` so the surface renders the legend, and we de-dupe by a normalized
// title so an issue and a gap describing the same work don't both seed.
//
// Issues are fetched through the existing `IngestedItem` shape (the
// inbox GitHub connector returns these); the engine accepts them as an injected
// list so it stays provider-free + trivially testable. No migration — specs
// land in the existing `specs` table.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import type { IngestedItem } from "../inbox/types.js";
import { createSpec } from "../../workflow/projectSpec.js";
import type { SpecMode } from "../../state/spec.js";
import type { ReconGap, ReconReport } from "./types.js";

export type SeedSource = "github_issue" | "agent_gap";

export interface SeededSpec {
  specId: string;
  title: string;
  source: SeedSource;
  /** The external id (issue ref) or gap id this spec came from. */
  origin: string;
}

export interface SeedDagInput {
  projectId: string;
  orgId: string;
  report: ReconReport;
  /** Open issues for the repo (`IngestedItem`s). May be empty. */
  issues: ReadonlyArray<IngestedItem>;
  actor: ActorContext;
}

export interface SeedDagResult {
  seeded: SeededSpec[];
  /** Count of items dropped as duplicates (issue ↔ gap title overlap). */
  duplicatesDropped: number;
  fromIssues: number;
  fromGaps: number;
}

// EVERY spec seeded by brownfield onboarding authors against a PRE-EXISTING,
// AUTHORITATIVE repository — the recon report and the GitHub issues are both about a
// tree somebody else already built and that is green today. So the seed path opts INTO
// `modify_existing` explicitly, here, rather than by flipping `DEFAULT_SPEC_MODE`: the
// default stays `from_scratch` so no existing project type moves, and brownfield-ness
// is a property of the CREATION path (mirroring how `scaffoldSpecsFor()` opts the
// greenfield foundation specs into `specialize_seed`). Without this, a brownfield spec
// would carry the default `from_scratch` mode whose standing writer instruction is
// "Build everything ELSE — the manifest/lockfile, sources, configs, tests, fixtures" —
// against a real repository, an instruction to rebuild it instead of amend it.
const BROWNFIELD_SEED_SPEC_MODE: SpecMode = "modify_existing";

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();
}

function gapSpecTitle(gap: ReconGap): string {
  // The gap question is the work to settle; keep it concise for the spec title.
  return gap.question.length > 120 ? `${gap.question.slice(0, 117)}...` : gap.question;
}

/**
 * Seed the DAG from recon gaps + GitHub issues. Issues seed first (they carry an
 * operator-authored title), then gaps that don't duplicate an issue title. Each
 * created spec carries its provenance so the surface can render the source
 * legend. NOTHING is force-routed — these are plain pending specs.
 */
export async function seedDagFromReconAndIssues(pool: pg.Pool, input: SeedDagInput): Promise<SeedDagResult> {
  const seeded: SeededSpec[] = [];
  const seenTitles = new Set<string>();
  let duplicatesDropped = 0;
  let fromIssues = 0;
  let fromGaps = 0;

  for (const issue of input.issues) {
    const key = normalizeTitle(issue.title);
    if (key === "" || seenTitles.has(key)) {
      duplicatesDropped += 1;
      continue;
    }
    seenTitles.add(key);
    const spec = await createSpec(
      pool,
      {
        projectId: input.projectId,
        title: issue.title,
        description: issue.body === "" ? `Seeded from GitHub issue ${issue.externalId}.` : issue.body,
        acceptanceCriteria: [`given ${issue.externalId}, when addressed, then the issue is resolved`],
        mode: BROWNFIELD_SEED_SPEC_MODE,
      },
      input.actor,
    );
    seeded.push({
      specId: spec.specId,
      title: issue.title,
      source: "github_issue",
      origin: issue.externalId,
    });
    fromIssues += 1;
  }

  for (const gap of input.report.gaps) {
    const title = gapSpecTitle(gap);
    const key = normalizeTitle(title);
    if (key === "" || seenTitles.has(key)) {
      duplicatesDropped += 1;
      continue;
    }
    seenTitles.add(key);
    const spec = await createSpec(
      pool,
      {
        projectId: input.projectId,
        title,
        description: `Recon gap (${gap.chapter}): ${gap.question}`,
        acceptanceCriteria: [`given the recon gap "${gap.id}", when resolved, then the chapter is complete`],
        mode: BROWNFIELD_SEED_SPEC_MODE,
      },
      input.actor,
    );
    seeded.push({ specId: spec.specId, title, source: "agent_gap", origin: gap.id });
    fromGaps += 1;
  }

  return { seeded, duplicatesDropped, fromIssues, fromGaps };
}
