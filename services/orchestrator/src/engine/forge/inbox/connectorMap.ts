// The default inbox connector map (GitHub/Linear issues + Sentry errors),
// extracted so BOTH the inbox HTTP route (manual ingest) and the P1d intake
// poller construct the SAME set of source connectors from one builder — the
// poll path and the click path read sources identically.

import type { SecretStore } from "../../contracts/secretStore.js";
import type { OrgGithubAppInstallation } from "../../config/orgConfig.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { createCiInsightsConnector } from "./ciInsightsConnector.js";
import { createGitHubIssuesConnector } from "./githubConnector.js";
import { createIssuesDispatcher } from "./issuesDispatcher.js";
import {
  createLinearConnector,
  FetchLinearHttpClient,
  type LinearHttpClient,
  type LinearIntakeAuthority,
} from "./linearConnector.js";
import {
  createSentryConnector,
  FetchSentryHttpClient,
  type SentryHttpClient,
  type SentryIntakeAuthority,
} from "./sentryConnector.js";
import type { SourceConnector } from "./types.js";
import { IntakeSourceAuthorityError } from "./connectorErrors.js";

export interface BuildConnectorMapDeps {
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  sentryHttp?: SentryHttpClient;
  sentryAuthority?: SentryIntakeAuthority;
  linearHttp?: LinearHttpClient;
  linearAuthority?: LinearIntakeAuthority;
  // Intake credential resolution (no-silent-fallbacks fix): the org's GitHub App
  // installation + the shared minter, threaded into the GitHub issues connector so
  // the connector mints an INSTALLATION token. The intake poller builds this map
  // PER-ORG with EXPLICIT resolution — App installation when installed, ELSE the
  // org's default static token (`defaultGithubStaticRef`) — exactly how the rest of
  // the engine resolves a GitHub credential. Source JSON never selects a ref.
  installation?: OrgGithubAppInstallation;
  minter?: GithubAppTokenMinter;
  // The org-default static GitHub credential ref, used by the GitHub issues
  // connector when no App is installed.
  defaultGithubStaticRef?: string;
}

/** Build the default `{ issues, errors }` connector map from the shared transports. */
export function buildInboxConnectorMap(deps: BuildConnectorMapDeps): Map<string, SourceConnector> {
  const sentryAuthority: SentryIntakeAuthority =
    deps.sentryAuthority ??
    (() => Promise.reject(new IntakeSourceAuthorityError("sentry", "authority is not configured")));
  // An unconfigured authority is a LOUD refusal, never a connector that quietly
  // reads nothing — the same fail-closed default Sentry takes.
  const linearAuthority: LinearIntakeAuthority =
    deps.linearAuthority ??
    (() => Promise.reject(new IntakeSourceAuthorityError("linear", "authority is not configured")));
  return new Map<string, SourceConnector>([
    [
      // One kind, two providers: the dispatcher resolves `config.provider`.
      "issues",
      createIssuesDispatcher({
        github: createGitHubIssuesConnector({
          secrets: deps.secrets,
          githubHttp: deps.githubHttp,
          ...(deps.installation === undefined ? {} : { installation: deps.installation }),
          ...(deps.minter === undefined ? {} : { minter: deps.minter }),
          ...(deps.defaultGithubStaticRef === undefined ? {} : { defaultStaticRef: deps.defaultGithubStaticRef }),
        }),
        linear: createLinearConnector({
          secrets: deps.secrets,
          linearHttp: deps.linearHttp ?? new FetchLinearHttpClient(),
          authority: linearAuthority,
        }),
      }),
    ],
    [
      "errors",
      createSentryConnector({
        secrets: deps.secrets,
        sentryHttp: deps.sentryHttp ?? new FetchSentryHttpClient(),
        authority: sentryAuthority,
      }),
    ],
    // CI-intelligence PR3: the CI-insights source (a `system` source). It pulls
    // nothing — the worker's CiInsightsLoop emits its candidates — so the connector
    // is a registered no-op (a stray ingest over it is safe), keeping the kind a
    // recognized member of the map.
    ["system", createCiInsightsConnector()],
  ]);
}
