/**
 * plannerRunAdapters — the default production adapter/gate/usage-probe builders
 * for the planner loop. Extracted from plannerRun.ts to keep that file under the
 * 500-line architecture cap. These resolve the run's four role adapters from the
 * project's routing table (per-role provider DATA, not a code-level hardcode),
 * wire the lazily-resolved CI gate, and the codexbar + ccusage usage probe.
 */
import type { CiWhen } from "../ci/index.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import type { EventStore } from "../eventStore.js";
import type { ReviewAnswer } from "../answerers/schemas/index.js";
import {
  buildAdaptersFromRouting,
  buildSimulatedReviewerAdapter,
  buildSpecQualityValidator,
} from "../providers/adapterSelector.js";
import type { SpecQualityAnswerer } from "../forge/specQuality/index.js";
import type { AnswererAdapter } from "../providers/types.js";
import type { UsageProbe } from "../usage/index.js";
import { defaultUsageProbe } from "./plannerRunUsage.js";
// Re-exported so plannerRun.ts keeps a single import surface for the run's
// adapter/usage builders (the managed capturer lives in plannerRunUsage).
export { resolveManagedCapturer } from "./plannerRunUsage.js";
import type { BudgetGate } from "../contracts/dagWalker.js";
import { resolveBudgetGate } from "../dag/budgetGate.js";
import { runBudgetCeilingPreflight } from "./budgetPreflight.js";
import { assertAuditPostureReentersFindings } from "./auditPosturePreflight.js";
import { DEFAULT_AUDIT_POSTURE } from "../config/index.js";
import type { GateOutcome } from "./gate/index.js";
import { buildDefaultGate } from "./plannerRunGate.js";
// Re-exported so plannerRun.ts keeps a single import surface for the run's
// adapter/gate builders (the gate callback + JUnit ingest live in plannerRunGate).
export { buildDefaultGate } from "./plannerRunGate.js";
// Re-exported so plannerRun.ts keeps a single import surface for the run's
// input-shaping seams (the optional-property folders live in plannerRunSeams).
export {
  appTokenSeam,
  baseShiftRebaseSeam,
  designOracleSeam,
  issueLoopProvenanceSeam,
  loopConfigSeam,
  nativeQueueSeam,
  reGateGateReworkSeam,
  requireContextOrgId,
} from "./plannerRunSeams.js";
import type { PlannerRunAdapterContext, RunPlannerLoopInput } from "./plannerRun.js";
import type { AppendEvent, SubtaskLoopAdapters } from "./subtaskLoop.js";
import { buildDefaultConflictResolver } from "./reviewMerge/conflictResolver/index.js";
import { buildJjConflictApplier } from "./reviewMerge/conflictResolver/jjWorkspaceApplier.js";
import { buildLiveJjWorkspace } from "../providers/liveJjWorkspace.js";
import type { WorkspaceConflictApplier } from "../contracts/conflictResolution.js";
import type { ConflictResolverHook } from "./reviewMerge/index.js";
import { type EntityMapProduction, produceEntityChangeMap } from "../oracle/index.js";
// Builds the run's four role adapters (plan/write/check/audit) by resolving the
// project's effective routing table through the shared adapter selector. The
// routing is per-role provider DATA: the writer runs whatever the `write`
// chain's head names (codex/claude/opencode/...) and each answerer whatever its
// role chain names. Codex is the default ONLY because the default routing data
// (built in runExecutionContext) heads every chain with a Codex entry — there is
// no Codex hardcode here. A role whose chain is empty or names an
// unsupported/role-incapable provider is a HARD failure (EmptyRoutingChainError
// / UnsupportedProviderError from the selector) — never a silent Codex fallback.
//
// All four roles share one runId → one CODEX_HOME (codexHomeForRun) when they
// resolve to Codex, so ccusage at run end accounts for the whole run and
// codexbar reads the run's subscription account. The loop is sequential, so
// there is no concurrent write to a shared home.
export function defaultRoutingAdapters(input: RunPlannerLoopInput, ctx: PlannerRunAdapterContext): SubtaskLoopAdapters {
  const routing = input.context.routing;
  if (routing === undefined) {
    throw new Error("context.routing is required to build the run adapters from the project routing table");
  }
  return buildAdaptersFromRouting(
    {
      secrets: input.secrets,
      ssh: input.ssh,
      target: ctx.target,
      runId: ctx.runId,
      endpointBaseUrl: input.context.endpointBaseUrl,
    },
    routing,
  );
}

