// brownfield onboarding (full track) HTTP routes. Layered on top of the
// minimal link endpoint (which lives in `./index.ts`); these add the
// deeper steps without touching the link handler:
//
//   POST /:orgId/projects/:projectId/recon
//     Read-only recon: index the linked repo via the App resolver + read-only
//     Answerer, return the pre-filled chapters + gaps. Writes nothing.
//
//   POST /:orgId/projects/:projectId/config-injection
//     Open ONE config-injection PR in the target repo with the kept files
//     (operator-excluded paths removed). "No runs until merged."
//
//   POST /:orgId/projects/:projectId/seed-dag
//     Turn recon gaps + open GitHub issues into seed specs (createSpec).
//
//   POST /:orgId/projects/:projectId/governance
//     Persist the chosen posture (strict | open | audit_only) onto the project
//     config. The external-push behavior is DERIVED from the posture
//     (see `governancePosture.ts`), so no new config field + no migration.
//
//   POST /:orgId/projects/:projectId/migration
//     Re-index the linked repo (read-only) and classify its existing automation
//     into workflow INTENT (not YAML) → native replacements → a migration-risk
//     report with the not-ready-while-security/compliance/production-dropped
//     rule. The report is TRANSIENT (returned, not persisted) — no migration.
//
// Every GitHub/Answerer seam is injectable so tests mock them. The recon report
// rides on the request between steps (transient — no interview-session table),
// mirroring the greenfield capture model: no migration.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { GovernancePosture, type GovernancePosture as GovernancePostureType } from "../../engine/config/shared.js";
import { migrateProjectConfig, mutateProjectConfig } from "../../engine/config/projectConfig.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import {
  loadOrgDefaultGithubCredentialRef,
  loadOrgGithubAppInstallation,
} from "../../engine/credentials/orgGithubApp.js";
import { resolveGithubToken, type ResolvedGithubToken } from "../../engine/credentials/githubTokenResolver.js";
import {
  FetchConfigInjectionGitHub,
  GithubRepoReader,
  openConfigInjectionPr,
  ownedInjectionPaths,
  proposeConfigFiles,
  runRecon,
  seedDagFromReconAndIssues,
  buildMigrationReport,
  classifyWorkflowIntents,
  BranchProtectionInput,
  type ConfigInjectionGitHub,
  type ReconAnswerer,
  type RepoReader,
} from "../../engine/forge/brownfield/index.js";
import type { ForgeAnswererTarget } from "../../engine/forge/providerFactory.js";
import { createGitHubIssuesConnector } from "../../engine/forge/inbox/githubConnector.js";
import type { IngestedItem } from "../../engine/forge/inbox/types.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import { parseGitHubRepository } from "../../engine/providers/github.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import { ProjectStore } from "../../engine/repositories/index.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";
import {
  InvalidOnboardingStateError,
  OnboardingStateSigner,
  type ReconStatePayload,
} from "../../engine/forge/onboardingState.js";

export interface BrownfieldFullTrackOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  // The recon answerer factory, called per-request with the request's org/project
  // so the answerer resolves THAT project's `forge` routing. Production passes
  // `buildForgeReconAnswererFactory` (a real provider answerer); tests pass a
  // fake. REQUIRED — there is no deterministic fallback.
  reconAnswererFactory: (target: ForgeAnswererTarget) => ReconAnswerer;
  // Test seams: override the repo reader / config-injection GitHub / issue
  // fetch so the routes are exercised without network.
  repoReaderFor?: (repoUrl: string, defaultBranch: string, resolved: ResolvedGithubToken) => RepoReader;
  configInjectionGithubFor?: (resolved: ResolvedGithubToken) => ConfigInjectionGitHub;
  fetchIssues?: (repoUrl: string, projectId: string) => Promise<IngestedItem[]>;
}

const ReconBody = z.object({ repoUrl: z.string().min(1).max(400) }).strict();

const ConfigInjectionBody = z
  .object({
    state: z.string().min(1).max(500_000),
    posture: GovernancePosture.default("strict"),
    excludePaths: z.array(z.string().min(1).max(400)).default([]),
  })
  .strict();

const SeedDagBody = z
  .object({
    state: z.string().min(1).max(500_000),
    includeIssues: z.boolean().default(true),
  })
  .strict();

