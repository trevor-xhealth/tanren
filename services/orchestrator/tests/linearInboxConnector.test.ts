// Linear inbox connector + `issues` provider-dispatcher tests.
//
// Every test drives the REAL connector (and the REAL dispatcher, and the REAL
// integration authority via `testLinearIntakeAuthority`) through a recording
// STUB transport — no spies on the code under test, no `vi.mock`. The payloads
// are Linear's documented GraphQL `issues` envelope.
//
// The suite has two halves that must BOTH hold:
//   • Linear ingests. A realistic Linear payload becomes IngestedItems and, end
//     to end through `ingestSource`, persisted candidates.
//   • The gate stays closed. Opening `issues` to Linear must not open it to
//     anything else — Jira, an unknown tracker, a non-string provider, the
//     removed GitHub discriminator, or any source-owned credential coordinate
//     are still refused BEFORE authority, secret, or provider I/O.

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";
import {
  createGitHubIssuesConnector,
  createIssuesDispatcher,
  createLinearConnector,
  IntakeSourceAuthError,
  IntakeSourceFetchError,
  IntakeSourceRateLimitError,
  IntakeSourceResourceError,
  ingestSource,
  UnsupportedInboxProviderError,
  type InboxEngineDeps,
  type InboxSource,
  type LinearHttpClient,
  type LinearHttpRequest,
  type SourceConnector,
} from "../src/engine/forge/inbox/index.js";
import { createDeterministicTriageAnswerer } from "./fixtures/forge/deterministicTriageAnswerer.js";
import { testLinearIntakeAuthority } from "./helpers/linearIntakeAuthority.js";

const secrets = new InMemorySecretStore();
await secrets.put({ ref: "credential/github/org/org_a/default", value: "ghs_static_token" });
await secrets.put({ ref: "credential/linear/x/g/1", value: "lin_api_token" });

const linearSource: InboxSource = {
  id: "src_linear",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "linear · acme eng",
  detail: "open issues",
  config: { provider: "linear", teamKey: "ENG", labels: [] },
  enabled: true,
  autoRoute: false,
};

const githubSource: InboxSource = {
  id: "src_gh",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "github · acme",
  detail: "issues labeled spec-candidate",
  config: { owner: "acme", repo: "app", labels: ["spec-candidate"] },
  enabled: true,
  autoRoute: false,
};

const linearAuthority = testLinearIntakeAuthority("credential/linear/x/g/1");
const missingSecretAuthority = testLinearIntakeAuthority("credential/linear/missing/g/1");

// Linear's documented response envelope for the `issues` connection.
function envelope(nodes: unknown[]): unknown {
  return { data: { issues: { nodes } } };
}

function recordLinear(
  body: unknown,
  status = 200,
  headers?: Record<string, string | undefined>,
): { client: LinearHttpClient; calls: LinearHttpRequest[] } {
  const calls: LinearHttpRequest[] = [];
  return {
    calls,
    client: {
      async request(input) {
        calls.push(input);
        return { status, body, ...(headers === undefined ? {} : { headers }) };
      },
    },
  };
}

function linearConnector(linearHttp: LinearHttpClient, authority = linearAuthority): SourceConnector {
  return createLinearConnector({ secrets, linearHttp, authority });
}

function recordGitHub(body: unknown): { client: GitHubHttpClient; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      async request(input) {
        calls.push(input);
        return { status: 200, body };
      },
    },
  };
}

// A realistic Linear backlog page: an urgent bug, a high-priority feature, a
// chore with no priority, an issue with only an identifier, and a degenerate node.
const LINEAR_BACKLOG = [
  {
    id: "8f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8",
    identifier: "ENG-412",
    title: "Checkout throws on empty cart",
    description: "Repro: clear the cart, then submit. Stack points at submitOrder().",
    url: "https://linear.app/acme/issue/ENG-412",
    priority: 1,
    labels: { nodes: [{ name: "Bug" }, { name: "Checkout" }] },
  },
  {
    id: "1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809",
    identifier: "ENG-413",
    title: "CSV export for the reports page",
    description: "Finance wants a CSV download alongside the PDF.",
    url: "https://linear.app/acme/issue/ENG-413",
    priority: 2,
    labels: { nodes: [{ name: "feature" }] },
  },
  {
    id: "2b3c4d5e-6f70-8192-a3b4-c5d6e7f80912",
    identifier: "ENG-414",
    title: "Tidy up the settings copy",
    description: "",
    url: "https://linear.app/acme/issue/ENG-414",
    priority: 0,
    labels: { nodes: [] },
  },
  {
    id: "3c4d5e6f-7081-92a3-b4c5-d6e7f8091234",
    identifier: "ENG-415",
    url: "https://linear.app/acme/issue/ENG-415",
    priority: 4,
    labels: { nodes: [] },
  },
  // Neither a stable id nor any title signal — must be dropped.
  { priority: 3, labels: { nodes: [] } },
];

