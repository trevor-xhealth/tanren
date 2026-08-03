import { describe, expect, it } from "vitest";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import type { CostRecorder } from "../src/engine/costs/index.js";
import type { PlanSubtask } from "../src/engine/answerers/schemas/index.js";
import {
  runAuditorStage,
  runCheckerStage,
  runPlannerStage,
  runWriterStage,
} from "../src/engine/workflow/subtaskStages.js";
import type { SubtaskCostContext } from "../src/engine/workflow/subtaskCost.js";
import {
  buildPlan,
  cleanAudit,
  completeCheck,
  incompleteCheck,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  p1Audit,
} from "./helpers/plannerLoopHelpers.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

// subtaskStages.ts owns the per-call event timeline + task-row transitions for each
// planner/writer/checker/auditor invocation. These tests pin the emitted event
// names, task kinds, payload values, and the outcome branch.

interface RecordedEvent {
  eventType: EventName;
  payload: Record<string, unknown>;
  taskId: string | undefined;
}

interface RecordedTask {
  taskId: string;
  kind: string;
  title: string;
  parentTaskId: string | null;
  agentKind: string;
  cli: string;
  model: string | null;
}

interface RecordedCost {
  taskId: string;
  model: string;
  role: string | undefined;
  cli: string;
  authRef: string;
  runtimeSeconds: number;
  tokenUsage: Record<string, unknown>;
  rawUsage: Record<string, unknown>;
}

// Audit finding H3 sweep: stage helpers REQUIRE a writer; the harness derives
// `tasks` / `taskOutcomes` from the writer's atomic row state.
class StageHarness {
  readonly events: RecordedEvent[] = [];
  readonly costRecords: RecordedCost[] = [];
  readonly writer = new InMemoryRunStateWriter({
    forwardAppend: async (input) => {
      this.events.push({
        eventType: input.eventType as EventName,
        payload: input.payload as Record<string, unknown>,
        taskId: input.taskId,
      });
    },
  });
  get tasks(): RecordedTask[] {
    return this.writer.inserts.map((i) => ({
      taskId: i.taskId,
      kind: i.kind,
      title: i.title,
      parentTaskId: i.parentTaskId ?? null,
      agentKind: i.agentKind,
      cli: i.cli,
      model: i.model,
    }));
  }
  get taskOutcomes(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [taskId, row] of this.writer.tasks.entries()) {
      if (row.outcome !== null) map.set(taskId, row.outcome);
    }
    return map;
  }

  appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void> => {
    this.events.push({ eventType, payload: payload as Record<string, unknown>, taskId });
  };

  // pg-shaped query stub — task INSERTs/UPDATEs route through the writer (audit H3
  // sweep) and surface on `this.tasks`; this no-op absorbs any incidental SQL.
  query = async (_sql: string, _params: ReadonlyArray<unknown> = []): Promise<{ rows: never[]; rowCount: number }> => {
    return { rows: [], rowCount: 1 };
  };

  costCtx(): SubtaskCostContext {
    const recorder = {
      record: async (
        context: { taskId: string; model: string; role?: string; cli: string; authRef: string; runtimeSeconds: number },
        tokenUsage: Record<string, unknown>,
        rawUsage: Record<string, unknown>,
      ) => {
        this.costRecords.push({
          taskId: context.taskId,
          model: context.model,
          role: context.role,
          cli: context.cli,
          authRef: context.authRef,
          runtimeSeconds: context.runtimeSeconds,
          tokenUsage,
          rawUsage,
        });
        return undefined as never;
      },
    } as unknown as CostRecorder;
    return { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1", orgId: "org_1" };
  }

  task(taskId: string): RecordedTask {
    const found = this.tasks.find((t) => t.taskId === taskId);
    if (found === undefined) throw new Error(`no task inserted for ${taskId}`);
    return found;
  }

  cost(taskId: string): RecordedCost {
    const found = this.costRecords.find((c) => c.taskId === taskId);
    if (found === undefined) throw new Error(`no cost recorded for ${taskId}`);
    return found;
  }

  names(): EventName[] {
    return this.events.map((event) => event.eventType);
  }

  find(eventType: EventName): RecordedEvent | undefined {
    return this.events.find((event) => event.eventType === eventType);
  }
}