// Builds the simulated reviewer's Answerer (reviewPolicy: "simulated") from the
// project routing — the `audit` chain head, reusing the same adapter seam every
// Answerer uses (Codex by default). Only called when the review stage needs it.
export function defaultSimulatedReviewer(
  input: RunPlannerLoopInput,
  ctx: PlannerRunAdapterContext,
): AnswererAdapter<ReviewAnswer> {
  const routing = input.context.routing;
  if (routing === undefined) {
    throw new Error(
      "context.routing is required to build the simulated reviewer Answerer from the project routing table",
    );
  }
  return buildSimulatedReviewerAdapter(
    {
      secrets: input.secrets,
      ssh: input.ssh,
      target: ctx.target,
      runId: ctx.runId,
      endpointBaseUrl: input.context.endpointBaseUrl,
    },
    routing,
  );
}

// Builds the spec-quality VALIDATOR (workstream 1) from the project routing — the
// read-only judge over the loop's TRIAGE `kind: spec` items, riding the `audit` chain
// head like the simulated reviewer, so a triaged spec meets the SAME accomplishable/
// demo-able/non-trivial/legible bar as every spec-emitter before it materializes.
//
// LAZY: the underlying provider validator is resolved on the FIRST `.validate()` call,
// not at run setup. The loop's triage only validates when it routes a `kind: spec`
// item, so a run that never emits a new spec never needs it. This keeps the seam off
// the unconditional setup path (where a test injecting fake adapters has no routing),
// while production resolves the REAL validator (and fails loud if routing is genuinely
// absent) exactly when a spec is about to materialize.
export function defaultSpecQualityValidator(
  input: RunPlannerLoopInput,
  ctx: PlannerRunAdapterContext,
): SpecQualityAnswerer {
  let resolved: SpecQualityAnswerer | undefined;
  // Resolve-once, then DELEGATE every method. The prior wrapper exposed ONLY
  // `validate` and silently dropped `reAuthor` — so `resolveReviseSpec`
  // (specQuality/stage.ts) found no re-author callback and escalated at round 0
  // (never applying the guidance it produced). Delegating BOTH methods forwards
  // the underlying validator's built-in re-author; adding a method to the
  // `SpecQualityAnswerer` contract now surfaces here at the type level rather than
  // being silently lost. `reAuthor` stays optional-safe per the contract (a fake
  // validator may omit it), but production `buildSpecQualityValidator` always
  // provides it (via `wrapProviderSpecQualityAnswerer`).
  const ensure = (): SpecQualityAnswerer => {
    if (resolved === undefined) {
      const routing = input.context.routing;
      if (routing === undefined) {
        throw new Error(
          "context.routing is required to build the spec-quality validator from the project routing table",
        );
      }
      resolved = buildSpecQualityValidator(
        {
          secrets: input.secrets,
          ssh: input.ssh,
          target: ctx.target,
          runId: ctx.runId,
          endpointBaseUrl: input.context.endpointBaseUrl,
        },
        routing,
      );
    }
    return resolved;
  };
  return {
    validate: (spec) => ensure().validate(spec),
    reAuthor: (spec, guidance) => {
      const v = ensure();
      // Contract-optional, but production always provides it. Fail LOUD (not a
      // silent drop) if a validator without `reAuthor` ever reaches this lazy seam.
      if (v.reAuthor === undefined) {
        throw new Error("the resolved spec-quality validator does not provide a re-author capability");
      }
      return v.reAuthor(spec, guidance);
    },
  };
}

