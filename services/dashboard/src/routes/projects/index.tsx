/**
 * Project view, specs, and routing settings (append-only screen registry).
 * DAG mode via `?mode=dag`; spec drawer/full-page lives in `./specRoutes`.
 */

import type { Context, Hono } from "hono";
import { formField } from "../formField.js";
import { OrchestratorClient } from "../../api/orchestrator.js";
import { getProjectDag, ProjectDagUnavailableError } from "../../api/projectDag.js";
import { ROLE_IDS, type ProjectConfig, type RoleId, type RoutingChainEntry } from "../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { ProjectDagBody, ProjectDagUnavailableBody } from "../../components/project/ProjectDagBody.js";
import { ProjectViewBody } from "../../components/project/ProjectViewBody.js";
import { buildProjectViewModel, summarizeRunCosts } from "../../components/project/projectViewData.js";
import { SettingsBody } from "../../components/project/SettingsBody.js";
import { resolveConfig } from "./projectConfig.js";
import { SpecCreateBody, SpecListBody } from "../../components/project/SpecCreateBody.js";
import { mountSpecDetailRoutes, notFoundBody, resolveProjectMode } from "./specRoutes.js";

function clientFor(c: Context, deps: ShellDeps): OrchestratorClient {
  return new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

/** Session CSRF for writes — inlined to stay under max-dependencies (import cap). */
async function writeClient(c: Context, deps: ShellDeps): Promise<OrchestratorClient> {
  const cookieHeader = c.req.header("cookie");
  const probe = new OrchestratorClient({ orchestratorUrl: deps.orchestratorUrl, cookieHeader });
  const session = await probe.session();
  const csrfToken = session?.csrfToken;
  return new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader,
    ...(csrfToken !== undefined && csrfToken !== "" ? { csrfToken } : {}),
  });
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter((v) => v.length > 0);
}

