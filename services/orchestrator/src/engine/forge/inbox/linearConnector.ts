// Linear source connector.
//
// Reads OPEN Linear issues for one team through the Linear GraphQL API
// (`POST https://api.linear.app/graphql`) and maps each to a raw `IngestedItem`
// the engine persists as a candidate. Linear is an issue tracker, so it is wired
// under the EXISTING `issues` source kind — `inbox_sources.kind` is CHECK-
// constrained, so a new kind would need a migration and none is taken here. The
// `issues` dispatcher in connectorMap.ts routes to this connector when the
// source config carries `provider: "linear"`.
//
// Each fetch obtains exact `intake` authority from the persisted project
// selection, resolves that lease's generation-addressed secret, and only then
// calls the injectable HTTP transport — identical in structure to the Sentry
// connector. Reusable credential coordinates never enter source config.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { OrgGrant } from "../../contracts/integrationProvisioner.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import { PgIntegrationAuthority } from "../../integrations/integrationAuthorityImpl.js";
import { GenerationAddressedIntegrationSecretStore } from "../../integrations/integrationSecretStoreImpl.js";
import { IntegrationConnectionsStore } from "../../repositories/integrationConnections.js";
import { assertOrgGrantMatchesLease, secretValueForLease } from "../../repositories/integrationConnectionResolve.js";
import { systemActor } from "../../state/actor.js";
import {
  assertIntakeResponseOk,
  assertIssuesProviderIs,
  IntakeSourceAuthorityError,
  IntakeSourceFetchError,
} from "./connectorErrors.js";
import { ActiveLinearIssuesConfig, type IngestedItem, type InboxSource, type SourceConnector } from "./types.js";

export const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

// The injectable Linear transport. A GraphQL request carries the resolved auth
// token, the query, and its variables. Mirrors the Sentry/GitHub client shape so
// the same test pattern (a fake returning `{ status, body }`) applies.
export interface LinearHttpRequest {
  endpoint: string;
  token: string;
  query: string;
  variables: Record<string, unknown>;
}

export interface LinearHttpResponse {
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string | undefined>>;
}

export interface LinearHttpClient {
  request(input: LinearHttpRequest): Promise<LinearHttpResponse>;
}

// The production transport: a thin fetch wrapper. Linear API keys are sent raw in
// `Authorization`; OAuth access tokens carry their own `Bearer` prefix, so the
// resolved credential is forwarded verbatim either way.
export class FetchLinearHttpClient implements LinearHttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async request(input: LinearHttpRequest): Promise<LinearHttpResponse> {
    const response = await this.fetchImpl(input.endpoint, {
      method: "POST",
      headers: {
        Authorization: input.token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: input.query, variables: input.variables }),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = text;
    }
    return {
      status: response.status,
      body,
      headers: { "retry-after": response.headers.get("retry-after") ?? undefined },
    };
  }
}

function retryAfterMs(value: string | undefined, now = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const deadline = Date.parse(value);
  return Number.isNaN(deadline) ? undefined : Math.max(0, deadline - now);
}

export interface LinearConnectorDeps {
  secrets: SecretStore;
  linearHttp: LinearHttpClient;
  authority: LinearIntakeAuthority;
}

export type LinearIntakeAuthority = (input: {
  orgId: string;
  projectId: string;
  resourceId: string;
}) => Promise<OrgGrant>;

/** Build the production intake authority over the current project selection. */
export function buildPgLinearIntakeAuthority(pool: pg.Pool): LinearIntakeAuthority {
  return async (input) =>
    runWithSystemScope(pool, async (client) => {
      const result = await new PgIntegrationAuthority().authorizeOperation(client, {
        orgId: input.orgId,
        projectId: input.projectId,
        providerKind: "linear",
        capability: "issues",
        operation: "intake",
        target: { resourceId: input.resourceId },
        actor: systemActor,
      });
      if (result.status !== "eligible") {
        const reason =
          result.status === "ineligible"
            ? result.reasons.join(",")
            : result.status === "selection_required"
              ? result.reason
              : "not_linked";
        throw new IntakeSourceAuthorityError("linear", reason);
      }
      return IntegrationConnectionsStore.orgGrantFromLease(result.lease);
    });
}

// The GraphQL read. Open issues are those whose workflow state TYPE is neither
// `completed` nor `canceled` — Linear lets a workspace freely rename its states,
// so filtering on the state type rather than a state name is the only portable
// form. `first: 50` is one page of one request (the same shape as GitHub's
// `per_page=50`), not a retry or attempt bound.
const ISSUES_QUERY = `query TanrenLinearIntake($filter: IssueFilter!) {
  issues(filter: $filter, first: 50, orderBy: updatedAt) {
    nodes {
      id
      identifier
      title
      description
      url
      priority
      labels { nodes { name } }
    }
  }
}`;

interface RawLinearLabel {
  name?: unknown;
}

