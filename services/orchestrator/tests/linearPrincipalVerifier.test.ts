// Linear principal verification.
//
// The verifier drives the REAL Linear GraphQL probe through a stub `fetch` and
// asserts the identity it stores and the scope it claims. The invariants under
// test are the ones the integration plane depends on: the workspace id comes
// from the provider response and nothing else, a GraphQL 200-with-errors is an
// invalid credential rather than a verified one, and the `read` scope is only
// claimed when the issue read that proves it actually succeeded.

import { describe, expect, it, vi } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import { LinearPrincipalVerifier } from "../src/engine/integrations/linearPrincipalVerifier.js";
import { hasPrincipalVerifier, principalVerifierFor } from "../src/engine/integrations/principalVerifiers.js";
import { catalogOperation, isKnownProviderKind } from "../src/engine/contracts/integrationCatalog.js";
import { testPrincipalVerificationPermit } from "./helpers/orgGrant.js";

async function verify(
  operationId: string,
  responder: () => Response,
): Promise<Awaited<ReturnType<LinearPrincipalVerifier["verify"]>>> {
  const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
  const staged = await secrets.stage(operationId, "lin_api_token");
  const permit = await testPrincipalVerificationPermit({ providerKind: "linear", operationId });
  const fetchImpl = vi.fn<typeof fetch>(async () => responder());
  return new LinearPrincipalVerifier(fetchImpl as unknown as typeof fetch).verify(permit, staged, secrets);
}

describe("linear provider registration", () => {
  it("is a catalogued provider whose issues capability exposes the intake operation", () => {
    expect(isKnownProviderKind("linear")).toBe(true);
    expect(catalogOperation("linear", "issues", "intake")).toEqual({
      id: "intake",
      requiredScopes: ["read"],
      plane: "control",
    });
    // Tanren reads Linear and never writes to it, so there is nothing to provision.
    expect(catalogOperation("linear", "issues", "provision")).toBeUndefined();
  });

  it("resolves a principal verifier so an org can link a Linear workspace", () => {
    expect(hasPrincipalVerifier("linear")).toBe(true);
    expect(principalVerifierFor("linear").providerKind).toBe("linear");
  });
});

describe("linear principal verifier", () => {
  it("stores the workspace id from the provider response, not a caller label", async () => {
    const result = await verify("op-linear-ok", () =>
      Response.json({
        data: {
          organization: { id: "org_9f1c", name: "Acme", urlKey: "acme" },
          issues: { nodes: [{ id: "issue_1" }] },
        },
      }),
    );
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.principal.providerPrincipalId).toBe("org_9f1c");
    expect(result.principal.principalKind).toBe("organization");
    expect(result.principal.displayName).toBe("Acme");
    expect(result.principal.metadata).toEqual({ urlKey: "acme" });
    expect(result.authKind).toBe("api_key");
    // proven by the issue read that just succeeded on this credential.
    expect(result.scopes).toEqual(["read"]);
  });

  it("verifies against an empty backlog — zero issues still proves the read", async () => {
    const result = await verify("op-linear-empty", () =>
      Response.json({ data: { organization: { id: "org_1" }, issues: { nodes: [] } } }),
    );
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.scopes).toEqual(["read"]);
  });

  it("treats a GraphQL 200-with-errors as an invalid credential, never a verified one", async () => {
    const result = await verify("op-linear-gql", () =>
      Response.json({ errors: [{ message: "Authentication required, not authenticated" }] }),
    );
    expect(result).toEqual({ status: "invalid", reason: "linear_graphql_error" });
  });

  it("refuses to claim the read scope when identity resolved but the issue read did not", async () => {
    const result = await verify("op-linear-no-read", () =>
      Response.json({ data: { organization: { id: "org_1", name: "Acme" } } }),
    );
    expect(result).toEqual({ status: "invalid", reason: "linear_scopes_unproven" });
  });

  it("maps a 401 to invalid and a 502 to unavailable", async () => {
    expect(await verify("op-linear-401", () => new Response("", { status: 401 }))).toEqual({
      status: "invalid",
      reason: "linear_http_401",
    });
    const unavailable = await verify("op-linear-502", () => new Response("", { status: 502 }));
    expect(unavailable.status).toBe("unavailable");
  });
});