export function mountProjectScreens(app: Hono, deps: ShellDeps): void {
  // -------------------------------------------------------------------------
  // Chat-primary project view (overrides the placeholder).
  // -------------------------------------------------------------------------
  app.get("/projects/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "projects", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return renderShell(
        c,
        ctx,
        { title: `tanren · ${projectId}` },
        <div class="p2b">
          <div class="page-head">
            <div>
              <div class="eyebrow">project · not found</div>
              <div class="page-title">project not found</div>
            </div>
          </div>
          <div class="page-body">
            <section class="placeholder-card">
              <p>No project {projectId} is visible to you.</p>
            </section>
          </div>
        </div>,
      );
    }
    const orgId = ctx.org.id;
    // GET is read-only: never mint forge threads/turns from a safe method.
    // Live narration is POST /forge/project-narration (inbound CSRF + outbound
    // clientDepsFor). Pulse falls back to data-derived copy when undefined.
    const client = clientFor(c, deps);
    const mode = resolveProjectMode(c);
    const [runsMaybe, insights, milestones, feed] = await Promise.all([
      client.listRunsMaybe(orgId, projectId),
      client.listInsights(orgId, projectId),
      client.listMilestones(orgId, projectId),
      client.listFeed(orgId, projectId),
    ]);
    const runs = runsMaybe ?? [];
    const model = buildProjectViewModel({
      projectId,
      projectName: ctx.project.name,
      runs,
      runsAvailable: runsMaybe !== undefined,
      insights,
      milestones,
      feed,
      narration: undefined,
      weekSpend: summarizeRunCosts(runs),
    });
    const view = (
      <ProjectViewBody
        projectId={projectId}
        projectName={ctx.project.name}
        orgId={orgId}
        model={model}
        insights={insights}
        csrfToken={ctx.csrfToken}
      />
    );
    if (mode !== "dag") return renderShell(c, ctx, { title: `tanren · ${ctx.project.name}` }, view);
    try {
      const dag = await getProjectDag(client, orgId, projectId);
      return renderShell(
        c,
        ctx,
        { title: `tanren · ${ctx.project.name} · dag` },
        <ProjectDagBody projectId={projectId} projectName={ctx.project.name} dag={dag} model={model} />,
      );
    } catch (error) {
      if (!(error instanceof ProjectDagUnavailableError)) throw error;
      return renderShell(
        c,
        ctx,
        { title: `tanren · ${ctx.project.name} · dag` },
        <ProjectDagUnavailableBody projectId={projectId} projectName={ctx.project.name} model={model} />,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Spec list.
  // -------------------------------------------------------------------------
  app.get("/projects/:projectId/specs", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "projects", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return renderShell(c, ctx, { title: "tanren · specs" }, notFoundBody(projectId));
    }
    const client = clientFor(c, deps);
    const [specs, runsMaybe] = await Promise.all([
      client.listSpecs(ctx.org.id, projectId),
      client.listRunsMaybe(ctx.org.id, projectId),
    ]);
    const runBySpec: Record<string, string | undefined> = {};
    for (const run of runsMaybe ?? []) {
      if (runBySpec[run.specId] === undefined) runBySpec[run.specId] = run.runId;
    }
    return renderShell(
      c,
      ctx,
      { title: `tanren · ${ctx.project.name} specs` },
      <SpecListBody
        project={ctx.project}
        specs={specs}
        runBySpec={runBySpec}
        runsAvailable={runsMaybe !== undefined}
        csrfToken={ctx.csrfToken}
      />,
    );
  });

  // -------------------------------------------------------------------------
  // Spec creation form.
  // -------------------------------------------------------------------------
  app.get("/projects/:projectId/specs/new", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "projects", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return renderShell(c, ctx, { title: "tanren · new spec" }, notFoundBody(projectId));
    }
    const client = clientFor(c, deps);
    const [milestones, behaviors, specs] = await Promise.all([
      client.listMilestones(ctx.org.id, projectId),
      client.listAllBehaviors(ctx.org.id, projectId),
      client.listSpecs(ctx.org.id, projectId),
    ]);
    return renderShell(
      c,
      ctx,
      { title: `tanren · new spec` },
      <SpecCreateBody
        project={ctx.project}
        milestones={milestones}
        behaviors={behaviors}
        specs={specs}
        csrfToken={ctx.csrfToken}
      />,
    );
  });

  // spec drawer fragment + full-page spec view (split into specRoutes
  // to stay under the line cap). Registered after `/specs/new` so the static
  // route is not shadowed by the `:specId` param route.
  mountSpecDetailRoutes(app, deps);

  // -------------------------------------------------------------------------
  // Create spec (POST →). Re-renders the form with an error banner on
  // failure; redirects to the spec list on success.
  // -------------------------------------------------------------------------
  app.post("/projects/:projectId/specs", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "projects", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return renderShell(c, ctx, { title: "tanren · new spec" }, notFoundBody(projectId));
    }
    const form = await c.req.parseBody({ all: true });
    const title = formField(form, "title").trim();
    const description = formField(form, "description").trim();
    const acceptanceCriteria = asArray(form["acceptanceCriteria"] as string | string[] | undefined);
    const dependsOn = asArray(form["dependsOn"] as string | string[] | undefined);
    const milestoneId = formField(form, "milestoneId");

    const client = await writeClient(c, deps);
    const reRender = (error: string) =>
      renderForm(c, ctx, deps, projectId, error, {
        title,
        description,
        acceptanceCriteria,
        milestoneId,
      });

    if (title === "" || description === "" || acceptanceCriteria.length === 0) {
      return reRender("title, description, and at least one acceptance criterion are required.");
    }

    const result = await client.createSpec(ctx.org.id, projectId, {
      title,
      description,
      acceptanceCriteria,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
    });
    if (!result.ok) {
      return reRender(
        result.status === 0
          ? "could not reach the orchestrator. try again."
          : `spec creation failed (status ${result.status}).`,
      );
    }
    // Milestone + behavior associations are carried as form fields; the
    // create-spec route persists the spec, and the run-detail loader already
    // reads spec↔milestone/behavior links from join tables. v0 leaves
    // the association write to the planner; the operator's selections are
    // forwarded but not yet bound here (documented punt — see PR body).
    return c.redirect(`/projects/${projectId}/specs`);
  });

  // -------------------------------------------------------------------------
  // Suboptimal-callout action: proxy the carried Forge tool call to the forge route
  // via the dashboard's existing /forge/tools proxy contract, then redirect
  // back to the project view.
  // -------------------------------------------------------------------------
  app.post("/projects/:projectId/insights/act", async (c) => {
    const projectId = c.req.param("projectId");
    const form = await c.req.parseBody();
    const orgId = formField(form, "orgId");
    const tool = formField(form, "tool");
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(formField(form, "args", "{}")) as Record<string, unknown>;
    } catch {
      args = {};
    }
    if (orgId === "" || tool === "") {
      return c.redirect(`/projects/${projectId}?insightErr=missing`);
    }
    const client = await writeClient(c, deps);
    const result = await client.invokeForgeTool(orgId, tool, args);
    if (result === undefined) {
      return c.redirect(`/projects/${projectId}?insightErr=tool_failed`);
    }
    return c.redirect(`/projects/${projectId}?insightOk=1`);
  });

  // Routing & limits settings screens (+ their config-mutation POSTs) live in
  // `mountRoutingSettingsScreens` below — same registrations, behavior-identical.
  mountRoutingSettingsScreens(app, deps);
}

