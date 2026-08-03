// Behavior tests for defaultRoutingAdapters — the production builder that
// resolves the run's four role adapters (plan/write/check/audit) from the
// project's effective routing table via the shared adapter selector. These pin
// the core claim of the routing-driven path: the writer/answerer providers come
// from DATA (the routing chain heads), and a missing/empty role chain is a HARD
// failure — never a silent Codex fallback.

import { describe, expect, it } from "vitest";
import { emptyRoutingTable, RoutingTable } from "../src/engine/config/shared.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { EmptyRoutingChainError } from "../src/engine/providers/adapterSelector.js";
import {
  defaultRoutingAdapters,
  resolveRunAdaptersWithBudgetPreflight,
} from "../src/engine/workflow/plannerRunAdapters.js";
import {
  UnenforceableBudgetCeilingError,
  UnreachableBudgetCeilingError,
} from "../src/engine/workflow/budgetPreflight.js";
import type { BudgetGate } from "../src/engine/contracts/dagWalker.js";
import type { AppendEvent } from "../src/engine/workflow/subtaskLoop.js";
import type { RoutingChainEntry } from "../src/engine/config/shared.js";
import type { PlannerRunAdapterContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

class NoopSsh implements CommandSubstrate {
  async run(_target: RunnerHandle, _command: RunnerCommand): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

// The minimal RunPlannerLoopInput defaultRoutingAdapters reads: secrets, ssh,
// and the run context's routing + optional endpoint override. The rest of the
// loop input is irrelevant to adapter construction.
function input(routing: RunPlannerLoopInput["context"]["routing"]): RunPlannerLoopInput {
  return {
    secrets: new InMemorySecretStore(),
    ssh: new NoopSsh(),
    context: {
      runId: "run_1",
      specId: "spec_1",
      projectId: "project_1",
      repoUrl: "https://example.invalid/repo",
      targetBranch: "main",
      runBranch: "tanren/x",
      specTitle: "t",
      specDescription: "d",
      acceptanceCriteria: [],
      runnerImage: "img",
      identitySecretRef: "id",
      githubCredentialRef: "cred/gh",
      routing,
    },
  } as unknown as RunPlannerLoopInput;
}

const ctx: PlannerRunAdapterContext = { runId: "run_1", target, codexHome: "/home/tanren/.codex/run_1" };

describe("defaultRoutingAdapters", () => {
  it("selects each role's adapter from the project routing table (not a Codex hardcode)", () => {
    const routing = RoutingTable.parse({
      plan: { chain: [{ cli: "claude", model: "claude-opus-4-8", authRef: "cred/claude" }] },
      write: { chain: [{ cli: "opencode", model: "zai/glm-5.1", authRef: "cred/opencode" }] },
      check: { chain: [{ cli: "codex", model: "default", authRef: "cred/codex" }] },
      audit: { chain: [{ cli: "claude", model: "claude-opus-4-8", authRef: "cred/claude" }] },
    });
    const adapters = defaultRoutingAdapters(input(routing), ctx);
    expect(adapters.planner.cli).toBe("claude");
    expect(adapters.writer.cli).toBe("opencode");
    expect(adapters.checker.cli).toBe("codex");
    expect(adapters.auditor.cli).toBe("claude");
  });

  it("yields Codex adapters when the routing data heads every role with Codex (the default)", () => {
    const routing = RoutingTable.parse({
      plan: { chain: [{ cli: "codex", model: "default", authRef: "cred/codex" }] },
      write: { chain: [{ cli: "codex", model: "default", authRef: "cred/codex" }] },
      check: { chain: [{ cli: "codex", model: "default", authRef: "cred/codex" }] },
      audit: { chain: [{ cli: "codex", model: "default", authRef: "cred/codex" }] },
    });
    const adapters = defaultRoutingAdapters(input(routing), ctx);
    expect(adapters.writer.cli).toBe("codex");
    expect(adapters.planner.cli).toBe("codex");
  });

  it("hard-fails (no Codex fallback) when a required role's chain is empty", () => {
    // An empty routing table leaves every loop role unresolvable; the selector
    // throws EmptyRoutingChainError rather than silently defaulting to Codex.
    expect(() => defaultRoutingAdapters(input(emptyRoutingTable()), ctx)).toThrow(EmptyRoutingChainError);
  });

  it("hard-fails when the run context carries no routing at all", () => {
    const noRouting: RunPlannerLoopInput["context"]["routing"] = undefined;
    expect(() => defaultRoutingAdapters(input(noRouting), ctx)).toThrow(/routing is required/u);
  });
});

// The usage probe (codexbar/ccusage) is CODEX-specific. resolveRunAdaptersWithBudgetPreflight
// builds it when ANY role adapter is codex (so codex window pressure is observed even in a
// mixed route); ceiling reachability is then gated on the WRITER being codex+probed, so a
// non-codex subscription writer still FAILS CLOSED.
function routingAll(cli: string, authRef: string): RoutingTable {
  const entry: RoutingChainEntry = { cli, model: "default", authRef };
  const chain = { chain: [entry] };
  return { plan: chain, write: chain, check: chain, audit: chain, demo: chain, forge: chain };
}
function budgetGateWithCeiling(ceilingUsd: number | undefined): BudgetGate {
  return {
    resolveBudget: async () => ({ ceilingUsd }) as unknown as Awaited<ReturnType<BudgetGate["resolveBudget"]>>,
  };
}
function preflightInput(routing: RoutingTable, ceilingUsd?: number): RunPlannerLoopInput {
  return { ...input(routing), budgetGate: budgetGateWithCeiling(ceilingUsd) } as unknown as RunPlannerLoopInput;
}
const noopAppend: AppendEvent = async () => {};

// A real recording sink (no spies — this repo's `no-mock-only-tests` lint rejects
// assertions that only check a spy was called, and the allowlist is empty).
function recorder(): { events: Array<{ eventType: string; payload: unknown }>; append: AppendEvent } {
  const events: Array<{ eventType: string; payload: unknown }> = [];
  const append = (async (eventType: string, payload: unknown) => {
    events.push({ eventType, payload });
  }) as AppendEvent;
  return { events, append };
}

describe("resolveRunAdaptersWithBudgetPreflight — codex-only usage probe gating", () => {
  it("fails closed for a NON-codex (claude) subscription default with a ceiling — no codex probe is built", async () => {
    const routing = routingAll("claude", "credential/claude/org/o1/default");
    await expect(
      resolveRunAdaptersWithBudgetPreflight(preflightInput(routing, 50), ctx, noopAppend),
    ).rejects.toBeInstanceOf(UnreachableBudgetCeilingError);
  });

  it("builds the codex probe for a codex default, so the subscription ceiling is reachable", async () => {
    const routing = routingAll("codex", "credential/codex/org/o1/default");
    const { usageProbe } = await resolveRunAdaptersWithBudgetPreflight(preflightInput(routing, 50), ctx, noopAppend);
    expect(usageProbe).toBeDefined();
  });

  it("builds the codex probe when codex is only in ANSWERER roles (mixed route) — codex window still observed", async () => {
    // writer=claude, answerers=codex: codex subscription is consumed by the
    // answerers, so the probe MUST be built (the round-2 mixed-route gap). No
    // ceiling here, so the writer-observability question is isolated out.
    const codexChain = { chain: [{ cli: "codex", model: "default", authRef: "credential/codex/org/o1/default" }] };
    const mixed: RoutingTable = {
      plan: codexChain,
      write: { chain: [{ cli: "claude", model: "claude-opus-4-8", authRef: "credential/claude/org/o1/default" }] },
      check: codexChain,
      audit: codexChain,
      demo: codexChain,
      forge: codexChain,
    };
    const { usageProbe } = await resolveRunAdaptersWithBudgetPreflight(preflightInput(mixed), ctx, noopAppend);
    expect(usageProbe).toBeDefined();
  });
});

// THE PRODUCTION WIRING of the BUDGET-SAFETY meterability refusal. `budgetPreflight.ts`
// proves the refusal in isolation; these prove it is actually REACHED — the run-setup
// path builds the adapters, reads the WRITER's (cli × credential) route off the real
// routing table, and puts it through `runBudgetCeilingPreflight`. Without this, the
// refusal is proven only for a function nothing proves is called (exactly the
// wired-to-nothing shape `fix/brownfield-config-injection-safety` exists to fix).
// Asserted on the OBSERVABLE outcome: the rejection's error class + kind, and the
// events that actually landed on the run's timeline — never on a spy call count.
describe("resolveRunAdaptersWithBudgetPreflight — the meterability refusal reaches the run-setup path", () => {
  it("REFUSES a codex × OpenRouter run with a ceiling, and lands both events on the run timeline", async () => {
    // The BYOK shape a real tanren run carries: every role routed through
    // `codex exec --json` pointed at OpenRouter, with a project dollar ceiling.
    const routing = routingAll("codex", "credential/openrouter/acme/default");
    const sink = recorder();
    const thrown = await resolveRunAdaptersWithBudgetPreflight(preflightInput(routing, 50), ctx, sink.append).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(UnenforceableBudgetCeilingError);
    // The UNENFORCEABLE shape (a permanent, unclearable gate latch), NOT the
    // pre-existing M6 `unreachable` one — the two are symmetric opposites and the
    // call site must surface the right one for this route.
    expect((thrown as UnenforceableBudgetCeilingError).kind).toBe("unenforceable");
    expect((thrown as UnenforceableBudgetCeilingError).refKind).toBe("credential/openrouter/acme");
    // Narration first (unconditional), then the loud refusal — in that order.
    expect(sink.events.map((e) => e.eventType)).toEqual(["cost.route_unmeterable", "cost.ceiling_unenforceable"]);
    expect(sink.events[1]?.payload).toMatchObject({ reason: "harness_discards_generation_id", ceilingUsd: 50 });
  });

  it("still NARRATES the unmeterable route on an UNBUDGETED run, and lets it proceed", async () => {
    // No ceiling ⇒ nothing to refuse, but the operator would otherwise discover the
    // run's all-NULL cost_usd only from a $0 spend report. The narrate call is
    // unconditional inside `runBudgetCeilingPreflight`, so this is the assertion that
    // the setup path calls it at all rather than only on the throwing branch.
    const routing = routingAll("codex", "credential/openrouter/acme/default");
    const sink = recorder();
    const { adapters } = await resolveRunAdaptersWithBudgetPreflight(preflightInput(routing), ctx, sink.append);
    expect(adapters.writer.cli).toBe("codex");
    expect(sink.events.map((e) => e.eventType)).toEqual(["cost.route_unmeterable"]);
    // Secret-free: the credential NAME segment ("default") is stripped from the event.
    expect(sink.events[0]?.payload).toMatchObject({ cli: "codex", refKind: "credential/openrouter/acme" });
  });

  it("stays QUIET and proceeds on a meterable route with a ceiling (the working path emits nothing)", async () => {
    // The negative control for the two above: a codex subscription writer WITH the
    // codex probe is both meterable and enforceable, so the same setup path must emit
    // no cost events and return adapters normally.
    const routing = routingAll("codex", "credential/codex/org/o1/default");
    const sink = recorder();
    const { usageProbe } = await resolveRunAdaptersWithBudgetPreflight(preflightInput(routing, 50), ctx, sink.append);
    expect(usageProbe).toBeDefined();
    expect(sink.events).toEqual([]);
  });
});
