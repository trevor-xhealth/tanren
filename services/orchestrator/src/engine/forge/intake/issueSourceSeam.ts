// The intake poller's `IssueSource` seam impl (engineSeams.ts) — the purpose-based
// seam through which intake reads issues, with the GitHub credential resolved the
// SAME way the rest of the engine resolves it: an App installation token when the
// org has installed the App, ELSE the org's default static GitHub token. This
// replaces the prior App-token-ONLY minting in `bootIntake.ts`, which silently
// produced NO intake connector when the App was absent (the binding
// no-silent-fallbacks doctrine: a required-but-missing credential is a LOUD
// fail-closed error, never a quiet degrade to no poller).
//
// Distinction the seam enforces:
//   • intake NOT configured for a project/org → no GitHub `issues` source listed →
//     no poller runs over it (the legitimate "no intake" case — no error).
//   • intake CONFIGURED (a github `issues` source exists) BUT the credential
//     cannot be resolved (App not installed AND no org-default static token) → a
//     LOUD fail-closed error naming the missing credential, never a silent skip.
//
// Sentry error sources resolve an exact integration grant, so they do not depend
// on the org's GitHub credential; only a GitHub `issues` source needs this path.

import type pg from "pg";
import { z } from "zod";
import type { SecretStore } from "../../contracts/secretStore.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { loadOrgDefaultGithubCredentialRef, loadOrgGithubAppInstallation } from "../../credentials/orgGithubApp.js";
import {
  MissingGithubCredentialRefError,
  NoGithubCredentialConfiguredError,
} from "../../credentials/githubTokenResolver.js";
import { CredentialRefOwnershipError } from "../../credentials/refNamespace.js";
import {
  IntakeSourceAuthError,
  IntakeSourceAuthorityError,
  IntakeSourceResourceError,
  UnsupportedInboxProviderError,
} from "../inbox/connectorErrors.js";
import {
  ActiveGitHubIssuesConfig,
  buildInboxConnectorMap,
  buildPgLinearIntakeAuthority,
  buildPgSentryIntakeAuthority,
  resolveIssuesProvider,
  type LinearHttpClient,
  type SentryHttpClient,
  type InboxSource,
  type SourceConnector,
} from "../inbox/index.js";

/**
 * Thrown when a project/org HAS a GitHub `issues` intake source configured but no
 * GitHub credential can be resolved for that org: the App is not installed AND the
 * org has set no default static GitHub token. Per the no-silent-fallbacks
 * doctrine this is a LOUD fail-closed configuration error (the operator must
 * install the App or set the org-default `github_token`), NOT a silent no-poller.
 */
export class IntakeGithubCredentialMissingError extends Error {
  readonly retriable = false as const;
  readonly orgId: string;
  readonly sourceId: string;

  constructor(orgId: string, sourceId: string) {
    super(
      `intake source ${sourceId} (org ${orgId}) is a configured GitHub issues source but no GitHub credential ` +
        `resolves for the org: no App installation and no org-default github_token ` +
        `(organizations.config.defaultCredentials.github_token). ` +
        `Install the GitHub App or set the org-default github_token.`,
    );
    this.name = "IntakeGithubCredentialMissingError";
    this.orgId = orgId;
    this.sourceId = sourceId;
  }
}

/**
 * Classify a typed permanent source failure into the sanitized state persisted
 * by the poller. Raw exception messages are deliberately not retained: they may
 * contain a tenant credential coordinate.
 *   • the EAGER org-default path — {@link IntakeGithubCredentialMissingError}
 *     (no App installed AND no org-default static token), AND
 *   • resolver errors for the organization-bound credential, AND
 *   • the LIVE auth-rejected path — a connector's HTTP fetch comes back 401/403
 *     ({@link IntakeSourceAuthError}): the token resolved but the source denied it
 *     (expired/revoked/insufficient scope). Same class of misconfiguration — a
 *     LOUD fail-closed re-throw, not a swallowed "this source never ingests", AND
 *   • a deleted provider/raw-token shape ({@link UnsupportedInboxProviderError}):
 *     the source cannot become valid through retry and must be recreated against
 *     the supported GitHub provider rather than quietly retried forever.
 *
 * Genuinely transient errors (network, 5xx, rate-limit) return undefined.
 */
export interface PermanentInboxSourceFailure {
  code:
    | "unsupported_provider"
    | "invalid_config"
    | "credential_unavailable"
    | "authority_unavailable"
    | "resource_unavailable";
  message: string;
}