const subtask: PlanSubtask = {
  index: 0,
  title: "Wire behavior B1",
  intent: "touch the README",
  behaviorIds: ["B1", "B2"],
  estimatedTokens: null,
};

describe("runPlannerStage", () => {
  it("emits planner.subtasks.emitted with the plan subtasks + rationale and records planner cost", async () => {
    const h = new StageHarness();
    const plan = buildPlan([{ title: "Wire behavior B1", intent: "touch the README", behaviorIds: ["B1", "B2"] }]);
    const result = await runPlannerStage({
      pool: { query: h.query },
      writer: h.writer,
      costCtx: h.costCtx(),
      adapter: makePlanner([plan]),
      spec: { specTitle: "S", specDescription: "D", acceptanceCriteria: ["AC1"], behaviorIds: [], behaviorContext: [] },
      runId: "run_1",
      workspacePath: "/ws",
      plannerTaskId: "task_plan",
      appendEvent: h.appendEvent,
      attempt: 2,
      rejectionHistory: [],
      timeoutMs: 1000,
    });

    expect(result).toBe(plan);
    const emitted = h.find("planner.subtasks.emitted");
    expect(emitted).toBeDefined();
    expect(emitted!.taskId).toBe("task_plan");
    expect(emitted!.payload.runId).toBe("run_1");
    expect(emitted!.payload.rationale).toBe(plan.rationale);
    const subtasks = emitted!.payload.subtasks as Array<Record<string, unknown>>;
    expect(subtasks).toHaveLength(1);
    expect(subtasks[0]).toMatchObject({ index: 0, title: "Wire behavior B1", intent: "touch the README" });
    // behaviorIds must be spread through (the [...] array survivor).
    expect(subtasks[0]!.behaviorIds).toEqual(["B1", "B2"]);

    const cost = h.cost("task_plan");
    // ROLE on its OWN field (→ cost_source_raw.role); `model` is the adapter's declared
    // id — EMPTY for a `fake` (the recorder's "no model id → notional NULL, quiet"
    // path). It was "tanren-planner", which no price source has.
    expect(cost.role).toBe("planner");
    expect(cost.model).toBe("");
    expect(cost.cli).toBe("fake");
    expect(cost.runtimeSeconds).toBeGreaterThan(0);
    // Default rawUsage (no buildUsage override) pins `?? { role: "planner", attempt }`.
    expect(cost.rawUsage).toEqual({ role: "planner", attempt: 2 });
  });

  it("uses the buildUsage override for rawUsage when provided", async () => {
    const h = new StageHarness();
    const plan = buildPlan([{ title: "T", intent: "i", behaviorIds: ["B1"] }]);
    await runPlannerStage({
      pool: { query: h.query },
      writer: h.writer,
      costCtx: h.costCtx(),
      adapter: makePlanner([plan]),
      spec: { specTitle: "S", specDescription: "D", acceptanceCriteria: ["AC1"], behaviorIds: [], behaviorContext: [] },
      runId: "run_1",
      workspacePath: "/ws",
      plannerTaskId: "task_plan",
      appendEvent: h.appendEvent,
      attempt: 4,
      rejectionHistory: [],
      timeoutMs: 1000,
      buildUsage: ({ plannerTaskId, attempt }) => ({ custom: true, plannerTaskId, attempt }),
    });
    // The override replaces the default object entirely (the `??` left arm).
    expect(h.cost("task_plan").rawUsage).toEqual({ custom: true, plannerTaskId: "task_plan", attempt: 4 });
  });
});

