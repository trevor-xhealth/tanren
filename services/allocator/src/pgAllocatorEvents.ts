// The allocator service's SOLE `events` writer. Its typed append API validates
// allocator-owned payloads and preserves the event notification fanout.

import type pg from "pg";
import {
  AllocatorEventRegistry,
  type AllocatorEventInput,
  type AllocatorEventName,
  notifyEventAppended,
  notifyRunActivity,
  runWithOrgScope,
} from "@tanren/db";
import type { AllocationAudit, SweptAudit } from "./runnerLifecycle.js";

type EventClient = Pick<pg.PoolClient, "query">;

/**
 * The allocator's typed append API. It is the only allocator-side SQL writer
 * for `events`, and callers must supply the tenant key that is stamped on row.
 *
 * The event NAMES and payload schemas come from `AllocatorEventRegistry` in
 * `@tanren/db`, which binds its keys to the shared event vocabulary. This file
 * deliberately keeps its own INSERT — the allocator is a de-privileged service
 * on the other side of the plane split and does not share the orchestrator's
 * in-process event store — but it no longer declares a parallel vocabulary that
 * nothing ties to the `event_types` rows the migrations insert.
 */
async function appendAllocatorEvent<N extends AllocatorEventName>(
  client: EventClient,
  input: AllocatorEventInput<N>,
): Promise<void> {
  if (input.orgId.trim() === "") {
    throw new Error("appendAllocatorEvent: explicit orgId must be non-empty");
  }
  const payload: unknown = AllocatorEventRegistry[input.eventType].parse(input.payload);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO events (run_id, project_id, org_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id::text AS id`,
    [input.runId, input.projectId, input.orgId, input.eventType, JSON.stringify(payload)],
  );
  const eventId = inserted.rows[0]?.id;
  if (eventId === undefined) {
    throw new Error("appendAllocatorEvent: event insert returned no id");
  }
  if (input.runId !== null) {
    await notifyRunActivity(client, input.runId);
  }
  await notifyEventAppended(client, eventId);
}

/**
 * Append the durable `allocator.allocated` audit event for a successful allocation,
 * org-scoped (same RLS scope as the `runners` row). `run_id` is NULL for a runless
 * Forge allocation (no `runs` row to reference); the events table allows it. The
 * event type is a key of `AllocatorEventRegistry`, so it is in the shared
 * vocabulary by construction and a migration has inserted its `event_types` row.
 */
export async function recordAllocatedEvent(appPool: pg.Pool, audit: AllocationAudit): Promise<void> {
  await runWithOrgScope(appPool, audit.orgId, async (client) => {
    await appendAllocatorEvent(client, {
      runId: audit.runId,
      projectId: audit.projectId,
      orgId: audit.orgId,
      eventType: "allocator.allocated",
      payload: {
        runnerId: audit.runnerId,
        imageSha: audit.imageSha,
        target: audit.target,
      },
    });
  });
}

/**
 * Append the durable `runner.swept` audit event for a sweeper reclaim, org-scoped
 * (same RLS scope as the `runners` row). The payload carries the discriminated
 * stuck-state `reason` plus the NON-SECRET runner/run handles — the proof a leaked
 * runner the normal release path missed was reconciled LOUDLY, never silently.
 * `run_id` is NULL for a wedged (unclaimed-grace) allocation never tied to a `runs`
 * row. The event type is a key of `AllocatorEventRegistry`, so it is in the shared
 * vocabulary by construction and a migration has inserted its `event_types` row.
 */
export async function recordSweptEvent(appPool: pg.Pool, audit: SweptAudit): Promise<void> {
  await runWithOrgScope(appPool, audit.orgId, async (client) => {
    await appendAllocatorEvent(client, {
      runId: audit.runId,
      projectId: audit.projectId,
      orgId: audit.orgId,
      eventType: "runner.swept",
      payload: {
        runnerId: audit.runnerId,
        runId: audit.runId,
        reason: audit.reason,
      },
    });
  });
}