/**
 * The routing & limits settings surface: the active-project shortcut, the
 * explicit per-project view, and the add / remove / reorder / credentials /
 * hatches config-mutation POSTs. Extracted from `mountProjectScreens` so each
 * route builder stays focused; every registration is byte-for-byte the prior
 * inline call.
 */
function mountRoutingSettingsScreens(app: Hono, deps: ShellDeps): void {
  // -------------------------------------------------------------------------
  // Routing & limits — active project shortcut + explicit project route.
  // -------------------------------------------------------------------------
  app.get("/settings/routing", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "settings" });
    const project = ctx.projects[0];
    if (ctx.org === undefined || project === undefined) {
      return renderShell(
        c,
        ctx,
        { title: "tanren · routing & limits" },
        <div class="p2b">
          <div class="page-head">
            <div>
              <div class="eyebrow">▮ settings · routing &amp; limits</div>
              <div class="page-title">no project yet</div>
            </div>
          </div>
          <div class="page-body">
            <section class="placeholder-card">
              <p>
                Link a project first — routing chains are per-project. <a href="/onboarding/existing">link a repo ↗</a>
              </p>
            </section>
          </div>
        </div>,
      );
    }
    return c.redirect(`/settings/routing/${project.projectId}`);
  });

  app.get("/settings/routing/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "settings", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return renderShell(c, ctx, { title: "tanren · routing & limits" }, notFoundBody(projectId));
    }
    const client = clientFor(c, deps);
    const [detail, orgCredentials, org] = await Promise.all([
      client.getProject(ctx.org.id, projectId),
      client.listOrgCredentials(ctx.org.id),
      client.getOrg(ctx.org.id),
    ]);
    const { routing } = resolveConfig(detail?.config);
    const boundCredentials = detail?.config?.credentials ?? {};
    const saved = c.req.query("saved") === "1";
    // surface the org audit-gate state so the toggle reflects reality.
    const auditGate = org?.config.auditGateEnabled === true;
    return renderShell(
      c,
      ctx,
      { title: `tanren · ${ctx.project.name} routing` },
      <SettingsBody
        project={ctx.project}
        routing={routing}
        orgId={ctx.org.id}
        auditGate={auditGate}
        auditGateRepo={org?.config.auditGate?.repo}
        saved={saved}
        orgCredentials={orgCredentials}
        boundCredentials={boundCredentials}
        csrfToken={ctx.csrfToken}
      />,
    );
  });

  // -------------------------------------------------------------------------
  // Config mutations — add / remove / reorder a chain entry, save hatches.
  // Each loads the merged config, applies the edit, PATCHes it back.
  // -------------------------------------------------------------------------
  app.post("/settings/routing/:projectId/add", async (c) => {
    const projectId = c.req.param("projectId");
    const form = await c.req.parseBody();
    const orgId = formField(form, "orgId");
    const role = formField(form, "role") as RoleId;
    // A BLANK model field is the operator saying "use this provider's pinned
    // default" — the entry is stored with NO `model` key (the routing schema's
    // named representation of that), never with a placeholder string.
    const model = formField(form, "model").trim();
    const entry: RoutingChainEntry = {
      cli: formField(form, "cli").trim(),
      ...(model !== "" && { model }),
      authRef: formField(form, "authRef").trim(),
    };
    await mutateConfig(c, deps, orgId, projectId, (config) => {
      if (ROLE_IDS.includes(role) && entry.cli !== "" && entry.authRef !== "") {
        config.routing[role].chain.push(entry);
      }
    });
    return c.redirect(`/settings/routing/${projectId}?saved=1`);
  });

  app.post("/settings/routing/:projectId/remove", async (c) => {
    const projectId = c.req.param("projectId");
    const form = await c.req.parseBody();
    const orgId = formField(form, "orgId");
    const role = formField(form, "role") as RoleId;
    const index = Number(form["index"] ?? "-1");
    await mutateConfig(c, deps, orgId, projectId, (config) => {
      if (ROLE_IDS.includes(role)) {
        const chain = config.routing[role].chain;
        if (index >= 0 && index < chain.length) chain.splice(index, 1);
      }
    });
    return c.redirect(`/settings/routing/${projectId}?saved=1`);
  });

  app.post("/settings/routing/:projectId/reorder", async (c) => {
    const projectId = c.req.param("projectId");
    const form = await c.req.parseBody();
    const orgId = formField(form, "orgId");
    const role = formField(form, "role") as RoleId;
    const index = Number(form["index"] ?? "-1");
    const direction = formField(form, "direction");
    await mutateConfig(c, deps, orgId, projectId, (config) => {
      if (!ROLE_IDS.includes(role)) return;
      const chain = config.routing[role].chain;
      const target = direction === "up" ? index - 1 : index + 1;
      if (index >= 0 && index < chain.length && target >= 0 && target < chain.length) {
        const [moved] = chain.splice(index, 1);
        if (moved !== undefined) chain.splice(target, 0, moved);
      }
    });
    return c.redirect(`/settings/routing/${projectId}?saved=1`);
  });

  // Bind the project's default LLM + GitHub credential refs. An empty submitted
  // value clears the binding so the run inherits the org default. The selected
  // codex bundle is wrapped into the provider-agnostic default-LLM entry
  // ({cli,model,authRef}) the orchestrator config now expects.
  app.post("/settings/routing/:projectId/credentials", async (c) => {
    const projectId = c.req.param("projectId");
    const form = await c.req.parseBody();
    const orgId = formField(form, "orgId");
    const codexCredentialRef = formField(form, "codexCredentialRef").trim();
    const githubCredentialRef = formField(form, "githubCredentialRef").trim();
    await mutateConfig(c, deps, orgId, projectId, (config) => {
      const credentials: {
        defaultLlm?: { cli: string; model?: string; authRef: string };
        githubCredentialRef?: string;
      } = {};
      // Binding a credential selects the CREDENTIAL, not a model: the entry omits
      // `model`, which the routing schema reads as "use this provider's pinned
      // default". It must NOT be the literal "default" — that sentinel reached the
      // provider verbatim and 400'd the run.
      if (codexCredentialRef !== "") credentials.defaultLlm = { cli: "codex", authRef: codexCredentialRef };
      if (githubCredentialRef !== "") credentials.githubCredentialRef = githubCredentialRef;
      if (Object.keys(credentials).length === 0) {
        delete config.credentials;
      } else {
        config.credentials = credentials;
      }
    });
    return c.redirect(`/settings/routing/${projectId}?saved=1`);
  });
}

