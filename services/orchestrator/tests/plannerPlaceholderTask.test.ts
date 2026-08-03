// The QUEUE-TIME PLACEHOLDER plan task `createQueuedRunFromSpec` pre-creates.
//
// It is LOAD-BEARING — `job_queue.task_id` FK-references it, `plannerTaskId` is
// returned to the caller and stamped on the `run.queued` / `task.queued` events, and
// `merge/recoveryEvidencePg.ts` binds a recovery receipt to it — so it cannot simply
// be removed. But it used to be written with `cli = 'fake'` / `model = 'fake-planner'`,
// which in a `SELECT` or a DB dump reads exactly like a deterministic fallback
// provider serving production traffic (and collides with the `fake` cli the test
// fixtures use for a stubbed adapter). The row now says the true thing: no harness
// has been assigned yet, because the worker has not resolved routing.
//
// Asserted on the COLUMN VALUES the production INSERT actually binds, observed by
// TAPPING the real pool — not on a constant's value.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { createProject, createQueuedRunFromSpec, createSpec } from "../src/engine/workflow/projectSpec.js";
import { WorkerPool } from "./helpers/workerPool.js";

const ORG = "org_placeholder_test";

/** Every harness name tanren can actually route to — none may appear on the row. */
const REAL_HARNESSES = ["codex", "claude", "opencode", "aider", "pi", "reasonix"];

/**
 * A pass-through tap over the in-memory `WorkerPool` that records the SQL + bind
 * params of every `INSERT INTO tasks`. Everything else delegates unchanged, so the
 * production write path runs exactly as it does against the real pool.
 */
class TaskInsertTap {
  readonly taskInserts: Array<{ sql: string; params: unknown[] }> = [];
  readonly totalCount = 0;

  constructor(private readonly inner: WorkerPool) {}

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.trim().startsWith("INSERT INTO tasks")) {
      this.taskInserts.push({ sql: sql.trim(), params: [...params] });
    }
    return this.inner.query(sql, params);
  }

  async connect(): Promise<pg.PoolClient> {
    return {
      query: (sql: string, params?: unknown[]) => this.query(sql, params ?? []),
      release: () => {},
    } as unknown as pg.PoolClient;
  }

  release(): void {}

  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

async function queueRun(tap: TaskInsertTap) {
  const project = await createProject(
    tap.asPgPool(),
    {
      name: "placeholder-test",
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      defaultBranch: "main",
      config: { version: 1 },
    },
    { userId: "user_placeholder", orgId: ORG, projectId: null, scopes: ["org:admin"], source: "session" },
  );
  const spec = await createSpec(tap.asPgPool(), {
    projectId: project.projectId,
    title: "Add a marker file",
    description: "Create the marker.",
    acceptanceCriteria: ["marker exists"],
  });
  return createQueuedRunFromSpec(tap.asPgPool(), { specId: spec.specId, branch: "tanren/placeholder" });
}

describe("the queue-time placeholder plan task", () => {
  it("names NO provider and carries a NULL model — it is unassigned, not a fallback harness", async () => {
    const tap = new TaskInsertTap(new WorkerPool());
    await queueRun(tap);

    // Exactly one task row is written at queue time: the placeholder.
    expect(tap.taskInserts).toHaveLength(1);
    const insert = tap.taskInserts[0]!;
    // Column order in the production INSERT: (task_id, run_id, org_id, kind, title,
    // status, agent_kind, cli, model). `cli` is bound; `model` is the SQL literal NULL.
    expect(insert.params[2]).toBe("unassigned");
    expect(insert.sql).toMatch(/'answerer',\s*\$3,\s*NULL\)/u);

    // The row must not be readable as any harness tanren can actually run — that
    // misreading is the whole defect. Checked against the real harness vocabulary
    // plus the test-fixture `fake` cli it used to collide with.
    const rowText = `${insert.sql} ${JSON.stringify(insert.params)}`.toLowerCase();
    for (const harness of [...REAL_HARNESSES, "fake"]) {
      expect(rowText).not.toContain(`'${harness}'`);
      expect(rowText).not.toContain(`"${harness}"`);
    }
  });

  it("stays load-bearing: the enqueued plan job still points at that exact task row", async () => {
    const tap = new TaskInsertTap(new WorkerPool());
    const run = await queueRun(tap);

    // `job_queue.task_id` FK-references the placeholder, and the caller/event payload
    // carry the same id — which is why the row cannot be deleted, only renamed.
    expect(run.plannerTaskId).toBe(String(tap.taskInserts[0]?.params[0]));
    expect(run.plannerJobId).not.toBe("");
  });
});