// The `pollReviewForRun` fields for reviewPolicy: "simulated". The reviewer
// factory is LAZY — invoked only on the simulated branch — so a human/auto run
// never resolves a reviewer adapter. The spec context the reviewer judges
// against is the run's own spec title/description/acceptance-criteria.
export function simulatedReviewSeam(
  input: RunPlannerLoopInput,
  ctx: PlannerRunAdapterContext,
): {
  simulatedReviewer: () => AnswererAdapter<ReviewAnswer>;
  simulatedReviewContext: {
    specTitle: string;
    specDescription: string;
    acceptanceCriteria: ReadonlyArray<string>;
  };
} {
  return {
    simulatedReviewer: () => (input.buildSimulatedReviewer ?? ((c) => defaultSimulatedReviewer(input, c)))(ctx),
    simulatedReviewContext: {
      specTitle: input.context.specTitle,
      specDescription: input.context.specDescription,
      acceptanceCriteria: input.context.acceptanceCriteria,
    },
  };
}

// Builds the PRODUCTION default intent-preserving conflict resolver (
// autonomy-engine.md §2b) — the real replacement for `noopConflictResolver` as
// the `resolveConflict` hook the merge stage calls on a detected conflict. It
// composes the run's already-resolved merge-stage context (the runner target +
// workspace, the gate/checker/auditor the loop built, the project routing, the
// run's spec intent, the diff base sha) into the resolver. Tests inject
// `input.resolveConflict` to skip the live runner/model; production omits it →
// this real resolver is the default (§8a: the default of an injectable seam is
// the REAL impl, never a stub).
export function resolveConflictResolverHook(
  input: RunPlannerLoopInput,
  deps: ConflictResolverDeps,
): ConflictResolverHook {
  // Test seam: a scripted resolver skips the live runner/model. Production omits
  // it → the real intent-preserving resolver is the default. The `??` lives HERE
  // (not in the workflow function) so the merge-stage call stays a single
  // expression and the workflow's branch count is unchanged.
  return input.resolveConflict ?? defaultConflictResolver(input, deps);
}

