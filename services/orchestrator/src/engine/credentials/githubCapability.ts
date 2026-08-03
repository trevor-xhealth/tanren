// Connect-GitHub capability probe (Wave-2 operator API). Answers, against the
// org's REAL resolved GitHub credential, the question an operator needs BEFORE a
// run: "does this identity hold the permissions Tanren actually depends on?" —
// so a permission gap is learned at onboarding instead of as a late 403.
//
// WHY THIS IS NOT JUST `administration:write` (the false-green defect): the probe
// once checked ONLY repo-creation authority. An installation granted exactly
// `contents:write, metadata:read, pull_requests:write` therefore reported
// `connected:true` with a single OPTIONAL gap — while every run died at gate
// publish, because `POST /repos/{o}/{r}/statuses/{sha}` 403s without
// `statuses:write` and `githubPublishCheck.ts` throws on any non-201. The gate
// verdict is the merge authority, so nothing lands without it. Repo creation, by
// contrast, is optional (greenfield only). A flat "missing permissions" list
// cannot express that difference, and flattening it is what produced the false
// green — hence {@link GithubPermissionGap.severity}.
//
// This is a REAL check against the credential, never a guess — and a NON-MUTATING
// one. We do not write a probe status into an operator's repository to discover
// whether we may: GitHub reports an installation's granted permission set
// directly, and that set is precisely what the API enforces (a 403 "Resource not
// accessible by integration" IS the declared-scope check), so a declarative
// comparison against {@link GITHUB_PERMISSION_REQUIREMENTS} is both sufficient
// and strictly less intrusive than an empirical write.
//   - App installation → sign the App JWT (the SAME signer the minter uses) and
//     read `GET /app/installations/{id}` → its `permissions` map + `account.login`.
//   - Static token (PAT) → `GET /user` and read the `X-OAuth-Scopes` RESPONSE
//     header (the authoritative list of scopes the token actually carries) plus
//     the `login`. The secret is sent only in the Authorization header and is
//     never logged or returned.
//
// The probe is HTTP-injectable (`fetchImpl`) so route tests exercise the real
// header/permission parsing without a live GitHub.

import { loadGithubAppCredential } from "./githubApp.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import { signAppJwt } from "../providers/githubAppTokenMinter.js";

/**
 * How badly a permission Tanren needs, but does not hold, hurts.
 *   - `run_fatal`      — every run fails without it. There is no degraded mode.
 *   - `feature_blocking` — one optional capability is unavailable; runs that do
 *     not use that capability are unaffected.
 */
export type GithubPermissionSeverity = "run_fatal" | "feature_blocking";

/** One permission Tanren needs that the connected identity does NOT hold. */
export interface GithubPermissionGap {
  /** The permission (App) or scope (PAT) at the level needed, e.g. `statuses:write`. */
  permission: string;
  severity: GithubPermissionSeverity;
  /** What stops working without it, in operator language. */
  blocks: string;
}

/** The capability view the GET route renders (never carries a secret). */
export interface GithubCapability {
  /** The connected GitHub identity's login (the App account / the PAT user). */
  login: string | null;
  /**
   * False when ANY `run_fatal` permission is missing: the credential is
   * connected but no run can complete. This — not `connected` — is the signal an
   * operator must read as "GitHub is ready".
   */
  runReady: boolean;
  /**
   * True only when the identity can publish the Tanren gate verdict as a commit
   * status. Its absence is the run-killing gap the flat probe used to hide.
   */
  canPublishGateStatus: boolean;
  /** True only when a REAL check confirms repo-creation authority (greenfield). */
  canCreateRepos: boolean;
  /** Every permission Tanren needs that is NOT granted, with its severity. */
  permissionGaps: GithubPermissionGap[];
  /** Flat projection of the `run_fatal` gaps — the ones that stop every run. */
  blockingPermissions: string[];
  /** Flat projection of ALL gaps (run-fatal first), for terse rendering. */
  missingPermissions: string[];
}

export interface GithubAppCapabilityInput {
  secrets: SecretStore;
  installation: OrgGithubAppInstallation;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  /** Injectable clock (ms epoch) so the App JWT `iat`/`exp` are deterministic. */
  now?: () => number;
}

export interface GithubTokenCapabilityInput {
  token: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}

/** The classic OAuth scope that covers every repository operation Tanren performs. */
const REPO_SCOPE = "repo";

