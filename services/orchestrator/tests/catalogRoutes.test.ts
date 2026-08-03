// Catalog HTTP surface — the fail-closed guards that must reject BEFORE any
// database work happens. The happy path is proven end-to-end against real
// Postgres in catalogImport.rls.integration.test.ts.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createCatalogRoutes } from "../src/routes/catalog/index.js";

const actor: ActorContext = {
  userId: "user_catalog_routes",
  orgId: "org_catalog_routes",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function buildApp(): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (context, next) => {
    context.set("actor", actor);
    await next();
  });
  // The pool is never reached on any path exercised here — every case is
  // rejected by an authorization or shape guard first.
  app.route("/orgs", createCatalogRoutes({ pool: {} as never }));
  return app;
}

function importPath(orgId: string): string {
  return `/orgs/${orgId}/projects/project_catalog_routes/catalog/import`;
}

describe("catalog import HTTP guards", () => {
  it("denies an org the actor is not scoped to, without touching the pool", async () => {
    const response = await buildApp().request(importPath("org_someone_else"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documents: [{ path: "docs/behaviors/B-0001-x.md", text: "---\n" }] }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "org_access_denied" });
  });

  it("rejects an empty document list rather than reporting a successful zero-document import", async () => {
    const response = await buildApp().request(importPath(actor.orgId ?? ""), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documents: [] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_catalog_request" });
  });

  it("rejects a malformed body", async () => {
    const response = await buildApp().request(importPath(actor.orgId ?? ""), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_catalog_request" });
  });

  it("denies cross-org catalog reads", async () => {
    const app = buildApp();
    const list = await app.request("/orgs/org_someone_else/projects/p/catalog/behaviors");
    expect(list.status).toBe(403);
    const get = await app.request("/orgs/org_someone_else/projects/p/catalog/behaviors/B-0001");
    expect(get.status).toBe(403);
  });
});