/** The runner/workspace + gate/answerer deps the conflict resolver assembles over. */
interface ConflictResolverDeps {
  eventStore: EventStore;
  target: RunnerHandle;
  workspacePath: string;
  baseSha: string;
  runGate: (gate: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
  checker: SubtaskLoopAdapters["checker"];
  auditor: SubtaskLoopAdapters["auditor"];
  // WS-A PR-4 (walker-jj-local-integration-design.md §4): the merge-time rebase base when
  // the run's base was jj-ASSEMBLED locally from the ancestor stack (non-empty) — the
  // LOCAL assembly bookmark, used INSTEAD of `${targetBranch}@origin`. Absent on the
  // legacy single-ref clone path (empty stack) ⇒ the conflict resolver keeps
  // `${targetBranch}@origin`.
  bootstrappedBaseRevision?: string;
}

function defaultConflictResolver(input: RunPlannerLoopInput, deps: ConflictResolverDeps): ConflictResolverHook {
  // LAZY construction: the real resolver (which needs the project routing to
  // resolve its conflict Answerer) is built only when a conflict ACTUALLY occurs
  // and the hook is invoked. So a run that merges cleanly never constructs it —
  // and `context.routing` (always present in production) is required only on the
  // conflict path, where a missing routing is a genuine misconfiguration to fail
  // loudly on, not a silent no-op.: read the run's percolation marker here so
  // a percolation re-execution's conflict is resolved in UPSTREAM-CHANGE mode.
  return async (conflictContext) => {
    const upstreamChange = await readPercolationUpstreamChange(input);
    // Provision a live jj workspace (A1's `buildLiveJjWorkspace`) and run the WHOLE
    // resolver — adapters + re-gate + applier — over that runner + path, so the re-gate
    // judges the jj-resolved tree. `rebaseOnto` RECORDS the conflict (fail-closed, no
    // `git merge --abort` / `|| true` fail-open). A clean run never reaches here, so no
    // jj runner is allocated for the common path.
    return resolveOverLiveJj(input, deps, upstreamChange, conflictContext);
  };
}

/**
 * Resolve an in-loop conflict over a freshly-provisioned live jj workspace. Mirrors the
 * drive-path jj resolve: build the live workspace, build the conflict adapters + re-gate
 * over its runner + path (so the re-gate runs against the jj-resolved tree), build the jj
 * applier, assemble the resolver, run it. The jj applier owns releasing the live
 * workspace on its terminal step; a failure BEFORE its gather() took ownership releases
 * the runner loudly here (never a leaked runner).
 */
async function resolveOverLiveJj(
  input: RunPlannerLoopInput,
  deps: ConflictResolverDeps,
  upstreamChange: { ancestorSpecId: string; changeSummary: string } | undefined,
  conflictContext: Parameters<ConflictResolverHook>[0],
): Promise<{ resolved: boolean }> {
  const context = input.context;
  const live = await buildLiveJjWorkspace({
    facts: {
      // `PlannerRunContext.orgId` is a REQUIRED non-empty string (hydration
      // enforces the tenant-scope invariant).
      orgId: context.orgId,
      projectId: context.projectId,
      repoUrl: context.repoUrl,
      runnerImage: context.runnerImage,
      ...(context.installation !== undefined && { installation: context.installation }),
      githubCredentialRef: context.githubCredentialRef,
      identitySecretRef: context.identitySecretRef,
    },
    allocator: input.allocator,
    ssh: input.ssh,
    secrets: input.secrets,
    githubHttp: input.githubHttp,
    ...(input.githubAppMinter !== undefined && { githubAppMinter: input.githubAppMinter }),
  });
  const applier = buildJjConflictApplier({
    live,
    ssh: input.ssh,
    secrets: input.secrets,
    githubHttp: input.githubHttp,
    ...(input.githubAppMinter !== undefined && { githubAppMinter: input.githubAppMinter }),
    facts: {
      orgId: context.orgId,
      repoUrl: context.repoUrl,
      baseBranch: context.targetBranch,
      // The merge-time base the PR head rebases onto (never-discard, conflict recorded).
      // WS-A PR-4: when the run's base was jj-assembled locally (non-empty stack)
      // the base is the LOCAL assembly bookmark `bootstrappedBaseRevision`, NOT the
      // freshly-cloned `${targetBranch}@origin` — the PR head rebases onto the re-assembled
      // stack head. (PR-6 makes the merge-time opener re-assemble that stack; PR-4 threads
      // the base name.) Absent ⇒ the legacy single-ref clone base, unchanged.
      baseRevision: deps.bootstrappedBaseRevision ?? `${context.targetBranch}@origin`,
      headBranch: context.runBranch,
      ...(context.installation !== undefined && { installation: context.installation }),
      githubCredentialRef: context.githubCredentialRef,
    },
  });
  try {
    // The adapters + re-gate run over the jj workspace's runner + path; the re-gate
    // baseline is the merge-time base branch (the resolved tree sits on it). ONLY the
    // workspace mechanism changed — the classify/re-gate/replan logic is identical.
    const jjAdapters = buildAdaptersFromRouting(
      {
        secrets: input.secrets,
        ssh: input.ssh,
        target: live.target,
        runId: context.runId,
        ...(context.endpointBaseUrl !== undefined && { endpointBaseUrl: context.endpointBaseUrl }),
      },
      requireRouting(context.routing),
    );
    const resolver = buildResolver(
      input,
      {
        eventStore: deps.eventStore,
        target: live.target,
        workspacePath: live.workspacePath,
        baseSha: context.targetBranch,
        runGate: buildDefaultGate(input, live.target, live.workspacePath, deps.eventStore),
        checker: jjAdapters.checker,
        auditor: jjAdapters.auditor,
      },
      upstreamChange,
      applier,
    );
    return await resolver(conflictContext);
  } catch (error) {
    // FAIL-CLOSED: a failure before the applier's gather() took workspace ownership
    // would leak the runner — release it loudly. (Once gather() runs, the applier's
    // terminal publish/abort owns release; releasing twice is a no-op there.)
    await live.release();
    throw error;
  }
}

function requireRouting(routing: RunPlannerLoopInput["context"]["routing"]): NonNullable<typeof routing> {
  if (routing === undefined) {
    throw new Error("context.routing is required to build the intent-preserving conflict resolver");
  }
  return routing;
}

/**
 * Read the run's in-flight percolation marker (`percolation_pending`). When set,
 * THIS run is a change-percolation re-execution absorbing an ancestor's change, so
 * the resolver runs in upstream-change mode (the ancestor's change flows INTO this
 * spec). Returns undefined for a normal (non-percolation) run.
 */
async function readPercolationUpstreamChange(
  input: RunPlannerLoopInput,
): Promise<{ ancestorSpecId: string; changeSummary: string } | undefined> {
  const result = await input.pool.query<{ percolation_pending: unknown }>(
    "SELECT percolation_pending FROM runs WHERE run_id = $1",
    [input.context.runId],
  );
  const marker = result.rows[0]?.percolation_pending;
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)) return undefined;
  const ancestorSpecId = (marker as Record<string, unknown>)["ancestorSpecId"];
  const toSha = (marker as Record<string, unknown>)["toSha"];
  if (typeof ancestorSpecId !== "string") return undefined;
  return {
    ancestorSpecId,
    changeSummary: `the upstream change from ${ancestorSpecId}${typeof toSha === "string" ? ` (head ${toSha})` : ""}`,
  };
}

