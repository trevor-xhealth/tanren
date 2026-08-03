// BUDGET-SAFETY: the run-setup budget-ceiling preflight. A configured DOLLAR
// ceiling against a subscription/self-hosted credential with no usage probe is
// structurally UNREACHABLE — it must be surfaced LOUDLY (a cost.ceiling_unreachable
// event) and fail the run setup, never silently configured.
//
// The SYMMETRIC failure (a per_token route with no real-spend capture, where the
// ceiling instead fires permanently and unclearably) is covered in
// costsMeterability.test.ts + openRouterCostAttribution.integration.test.ts. This
// file pins the ORIGINAL M6 behavior across the rename to
// `assertBudgetCeilingEnforceable`, including the retained
// `UnreachableBudgetCeilingError` type.
import { describe, expect, it } from "vitest";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import type { AppendEvent } from "../src/engine/workflow/subtaskLoop.js";
import {
  assertBudgetCeilingEnforceable,
  UnenforceableBudgetCeilingError,
  UnreachableBudgetCeilingError,
} from "../src/engine/workflow/budgetPreflight.js";

interface Captured {
  eventType: EventName;
  payload: EventPayload<EventName>;
}

function recorder(): { append: AppendEvent; events: Captured[] } {
  const events: Captured[] = [];
  const append: AppendEvent = async (eventType, payload) => {
    events.push({ eventType, payload });
  };
  return { append, events };
}

describe("assertBudgetCeilingEnforceable — the M6 unreachable-ceiling half", () => {
  it("FAILS LOUD: a ceiling against a subscription credential with NO usage probe is unreachable", async () => {
    const r = recorder();
    await expect(
      assertBudgetCeilingEnforceable(
        { ceilingUsd: 50, cli: "codex", authRef: "credential/codex/pro", hasUsageProbe: false },
        r.append,
      ),
    ).rejects.toBeInstanceOf(UnreachableBudgetCeilingError);
    // A loud, secret-free event is emitted BEFORE the throw.
    expect(r.events.map((e) => e.eventType)).toEqual(["cost.ceiling_unreachable"]);
    expect(r.events[0]?.payload).toMatchObject({ refKind: "credential/codex", billingMode: "subscription" });
  });

  it("FAILS LOUD for a self-hosted credential with no usage probe too", async () => {
    const r = recorder();
    await expect(
      assertBudgetCeilingEnforceable(
        { ceilingUsd: 10, cli: "codex", authRef: "credential/self-hosted/qwen", hasUsageProbe: false },
        r.append,
      ),
    ).rejects.toBeInstanceOf(UnreachableBudgetCeilingError);
    expect(r.events[0]?.payload).toMatchObject({ billingMode: "self_hosted" });
  });

  it("is a NO-OP when a usage probe IS wired (the subscription ceiling becomes reachable)", async () => {
    const r = recorder();
    await assertBudgetCeilingEnforceable(
      { ceilingUsd: 50, cli: "codex", authRef: "credential/codex/pro", hasUsageProbe: true },
      r.append,
    );
    expect(r.events).toEqual([]);
  });

  it("a per-token credential is NOT an M6 unreachable case — it is judged on METERABILITY instead", async () => {
    // This used to be an unconditional no-op, on the (now stale) premise that "a
    // per_token credential prices every call from the provider table". The static
    // rate table is gone, so the question became whether the ROUTE can capture a
    // real-spend fact — and a raw upstream-provider key cannot (its charge is on an
    // invoice tanren cannot read), so the ceiling is refused as UNENFORCEABLE rather
    // than silently accepted and then latched by the budget gate.
    const r = recorder();
    await expect(
      assertBudgetCeilingEnforceable(
        { ceilingUsd: 50, cli: "claude", authRef: "credential/anthropic/prod", hasUsageProbe: false },
        r.append,
      ),
      // The UNENFORCEABLE shape — distinct from the M6 `unreachable` subclass above.
    ).rejects.toBeInstanceOf(UnenforceableBudgetCeilingError);
    expect(r.events.map((e) => e.eventType)).toEqual(["cost.ceiling_unenforceable"]);
    expect(r.events[0]?.payload).toMatchObject({ reason: "byok_upstream_invoice" });
  });

  it("is a NO-OP when no ceiling is configured (unlimited — today's behavior)", async () => {
    const r = recorder();
    await assertBudgetCeilingEnforceable(
      { ceilingUsd: undefined, cli: "codex", authRef: "credential/codex/pro", hasUsageProbe: false },
      r.append,
    );
    expect(r.events).toEqual([]);
  });

  it("NEVER leaks the secret value — only the ref KIND is in the event", async () => {
    const r = recorder();
    await expect(
      assertBudgetCeilingEnforceable(
        { ceilingUsd: 50, cli: "codex", authRef: "credential/self-hosted/super-secret-endpoint", hasUsageProbe: false },
        r.append,
      ),
    ).rejects.toBeInstanceOf(UnreachableBudgetCeilingError);
    expect(JSON.stringify(r.events[0]?.payload)).not.toContain("super-secret-endpoint");
  });
});
