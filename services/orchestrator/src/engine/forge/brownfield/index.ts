// brownfield onboarding (full track) engine barrel.
//
// Recon (read-only Answerer) → config-injection PR → DAG seed → governance.
// Every seam is injectable/mockable; nothing here adds a migration.

export * from "./types.js";
export { wrapProviderReconAnswerer, type WrapProviderReconAnswererOptions } from "./providerReconAnswerer.js";
export { renderReconEvidence, RECON_PROMPT_MAX_CHARS } from "./prompt.js";
export { uncharacterizedAreas, type ReconArea } from "./reconAreas.js";
export { reconcileCitations, unresolvedTargets, type ReconciledReport } from "./reconCitations.js";
export { buildReconTurnPrompt } from "./explorationPrompt.js";
export { GithubRepoReader, ReconTreeTruncatedError, type GithubRepoReaderInput } from "./githubRepoReader.js";
export {
  exploreUntilConverged,
  ReconExplorationStalledError,
  type ExploreReconInput,
  type ExploreReconResult,
  type ReconExplorationTrace,
  type ReconExplorationTurn,
} from "./reconExploration.js";
export { runRecon, type ReconEngineDeps, type RunReconResult } from "./recon.js";
export {
  proposeConfigFiles,
  openConfigInjectionPr,
  ownedInjectionPaths,
  mergeFileContent,
  CONFIG_INJECTION_PATHS,
  type FileMergeStrategy,
  type ProposedFile,
  type ProposeFilesInput,
  type ConfigInjectionGitHub,
  type InjectedConfigPullRequest,
  type OpenConfigInjectionInput,
} from "./configInjection.js";
export { FetchConfigInjectionGitHub, type FetchConfigInjectionGitHubInput } from "./githubConfigInjection.js";
export {
  seedDagFromReconAndIssues,
  type SeedDagInput,
  type SeedDagResult,
  type SeededSpec,
  type SeedSource,
} from "./seed.js";
export {
  classifyWorkflowIntents,
  replacementFor,
  severityFor,
  BranchProtectionInput,
  WorkflowIntent,
  WorkflowIntentCategory,
  WorkflowIntentSource,
  NativeReplacementKind,
  DispositionSeverity,
  type ClassifyWorkflowIntentInput,
} from "./workflowIntent.js";
export {
  buildMigrationReport,
  DispositionStatus,
  MigrationDisposition,
  MigrationRiskReport,
  type BuildMigrationReportInput,
} from "./migrationReport.js";
