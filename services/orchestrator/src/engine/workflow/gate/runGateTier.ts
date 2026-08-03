// in-loop deterministic gate-check stage. This is the automation half
// of the verification split: it runs a CI tier's shell steps over SSH in the
// bootstrapped runner workspace and judges pass/fail PURELY from exit codes.
// There is no Answerer / model here — correctness is exit codes only. The
// fast tier runs after each writer iteration; the slow tier runs before the
// audit. A failing tier short-circuits at the first nonzero step (later steps
// are pointless once the tree is known-broken) and routes the run to rework.
import type { CiStep, CiWhen } from "../../ci/index.js";
import { evidenceForStep } from "../../ci/index.js";
import type { RunnerHandle } from "../../contracts/allocator.js";
import type { CommandResult, CommandSubstrate } from "../../contracts/commandSubstrate.js";
import type { EventName, EventPayload } from "../../events/index.js";
import { withAppEnv } from "../../ssh/appEnvPrelude.js";
import { withMiseActivation } from "../../ssh/miseActivate.js";
import { buildActivityWatchdog } from "../../ssh/activityWatchdog.js";
import { type EvidenceVerdict, harvestStepEvidence } from "./harvestStepEvidence.js";
import type { JunitReport } from "../../ci/junit.js";

// Captured command output can be large; we keep only the last N characters so
// the emitted gate.* events and the typed result carry a useful, bounded
// diagnostic without bloating the events table. Matches the bootstrap step's
// tail bound for consistency.
const OUTPUT_TAIL_LIMIT = 4_000;

// One executed step's outcome, mirroring the gate.* event shape. `evidence` is the
// optional positive-proof verdict the gate harvested when the step declared an
// evidence contract (apex v57 task #64). Carried on BOTH pass and fail so the
// timeline records observed-vs-required counts even on a pass (visibility), and so a
// fail names the diagnosis precisely (the writer's iteration-1 directive).
export interface GateStepOutcome {
  name: string;
  run: string;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  outputTail: string;
  evidence?: EvidenceVerdict;
}

// Why a step failed (apex v57 task #64). `exit_code` is the historical case (process
// exited nonzero / timed out / substrate failed) — default for back-compat consumers.
// `evidence_insufficient` is the v57 green-by-accident class: exit was 0 but the
// declared evidence was missing/zero-tests/below-threshold. The discriminator lets
// the writer's rework directive steer precisely instead of guessing "the gate failed".
export type GateStepFailReason = "exit_code" | "evidence_insufficient";

// A typed pass/fail result for the whole tier. `failedStep` is populated only
// when `passed` is false (the first step that did not exit 0). `failedReason` +
// `evidence` discriminate the v57 evidence-insufficient class on the failure branch.
// `parsedJunitReports` is a SIDE CHANNEL (keyed by step name) of any JUnit XML the
// evidence harvester already read + parsed during this tier — exposed so the
// downstream per-test ingest reuses the parsed report instead of re-reading SSH.
// BACK-COMPAT: `failedReason` is OPTIONAL — synthesized failure callers (bootstrap /
// invalid-ci-config) omit it; the absent default is `"exit_code"`. New runtime gate
// failures populate it; downstream consumers tolerate undefined.
export type GateTierResult =
  | {
      passed: true;
      tier: string;
      when: CiWhen;
      steps: GateStepOutcome[];
      parsedJunitReports?: ReadonlyMap<string, JunitReport>;
    }
  | {
      passed: false;
      tier: string;
      when: CiWhen;
      failedStep: string;
      exitCode: number | null;
      failedReason?: GateStepFailReason;
      evidence?: EvidenceVerdict;
      steps: GateStepOutcome[];
      parsedJunitReports?: ReadonlyMap<string, JunitReport>;
    };

// The event-append seam, identical to the one runSubtaskLoop uses, so the gate
// emits through the same store.
export interface GateAppendEvent {
  <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void>;
}

export interface RunGateTierInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  tier: string;
  when: CiWhen;
  steps: ReadonlyArray<CiStep>;
  appendEvent: GateAppendEvent;
  // Correlates the gate.* events with the loop task that triggered them (the
  // writer task for per_iteration, the planner task for pre_audit).
  taskId?: string;
  // LENIENT POSTURE (advisory steps): step NAMES whose failure is ADVISORY — the
  // step still runs and its outcome is recorded (a `gate.advisory_failed` warning
  // event), but it does NOT short-circuit the tier or fail the gate. Empty (the
  // default, every non-lenient posture) ⇒ every step blocks, behavior unchanged.
  advisoryStepNames?: ReadonlySet<string>;
  // FLAKY-QUARANTINE ACTUATION (CI-intelligence): step NAMES on the project's
  // ACTIVE quarantine surface (`quarantined_tests`). A step in this set that fails
  // is EXCLUDED from the verdict (a `gate.quarantine_excluded` warning is emitted,
  // the tier keeps running, the gate stays passing for it) — this is what CLOSES
  // the flaky→quarantine→ship loop. SAFETY: a name lands here ONLY because the
  // detector PROVED the step toggled (passed AND failed) on UNCHANGED code; a
  // consistently-failing step is never quarantined, so a real regression is never
  // masked. Distinct from `advisoryStepNames` (posture-driven, lint/typecheck only)
  // — this is surface-driven and applies under EVERY posture. Empty ⇒ no exclusion.
  quarantinedStepNames?: ReadonlySet<string>;
  // Plane B: the PROJECT's dev+test app env, materialized into the
  // EXECUTED command's environment (the building agent's test/dev commands need
  // it). Prepended ONLY to the command handed to the substrate — the emitted
  // gate.* `step.run` stays the ORIGINAL command, so no secret value reaches the
  // events table. Distinct from Tanren's own provider creds. Undefined ⇒ no env.
  appEnv?: Record<string, string>;
}