describe("linear connector — request wire shape", () => {
  it("POSTs the Linear GraphQL endpoint with the grant-resolved token and an open, team-scoped filter", async () => {
    const { client, calls } = recordLinear(envelope([]));
    await linearConnector(client).fetch(linearSource);

    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.endpoint).toBe("https://api.linear.app/graphql");
    // the token comes from the generation-addressed integration secret, never
    // from source config.
    expect(req.token).toBe("lin_api_token");
    expect(req.query).toContain("issues(filter: $filter, first: 50, orderBy: updatedAt)");
    expect(req.variables["filter"]).toEqual({
      // open == workflow-state TYPE, not a state name a workspace can rename.
      state: { type: { nin: ["completed", "canceled"] } },
      team: { key: { eq: "ENG" } },
    });
  });

  it("pushes a configured label filter into the GraphQL filter and omits it entirely when unset", async () => {
    const filtered = recordLinear(envelope([]));
    await linearConnector(filtered.client).fetch({
      ...linearSource,
      config: { provider: "linear", teamKey: "ENG", labels: ["spec-candidate", "bug"] },
    });
    expect(filtered.calls[0]!.variables["filter"]).toMatchObject({
      labels: { some: { name: { in: ["spec-candidate", "bug"] } } },
    });

    const unfiltered = recordLinear(envelope([]));
    await linearConnector(unfiltered.client).fetch(linearSource);
    expect(unfiltered.calls[0]!.variables["filter"]).not.toHaveProperty("labels");
  });

  it("throws when the authorized generation secret is absent from the secret store", async () => {
    const { client, calls } = recordLinear(envelope([]));
    await expect(linearConnector(client, missingSecretAuthority).fetch(linearSource)).rejects.toThrow(
      /missing integration secret for generation/u,
    );
    expect(calls).toEqual([]);
  });

  it("rejects a cloned authority before secret or Linear HTTP I/O", async () => {
    const { client, calls } = recordLinear(envelope([]));
    const authentic = await linearAuthority({ orgId: "org_a", projectId: "project_a", resourceId: "ENG" });
    const cloned = { ...authentic, metadata: { ...authentic.metadata } } as typeof authentic;
    const secretRead = vi.spyOn(secrets, "get");
    try {
      await expect(linearConnector(client, async () => cloned).fetch(linearSource)).rejects.toThrow(
        /org grant does not match/u,
      );
      expect(secretRead).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    } finally {
      secretRead.mockRestore();
    }
  });

  it("refuses a project-less intake source rather than resolving authority for a null project", async () => {
    const { client, calls } = recordLinear(envelope([]));
    await expect(linearConnector(client).fetch({ ...linearSource, projectId: null })).rejects.toThrow(
      /must name a project/u,
    );
    expect(calls).toEqual([]);
  });
});

describe("linear connector — normalization of a realistic backlog", () => {
  it("maps a Linear GraphQL page to candidates with description + deep-link bodies", async () => {
    const { client } = recordLinear(envelope(LINEAR_BACKLOG));
    const items = await linearConnector(client).fetch(linearSource);

    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({
      // the stable uuid, so a re-poll updates rather than duplicates.
      externalId: "linear-8f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8",
      title: "Checkout throws on empty cart",
      body:
        "Repro: clear the cart, then submit. Stack points at submitOrder().\n\n" +
        "https://linear.app/acme/issue/ENG-412",
      severity: "fail",
      projectId: "project_a",
    });
  });

  it("maps a bug label and Linear's priority scale onto inbox severity", async () => {
    const { client } = recordLinear(envelope(LINEAR_BACKLOG));
    const items = await linearConnector(client).fetch(linearSource);
    // urgent + a bug label
    expect(items[0]!.severity).toBe("fail");
    // priority 2 (High), no bug-shaped label
    expect(items[1]!.severity).toBe("warn");
    // no priority, no labels
    expect(items[2]!.severity).toBe("info");
    // priority 4 (Low)
    expect(items[3]!.severity).toBe("info");
  });

  it("falls back to the human identifier when an issue has no title, and drops rows with neither", async () => {
    const { client } = recordLinear(envelope(LINEAR_BACKLOG));
    const items = await linearConnector(client).fetch(linearSource);
    expect(items[3]!.title).toBe("ENG-415");
    // the degenerate node contributed nothing.
    expect(items.map((item) => item.externalId)).not.toContain("linear-undefined");
  });

  it("emits a url-only body for a description-less issue", async () => {
    const { client } = recordLinear(
      envelope([{ id: "u1", title: "no description", url: "https://linear.app/acme/issue/ENG-9", priority: 0 }]),
    );
    const items = await linearConnector(client).fetch(linearSource);
    expect(items[0]!.body).toBe("https://linear.app/acme/issue/ENG-9");
  });
});

