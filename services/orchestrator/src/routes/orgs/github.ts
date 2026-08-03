// Wave-2 operator API: human-drivable "Connect GitHub" + readiness routes,
// mirroring a real settings screen + an onboarding checklist. The gap this
// closes (found during live operation): to connect GitHub today an operator must
// hand-craft a raw `PATCH /orgs/:orgId` config with a `github_app` block
// (including an `installedAt` timestamp) or hand-set a `defaultCredentials`
// credential ref — nothing a real user does — and there is NO way to learn, up
// front, whether the connected identity holds the permissions Tanren needs, so
// runs fail late with a 403.
//
//   POST /orgs/:orgId/github          — connect GitHub (App install OR token).
//   GET  /orgs/:orgId/github          — the connected identity + its CAPABILITIES
//                                       (real check: runReady + classified gaps).
//   GET  /orgs/:orgId/onboarding-status — the single readiness checklist. Its
//                                       composition (including the ROUTE-AWARE
//                                       budget-ceiling rule) lives in the sibling
//                                       `onboardingReadiness.ts`.
//
// Org-scoped under RLS (the scoped pool); the writes require org-admin. The
// secret (App private key / PAT) is NEVER logged or returned — only refs and the
// non-secret `installedAt` (server-stamped) / login leave the boundary.

import { type Context, Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import {
  bindOrgGithubCredentialRefs,
  migrateOrgConfig,
  type OrgConfigV1,
  type OrgGithubAppInstallation,
} from "../../engine/config/orgConfig.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import { loadGithubAppCredential } from "../../engine/credentials/githubApp.js";
import {
  probeGithubAppCapability,
  probeGithubTokenCapability,
  UNCONNECTED_GITHUB_CAPABILITY,
  type GithubCapability,
} from "../../engine/credentials/githubCapability.js";
import { storeGithubToken } from "../../engine/credentials/githubToken.js";
import {
  loadOrgDefaultGithubCredentialRef,
  loadOrgGithubAppInstallation,
  persistOrgDefaultGithubCredentialRef,
  persistOrgGithubAppInstallation,
} from "../../engine/credentials/orgGithubApp.js";
import { canonicalOrgGithubCredentialRef, deriveCredentialRef } from "../../engine/credentials/refNamespace.js";
import { PgEventStore, type EventStore } from "../../engine/eventStore.js";
import { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "./access.js";
import {
  composeOnboardingStatus,
  ManagedProviderCredentialMissingError,
  resolveAiProviderStatus,
  type AiProviderStatus,
} from "./onboardingReadiness.js";

// Re-exported so existing importers of the readiness surface keep resolving from
// the route module they already depend on.
export { ManagedProviderCredentialMissingError };
export type { OnboardingStatus } from "./onboardingReadiness.js";

export interface GithubConnectRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  /** Shared minter so installation-token caching spans routes. */
  minter?: GithubAppTokenMinter;
  /**
   * The Vault ref of the platform-managed GitHub App credential (appId +
   * private key). Used as the default when a connect-by-install request omits a
   * `credentialRef`. Mirrors `TANREN_GITHUB_APP_CREDENTIAL_REF`.
   */
  appCredentialRef?: string;
  /** Injectable fetch for the capability probe (real GitHub by default). */
  fetchImpl?: typeof fetch;
  /** Event append seam for credential repair signals; defaults to PgEventStore. */
  events?: EventStore;
}

// Connect-by-App-install: GitHub gives the operator an `installationId` (+ the
// App `appId`); the App private key is already a managed credential (or the
// caller names its `credentialRef`). The operator MUST NOT supply a timestamp —
// `installedAt` is server-stamped.
const InstallConnectSchema = z
  .object({
    installationId: z.string().min(1),
    appId: z.string().min(1),
    credentialRef: z.string().min(1).optional(),
  })
  .strict();

// Connect-by-token: a raw PAT. Stored as a `github_token` credential under the
// org's namespace and set as the org's default GitHub credential.
const TokenConnectSchema = z.object({ token: z.string().min(1) }).strict();

export function createGithubConnectRoutes(options: GithubConnectRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const minter = options.minter ?? new GithubAppTokenMinter({ secrets: options.secrets });
  const events = options.events ?? new PgEventStore(options.pool);

  // POST /:orgId/github — connect GitHub. Body discriminates the two modes:
  //   { installationId, appId, credentialRef? } → App install
  //   { token }                                 → static token
  app.post("/:orgId/github", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    const raw = (await c.req.json().catch(() => {})) as unknown;

    const install = InstallConnectSchema.safeParse(raw);
    if (install.success) {
      return connectViaApp(c, options, minter, events, orgId, install.data);
    }
    const token = TokenConnectSchema.safeParse(raw);
    if (token.success) {
      return connectViaToken(c, options, events, actor, orgId, token.data.token);
    }
    // Neither shape matched — report the install-mode issues (the richer schema)
    // so the caller sees what a valid body looks like; the secret never echoes.
    return c.json({ error: "invalid_github_connect", issues: install.error.issues }, 400);
  });

  // GET /:orgId/github — the connected identity + a REAL capability check.
  app.get("/:orgId/github", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    let status: GithubConnectionStatus;
    try {
      status = await resolveGithubConnection(options, minter, orgId);
    } catch (error) {
      if (error instanceof GithubCredentialRefMissingError) {
        return c.json({ error: "github_credential_ref_missing", message: error.message, ref: error.ref }, 409);
      }
      return c.json({ error: "github_capability_check_failed", message: messageOf(error) }, 502);
    }
    return c.json(status);
  });

  // GET /:orgId/onboarding-status — the single readiness checklist.
  app.get("/:orgId/onboarding-status", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const configResult = await options.pool.query<{ config: unknown }>(
      "SELECT config FROM organizations WHERE id = $1",
      [orgId],
    );
    if (configResult.rows[0] === undefined) {
      return c.json({ error: "org_not_found" }, 404);
    }
    let config: OrgConfigV1;
    try {
      config = bindOrgGithubCredentialRefs(migrateOrgConfig(configResult.rows[0].config), orgId);
    } catch {
      return c.json({ error: "invalid_org_config" }, 409);
    }

    let github: GithubConnectionStatus;
    try {
      github = await resolveGithubConnection(options, minter, orgId);
    } catch (error) {
      if (error instanceof GithubCredentialRefMissingError) {
        return c.json({ error: "github_credential_ref_missing", message: error.message, ref: error.ref }, 409);
      }
      return c.json({ error: "github_capability_check_failed", message: messageOf(error) }, 502);
    }

    let aiProvider: AiProviderStatus;
    try {
      aiProvider = await resolveAiProviderStatus(config, options.secrets);
    } catch (error) {
      if (error instanceof ManagedProviderCredentialMissingError) {
        return c.json({ error: "managed_provider_credential_missing", message: error.message, ref: error.ref }, 409);
      }
      return c.json({ error: "ai_provider_check_failed", message: messageOf(error) }, 502);
    }
    return c.json(composeOnboardingStatus(config, github, aiProvider));
  });

  return app;
}

