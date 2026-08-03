// The pg-backed BudgetGate (autonomy-engine.md §3 proof 6): the DagWalker's
// dollar-budget seam. It resolves a project's configured ceiling — the project's
// own `budget` over the org's `defaultBudget` (project-over-org, exactly how the
// rest of the config layers) — and, when a ceiling is set, sums the project's
// CUMULATIVE SPEND over the configured period from `cost_records` (the dollar
// column `cost_usd`). The walker consults this BEFORE enqueuing: a reached ceiling
// pauses the tick on budget. A project with NO budget configured resolves
// `ceilingUsd: undefined` (unlimited) and skips the sum entirely, so the no-budget
// path is byte-identical to before this gate existed.
//
// Period semantics (the sum window):
//   - `monthly` — the CURRENT CALENDAR MONTH (UTC): records since
//                 `date_trunc('month', now())`. A fresh window opens each month.
//   - `total`   — the project's LIFETIME: every cost record for the project.
//
// RLS: the cost-sum read runs on the ORG-SCOPED client (resolve the project's org
// system-scoped first, then sum under that org). An off-scope read sees zero rows
// (RLS denies by default), so the spend is always exactly the calling org's. This
// mirrors PgDagReadModel's resolve-org-then-read-scoped pattern.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { DEFAULT_BUDGET_PERIOD, type BudgetPeriod } from "../config/index.js";
import { migrateOrgConfig } from "../config/orgConfig.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import type { ProjectBudget } from "../config/shared.js";
import type { BudgetGate, ProjectBudgetState } from "../contracts/dagWalker.js";
import { isPool, type QueryClient } from "../data/orgScopedDb.js";

/**
 * The result of resolving a project's effective budget. We DISTINGUISH the three
 * honestly-different states (BUDGET-SAFETY M5) so the gate can fail loud on the
 * dangerous one rather than collapse them all into "unlimited":
 *   - `{ budget }`        — a parseable budget (project-over-org). undefined budget
 *                           ⇒ genuinely ABSENT ⇒ legitimately unlimited.
 *   - `{ unparseable }`   — a PRESENT-but-undecodable config blob. NOT unlimited:
 *                           the gate fails CLOSED rather than fail OPEN to unbounded
 *                           spend on a config it cannot read.
 */
export type EffectiveBudgetResolution = { kind: "ok"; budget: ProjectBudget | undefined } | { kind: "unparseable" };

/**
 * Resolve the EFFECTIVE budget for a project: the project's own `budget` wins; else
 * the org's `defaultBudget`; else undefined (no ceiling). A whole-object override
 * (the project either sets a complete budget or inherits the org's complete one) —
 * matching the `ProjectBudget` shape, which carries a required `ceilingUsd`.
 *
 * BUDGET-SAFETY (M5): a PRESENT-but-unparseable config blob is NOT silently treated
 * as "no budget" (which fails OPEN to unlimited). It returns `{ kind: 'unparseable' }`
 * so the gate fails CLOSED. A genuinely ABSENT budget (a parseable config that simply
 * sets none) is still legitimately unlimited.
 */
export function resolveEffectiveBudget(projectConfigRaw: unknown, orgConfigRaw: unknown): EffectiveBudgetResolution {
  let projectBudget: ProjectBudget | undefined;
  try {
    projectBudget = migrateProjectConfig(projectConfigRaw).budget;
  } catch {
    return { kind: "unparseable" };
  }
  if (projectBudget !== undefined) return { kind: "ok", budget: projectBudget };
  try {
    return { kind: "ok", budget: migrateOrgConfig(orgConfigRaw).defaultBudget };
  } catch {
    return { kind: "unparseable" };
  }
}

/**
 * Prefer an injected gate (tests); else build {@link PgBudgetGate} when `pool`
 * is a real `pg.Pool`. Uses `isPool` so workflow callers need no cast.
 */
export function resolveBudgetGate(pool: QueryClient, injected?: BudgetGate): BudgetGate {
  if (injected !== undefined) return injected;
  if (isPool(pool)) return new PgBudgetGate(pool);
  throw new Error("budget gate requires a real pg.Pool when not injected");
}

/** The pg-backed budget gate the production walker uses. */
export class PgBudgetGate implements BudgetGate {
  constructor(private readonly pool: pg.Pool) {}