const GovernanceBody = z.object({ posture: GovernancePosture }).strict();

const MigrationBody = z
  .object({
    repoUrl: z.string().min(1).max(400),
    // Branch protection / required checks arrive separately from the file tree;
    // the caller (or a future provider read) supplies them so the classifier can
    // account for required-status-checks + approval rules. Optional.
    branchProtection: z.array(BranchProtectionInput).default([]),
    // Intent ids the operator chose to drop. Dropping a security/compliance/
    // production intent flips `tanrenNativeReady` to false (the not-ready rule).
    droppedIds: z.array(z.string().min(1).max(120)).default([]),
  })
  .strict();

const systemActor = { kind: "system" } as const;

export function createBrownfieldFullTrackRoutes(options: BrownfieldFullTrackOptions) {
  const app = new Hono<ActorContextEnv>();
  const stateSigner = new OnboardingStateSigner(options.secrets);

  app.post("/:orgId/projects/:projectId/recon", async (c) => {
    const guard = await guardOrg(c, options.pool);
    if (guard.error !== undefined) return c.json({ error: guard.error }, guard.status);
    const parsed = ReconBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_recon", issues: parsed.error.issues }, 400);
    if (canonicalRepoUrl(parsed.data.repoUrl) !== canonicalRepoUrl(guard.repoUrl)) {
      return c.json({ error: "repo_project_mismatch" }, 400);
    }
    try {
      const resolved = await resolveTokenFor(options, guard.orgId);
      const reader =
        options.repoReaderFor?.(parsed.data.repoUrl, guard.defaultBranch, resolved) ??
        new GithubRepoReader({
          http: options.githubHttp,
          resolved,
          defaultBranch: guard.defaultBranch,
        });
      const { index, report } = await runRecon(
        {
          reader,
          answerer: options.reconAnswererFactory({ orgId: guard.orgId, projectId: c.req.param("projectId") }),
        },
        parsed.data.repoUrl,
      );
      const state = await stateSigner.signRecon({
        orgId: guard.orgId,
        projectId: guard.projectId,
        repoUrl: guard.repoUrl,
        report,
        // Recon is the only step that sees the repo TREE. Carry the injectable paths it
        // already owns forward on the signed state so config-injection proposes only what
        // it may actually write — the guard has to ride the state or it is not wired.
        existingPaths: ownedInjectionPaths(index.files.map((file) => file.path)),
      });
      return c.json({ repoUrl: guard.repoUrl, filesIndexed: index.filesIndexed, report, state }, 200);
    } catch (error) {
      return c.json({ error: "recon_failed", message: messageOf(error) }, 502);
    }
  });

  app.post("/:orgId/projects/:projectId/config-injection", async (c) => {
    const guard = await guardOrg(c, options.pool);
    if (guard.error !== undefined) return c.json({ error: guard.error }, guard.status);
    const parsed = ConfigInjectionBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_config_injection", issues: parsed.error.issues }, 400);
    let state: ReconStatePayload;
    try {
      state = await stateSigner.verifyRecon(parsed.data.state, {
        orgId: guard.orgId,
        projectId: guard.projectId,
        repoUrl: guard.repoUrl,
      });
    } catch (error) {
      if (!(error instanceof InvalidOnboardingStateError)) {
        return c.json({ error: "config_injection_failed", message: messageOf(error) }, 500);
      }
      return invalidStateResponse(error);
    }
    const repo = parseGitHubRepository(state.repoUrl);
    const files = proposeConfigFiles(
      {
        repoSlug: repo.name,
        orgLogin: repo.owner,
        repoUrl: state.repoUrl,
        report: state.report,
        posture: parsed.data.posture,
        generatedAt: new Date().toISOString(),
        // What recon observed the repo already owns — a `skip_if_present` file at one of
        // these paths is not proposed at all (the repo's justfile / CODEOWNERS / PR
        // template stay its own).
        existingPaths: state.existingPaths,
      },
      parsed.data.excludePaths,
    );
    try {
      const resolved = await resolveTokenFor(options, guard.orgId);
      const github =
        options.configInjectionGithubFor?.(resolved) ??
        new FetchConfigInjectionGitHub({
          http: options.githubHttp,
          token: resolved.token,
          refreshToken: resolved.refresh,
        });
      const pr = await openConfigInjectionPr({
        github,
        repoUrl: state.repoUrl,
        baseBranch: guard.defaultBranch,
        files,
      });
      return c.json(
        {
          pullRequest: pr,
          files: files.map((f) => ({ path: f.path, addedLines: f.addedLines })),
          noRunsUntilMerged: true,
        },
        201,
      );
    } catch (error) {
      return c.json({ error: "config_injection_failed", message: messageOf(error) }, 502);
    }
  });

  app.post("/:orgId/projects/:projectId/seed-dag", async (c) => {
    const guard = await guardOrg(c, options.pool);
    if (guard.error !== undefined) return c.json({ error: guard.error }, guard.status);
    const parsed = SeedDagBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_seed_dag", issues: parsed.error.issues }, 400);
    let state: ReconStatePayload;
    try {
      state = await stateSigner.verifyRecon(parsed.data.state, {
        orgId: guard.orgId,
        projectId: guard.projectId,
        repoUrl: guard.repoUrl,
      });
    } catch (error) {
      if (!(error instanceof InvalidOnboardingStateError)) {
        return c.json({ error: "seed_dag_failed", message: messageOf(error) }, 500);
      }
      return invalidStateResponse(error);
    }
    try {
      const issues = parsed.data.includeIssues
        ? await fetchIssuesFor(options, guard.orgId, guard.projectId, state.repoUrl)
        : [];
      const result = await seedDagFromReconAndIssues(options.pool, {
        projectId: guard.projectId,
        orgId: guard.orgId,
        report: state.report,
        issues,
        actor: { ...guard.actor, orgId: guard.orgId, projectId: guard.projectId },
      });
      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: "seed_dag_failed", message: messageOf(error) }, 500);
    }
  });

  app.post("/:orgId/projects/:projectId/governance", async (c) => {
    const guard = await guardOrg(c, options.pool);
    if (guard.error !== undefined) return c.json({ error: guard.error }, guard.status);
    const parsed = GovernanceBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_governance", issues: parsed.error.issues }, 400);
    const posture = parsed.data.posture;
    const next = await persistPosture(options.pool, guard.projectId, posture);
    return c.json(
      {
        projectId: guard.projectId,
        governancePosture: posture,
        externalPushPolicy: externalPushPolicy(posture),
        config: next,
      },
      200,
    );
  });

  // POST /:orgId/projects/:projectId/migration
  //   Re-index the linked repo (read-only, the SAME recon read surface), classify
  //   every discovered automation into workflow INTENT, and return the
  //   migration-risk report (per-item disposition + the not-ready verdict). The
  //   report is transient — it is RETURNED, never persisted as a new entity-shape
  //   (no migration). The repo reader + token resolution mirror the recon route.
  app.post("/:orgId/projects/:projectId/migration", async (c) => {
    const guard = await guardOrg(c, options.pool);
    if (guard.error !== undefined) return c.json({ error: guard.error }, guard.status);
    const parsed = MigrationBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_migration", issues: parsed.error.issues }, 400);
    try {
      const resolved = await resolveTokenFor(options, guard.orgId);
      const reader =
        options.repoReaderFor?.(parsed.data.repoUrl, guard.defaultBranch, resolved) ??
        new GithubRepoReader({
          http: options.githubHttp,
          resolved,
          defaultBranch: guard.defaultBranch,
        });
      const index = await reader.index(parsed.data.repoUrl);
      const intents = classifyWorkflowIntents({
        index,
        branchProtection: parsed.data.branchProtection,
      });
      const report = buildMigrationReport({
        repoUrl: parsed.data.repoUrl,
        intents,
        droppedIds: parsed.data.droppedIds,
      });
      return c.json({ filesIndexed: index.filesIndexed, intents, report }, 200);
    } catch (error) {
      return c.json({ error: "migration_failed", message: messageOf(error) }, 502);
    }
  });

  return app;
}