export function classifyPermanentInboxSourceError(error: unknown): PermanentInboxSourceFailure | undefined {
  if (error instanceof UnsupportedInboxProviderError) {
    return {
      code: "unsupported_provider",
      message: "This source uses an unsupported provider or caller-owned credential reference. Recreate it.",
    };
  }
  if (error instanceof z.ZodError) {
    return {
      code: "invalid_config",
      message: "This source configuration is invalid. Recreate it with required fields.",
    };
  }
  if (
    error instanceof IntakeGithubCredentialMissingError ||
    error instanceof NoGithubCredentialConfiguredError ||
    error instanceof MissingGithubCredentialRefError ||
    error instanceof CredentialRefOwnershipError ||
    error instanceof IntakeSourceAuthError
  ) {
    return {
      code: "credential_unavailable",
      message: "The organization-bound credential is missing, expired, or denied. Repair it in integration settings.",
    };
  }
  if (error instanceof IntakeSourceAuthorityError) {
    return {
      code: "authority_unavailable",
      message: "The selected integration grant is unavailable. Repair the project selection or grant.",
    };
  }
  if (error instanceof IntakeSourceResourceError) {
    return {
      code: "resource_unavailable",
      message: "The configured provider resource is missing or rejected. Repair the source coordinates.",
    };
  }
  return undefined;
}

export interface BuildIntakeConnectorMapDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  // The shared App-token minter (installation-token cache). Threaded into the
  // GitHub issues connector for the App-installation path; absent is FINE for an
  // org on the static-token path (it does not silently disable intake).
  githubAppMinter?: GithubAppTokenMinter;
  sentryHttp?: SentryHttpClient;
  linearHttp?: LinearHttpClient;
}

/**
 * Whether a source is a GitHub-provider `issues` source — the only source whose
 * polling depends on the org's GitHub credential. A GitHub source carries kind
 * `issues` with the one canonical GitHub config and no `provider` discriminator.
 * A LINEAR `issues` source resolves its own exact integration grant, so it must
 * NOT drag the org's GitHub credential into scope — an org that polls Linear and
 * has never installed the GitHub App is a legitimate configuration, not a
 * missing-credential failure. Invalid/deleted-provider rows likewise do not
 * trigger credential resolution; the connector classifies them before I/O.
 */
function isGithubIssuesSourceNeedingOrgCredential(source: InboxSource): boolean {
  if (source.kind !== "issues") return false;
  try {
    if (resolveIssuesProvider(source.config) !== "github") return false;
  } catch {
    return false;
  }
  return ActiveGitHubIssuesConfig.safeParse(source.config).success;
}

/**
 * Build the intake connector map for ONE org, resolving the GitHub credential the
 * SAME way the rest of the engine does — App installation token when installed,
 * ELSE the org's default static GitHub token (threaded into the connector as its
 * `staticRef`). The resolution is EXPLICIT and fail-closed:
 *   • `githubSource` names the org's configured GitHub `issues` source (when one
 *     exists) so a missing credential raises {@link IntakeGithubCredentialMissingError}
 *     against that source — a LOUD failure, never a silent no-connector.
 *   • when NO valid GitHub source needs the org credential (only Sentry, an
 *     invalid source awaiting a terminal state transition, or no intake configured), the map is
 *     built without an org-default github ref — the legitimate "no GitHub intake"
 *     case, no error.
 */
export async function buildIntakeConnectorMapForOrg(
  deps: BuildIntakeConnectorMapDeps,
  orgId: string,
  sources: ReadonlyArray<InboxSource>,
): Promise<ReadonlyMap<string, SourceConnector>> {
  const githubSource = sources.find((source) => isGithubIssuesSourceNeedingOrgCredential(source));
  // Resolve GitHub authority only for a fully-valid GitHub source. A poisoned
  // row must hit the connector's config boundary before any credential lookup;
  // malformed source JSON cannot select or trigger authority work.
  const installation = githubSource === undefined ? undefined : await loadOrgGithubAppInstallation(deps.pool, orgId);
  const staticRef =
    githubSource !== undefined && installation === undefined
      ? await loadOrgDefaultGithubCredentialRef(deps.pool, orgId)
      : undefined;

  // Configured-but-missing → LOUD fail-closed. A GitHub issues source exists for
  // this org, yet neither an App installation nor an org-default static token
  // resolves: the poller would otherwise mint no connector and the source would
  // silently never ingest. Name the missing credential and throw.
  if (githubSource !== undefined && installation === undefined && (staticRef === undefined || staticRef === "")) {
    throw new IntakeGithubCredentialMissingError(orgId, githubSource.id);
  }

  return buildInboxConnectorMap({
    secrets: deps.secrets,
    githubHttp: deps.githubHttp,
    sentryAuthority: buildPgSentryIntakeAuthority(deps.pool),
    linearAuthority: buildPgLinearIntakeAuthority(deps.pool),
    ...(deps.sentryHttp === undefined ? {} : { sentryHttp: deps.sentryHttp }),
    ...(deps.linearHttp === undefined ? {} : { linearHttp: deps.linearHttp }),
    ...(installation === undefined ? {} : { installation }),
    ...(staticRef === undefined ? {} : { defaultGithubStaticRef: staticRef }),
    ...(deps.githubAppMinter === undefined ? {} : { minter: deps.githubAppMinter }),
  });
}
