// Scoped mutation run for the writer commit-gate recovery path.
//
// WHAT THIS MEASURES, STATED NARROWLY (#1420 review, P2). It mutates the two modules
// listed below and nothing else, so the only claim it supports is that the tests PIN THE
// CLASSIFICATION SEAM AND THE STEERING TEXT. It says nothing about the rest of the change:
// the adapter/result propagation (`writerGit.ts`, `codexGit.ts`, the six provider adapters)
// and the loop routing (`writerStage.ts`, `subtaskInnerLoop.ts`) are NOT mutated. Dropping
// `commitRejection` from a returned `WriterResult`, or routing `commit_rejected` through
// the success arm, would break recovery and leave this score unchanged. An earlier version
// of this comment named "the adapter reporting and the loop routing" as in scope. They
// were not, and the commit message's "100% on the two new modules" should be read as
// exactly that — two modules, not the feature.
//
// Those behaviors ARE covered — `writerCommitGateRecovery.test.ts` drives an end-to-end
// `runSubtaskLoop` re-drive, `writerCommitGateBoundaries.test.ts` drives real adapters for
// the negative controls, `writerCommitGateInjection.test.ts` asserts on the prompt the
// writer is handed — but "covered by tests" is a weaker statement than "mutation-pinned",
// and conflating the two is how a scope claim outruns its evidence. Widening the scope is
// the honest upgrade; it was left narrow because `coverageAnalysis: "all"` runs the whole
// ~9.7k-test suite against EVERY mutant, and `subtaskInnerLoop.ts` alone would multiply
// the run time well past what this fix can carry. Do it as a dedicated pass with its own
// ratchet, not as a rider.
const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  mutate: [
    "services/orchestrator/src/engine/providers/writerCommitGate.ts",
    "services/orchestrator/src/engine/workflow/commitGateSteering.ts",
  ],
  reporters: ["clear-text"],
  // RATCHETED FLOOR (#1420 review, P2). `break: 0` meant Stryker exited 0 even if every
  // mutant survived, so running this config could not establish the property above nor
  // catch a later test-strength regression — it was the one cluster with no floor and no
  // documented reason for it (`runloop` and `full` carry theirs in
  // docs/contracts/mutation-testing.md).
  //
  // Measured 97.67% — 84 killed, 2 survived, 86 mutants — with `commitGateSteering.ts` at
  // 100% (32/32) and `writerCommitGate.ts` at 96.30% (52/54). Floor set just below, the
  // same convention the other clusters use.
  //
  // The 2 survivors are both the `buildActivityWatchdog({ substrate, target, cls: "vcs",
  // workspace })` argument in `stageWorkspaceChanges` — the watchdog wiring is not
  // observable through the current test seam, so blanking the object or the `cls` string
  // is undetected. Worth recording that they are NOT pre-existing: `stageWorkspaceChanges`
  // arrived in 9d7b02f5 (the staging split) AFTER the "100% on the two new modules, 73
  // mutants" measurement in 691b380b, and nothing re-measured, so the module had quietly
  // been sitting at 96.30% under a claim of 100%. Exactly what a floor is for.
  thresholds: { high: 80, low: 60, break: 97 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-commit-gate",
  concurrency: 4,
  timeoutMS: 60000,
  dryRunTimeoutMinutes: 15,
};
export default config;