// Runs every step of one tier in order, stopping at the first failure. Emits
// gate.started before the run and exactly one of gate.passed / gate.failed
// after. Never throws on a step failure — a nonzero exit is a normal gate
// result, returned as { passed: false }. Substrate failures and timeouts also
// count as a failed step (the tree could not be verified).
export async function runGateTier(input: RunGateTierInput): Promise<GateTierResult> {
  await input.appendEvent(
    "gate.started",
    { tier: input.tier, when: input.when, stepNames: input.steps.map((step) => step.name) },
    input.taskId,
  );

  const advisoryStepNames = input.advisoryStepNames ?? EMPTY_ADVISORY_SET;
  const quarantinedStepNames = input.quarantinedStepNames ?? EMPTY_ADVISORY_SET;
  const outcomes: GateStepOutcome[] = [];
  // Side-channel: the harvester's parsed JUnit reports, keyed by step name. Reused by
  // the downstream per-test ingest so it never re-reads the same file over SSH.
  const parsedJunitReports = new Map<string, JunitReport>();
  for (const step of input.steps) {
    const { outcome, exitCode, failReason, evidenceVerdict } = await executeStep(input, step, parsedJunitReports);
    outcomes.push(outcome);
    const passed = outcome.passed;
    // LENIENT POSTURE: an advisory step's failure is RECORDED but does NOT block.
    // We emit a `gate.advisory_failed` warning (so the timeline shows the real
    // lint/type issue) and continue running the rest of the tier — the gate stays
    // passing for this step. A genuinely-broken tree still blocks because build /
    // test are never advisory.
    if (!passed && advisoryStepNames.has(step.name)) {
      await input.appendEvent(
        "gate.advisory_failed",
        {
          tier: input.tier,
          when: input.when,
          advisoryStep: step.name,
          exitCode,
          outputTail: outcome.outputTail,
        },
        input.taskId,
      );
      continue;
    }
    // FLAKY-QUARANTINE: a proven-flaky step's failure is RECORDED but does NOT
    // block. We emit `gate.quarantine_excluded` (the timeline shows the excluded
    // flake) and keep running the tier — the gate stays passing for this step, so
    // the merge can go green while a root-cause spec is in flight. This CLOSES the
    // flaky→quarantine→ship loop. A consistently-failing step is never quarantined
    // (the detector only records a proven toggle), so a real regression still blocks.
    if (!passed && quarantinedStepNames.has(step.name)) {
      await input.appendEvent(
        "gate.quarantine_excluded",
        {
          tier: input.tier,
          when: input.when,
          quarantinedStep: step.name,
          exitCode,
          outputTail: outcome.outputTail,
        },
        input.taskId,
      );
      continue;
    }
    if (!passed) {
      const evidencePayload =
        evidenceVerdict !== undefined && !evidenceVerdict.sufficient ? evidenceVerdict : undefined;
      const failed: GateTierResult = {
        passed: false,
        tier: input.tier,
        when: input.when,
        failedStep: step.name,
        exitCode,
        failedReason: failReason,
        ...(evidencePayload === undefined ? {} : { evidence: evidencePayload }),
        steps: outcomes,
        ...(parsedJunitReports.size === 0 ? {} : { parsedJunitReports }),
      };
      await input.appendEvent(
        "gate.failed",
        {
          tier: input.tier,
          when: input.when,
          failedStep: step.name,
          exitCode,
          steps: outcomes,
          failedReason: failReason,
          ...(evidencePayload === undefined
            ? {}
            : {
                evidence: {
                  kind: evidencePayload.kind,
                  sufficient: false,
                  reason: evidencePayload.reason,
                  observed: evidencePayload.observed,
                  required: evidencePayload.required,
                },
              }),
        },
        input.taskId,
      );
      return failed;
    }
  }

  await input.appendEvent("gate.passed", { tier: input.tier, when: input.when, steps: outcomes }, input.taskId);
  return {
    passed: true,
    tier: input.tier,
    when: input.when,
    steps: outcomes,
    ...(parsedJunitReports.size === 0 ? {} : { parsedJunitReports }),
  };
}

// Shared empty advisory set so the strict (default) path allocates nothing.
const EMPTY_ADVISORY_SET: ReadonlySet<string> = new Set<string>();

interface StepExecution {
  outcome: GateStepOutcome;
  exitCode: number | null;
  failReason: GateStepFailReason;
  evidenceVerdict: EvidenceVerdict | undefined;
}