describe("runWriterStage", () => {
  it("emits the write task timeline with the commit sha and diff byte length", async () => {
    const h = new StageHarness();
    await runWriterStage({
      pool: { query: h.query },
      writer: h.writer,
      costCtx: h.costCtx(),
      adapter: makeWriter(["diff body\n"]),
      runId: "run_1",
      workspacePath: "/ws",
      plannerTaskId: "task_plan",
      subtask,
      writeTaskId: "task_write",
      prompt: "write it",
      timeoutMs: 1000,
      appendEvent: h.appendEvent,
    });

    expect(h.names()).toEqual(["task.started", "writer.subtask.started", "writer.subtask.completed", "task.completed"]);
    // task.started / task.completed carry taskKind "write".
    expect(h.find("task.started")!.payload.taskKind).toBe("write");
    expect(h.find("task.completed")!.payload.taskKind).toBe("write");

    const started = h.find("writer.subtask.started")!;
    expect(started.payload.subtaskIndex).toBe(0);
    expect(started.payload.intent).toBe("touch the README");
    expect(started.payload.behaviorIds).toEqual(["B1", "B2"]);

    const completed = h.find("writer.subtask.completed")!;
    expect(completed.payload.diffBytes).toBe(Buffer.byteLength("diff body\n", "utf8"));
    // Non-empty diff -> writer returns a commit -> commitSha is the first sha.
    expect(completed.payload.commitSha).toBe("sha_1");

    // Child task inserted as a "write" under the planner, then marked passed.
    const row = h.task("task_write");
    expect(row.kind).toBe("write");
    expect(row.title).toContain("write subtask 0");
    expect(row.parentTaskId).toBe("task_plan");
    // The write row is owned by the writer agent and carries the adapter cli +
    // a null model (writer model is recorded on the cost row, not the task).
    expect(row.agentKind).toBe("writer");
    expect(row.cli).toBe("fake");
    expect(row.model).toBeNull();
    expect(h.taskOutcomes.get("task_write")).toBe("passed");

    const cost = h.cost("task_write");
    expect(cost.role).toBe("writer");
    expect(cost.model).toBe("");
    expect(cost.cli).toBe("fake");
    expect(cost.tokenUsage).toMatchObject({ totalTokens: 2 });
    expect(cost.rawUsage).toEqual({ role: "writer", attempt: 1, subtaskIndex: 0 });
  });

  it("reports diffBytes as the utf8 byte length, not the code-point count", async () => {
    const h = new StageHarness();
    // "é" + "あ" are multibyte in utf8 (2 + 3 bytes) so the byte length differs
    // from the JS string length — pins Buffer.byteLength(diff, "utf8").
    const diff = "éあ";
    await runWriterStage({
      pool: { query: h.query },
      writer: h.writer,
      costCtx: h.costCtx(),
      adapter: makeWriter([diff]),
      runId: "run_1",
      workspacePath: "/ws",
      plannerTaskId: "task_plan",
      subtask,
      writeTaskId: "task_write",
      prompt: "write it",
      timeoutMs: 1000,
      appendEvent: h.appendEvent,
    });
    const completed = h.find("writer.subtask.completed")!;
    expect(completed.payload.diffBytes).toBe(5);
    expect(completed.payload.diffBytes).not.toBe(diff.length);
  });

  it("uses the buildUsage override for the writer rawUsage when provided", async () => {
    const h = new StageHarness();
    await runWriterStage({
      pool: { query: h.query },
      writer: h.writer,
      costCtx: h.costCtx(),
      adapter: makeWriter(["diff body\n"]),
      runId: "run_1",
      workspacePath: "/ws",
      plannerTaskId: "task_plan",
      subtask,
      writeTaskId: "task_write",
      prompt: "write it",
      timeoutMs: 1000,
      appendEvent: h.appendEvent,
      buildUsage: ({ subtaskTaskId, subtaskIndex }) => ({ custom: "w", subtaskTaskId, subtaskIndex }),
    });
    expect(h.cost("task_write").rawUsage).toEqual({ custom: "w", subtaskTaskId: "task_write", subtaskIndex: 0 });
  });

  it("reports commitSha null when the writer produces an empty diff (no commit)", async () => {
    const h = new StageHarness();
    await runWriterStage({
      pool: { query: h.query },
      writer: h.writer,
      costCtx: h.costCtx(),
      adapter: makeWriter([""]),
      runId: "run_1",
      workspacePath: "/ws",
      plannerTaskId: "task_plan",
      subtask,
      writeTaskId: "task_write",
      prompt: "write it",
      timeoutMs: 1000,
      appendEvent: h.appendEvent,
    });
    const completed = h.find("writer.subtask.completed")!;
    expect(completed.payload.commitSha).toBeNull();
    expect(completed.payload.diffBytes).toBe(0);
  });
});

