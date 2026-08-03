// the read-only recon engine. Composes the injectable `RepoExplorer`
// (indexes AND navigates the linked repo READ-ONLY) with the `ReconTurnAnswerer`
// (reconstructs the chapters + gaps from the evidence it asks for).
//
// The index is now the ENTRY POINT, not the whole picture: `exploreUntilConverged`
// drives the answerer turn by turn, fetching whatever it names, until it converges
// on a report. The exploration TRACE comes back with the report so the cost of a
// recon (turns, files read, bytes) is observable rather than implicit — an
// unbounded loop that silently spends would be worse than the cap it replaced.
//
// NOTHING is persisted here — the recon report is transient (carried on the
// request, like the greenfield capture). The downstream steps (config-injection
// PR, DAG seed) consume the report the operator confirmed.

import { exploreUntilConverged, type ReconExplorationTrace } from "./reconExploration.js";
import { ReconReport, type ReconIndex, type ReconTurnAnswerer, type RepoExplorer } from "./types.js";

export interface ReconEngineDeps {
  // Indexes AND navigates the repo. Required — production wires the GitHub
  // reader, tests a fake.
  explorer: RepoExplorer;
  // The recon Answerer — REQUIRED. Production resolves a real provider answerer
  // from the project's `forge` routing (the model RECONSTRUCTS the chapters from
  // the evidence it explores); tests inject a fake. There is NO production
  // fallback to a deterministic report (§8a).
  answerer: ReconTurnAnswerer;
}

export interface RunReconResult {
  index: ReconIndex;
  report: ReconReport;
  exploration: ReconExplorationTrace;
}

/**
 * Run a read-only recon pass: index the repo, then let the Answerer explore it
 * until it converges on the chapters + gaps. The report is validated at the
 * engine boundary (defence in depth; a provider that drifts from the schema is
 * normalized/rejected).
 */
export async function runRecon(deps: ReconEngineDeps, repoUrl: string): Promise<RunReconResult> {
  const index = await deps.explorer.index(repoUrl);
  const { report, exploration } = await exploreUntilConverged({
    explorer: deps.explorer,
    answerer: deps.answerer,
    index,
    repoUrl,
  });
  return { index, report: ReconReport.parse(report), exploration };
}
