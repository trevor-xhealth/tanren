// GitHub Issues source connector.
//
// Reads open issues for a repo through the SAME GitHub plumbing as the rest of
// The `resolveGithubToken` (App installation token, static
// fallback) + the injectable `GitHubHttpClient`. It maps each issue to a raw
// `IngestedItem` the engine persists as a candidate. Pull requests (which the
// Issues API also returns) are filtered out.
//
// Everything the connector needs to hit GitHub is injected, so tests drive it
// with a fake `GitHubHttpClient` (no network) — see candidateInbox.test.ts.

import type { SecretStore } from "../../contracts/secretStore.js";
import type { OrgGithubAppInstallation } from "../../config/orgConfig.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { resolveGithubToken } from "../../credentials/githubTokenResolver.js";
import { assertIntakeResponseOk, assertIssuesProviderIs, IntakeSourceFetchError } from "./connectorErrors.js";
import { ActiveGitHubIssuesConfig, type IngestedItem, type InboxSource, type SourceConnector } from "./types.js";

export interface GitHubConnectorDeps {
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  // Optional org App installation; when present the resolver mints an App token.
  installation?: OrgGithubAppInstallation;
  minter?: GithubAppTokenMinter;
  // The organization-bound static credential ref, resolved from the source's
  // org by the intake seam. Source JSON can never override this coordinate.
  defaultStaticRef?: string;
}

// A GitHub issue as the Issues API returns it (the fields we map). `pull_request`
// is present only on PRs, which we drop.
interface RawIssue {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  labels?: Array<{ name?: unknown } | string> | undefined;
  pull_request?: unknown;
}

function severityFromLabels(labels: ReadonlyArray<string>): IngestedItem["severity"] {
  const lowered = labels.map((l) => l.toLowerCase());
  if (lowered.some((l) => l.includes("bug") || l.includes("regression") || l.includes("critical"))) {
    return "fail";
  }
  if (lowered.some((l) => l.includes("warn") || l.includes("perf"))) {
    return "warn";
  }
  return "info";
}

function labelNames(issue: RawIssue): string[] {
  const raw = issue.labels ?? [];
  return raw
    .map((l) => (typeof l === "string" ? l : typeof l?.name === "string" ? l.name : ""))
    .filter((l): l is string => l.length > 0);
}

export function createGitHubIssuesConnector(deps: GitHubConnectorDeps): SourceConnector {
  return {
    kind: "issues",
    async fetch(source: InboxSource): Promise<IngestedItem[]> {
      // An unsupported or non-GitHub `issues` config must fail at the authority
      // boundary, before config parsing can look like a generic GitHub failure
      // and before any credential/provider I/O occurs.
      assertIssuesProviderIs("github", source.config);
      const config = ActiveGitHubIssuesConfig.parse(source.config);
      // Credential authority is bound to the source organization: an App
      // installation or the org-default ref selected by the intake seam. The
      // source config has no credential coordinate and cannot become a deputy.
      const resolved = await resolveGithubToken({
        secrets: deps.secrets,
        orgId: source.orgId,
        ...(deps.installation === undefined ? {} : { installation: deps.installation }),
        ...(deps.defaultStaticRef === undefined ? {} : { staticRef: deps.defaultStaticRef }),
        minter: deps.minter ?? new GithubAppTokenMinter({ secrets: deps.secrets }),
      });

      const labelQuery = config.labels.length > 0 ? `&labels=${encodeURIComponent(config.labels.join(","))}` : "";
      const path =
        `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}` +
        `/issues?state=open&per_page=50${labelQuery}`;

      const response = await deps.githubHttp.request({
        method: "GET",
        path,
        token: resolved.token,
        refreshToken: resolved.refresh,
        // The durable intake scheduler owns rate-limit delays. Surface the raw
        // classified response so this source never sleeps ahead of its peers.
        retryRateLimit: false,
      });
      // No-silent-fallbacks: a non-200 is a LOUD throw (a 401/403 ⇒ auth error
      // the poller re-throws; any other non-200 ⇒ a transient fetch error), NEVER
      // an empty list masking a failed fetch. Only a genuine 200-with-an-array is
      // an empty result. A 200 whose body is not the expected array is itself a
      // failed read (the API shape changed / an error envelope) — also LOUD.
      assertIntakeResponseOk("github", response.status, response.errorDetail ?? "", response.retryAfterMs);
      if (!Array.isArray(response.body)) {
        throw new IntakeSourceFetchError("github", response.status, "200 body was not an issues array");
      }

      const issues = response.body as RawIssue[];
      const items: IngestedItem[] = [];
      for (const issue of issues) {
        // The Issues API also returns PRs; drop them.
        if (issue.pull_request !== undefined) continue;
        if (typeof issue.number !== "number" || typeof issue.title !== "string") continue;
        const labels = labelNames(issue);
        items.push({
          externalId: `gh-${config.owner}/${config.repo}#${issue.number}`,
          title: issue.title,
          body: typeof issue.body === "string" ? issue.body.slice(0, 8000) : "",
          severity: severityFromLabels(labels),
          projectId: source.projectId,
        });
      }
      return items;
    },
  };
}
