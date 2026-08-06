import { notifyJobEnqueued } from "@tanren/db";
import type pg from "pg";

export interface JobEnvelope<TPayload = unknown> {
  id: string;
  runId?: string;
  taskId?: string;
  taskKind: string;
  payload: TPayload;
  /**
   * DIAGNOSTIC re-claim counter: how many times this job has been claimed (incl.
   * recoveries after a crashed/slow worker let its lease lapse). NOT a give-up
   * budget — there is no ceiling and it NEVER terminates the job. The doctrine
   * forbids a fixed attempt cap; a lease-expired job is requeued indefinitely.
   */
  attempts: number;
  // RLS R3b: the owning run's org, stamped on enqueue (job_queue.org_id). The
  // queue stays OUTSIDE RLS, so this is the worker's tenant BOOTSTRAP source —
  // the claim reads it to scope `loadRunExecutionContext` to the job's org
  // instead of doing an RLS-protected `runs` read. Undefined for a
  // system / null-org job (e.g. the hello fixture, a CLI caller with no org).
  orgId?: string;
}

export type EnqueueJob<TPayload = unknown> = Omit<JobEnvelope<TPayload>, "id" | "attempts"> & {
  attempts?: number;
};

/** queue lease default: a claimed job's lease lives this long unless renewed. */
export const DEFAULT_LEASE_MS = 60_000;

/**
 * A job the reaper recovered: ALWAYS requeued. A lease-expired `running` job is a
 * crashed/slow worker (transient), so it is returned to `queued` indefinitely — a
 * re-claim is recovery, NOT a strike, and the doctrine forbids a fixed attempt cap.
 * `attempts` is carried as DIAGNOSTIC evidence (the climbing re-claim count) so the
 * caller can emit a LOUD `job.lease_expired` infra signal — a worker that keeps
 * crashing is an infra problem to surface, never a job to silently drop.
 */
export interface ReapedJob {
  id: string;
  runId?: string;
  taskKind: string;
  attempts: number;
  outcome: "requeued";
}

export interface JobQueue<TPayload = unknown> {
  enqueue(job: EnqueueJob<TPayload>): Promise<JobEnvelope<TPayload>>;
  /** Claim one queued job. `leaseMs` sets the initial lease window (default {@link DEFAULT_LEASE_MS}). */
  claim(taskKind: string, options?: { runId?: string; leaseMs?: number }): Promise<JobEnvelope<TPayload> | undefined>;
  /** extend a claimed job's lease while the worker is still executing it. */
  heartbeat(id: string, leaseMs?: number): Promise<void>;
  complete(id: string): Promise<void>;
  fail(id: string, failure: { kind: string; message: string }): Promise<void>;
  failQueuedForRun(runId: string, failure: { kind: string; message: string }): Promise<void>;
  /**
   * lease recovery: requeue EVERY `running` job whose lease has lapsed (crashed
   * or slow worker). A lapsed lease is a transient infra event, so the job is
   * ALWAYS returned to `queued` — requeued indefinitely, never dead-lettered on a
   * count (the doctrine forbids a fixed attempt cap). Returns the jobs it
   * requeued so the caller can emit a LOUD `job.lease_expired` infra signal with
   * the climbing re-claim count as evidence.
   */
  reapExpiredLeases(options?: { now?: Date }): Promise<ReapedJob[]>;
}

interface FakeJobRow<TPayload> extends JobEnvelope<TPayload> {
  status: "queued" | "running" | "done" | "failed";
  leasedUntil?: number;
  failureKind?: string;
  failureMessage?: string;
}

export class FakeJobQueue<TPayload = unknown> implements JobQueue<TPayload> {
  private readonly jobs: Array<FakeJobRow<TPayload>> = [];

  async enqueue(job: EnqueueJob<TPayload>): Promise<JobEnvelope<TPayload>> {
    const envelope: FakeJobRow<TPayload> = {
      ...job,
      attempts: job.attempts ?? 0,
      id: `job_${this.jobs.length + 1}`,
      status: "queued" as const,
    };
    this.jobs.push(envelope);
    return envelopeFromRow(envelope);
  }

  async claim(
    taskKind: string,
    options?: { runId?: string; leaseMs?: number },
  ): Promise<JobEnvelope<TPayload> | undefined> {
    const job = this.jobs.find(
      (candidate) =>
        candidate.status === "queued" && candidate.taskKind === taskKind && matchesRun(candidate.runId, options?.runId),
    );
    if (job === undefined) {
      return undefined;
    }
    job.status = "running";
    job.attempts += 1;
    job.leasedUntil = Date.now() + (options?.leaseMs ?? DEFAULT_LEASE_MS);
    return envelopeFromRow(job);
  }

