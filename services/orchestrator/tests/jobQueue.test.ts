import { describe, expect, it } from "vitest";
import { FakeJobQueue, PgJobQueue } from "../src/engine/contracts/jobQueue.js";

describe("job queue", () => {
  it("enqueues, claims, completes, fails, and does not double-claim fake jobs", async () => {
    const queue = new FakeJobQueue<{ ok: boolean }>();
    const first = await queue.enqueue({
      runId: "run_1",
      taskId: "task_1",
      taskKind: "plan",
      payload: { ok: true },
    });
    const second = await queue.enqueue({
      runId: "run_1",
      taskId: "task_2",
      taskKind: "plan",
      payload: { ok: true },
    });

    expect(first).toMatchObject({ id: "job_1", attempts: 0 });
    expect(await queue.claim("plan", { runId: "other" })).toBeUndefined();
    await expect(queue.claim("plan", { runId: "run_1" })).resolves.toMatchObject({
      id: "job_1",
      taskId: "task_1",
      attempts: 1,
    });
    await expect(queue.claim("plan", { runId: "run_1" })).resolves.toMatchObject({
      id: "job_2",
      taskId: "task_2",
      attempts: 1,
    });
    expect(await queue.claim("plan", { runId: "run_1" })).toBeUndefined();

    await queue.complete(first.id);
    await queue.fail(second.id, { kind: "test_failed", message: "failed" });
    await queue.failQueuedForRun("run_1", { kind: "run_failed", message: "failed run" });
  });

  it("claims one queued Postgres job with row locking", async () => {
    const client = new RecordingClient([
      { rows: [], rowCount: 0 },
      {
        rows: [
          {
            id: "7",
            run_id: "run_1",
            task_id: "task_1",
            task_kind: "write",
            payload: { ok: true },
            attempts: 1,
          },
        ],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 },
    ]);
    const pool = new RecordingPool(client);
    const queue = new PgJobQueue<{ ok: boolean }>(pool.asPgPool());

    const job = await queue.claim("write", { runId: "run_1" });

    expect(job).toEqual({
      id: "7",
      runId: "run_1",
      taskId: "task_1",
      taskKind: "write",
      payload: { ok: true },
      attempts: 1,
    });
    expect(client.sql).toContain("BEGIN");
    expect(client.sql[1]).toContain("FOR UPDATE SKIP LOCKED");
    expect(client.sql[1]).toContain("SET status = 'running'");
    // the claim stamps a heartbeat + lease window.
    expect(client.sql[1]).toContain("leased_until = now() +");
    expect(client.sql).toContain("COMMIT");
    expect(client.released).toBe(true);
  });

  it("records completion and failure state in Postgres", async () => {
    const pool = new RecordingPool();
    const queue = new PgJobQueue(pool.asPgPool());

    await queue.complete("3");
    await queue.fail("4", { kind: "writer_failed", message: "cannot write" });
    await queue.failQueuedForRun("run_1", { kind: "run_failed", message: "failed run" });

    expect(pool.sql[0]).toContain("SET status = 'done'");
    expect(pool.sql[1]).toContain("SET status = 'failed'");
    // Both finalizers are guarded to `running` so a late finalizer cannot perform the
    // illegal `cancelled -> done` / `cancelled -> failed` transition (state/job.ts).
    expect(pool.sql[0]).toContain("AND status = 'running'");
    expect(pool.sql[1]).toContain("AND status = 'running'");
    expect(pool.params[1]).toEqual(["4", "writer_failed", "cannot write"]);
    expect(pool.sql[2]).toContain("WHERE run_id = $1 AND status = 'queued'");
    expect(pool.params[2]).toEqual(["run_1", "run_failed", "failed run"]);
  });

  it("emits a job-queue NOTIFY right after the enqueue INSERT (LISTEN/NOTIFY wake)", async () => {
    // A pool that returns the inserted row id so enqueue can build its envelope,
    // and records every statement so we can assert the NOTIFY follows the INSERT.
    const sql: string[] = [];
    const pool = {
      async query(text: string): Promise<{ rows: unknown[]; rowCount: number }> {
        sql.push(text);
        if (text.startsWith("INSERT INTO job_queue")) {
          return {
            rows: [{ id: "42", run_id: "run_1", task_id: "task_1", task_kind: "plan", payload: {}, attempts: 0 }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const queue = new PgJobQueue(pool as never);

    const envelope = await queue.enqueue({ runId: "run_1", taskId: "task_1", taskKind: "plan", payload: {} });

    expect(envelope.id).toBe("42");
    // The NOTIFY fires on the cross-tenant job-queue channel, AFTER the INSERT.
    expect(sql[0]).toContain("INSERT INTO job_queue");
    expect(sql[1]).toBe("NOTIFY tanren_job_queue");
  });
});

describe("job queue lease recovery", () => {
  it("requeues a job whose lease expired (recovery, not a strike)", async () => {
    const queue = new FakeJobQueue<{ ok: boolean }>();
    await queue.enqueue({
      runId: "run_1",
      taskKind: "plan",
      payload: { ok: true },
    });
    const claimed = await queue.claim("plan", { leaseMs: 10 });
    expect(claimed).toMatchObject({ attempts: 1 });

    // Lease has lapsed (now is past leased_until) and a worker can't be holding it.
    const reaped = await queue.reapExpiredLeases({ now: new Date(Date.now() + 1_000) });
    expect(reaped).toEqual([
      {
        id: claimed!.id,
        runId: "run_1",
        taskKind: "plan",
        attempts: 1,
        outcome: "requeued",
      },
    ]);
    // Requeued → re-claimable, and the attempt count keeps climbing (diagnostic).
    const reclaimed = await queue.claim("plan", { leaseMs: 10 });
    expect(reclaimed).toMatchObject({ id: claimed!.id, attempts: 2 });
  });

  it("requeues INDEFINITELY — never dead-letters a transient lease-expiry on a count", async () => {
    const queue = new FakeJobQueue<{ ok: boolean }>();
    await queue.enqueue({ runId: "run_1", taskKind: "plan", payload: { ok: true } });

    // Far past any old fixed cap (DEFAULT_MAX_ATTEMPTS was 5): every lease-expiry
    // requeues, the job is NEVER terminal. A crashing worker is loud infra, not a
    // job to drop on a count.
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const claimed = await queue.claim("plan", { leaseMs: 10 });
      expect(claimed).toMatchObject({ attempts: attempt });
      const reaped = await queue.reapExpiredLeases({ now: new Date(Date.now() + 1_000) });
      expect(reaped[0]?.outcome).toBe("requeued");
    }

    // Still claimable after 20 re-claims — there is no terminal dead-letter state.
    expect(await queue.claim("plan")).toMatchObject({ runId: "run_1", attempts: 21 });
  });

  it("does not reap a job whose lease is still fresh (heartbeat keeps it alive)", async () => {
    const queue = new FakeJobQueue<{ ok: boolean }>();
    await queue.enqueue({ runId: "run_1", taskKind: "plan", payload: { ok: true } });
    const claimed = await queue.claim("plan", { leaseMs: 50 });
    await queue.heartbeat(claimed!.id, 10_000);

    // now is past the ORIGINAL lease but inside the heartbeat-renewed window.
    const reaped = await queue.reapExpiredLeases({ now: new Date(Date.now() + 1_000) });
    expect(reaped).toEqual([]);
    // Still held → not claimable by another slot.
    expect(await queue.claim("plan")).toBeUndefined();
  });

  it("emits the lease-aware claim + reaper SQL through Postgres", async () => {
    const pool = new RecordingPool(
      new RecordingClient([
        { rows: [], rowCount: 0 },
        { rows: [], rowCount: 0 },
        { rows: [], rowCount: 0 },
      ]),
    );
    const queue = new PgJobQueue(pool.asPgPool());

    await queue.heartbeat("9", 30_000);
    await queue.reapExpiredLeases();

    expect(pool.sql[0]).toContain("heartbeat_at = now()");
    expect(pool.sql[0]).toContain("status = 'running'");
    const reapSql = pool.sql[1] ?? "";
    // Always requeue — no attempt-cap dead-letter branch.
    expect(reapSql).toContain("SET status = 'queued'");
    expect(reapSql).not.toContain("dead_letter");
    expect(reapSql).not.toContain("max_attempts");
    expect(reapSql).toContain("leased_until < now()");
  });

  // A cancelled spec reaps its run's live `job_queue` rows to the TERMINAL `cancelled`
  // status (workflow/cancelSpec.ts) but does NOT stop the worker already executing the
  // job. That worker's `executeNextPlanJob` finalizer then runs anyway. If `complete` /
  // `fail` write by id alone they perform `cancelled -> done` / `cancelled -> failed`,
  // which `state/job.ts` declares ILLEGAL (`cancelled: []`) — silently undoing the reap,
  // falsifying the `jobsCancelled` audit evidence, and (for `failed`, which allows
  // `failed -> queued`) re-opening the requeue door the reap exists to close.
  it("does not let a late finalizer overwrite a job the cancel already reaped", async () => {
    for (const finalize of [
      async (queue: PgJobQueue<{ ok: boolean }>, id: string) => {
        await queue.complete(id);
      },
      async (queue: PgJobQueue<{ ok: boolean }>, id: string) => {
        await queue.fail(id, { kind: "writer_failed", message: "cannot write" });
      },
    ]) {
      const pool = new StatefulJobPool();
      const queue = new PgJobQueue<{ ok: boolean }>(pool.asPgPool());
      const enqueued = await queue.enqueue({ runId: "run_1", taskKind: "plan", payload: { ok: true } });
      await queue.claim("plan", { runId: "run_1" });
      expect(pool.statusOf(enqueued.id)).toBe("running");

      // The operator cancels the spec: cancelSpec reaps this row terminal, out of band
      // from the worker still holding it.
      pool.forceStatus(enqueued.id, "cancelled");

      // The worker finishes and finalizes the job it thinks it still owns.
      await finalize(queue, enqueued.id);

      expect(pool.statusOf(enqueued.id)).toBe("cancelled");
    }
  });

  it("still finalizes a running job (the guard narrows the write, it does not disable it)", async () => {
    const pool = new StatefulJobPool();
    const queue = new PgJobQueue<{ ok: boolean }>(pool.asPgPool());
    const done = await queue.enqueue({ runId: "run_1", taskKind: "plan", payload: { ok: true } });
    await queue.claim("plan", { runId: "run_1" });
    await queue.complete(done.id);
    expect(pool.statusOf(done.id)).toBe("done");

    const failed = await queue.enqueue({ runId: "run_1", taskKind: "plan", payload: { ok: true } });
    await queue.claim("plan", { runId: "run_1" });
    await queue.fail(failed.id, { kind: "writer_failed", message: "cannot write" });
    expect(pool.statusOf(failed.id)).toBe("failed");
  });
});

/**
 * A stateful in-memory `pg.Pool` substitute for PgJobQueue's finalize statements.
 *
 * It does NOT hard-code the guard: it parses `AND status = '<x>'` out of the
 * PRODUCTION statement and applies exactly that predicate. So the fake can never be
 * more correct than the SQL under test — drop the guard from `complete`/`fail` and the
 * write lands unconditionally, exactly as Postgres would apply it.
 */
class StatefulJobPool {
  private readonly jobs = new Map<string, { runId: string | null; taskKind: string; status: string }>();
  private seq = 0;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const text = sql.trim();
    if (text.includes("INSERT INTO job_queue")) {
      this.seq += 1;
      const id = String(this.seq);
      this.jobs.set(id, {
        runId: (params[0] as string | null) ?? null,
        taskKind: params[2] as string,
        status: "queued",
      });
      return {
        rows: [{ id, run_id: params[0], task_id: params[1], task_kind: params[2], payload: {}, attempts: 0 }],
        rowCount: 1,
      };
    }
    if (text.includes("FOR UPDATE SKIP LOCKED")) {
      const runId = (params[1] as string | null) ?? null;
      for (const [id, job] of this.jobs) {
        if (job.status !== "queued" || job.taskKind !== params[0]) continue;
        if (runId !== null && job.runId !== runId) continue;
        job.status = "running";
        return {
          rows: [{ id, run_id: job.runId, task_id: null, task_kind: job.taskKind, payload: {}, attempts: 1 }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }
    const target = /SET status = '([a-z_]+)'/u.exec(text);
    if (text.startsWith("UPDATE job_queue") && target !== null) {
      const job = this.jobs.get(String(params[0]));
      // Apply the statement's OWN guard, whatever it is (absent guard => unconditional).
      const guard = /AND status = '([a-z_]+)'/u.exec(text)?.[1];
      if (job !== undefined && (guard === undefined || job.status === guard)) {
        job.status = target[1] ?? job.status;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<StatefulJobPool> {
    return this;
  }

  release(): void {}

  /** Reap the row out of band, the way `cancelSpec` does. */
  forceStatus(id: string, status: string): void {
    const job = this.jobs.get(id);
    if (job !== undefined) {
      job.status = status;
    }
  }

  statusOf(id: string): string | undefined {
    return this.jobs.get(id)?.status;
  }

  asPgPool() {
    return this as never;
  }
}

class RecordingPool {
  readonly sql: string[] = [];
  readonly params: unknown[][] = [];

  constructor(private readonly client = new RecordingClient()) {}

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.sql.push(sql);
    this.params.push(params);
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<RecordingClient> {
    return this.client;
  }

  asPgPool() {
    return this as never;
  }
}

class RecordingClient {
  readonly sql: string[] = [];
  released = false;

  constructor(private readonly results: Array<{ rows: unknown[]; rowCount: number }> = []) {}

  async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    this.sql.push(sql);
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }

  release(): void {
    this.released = true;
  }
}
