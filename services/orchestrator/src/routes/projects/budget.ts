// The per-project DOLLAR BUDGET surface (autonomy-engine.md §3 proof 6): the
// OBSERVATION + MUTATION endpoints for the budget ceiling the DagWalker enforces.
//
//   GET  /:orgId/projects/:projectId/budget
//     → { ceilingUsd | null, period, spentUsd, notionalUsd,
//         remainingUsd | null, paused, pauseObservation, failClosed }
//       the resolved ceiling (project-over-org), the cumulative REAL spend over the
//       period (the figure the ceiling ALWAYS gates — the doctrine), the API-EQUIVALENT
//       notional value over the same period (surfaced so a subscription org sees a
//       non-zero figure; NOT spend, NOT gated), the remaining headroom against real
//       spend, whether the walker is paused on budget, and the latest durable
//       project-level walker proof when one has been observed.
//   PUT  /:orgId/projects/:projectId/budget   { ceilingUsd, period? }
//     → the same shape, re-read after the write. Sets the project's OWN budget,
//       read-modify-writing `projects.config.budget` through the SAME versioned
//       project-config path the rest of the config uses — a dedicated, discoverable
//       endpoint so an operator never hand-crafts a full config PATCH to change it.
//       `ceilingUsd: null` CLEARS the project budget (back to the org default /
//       unlimited).
//
// Both run org-scoped under RLS: the spend sum (via PgBudgetGate) reads on the
// org-scoped client; the config write resolves + verifies the project's org first.

import { notifyDagChanged } from "@tanren/db";
import type { Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import { ConfigRevisionSchema } from "../../engine/config/configRevision.js";
import { DEFAULT_BUDGET_PERIOD, migrateProjectConfig } from "../../engine/config/index.js";
import { type ProjectBudgetState, shouldPauseOnBudget } from "../../engine/contracts/dagWalker.js";
import { PgBudgetGate } from "../../engine/dag/budgetGate.js";
import {
  type BudgetPauseObservation,
  PgBudgetPauseObservationReader,
} from "../../engine/dag/budgetPauseObservation.js";
import { ProjectStore } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";
import { createLogger } from "../../engine/observability/logger.js";
import { projectConfigConflict } from "./configConflict.js";
// Re-export so routes/projects/index.ts can share the helper without exceeding max-dependencies.
export { projectConfigConflict };

const log = createLogger("budget");

// `ceilingUsd: null` clears the project's own budget; a number (with an optional
// period) sets it. `period` defaults to the same default the config schema uses. The
// ceiling ALWAYS gates REAL spend (`cost_records.cost_usd`) — that is the doctrine, so
// there is no "which figure" knob; the notional figure is surfaced but never gated.
// `revision` is the one-shot CAS token from the last budget/project GET.
export const BudgetPutSchema = z
  .object({
    ceilingUsd: z.number().nonnegative().nullable(),
    period: z.enum(["monthly", "quarterly", "annual", "total"]).optional(),
    revision: ConfigRevisionSchema,
  })
  .strict();

/** Full-document project config PATCH — revision uses the shared closed range. */
export const ProjectPatchSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  /** Expected config_revision from the last GET — one-shot CAS token. */
  revision: ConfigRevisionSchema,
});

/**
 * The read-shape both GET and PUT return — the behavior-proof + operator surface.
 *
 * Vocabulary discipline (FOCUS-aligned): `spentUsd` is REAL money out the door
 * (BilledCost; the figure the ceiling ALWAYS gates — the doctrine). `notionalUsd` is
 * the API-EQUIVALENT, list-priced ESTIMATE (ListCost) over the SAME period — surfaced
 * so a subscription org sees a non-zero figure; it is NOT spend and is NEVER gated.
 * `remainingUsd` is the headroom against real spend.
 */
export interface BudgetView {
  ceilingUsd: number | null;
  period: "monthly" | "quarterly" | "annual" | "total";
  /** REAL spend over the period (the gated figure — the ceiling always gates real spend). */
  spentUsd: number;
  /** Notional / API-equivalent value over the same period (NOT spend, NOT gated). */
  notionalUsd: number;
  remainingUsd: number | null;
  paused: boolean;
  /** Latest durable project-level DagWalker pause proof; never synthesized. */
  pauseObservation: BudgetPauseObservation | null;
  /**
   * Fail-closed safety reason when the gate pauses because true spend cannot be
   * trusted (`unpriced_spend` / `unparseable_config` / `unresolvable_project_org`).
   * Null when the pause (if any) is a genuine ceiling-reached halt or the gate is open.
   * Surfaced so the operator UI can avoid painting placeholder/partial zeros as real spend.
   */
  failClosed: "unpriced_spend" | "unparseable_config" | "unresolvable_project_org" | null;
  /**
   * How many rows in the period are UN-PRICED real spend (NULL `cost_usd` on a
   * real-spend-bearing billing mode) — the exact population behind
   * `failClosed: 'unpriced_spend'`. `null` when the gate did not measure it (no
   * ceiling configured, or an earlier fail-closed short-circuited the sum). Surfaced
   * so an operator sees the SCALE of what could not be priced rather than a bare
   * flag whose only advertised remedy (raise the ceiling) is inert against it.
   */
  unpricedCount: number | null;
  /** Application config generation for one-shot CAS on PUT. */
  revision: string;
}

