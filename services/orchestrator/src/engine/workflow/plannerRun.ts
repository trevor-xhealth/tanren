// The real planner-loop run-trigger: drives runSubtaskLoop with real Codex
// adapters; on a passing loop publishes a draft PR, runs the native pre-merge
// gate, then drives review→merge. Non-pass outcomes map per-disposition:
// task #82's `window_exhausted` → pause_for_capacity (run → paused, spec
// stays in_flight, prober resumes); other non-pass → re-drive (run → halted).
import type pg from "pg";
import type { CiWhen } from "../ci/index.js";
import type {
  AuditPostureConfig,
  ConvergencePolicyConfig,
  GovernancePosture,
  MergeIntegration,
  RoutingChainEntry,
  RoutingTable,
} from "../config/shared.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { Allocator, ReleaseReason, RunnerHandle } from "../contracts/allocator.js";
import type { BudgetGate } from "../contracts/dagWalker.js";
import type { AncestorStack } from "../dag/ancestorStack.js";
import type { SpecMode } from "../state/spec.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { CostRecorder } from "../costs/index.js";
import { codexHomeForRun } from "../credentials/codexMaterializer.js";
import type { EventName, EventPayload } from "../events/index.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import type { ReviewAnswer } from "../answerers/schemas/index.js";
import type { SpecQualityAnswerer } from "../forge/specQuality/index.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { AnswererAdapter } from "../providers/types.js";
import type { UsageProbe } from "../usage/index.js";
import type { ContractFile } from "../forge/scaffold/index.js";
import { workspaceRepoPathForRun } from "../workspace/index.js";
import { buildReGateCi, type MergeGateRunContext, runPublishGateStage } from "./plannerRunCi.js";
import type { GateOutcome } from "./gate/index.js";
import {
  baseShiftRebaseSeam,
  buildDefaultGate,
  buildEntityRiskProducer,
  designOracleSeam,
  issueLoopProvenanceSeam,
  loopConfigSeam,
  nativeQueueSeam,
  reGateGateReworkSeam,
  requireContextOrgId,
  resolveConflictResolverHook,
  resolveManagedCapturer,
  resolveRunAdaptersWithBudgetPreflight,
  simulatedReviewSeam,
} from "./plannerRunAdapters.js";
import { prepareRunWorkspace, workspacePreparedPayload } from "./plannerRunWorkspace.js";
import type { BootstrapStepInput, CommitBootstrapStepInput } from "./plannerRunWorkspace.js";
import type { ProvisionMiseToolchainInput, ToolchainProvisionOutcome } from "../workspace/toolchainProvision.js";
import type {
  AncestorPhaseReader,
  BootstrapStackHeadShaWriteBack,
  EagerBaseNodeUpsert,
} from "./plannerRunJjLocalBootstrap.js";
import {
  applyScopedRunCredentials,
  buildFinalizeRunState,
  emitPrepBootstrapDeferred,
  finalizeMergeOutcome,
  finalizeNonPassOutcome,
  finalizeWorkflowThrow,
  markRunRunning,
  nonPassDetailFor,
  nonPassWindow,
  releaseRunnerWithCleanupProof,
  type RunCredentialScoping,
  runnerPayload,
  supersedeQueuedPlannerTask,
} from "./plannerRunFinalize.js";
import { dispatchReviewVerdict, type MergeGateBudget } from "./plannerRunSelfHeal.js";
import type { RedriveHistoryReader } from "./plannerRunRedrive.js";
import type { PublishedDraftPullRequest } from "./githubDraftPr.js";
import type { PlannerRejectionFeedback } from "./planner/planner.js";
import {
  type GateAttempt,
  mergeForRun,
  pollReviewForRun,
  type ConflictResolverHook,
  type MergeAuthorityBundle,
  type MergeForRunInput,
  type MergeForRunResult,
  type MergeProbe,
  type NativeQueueEnqueuer,
  type NativeQueueOnClientEnqueuer,
  type PollReviewForRunResult,
  type ReviewProbe,
} from "./reviewMerge/index.js";
import { runSubtaskLoop, type SubtaskLoopAdapters, type SubtaskLoopOutcome } from "./subtaskLoop.js";
import { materializeFreshTriageNewSpecs, type TriageNewSpecsMaterializer } from "./plannerRunTriageNewSpecs.js";
import type { PreMergeBehaviorGateProducer } from "../verification/preMerge/preMergeBehaviorGateProducer.js";

