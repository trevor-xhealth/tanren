// Projects-screen verification harness — `app.request`-based rendered-HTML + POST
// behavior assertions for the chat-primary project view, spec creation, and
// routing & limits settings. Mirrors the shell test pattern
// (tests/shell.render.test.ts): stub the pg pool + mock the orchestrator
// product APIs via global fetch, then assert the rendered screens.
//
// Coverage maps to the three acceptance-criteria checklists:
//   - project-view-chat-primary.md: page head, KPI strip, narration pulse,
//     attention queue, subopt callouts (supported kinds), velocity, activity, dag.
//   - project-and-spec.md: spec list, spec creation form (schema-bound, no JSON
//     editor), create POST.
//   - routing-and-limits.md: 6-role chains, vault panel, escape hatches,
//     audit-gate off caption, add/reorder/remove + save flows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  build,
  forgeMutationCalls,
  mockOrchestrator,
  patchCalls,
  specCreateCalls,
  toolCalls,
} from "./projects.render.fixtures.js";

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  patchCalls.length = 0;
  toolCalls.length = 0;
  specCreateCalls.length = 0;
  forgeMutationCalls.length = 0;
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

describe("project view (chat-primary)", () => {
  it("renders the page head, live indicator, and discover-spec CTA", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain("what needs");
    expect(html).toContain("your attention");
    expect(html).toContain("forge live");
    expect(html).toContain("/projects/project_easy/specs/new");
  });

  it("renders KPI numbers wired to real run/cost data", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain("in-flight runs");
    expect(html).toContain("needs you");
    expect(html).toContain("week spend");
    // one running run, one needs-review + one insight = 2 needs-you, $42.50 spend.
    expect(html).toContain("$42.5");
  });

  it("renders a data-derived project pulse without forge mutations on GET", async () => {
    const app = await build();
    const res = await app.request("/projects/project_easy");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("project pulse");
    // GET must not create forge threads / generate-project-view turns (CSRF residual #848).
    expect(forgeMutationCalls).toHaveLength(0);
    // Fallback pulse is data-derived from runs/spend (not the forge turn body).
    expect(html).toMatch(/run\(s\) in flight|is idle/u);
  });

  it("embeds csrf on insight action forms for pure HTML posts", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain('action="/projects/project_easy/insights/act"');
    expect(html).toContain('name="csrf"');
    expect(html).toContain('value="c"');
  });

  it("renders the attention queue with a review handoff routing to run detail", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain("things need you");
    expect(html).toContain("review-ready");
    expect(html).toContain("/projects/project_easy/runs/run_review");
  });

  it("renders subopt callouts including the P3-0020 review_stall kind", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain("retry hotspot");
    expect(html).toContain("writer retries on supplier-scorecard class");
    // review_stall now renders (kind label is underscore-stripped).
    expect(html).toContain("review stall on auth PR");
    // callout action posts the carried tool call.
    expect(html).toContain('action="/projects/project_easy/insights/act"');
    expect(html).toContain('value="tanren.create_spec"');
  });

  it("renders the velocity card with milestone ETA and the DAG snapshot", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain("velocity");
    // milestone ETA renders the target date (exact day is timezone-local).
    expect(html).toMatch(/Jun 1[78]/u);
    expect(html).toContain("dag · live");
    expect(html).toContain("dag-primary mode");
  });

  it("renders the activity feed from the event stream", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain("activity");
    expect(html).toContain("task write started");
  });

  it("invokes the carried Forge tool when a subopt action is submitted", async () => {
    const app = await build();
    const res = await app.request("/projects/project_easy/insights/act", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        orgId: "org_acme",
        tool: "tanren.acknowledge_insight",
        args: '{"insightId":"ins_1"}',
      }),
    });
    expect(res.status).toBe(302);
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0].body as { tool: string }).tool).toBe("tanren.acknowledge_insight");
  });
});