/** GitHub App permission levels, ranked: a `write` grant satisfies a `read` need. */
const PERMISSION_LEVEL_RANK: Record<string, number> = { read: 1, write: 2 };

interface GithubPermissionRequirement {
  /** The permission key exactly as `GET /app/installations/{id}` reports it. */
  key: string;
  /** The MINIMUM level Tanren needs. */
  level: "read" | "write";
  severity: GithubPermissionSeverity;
  blocks: string;
}

/**
 * The permissions Tanren's GitHub integration actually depends on, each tied to
 * the code path that needs it. This table is the probe's contract — extend it
 * when a new GitHub call is added, so onboarding keeps telling the whole truth.
 *
 * Ordered run-fatal first so the flat projections read worst-first.
 */
export const GITHUB_PERMISSION_REQUIREMENTS: readonly GithubPermissionRequirement[] = [
  {
    key: "statuses",
    level: "write",
    severity: "run_fatal",
    blocks:
      "publishing the Tanren gate verdict as a commit status " +
      "(POST /repos/{owner}/{repo}/statuses/{sha}) — the merge authority for every run",
  },
  {
    key: "contents",
    level: "write",
    severity: "run_fatal",
    blocks: "pushing a run's branch and writing repository configuration",
  },
  {
    key: "pull_requests",
    level: "write",
    severity: "run_fatal",
    blocks: "opening, updating, reviewing and merging the change request a run produces",
  },
  {
    key: "metadata",
    level: "read",
    severity: "run_fatal",
    blocks: "reading repository metadata, which every other GitHub call depends on",
  },
  {
    key: "administration",
    level: "write",
    severity: "feature_blocking",
    blocks: "creating a repository for a greenfield project (optional — brownfield projects never need it)",
  },
  {
    key: "issues",
    level: "write",
    severity: "feature_blocking",
    blocks: "issue-sourced intake: reading tracked issues and syncing comments and state back to them",
  },
  {
    key: "repository_hooks",
    level: "write",
    severity: "feature_blocking",
    blocks: "provisioning the repository webhook an issue source needs to receive events",
  },
];

/**
 * The single classic-PAT scope requirement. Classic scopes are coarse: `repo`
 * grants EVERY repository operation Tanren performs (commit statuses, contents,
 * pull requests, issues, hooks) and repository creation. So for a PAT there is
 * one requirement, and it is run-fatal — a token without it cannot publish the
 * gate verdict, not merely fail to create repos.
 */
const REPO_SCOPE_REQUIREMENT: GithubPermissionGap = {
  permission: REPO_SCOPE,
  severity: "run_fatal",
  blocks:
    "every repository operation Tanren performs — publishing the gate commit status " +
    "(the merge authority for every run), pushing branches, driving pull requests, and creating repositories. " +
    "A fine-grained token exposes no classic scope header, so its authority cannot be confirmed here: " +
    "connect a classic token with the 'repo' scope, or a GitHub App installation",
};

/** The capability reported for an org with no GitHub identity configured at all. */
export const UNCONNECTED_GITHUB_CAPABILITY: GithubCapability = {
  login: null,
  runReady: false,
  canPublishGateStatus: false,
  canCreateRepos: false,
  permissionGaps: [],
  blockingPermissions: [],
  missingPermissions: [],
};

/**
 * The operator-facing sentence for one gap. Severity picks the wording: a
 * run-fatal gap is stated as blocking EVERY run (it belongs in the readiness
 * checklist's next steps), a feature-blocking gap as an optional capability.
 */
export function describeGithubPermissionGap(gap: GithubPermissionGap): string {
  return gap.severity === "run_fatal"
    ? `Grant ${gap.permission} to the connected GitHub identity: without it EVERY run fails — it blocks ${gap.blocks}.`
    : `Grant ${gap.permission} to enable ${gap.blocks}.`;
}

function normalizeBaseUrl(apiBaseUrl: string | undefined): string {
  return (apiBaseUrl ?? "https://api.github.com").replace(/\/$/u, "");
}

/**
 * Is a required permission satisfied by the installation's granted level? GitHub
 * reports each granted permission as `"read"` or `"write"`; a higher grant
 * satisfies a lower need. An absent key means the permission is not held.
 */
function grantSatisfies(granted: unknown, required: "read" | "write"): boolean {
  if (typeof granted !== "string") return false;
  return (PERMISSION_LEVEL_RANK[granted] ?? 0) >= PERMISSION_LEVEL_RANK[required]!;
}

