// cspell:ignore METERABILITY unmeterable meterable UNMETERABLE
// Route METERABILITY — can a given (cli × credential) route ever produce a
// real-spend FACT? — plus the run-setup preflight that turns "no" into a loud,
// legible refusal instead of a mid-run deadlock.
//
// See docs/_design/openrouter-cost-attribution.md. No mocks: the module is pure,
// and the preflight is driven with a real recording sink.
import { describe, expect, it } from "vitest";
import {
  CODEX_VERSION_VERIFIED_WITHOUT_GENERATION_ID,
  isCeilingEnforceable,
  resolveRouteMetering,
} from "../src/engine/costs/meterability.js";
import {
  assertBudgetCeilingEnforceable,
  narrateRouteMetering,
  UnenforceableBudgetCeilingError,
  UnreachableBudgetCeilingError,
} from "../src/engine/workflow/budgetPreflight.js";
import type { AppendEvent } from "../src/engine/workflow/subtaskLoop.js";

// A real recording sink shaped like the loop's typed AppendEvent.
function recorder(): { events: Array<{ eventType: string; payload: unknown }>; append: AppendEvent } {
  const events: Array<{ eventType: string; payload: unknown }> = [];
  const append = (async (eventType: string, payload: unknown) => {
    events.push({ eventType, payload });
  }) as AppendEvent;
  return { events, append };
}

describe("resolveRouteMetering", () => {
  it("codex × OpenRouter is UNMETERABLE — the harness discards the generation id", () => {
    const metering = resolveRouteMetering({
      cli: "codex",
      authRef: "credential/openrouter/acme/default",
      hasUsageProbe: true,
    });
    expect(metering.kind).toBe("unmeterable");
    if (metering.kind !== "unmeterable") return;
    expect(metering.reason).toBe("harness_discards_generation_id");
    // The claim is DATED — a capability assertion about someone else's software
    // must say which version it was checked against.
    expect(metering.detail).toContain(CODEX_VERSION_VERIFIED_WITHOUT_GENERATION_ID);
    // ...and must state where the number is lost, not just that it is missing.
    expect(metering.detail).toContain("usage.cost");
    expect(isCeilingEnforceable(metering)).toBe(false);
  });

  it("a usage probe does NOT rescue a per_token route", () => {
    // ccusage/credit reconcile lands at run END, so a per_token route's rows are
    // NULL for the whole run and the per-iteration gate latches on them long before
    // any back-fill. The probe flag must not be mistaken for a metering path here.
    const withProbe = resolveRouteMetering({ cli: "codex", authRef: "credential/openrouter/a/b", hasUsageProbe: true });
    const without = resolveRouteMetering({ cli: "codex", authRef: "credential/openrouter/a/b", hasUsageProbe: false });
    expect(withProbe).toEqual(without);
  });

  it("a raw upstream-provider key is UNMETERABLE for a different, named reason", () => {
    for (const ref of ["credential/anthropic/acme/k", "credential/openai-api/acme/k"]) {
      const metering = resolveRouteMetering({ cli: "claude", authRef: ref, hasUsageProbe: false });
      expect(metering.kind).toBe("unmeterable");
      if (metering.kind !== "unmeterable") continue;
      // Distinct from the harness limitation: nothing upstream reports a per-call
      // dollar figure at all, so no harness fix would help.
      expect(metering.reason).toBe("byok_upstream_invoice");
    }
  });

  it("subscription / self-hosted / no-credential routes are reconcile routes, not limitations", () => {
    for (const ref of [
      "credential/codex/acme/default",
      "credential/claude/acme/default",
      "credential/self-hosted/gpu",
      "",
    ]) {
      expect(resolveRouteMetering({ cli: "codex", authRef: ref, hasUsageProbe: true }).kind).toBe("run_reconcile");
    }
  });

  it("an UNRECOGNIZED ref is NOT relabelled as a platform limitation", () => {
    // It is a misconfiguration (billing_mode='unattributed', BUDGET-SAFETY C1) with
    // its own loud path. Calling it "unmeterable" would launder an operator error
    // into "tanren cannot do this".
    const metering = resolveRouteMetering({ cli: "codex", authRef: "credential/mystery/prod", hasUsageProbe: false });
    expect(metering.kind).not.toBe("unmeterable");
  });
});

