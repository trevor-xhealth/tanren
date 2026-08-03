/**
 * Versioned provider/capability/operation catalog — sole source of policy revisions.
 * Consent revision is issued by authenticated administrative action, not callers.
 */

// v3 adds the direct product Slack channel-create/join scopes. Existing grants
// remain ineligible until authority reissues consent against this exact policy.
export const INTEGRATION_POLICY_CATALOG_REVISION = "integration-catalog.v3" as const;

export type IntegrationProviderKind =
  | "slack"
  | "sentry"
  | "linear"
  | "deploy.vercel"
  | "deploy.flyio"
  | "deploy.manual_external"
  | "deploy.pulumi"
  | "deploy.package_release"
  | "deploy.mobile_release";

export interface CatalogOperation {
  id: string;
  requiredScopes: readonly string[];
  plane: "control" | "product";
}

export interface CatalogCapability {
  id: string;
  operations: readonly CatalogOperation[];
}

export interface ProviderCatalogEntry {
  providerKind: IntegrationProviderKind;
  principalKinds: readonly ("team" | "organization" | "user")[];
  capabilities: readonly CatalogCapability[];
  authKinds: readonly ("api_key" | "oauth2" | "bot_token" | "webhook" | "workload_identity")[];
}

const CATALOG: readonly ProviderCatalogEntry[] = [
  {
    providerKind: "slack",
    principalKinds: ["team"],
    authKinds: ["bot_token"],
    capabilities: [
      {
        id: "notify",
        operations: [
          { id: "discover", requiredScopes: ["channels:read"], plane: "control" },
          { id: "provision", requiredScopes: ["channels:manage", "channels:read"], plane: "control" },
          { id: "bind", requiredScopes: ["channels:manage", "channels:read"], plane: "control" },
        ],
      },
      {
        // in-12: the PRODUCT-plane messaging capability the built application uses
        // (managed relay / in-13 direct mode). Distinct from control `notify` — a
        // Tanren operator bot token never validates a product messaging grant.
        id: "messaging.send",
        operations: [
          { id: "discover", requiredScopes: ["channels:read"], plane: "product" },
          // Direct mode creates a product-owned channel and joins its separately
          // authorized bot before it confirms chat.postMessage. Relay mode uses
          // the same product grant through its managed channel lifecycle.
          {
            id: "provision",
            requiredScopes: ["chat:write", "channels:read", "channels:manage", "channels:join"],
            plane: "product",
          },
          {
            id: "bind",
            requiredScopes: ["chat:write", "channels:read", "channels:join"],
            plane: "product",
          },
          // A3 reads the exact product-owned channel independently after the live
          // product action. This is deliberately a separate privileged operation:
          // a chat-write grant without history visibility cannot claim an effect.
          { id: "verify", requiredScopes: ["channels:history"], plane: "product" },
        ],
      },
    ],
  },
  {
    providerKind: "sentry",
    principalKinds: ["organization"],
    authKinds: ["api_key"],
    capabilities: [
      {
        id: "errors",
        operations: [
          { id: "discover", requiredScopes: ["project:read"], plane: "control" },
          // Official Sentry create-project + create-client-key accept project:write OR
          // project:admin (docs.sentry.io/api/projects). Require only project:write —
          // never invent project:admin that the verifier cannot prove without mutation.
          { id: "provision", requiredScopes: ["project:write"], plane: "control" },
          { id: "bind", requiredScopes: ["project:read"], plane: "control" },
          { id: "intake", requiredScopes: ["event:read", "project:read"], plane: "control" },
        ],
      },
    ],
  },
  {
    // Linear issue-tracker intake. Read-only: Tanren pulls a workspace's open
    // issues into the candidate inbox and never writes back, so the entry
    // deliberately carries NO `provision` operation — there is nothing for
    // Tanren to create in Linear. Linear's API scope vocabulary is coarse
    // (`read` covers every read query); never invent a finer scope the
    // verifier cannot prove.
    providerKind: "linear",
    principalKinds: ["organization"],
    authKinds: ["api_key"],
    capabilities: [
      {
        id: "issues",
        operations: [
          { id: "discover", requiredScopes: ["read"], plane: "control" },
          { id: "bind", requiredScopes: ["read"], plane: "control" },
          { id: "intake", requiredScopes: ["read"], plane: "control" },
        ],
      },
    ],
  },
  {
    providerKind: "deploy.vercel",
    principalKinds: ["team", "user"],
    authKinds: ["api_key"],
    capabilities: [
      {
        id: "deploy",
        operations: [
          { id: "discover", requiredScopes: [], plane: "control" },
          { id: "provision", requiredScopes: [], plane: "control" },
          { id: "bind", requiredScopes: [], plane: "control" },
          { id: "attach_runtime_env", requiredScopes: [], plane: "control" },
          { id: "deploy", requiredScopes: [], plane: "control" },
          { id: "verify", requiredScopes: [], plane: "control" },
          { id: "resolve_demo_surface", requiredScopes: [], plane: "control" },
          { id: "resolve_artifact_identity", requiredScopes: [], plane: "control" },
          { id: "promote", requiredScopes: [], plane: "control" },
          { id: "rollback", requiredScopes: [], plane: "control" },
          { id: "teardown_deployment", requiredScopes: [], plane: "control" },
        ],
      },
    ],
  },
  {
    providerKind: "deploy.flyio",
    principalKinds: ["organization"],
    authKinds: ["api_key"],
    capabilities: [
      {
        id: "deploy",
        operations: [
          { id: "discover", requiredScopes: [], plane: "control" },
          { id: "provision", requiredScopes: [], plane: "control" },
          { id: "bind", requiredScopes: [], plane: "control" },
          { id: "attach_runtime_env", requiredScopes: [], plane: "control" },
          { id: "deploy", requiredScopes: [], plane: "control" },
          { id: "verify", requiredScopes: [], plane: "control" },
          { id: "resolve_demo_surface", requiredScopes: [], plane: "control" },
          { id: "resolve_artifact_identity", requiredScopes: [], plane: "control" },
          { id: "promote", requiredScopes: [], plane: "control" },
          { id: "rollback", requiredScopes: [], plane: "control" },
          { id: "teardown_deployment", requiredScopes: [], plane: "control" },
        ],
      },
    ],
  },
  // Fixture / extended deploy adapters — empty scopes; still require project selection.
  {
    providerKind: "deploy.manual_external",
    principalKinds: ["organization"],
    authKinds: ["api_key"],
    capabilities: [
      {
        id: "deploy",
        operations: [
          { id: "discover", requiredScopes: [], plane: "control" },
          { id: "provision", requiredScopes: [], plane: "control" },
          { id: "bind", requiredScopes: [], plane: "control" },
          { id: "attach_runtime_env", requiredScopes: [], plane: "control" },
          { id: "deploy", requiredScopes: [], plane: "control" },
          { id: "verify", requiredScopes: [], plane: "control" },
          { id: "resolve_demo_surface", requiredScopes: [], plane: "control" },
          { id: "resolve_artifact_identity", requiredScopes: [], plane: "control" },
          { id: "promote", requiredScopes: [], plane: "control" },
          { id: "rollback", requiredScopes: [], plane: "control" },
          { id: "teardown_deployment", requiredScopes: [], plane: "control" },
        ],
      },
    ],
  },
  {
    providerKind: "deploy.pulumi",
    principalKinds: ["organization"],
    authKinds: ["api_key"],
    capabilities: [
      {
        id: "deploy",
        operations: [
          { id: "discover", requiredScopes: [], plane: "control" },
          { id: "provision", requiredScopes: [], plane: "control" },
          { id: "bind", requiredScopes: [], plane: "control" },
          { id: "attach_runtime_env", requiredScopes: [], plane: "control" },
          { id: "deploy", requiredScopes: [], plane: "control" },
          { id: "verify", requiredScopes: [], plane: "control" },
          { id: "resolve_demo_surface", requiredScopes: [], plane: "control" },
          { id: "resolve_artifact_identity", requiredScopes: [], plane: "control" },
          { id: "promote", requiredScopes: [], plane: "control" },
          { id: "rollback", requiredScopes: [], plane: "control" },
          { id: "teardown_deployment", requiredScopes: [], plane: "control" },
        ],
      },
    ],
  },
  {
    providerKind: "deploy.package_release",
    principalKinds: ["organization"],
    authKinds: ["api_key"],
    capabilities: [
      {
        id: "deploy",
        operations: [
          { id: "discover", requiredScopes: [], plane: "control" },
          { id: "provision", requiredScopes: [], plane: "control" },
          { id: "bind", requiredScopes: [], plane: "control" },
          { id: "attach_runtime_env", requiredScopes: [], plane: "control" },
          { id: "deploy", requiredScopes: [], plane: "control" },
          { id: "verify", requiredScopes: [], plane: "control" },
          { id: "resolve_demo_surface", requiredScopes: [], plane: "control" },
          { id: "resolve_artifact_identity", requiredScopes: [], plane: "control" },
          { id: "promote", requiredScopes: [], plane: "control" },
          { id: "rollback", requiredScopes: [], plane: "control" },
          { id: "teardown_deployment", requiredScopes: [], plane: "control" },
        ],
      },
    ],
  },
  {
    providerKind: "deploy.mobile_release",
    principalKinds: ["organization"],
    authKinds: ["api_key"],
    capabilities: [
      {
        id: "deploy",
        operations: [
          { id: "discover", requiredScopes: [], plane: "control" },
          { id: "provision", requiredScopes: [], plane: "control" },
          { id: "bind", requiredScopes: [], plane: "control" },
          { id: "attach_runtime_env", requiredScopes: [], plane: "control" },
          { id: "deploy", requiredScopes: [], plane: "control" },
          { id: "verify", requiredScopes: [], plane: "control" },
          { id: "resolve_demo_surface", requiredScopes: [], plane: "control" },
          { id: "resolve_artifact_identity", requiredScopes: [], plane: "control" },
          { id: "promote", requiredScopes: [], plane: "control" },
          { id: "rollback", requiredScopes: [], plane: "control" },
          { id: "teardown_deployment", requiredScopes: [], plane: "control" },
        ],
      },
    ],
  },
] as const;

export function integrationCatalogRevision(): typeof INTEGRATION_POLICY_CATALOG_REVISION {
  return INTEGRATION_POLICY_CATALOG_REVISION;
}

export function catalogEntry(providerKind: string): ProviderCatalogEntry | undefined {
  return CATALOG.find((entry) => entry.providerKind === providerKind);
}

export function catalogCapabilitiesForProvider(providerKind: string): string[] {
  const entry = catalogEntry(providerKind);
  if (entry === undefined) {
    throw new Error(`unknown provider kind '${providerKind}'`);
  }
  return entry.capabilities.map((capability) => capability.id);
}

export function catalogOperation(
  providerKind: string,
  capability: string,
  operation: string,
): CatalogOperation | undefined {
  const entry = catalogEntry(providerKind);
  const cap = entry?.capabilities.find((item) => item.id === capability);
  return cap?.operations.find((item) => item.id === operation);
}

export function isKnownProviderKind(providerKind: string): providerKind is IntegrationProviderKind {
  return catalogEntry(providerKind) !== undefined;
}
