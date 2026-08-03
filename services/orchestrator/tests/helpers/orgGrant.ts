import {
  defaultIntegrationResourceConstraints,
  type IntegrationOperationTarget,
  type IntegrationPrivilegedOperation,
  type PrincipalVerificationPermit,
} from "../../src/engine/contracts/integrationAuthority.js";
import { integrationCatalogRevision } from "../../src/engine/contracts/integrationCatalog.js";
import { integrationStagedSecretRef } from "../../src/engine/contracts/integrationSecretStore.js";
import type { OrgGrant } from "../../src/engine/contracts/integrationProvisioner.js";
import { PgIntegrationAuthority } from "../../src/engine/integrations/integrationAuthorityImpl.js";
import type { IntegrationQueryClient } from "../../src/engine/repositories/integrationQuery.js";
import { orgGrantFromLease } from "../../src/engine/repositories/integrationConnectionResolve.js";

type TestGrantInput = {
  providerKind?: string;
  connectionId?: string;
  grantId?: string;
  providerPrincipalId?: string;
  authGeneration?: number;
  grantGeneration?: number;
  credentialRef?: string;
  metadata?: Record<string, unknown>;
  capability?: string;
  operation?: IntegrationPrivilegedOperation;
  target?: IntegrationOperationTarget;
  projectId?: string;
  orgId?: string;
};

function defaultTarget(operation: IntegrationPrivilegedOperation): IntegrationOperationTarget {
  switch (operation) {
    case "discover":
      return {};
    case "provision":
      return { projectName: "proj-test", orgSlug: "org-test" };
    case "bind":
      return { resourceId: "resource-1", projectName: "proj-test", orgSlug: "org-test" };
    case "attach_runtime_env":
      return { resourceId: "app-1", environment: "production" };
    case "intake":
      return { resourceId: "resource-1" };
    case "deploy":
      return { resourceId: "app-1", sourceRepo: "owner/repo", sourceRef: "sha" };
    default:
      return { resourceId: "app-1", deploymentId: "deployment-1" };
  }
}

function scopesFor(providerKind: string): string[] {
  // Direct PRODUCT Slack binds a bot into a product channel before confirming a
  // message. The fixture supplies the catalogued product scopes; individual tests
  // that need a missing-scope state construct it explicitly.
  if (providerKind === "slack") return ["channels:read", "channels:manage", "channels:join", "chat:write"];
  if (providerKind === "sentry") return ["event:read", "project:read", "project:write"];
  if (providerKind === "linear") return ["read"];
  return [];
}

/** Test fixture issued through the real authority; no test-only mint exists. */
export async function testOrgGrant(input: TestGrantInput = {}): Promise<OrgGrant> {
  const providerKind = input.providerKind ?? "slack";
  const operation = input.operation ?? "provision";
  const capability =
    input.capability ??
    (providerKind === "slack"
      ? "notify"
      : providerKind === "sentry"
        ? "errors"
        : providerKind === "linear"
          ? "issues"
          : "deploy");
  const orgId = input.orgId ?? "org-test";
  const projectId = input.projectId ?? "proj-test";
  const authGeneration = input.authGeneration ?? 1;
  const grantGeneration = input.grantGeneration ?? 1;
  const connectionId = input.connectionId ?? "conn-1";
  const grantId = input.grantId ?? "grant-1";
  const baseRef =
    input.credentialRef?.replace(/\/g\/\d+$/u, "") ??
    `secret://org/test/integration/${providerKind}/connection/c/token`;
  const credentialRef = input.credentialRef?.includes("/g/") ? input.credentialRef : `${baseRef}/g/${authGeneration}`;
  const client: IntegrationQueryClient = {
    async query() {
      return {
        rows: [
          {
            connection_id: connectionId,
            provider_kind: providerKind,
            provider_principal_id: input.providerPrincipalId ?? "principal-1",
            display_name: "Test principal",
            principal_metadata: input.metadata ?? {},
            connection_health: "healthy",
            connection_status: "active",
            current_auth_generation: authGeneration,
            grant_id: grantId,
            grant_current_generation: grantGeneration,
            grant_status: "active",
            plane: "control",
            environment: "control",
            credential_ref: credentialRef,
            auth_expires_at: null,
            auth_status: "active",
            capabilities: [capability],
            operations: [operation],
            provider_scopes: scopesFor(providerKind),
            resource_constraints: defaultIntegrationResourceConstraints(),
            policy_revision: integrationCatalogRevision(),
            consent_revision: "consent.test",
            grant_expires_at: null,
            grant_generation_status: "active",
            selected_auth_generation: authGeneration,
            selected_grant_generation: grantGeneration,
            selected_connection_id: connectionId,
            selected_grant_id: grantId,
          },
        ],
        rowCount: 1,
      };
    },
  };
  const result = await new PgIntegrationAuthority().authorizeOperation(client, {
    orgId,
    projectId,
    providerKind,
    capability,
    operation,
    target: input.target ?? defaultTarget(operation),
    actor: { kind: "operator", id: "test" },
  });
  if (result.status !== "eligible") throw new Error(`test authority failed: ${JSON.stringify(result)}`);
  return orgGrantFromLease(result.lease);
}

/** Principal permit fixture issued through the real durable-operation API. */
export async function testPrincipalVerificationPermit(input: {
  orgId?: string;
  providerKind: string;
  actorId?: string;
  operationId?: string;
}): Promise<PrincipalVerificationPermit> {
  const operationId = input.operationId ?? `operation-${input.providerKind}`;
  const client: IntegrationQueryClient = {
    async query() {
      return {
        rows: [
          {
            id: operationId,
            org_id: input.orgId ?? "org-1",
            provider_kind: input.providerKind,
            stage: "credential_staged",
            status: "in_progress",
            staged_secret_handle: integrationStagedSecretRef(operationId),
            actor_id: input.actorId ?? "admin",
          },
        ],
        rowCount: 1,
      };
    },
  };
  return new PgIntegrationAuthority().resumePrincipalVerification(client, {
    orgId: input.orgId ?? "org-1",
    operationId,
  });
}