function buildResolver(
  input: RunPlannerLoopInput,
  deps: ConflictResolverDeps,
  upstreamChange: { ancestorSpecId: string; changeSummary: string } | undefined,
  applier: WorkspaceConflictApplier,
): ConflictResolverHook {
  const context = input.context;
  const routing = requireRouting(context.routing);
  // `PlannerRunContext.orgId` is a REQUIRED non-empty string (hydration enforces
  // the tenant-scope invariant), so the conflict resolver's writes always carry
  // a real org id — no empty-sentinel fallback.
  const orgId = context.orgId;
  return buildDefaultConflictResolver({
    applier,
    pool: input.pool,
    runStateWriter: input.runStateWriter,
    eventStore: deps.eventStore,
    ssh: input.ssh,
    secrets: input.secrets,
    target: deps.target,
    workspacePath: deps.workspacePath,
    baseSha: deps.baseSha,
    runId: context.runId,
    projectId: context.projectId,
    orgId,
    specId: context.specId,
    specTitle: context.specTitle,
    specDescription: context.specDescription,
    acceptanceCriteria: context.acceptanceCriteria,
    // Task #86: thread the spec mode through so the re-gate's checker + auditor see
    // the seeded-mode tail block on `specialize_seed` specs.
    ...(context.specMode !== undefined && { specMode: context.specMode }),
    ...(context.endpointBaseUrl !== undefined && { endpointBaseUrl: context.endpointBaseUrl }),
    routing,
    checker: deps.checker,
    auditor: deps.auditor,
    runGate: deps.runGate,
    ...(upstreamChange !== undefined && { upstreamChange }),
  });
}

/**
 * Build the run's adapters + usage probe through the injectable factories, then run
 * the BUDGET-SAFETY ceiling preflight: a configured dollar ceiling that can never
 * FIRE (subscription/self-hosted, no probe) or can never be CLEARED (a per_token
 * route with no real-spend capture) fails the run closed at setup with a loud event.
 * The budget gate is the injectable `input.budgetGate` seam, defaulting to the
 * pg-backed PgBudgetGate over `input.pool` (tests inject a gate seam).
 */