describe("linear connector — no silent fallbacks", () => {
  it("classifies a 401 as a loud auth error, never 'no issues'", async () => {
    const { client } = recordLinear({ message: "authentication required" }, 401);
    await expect(linearConnector(client).fetch(linearSource)).rejects.toThrow(IntakeSourceAuthError);
  });

  it("surfaces a 429 as a provider-directed delay the durable poller schedules", async () => {
    const { client } = recordLinear({}, 429, { "retry-after": "45" });
    const error = await linearConnector(client)
      .fetch(linearSource)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IntakeSourceRateLimitError);
    expect((error as IntakeSourceRateLimitError).retryAfterMs).toBe(45_000);
  });

  it("classifies a stable 400 as a resource error rather than a retriable transient", async () => {
    const { client } = recordLinear({ errors: [{ message: "unknown team" }] }, 400);
    await expect(linearConnector(client).fetch(linearSource)).rejects.toThrow(IntakeSourceResourceError);
  });

  it("THROWS on a 200 carrying GraphQL errors — the whole point of a GraphQL connector", async () => {
    // Linear answers a revoked token, an unreadable team, or a schema drift with
    // HTTP 200 + `errors`. Reading that as an empty backlog would silently stop
    // roadmap intake with no signal anywhere.
    const { client } = recordLinear({ errors: [{ message: "Authentication required, not authenticated" }] }, 200);
    await expect(linearConnector(client).fetch(linearSource)).rejects.toThrow(IntakeSourceFetchError);
  });

  it("THROWS on a 200 whose body has no data.issues.nodes array", async () => {
    const missing = recordLinear({ data: { issues: {} } }, 200);
    await expect(linearConnector(missing.client).fetch(linearSource)).rejects.toThrow(IntakeSourceFetchError);
    const notJson = recordLinear("<html>gateway</html>", 200);
    await expect(linearConnector(notJson.client).fetch(linearSource)).rejects.toThrow(IntakeSourceFetchError);
  });

  it("returns a genuine empty list on a 200 with an empty nodes array", async () => {
    const { client } = recordLinear(envelope([]), 200);
    expect(await linearConnector(client).fetch(linearSource)).toHaveLength(0);
  });
});

