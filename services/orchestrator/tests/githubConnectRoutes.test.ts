// Route tests for the Wave-2 "Connect GitHub" + onboarding-status operator API.
// Drives the REAL route handlers against the in-memory RoutesPool + an injected
// fetch, proving the user experience without a raw config PATCH:
//   - connect via App install → GET reflects mode:"app" + a SERVER-stamped
//     installedAt + a real capability check over the installation's GRANTED
//     permission set (run-fatal gaps vs optional ones);
//   - connect via token → the PAT is stored + set as the org default, and the
//     capability reflects the token's actual X-OAuth-Scopes;
//   - onboarding-status aggregates AI provider + GitHub + budget into ready/nextSteps;
//   - a non-admin POST is a 403.

import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { DEFAULT_MANAGED_CREDENTIAL_REF } from "../src/engine/config/managedProvider.js";
import { migrateOrgConfig } from "../src/engine/config/orgConfig.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { storeGithubAppCredential } from "../src/engine/credentials/githubApp.js";
import type { AppendEventInput, EventStore } from "../src/engine/eventStore.js";
import { GithubAppTokenMinter } from "../src/engine/providers/githubAppTokenMinter.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createGithubConnectRoutes } from "../src/routes/orgs/github.js";
import { RoutesPool } from "./helpers/routesPool.js";

const APP_CREDENTIAL_REF = "credential/github_app/org/org_acme/default";

class RecordingEventStore implements EventStore {
  readonly appended: AppendEventInput[] = [];

  async append(input: AppendEventInput): Promise<void> {
    this.appended.push(input);
  }
}

function pem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

const admin: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