function checkerArgs(h: StageHarness, verdict: typeof completeCheck) {
  return {
    pool: { query: h.query },
    writer: h.writer,
    costCtx: h.costCtx(),
    adapter: makeChecker([verdict]),
    runId: "run_1",
    workspacePath: "/ws",
    writeTaskId: "task_write",
    checkerTaskId: "task_check",
    subtask,
    writerResult: { diff: "d", commits: [], exitReason: "completed" as const },
    specTitle: "S",
    specDescription: "D",
    acceptanceCriteria: ["AC1"],
    timeoutMs: 1000,
    appendEvent: h.appendEvent,
  };
}

function auditorArgs(h: StageHarness, verdict: typeof cleanAudit) {
  return {
    pool: { query: h.query },
    writer: h.writer,
    costCtx: h.costCtx(),
    adapter: makeAuditor([verdict]),
    runId: "run_1",
    workspacePath: "/ws",
    plannerTaskId: "task_plan",
    plan: buildPlan([{ title: "T1", intent: "i", behaviorIds: ["B1"] }]),
    baseSha: "a".repeat(40),
    specTitle: "S",
    specDescription: "D",
    acceptanceCriteria: ["AC1"],
    timeoutMs: 1000,
    appendEvent: h.appendEvent,
  };
}

describe("runCheckerStage", () => {
  it("emits checker.verdict with complete=true + empty findings and marks the check passed", async () => {
    const h = new StageHarness();
    const decision = await runCheckerStage(checkerArgs(h, completeCheck));

    expect(decision.kind).toBe("pass");
    const verdict = h.find("checker.verdict")!;
    expect(verdict.payload.complete).toBe(true);
    expect(verdict.payload.passed).toBe(true);
    expect(verdict.payload.reasoning).toBe(completeCheck.reasoning);
    expect(verdict.payload.findings).toEqual([]);
    expect(verdict.payload.behaviorIdsFailed).toEqual([]);
    expect(h.names()).not.toContain("checker.rejected");
    expect(h.taskOutcomes.get("task_check")).toBe("passed");
    // Insert metadata: a "check subtask N" title under the writer, owned by the
    // answerer agent, carrying the adapter cli + null model.
    const row = h.task("task_check");
    expect(row.title).toBe("check subtask 0");
    expect(row.parentTaskId).toBe("task_write");
    expect(row.agentKind).toBe("answerer");
    expect(row.cli).toBe("fake");
    expect(row.model).toBeNull();
    // task.started / checker.started both carry the "check" kind.
    expect(h.find("task.started")!.payload.taskKind).toBe("check");
    expect(h.find("checker.started")!.payload.taskKind).toBe("check");
    // The pass-branch task.completed also carries the "check" kind.
    expect(h.find("task.completed")!.payload.taskKind).toBe("check");
    const cost = h.cost("task_check");
    expect(cost.role).toBe("checker");
    expect(cost.model).toBe("");
    expect(cost.rawUsage).toEqual({ role: "checker", subtaskIndex: 0 });
  });

  it("emits checker.rejected and marks rejected_by_checker on an incomplete (findings) verdict", async () => {
    const h = new StageHarness();
    const decision = await runCheckerStage(checkerArgs(h, incompleteCheck));

    expect(decision.kind).toBe("reject");
    expect(h.names()).toContain("checker.rejected");
    // The verdict event (emitted before the decision branch) carries complete=false +
    // the emitted completeness findings + the downstream-blocked behavior ids.
    const verdict = h.find("checker.verdict")!;
    expect(verdict.payload.complete).toBe(false);
    expect(verdict.payload.passed).toBe(false);
    expect(verdict.payload.behaviorIdsFailed).toEqual(["B1"]);
    expect(verdict.payload.findings).toEqual([
      { id: "missing-file", title: "required file not created", body: "downstream tasks import it", behaviorId: "B1" },
    ]);
    const rejected = h.find("checker.rejected")!;
    expect(rejected.payload.subtaskIndex).toBe(0);
    expect(rejected.payload.behaviorIdsFailed).toEqual(["B1"]);
    expect(h.taskOutcomes.get("task_check")).toBe("rejected_by_checker");
    // The reject-branch still closes the task with the "check" kind.
    expect(h.find("task.completed")!.payload.taskKind).toBe("check");
  });

  it("uses the buildUsage override for the checker rawUsage when provided", async () => {
    const h = new StageHarness();
    await runCheckerStage({
      ...checkerArgs(h, completeCheck),
      buildUsage: ({ checkerTaskId, subtaskIndex }) => ({ custom: "c", checkerTaskId, subtaskIndex }),
    });
    expect(h.cost("task_check").rawUsage).toEqual({ custom: "c", checkerTaskId: "task_check", subtaskIndex: 0 });
  });
});