interface RawLinearIssue {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  priority?: unknown;
  labels?: { nodes?: RawLinearLabel[] } | undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function labelNames(issue: RawLinearIssue): string[] {
  return (issue.labels?.nodes ?? [])
    .map((label) => asString(label.name))
    .filter((name): name is string => name !== undefined);
}

// Map a Linear issue to inbox severity. A bug-shaped label wins outright (it is
// the strongest statement the tracker makes about an issue), then Linear's
// priority scale — 1 Urgent, 2 High, 3 Medium, 4 Low, 0 No priority. This mirrors
// the GitHub connector's label heuristic so candidates from either tracker sort
// the same way in the inbox.
function severityFor(issue: RawLinearIssue): IngestedItem["severity"] {
  const labels = labelNames(issue).map((label) => label.toLowerCase());
  if (labels.some((label) => label.includes("bug") || label.includes("regression") || label.includes("critical"))) {
    return "fail";
  }
  const priority = typeof issue.priority === "number" ? issue.priority : 0;
  if (priority === 1) return "fail";
  if (priority === 2) return "warn";
  if (labels.some((label) => label.includes("warn") || label.includes("perf"))) return "warn";
  return "info";
}

// The candidate body is the description plus the Linear deep link, so triage and
// the surface have the issue context without a second round trip.
function bodyFor(issue: RawLinearIssue): string {
  const lines: string[] = [];
  const description = asString(issue.description);
  if (description !== undefined) lines.push(description);
  const url = asString(issue.url);
  if (url !== undefined) lines.push(url);
  return lines.join("\n\n").slice(0, 8000);
}

function buildFilter(config: ActiveLinearIssuesConfig): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    state: { type: { nin: ["completed", "canceled"] } },
    team: { key: { eq: config.teamKey } },
  };
  if (config.labels.length > 0) {
    filter["labels"] = { some: { name: { in: config.labels } } };
  }
  return filter;
}

interface LinearIssuesEnvelope {
  data?: { issues?: { nodes?: unknown } };
  errors?: unknown;
}

// GraphQL reports application errors — a revoked token, an unknown field, a team
// the credential cannot see — as HTTP 200 with an `errors` array. Treating that
// as "no open issues" is precisely the silent degrade the intake doctrine
// forbids, so the envelope gets its own loud path.
function issueNodesOrThrow(status: number, body: unknown): RawLinearIssue[] {
  const envelope = (typeof body === "object" && body !== null ? body : {}) as LinearIssuesEnvelope;
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
    throw new IntakeSourceFetchError("linear", status, "200 body carried GraphQL errors");
  }
  const nodes = envelope.data?.issues?.nodes;
  if (!Array.isArray(nodes)) {
    throw new IntakeSourceFetchError("linear", status, "200 body had no data.issues.nodes array");
  }
  return nodes as RawLinearIssue[];
}

export function createLinearConnector(deps: LinearConnectorDeps): SourceConnector {
  return {
    // Wired under the existing `issues` slot; the dispatcher routes to this
    // connector when `config.provider === "linear"`.
    kind: "issues",
    async fetch(source: InboxSource): Promise<IngestedItem[]> {
      // Defence in depth: refuse a config this connector does not own before any
      // credential or provider I/O, exactly as the GitHub connector does.
      assertIssuesProviderIs("linear", source.config);
      const config = ActiveLinearIssuesConfig.parse(source.config);
      if (source.projectId === null) throw new Error("linear connector: intake source must name a project");
      const grant = await deps.authority({
        orgId: source.orgId,
        projectId: source.projectId,
        resourceId: config.teamKey,
      });
      assertOrgGrantMatchesLease(grant);
      const token = await secretValueForLease(
        new GenerationAddressedIntegrationSecretStore(deps.secrets),
        grant.eligibleOperation,
        {
          orgId: source.orgId,
          projectId: source.projectId,
          providerKind: "linear",
          capability: "issues",
          operation: "intake",
          target: { resourceId: config.teamKey },
        },
      );

      const response = await deps.linearHttp.request({
        endpoint: LINEAR_GRAPHQL_ENDPOINT,
        token,
        query: ISSUES_QUERY,
        variables: { filter: buildFilter(config) },
      });
      // No-silent-fallbacks: a non-200 is a LOUD throw (401/403 ⇒ auth, 429 ⇒ a
      // provider-directed delay the durable poller schedules, else ⇒ transient),
      // NEVER an empty list.
      assertIntakeResponseOk(
        "linear",
        response.status,
        "provider response",
        retryAfterMs(response.headers?.["retry-after"]),
      );

      const items: IngestedItem[] = [];
      for (const issue of issueNodesOrThrow(response.status, response.body)) {
        const id = asString(issue.id);
        const title = asString(issue.title) ?? asString(issue.identifier);
        // Skip anything without a stable id or any title signal.
        if (id === undefined || title === undefined) continue;
        items.push({
          // Idempotent external id = the Linear issue's stable uuid.
          externalId: `linear-${id}`,
          title: title.slice(0, 300),
          body: bodyFor(issue),
          severity: severityFor(issue),
          projectId: source.projectId,
        });
      }
      return items;
    },
  };
}