// Execute ONE step end-to-end: run the SSH command, harvest declared evidence on an
// exit-0, and build the outcome + fail-reason discriminator. Extracted from runGateTier
// to keep the orchestration loop under the architecture's cyclomatic-complexity cap.
//
// EVIDENCE GATE (apex v57 task #64): when the step declared an evidence contract (or
// its legacy `junitReport` promoted to one) AND the process exited 0, harvest POSITIVE
// proof BEFORE judging the step a pass. An exit-0 with insufficient evidence is the
// v57 green-by-accident class — the writer produced no real work but the process
// exited 0 (an empty `files` tsc, a vitest with zero tests, a playwright with no
// browsers). A nonzero exit is already a failure — no need to harvest. The QUARANTINE
// + ADVISORY bypasses (in the caller) are for known-broken/known-flaky steps; they do
// NOT skip evidence checks (a vacuous-success step is a different class).
async function executeStep(
  input: RunGateTierInput,
  step: CiStep,
  parsedJunitReports: Map<string, JunitReport>,
): Promise<StepExecution> {
  const evidenceContract = evidenceForStep(step);
  // OUTPUT RETENTION (F-9). A gate step is the single largest stream in the system — a
  // full `just ci` on a 12k-file monorepo emits hundreds of MB, and the orchestrator used
  // to hold every byte of it in one JS string per in-flight step. Its ONLY output consumer
  // is `tailOf(combinedOutput(result))`, a 4 000-char tail, so a head+tail retention loses
  // nothing it reads — WITH ONE EXCEPTION: a `stdout-count` evidence contract COUNTS regex
  // matches across the WHOLE stdout (`harvestStdoutCount`), and an elided middle would
  // undercount and fail a passing step as `evidence_insufficient`. So the step opts into
  // bounded retention only when its evidence contract does not read the whole stream.
  // (junit / artifact evidence is harvested by a SEPARATE `cat` over SSH, which keeps its
  // own full retention — the report is read back as a file, not from this stream.)
  const needsWholeStdout = evidenceContract?.kind === "stdout-count";
  const result = await input.ssh.run(input.target, {
    outputRetention: needsWholeStdout ? "full" : "bounded",
    // PROJECT-COMMAND path: mise-activate so a bare `node`/`pnpm`/etc in the project's
    // gate command resolves to its `mise.toml`-declared toolchain (a no-op when the
    // project declared none), THEN prepend the app-env prelude. Both are prepended to
    // the EXECUTED command only; the emitted `step.run` stays the original (no secret,
    // no prelude in events). PROJECT path — codex/answerers never run through here.
    command: withMiseActivation(withAppEnv(step.run, input.appEnv)),
    cwd: input.workspacePath,
    // VCS/build op (the project's gate step): output-driven + the workspace as the
    // silent-stretch liveness probe. NEVER killed for elapsed time — a long test suite
    // that keeps producing output/touching files runs unbounded.
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
  });
  const exitOk = result.failure === undefined && result.stalled !== true && result.exitCode === 0;
  let evidenceVerdict: EvidenceVerdict | undefined;
  if (exitOk && evidenceContract !== undefined) {
    const harvest = await harvestStepEvidence(
      { ssh: input.ssh, target: input.target, workspacePath: input.workspacePath },
      evidenceContract,
      result.stdout,
    );
    evidenceVerdict = harvest.verdict;
    if (harvest.parsedJunitReport !== undefined) {
      parsedJunitReports.set(step.name, harvest.parsedJunitReport);
    }
  }
  const evidenceOk = evidenceVerdict === undefined || evidenceVerdict.sufficient;
  const passed = exitOk && evidenceOk;
  const outcome: GateStepOutcome = {
    name: step.name,
    run: step.run,
    exitCode: result.exitCode,
    passed,
    // The gate-step domain field records "did not complete"; sourced from the
    // progress-based no-life flag (`stalled`).
    timedOut: result.stalled === true,
    outputTail: tailOf(combinedOutput(result)),
    ...(evidenceVerdict === undefined ? {} : { evidence: evidenceVerdict }),
  };
  // exit_code = the process exited nonzero / timed out / substrate failed (historical);
  // evidence_insufficient = exit was 0 but the declared positive proof was missing
  // (the green-by-accident class). The writer rework directive steers off this.
  const failReason: GateStepFailReason = exitOk && !evidenceOk ? "evidence_insufficient" : "exit_code";
  return { outcome, exitCode: result.exitCode, failReason, evidenceVerdict };
}

function combinedOutput(result: CommandResult): string {
  if (result.failure !== undefined) {
    const detail = "message" in result.failure ? result.failure.message : result.failure.reason;
    return [result.stdout, result.stderr, detail].filter((part) => part !== undefined && part !== "").join("\n");
  }
  return [result.stdout, result.stderr].filter((part) => part !== "").join("\n");
}

function tailOf(output: string): string {
  if (output.length <= OUTPUT_TAIL_LIMIT) {
    return output;
  }
  return output.slice(output.length - OUTPUT_TAIL_LIMIT);
}
