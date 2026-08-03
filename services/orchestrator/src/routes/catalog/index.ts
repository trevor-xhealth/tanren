// Catalog import + read routes. A `tanren.behavior.v0` / `tanren.persona.v0`
// catalog is posted as its own documents — the server owns the one parser, so
// the CLI (and any other client) never has to reimplement the format.
//
// The import is a single transaction: the response is either a full summary or a
// coded failure, never a partly applied catalog.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import { runWithOrgScope } from "@tanren/db";
import type { ActorContext } from "../../auth/schemas.js";
import { CatalogImportError, importCatalog } from "../../engine/catalog/importCatalog.js";
import { CatalogStore } from "../../engine/catalog/store.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

interface CatalogRoutesOptions {
  pool: pg.Pool;
}

const CatalogImportBody = z.object({
  documents: z.array(z.object({ path: z.string().min(1), text: z.string().min(1) })).min(1),
  dryRun: z.boolean().optional(),
});

export function createCatalogRoutes(options: CatalogRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.post("/:orgId/projects/:projectId/catalog/import", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = CatalogImportBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_catalog_request", issues: parsed.error.issues }, 400);
    }
    try {
      const summary = await importCatalog(
        options.pool,
        { orgId, projectId, documents: parsed.data.documents, dryRun: parsed.data.dryRun ?? false },
        actor,
      );
      return c.json(summary, 200);
    } catch (error) {
      if (error instanceof CatalogImportError) {
        const status = error.code === "catalog_org_access_denied" ? 403 : 400;
        return c.json({ error: error.code, message: error.message, sourcePath: error.sourcePath ?? null }, status);
      }
      return c.json({ error: "catalog_import_failed", message: messageOf(error) }, 400);
    }
  });

  app.get("/:orgId/projects/:projectId/catalog/behaviors", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const behaviors = await runWithOrgScope(options.pool, orgId, async (client) =>
      CatalogStore.listBehaviors(client, { orgId, projectId }),
    );
    return c.json({ behaviors });
  });

  app.get("/:orgId/projects/:projectId/catalog/behaviors/:catalogId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    const catalogId = c.req.param("catalogId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const behavior = await runWithOrgScope(options.pool, orgId, async (client) =>
      CatalogStore.getBehavior(client, { orgId, projectId, catalogId }),
    );
    if (behavior === undefined) {
      return c.json({ error: "catalog_behavior_not_found" }, 404);
    }
    return c.json(behavior);
  });

  return app;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