  async heartbeat(id: string, leaseMs?: number): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job !== undefined && job.status === "running") {
      job.leasedUntil = Date.now() + (leaseMs ?? DEFAULT_LEASE_MS);
    }
  }

  // Finalize ONLY from `running` — see the PgJobQueue note below. `cancelled` is
  // terminal in `state/job.ts` (`cancelled: []`), so a late finalizer must not
  // resurrect a cancelled job into `done`/`failed`.
  async complete(id: string): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job !== undefined && job.status === "running") {
      job.status = "done";
    }
  }

  async fail(id: string, failure: { kind: string; message: string }): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job !== undefined && job.status === "running") {
      job.status = "failed";
      job.failureKind = failure.kind;
      job.failureMessage = failure.message;
    }
  }

  async failQueuedForRun(runId: string, failure: { kind: string; message: string }): Promise<void> {
    for (const job of this.jobs) {
      if (job.status === "queued" && job.runId === runId) {
        job.status = "failed";
        job.failureKind = failure.kind;
        job.failureMessage = failure.message;
      }
    }
  }

  async reapExpiredLeases(options?: { now?: Date }): Promise<ReapedJob[]> {
    const now = (options?.now ?? new Date()).getTime();
    const reaped: ReapedJob[] = [];
    for (const job of this.jobs) {
      if (job.status !== "running" || job.leasedUntil === undefined || job.leasedUntil > now) {
        continue;
      }
      // A lapsed lease is a transient crash/slowness: ALWAYS requeue, unbounded.
      // No attempt-cap dead-letter — recovery is not a strike.
      job.status = "queued";
      job.leasedUntil = undefined;
      reaped.push(reapedFromRow(job, "requeued"));
    }
    return reaped;
  }
}

export class PgJobQueue<TPayload = unknown> implements JobQueue<TPayload> {
  constructor(private readonly pool: pg.Pool) {}

  async enqueue(job: EnqueueJob<TPayload>): Promise<JobEnvelope<TPayload>> {
    // RLS R3b: stamp the owning run's org_id on the queue row. When the caller
    // does not pass one explicitly we derive it from the run (COALESCE), so a
    // run-bound job always carries its tenant even if the enqueue site predates
    // the org thread. job_queue stays OUTSIDE RLS, so this INSERT is unaffected
    // by policies — it is the worker's bootstrap source, not a tenant read.
    const result = await this.pool.query(
      `INSERT INTO job_queue (run_id, task_id, task_kind, payload, attempts, org_id)
       VALUES (
         $1, $2, $3, $4::jsonb, $5,
         COALESCE($6, (SELECT org_id FROM runs WHERE run_id = $1))
       )
       RETURNING id::text, run_id, task_id, task_kind, payload, attempts, org_id`,
      [
        job.runId ?? null,
        job.taskId ?? null,
        job.taskKind,
        JSON.stringify(job.payload),
        job.attempts ?? 0,
        job.orgId ?? null,
      ],
    );
    // LISTEN/NOTIFY: wake an idle worker slot the instant a job is enqueued,
    // replacing its 1s poll as the primary driver. This INSERT is autocommit
    // (the pool), so the NOTIFY fires immediately on the cross-tenant
    // `tanren_job_queue` channel — a payload-free "work may be available" pulse.
    await notifyJobEnqueued(this.pool);
    return envelopeFromRow(result.rows[0]);
  }