export async function resolveRunAdaptersWithBudgetPreflight(
  input: RunPlannerLoopInput,
  ctx: PlannerRunAdapterContext,
  appendEvent: AppendEvent,
): Promise<{
  adapters: SubtaskLoopAdapters;
  usageProbe: UsageProbe | undefined;
  specValidator: SpecQualityAnswerer;
  // The resolved budget gate (audit §3.7a) — threaded into the loop for the PER-ITERATION
  // halt-on-ceiling, so it shares the SAME gate the preflight used (no second construction).
  budgetGate: BudgetGate;
}> {
  const adapters = (input.buildAdapters ?? ((c) => defaultRoutingAdapters(input, c)))(ctx);
  // WORKSTREAM 1 ↔ 2 SEAM — the spec-quality validator the loop's TRIAGE gates its
  // `kind: spec` items through. Resolved here (the same place the loop adapters are)
  // so it shares the run's routing/runner; tests override via `buildSpecValidator`.
  const specValidator = (input.buildSpecValidator ?? ((c) => defaultSpecQualityValidator(input, c)))(ctx);
  // The codex usage probe (ccusage + codexbar) is codex-specific. Build it when ANY
  // role adapter is codex (a mixed route still consumes the codex subscription) so
  // codex window pressure is always observed; a run with no codex role gets none.
  const usesCodex = [adapters.planner, adapters.writer, adapters.checker, adapters.auditor].some(
    (a) => a.cli === "codex",
  );
  const usageProbe = input.buildUsageProbe
    ? input.buildUsageProbe(ctx)
    : usesCodex
      ? defaultUsageProbe(input, ctx)
      : undefined;
  // Injected gate, else real pool via isPool (no cast). Tests inject; prod always has a pool.
  const budgetGate = resolveBudgetGate(input.pool, input.budgetGate);
  // Ceiling reachability is about the WRITER's credential: a subscription writer's
  // spend is observable only when a probe covers IT (writer is codex AND a codex
  // probe exists), so a non-codex subscription writer fails closed even if a codex
  // answerer wired a probe (that probe observes codex, not the writer's provider).
  const writerObservable = usageProbe !== undefined && adapters.writer.cli === "codex";
  await runBudgetCeilingPreflight(
    budgetGate,
    input.context.projectId,
    // Metering capability is a (cli × credential) ROUTE property — meterability.ts.
    adapters.writer.cli,
    adapters.writer.authRef,
    writerObservable,
    appendEvent,
  );
  // LOOP 3 — AUDIT-POSTURE PREFLIGHT. For an AUTONOMOUS run (the `lenient` tier —
  // functional-but-weak autonomous build, no operator in the loop), assert the
  // resolved `auditPosture` RE-ENTERS scheduled-audit findings into the DAG (residual
  // routes/fixes AND blocking findings become remediation specs). A posture that would
  // strand findings silently no-ops the audit→fix→merge proof, so the run FAILS CLOSED
  // at setup (a loud `audit.posture_strands_findings` event + a thrown error). A
  // non-autonomous run is a no-op (a parked blocking finding is its intended human-stop).
  await assertAuditPostureReentersFindings(
    {
      autonomous: input.context.governancePosture === "lenient",
      // The absent-posture default is the BALANCED posture; an autonomous run whose
      // project did not set `auditPosture: AUTONOMOUS_AUDIT_POSTURE` via the
      // governance API will FAIL THIS PREFLIGHT — that is the intended fail-closed bar.
      posture: input.context.auditPosture ?? DEFAULT_AUDIT_POSTURE,
    },
    appendEvent,
  );
  return { adapters, usageProbe, specValidator, budgetGate };
}

// §3.1 HOST-SIDE entity-risk producer builder. Binds the run's command substrate +
// runner handle + bootstrapped workspace into the `sem diff` producer the checker
// stage invokes per subtask (over the SAME `baselineSha` the agent self-inspects
// against). NATIVE deterministic signal — NOT prompt injection. The producer
// degrades to the graceful `unknown` signal (sem absent / errors / can't parse the
// stack) and is contracted never to throw.
export function buildEntityRiskProducer(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
): (baselineSha: string) => Promise<EntityMapProduction> {
  return (baselineSha) => produceEntityChangeMap({ ssh: input.ssh, target, workspacePath, baselineSha });
}
