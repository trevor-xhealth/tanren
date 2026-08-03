// cspell:ignore unmeterable meterable ttft PQEF Twnkf
// NEGATIVE CONTROL for the OpenRouter cost-attribution deadlock
// (docs/_design/openrouter-cost-attribution.md).
//
// Two halves, both driven by REAL artifacts (no SQL mocks, no vi.mock):
//
//  A. THE ID LOSS — real `codex exec --json` bytes (codex-cli 0.145.0, captured
//     live; see the fixture comment) pushed through the REAL adapter parser.
//     `findOpenRouterGenerationId` finds nothing, because the codex CLI re-emits
//     its OWN event vocabulary and never surfaces the upstream response envelope.
//     Consequence: `TokenUsage.openRouterGenerationId` is undefined on every
//     codex-routed call, so the per-call real-cost capture can never fire.
//
//  B. THE DEADLOCK — the REAL `CostRecorder` writing to a REAL Postgres with a
//     REAL `credential/openrouter/` ref and NO captured real-spend fact, then the
//     REAL `PgBudgetGate` over those rows. The run's OWN rows set
//     `failClosed: 'unpriced_spend'`, and RAISING THE CEILING DOES NOT CLEAR IT —
//     the project self-deadlocks.
//
//  C. THE FIX — the run-setup preflight refuses the run up front, naming the
//     route limitation, instead of letting it spend uncounted money and then park.
//
// Half A is pure and always runs. Halves B/C are gated behind
// TANREN_RLS_DB_TEST=1 + a migration-owner DATABASE_URL, like every other
// orchestrator pg-integration test.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { parseCodexJsonlTelemetry } from "../src/engine/providers/codex.js";
import { findOpenRouterGenerationId } from "../src/engine/providers/openRouterGenerationId.js";
import { CostRecorder } from "../src/engine/costs/index.js";
import { PgBudgetGate } from "../src/engine/dag/budgetGate.js";
import {
  assertBudgetCeilingEnforceable,
  UnenforceableBudgetCeilingError,
} from "../src/engine/workflow/budgetPreflight.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

// A VERBATIM `codex exec --json` stream, captured live from codex-cli 0.145.0:
//   printf 'Reply with exactly: ok' | codex exec --json --sandbox read-only \
//     --skip-git-repo-check --cd <dir> -
// Note what is and is NOT here: a codex-internal `thread_id` (a UUID, not `gen-`),
// a codex-internal `item.id` ("item_0" — an ORDINAL; codex does not even pass the
// upstream item id through), and a `usage` block of five TOKEN COUNTS with NO cost
// field and NO response/generation id at any nesting level.
const REAL_CODEX_EXEC_JSON_STREAM = [
  `{"type":"thread.started","thread_id":"019fc5dc-a605-7431-8a92-ed7c0d147d64"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":17665,"cached_input_tokens":11008,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}`,
  ``,
].join("\n");

// The bytes OpenRouter actually puts on the wire for the SAME call (captured from a
// MITM proxy standing in as codex's `base_url`). The id and the real dollar figure
// are BOTH present upstream — they are discarded by the codex CLI, not by OpenRouter.
const REAL_OPENROUTER_UPSTREAM_EVENT = {
  type: "response.completed",
  response: {
    id: "gen-1785730085-ifPQEF4jf7RVwCvTwnkf",
    usage: { input_tokens: 17665, output_tokens: 5, cost: 0.0011782784 },
  },
};