/**
 * The connected-GitHub view. `connected` reports only what it says: an identity
 * IS configured and GitHub confirms it. It stays true even when a run-fatal
 * permission is absent — flipping it to false would misstate the fault and
 * push the operator to re-connect the same identity, when what they must do is
 * grant a permission. `runReady` is the readiness signal, and it goes red the
 * moment a run-fatal permission is missing (loud, never a silent degrade).
 */
interface GithubConnectionStatus extends GithubCapability {
  connected: boolean;
  mode: "app" | "token" | null;
}

/**
 * Resolve the org's connected GitHub identity + its capabilities. Prefers the
 * App installation (the long-term model) over a static token, mirroring the
 * token resolver's precedence. The capability probe is a REAL call against the
 * resolved credential — never a guess.
 */
async function resolveGithubConnection(
  options: GithubConnectRoutesOptions,
  minter: GithubAppTokenMinter,
  orgId: string,
): Promise<GithubConnectionStatus> {
  const installation = await loadOrgGithubAppInstallation(options.pool, orgId);
  if (installation !== undefined) {
    const capability = await probeGithubAppCapability({
      secrets: options.secrets,
      installation,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    return { connected: true, mode: "app", ...capability };
  }
  const staticRef = await loadOrgDefaultGithubCredentialRef(options.pool, orgId);
  if (staticRef !== undefined) {
    const secret = await options.secrets.get(staticRef);
    if (secret === undefined) {
      // A PERSISTED `github_token` ref that points at NO secret is configuration
      // CORRUPTION (a broken tenant credential), NOT "no GitHub connected". Fail
      // LOUD so onboarding/status surfaces the broken state rather than quietly
      // reporting `connected:false` — which would hide it and let a run resolve a
      // dangling ref downstream. (Distinct from the genuinely-unconfigured case
      // below, which is a legitimate `connected:false`.)
      throw new GithubCredentialRefMissingError(staticRef);
    }
    const capability = await probeGithubTokenCapability({
      token: secret.value,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    return { connected: true, mode: "token", ...capability };
  }
  // No App installation AND no static ref configured: legitimately not connected.
  return { connected: false, mode: null, ...UNCONNECTED_GITHUB_CAPABILITY };
}

/**
 * Raised when a persisted GitHub credential ref resolves to NO secret in the
 * store. This is configuration corruption (a dangling tenant credential), NOT a
 * legitimately-unconfigured org — the routes surface it as a loud
 * `github_credential_ref_missing` (409), never a quiet `connected:false`. The
 * ref name is safe to carry (it is a non-secret store KEY, never the secret).
 */
export class GithubCredentialRefMissingError extends Error {
  constructor(public readonly ref: string) {
    super(
      `GitHub credential ref '${ref}' is persisted for this org but resolves to no secret in the store: ` +
        "this is broken tenant credential state (configuration corruption), not 'no GitHub connected'.",
    );
    this.name = "GithubCredentialRefMissingError";
  }
}

/**
 * App-install connect: verify the App can mint an installation token (and read
 * the App credential's id) BEFORE persisting, then write the `github_app` block
 * with a SERVER-STAMPED `installedAt` through the shared config path. The
 * supplied `appId` must match the credential's own id — a mismatch is a loud
 * 400, never a silently-wrong write.
 */
async function connectViaApp(
  c: Context<ActorContextEnv>,
  options: GithubConnectRoutesOptions,
  minter: GithubAppTokenMinter,
  events: EventStore,
  orgId: string,
  body: z.infer<typeof InstallConnectSchema>,
): Promise<Response> {
  const suppliedRef = body.credentialRef ?? options.appCredentialRef;
  if (suppliedRef === undefined || suppliedRef === "") {
    return c.json({ error: "github_app_credential_unconfigured" }, 400);
  }

  let credentialRef: string;
  try {
    credentialRef = canonicalOrgGithubCredentialRef({ orgId, supplied: suppliedRef, kind: "github_app" });
  } catch {
    return c.json({ error: "github_app_credential_not_owned" }, 400);
  }

  let appId: string;
  try {
    const credential = await loadGithubAppCredential(options.secrets, credentialRef);
    appId = credential.appId;
    if (appId !== body.appId) {
      return c.json({ error: "github_app_id_mismatch" }, 400);
    }
    await minter.refreshInstallationToken({ installationId: body.installationId, credentialRef });
  } catch (error) {
    return c.json({ error: "github_app_install_verification_failed", message: messageOf(error) }, 502);
  }

  const installation: OrgGithubAppInstallation = {
    installationId: body.installationId,
    appId,
    credentialRef,
    // SERVER-STAMPED: the operator must NOT supply a timestamp.
    installedAt: new Date().toISOString(),
  };
  const persisted = await persistOrgGithubAppInstallation(options.pool, orgId, installation);
  if (!persisted) {
    return c.json({ error: "org_not_found" }, 404);
  }
  await emitGithubConfiguredForOrgProjects(options, events, orgId, {
    mode: "app",
    credentialKind: "github_app",
    ref: credentialRef,
    redacted: true,
  });
  return c.json(
    {
      ok: true,
      mode: "app",
      installation: { installationId: installation.installationId, appId, installedAt: installation.installedAt },
    },
    201,
  );
}

/**
 * Token connect: validate + store the PAT as a `github_token` credential under
 * the org's namespace, then set it as the org's default GitHub credential. The
 * raw token never appears in the response (only the redacted ref) or a log.
 */
async function connectViaToken(
  c: Context<ActorContextEnv>,
  options: GithubConnectRoutesOptions,
  events: EventStore,
  actor: ActorContext,
  orgId: string,
  token: string,
): Promise<Response> {
  // Derive the canonical org-namespaced ref server-side (never a caller ref).
  const ref = deriveCredentialRef({ kind: "github_token", scope: "org", ownerId: orgId, name: "default" });
  try {
    await storeGithubToken(options.secrets, { ref, token });
  } catch (error) {
    return c.json({ error: "invalid_github_token", message: messageOf(error) }, 400);
  }
  const persisted = await persistOrgDefaultGithubCredentialRef(options.pool, orgId, ref);
  if (!persisted) {
    // Roll back the orphaned secret so a failed connect leaves no dangling key.
    await options.secrets.delete(ref).catch(() => {});
    return c.json({ error: "org_not_found" }, 404);
  }
  await emitGithubConfiguredForOrgProjects(options, events, orgId, {
    mode: "token",
    credentialKind: "github_token",
    ref,
    redacted: true,
  });
  return c.json({ ok: true, mode: "token", credentialRef: ref, redacted: true }, 201);
}

async function emitGithubConfiguredForOrgProjects(
  options: GithubConnectRoutesOptions,
  events: EventStore,
  orgId: string,
  payload: {
    mode: "app" | "token";
    credentialKind: "github_app" | "github_token";
    ref: string;
    redacted: true;
  },
): Promise<void> {
  const projects = await options.pool.query<{ project_id: string }>(
    "SELECT project_id FROM projects WHERE org_id = $1",
    [orgId],
  );
  await Promise.all(
    projects.rows.map((project) =>
      events.append({
        projectId: project.project_id,
        orgId,
        eventType: "credential.github.configured",
        payload,
      }),
    ),
  );
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