/**
 * Load the merged config, apply `edit` to a working copy, PATCH it back. The
 * working copy is built from a defaulted routing table so the PATCH always sends
 * a complete, schema-valid config.
 */
async function mutateConfig(
  c: Context,
  deps: ShellDeps,
  orgId: string,
  projectId: string,
  edit: (config: ProjectConfig) => void,
): Promise<void> {
  if (orgId === "") return;
  const client = await writeClient(c, deps);
  const detail = await client.getProject(orgId, projectId);
  const resolved = resolveConfig(detail?.config);
  const working: ProjectConfig = {
    ...(detail?.config ?? {
      version: 1,
      routing: resolved.routing,
    }),
    version: 1,
    routing: resolved.routing,
  };
  edit(working);
  await client.patchProjectConfig(orgId, projectId, working);
}

/** Re-render the spec form (shared by the create-spec validation/error path). */
async function renderForm(
  c: Context,
  ctx: Awaited<ReturnType<typeof loadShellContext>>,
  deps: ShellDeps,
  projectId: string,
  error: string,
  values: { title: string; description: string; acceptanceCriteria: string[]; milestoneId: string },
) {
  if (ctx.org === undefined || ctx.project === undefined) {
    return renderShell(c, ctx, { title: "tanren · new spec" }, notFoundBody(projectId));
  }
  const client = clientFor(c, deps);
  const [milestones, behaviors, specs] = await Promise.all([
    client.listMilestones(ctx.org.id, projectId),
    client.listAllBehaviors(ctx.org.id, projectId),
    client.listSpecs(ctx.org.id, projectId),
  ]);
  return renderShell(
    c,
    ctx,
    { title: "tanren · new spec" },
    <SpecCreateBody
      project={ctx.project}
      milestones={milestones}
      behaviors={behaviors}
      specs={specs}
      error={error}
      values={values}
      csrfToken={ctx.csrfToken}
    />,
  );
}