interface OrgGuard {
  orgId: string;
  projectId: string;
  defaultBranch: string;
  repoUrl: string;
  actor: ActorContext;
  error?: string;
  status: 403 | 404;
}

async function guardOrg(
  c: { req: { param(name: string): string }; var: { actor?: ActorContext } },
  pool: pg.Pool,
): Promise<OrgGuard> {
  const actor = c.var.actor;
  const orgId = c.req.param("orgId");
  const projectId = c.req.param("projectId");
  const base: OrgGuard = {
    orgId,
    projectId,
    defaultBranch: "main",
    repoUrl: "",
    actor: actor as ActorContext,
    status: 403,
  };
  if (actor === undefined) return { ...base, error: "actor_missing" };
  if (!actorCanAccessOrg(actor, orgId)) return { ...base, error: "org_access_denied", status: 403 };
  const ownership = await ProjectStore.getOwnership(pool, projectId, systemActor);
  if (ownership === undefined) return { ...base, error: "project_not_found", status: 404 };
  if (ownership.orgId !== null && ownership.orgId !== orgId)
    return { ...base, error: "project_access_denied", status: 403 };
  return { ...base, defaultBranch: ownership.defaultBranch ?? "main", repoUrl: ownership.repoUrl };
}

async function resolveTokenFor(options: BrownfieldFullTrackOptions, orgId: string): Promise<ResolvedGithubToken> {
  const installation = await loadOrgGithubAppInstallation(options.pool, orgId);
  // No App installation ⇒ resolve the org's default GitHub credential ref as the
  // static token source (no hardcoded default ref).
  const staticRef =
    installation === undefined ? await loadOrgDefaultGithubCredentialRef(options.pool, orgId) : undefined;
  return resolveGithubToken({
    secrets: options.secrets,
    orgId,
    ...(installation === undefined ? {} : { installation }),
    ...(staticRef === undefined ? {} : { staticRef }),
    ...(options.githubAppMinter === undefined ? {} : { minter: options.githubAppMinter }),
  });
}