type RunStateClient = Pick<pg.Pool | pg.PoolClient, "query">;

// Codex H3 #11: `parked` → `abandoned` (prober resumes); `halt` → `failed`.
const REVIEW_EXIT_RELEASE_REASON: Record<"parked" | "halt", ReleaseReason> = {
  parked: "abandoned",
  halt: "failed",
};
export interface PlannerRunContext {
  runId: string;
  specId: string;
  projectId: string;
  /** IssueLoop lineage of the spec, when this run is executing an issue-origin fix. */
  issueLoopId?: string;
  // Tenant scope for allocator, RLS, and every event append.
  orgId: string;
  repoUrl: string;
  targetBranch: string;
  runBranch: string;
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: string[];
  behaviorIds?: string[];
  behaviorContext?: ReadonlyArray<{ id: string; title: string; description: string }>;
  // WS-D2: HEAD `DesignContract` rendered for the writer prompt (designWriterContext.ts).
  designContextBlock?: string;
  // Task #86 (v64 root cause): spec writer-prompt MODE; absent ⇒ `from_scratch`.
  specMode?: SpecMode;
  runnerImage: string;
  identitySecretRef: string;
  githubCredentialRef: string;
  // Part 2: org GitHub App installation — clone/push/PR/CI/merge mint App-first when set.
  installation?: OrgGithubAppInstallation;
  // Resolved DEFAULT LLM entry {cli, model, authRef} — heads every empty loop-role chain.
  defaultLlm?: RoutingChainEntry;
  // Effective per-role routing table (project over `defaultLlm`).
  routing?: RoutingTable;
  // SaaS Tier-B #5: MANAGED run's OpenAI-compatible endpoint override. Absent ⇒ BYOK.
  endpointBaseUrl?: string;
  // Governance posture — drives gate's advisory policy (`lenient` ⇒ lint/typecheck advisory).
  governancePosture?: GovernancePosture;
  /** apex v67/v69 loop-close: resolved merge integration; gates EARLY-PATH enqueue. */
  mergeIntegration?: MergeIntegration;
  // SPEC-LOOP REDESIGN: per-project audit posture + convergence policy.
  auditPosture?: AuditPostureConfig;
  convergencePolicy?: ConvergencePolicyConfig;
  // rv-premerge: OPT-IN pre-merge BEHAVIOR-gate knob (default OFF); gates the preview-deploy →
  // rv-11 → `pre_merge` verdict producer at the merge stage. Absent/false ⇒ no preview deploy.
  preMergeBehaviorGate?: boolean;
  // AUDIT-EVIDENCE BASELINE: governance policy version, stamped onto `gate.verdict` roll-up.
  policyVersion?: number;
  greenfield?: boolean;
  creditUsdRate?: number;
  // DETERMINISTIC CONTRACT FILES (v27 fix): workspace-prep materializes `.tanren/ci.yml` +
  // `justfile` VERBATIM (write-iff-absent) BEFORE writer — never LLM-authored.
  contractFiles?: ReadonlyArray<ContractFile>;
  // WS-A PR-4: ancestor stack for jj-local base assembly (from `runs.ancestor_stack`).
  ancestorStack?: AncestorStack;
}

export interface PlannerRunAdapterContext {
  runId: string;
  target: RunnerHandle;
  // Shared per-run CODEX_HOME (single ccusage read covers the run; codexbar pre-flight
  // reads the run's account).
  codexHome: string;
}