  async resolveBudget(projectId: string): Promise<ProjectBudgetState> {
    const owner = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null; config: unknown }>(
        "SELECT org_id, config FROM projects WHERE project_id = $1",
        [projectId],
      );
      const row = result.rows[0];
      return row === undefined ? null : { orgId: row.org_id, projectConfig: row.config };
    });
    if (owner === null || owner.orgId === null) {
      // BUDGET-SAFETY (Codex critic #11): a MISSING project row OR a NULL org_id
      // is NOT "no budget configured" (which would silently fail OPEN to
      // unlimited — the intended ceiling would be bypassed by an
      // ownership-corruption / in-flight-migration read failure). "Budget is the
      // only run gate" — an ordinary read failure must never let spend run past
      // the operator's intended ceiling. Fail CLOSED: the walker pauses on budget
      // with `unresolvable_project_org` so operators can distinguish it from an
      // intentional ceiling-reached pause. The cost-sum read is genuinely skipped
      // (there is no org to scope it to; an off-scope read would see zero rows).
      return {
        ceilingUsd: undefined,
        period: DEFAULT_BUDGET_PERIOD,
        spentUsd: 0,
        notionalUsd: 0,
        failClosed: "unresolvable_project_org",
      };
    }
    const orgConfig = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [
        owner.orgId,
      ]);
      return result.rows[0]?.config;
    });

    const resolution = resolveEffectiveBudget(owner.projectConfig, orgConfig);
    if (resolution.kind === "unparseable") {
      // BUDGET-SAFETY (M5): a PRESENT-but-unparseable budget config must NOT fail
      // OPEN to unlimited. Fail CLOSED — the walker pauses and narrates the reason.
      return {
        ceilingUsd: undefined,
        period: DEFAULT_BUDGET_PERIOD,
        spentUsd: 0,
        notionalUsd: 0,
        failClosed: "unparseable_config",
      };
    }
    const budget = resolution.budget;
    if (budget === undefined) {
      // Genuinely ABSENT budget ⇒ unlimited: skip the (otherwise unnecessary) sum.
      return {
        ceilingUsd: undefined,
        period: DEFAULT_BUDGET_PERIOD,
        spentUsd: 0,
        notionalUsd: 0,
      };
    }

    const { spentUsd, notionalUsd, unpricedCount } = await this.sumSpend(owner.orgId, projectId, budget.period);
    // BUDGET-SAFETY (C1b): with a configured ceiling, an UN-PRICED REAL-SPEND row in
    // the window means the true spend is UNKNOWN — it may already exceed the ceiling.
    // Do not assume $0; fail CLOSED. An un-priced real-spend row is a NULL-cost_usd
    // row whose billing_mode is REAL-spend-bearing — `per_token` (a metered API key
    // that captured NO real-spend FACT now that the static rate table is gone) OR
    // `unattributed` (an unrecognized ref). An HONESTLY-$0 subscription/self_hosted
    // NULL is NOT counted — a pure-subscription run never trips this.
    if (unpricedCount > 0) {
      return {
        ceilingUsd: budget.ceilingUsd,
        period: budget.period,
        spentUsd,
        notionalUsd,
        // LEGIBILITY: the count was already computed and then discarded. A bare
        // `unpriced_spend` flag tells an operator nothing about the SCALE of what
        // could not be priced — and, crucially, nothing about the fact that the
        // offending rows may be the current run's OWN (in which case raising the
        // ceiling cannot clear the pause). Surface the number.
        unpricedCount,
        failClosed: "unpriced_spend",
      };
    }
    return {
      ceilingUsd: budget.ceilingUsd,
      period: budget.period,
      spentUsd,
      notionalUsd,
      unpricedCount: 0,
    };
  }

  /**
   * Sum the project's `cost_records.cost_usd` over the period, ORG-SCOPED (RLS), and
   * COUNT the UN-PRICED REAL-SPEND rows in the same window. `cost_usd` is nullable
   * (cost-unknown is an honest state) — COALESCE skips NULLs for the dollar sum; a
   * `monthly` window filters to the current calendar month, `total` sums all rows.
   * `unpricedCount` is the BUDGET-SAFETY (C1b) signal: NULL-cost rows whose
   * billing_mode bears REAL spend — `per_token` (a metered API key with no captured
   * real-spend FACT, now that the static rate table is gone) OR `unattributed` (an
   * unrecognized ref). An honestly-$0 subscription/self_hosted NULL is NOT counted.
   */
  private async sumSpend(
    orgId: string,
    projectId: string,
    period: BudgetPeriod,
  ): Promise<{ spentUsd: number; notionalUsd: number; unpricedCount: number }> {
    const windowClause = budgetWindowClause(period);
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{ total: string | null; notional: string | null; unpriced: string | null }>(
        `SELECT COALESCE(SUM(cost_usd::numeric), 0)::text AS total,
                COALESCE(SUM(notional_cost_usd::numeric), 0)::text AS notional,
                COUNT(*) FILTER (
                  WHERE cost_usd IS NULL AND (billing_mode = 'per_token' OR billing_mode = 'unattributed')
                )::text AS unpriced
           FROM cost_records
          WHERE project_id = $1${windowClause}`,
        [projectId],
      );
      const row = result.rows[0];
      return {
        spentUsd: Number(row?.total ?? "0"),
        notionalUsd: Number(row?.notional ?? "0"),
        unpricedCount: Number(row?.unpriced ?? "0"),
      };
    });
  }
}

/**
 * The `recorded_at` window clause for a budget period. `total` sums the project's
 * lifetime (no clause); every other period is a CALENDAR-anchored rolling window
 * via `date_trunc` (a fresh window opens at each calendar boundary). All values
 * are members of the frozen `BudgetPeriod` enum, so the trunc unit is a constant —
 * never user input — and the query stays parameter-free for the project id only.
 */
function budgetWindowClause(period: BudgetPeriod): string {
  switch (period) {
    case "monthly":
      return " AND recorded_at >= date_trunc('month', now())";
    case "quarterly":
      return " AND recorded_at >= date_trunc('quarter', now())";
    case "annual":
      return " AND recorded_at >= date_trunc('year', now())";
    case "total":
      return "";
    default: {
      const exhaustive: never = period;
      throw new Error(`budgetWindowClause: unhandled period ${String(exhaustive)}`);
    }
  }
}