/**
 * Compose the capability view from the gaps found. Keeping this one function is
 * what guarantees `runReady` and `canPublishGateStatus` cannot drift out of sync
 * with `permissionGaps` — the false-green class of bug being fixed here.
 */
function composeCapability(login: string | null, gaps: GithubPermissionGap[]): GithubCapability {
  const missing = new Set(gaps.map((gap) => gap.permission));
  return {
    login,
    runReady: !gaps.some((gap) => gap.severity === "run_fatal"),
    canPublishGateStatus: !missing.has("statuses:write") && !missing.has(REPO_SCOPE),
    canCreateRepos: !missing.has("administration:write") && !missing.has(REPO_SCOPE),
    permissionGaps: gaps,
    blockingPermissions: gaps.filter((gap) => gap.severity === "run_fatal").map((gap) => gap.permission),
    missingPermissions: gaps.map((gap) => gap.permission),
  };
}

/**
 * Compare an installation's granted permission map against
 * {@link GITHUB_PERMISSION_REQUIREMENTS}. Exported so the requirement table can
 * be exercised directly, and so any future caller classifies gaps identically.
 */
export function classifyInstallationPermissions(granted: Record<string, unknown> | undefined): GithubPermissionGap[] {
  return GITHUB_PERMISSION_REQUIREMENTS.filter(
    (requirement) => !grantSatisfies(granted?.[requirement.key], requirement.level),
  ).map((requirement) => ({
    permission: `${requirement.key}:${requirement.level}`,
    severity: requirement.severity,
    blocks: requirement.blocks,
  }));
}

/**
 * Probe an org's GitHub App installation. Signs the App JWT and reads the
 * installation's GRANTED permission set + account login, then compares it against
 * the permissions Tanren depends on — no write is performed against the operator's
 * repositories. A non-2xx from GitHub is a LOUD failure (the caller maps it to a
 * 502) rather than a silent "cannot" — we never guess the capability.
 */
export async function probeGithubAppCapability(input: GithubAppCapabilityInput): Promise<GithubCapability> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(input.apiBaseUrl);
  const nowSeconds = Math.floor((input.now ?? Date.now)() / 1000);
  const credential = await loadGithubAppCredential(input.secrets, input.installation.credentialRef);
  const jwt = signAppJwt(credential.appId, credential.privateKeyPem, nowSeconds);

  const response = await fetchImpl(
    `${baseUrl}/app/installations/${encodeURIComponent(input.installation.installationId)}`,
    {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub App installation read failed: HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => {})) as
    | { account?: { login?: unknown }; permissions?: Record<string, unknown> }
    | undefined;
  const login = typeof body?.account?.login === "string" ? body.account.login : null;
  return composeCapability(login, classifyInstallationPermissions(body?.permissions));
}

/**
 * Probe a static GitHub token (PAT). Reads the authoritative `X-OAuth-Scopes`
 * response header from `GET /user` — the actual scopes the token carries — plus
 * the authenticated `login`. The token travels only in the Authorization header.
 * A non-2xx is a LOUD failure.
 *
 * (MERGE-SAFETY's `resolveActorIdentity` reads the SAME `GET /user` login + id,
 * but through the shared GitHub HTTP client (`githubCodeHost.ts`) — so the
 * observability wrapper + 401-refresh apply; it does not reuse this `fetch` path.)
 */
export async function probeGithubTokenCapability(input: GithubTokenCapabilityInput): Promise<GithubCapability> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(input.apiBaseUrl);
  const response = await fetchImpl(`${baseUrl}/user`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub token identity read failed: HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => {})) as { login?: unknown } | undefined;
  const login = typeof body?.login === "string" ? body.login : null;
  const scopes = parseOAuthScopes(response.headers.get("x-oauth-scopes"));
  return composeCapability(login, scopes.includes(REPO_SCOPE) ? [] : [REPO_SCOPE_REQUIREMENT]);
}

/**
 * Parse the comma-separated `X-OAuth-Scopes` header into a scope list. A
 * fine-grained PAT (or an empty/absent header) yields `[]` — the token's
 * authority is then reported as NOT confirmed, LOUDLY (run-fatal), rather than
 * assumed sufficient. Assuming sufficiency is exactly the false green this probe
 * exists to prevent; the gap's `blocks` text tells the operator what to do.
 */
export function parseOAuthScopes(header: string | null): string[] {
  if (header === null) return [];
  return header
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
}