export interface RunPlannerLoopInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  // Cost recorder — in-process default over pool+eventStore; worker injects a writer-backed recorder for remote-writes.
  recorder?: CostRecorder;
  // Run terminal finalize — in-process org-scoped UPDATE default; worker injects a writer-backed finalizer for remote-writes.
  finalizeRun?: (input: { runId: string; status: string; outcome: string; fromStatuses: string[] }) => Promise<void>;
  // REQUIRED (audit D3/H3 sweep): atomic terminal seams ride through this writer.
  runStateWriter: RunStateWriter;
  allocator: Allocator;
  ssh: CommandSubstrate;
  onAllocationProgress?: () => void;
  secrets: SecretStore;
  // Dimension D — the per-run credential-scoping seam ({@link applyScopedRunCredentials}).
  credentialScoping?: RunCredentialScoping;
  /** The shared (timed) GitHub HTTP client the run/merge host seams build over. */
  githubHttp: GitHubHttpClient;
  // Part 2: the shared GitHub App installation-token minter (cache lives here), threaded into App-first clone-token resolution.
  githubAppMinter?: GithubAppTokenMinter;
  context: PlannerRunContext;
  workspacePath?: string;
  // Test seam: pre-resolved GitHub clone token; production resolves in prepareRunWorkspace.
  githubToken?: string;
  ciPollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  pressureThresholdPercent?: number;
  // Bootstrap install-command override over SSH; omitted ⇒ tanren-ci.yml `bootstrap.run` else `DEFAULT_BOOTSTRAP_COMMAND`.
  bootstrapCommand?: string;
  // Test seam: no-op / scripted failure for `bootstrapWorkspace` over SSH.
  runBootstrap?: (input: BootstrapStepInput) => Promise<void>;
  // Test seam: `mise trust && mise install` before bootstrap (env-management §3).
  // Production returns the provision outcome (what resolved, recorded on `workspace.prepared`);
  // a seam may return nothing, and the run then records no toolchain, as an undeclared repo does.
  provisionMise?: (input: ProvisionMiseToolchainInput) => Promise<ToolchainProvisionOutcome | void>;
  // Test seam: synthetic post-bootstrap commit (the writer's diff base).
  commitBootstrap?: (input: CommitBootstrapStepInput) => Promise<string>;
  // Test seam: gate for per_iteration (fast) + pre_audit (slow); default reads tanren-ci.yml.
  runGate?: (input: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
  // Test seams. Omitted in production → real Codex adapters + SSH usage probe.
  buildAdapters?: (ctx: PlannerRunAdapterContext) => SubtaskLoopAdapters;
  buildUsageProbe?: (ctx: PlannerRunAdapterContext) => UsageProbe | undefined;
  // WS1↔WS2 seam. Omitted → spec-quality validator from project routing; tests inject.
  buildSpecValidator?: (ctx: PlannerRunAdapterContext) => SpecQualityAnswerer;
  // BUDGET-SAFETY (M6) + §3.7a: shared preflight + per-iteration gate. Default PgBudgetGate.
  budgetGate?: BudgetGate;
  // reviewPolicy "simulated" seam — reviewer answerer resolved from project routing.
  buildSimulatedReviewer?: (ctx: PlannerRunAdapterContext) => AnswererAdapter<ReviewAnswer>;
  // review→merge tail seams — tests inject to avoid GitHub.
  reviewProbe?: ReviewProbe;
  mergeProbe?: MergeProbe;
  // TEST SEAM (§5h): `behind` rebase hook (production → `baseShiftRebaseSeam`).
  baseShiftRebase?: MergeForRunInput["baseShiftRebase"];
  // TEST SEAM: pre-built authority bundle (no-DB unit run); production builds it.
  mergeAuthority?: MergeAuthorityBundle;
  resolveConflict?: ConflictResolverHook;
  // TEST SEAM: auto-rebase re-gate gate-fail → writer-rework router.
  reGateGateRework?: MergeForRunInput["reGateGateRework"];
  // native_queue enqueue: on-client is PR #724's atomic 3-write block.
  nativeQueueEnqueuer?: NativeQueueEnqueuer;
  nativeQueueOnClientEnqueuer?: NativeQueueOnClientEnqueuer;
  // WS-A PR-8 (§2.3, fork F4): OBSERVE-ONLY jj-local `eager_base` integration node UPSERT
  // (proof-reuse substrate). NEVER gates the run.
  eagerBaseNodeUpsert?: EagerBaseNodeUpsert;
  /** WS-A PR-8c (§2.3): bootstrap → `runs.ancestor_stack[].headSha` write-back (divergence key). */
  bootstrapStackHeadShaWriteBack?: BootstrapStackHeadShaWriteBack;
  // §3 NEVER-DISCARD (apex v35): reads ancestor lifecycle buckets so a headless non-terminal
  // ancestor makes the dependent BENIGN-WAIT (never strand).
  ancestorPhaseReader?: AncestorPhaseReader;
  // apex v35 ROBUSTNESS: consecutive-same-failure reader — RE-DRIVE transient, ESCALATE K times.
  redriveHistoryReader?: RedriveHistoryReader;
  // Plane B: project dev+test app env for the runner (gate+bootstrap), NEVER logged, DISTINCT
  // from Tanren's own creds.
  appEnv?: Record<string, string>;
  // apex v79/v80 loop closure: MATERIALIZE the triage-emitted cross-scope work items as REAL
  // DAG specs so the "route out" decision lands on the DAG. Wired by `runExecutor.ts`; absent
  // on unit paths (the outcome's `newSpecs` is still observable, byte-identical to pre-fix).
  materializeTriageNewSpecs?: TriageNewSpecsMaterializer;
  // rv-premerge: OPT-IN pre-merge behavior-gate producer (runs only when the project's
  // `context.preMergeBehaviorGate` is true); absent / knob off ⇒ NO preview deploy (no-op).
  preMergeBehaviorProducer?: PreMergeBehaviorGateProducer;
}

