// Shared harness for the Wave-2 operator API route tests (connect-GitHub +
// onboarding-status). Extracted when the onboarding-status suite grew a
// ROUTE-AWARE budget checklist and moved to its own file
// (`onboardingStatusRoutes.test.ts`), so neither test file crosses the 500-line
// cap and both keep driving the SAME real route handlers over the in-memory
// RoutesPool + an injected fetch. No `vi.mock` anywhere — every seam is a real
// object (an in-memory pool, an in-memory secret store, a URL-routing fetch).

import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import type { ActorContext } from "../../src/auth/schemas.js";
import { DEFAULT_MANAGED_CREDENTIAL_REF } from "../../src/engine/config/managedProvider.js";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import { storeGithubAppCredential } from "../../src/engine/credentials/githubApp.js";
import type { AppendEventInput, EventStore } from "../../src/engine/eventStore.js";
import { GithubAppTokenMinter } from "../../src/engine/providers/githubAppTokenMinter.js";
import { createAuthMiddleware, type ActorContextEnv } from "../../src/middleware/auth.js";
import { createGithubConnectRoutes } from "../../src/routes/orgs/github.js";
import { RoutesPool } from "./routesPool.js";

export const APP_CREDENTIAL_REF = "credential/github_app/org/org_acme/default";

export class RecordingEventStore implements EventStore {
  readonly appended: AppendEventInput[] = [];

  async append(input: AppendEventInput): Promise<void> {
    this.appended.push(input);
  }
}

export function pem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

export const admin: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

export const member: ActorContext = {
  userId: "user_bob",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

export interface CapabilityFetchOptions {
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
export const FULL_PERMISSIONS: Record<string, string> = {
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
export function buildFetch(opts: CapabilityFetchOptions = {}): typeof fetch {
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

export async function buildHarness(
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

export async function reqJson(
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
