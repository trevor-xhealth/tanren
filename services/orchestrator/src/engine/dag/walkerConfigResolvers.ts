// The walker's PER-PROJECT CONFIG RESOLVERS, split out of `walker.ts` for the 500-line cap:
// the speculation knobs (autonomy-engine.md §2c) and the concurrency ceiling (§1.4). Both
// resolve a GOVERNED knob from the project's (and, for the ceiling, its org's) persisted
// versioned config — never an env var.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import {
  DEFAULT_SPECULATION_THRESHOLD,
  DEFAULT_SPECULATIVE_INTEGRATION_DEPTH,
  resolveWorkerConcurrency,
  type WorkerConcurrencyLayers,
} from "../config/index.js";
import { migrateOrgConfig } from "../config/orgConfig.js";
import { isAbsentProjectConfig, migrateProjectConfig } from "../config/projectConfig.js";
import type { DagEventEmitter } from "./walkerPg.js";
import type { ConcurrencyResolver, SpeculationConfig, SpeculationConfigResolver } from "./walker.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("dag-walker");

/**
 * Resolve a project's speculation config (threshold + depth cap) from its versioned project
 * config — the §2c knobs, never an env var. An ABSENT config (`{}` / no `version` — the default
 * a fresh project carries) legitimately uses the schema defaults (moderate / depth 2).
 *
 * no_silent_fallbacks (LOUD-DEFAULT): these knobs gate WORK (speculation eagerness), NOT MERGE —
 * so a corrupt PRESENT config still falls back to the safe schema default rather than failing
 * closed. But the corruption is NEVER silently swallowed: it is logged LOUD and surfaced as a
 * `dag.config.corrupt` observability event, then the default is applied. (Contrast the
 * github-identity / batch-cap resolvers, where a corrupt config yields WRONG behavior and
 * therefore PROPAGATES.)
 */
export function buildSpeculationConfigResolver(pool: pg.Pool, events?: DagEventEmitter): SpeculationConfigResolver {
  return async (projectId: string): Promise<SpeculationConfig> => {
    const config = await runWithSystemScope(pool, async (client) => {
      const result = await client.query<{ config: unknown }>("SELECT config FROM projects WHERE project_id = $1", [
        projectId,
      ]);
      return result.rows[0]?.config;
    });
    // An absent config is not corruption — it simply carries no §2c overrides.
    if (isAbsentProjectConfig(config)) {
      return { threshold: DEFAULT_SPECULATION_THRESHOLD, depthCap: DEFAULT_SPECULATIVE_INTEGRATION_DEPTH };
    }
    try {
      const parsed = migrateProjectConfig(config);
      return { threshold: parsed.speculationThreshold, depthCap: parsed.speculativeIntegrationDepth };
    } catch (error) {
      const appliedDefault = {
        threshold: DEFAULT_SPECULATION_THRESHOLD,
        depthCap: DEFAULT_SPECULATIVE_INTEGRATION_DEPTH,
      };
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("corrupt project config resolving speculation knobs; applying safe default", {
        projectId,
        default: appliedDefault,
        reason,
      });
      await events?.emitConfigCorrupt({ projectId, knob: "speculation_config", appliedDefault, reason });
      return appliedDefault;
    }
  };
}

// ---- The concurrency ceiling (autonomy-engine.md §1.4) --------------------
//
// The governed `allocator.concurrency` knob, resolved from the config the operator
// actually SAVED: the project's own override over its org's default over the schema
// default (project-over-org, the same layering `resolveEffectiveBudget` /
// `resolveCreditUsdRate` use).
//
// Before this resolver the walker resolved its ceiling by parsing an EMPTY
// `AllocatorConfig`, so every persisted project/org `allocator.concurrency` was
// silently discarded and every project planned against the schema default.
//
// no_silent_fallbacks (LOUD-DEFAULT): the ceiling gates WORK (how many runs start), not
// MERGE, so an unparseable PRESENT config falls through to the next layer rather than
// wedging scheduling — but never silently: it is logged LOUD. The same walk resolves the
// speculation knobs from the SAME `projects.config` blob and emits `dag.config.corrupt`
// for it, so a corrupt project config is already surfaced as an event; this resolver
// logs rather than emitting a second event for one blob.

/** The project row the ceiling is resolved from: its owning org + its own config blob. */
interface ProjectConfigRow {
  orgId: string | null;
  projectConfig: unknown;
}

/**
 * Build the production concurrency resolver: for the project being walked, read its
 * persisted `allocator.concurrency`, then its org's, and apply project-over-org-over-default.
 *
 * Reads system-scoped (the walker runs outside any single org's scope) exactly as
 * `PgBudgetGate` does: resolve the project row's `org_id` + config first, then that org's
 * config. A project with no resolvable org simply contributes no org layer.
 */
export function buildConcurrencyResolver(pool: pg.Pool): ConcurrencyResolver {
  return async (projectId: string): Promise<number> => {
    const row = await runWithSystemScope(pool, async (client) => {
      const result = await client.query<{ org_id: string | null; config: unknown }>(
        "SELECT org_id, config FROM projects WHERE project_id = $1",
        [projectId],
      );
      const found = result.rows[0];
      return found === undefined ? null : { orgId: found.org_id, projectConfig: found.config };
    });
    if (row === null) {
      return resolveWorkerConcurrency();
    }
    const layers: WorkerConcurrencyLayers = {
      project: projectConcurrencyLayer(projectId, row),
      org: row.orgId === null ? undefined : await orgConcurrencyLayer(pool, projectId, row.orgId),
    };
    return resolveWorkerConcurrency(layers);
  };
}

/** The project's own override, or undefined when it is absent / the blob will not parse. */
function projectConcurrencyLayer(projectId: string, row: ProjectConfigRow): number | undefined {
  // An absent config is not corruption — a fresh project simply carries no override.
  if (isAbsentProjectConfig(row.projectConfig)) {
    return undefined;
  }
  try {
    return migrateProjectConfig(row.projectConfig).allocator.concurrency;
  } catch (error) {
    log.warn("corrupt project config resolving the concurrency ceiling; falling through to the org/default layer", {
      projectId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** The org-level default, or undefined when the org row is missing / will not parse. */
async function orgConcurrencyLayer(pool: pg.Pool, projectId: string, orgId: string): Promise<number | undefined> {
  const config = await runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [orgId]);
    return result.rows[0]?.config;
  });
  if (config === undefined || config === null) {
    return undefined;
  }
  try {
    return migrateOrgConfig(config).allocator.concurrency;
  } catch (error) {
    log.warn("corrupt org config resolving the concurrency ceiling; falling through to the schema default", {
      projectId,
      orgId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