export interface PlannerRunResult {
  runId: string;
  workspacePath: string;
  outcome: SubtaskLoopOutcome;
  pullRequest?: PublishedDraftPullRequest;
  // The native pre-merge gate verdict (the merge authority). Omitted when the run halted before the gate.
  mergeGate?: GateOutcome;
  // The review→merge tail. `review` carries the final review verdict and `merge` the
  // merge-stage outcome. Both omitted when the run halted before the gate or stopped
  // at changes-requested after exhausting the rework budget.
  review?: PollReviewForRunResult;
  merge?: MergeForRunResult;
  // SINGLE-FINALIZE INVARIANT (apex v35): set when a thrown run-error was RE-DRIVEN by the workflow's
  // own finalizer (run → halted, spec → open, `dag.spec.redriven`); the workflow then returns NORMALLY
  // instead of re-throwing into the worker's strand path (the #580 double-finalize).
  reDriven?: boolean;
}

export async function runPlannerLoopWorkflow(rawInput: RunPlannerLoopInput): Promise<PlannerRunResult> {
  const eventStore = rawInput.eventStore ?? new PgEventStore(rawInput.pool);
  const context = rawInput.context;
  const orgId = requireContextOrgId(context);
  const workspacePath = rawInput.workspacePath ?? workspaceRepoPathForRun(context.runId);
  const recorder = rawInput.recorder ?? new CostRecorder(rawInput.pool, eventStore);
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) =>
    eventStore.append({ ...context, orgId, taskId, eventType, payload });

  // Dimension D: de-privilege behind a per-run scoped Vault child token BEFORE any
  // credential read ({@link applyScopedRunCredentials}).
  const input = await applyScopedRunCredentials(rawInput, appendEvent);
  // Run terminal finalize — remote via control-plane, or byte-identical in-process.
  const finalizeRunState = buildFinalizeRunState(input, context.runId);

  // `running` + supersede route through the lifecycle writer when wired.
  await markRunRunning(input, context);
  await supersedeQueuedPlannerTask(input, context.runId);
  const allocation = await input.allocator.allocate({
    runId: context.runId,
    projectId: context.projectId,
    runnerImage: context.runnerImage,
    identitySecretRef: context.identitySecretRef,
    // Threaded so `runners` row is RLS-scoped. `PlannerRunContext.orgId` is a
    // REQUIRED non-empty string (hydration enforces the tenant-scope invariant),
    // so there is no null/undefined branch here.
    orgId: context.orgId,
    ...(input.onAllocationProgress === undefined ? {} : { onProgress: input.onAllocationProgress }),
  });
  await appendEvent("runner.allocated", runnerPayload(allocation));

  // The release reason handed to the RELEASE FINALIZER in `finally`; starts `abandoned` and
  // is promoted to completed/failed as the run resolves.
  let releaseReason: ReleaseReason = "abandoned";
  try {
    // Clone (single-ref OR — WS-A PR-4, flag-gated — the jj-local ancestor-stack bootstrap) +
    // bootstrap-install + commit + materialize contract files. `baseSha` = answerer review base;
    // `cloneHeadSha` = writer's replay base; `bootstrappedBaseRevision` set ONLY on jj-local.
    const prepared = await prepareRunWorkspace(input, allocation.target, workspacePath);
    const { cloneHeadSha, bootstrapSha, baseSha, bootstrappedBaseRevision, prepBootstrapDeferred, pushIdentity } =
      prepared;
    await appendEvent("workspace.prepared", workspacePreparedPayload(workspacePath, context, prepared));
    // SELF-HEAL (apex v35): emit `workspace.bootstrap_deferred` when prep's
    // `just bootstrap` deps-install was deferred to the gate self-heal.
    await emitPrepBootstrapDeferred(appendEvent, workspacePath, prepBootstrapDeferred);

    const adapterCtx: PlannerRunAdapterContext = {
      runId: context.runId,
      target: allocation.target,
      codexHome: codexHomeForRun(context.runId),
    };
    // Adapters + usage probe + spec-quality validator + BUDGET-SAFETY (M6) preflight.
    const adapterResult = await resolveRunAdaptersWithBudgetPreflight(input, adapterCtx, appendEvent);
    const { adapters, usageProbe, specValidator, budgetGate: iterationBudgetGate } = adapterResult;
    // MANAGED real-`usage.cost` capturer; BYOK has no platform metering ref (apex v30).
    const captureRealProviderCost = await resolveManagedCapturer(input, appendEvent);
    // The deterministic gate on the just-bootstrapped workspace (tanren-ci.yml or default).
    const runGate = input.runGate ?? buildDefaultGate(input, allocation.target, workspacePath, eventStore);
    // Native merge-gate context: the authority runs `runGate` at `pre_merge` + publishes `tanren/gate`.
    const mergeGateCtx: MergeGateRunContext = { runGate, target: allocation.target, workspacePath, eventStore };

    // write→gate→PR→CI→review tail: re-enters on changes_requested UNBOUNDED while feedback
    // KEEPS CHANGING; escalates at a FIXED POINT (shared `convergenceDetector`, NOT a count).
    const reviewReworkAttempts: GateAttempt[] = [];
    // SELF-HEAL (apex v35): pre_merge→writer self-heal state — UNBOUNDED while gate error
    // changes or count shrinks; halts at a fixed point (see `mergeGateSelfHeal`).
    const mergeGateBudget: MergeGateBudget = { used: 0, attempts: [] };
    const seedRejections: PlannerRejectionFeedback[] = [];
    // apex v79/v80 loop closure: track which triage-emitted new-spec ids we already
    // materialized so a rework/re-plan iteration is idempotent (same items may recur).
    const materializedNewSpecIds = new Set<string>();
    const entityRiskProducer = buildEntityRiskProducer(input, allocation.target, workspacePath);
    let outcome: SubtaskLoopOutcome | undefined, pullRequest: PublishedDraftPullRequest | undefined;
    let mergeGate: GateOutcome | undefined, review: PollReviewForRunResult | undefined;

    // UNBOUNDED re-entry: each iteration re-authors then re-gates/re-reviews, continuing while
    // it CONVERGES (gate error / review feedback keeps changing) and exiting only on a terminal
    // outcome (merge / fixed-point halt / non-pass re-drive) — never a hardcoded rework count.
    for (;;) {
      outcome = await runSubtaskLoop({
        pool: input.pool,
        eventStore,
        runStateWriter: input.runStateWriter,
        recorder,
        adapters,
        context: {
          specTitle: context.specTitle,
          specDescription: context.specDescription,
          acceptanceCriteria: context.acceptanceCriteria,
          behaviorIds: context.behaviorIds ?? [],
          behaviorContext: context.behaviorContext ?? [],
          runId: context.runId,
          specId: context.specId,
          projectId: context.projectId,
          orgId,
          ...issueLoopProvenanceSeam(context),
          workspacePath,
          baseSha,
          ...(context.designContextBlock !== undefined && { designContextBlock: context.designContextBlock }),
          ...(context.specMode !== undefined && { specMode: context.specMode }),
        },
        usageProbe,
        budgetGate: iterationBudgetGate,
        runGate,
        entityRiskProducer,
        seedRejections: [...seedRejections],
        ...(captureRealProviderCost !== undefined && { captureRealProviderCost }),
        ...designOracleSeam(context),
        ...loopConfigSeam(context, specValidator),
      });

      if (outcome.kind !== "passed") {
        // task #82: window_exhausted → pause_for_capacity (snapshot rides run.paused); other non-pass → re-drive.
        await finalizeNonPassOutcome(
          input,
          finalizeRunState,
          context,
          appendEvent,
          nonPassDetailFor(outcome),
          nonPassWindow(outcome),
        );
        releaseReason = "failed";
        return { runId: context.runId, workspacePath, outcome };
      }

      // apex v79/v80 loop closure: materialize the fresh triage-emitted `kind: spec`
      // items as REAL DAG specs so triage's "route out" decision actually lands.
      await materializeFreshTriageNewSpecs(input.materializeTriageNewSpecs, outcome, materializedNewSpecIds, {
        runId: context.runId,
        parentSpecId: context.specId,
        projectId: context.projectId,
        orgId,
        ...issueLoopProvenanceSeam(context),
      });

      // Publish the cleaned draft PR + run the merge-authority `pre_merge` gate
      // (`runPublishGateStage`): `rework`/`halt`/`merged`/`converged_empty` (v35).
      const stage = await runPublishGateStage(input, mergeGateCtx, context, {
        cloneHeadSha,
        bootstrapSha,
        ...(pushIdentity !== undefined && { pushIdentity }),
        finalizeRunState,
        appendEvent,
        seedRejections,
        budget: mergeGateBudget,
      });
      if (stage.kind === "converged_empty") {
        releaseReason = "completed";
        return { runId: context.runId, workspacePath, outcome };
      }
      pullRequest = stage.pullRequest;
      mergeGate = stage.mergeGate;
      if (stage.kind === "rework") continue;
      if (stage.kind === "halt") {
        releaseReason = "failed";
        return { runId: context.runId, workspacePath, outcome, pullRequest, mergeGate };
      }

      review = await pollReviewForRun({
        pool: input.pool,
        eventStore,
        runStateWriter: input.runStateWriter,
        secrets: input.secrets,
        githubHttp: input.githubHttp,
        runId: context.runId,
        // Same token ref as PR-creation + CI-poll (project record → org default).
        resolvedGithubCredentialRef: context.githubCredentialRef,
        // The review stage awaits its verdict INDEFINITELY (no poll cap); the poll
        // SPACING reuses the CI poll cadence (an interval, not a budget).
        pollDelayMs: input.ciPollDelayMs,
        sleep: input.sleep,
        reviewProbe: input.reviewProbe,
        // reviewPolicy "simulated": the lazy reviewer-Answerer + the spec it judges.
        ...simulatedReviewSeam(input, adapterCtx),
      });

      // Codex H3 #11: `dispatchReviewVerdict` short-circuits `parked`; the
      // awaiting-review prober owns the resume. Release lookup keeps complexity ratcheted.
      const reviewMove = await dispatchReviewVerdict(
        input,
        finalizeRunState,
        context,
        appendEvent,
        pullRequest,
        review,
        seedRejections,
        reviewReworkAttempts,
      );
      if (reviewMove === "merge") break;
      if (reviewMove === "rework") continue;
      releaseReason = REVIEW_EXIT_RELEASE_REASON[reviewMove];
      return { runId: context.runId, workspacePath, outcome, pullRequest, mergeGate, review };
    }

    const merge = await mergeForRun({
      pool: input.pool,
      eventStore,
      runStateWriter: input.runStateWriter,
      secrets: input.secrets,
      githubHttp: input.githubHttp,
      runId: context.runId,
      // Same source as PR-creation + CI-poll (project record → org default).
      resolvedGithubCredentialRef: context.githubCredentialRef,
      mergeProbe: input.mergeProbe,
      ...(input.mergeAuthority !== undefined && { mergeAuthority: input.mergeAuthority }),
      resolveConflict: resolveConflictResolverHook(input, {
        eventStore,
        target: allocation.target,
        workspacePath,
        baseSha,
        runGate,
        checker: adapters.checker,
        auditor: adapters.auditor,
        // WS-A PR-4: the jj-local-assembled base → the resolver's merge-time base.
        ...(bootstrappedBaseRevision !== undefined && { bootstrappedBaseRevision }),
      }),
      // After an auto-rebase the prior verdict is stale → re-run the native `pre_merge` gate.
      reGateCi: buildReGateCi(input, mergeGateCtx),
      ...reGateGateReworkSeam(input, { prNumber: pullRequest.prNumber }),
      // THE ONE BASE-SHIFT HANDLER (§7 / §5h): the unified jj rebase, no server update-branch.
      baseShiftRebase: baseShiftRebaseSeam(context, input),
      ...nativeQueueSeam(input),
    });

    await finalizeMergeOutcome(input, finalizeRunState, context, appendEvent, merge);
    releaseReason = "completed";
    return { runId: context.runId, workspacePath, outcome, pullRequest, mergeGate, review, merge };
  } catch (error) {
    releaseReason = "failed";
    return await finalizeWorkflowThrow(error, { finalizeRunState, appendEvent, workspacePath, input, context });
  } finally {
    // SECURITY-BASELINE CLEANUP-PROOF: sandbox teardown + release via finalizer + release.finalized event (~204 GB leak fix).
    const runWorkspace = { ssh: input.ssh, target: allocation.target, runId: context.runId };
    await releaseRunnerWithCleanupProof(input.allocator, allocation.runnerId, appendEvent, runWorkspace, releaseReason);
  }
}