describe("narrateRouteMetering", () => {
  it("says so ONCE, even with no ceiling configured — an unbudgeted run's NULL cost is just as invisible", async () => {
    const sink = recorder();
    await narrateRouteMetering(
      { cli: "codex", authRef: "credential/openrouter/acme/default", hasUsageProbe: true },
      sink.append,
    );
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.eventType).toBe("cost.route_unmeterable");
    expect(sink.events[0]?.payload).toMatchObject({
      cli: "codex",
      // The secret NAME segment is stripped; only the KIND is narrated.
      refKind: "credential/openrouter/acme",
      reason: "harness_discards_generation_id",
    });
  });

  it("stays silent on a meterable route (the working path is quiet)", async () => {
    const sink = recorder();
    await narrateRouteMetering({ cli: "codex", authRef: "credential/codex/a/b", hasUsageProbe: true }, sink.append);
    expect(sink.events).toHaveLength(0);
  });
});

describe("assertBudgetCeilingEnforceable", () => {
  it("REFUSES a ceiling over an unmeterable per_token route, before any money is spent", async () => {
    const sink = recorder();
    await expect(
      assertBudgetCeilingEnforceable(
        { ceilingUsd: 50, cli: "codex", authRef: "credential/openrouter/acme/default", hasUsageProbe: true },
        sink.append,
      ),
    ).rejects.toBeInstanceOf(UnenforceableBudgetCeilingError);
    expect(sink.events.map((e) => e.eventType)).toEqual(["cost.ceiling_unenforceable"]);
    expect(sink.events[0]?.payload).toMatchObject({
      remedy: expect.stringContaining("OpenRouter API key") as unknown as string,
    });
  });

  it("names the OTHER remedy for an upstream-invoice credential", async () => {
    const sink = recorder();
    await expect(
      assertBudgetCeilingEnforceable(
        { ceilingUsd: 50, cli: "claude", authRef: "credential/anthropic/acme/k", hasUsageProbe: false },
        sink.append,
      ),
    ).rejects.toBeInstanceOf(UnenforceableBudgetCeilingError);
    expect(sink.events[0]?.payload).toMatchObject({ reason: "byok_upstream_invoice" });
  });

  it("still enforces the ORIGINAL M6 unreachable-ceiling check (subscription, no probe)", async () => {
    const sink = recorder();
    const thrown = await assertBudgetCeilingEnforceable(
      { ceilingUsd: 50, cli: "codex", authRef: "credential/codex/acme/default", hasUsageProbe: false },
      sink.append,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    // The pre-existing error TYPE is preserved for existing catchers.
    expect(thrown).toBeInstanceOf(UnreachableBudgetCeilingError);
    expect((thrown as UnenforceableBudgetCeilingError).kind).toBe("unreachable");
    expect(sink.events.map((e) => e.eventType)).toEqual(["cost.ceiling_unreachable"]);
  });

  it("passes a subscription route WITH a probe, and any route with NO ceiling", async () => {
    const sink = recorder();
    await expect(
      assertBudgetCeilingEnforceable(
        { ceilingUsd: 50, cli: "codex", authRef: "credential/codex/acme/default", hasUsageProbe: true },
        sink.append,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertBudgetCeilingEnforceable(
        { ceilingUsd: undefined, cli: "codex", authRef: "credential/openrouter/acme/default", hasUsageProbe: false },
        sink.append,
      ),
    ).resolves.toBeUndefined();
    expect(sink.events).toHaveLength(0);
  });
});
