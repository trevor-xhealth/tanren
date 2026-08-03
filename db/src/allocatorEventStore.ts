// Shared allocator-event writer. The allocator is a separate service, so it
// cannot use the orchestrator's in-process PgEventStore. This package owns the
// two allocator event schemas and the durable insert + notify behavior they
// share with the orchestrator event store.
//
// `AllocatorEventRegistry` here is the SOLE allocator event-name declaration:
// services/allocator/src/pgAllocatorEvents.ts imports it rather than declaring
// a parallel one, so there is exactly one allocator surface to bind.

import type pg from "pg";
import { z } from "zod";
import type { EventTypeSeedName } from "./eventTypesSeed.js";
import { notifyEventAppended, notifyRunActivity } from "./notify.js";

type EventClient = Pick<pg.PoolClient, "query">;

const SshTargetSummary = z
  .object({
    host: z.string(),
    port: z.number().int(),
    username: z.string(),
    hostKeyFingerprint: z.string(),
  })
  .strict();

export const AllocatorAllocatedPayload = z
  .object({
    runnerId: z.string(),
    imageSha: z.string(),
    target: SshTargetSummary,
  })
  .strict();

export const RunnerSweptPayload = z
  .object({
    runnerId: z.string(),
    runId: z.string().nullable(),
    reason: z.enum(["terminal_run", "lease_lapsed", "unclaimed_grace"]),
  })
  .strict();

/**
 * The allocator's event names, BOUND to the shared vocabulary.
 *
 * `EventTypeSeedName` is the union of every name in `eventTypesSeed`, which
 * `check:event-drift` proves is the mirror of `eventTypeVocabulary()` and which
 * the event-type migration guard proves every migration inserts. Constraining
 * the keys to that union means a name outside it is a TYPE ERROR here rather
 * than a `events.event_type` foreign-key failure on the first emit — which
 * returns 500 from `/internal/append-event` and halts the run.
 *
 * `Partial<...>` because the allocator owns two of the vocabulary's names, not
 * all of them; excess-property checking on the object literal is what rejects a
 * key the vocabulary does not carry.
 */
export const AllocatorEventRegistry = {
  "allocator.allocated": AllocatorAllocatedPayload,
  "runner.swept": RunnerSweptPayload,
} as const satisfies Partial<Record<EventTypeSeedName, z.ZodType>>;

export type AllocatorEventName = keyof typeof AllocatorEventRegistry;
export type AllocatorEventPayload<N extends AllocatorEventName> = z.output<(typeof AllocatorEventRegistry)[N]>;

export interface AllocatorEventInput<N extends AllocatorEventName> {
  runId: string | null;
  projectId: string | null;
  /** Explicit tenant key; never inferred from a project row or ambient scope. */
  orgId: string;
  eventType: N;
  payload: AllocatorEventPayload<N>;
}

/**
 * Append one allocator-owned event using the shared event-table protocol.
 * Callers must already hold the matching `runWithOrgScope` transaction; this
 * helper validates the payload and preserves the central notification fanout.
 */
export async function appendAllocatorEvent<N extends AllocatorEventName>(
  client: EventClient,
  input: AllocatorEventInput<N>,
): Promise<void> {
  if (input.orgId.trim() === "") {
    throw new Error("appendAllocatorEvent: explicit orgId must be non-empty");
  }
  const parsedPayload: unknown = AllocatorEventRegistry[input.eventType].parse(input.payload);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO events (run_id, project_id, org_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id::text AS id`,
    [input.runId, input.projectId, input.orgId, input.eventType, JSON.stringify(parsedPayload)],
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
