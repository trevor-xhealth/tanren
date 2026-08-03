/**
 * Linear principal verifier.
 *
 * A Linear API credential is bound to exactly ONE workspace, so verification
 * yields exactly one `organization` principal and never the multi-principal
 * path that Sentry/Vercel/Fly need. The stable id is the workspace's
 * `organization.id` from a provider-authenticated response — never a
 * caller-supplied label.
 *
 * Scope proof: Linear advertises no scope header on API responses, so the
 * catalogued `read` scope is proven the only honest way — by performing, in the
 * SAME authenticated request, the exact read the `issues.intake` operation will
 * later perform (`issues(first: 1)`). A response that resolves the workspace but
 * not the issue connection proves identity WITHOUT proving the read, and is
 * reported as unproven rather than assumed. We never invent a scope.
 */

import { z } from "zod";
import type { PrincipalVerificationPermit } from "../contracts/integrationAuthority.js";
import type { IntegrationSecretStore, StagedSecretHandle } from "../contracts/integrationSecretStore.js";
import type { PrincipalVerificationResult, PrincipalVerifier } from "./principalVerifiers.js";
import {
  type FetchImpl,
  principalMetadata as meta,
  providerUnavailable,
  readStagedToken,
} from "./principalVerifierSupport.js";

export const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

// Identity + read-capability probe in one authenticated round trip. `organization`
// is the workspace the credential belongs to; the one-node `issues` connection is
// the same read `issues.intake` performs, so a success proves the `read` scope.
const VIEWER_QUERY = `query TanrenLinearPrincipal {
  organization { id name urlKey }
  issues(first: 1) { nodes { id } }
}`;

const LinearPrincipalSchema = z.object({
  data: z
    .object({
      organization: z
        .object({
          id: z.string().min(1),
          name: z.string().optional(),
          urlKey: z.string().optional(),
        })
        .optional(),
      issues: z.object({ nodes: z.array(z.unknown()).optional() }).optional(),
    })
    .optional(),
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});

export class LinearPrincipalVerifier implements PrincipalVerifier {
  readonly providerKind = "linear";

  constructor(private readonly fetchImpl: FetchImpl = fetch) {}

  async verify(
    permit: PrincipalVerificationPermit,
    staged: StagedSecretHandle,
    secrets: IntegrationSecretStore,
  ): Promise<PrincipalVerificationResult> {
    const token = await readStagedToken(permit, staged, secrets);
    const response = await this.fetchImpl(LINEAR_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        // Linear API keys are sent raw; OAuth access tokens carry the Bearer
        // prefix. Forward the operator's credential verbatim either way.
        Authorization: token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: VIEWER_QUERY }),
    });
    if (response.status === 401 || response.status === 403) {
      return { status: "invalid", reason: `linear_http_${response.status}` };
    }
    if (!response.ok) return providerUnavailable(response, `linear_http_${response.status}`);

    const parsed = LinearPrincipalSchema.safeParse(await response.json());
    if (!parsed.success) return { status: "unavailable", reason: "linear_malformed_principal" };
    // GraphQL reports authentication failures as a 200 with an `errors` array;
    // treating that as a verified principal is exactly the silent degrade the
    // intake doctrine forbids.
    if (parsed.data.errors !== undefined && parsed.data.errors.length > 0) {
      return { status: "invalid", reason: "linear_graphql_error" };
    }
    const organization = parsed.data.data?.organization;
    if (organization === undefined) return { status: "invalid", reason: "linear_no_organization" };
    // Identity resolved but the issue read did not — the credential is real yet
    // its read capability is unproven. Never assume it.
    if (parsed.data.data?.issues?.nodes === undefined) {
      return { status: "invalid", reason: "linear_scopes_unproven" };
    }

    return {
      status: "verified",
      authKind: "api_key",
      // Proven by the issue read that just succeeded on this credential.
      scopes: ["read"],
      principal: {
        providerPrincipalId: organization.id,
        principalKind: "organization",
        displayName: organization.name ?? organization.urlKey ?? organization.id,
        metadata: meta({ urlKey: organization.urlKey }),
      },
    };
  }
}