  async claim(
    taskKind: string,
    options?: { runId?: string; leaseMs?: number },
  ): Promise<JobEnvelope<TPayload> | undefined> {
    const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `WITH next_job AS (
           SELECT id
           FROM job_queue
           WHERE task_kind = $1
             AND status = 'queued'
             AND ($2::text IS NULL OR run_id = $2)
           ORDER BY enqueued_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE job_queue
         SET status = 'running',
             started_at = now(),
             attempts = attempts + 1,
             heartbeat_at = now(),
             leased_until = now() + ($3 * interval '1 millisecond')
         WHERE id IN (SELECT id FROM next_job)
         RETURNING id::text, run_id, task_id, task_kind, payload, attempts, org_id`,
        [taskKind, options?.runId ?? null, leaseMs],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row === undefined ? undefined : envelopeFromRow(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(id: string, leaseMs?: number): Promise<void> {
    const lease = leaseMs ?? DEFAULT_LEASE_MS;
    await this.pool.query(
      `UPDATE job_queue
       SET heartbeat_at = now(), leased_until = now() + ($2 * interval '1 millisecond')
       WHERE id = $1 AND status = 'running'`,
      [id, lease],
    );
  }

  // FINALIZE ONLY FROM `running` (`AND status = 'running'`, the same guard `heartbeat`
  // above already carries).
  //
  // `state/job.ts` declares `cancelled: []` — `cancelled` is TERMINAL, and
  // `cancelled -> done` / `cancelled -> failed` are illegal transitions. But these two
  // statements are raw SQL that never consults `isAllowedJobTransition`, so an
  // unguarded `WHERE id = $1` performs exactly those illegal transitions in the
  // database. That is reachable on the ordinary cancel path: cancelling a spec reaps
  // the run's live `job_queue` rows to `cancelled` (workflow/cancelSpec.ts) but does
  // NOT stop the worker already executing the job, and `executeNextPlanJob`
  // (worker/runExecutor.ts) then unconditionally finalizes the job it holds. Without
  // the guard that late finalizer overwrites the reap.
  //
  // Two things break when it does. The `run.cancelled` audit event names the reaped
  // rows in `jobsCancelled`, so the record claims a reap that no longer holds — a
  // believable-but-false reading, not a visible error. And `failed` is NOT terminal
  // (`failed: ["queued", "dead_letter"]`), so a clobber to `failed` re-opens the very
  // requeue door the reap was added to close.
  //
  // The guard makes the write a no-op instead: a lost finalization leaves the job
  // `cancelled`, which is the true state. (A finalizer that lost its lease to the
  // reaper and is racing a re-claim is a separate, pre-existing concern — see the
  // note on PR #1406 — and is not what this guard addresses.)
  async complete(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE job_queue SET status = 'done', ended_at = now(), leased_until = NULL WHERE id = $1 AND status = 'running'",
      [id],
    );
  }

  async fail(id: string, failure: { kind: string; message: string }): Promise<void> {
    await this.pool.query(
      `UPDATE job_queue
       SET status = 'failed', ended_at = now(), leased_until = NULL, failure_kind = $2, failure_message = $3
       WHERE id = $1 AND status = 'running'`,
      [id, failure.kind, failure.message],
    );
  }

  async failQueuedForRun(runId: string, failure: { kind: string; message: string }): Promise<void> {
    await this.pool.query(
      `UPDATE job_queue
       SET status = 'failed', ended_at = now(), failure_kind = $2, failure_message = $3
       WHERE run_id = $1 AND status = 'queued'`,
      [runId, failure.kind, failure.message],
    );
  }

  async reapExpiredLeases(options?: { now?: Date }): Promise<ReapedJob[]> {
    // Single atomic pass: any `running` job whose lease lapsed is a crashed/slow
    // worker — ALWAYS requeue it (back to `queued`), unbounded. A lapsed lease is
    // transient recovery, NOT a strike, so there is NO attempt-cap dead-letter
    // branch (the doctrine forbids a fixed attempt cap). `attempts` is returned as
    // DIAGNOSTIC evidence so the reaper can emit a LOUD `job.lease_expired` infra
    // signal — a worker that keeps crashing is an infra problem to surface, never
    // a job to silently drop. arch-allow: timeout-class (`leased_until`/`now()` is
    // the LEASE CADENCE — a kept spacing interval, not a give-up budget).
    const now = options?.now;
    const result = await this.pool.query(
      `UPDATE job_queue
       SET status = 'queued',
           leased_until = NULL
       WHERE status = 'running'
         AND leased_until IS NOT NULL
         AND leased_until < ${now === undefined ? "now()" : "$1"}
       RETURNING id::text, run_id, task_kind, attempts, status`,
      now === undefined ? [] : [now],
    );
    return result.rows.map((row: ReapRow) => ({
      id: String(row.id),
      runId: row.run_id ?? undefined,
      taskKind: row.task_kind,
      attempts: row.attempts ?? 0,
      outcome: "requeued" as const,
    }));
  }
}

interface ReapRow {
  id: string | number;
  run_id?: string | null;
  task_kind: string;
  attempts?: number;
  status: string;
}

function reapedFromRow<TPayload>(job: JobEnvelope<TPayload>, outcome: ReapedJob["outcome"]): ReapedJob {
  return {
    id: job.id,
    runId: job.runId,
    taskKind: job.taskKind,
    attempts: job.attempts,
    outcome,
  };
}

function matchesRun(jobRunId: string | undefined, requestedRunId: string | undefined): boolean {
  return requestedRunId === undefined || jobRunId === requestedRunId;
}

function envelopeFromRow<TPayload>(row: {
  id: string | number;
  run_id?: string | null;
  runId?: string | null;
  task_id?: string | null;
  taskId?: string | null;
  task_kind?: string;
  taskKind?: string;
  payload: TPayload;
  attempts?: number;
  org_id?: string | null;
  orgId?: string | null;
}): JobEnvelope<TPayload> {
  const orgId = row.org_id ?? row.orgId ?? undefined;
  return {
    id: String(row.id),
    runId: row.run_id ?? row.runId ?? undefined,
    taskId: row.task_id ?? row.taskId ?? undefined,
    taskKind: row.task_kind ?? row.taskKind ?? "",
    payload: row.payload,
    attempts: row.attempts ?? 0,
    ...(orgId === undefined || orgId === null ? {} : { orgId }),
  };
}