describe("A. the codex CLI discards the OpenRouter generation id (real bytes)", () => {
  it("OpenRouter DOES surface the id + the real cost upstream", () => {
    // Control: the finder is not broken — given the upstream envelope it works.
    expect(findOpenRouterGenerationId(REAL_OPENROUTER_UPSTREAM_EVENT)).toBe("gen-1785730085-ifPQEF4jf7RVwCvTwnkf");
  });

  it("codex exec --json surfaces NO generation id — so per-call capture can never fire", () => {
    const telemetry = parseCodexJsonlTelemetry(REAL_CODEX_EXEC_JSON_STREAM);
    // Tokens DO survive the CLI (the notional axis works)...
    expect(telemetry.tokenUsage?.totalTokens).toBe(17_670);
    // ...but the id does not, on any event, at any nesting level.
    expect(telemetry.openRouterGenerationId).toBeUndefined();
    expect(telemetry.tokenUsage?.openRouterGenerationId).toBeUndefined();
    for (const line of REAL_CODEX_EXEC_JSON_STREAM.split("\n").filter((l) => l !== "")) {
      expect(findOpenRouterGenerationId(JSON.parse(line) as Record<string, unknown>)).toBeUndefined();
    }
  });

  it("codex's re-emitted usage carries NO cost field — no fact is derivable from it", () => {
    const turnCompleted = JSON.parse(REAL_CODEX_EXEC_JSON_STREAM.split("\n")[3] as string) as {
      usage: Record<string, unknown>;
    };
    expect(Object.keys(turnCompleted.usage).sort()).toEqual([
      "cache_write_input_tokens",
      "cached_input_tokens",
      "input_tokens",
      "output_tokens",
      "reasoning_output_tokens",
    ]);
    expect(turnCompleted.usage["cost"]).toBeUndefined();
  });
});

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const ORG = "org_or_cost";
const PROJECT = "proj_or_cost";
// The real BYOK OpenRouter credential shape a codex-through-OpenRouter run carries.
const OPENROUTER_REF = "credential/openrouter/acme/default";

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describeDb("B/C. the budget-gate deadlock a codex→OpenRouter run causes", () => {
  const database = `tanren_or_cost_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let ownerPool: Pool;
  let gate: PgBudgetGate;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    gate = new PgBudgetGate(ownerPool);

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG],
    );
    await setCeiling(50);
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description) VALUES ('spec_or', $1, $2, 't', 'd')`,
      [PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ('run_or', 'spec_or', $1, $2, 'cli', 'main', 'running')`,
      [PROJECT, ORG],
    );
    await ownerPool.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, started_at, agent_kind, cli, model)
       VALUES ('task_or', 'run_or', $1, 'write', 't', 'running', now(), 'writer', 'codex', NULL)`,
      [ORG],
    );

    // THE RUN'S OWN SPEND. Drive the REAL recorder with exactly what a
    // codex→OpenRouter writer call produces: real tokens parsed from the real
    // codex stream, and NO generation id ⇒ NO real-spend fact to capture.
    const telemetry = parseCodexJsonlTelemetry(REAL_CODEX_EXEC_JSON_STREAM);
    if (telemetry.tokenUsage?.openRouterGenerationId !== undefined) {
      throw new Error("fixture drift: the codex stream must carry NO generation id");
    }
    const recorder = new CostRecorder(ownerPool, new FakeEventStore());
    await runWithOrgScope(ownerPool, ORG, async () => {
      for (let call = 0; call < 3; call += 1) {
        await recorder.record(
          {
            runId: "run_or",
            taskId: "task_or",
            specId: "spec_or",
            projectId: PROJECT,
            orgId: ORG,
            cli: "codex",
            model: "openai/gpt-5.6-luna",
            authRef: OPENROUTER_REF,
            // The capture seam yields nothing: there was no id to query with.
            realProviderCostUsd: null,
          },
          telemetry.tokenUsage ?? {
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
          },
          {},
        );
      }
    });
  }, 60_000);

  afterAll(async () => {
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  async function setCeiling(ceilingUsd: number): Promise<void> {
    const config = JSON.stringify({ version: 1, budget: { ceilingUsd, period: "total" } });
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id, config)
       VALUES ($1, 'p', 'https://example.com/r.git', $2, $3::jsonb)
       ON CONFLICT (project_id) DO UPDATE SET config = EXCLUDED.config`,
      [PROJECT, ORG, config],
    );
  }

  it("every codex→OpenRouter row lands cost_usd NULL / per_token / unknown", async () => {
    const rows = await ownerPool.query<{
      cost_usd: string | null;
      billing_mode: string;
      cost_basis: string;
      total_tokens: number;
    }>("SELECT cost_usd, billing_mode, cost_basis, total_tokens FROM cost_records WHERE project_id = $1", [PROJECT]);
    expect(rows.rows).toHaveLength(3);
    for (const row of rows.rows) {
      expect(row.cost_usd).toBeNull();
      expect(row.billing_mode).toBe("per_token");
      expect(row.cost_basis).toBe("unknown");
      // Tokens ARE accounted — the loss is dollars only.
      expect(row.total_tokens).toBe(17_670);
    }
  });

  it("the run's OWN rows trip failClosed 'unpriced_spend', and the count is now legible", async () => {
    const state = await gate.resolveBudget(PROJECT);
    expect(state.ceilingUsd).toBe(50);
    expect(state.spentUsd).toBe(0);
    expect(state.failClosed).toBe("unpriced_spend");
    // The gate always computed this and then discarded it; a bare flag cannot tell
    // an operator whether one stray row or the whole window is unpriced.
    expect(state.unpricedCount).toBe(3);
  });

  it("RAISING THE CEILING DOES NOT CLEAR IT — the project self-deadlocks", async () => {
    for (const ceiling of [500, 50_000, 1_000_000_000]) {
      await setCeiling(ceiling);
      const state = await gate.resolveBudget(PROJECT);
      expect(state.ceilingUsd).toBe(ceiling);
      expect(state.failClosed).toBe("unpriced_spend");
    }
    await setCeiling(50);
  });

  // A sink that records what the preflight narrates, shaped like the loop's AppendEvent.
  function recordingAppendEvent(events: FakeEventStore) {
    return async (eventType: string, payload: unknown): Promise<void> => {
      await events.append({ orgId: ORG, projectId: PROJECT, eventType, payload } as never);
    };
  }

  it("C. THE FIX: the run-setup preflight refuses the run, naming the route limitation", async () => {
    const events = new FakeEventStore();
    const state = await gate.resolveBudget(PROJECT);
    const thrown = await assertBudgetCeilingEnforceable(
      { ceilingUsd: state.ceilingUsd, cli: "codex", authRef: OPENROUTER_REF, hasUsageProbe: true },
      recordingAppendEvent(events) as never,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(UnenforceableBudgetCeilingError);
    expect((thrown as UnenforceableBudgetCeilingError).kind).toBe("unenforceable");
    // The message must state the thing the operator would otherwise get wrong.
    expect((thrown as Error).message).toMatch(/RAISING THE CEILING WILL NOT CLEAR THE PAUSE/u);
    // ...and point at the remedy that DOES work (the biller enforces it).
    expect((thrown as Error).message).toMatch(/spend limit on the OpenRouter API key/u);
    const emitted = events.events.find((e) => e.eventType === "cost.ceiling_unenforceable");
    expect(emitted).toBeDefined();
    expect(emitted?.payload).toMatchObject({
      cli: "codex",
      refKind: "credential/openrouter/acme",
      reason: "harness_discards_generation_id",
      billingMode: "per_token",
    });
  });

  it("C. NON-VACUOUS: the same preflight PASSES a route whose spend can be judged", async () => {
    // If the assert threw for everything, the test above would prove nothing. A codex
    // ChatGPT-subscription credential with a usage probe is priced by the run-end
    // ccusage/credit reconcile and its NULL rows are `subscription` (which the gate
    // does NOT count as unpriced) — so the SAME ceiling is enforceable there.
    const events = new FakeEventStore();
    const state = await gate.resolveBudget(PROJECT);
    await expect(
      assertBudgetCeilingEnforceable(
        { ceilingUsd: state.ceilingUsd, cli: "codex", authRef: "credential/codex/acme/default", hasUsageProbe: true },
        recordingAppendEvent(events) as never,
      ),
    ).resolves.toBeUndefined();
    expect(events.events).toHaveLength(0);
  });

  it("C. and it stays out of the way when NO ceiling is configured", async () => {
    // The refusal is scoped to a configured ceiling. An unbudgeted project on the
    // same unmeterable route still runs — it just gets narrated (see
    // `narrateRouteMetering` / `cost.route_unmeterable`), never blocked.
    const events = new FakeEventStore();
    await expect(
      assertBudgetCeilingEnforceable(
        { ceilingUsd: undefined, cli: "codex", authRef: OPENROUTER_REF, hasUsageProbe: true },
        recordingAppendEvent(events) as never,
      ),
    ).resolves.toBeUndefined();
    expect(events.events).toHaveLength(0);
  });
});