describe("issues dispatcher — routes Linear, and the gate stays closed", () => {
  function dispatcher(): { connector: SourceConnector; linearCalls: LinearHttpRequest[]; githubCalls: unknown[] } {
    const linear = recordLinear(envelope([{ id: "lin_z", title: "linear issue", url: "https://l/z", priority: 0 }]));
    const github = recordGitHub([{ number: 1, title: "github issue", body: "", labels: [] }]);
    return {
      linearCalls: linear.calls,
      githubCalls: github.calls,
      connector: createIssuesDispatcher({
        github: createGitHubIssuesConnector({
          secrets,
          githubHttp: github.client,
          defaultStaticRef: "credential/github/org/org_a/default",
        }),
        linear: linearConnector(linear.client),
      }),
    };
  }

  it("routes provider 'linear' to the Linear connector", async () => {
    const { connector, linearCalls, githubCalls } = dispatcher();
    const items = await connector.fetch(linearSource);
    expect(items.map((item) => item.externalId)).toEqual(["linear-lin_z"]);
    expect(linearCalls).toHaveLength(1);
    expect(githubCalls).toEqual([]);
  });

  it("routes a provider-less config to GitHub, so every persisted GitHub source keeps working", async () => {
    const { connector, linearCalls, githubCalls } = dispatcher();
    const items = await connector.fetch(githubSource);
    expect(items.map((item) => item.externalId)).toEqual(["gh-acme/app#1"]);
    expect(githubCalls).toHaveLength(1);
    expect(linearCalls).toEqual([]);
  });

  it.each([
    ["jira, a provider whose bare-token connector was deleted", { provider: "jira", projectKey: "ENG" }],
    ["an issue tracker nobody has implemented", { provider: "shortcut", projectKey: "ENG" }],
    ["the removed GitHub discriminator", { provider: "github", owner: "acme", repo: "app", labels: [] }],
    ["a non-string provider", { provider: 7, teamKey: "ENG" }],
    ["a source-owned Linear token", { provider: "linear", teamKey: "ENG", tokenRef: "credential/linear/x" }],
    ["a source-owned GitHub static ref", { owner: "acme", repo: "app", labels: [], staticRef: "credential/x" }],
  ])("still refuses %s before either connector runs", async (_label, config) => {
    const { connector, linearCalls, githubCalls } = dispatcher();
    const secretRead = vi.spyOn(secrets, "get");
    try {
      await expect(connector.fetch({ ...linearSource, config } as unknown as InboxSource)).rejects.toThrow(
        UnsupportedInboxProviderError,
      );
      expect(secretRead).not.toHaveBeenCalled();
      expect(linearCalls).toEqual([]);
      expect(githubCalls).toEqual([]);
    } finally {
      secretRead.mockRestore();
    }
  });

  it("refuses a Linear config handed directly to the GitHub connector, and the converse", async () => {
    const github = recordGitHub([]);
    const githubOnly = createGitHubIssuesConnector({
      secrets,
      githubHttp: github.client,
      defaultStaticRef: "credential/github/org/org_a/default",
    });
    await expect(githubOnly.fetch(linearSource)).rejects.toThrow(UnsupportedInboxProviderError);
    expect(github.calls).toEqual([]);

    const linear = recordLinear(envelope([]));
    await expect(linearConnector(linear.client).fetch(githubSource)).rejects.toThrow(UnsupportedInboxProviderError);
    expect(linear.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End to end: a realistic Linear payload becomes persisted candidates.
// ---------------------------------------------------------------------------

function stubPool(): { pool: pg.Pool; candidates: Map<string, Record<string, unknown>> } {
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("INSERT INTO candidates")) {
      const [id, sourceId, orgId, projectId, externalId, title, body, severity, status, triage] = params as string[];
      const key = `${sourceId}::${externalId}`;
      const cid = byExternal.get(key) ?? id;
      const row = {
        id: cid,
        source_id: sourceId,
        org_id: orgId,
        project_id: projectId,
        external_id: externalId,
        title,
        body,
        severity,
        status,
        triage: JSON.parse(triage) as unknown,
        resolved_spec_id: null,
        source_name: linearSource.name,
        source_kind: linearSource.kind,
      };
      candidates.set(cid, row);
      byExternal.set(key, cid);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { pool: { query } as unknown as pg.Pool, candidates };
}

function depsFor(connector: SourceConnector, pool: pg.Pool): InboxEngineDeps {
  return {
    pool,
    connectors: new Map<string, SourceConnector>([["issues", connector]]),
    answerer: createDeterministicTriageAnswerer(),
  };
}

describe("linear intake — end to end through ingestSource", () => {
  it("turns a realistic Linear backlog into triaged candidates", async () => {
    const { client } = recordLinear(envelope(LINEAR_BACKLOG));
    const { pool, candidates } = stubPool();
    const { candidates: out } = await ingestSource(depsFor(linearConnector(client), pool), linearSource);

    expect(out).toHaveLength(4);
    expect(candidates.size).toBe(4);
    expect(out[0]?.externalId).toBe("linear-8f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8");
    expect(out[0]?.title).toBe("Checkout throws on empty cart");
    expect(out[0]?.severity).toBe("fail");
    expect(out[0]?.status).toBe("triaged");
    expect(out[0]?.triage).not.toBeNull();
  });

  it("is idempotent: re-ingesting the same Linear issue updates rather than duplicates", async () => {
    const nodes = [{ id: "lin_stable", title: "v1", url: "https://linear.app/acme/issue/ENG-1", priority: 0 }];
    const { client } = recordLinear(envelope(nodes));
    const { pool, candidates } = stubPool();
    const deps = depsFor(linearConnector(client), pool);

    await ingestSource(deps, linearSource);
    nodes[0]!.title = "v2";
    await ingestSource(deps, linearSource);

    expect(candidates.size).toBe(1);
    expect([...candidates.values()][0]?.title).toBe("v2");
  });
});