function toView(
  state: ProjectBudgetState,
  pauseObservation: BudgetPauseObservation | null,
  revision: string,
): BudgetView {
  const ceilingUsd = state.ceilingUsd ?? null;
  return {
    ceilingUsd,
    period: state.period,
    spentUsd: state.spentUsd,
    notionalUsd: state.notionalUsd,
    // Headroom is measured against REAL spend (the gated figure) — never notional.
    remainingUsd: ceilingUsd === null ? null : Math.max(0, ceilingUsd - state.spentUsd),
    // BUDGET-SAFETY (C1b/M5): a fail-closed safety pause shows as paused too, not
    // just the genuine ceiling-reached case.
    paused: shouldPauseOnBudget(state),
    pauseObservation,
    failClosed: state.failClosed ?? null,
    unpricedCount: state.unpricedCount ?? null,
    revision,
  };
}

async function pauseObservationFor(
  pool: pg.Pool,
  orgId: string,
  projectId: string,
  state: ProjectBudgetState,
): Promise<BudgetPauseObservation | null> {
  // The budget state decides whether the project is paused. The event projection
  // only explains an active pause; an open gate never replays a historical halt
  // as if it were current.
  if (!shouldPauseOnBudget(state)) return null;
  return new PgBudgetPauseObservationReader(pool).latest(orgId, projectId);
}

/** GET handler: resolve the project's budget state + render the observation view. */
export async function handleBudgetGet(c: Context, pool: pg.Pool, orgId: string, projectId: string): Promise<Response> {
  const ownership = await ProjectStore.getOwnership(pool, projectId, systemActor);
  if (ownership === undefined || (ownership.orgId !== null && ownership.orgId !== orgId)) {
    return c.json({ error: "project_not_found" }, 404);
  }
  const snapshot = await ProjectStore.getConfigSnapshot(pool, projectId, systemActor);
  if (snapshot === undefined) {
    return c.json({ error: "project_not_found" }, 404);
  }
  const state = await new PgBudgetGate(pool).resolveBudget(projectId);
  const pauseObservation = await pauseObservationFor(pool, orgId, projectId, state);
  return c.json(toView(state, pauseObservation, snapshot.revision));
}

/**
 * PUT handler: one-shot revision CAS over `projects.config.budget`. Merges
 * budget fields once against the snapshot that matches `body.revision`; never
 * silently auto-retries a stale human write. `ceilingUsd: null` clears the
 * project budget (org default / unlimited then applies).
 */
export async function handleBudgetPut(
  c: Context,
  pool: pg.Pool,
  orgId: string,
  projectId: string,
  body: z.infer<typeof BudgetPutSchema>,
): Promise<Response> {
  const ownership = await ProjectStore.getOwnership(pool, projectId, systemActor);
  if (ownership === undefined || (ownership.orgId !== null && ownership.orgId !== orgId)) {
    return c.json({ error: "project_not_found" }, 404);
  }

  // The PRE-write resolved state — so a ceiling RAISE that re-animates a budget-paused
  // project can fire the re-walk wake below (audit §3.7e).
  const before = await new PgBudgetGate(pool).resolveBudget(projectId);

  const snapshot = await ProjectStore.getConfigSnapshot(pool, projectId, systemActor);
  if (snapshot === undefined) {
    return c.json({ error: "project_not_found" }, 404);
  }
  if (snapshot.revision !== body.revision) {
    return c.json(projectConfigConflict(orgId, projectId, snapshot.revision), 409);
  }
  const current = migrateProjectConfig(snapshot.config);
  const nextConfig = {
    ...current,
    budget:
      body.ceilingUsd === null
        ? undefined
        : {
            ceilingUsd: body.ceilingUsd,
            period: body.period ?? DEFAULT_BUDGET_PERIOD,
          },
  };
  // Round-trip through the versioned parser so the persisted blob is always a valid
  // ProjectConfigV1 (drops the `budget` key entirely when cleared — `.strict()`).
  const validated = migrateProjectConfig(nextConfig);
  const outcome = await ProjectStore.compareAndSwapConfig(pool, projectId, body.revision, validated, systemActor);
  if (outcome.status === "not_found") {
    return c.json({ error: "project_not_found" }, 404);
  }
  if (outcome.status === "conflict") {
    return c.json(projectConfigConflict(orgId, projectId, outcome.current.revision), 409);
  }

  const state = await new PgBudgetGate(pool).resolveBudget(projectId);
  const pauseObservation = await pauseObservationFor(pool, orgId, projectId, state);

  // RESUME WAKE (audit §3.7e): the DagWalker is driven by the LISTEN/NOTIFY bus, and a
  // project PAUSED on budget has NO run-terminal / spec-insert notification to re-walk
  // it — so without an explicit wake here, raising the ceiling would leave it paused
  // until the periodic backstop (§3.13a) or a worker reboot. When the write LOOSENS the
  // gate — the project WAS paused and is now NOT (a raised ceiling, a cleared budget, a
  // rolled period) — fire a `tanren_dag` re-walk so the freed headroom is picked up
  // immediately. Best-effort (a NOTIFY failure must not fail the budget write); the
  // backstop tick is the safety net regardless.
  if (shouldPauseOnBudget(before) && !shouldPauseOnBudget(state)) {
    try {
      await notifyDagChanged(pool, projectId);
    } catch (error) {
      log.error("failed to emit re-walk wake after un-pausing project", { projectId }, error);
    }
  }

  return c.json(toView(state, pauseObservation, outcome.revision));
}
