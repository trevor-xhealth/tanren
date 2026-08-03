// TWO API STRICTNESS RULES THAT READ AS BUGS UNTIL THE ERROR EXPLAINS THEM.
// Both were reported during a live operator run; both turned out to be correct
// behaviour whose REJECTION MESSAGE was the actual defect.
//
//  1. `GET /orgs/:id/budget` returns `revision` as a JSON STRING and `PUT` refuses a
//     number. Not an inconsistent round-trip — `config_revision` is a BIGINT, so the
//     token crosses the wire as a decimal string in BOTH directions and a JSON number
//     would round above 2^53. But zod stopped at "expected string, received number",
//     which reads like an arbitrary quirk. The message now states the round-trip rule.
//
//  2. `POST /specs` refuses `"p2"` and requires `"P2"`. Deliberate: the vocabulary is
//     MIXED case (`P0`/`P1`/`P2`/`tbd`), so no single case fold normalizes it, and the
//     literals are the DB CHECK's literals. The message now says the comparison is
//     case-sensitive instead of listing options a caller believes they matched.
//
// Driven over the REAL route handlers; the assertions are the HTTP status + the
// message the caller actually receives.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createOrgRoutes } from "../src/routes/orgs/index.js";
import { createSpecRoutes } from "../src/routes/specs/index.js";
import { RoutesPool } from "./helpers/routesPool.js";

const admin: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function buildHarness() {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme", login: "acme", config: { version: 1 } });
  pool.seedProject({ project_id: "project_acme", org_id: "org_acme", config: { version: 1 } });
  const app = new Hono<ActorContextEnv>();
  app.use("*", createAuthMiddleware({ store: { async resolveActorContext() {} } as never, localDevActor: admin }));
  app.route("/orgs", createOrgRoutes({ pool: pool.asPgPool() }));
  app.route("/orgs", createSpecRoutes({ pool: pool.asPgPool() }));
  return { app, pool };
}

async function json(app: Hono<ActorContextEnv>, method: string, path: string, payload?: unknown) {
  const res = await app.request(path, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

describe("org budget revision — the string token round-trips, a number is refused clearly", () => {
  it("GET's revision is a string and PUT accepts EXACTLY that value back", async () => {
    const { app } = buildHarness();
    const read = await json(app, "GET", "/orgs/org_acme/budget");
    expect(read.status).toBe(200);
    expect(typeof read.body.revision).toBe("string");

    // The round trip the operator expects: paste GET's value straight into PUT.
    const write = await json(app, "PUT", "/orgs/org_acme/budget", {
      ceilingUsd: 25,
      period: "total",
      revision: read.body.revision,
    });
    expect(write.status).toBe(200);
    expect(write.body).toMatchObject({ ceilingUsd: 25, period: "total" });
    expect(typeof write.body.revision).toBe("string");
  });

  it("refuses the NUMERIC form of the same revision, and the message says why", async () => {
    const { app } = buildHarness();
    const read = await json(app, "GET", "/orgs/org_acme/budget");
    const numeric = Number(read.body.revision);

    const write = await json(app, "PUT", "/orgs/org_acme/budget", {
      ceilingUsd: 25,
      period: "total",
      revision: numeric,
    });
    expect(write.status).toBe(400);
    expect(write.body.error).toBe("invalid_budget");
    const issues = write.body.issues as unknown as Array<{ message: string }>;
    // The caller must be told the ROUND-TRIP RULE, not just "expected string".
    expect(issues[0]?.message).toContain("STRING token returned by GET");
    expect(issues[0]?.message).toContain("BIGINT");
  });
});

const specBody = (priority: string) => ({
  title: "A spec",
  description: "Do the thing.",
  acceptanceCriteria: ["it works"],
  priority,
});

describe("spec priority — case-sensitive by design, and the error says so", () => {
  it('accepts "P2" (the canonical token)', async () => {
    const { app } = buildHarness();
    const created = await json(app, "POST", "/orgs/org_acme/projects/project_acme/specs", specBody("P2"));
    expect(created.status).toBe(201);
    expect(created.body.priority).toBe("P2");
  });

  it('refuses "p2" with a message that names case-sensitivity, not just the option list', async () => {
    const { app } = buildHarness();
    const rejected = await json(app, "POST", "/orgs/org_acme/projects/project_acme/specs", specBody("p2"));
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("invalid_spec");
    const issues = rejected.body.issues as unknown as Array<{ message: string }>;
    // Without this, the caller reads 'expected one of "P0"|"P1"|"P2"|"tbd"' and
    // concludes they DID send one of them.
    expect(issues[0]?.message).toContain("case-sensitive");
    expect(issues[0]?.message).toContain('"p2"');
  });
});
