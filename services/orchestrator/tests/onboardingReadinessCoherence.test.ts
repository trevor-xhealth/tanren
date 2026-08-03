// THE ONBOARDING↔RUNNABILITY COHERENCE CONTROL.
//
// The defect these pin: `GET /orgs/:orgId/onboarding-status` held `ready:false`
// until a dollar ceiling was set, while `assertBudgetCeilingEnforceable` FAILS THE
// RUN CLOSED at setup when that ceiling sits on a route whose spend cannot be
// metered (codex × OpenRouter — the harness discards the generation id). So the
// configuration onboarding CALLED ready was exactly the one that could not run, and
// tanren's own refusal event named the remedy — "remove the tanren dollar ceiling
// for this project" — i.e. make yourself un-`ready`.
//
// These are deliberately END-TO-END over the two REAL surfaces an operator meets:
//   1. the actual HTTP route (`createGithubConnectRoutes` → GET /onboarding-status);
//   2. the actual run-setup path (`resolveRunAdaptersWithBudgetPreflight` — the
//      function that refuses a run at setup), reading the SAME org/project rows
//      through the production `PgBudgetGate`.
// Nothing here asserts a helper's return value: the observable outcomes are the
// route's `ready`/`nextSteps`/`advisories`, whether the run-setup path resolves
// adapters or throws, and whether the walker's gate pauses at the ceiling.

import { describe, expect, it } from "vitest";
import type { RoutingChainEntry } from "../src/engine/config/shared.js";
import { shouldPauseOnBudget } from "../src/engine/contracts/dagWalker.js";
import { PgBudgetGate } from "../src/engine/dag/budgetGate.js";
import { UnenforceableBudgetCeilingError } from "../src/engine/workflow/budgetPreflight.js";
import { buildHarness, FULL_PERMISSIONS, reqJson } from "./helpers/githubConnectHarness.js";
import { startRunSetup } from "./helpers/runSetupHarness.js";

/** The route the live apex run actually carried: codex driving OpenRouter (BYOK). */
const UNMETERABLE_ROUTE: RoutingChainEntry = {
  cli: "codex",
  model: "default",
  authRef: "credential/openrouter/org/org_acme/default",
};

/** A codex SUBSCRIPTION credential — probe-covered, so its ceiling is enforceable. */
const METERABLE_ROUTE: RoutingChainEntry = {
  cli: "codex",
  model: "default",
  authRef: "credential/codex/org/org_acme/default",
};

/**
 * An org whose ONLY possible blocker is the budget item: GitHub connected through
 * the REAL connect route with a fully-provisioned App install, and an AI-provider
 * default bound. `ceilingUsd` seeds the org's `defaultBudget` — the exact field the
 * onboarding checklist tells the operator to PUT.
 */
async function buildOrg(route: RoutingChainEntry, ceilingUsd?: number) {
  const { app, pool, secrets } = await buildHarness({ permissions: FULL_PERMISSIONS });
  pool.orgs.get("org_acme")!.config = {
    version: 1,
    defaultCredentials: { defaultLlm: route },
    ...(ceilingUsd === undefined ? {} : { defaultBudget: { ceilingUsd, period: "total" } }),
  };
  const connect = await reqJson(app, "POST", "/orgs/org_acme/github", { installationId: "987", appId: "123456" });
  expect(connect.status).toBe(201);
  return { app, pool, secrets };
}

describe("onboarding readiness ↔ runnability coherence (the unmeterable route)", () => {
  it("NEGATIVE CONTROL: an operator on an unmeterable route is BOTH ready AND able to start a run", async () => {
    // codex × OpenRouter with NO tanren ceiling. This is the only configuration that
    // can actually RUN on this route — so readiness must call it ready.
    const { app, pool, secrets } = await buildOrg(UNMETERABLE_ROUTE);

    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.body.nextSteps).toEqual([]);
    expect(status.body.ready).toBe(true);
    expect(status.body.budget).toMatchObject({ ceilingUsd: null, ceilingRequirement: "refused" });

    // ...and the run actually starts: the run-setup path resolves adapters rather
    // than refusing. This is the half that makes `ready` mean something.
    const { adapters } = await startRunSetup({ pool, secrets, route: UNMETERABLE_ROUTE });
    expect(adapters.writer.cli).toBe("codex");

    // The guidance must SAY why no ceiling is required for this route, naming the
    // place spend IS bounded — not stay silent about a dropped checklist item.
    expect(status.body.advisories[0]).toContain("No tanren dollar ceiling is required");
    expect(status.body.advisories[0]).toContain("OpenRouter API key");
  });

  it("holds `ready` FALSE while a ceiling sits on an unmeterable route — the state that cannot run", async () => {
    // The state the OLD checklist pushed operators into: ceiling set, run refused.
    const { app, pool, secrets } = await buildOrg(UNMETERABLE_ROUTE, 50);

    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.body.ready).toBe(false);
    expect(status.body.nextSteps[0]).toContain("Remove the default budget ceiling ($50)");

    // And the refusal is UNWEAKENED: the run still fails closed at setup.
    const thrown = await startRunSetup({ pool, secrets, route: UNMETERABLE_ROUTE }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(UnenforceableBudgetCeilingError);
    expect((thrown as UnenforceableBudgetCeilingError).kind).toBe("unenforceable");
  });
});

describe("the opposite guard — a ceiling on a METERABLE route is still required and still enforced", () => {
  it("holds `ready` FALSE until a ceiling is set on a meterable route", async () => {
    const { app } = await buildOrg(METERABLE_ROUTE);
    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.body.ready).toBe(false);
    expect(status.body.budget).toMatchObject({ ceilingRequirement: "required" });
    expect(status.body.nextSteps[0]).toContain("Set a default budget ceiling");
  });

  it("flips to ready once the ceiling is set, the run starts, AND the ceiling actually pauses at spend", async () => {
    const { app, pool, secrets } = await buildOrg(METERABLE_ROUTE, 50);

    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.body.nextSteps).toEqual([]);
    expect(status.body.ready).toBe(true);

    // The run starts with the ceiling live (a codex writer is probe-covered).
    const { usageProbe } = await startRunSetup({ pool, secrets, route: METERABLE_ROUTE });
    expect(usageProbe).toBeDefined();

    // ENFORCEMENT, observed through the walker's own gate over the SAME org row:
    // spend reaching the ceiling pauses the DAG. "Readiness never asks for
    // anything" cannot masquerade as a fix.
    pool.seedCostRecord("project_acme", 50);
    const state = await new PgBudgetGate(pool.asPgPool()).resolveBudget("project_acme");
    expect(state.ceilingUsd).toBe(50);
    expect(shouldPauseOnBudget(state)).toBe(true);
  });
});
