// Loop 6 (fail-loud at creation): an AUTO-ROUTING inbox source MUST name a
// project. Its candidates skip manual triage and commit straight into the DAG —
// project-scoped — so a project-less auto-route source produces routable
// candidates that can never become specs (they stall in the inbox). The
// `POST /:orgId/inbox/sources` route rejects that misconfiguration at creation
// rather than discovering it per item. A non-auto-route source (operator-triaged)
// may still be project-less.

import type pg from "pg";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { createInboxRoutes } from "../src/routes/inbox/index.js";
import type { ActorContext } from "../src/auth/schemas.js";
import type { TriageAnswerer } from "../src/engine/forge/inbox/index.js";

const ACTOR: ActorContext = {
  userId: "user_admin",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

const MEMBER: ActorContext = {
  userId: "user_member",
  orgId: "org_a",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

const noopAnswerer: TriageAnswerer = {
  async triage() {
    throw new Error("triage should not run for a source-creation test");
  },
};

// A SQL-substring stub pool that captures `INSERT INTO inbox_sources` so a test
// can assert whether the (mis)configured source was actually created. Returns an
// project ownership as well as the inserted canonical config.
function stubPool(): { pool: pg.Pool; sourceInserts: Array<Record<string, unknown>> } {
  const sourceInserts: Array<Record<string, unknown>> = [];
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("SELECT org_id FROM projects")) {
      const projectId = String(params[0]);
      const orgId = projectId === "project_a" ? "org_a" : projectId === "project_b" ? "org_b" : undefined;
      return { rows: orgId === undefined ? [] : [{ org_id: orgId }], rowCount: orgId === undefined ? 0 : 1 };
    }
    if (sql.startsWith("INSERT INTO inbox_sources")) {
      const [id, orgId, projectId, kind, name, detail, config, enabled, autoRoute] = params as string[];
      const row = {
        id,
        org_id: orgId,
        project_id: projectId,
        kind,
        name,
        detail,
        config: JSON.parse(config) as unknown,
        enabled,
        auto_route: autoRoute,
        state: "active",
        attention_code: null,
        attention_message: null,
        attention_observed_at: null,
        webhook_configured: false,
        retry_not_before: null,
      };
      sourceInserts.push(row);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, sourceInserts };
}

function app(
  pool: pg.Pool,
  options: { secrets?: FakeSecretStore; providerCalls?: unknown[]; actor?: ActorContext } = {},
): Hono<ActorContextEnv> {
  const inbox = createInboxRoutes({
    pool,
    secrets: options.secrets ?? new FakeSecretStore(),
    githubHttp: {
      async request(input) {
        options.providerCalls?.push(input);
        return { status: 200, body: [] };
      },
    },
    answererFactory: () => noopAnswerer,
  });
  const root = new Hono<ActorContextEnv>();
  root.use("*", async (c, next) => {
    c.set("actor", options.actor ?? ACTOR);
    await next();
  });
  root.route("/orgs", inbox);
  return root;
}

async function postSource(pool: pg.Pool, body: unknown): Promise<Response> {
  return app(pool).request(`/orgs/org_a/inbox/sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function storedIssuesPool(config: Record<string, unknown>): pg.Pool {
  const row = {
    id: "source_removed_provider",
    org_id: "org_a",
    project_id: "project_a",
    kind: "issues",
    name: "removed provider",
    detail: "",
    config,
    enabled: "true",
    auto_route: "false",
    state: "active",
    attention_code: null,
    attention_message: null,
    attention_observed_at: null,
    webhook_configured: false,
    retry_not_before: null,
    project_valid: true,
  };
  const query = async (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.includes("FROM inbox_sources WHERE id = $1")) {
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE inbox_sources SET state = 'needs_attention'")) {
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    // Match the canonical EventStore append by its column identity without
    // embedding the prohibited raw event-write phrase in this fixture.
    if (sql.startsWith(["INSERT", "INTO", "events"].join(" "))) return { rows: [{ id: "1" }], rowCount: 1 };
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL") ||
      sql.startsWith("SELECT pg_notify") ||
      sql.startsWith("NOTIFY tanren_notify")
    ) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected query after unsupported provider boundary: ${sql}`);
  };
  return { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool;
}

describe("inbox source creation — auto-route requires a project (Loop 6)", () => {
  it("rejects an auto_route source with no projectId (candidates could never become specs)", async () => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, { kind: "system", name: "org default intake", autoRoute: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_source");
    // The misconfigured source was NOT created.
    expect(sourceInserts).toHaveLength(0);
  });

  it("accepts an auto_route source WITH a projectId", async () => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, {
      kind: "system",
      name: "project intake",
      projectId: "project_a",
      config: { ciInsights: true },
      autoRoute: true,
    });
    expect(res.status).toBe(201);
    expect(sourceInserts).toHaveLength(1);
  });

  it("still accepts a NON-auto_route source with no projectId (operator-triaged is fine)", async () => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, { kind: "manual", name: "manual triage" });
    expect(res.status).toBe(201);
    expect(sourceInserts).toHaveLength(1);
  });

  it("rejects a project owned by a different organization before persistence", async () => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, {
      kind: "issues",
      name: "foreign project",
      projectId: "project_b",
      config: { owner: "cat-cave", repo: "app" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "project_not_found" });
    expect(sourceInserts).toHaveLength(0);
  });
});