async function fetchIssuesFor(
  options: BrownfieldFullTrackOptions,
  orgId: string,
  projectId: string,
  repoUrl: string,
): Promise<IngestedItem[]> {
  if (options.fetchIssues !== undefined) return options.fetchIssues(repoUrl, projectId);
  const repo = parseGitHubRepository(repoUrl);
  const installation = await loadOrgGithubAppInstallation(options.pool, orgId);
  // No App installation ⇒ the connector resolves the organization-bound default
  // GitHub credential. The ephemeral source config never carries a credential ref.
  const staticRef =
    installation === undefined ? await loadOrgDefaultGithubCredentialRef(options.pool, orgId) : undefined;
  const connector = createGitHubIssuesConnector({
    secrets: options.secrets,
    githubHttp: options.githubHttp,
    ...(installation === undefined ? {} : { installation }),
    ...(options.githubAppMinter === undefined ? {} : { minter: options.githubAppMinter }),
    ...(staticRef === undefined ? {} : { defaultStaticRef: staticRef }),
  });
  return connector.fetch({
    id: "brownfield-recon",
    orgId,
    projectId,
    kind: "issues",
    name: "brownfield recon issues",
    detail: "",
    config: { owner: repo.owner, repo: repo.name, labels: [] },
    enabled: true,
    autoRoute: false,
    state: "active",
    attention: null,
    retryNotBefore: null,
    webhookConfigured: false,
  });
}

async function persistPosture(pool: pg.Pool, projectId: string, posture: GovernancePostureType): Promise<unknown> {
  const result = await mutateProjectConfig(pool, projectId, systemActor, (config) => {
    const current = migrateProjectConfig(config);
    return { ...current, governancePosture: posture };
  });
  return result.config;
}

function externalPushPolicy(posture: GovernancePostureType): string {
  if (posture === "open") return "external pushes coexist · tracked, never blocked";
  if (posture === "audit_only") return "external pushes observed · tanren opens no PRs";
  return "external pushes warned + auto-spec'd · force-push blocked · main bypass fails the check";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidStateResponse(error: unknown): Response {
  const reason = error instanceof InvalidOnboardingStateError ? error.reason : "malformed";
  return new Response(JSON.stringify({ error: "invalid_onboarding_state", reason }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function canonicalRepoUrl(repoUrl: string): string {
  return repoUrl.replace(/\.git$/u, "");
}
