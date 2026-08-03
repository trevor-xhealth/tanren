// THE ONBOARDING READINESS CHECKLIST over the REAL `GET /orgs/:orgId/onboarding-status`
// route. Split out of `githubConnectRoutes.test.ts` when the budget item became
// ROUTE-AWARE (see `routes/orgs/onboardingReadiness.ts`): a dollar ceiling is a
// blocking requirement only where a ceiling can actually be ENFORCED, because
// `assertBudgetCeilingEnforceable` fails a run closed at setup when a ceiling sits on
// an unmeterable route. The end-to-end ready-AND-runnable control is the sibling
// `onboardingReadinessCoherence.test.ts`; this file pins the checklist's own contract.

import { describe, expect, it } from "vitest";
import { DEFAULT_MANAGED_CREDENTIAL_REF } from "../src/engine/config/managedProvider.js";
import { admin, buildHarness, reqJson } from "./helpers/githubConnectHarness.js";

describe("onboarding-status", () => {
  it("aggregates AI provider + GitHub + budget into ready + nextSteps", async () => {
    const { app } = await buildHarness();
    // Nothing configured yet → not ready, every step listed.
    const empty = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(empty.status).toBe(200);
    expect(empty.body.ready).toBe(false);
    expect(empty.body.aiProvider).toEqual({ connected: false });
    expect(empty.body.github).toEqual({ connected: false, runReady: false, canCreateRepos: false });
    // No provider connected ⇒ no route to judge, so the ceiling question is
    // UNDETERMINED and does not add a step of its own (2 steps, not 3).
    expect(empty.body.budget).toMatchObject({ ceilingUsd: null, ceilingRequirement: "undetermined" });
    expect(empty.body.nextSteps.length).toBe(2);

    // Configure AI (codex default), a budget, and connect a repo-scoped token.
    const { app: app2, pool } = await buildHarness({ tokenScopes: "repo" });
    pool.orgs.get("org_acme")!.config = {
      version: 1,
      defaultCredentials: {
        defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/org/org_acme/default" },
      },
      defaultBudget: { ceilingUsd: 50, period: "monthly" },
    };
    await reqJson(app2, "POST", "/orgs/org_acme/github", { token: "ghp_repo" });

    const ready = await reqJson(app2, "GET", "/orgs/org_acme/onboarding-status");
    expect(ready.body.ready).toBe(true);
    expect(ready.body.aiProvider).toEqual({ connected: true, classifiedAs: "codex" });
    expect(ready.body.github).toEqual({ connected: true, runReady: true, canCreateRepos: true });
    // A codex SUBSCRIPTION default is probe-covered ⇒ the ceiling is enforceable
    // and therefore genuinely required.
    expect(ready.body.budget).toMatchObject({ ceilingUsd: 50, ceilingRequirement: "required" });
    expect(ready.body.nextSteps).toEqual([]);
  });

  it("classifies a managed provider as connected once the platform credential resolves", async () => {
    const { app, pool } = await buildHarness();
    pool.orgs.get("org_acme")!.config = { version: 1, providerMode: "managed" };
    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.status).toBe(200);
    expect(status.body.aiProvider).toEqual({ connected: true, classifiedAs: "managed" });
  });

  // Finding #3: managed mode must NOT be a pure config echo. With the platform
  // managed credential ABSENT, onboarding fails loud (409) instead of reporting a
  // false connected:true.
  it("managed mode with an absent platform credential is a loud 409, not a false ready", async () => {
    const { app, pool } = await buildHarness({}, admin, { seedManagedCredential: false });
    pool.orgs.get("org_acme")!.config = { version: 1, providerMode: "managed" };
    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.status).toBe(409);
    expect(status.body.error).toBe("managed_provider_credential_missing");
    expect(status.body.ref).toBe(DEFAULT_MANAGED_CREDENTIAL_REF);
  });

  it("surfaces the repo-creation gap as a next step when GitHub lacks it", async () => {
    const { app, pool } = await buildHarness({ tokenScopes: "read:org" });
    pool.orgs.get("org_acme")!.config = {
      version: 1,
      providerMode: "managed",
      defaultBudget: { ceilingUsd: 50, period: "monthly" },
    };
    await reqJson(app, "POST", "/orgs/org_acme/github", { token: "ghp_no_repo_scope" });
    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.body.ready).toBe(false);
    expect(status.body.github).toEqual({ connected: true, runReady: false, canCreateRepos: false });
    expect(status.body.nextSteps.some((s: string) => s.includes("repo"))).toBe(true);
  });

  it("keeps ready false while a REQUIRED (enforceable-route) budget ceiling is missing", async () => {
    const { app, pool } = await buildHarness({ tokenScopes: "repo" });
    pool.orgs.get("org_acme")!.config = {
      version: 1,
      defaultCredentials: {
        defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/org/org_acme/default" },
      },
    };
    await reqJson(app, "POST", "/orgs/org_acme/github", { token: "ghp_repo" });

    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.body.ready).toBe(false);
    expect(status.body.github).toEqual({ connected: true, runReady: true, canCreateRepos: true });
    expect(status.body.budget).toMatchObject({ ceilingUsd: null, ceilingRequirement: "required" });
    expect(status.body.nextSteps[0]).toContain("Set a default budget ceiling");
  });

  // The COHERENCE half: on a route tanren refuses a ceiling over, the checklist must
  // not demand one — it reports an advisory and the org is ready (and runnable).
  it("is ready with NO ceiling on a route whose ceiling would be refused at run setup", async () => {
    const { app, pool } = await buildHarness({ tokenScopes: "repo" });
    pool.orgs.get("org_acme")!.config = { version: 1, providerMode: "managed" };
    await reqJson(app, "POST", "/orgs/org_acme/github", { token: "ghp_repo" });

    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.body.ready).toBe(true);
    expect(status.body.aiProvider).toEqual({ connected: true, classifiedAs: "managed" });
    expect(status.body.budget).toMatchObject({ ceilingUsd: null, ceilingRequirement: "refused" });
    expect(status.body.nextSteps).toEqual([]);
    expect(status.body.advisories[0]).toContain("No tanren dollar ceiling is required");
  });
});