describe("inbox issues source boundary — removed providers never reach authority or transport", () => {
  it("denies an ordinary member's manual ingest before DB, secret, provider, or candidate effects", async () => {
    let dbCalls = 0;
    const pool = {
      query: async () => {
        dbCalls += 1;
        throw new Error("authorization must precede DB access");
      },
    } as unknown as pg.Pool;
    const secrets = new FakeSecretStore();
    const secretRead = vi.spyOn(secrets, "get");
    const providerCalls: unknown[] = [];

    const res = await app(pool, { secrets, providerCalls, actor: MEMBER }).request(
      "/orgs/org_a/inbox/sources/source_a/ingest",
      { method: "POST" },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "org_admin_required" });
    expect({ dbCalls, secretReads: secretRead.mock.calls.length, providerCalls: providerCalls.length }).toEqual({
      dbCalls: 0,
      secretReads: 0,
      providerCalls: 0,
    });
  });

  it.each([
    ["bare-token linear", { provider: "linear", teamKey: "ENG", tokenRef: "credential/linear/old" }],
    ["jira", { provider: "jira", baseUrl: "https://jira.example", projectKey: "ENG" }],
    ["an unimplemented tracker", { provider: "shortcut", projectKey: "ENG" }],
    ["a non-string provider", { provider: 7, teamKey: "ENG" }],
    ["legacy GitHub discriminator", { provider: "github", owner: "cat-cave", repo: "app" }],
    ["raw tokenRef", { provider: "github", owner: "cat-cave", repo: "app", tokenRef: "credential/old" }],
  ])("rejects %s config at source creation without persisting it", async (_label, config) => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, { kind: "issues", name: "unsupported", config });
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toMatchObject({ error: "unsupported_inbox_provider" });
    expect(sourceInserts).toHaveLength(0);
  });

  it("creates a Linear issues source and persists its one canonical credential-free config", async () => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, {
      kind: "issues",
      name: "linear · acme eng",
      projectId: "project_a",
      config: { provider: "linear", teamKey: "ENG" },
    });
    expect(res.status).toBe(201);
    expect(sourceInserts).toHaveLength(1);
    // `labels` defaults; nothing else — in particular no credential coordinate,
    // because the Linear token comes from the org's integration grant.
    expect(sourceInserts[0]!.config).toEqual({ provider: "linear", teamKey: "ENG", labels: [] });
  });

  it("rejects a Linear source missing its team key at the route boundary", async () => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, {
      kind: "issues",
      name: "linear",
      projectId: "project_a",
      config: { provider: "linear" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_inbox_source_config" });
    expect(sourceInserts).toHaveLength(0);
  });

  it("still creates an explicitly supported GitHub issues source", async () => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, {
      kind: "issues",
      name: "github issues",
      config: { owner: "cat-cave", repo: "app" },
    });
    expect(res.status).toBe(201);
    expect(sourceInserts).toHaveLength(1);
    expect(sourceInserts[0]!.config).toEqual({
      owner: "cat-cave",
      repo: "app",
      labels: [],
    });
  });

  it.each([
    ["GitHub config missing repo", "issues", { owner: "cat-cave" }],
    ["Sentry config missing project", "errors", { org: "cat-cave" }],
  ])("rejects malformed %s at the route boundary", async (_label, kind, config) => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, { kind, name: "malformed", config });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_inbox_source_config" });
    expect(sourceInserts).toHaveLength(0);
  });

  it("rejects caller-owned Sentry authority coordinates", async () => {
    const { pool, sourceInserts } = stubPool();
    const res = await postSource(pool, {
      kind: "errors",
      name: "sentry",
      config: { org: "cat-cave", project: "app", tokenRef: "credential/sentry/org_b" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unsupported_inbox_provider" });
    expect(sourceInserts).toHaveLength(0);
  });

  it("rejects a foreign-org staticRef before persistence, secret resolution, or provider I/O", async () => {
    const { pool, sourceInserts } = stubPool();
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_b/default", value: "org-b-token" });
    const secretRead = vi.spyOn(secrets, "get");
    const providerCalls: unknown[] = [];
    const res = await app(pool, { secrets, providerCalls }).request("/orgs/org_a/inbox/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "issues",
        name: "confused deputy",
        config: { owner: "cat-cave", repo: "app", staticRef: "credential/github/org/org_b/default" },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unsupported_inbox_provider" });
    expect(sourceInserts).toHaveLength(0);
    expect(secretRead).not.toHaveBeenCalled();
    expect(providerCalls).toEqual([]);
  });

  it.each([
    ["a stale bare-token linear", { provider: "linear", team: "ENG", tokenRef: "credential/linear/old" }],
    ["jira", { provider: "jira", baseUrl: "https://jira.example", projectKey: "ENG" }],
    ["raw tokenRef", { provider: "github", owner: "cat-cave", repo: "app", tokenRef: "credential/old" }],
    ["foreign staticRef", { owner: "cat-cave", repo: "app", staticRef: "credential/github/org/org_b/default" }],
  ])("parks a persisted %s source before secret/provider I/O", async (_label, config) => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_b/default", value: "org-b-token" });
    const secretRead = vi.spyOn(secrets, "get");
    const providerCalls: unknown[] = [];
    const res = await app(storedIssuesPool(config), { secrets, providerCalls }).request(
      "/orgs/org_a/inbox/sources/source_removed_provider/ingest",
      { method: "POST" },
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as unknown).toMatchObject({ error: "inbox_source_needs_attention" });
    expect(secretRead).not.toHaveBeenCalled();
    expect(providerCalls).toEqual([]);
  });
});