const member: ActorContext = {
  userId: "user_bob",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

interface CapabilityFetchOptions {
  /** The GitHub App installation's granted `administration` permission. */
  administration?: string;
  /**
   * The installation's FULL granted permission map, exactly as
   * `GET /app/installations/{id}` returns it. Supplied when a test needs to model
   * a real-world partial grant (rather than only varying `administration`).
   */
  permissions?: Record<string, string>;
  /** The classic OAuth scopes the static token reports via X-OAuth-Scopes. */
  tokenScopes?: string;
}

/**
 * The permission set a fully-provisioned Tanren GitHub App installation carries —
 * every permission Tanren depends on, at the level it needs. Used as the default
 * so the pre-existing tests keep exercising a healthy install, and as the positive
 * guard proving the probe does NOT warn when nothing is missing.
 */
const FULL_PERMISSIONS: Record<string, string> = {
  administration: "write",
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
  repository_hooks: "write",
  statuses: "write",
};

/**
 * A URL-routing fake fetch covering the three endpoints the routes hit:
 *   - POST /app/installations/{id}/access_tokens (minter)  → installation token
 *   - GET  /app/installations/{id}              (App probe) → permissions+account
 *   - GET  /user                                (token probe) → login + X-OAuth-Scopes
 */
function buildFetch(opts: CapabilityFetchOptions = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/access_tokens") && method === "POST") {
      return new Response(
        JSON.stringify({ token: "ghs_app", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
        { status: 201 },
      );
    }
    if (/\/app\/installations\/[^/]+$/u.test(url) && method === "GET") {
      // Default to a fully-provisioned install, then apply the test's overrides:
      // an explicit `permissions` map replaces it wholesale (modelling a real
      // partial grant), while `administration` varies only that one permission.
      const permissions = opts.permissions ?? { ...FULL_PERMISSIONS, administration: opts.administration ?? "read" };
      return new Response(JSON.stringify({ account: { login: "acme-org" }, permissions }), { status: 200 });
    }
    if (url.endsWith("/user") && method === "GET") {
      return new Response(JSON.stringify({ login: "acme-bot" }), {
        status: 200,
        headers: { "X-OAuth-Scopes": opts.tokenScopes ?? "" },
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

async function buildHarness(
  opts: CapabilityFetchOptions = {},
  actor: ActorContext = admin,
  harnessOpts: { seedManagedCredential?: boolean } = {},
) {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme", login: "acme", config: { version: 1 } });
  pool.seedProject({ project_id: "project_acme", org_id: "org_acme" });
  const secrets = new InMemorySecretStore();
  await storeGithubAppCredential(secrets, { ref: APP_CREDENTIAL_REF, appId: "123456", privateKeyPem: pem() });
  // The platform-managed provider credential the hosting layer provisions. Seeded
  // by default so managed-mode onboarding reports ready; the missing-cred test
  // opts OUT to prove the loud platform-config error.
  if (harnessOpts.seedManagedCredential !== false) {
    await secrets.put({ ref: DEFAULT_MANAGED_CREDENTIAL_REF, value: "sk-managed-platform-key" });
  }
  const fetchImpl = buildFetch(opts);
  const minter = new GithubAppTokenMinter({ secrets, fetchImpl });
  const events = new RecordingEventStore();

  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: { async resolveActorContext() {} } as never,
      localDevActor: actor,
    }),
  );
  app.route(
    "/orgs",
    createGithubConnectRoutes({
      pool: pool.asPgPool(),
      secrets,
      minter,
      appCredentialRef: APP_CREDENTIAL_REF,
      fetchImpl,
      events,
    }),
  );
  return { app, pool, secrets, events };
}

async function reqJson(
  app: Hono<ActorContextEnv>,
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("connect GitHub — App install mode", () => {
  it("connects via App install and GET reflects mode app + a server-stamped installedAt + capability", async () => {
    const { app, pool } = await buildHarness({ administration: "write" });
    const before = Date.now();
    const post = await reqJson(app, "POST", "/orgs/org_acme/github", {
      installationId: "987",
      appId: "123456",
    });
    expect(post.status).toBe(201);
    expect(post.body.mode).toBe("app");
    expect(post.body.installation.installationId).toBe("987");
    // SERVER-STAMPED: the caller supplied no timestamp; the route set a real one.
    const stamped = Date.parse(post.body.installation.installedAt);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before);

    // The persisted org config carries the github_app block with that timestamp.
    const persisted = migrateOrgConfig(pool.orgs.get("org_acme")?.config).github_app;
    expect(persisted?.installationId).toBe("987");
    expect(persisted?.installedAt).toBe(post.body.installation.installedAt);

    const get = await reqJson(app, "GET", "/orgs/org_acme/github");
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({
      connected: true,
      mode: "app",
      login: "acme-org",
      canCreateRepos: true,
      missingPermissions: [],
    });
  });

  // The OPPOSITE classification: an install missing ONLY administration:write can
  // still complete every run (it just cannot create a greenfield repo), so the gap
  // is reported as feature-blocking and `runReady` stays true.
  it("reports the administration:write gap as feature-blocking, keeping the install run-ready", async () => {
    const { app } = await buildHarness({ administration: "read" });
    await reqJson(app, "POST", "/orgs/org_acme/github", { installationId: "987", appId: "123456" });
    const get = await reqJson(app, "GET", "/orgs/org_acme/github");
    expect(get.body.canCreateRepos).toBe(false);
    expect(get.body.runReady).toBe(true);
    expect(get.body.canPublishGateStatus).toBe(true);
    expect(get.body.blockingPermissions).toEqual([]);
    expect(get.body.missingPermissions).toEqual(["administration:write"]);
    expect(get.body.permissionGaps).toMatchObject([
      { permission: "administration:write", severity: "feature_blocking" },
    ]);

    // …and onboarding lists it as an ADVISORY, not a step that holds back `ready`.
    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.body.nextSteps).not.toContainEqual(expect.stringContaining("administration:write"));
    expect(status.body.advisories).toContainEqual(expect.stringContaining("administration:write"));
  });

  // NEGATIVE CONTROL (the false-green defect). A real installation granted only
  // `contents:write, metadata:read, pull_requests:write` reported connected + a
  // single OPTIONAL `administration:write` gap — while EVERY run died at gate
  // publish, because `POST /repos/{o}/{r}/statuses/{sha}` 403s without
  // `statuses:write` and `githubPublishCheck.ts` throws on any non-201. The probe
  // must name the run-fatal gap, must not call the connection run-ready, and the
  // readiness checklist must hold `ready` false on it.
  it("reports the run-fatal statuses:write gap for a contents+metadata+pull_requests install", async () => {
    const { app, pool } = await buildHarness({
      permissions: { contents: "write", metadata: "read", pull_requests: "write" },
    });
    // Everything ELSE an org needs is configured, so `ready` can only be held
    // false by the GitHub permission gap.
    pool.orgs.get("org_acme")!.config = {
      version: 1,
      providerMode: "managed",
      defaultBudget: { ceilingUsd: 50, period: "monthly" },
    };
    await reqJson(app, "POST", "/orgs/org_acme/github", { installationId: "987", appId: "123456" });
    const get = await reqJson(app, "GET", "/orgs/org_acme/github");

    expect(get.status).toBe(200);
    // A credential IS configured and GitHub confirms the identity — `connected`
    // stays factual; the readiness signal is what must go red.
    expect(get.body.connected).toBe(true);
    expect(get.body.runReady).toBe(false);
    expect(get.body.canPublishGateStatus).toBe(false);
    // The run-fatal gap is named, and separated from the optional/feature gaps.
    expect(get.body.blockingPermissions).toEqual(["statuses:write"]);
    const gaps = get.body.permissionGaps as { permission: string; severity: string; blocks: string }[];
    expect(gaps.find((gap) => gap.permission === "statuses:write")).toMatchObject({ severity: "run_fatal" });
    // `administration:write`, `issues:write` and `repository_hooks:write` are
    // absent too, and likewise reported — as feature-blocking, not run-fatal.
    expect(get.body.missingPermissions).toEqual([
      "statuses:write",
      "administration:write",
      "issues:write",
      "repository_hooks:write",
    ]);

    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.body.ready).toBe(false);
    expect(status.body.github).toEqual({ connected: true, runReady: false, canCreateRepos: false });
    expect(status.body.nextSteps).toEqual([expect.stringContaining("statuses:write")]);
    expect(status.body.nextSteps[0]).toContain("EVERY run fails");
  });

  // POSITIVE GUARD: an install that genuinely holds every permission must report
  // healthy, so an "always warns" probe cannot masquerade as a fix.
  it("reports an install holding every permission as run-ready with no gaps", async () => {
    const { app } = await buildHarness({ permissions: FULL_PERMISSIONS });
    await reqJson(app, "POST", "/orgs/org_acme/github", { installationId: "987", appId: "123456" });
    const get = await reqJson(app, "GET", "/orgs/org_acme/github");

    expect(get.body).toMatchObject({
      connected: true,
      mode: "app",
      login: "acme-org",
      runReady: true,
      canPublishGateStatus: true,
      canCreateRepos: true,
    });
    expect(get.body.missingPermissions).toEqual([]);
    expect(get.body.blockingPermissions).toEqual([]);
    expect(get.body.permissionGaps).toEqual([]);
  });

  it("rejects an appId that does not match the credential", async () => {
    const { app } = await buildHarness();
    const post = await reqJson(app, "POST", "/orgs/org_acme/github", { installationId: "987", appId: "999999" });
    expect(post.status).toBe(400);
    expect(post.body.error).toBe("github_app_id_mismatch");
  });

  it("rejects a foreign-org App ref before secret load or token mint", async () => {
    const { app, secrets, pool } = await buildHarness();
    const foreignRef = "credential/github_app/org/org_other/default";
    await storeGithubAppCredential(secrets, { ref: foreignRef, appId: "123456", privateKeyPem: pem() });
    const secretRead = vi.spyOn(secrets, "get");

    const post = await reqJson(app, "POST", "/orgs/org_acme/github", {
      installationId: "987",
      appId: "123456",
      credentialRef: foreignRef,
    });

    expect(post.status).toBe(400);
    expect(post.body.error).toBe("github_app_credential_not_owned");
    expect(secretRead).not.toHaveBeenCalled();
    expect(migrateOrgConfig(pool.orgs.get("org_acme")?.config).github_app).toBeUndefined();
  });
});

describe("connect GitHub — token mode", () => {
  it("stores the token as the org default and the capability reflects its scope", async () => {
    const { app, secrets, events } = await buildHarness({ tokenScopes: "repo, workflow" });
    const post = await reqJson(app, "POST", "/orgs/org_acme/github", { token: "dummy_github_token" });
    expect(post.status).toBe(201);
    expect(post.body.mode).toBe("token");
    // The response carries only the redacted ref — never the secret.
    expect(post.body.credentialRef).toBe("credential/github/org/org_acme/default");
    expect(JSON.stringify(post.body)).not.toContain("dummy_github_token");
    // The token IS stored under that ref.
    expect((await secrets.get(post.body.credentialRef))?.value).toBe("dummy_github_token");
    expect(events.appended).toContainEqual(
      expect.objectContaining({
        projectId: "project_acme",
        eventType: "credential.github.configured",
        payload: {
          mode: "token",
          credentialKind: "github_token",
          ref: "credential/github/org/org_acme/default",
          redacted: true,
        },
      }),
    );

    const get = await reqJson(app, "GET", "/orgs/org_acme/github");
    expect(get.body).toMatchObject({ connected: true, mode: "token", login: "acme-bot", canCreateRepos: true });
    expect(get.body.missingPermissions).toEqual([]);
  });

  it("reports the missing repo scope for a token that lacks it", async () => {
    const { app } = await buildHarness({ tokenScopes: "read:org" });
    await reqJson(app, "POST", "/orgs/org_acme/github", { token: "ghp_no_repo_scope" });
    const get = await reqJson(app, "GET", "/orgs/org_acme/github");
    expect(get.body.canCreateRepos).toBe(false);
    expect(get.body.missingPermissions).toEqual(["repo"]);
  });
});

describe("GET github — not connected", () => {
  it("reports connected:false when no GitHub identity is configured", async () => {
    const { app } = await buildHarness();
    const get = await reqJson(app, "GET", "/orgs/org_acme/github");
    expect(get.status).toBe(200);
    expect(get.body).toEqual({
      connected: false,
      mode: null,
      login: null,
      runReady: false,
      canPublishGateStatus: false,
      canCreateRepos: false,
      permissionGaps: [],
      blockingPermissions: [],
      missingPermissions: [],
    });
  });

  // Finding #2: a persisted github_token ref pointing at NO secret is credential
  // CORRUPTION, not "no GitHub connected" — it must fail LOUD, never report a
  // quiet connected:false that hides the broken tenant state.
  it("a configured-ref-but-missing-secret is a loud 409, not a silent connected:false", async () => {
    const { app, pool } = await buildHarness();
    // The org config persists a default github_token ref, but the secret store
    // holds no value under it (corruption: e.g. the secret was deleted out-of-band).
    pool.orgs.get("org_acme")!.config = {
      version: 1,
      defaultCredentials: { github_token: "credential/github/org/org_acme/default" },
    };
    const get = await reqJson(app, "GET", "/orgs/org_acme/github");
    expect(get.status).toBe(409);
    expect(get.body.error).toBe("github_credential_ref_missing");
    expect(get.body.ref).toBe("credential/github/org/org_acme/default");
  });

  it("a genuinely-unconfigured org returns connected:false (not the corruption error)", async () => {
    const { app } = await buildHarness();
    const get = await reqJson(app, "GET", "/orgs/org_acme/github");
    expect(get.status).toBe(200);
    expect(get.body.connected).toBe(false);
  });
});

describe("onboarding-status", () => {
  it("aggregates AI provider + GitHub + budget into ready + nextSteps", async () => {
    const { app } = await buildHarness();
    // Nothing configured yet → not ready, every step listed.
    const empty = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(empty.status).toBe(200);
    expect(empty.body.ready).toBe(false);
    expect(empty.body.aiProvider).toEqual({ connected: false });
    expect(empty.body.github).toEqual({ connected: false, runReady: false, canCreateRepos: false });
    expect(empty.body.budget).toEqual({ ceilingUsd: null });
    expect(empty.body.nextSteps.length).toBe(3);

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
    expect(ready.body.budget).toEqual({ ceilingUsd: 50 });
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

  it("keeps ready false while the budget step is missing", async () => {
    const { app, pool } = await buildHarness({ tokenScopes: "repo" });
    pool.orgs.get("org_acme")!.config = { version: 1, providerMode: "managed" };
    await reqJson(app, "POST", "/orgs/org_acme/github", { token: "ghp_repo" });

    const status = await reqJson(app, "GET", "/orgs/org_acme/onboarding-status");
    expect(status.body.ready).toBe(false);
    expect(status.body.aiProvider).toEqual({ connected: true, classifiedAs: "managed" });
    expect(status.body.github).toEqual({ connected: true, runReady: true, canCreateRepos: true });
    expect(status.body.budget).toEqual({ ceilingUsd: null });
    expect(status.body.nextSteps).toEqual([
      "Set a default budget ceiling: PUT /orgs/:orgId/budget so runs have a spend cap.",
    ]);
  });
});

describe("authorization", () => {
  it("a non-admin POST is a 403", async () => {
    const { app } = await buildHarness({}, member);
    const post = await reqJson(app, "POST", "/orgs/org_acme/github", { token: "ghp_x" });
    expect(post.status).toBe(403);
    expect(post.body.error).toBe("org_admin_required");
  });

  it("a non-member is denied the GET read", async () => {
    const stranger: ActorContext = { ...member, orgId: "org_other" };
    const { app } = await buildHarness({}, stranger);
    const get = await reqJson(app, "GET", "/orgs/org_acme/github");
    expect(get.status).toBe(403);
    expect(get.body.error).toBe("org_access_denied");
  });
});