describe("on-demand project narration (CSRF-protected POST)", () => {
  const SESSION_COOKIE = "tanren_session=sess-project-narration";

  it("rejects narration POST with session cookie but missing csrf (403, no forge mutation)", async () => {
    const app = await build();
    const res = await app.request("/forge/project-narration", {
      method: "POST",
      headers: {
        cookie: SESSION_COOKIE,
        "content-type": "application/json",
      },
      body: JSON.stringify({ orgId: "org_acme", projectId: "project_easy" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("csrf_token_invalid");
    expect(forgeMutationCalls).toHaveLength(0);
  });

  it("accepts narration POST with matching x-csrf-token and mutates forge", async () => {
    const app = await build();
    const res = await app.request("/forge/project-narration", {
      method: "POST",
      headers: {
        cookie: SESSION_COOKIE,
        "content-type": "application/json",
        "x-csrf-token": "c",
      },
      body: JSON.stringify({ orgId: "org_acme", projectId: "project_easy" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { render?: { body?: string } };
    expect(json.render?.body).toContain("1 PR review-ready");
    expect(forgeMutationCalls.length).toBeGreaterThanOrEqual(1);
    expect(forgeMutationCalls.some((c) => c.url.includes("/forge/threads"))).toBe(true);
    expect(forgeMutationCalls.some((c) => c.url.includes("/generate-project-view"))).toBe(true);
  });
});

describe("spec creation + list", () => {
  it("renders a schema-bound spec form with milestone, behaviors, and locked repo — no JSON editor", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy/specs/new")).text();
    expect(html).toContain('name="title"');
    expect(html).toContain('name="description"');
    expect(html).toContain('name="acceptanceCriteria"');
    expect(html).toContain('name="milestoneId"');
    expect(html).toContain("M7 · perf");
    expect(html).toContain('name="behaviorIds"');
    expect(html).toContain("can export scorecard");
    // repo locked to the project repo.
    expect(html).toContain("https://github.com/cat-cave/tanren-fixture-easy");
    // no free-text JSON editor.
    expect(html).not.toMatch(/JSON\s*editor/iu);
    // pure-HTML posts need the server-rendered csrf field (injectFormCsrfFields is only a JS safety net).
    expect(html).toContain('name="csrf"');
    expect(html).toContain('value="c"');
  });

  it("creates a spec via P2A-0013 and redirects to the spec list", async () => {
    const app = await build();
    const res = await app.request("/projects/project_easy/specs", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["title", "new spec"],
        ["description", "does a thing"],
        ["acceptanceCriteria", "criterion one"],
        ["milestoneId", "m_7"],
      ]),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/projects/project_easy/specs");
    expect(specCreateCalls).toHaveLength(1);
    const body = specCreateCalls[0].body as { title: string; acceptanceCriteria: string[] };
    expect(body.title).toBe("new spec");
    expect(body.acceptanceCriteria).toEqual(["criterion one"]);
  });

  it("re-renders the form with an error when required fields are missing", async () => {
    const app = await build();
    const res = await app.request("/projects/project_easy/specs", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "", description: "", acceptanceCriteria: "" }),
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("required");
    expect(specCreateCalls).toHaveLength(0);
  });

  it("lists specs with a link to the most-recent run", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy/specs")).text();
    expect(html).toContain("supplier scorecard");
    expect(html).toContain("/projects/project_easy/runs/run_live");
  });
});

describe("routing & limits settings", () => {
  it("renders all six role rows generated from the P2A-0006 schema", async () => {
    const app = await build();
    const html = await (await app.request("/settings/routing/project_easy")).text();
    for (const role of ["plan", "write", "check", "audit", "demo", "forge"]) {
      expect(html).toContain(`▸ ${role}`);
    }
    // the configured Codex plan entry renders as preferred.
    expect(html).toContain("preferred");
    expect(html).toContain("gpt-5.5");
    expect(html).toContain("vault://dev/codex/chatgpt");
  });

  it("renders the vault panel + the audit-gate-OFF caption (no escape-hatches panel — apex v35)", async () => {
    const app = await build();
    const html = await (await app.request("/settings/routing/project_easy")).text();
    expect(html).toContain("per-cred policy");
    // The escape-hatches editor is GONE — there are no hardcoded attempt caps to tune.
    expect(html).not.toContain("escape hatches");
    expect(html).not.toContain("max writer iter per subtask");
    expect(html).toContain("edits land in the dashboard");
    expect(html).not.toContain("review before merge");
  });

  it("handles a 1-entry chain (add fallback control present for every role)", async () => {
    const app = await build();
    const html = await (await app.request("/settings/routing/project_easy")).text();
    expect((html.match(/\+ add fallback/gu) ?? []).length).toBe(6);
  });

  it("adds a fallback entry and PATCHes the full config back", async () => {
    const app = await build();
    const res = await app.request("/settings/routing/project_easy/add", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        orgId: "org_acme",
        role: "write",
        cli: "codex",
        model: "gpt-5.5",
        authRef: "vault://dev/codex/chatgpt",
      }),
    });
    expect(res.status).toBe(302);
    expect(patchCalls).toHaveLength(1);
    const body = patchCalls[0].body as {
      config: { routing: Record<string, { chain: unknown[] }> };
    };
    expect(body.config.routing.write.chain).toHaveLength(1);
  });

  it("removes a chain entry", async () => {
    const app = await build();
    const res = await app.request("/settings/routing/project_easy/remove", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ orgId: "org_acme", role: "plan", index: "0" }),
    });
    expect(res.status).toBe(302);
    const body = patchCalls[0].body as {
      config: { routing: Record<string, { chain: unknown[] }> };
    };
    expect(body.config.routing.plan.chain).toHaveLength(0);
  });

  it("renders the credentials binding panel with org refs in both dropdowns", async () => {
    const app = await build();
    const html = await (await app.request("/settings/routing/project_easy")).text();
    expect(html).toContain("codex + github binding");
    expect(html).toContain("credential/codex/org/o/c");
    expect(html).toContain("credential/github/org/o/g");
    expect(html).toContain("inherit org default");
  });

  it("binds selected credential refs and PATCHes them into project config", async () => {
    const app = await build();
    const res = await app.request("/settings/routing/project_easy/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        orgId: "org_acme",
        codexCredentialRef: "credential/codex/org/o/c",
        githubCredentialRef: "credential/github/org/o/g",
      }),
    });
    expect(res.status).toBe(302);
    expect((patchCalls[0].body as { config: { credentials: unknown } }).config.credentials).toEqual({
      // NO `model`: binding a credential selects the CREDENTIAL, not a model. An
      // absent model is the routing schema's "use this provider's pinned default";
      // the old `model: "default"` sentinel 400'd at the provider.
      defaultLlm: { cli: "codex", authRef: "credential/codex/org/o/c" },
      githubCredentialRef: "credential/github/org/o/g",
    });
  });

  it("clears the binding when both selections are empty (inherit org default)", async () => {
    const app = await build();
    const res = await app.request("/settings/routing/project_easy/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        orgId: "org_acme",
        codexCredentialRef: "",
        githubCredentialRef: "",
      }),
    });
    expect(res.status).toBe(302);
    expect((patchCalls[0].body as { config: { credentials?: unknown } }).config.credentials).toBeUndefined();
  });

  it("redirects /settings/routing to the active project's routing page", async () => {
    const app = await build();
    const res = await app.request("/settings/routing");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings/routing/project_easy");
  });
});