describe("runAuditorStage", () => {
  it("emits auditor.verdict (findings-only) and marks the audit passed on a clean audit", async () => {
    const h = new StageHarness();
    const { findings, auditorTaskId } = await runAuditorStage(auditorArgs(h, cleanAudit));

    expect(findings).toEqual([]);
    // The auditor task id is a generated `task_<uuid>` (not an empty string).
    expect(auditorTaskId).toMatch(/^task_[0-9a-f-]{36}$/u);
    const verdict = h.find("auditor.verdict")!;
    // `passed` is a notification projection; workflow control remains findings-only.
    expect(verdict.payload.findings).toEqual([]);
    expect(verdict.payload.passed).toBe(true);
    expect(verdict.payload).not.toHaveProperty("recommendedAction");
    expect(h.names()).not.toContain("auditor.rejected");
    expect(h.taskOutcomes.get(auditorTaskId)).toBe("passed");

    // Insert metadata: an "audit plan" title under the planner, answerer-owned.
    const row = h.task(auditorTaskId);
    expect(row.title).toBe("audit plan");
    expect(row.kind).toBe("audit");
    expect(row.parentTaskId).toBe("task_plan");
    expect(row.agentKind).toBe("answerer");

    // task.started / auditor.started / task.completed carry the "audit" kind.
    expect(h.find("task.started")!.payload.taskKind).toBe("audit");
    expect(h.find("auditor.started")!.payload.taskKind).toBe("audit");
    expect(h.find("task.completed")!.payload.taskKind).toBe("audit");

    const cost = h.cost(auditorTaskId);
    expect(cost.role).toBe("auditor");
    expect(cost.model).toBe("");
    expect(cost.rawUsage).toEqual({ role: "auditor" });
  });

  it("returns the emitted findings (findings-only) and marks the audit passed — no auditor.rejected", async () => {
    const h = new StageHarness();
    const { findings, auditorTaskId } = await runAuditorStage(auditorArgs(h, p1Audit));

    // SPEC-LOOP REDESIGN: the auditor renders NO verdict — it returns the emitted
    // findings (triage/convergence route them); the audit task always marks `passed`.
    expect(findings).toEqual([
      { id: "missed-behavior-B2", severity: "P1", title: "B2 not implemented", body: "B2 is uncovered." },
    ]);
    expect(h.names()).not.toContain("auditor.rejected");
    const verdict = h.find("auditor.verdict")!;
    expect(verdict.payload.findings).toEqual(findings);
    expect(verdict.payload.passed).toBe(false);
    expect(h.taskOutcomes.get(auditorTaskId)).toBe("passed");
    expect(h.find("task.completed")!.payload.taskKind).toBe("audit");
  });

  it("uses the buildUsage override for the auditor rawUsage when provided", async () => {
    const h = new StageHarness();
    const { auditorTaskId } = await runAuditorStage({
      ...auditorArgs(h, cleanAudit),
      buildUsage: ({ auditorTaskId: id }) => ({ custom: "a", auditorTaskId: id }),
    });
    expect(h.cost(auditorTaskId).rawUsage).toEqual({ custom: "a", auditorTaskId });
  });
});
