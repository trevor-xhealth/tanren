// Single import surface for versioned org + project config.
export {
  AllocatorConfig,
  AllocatorKind,
  CANONICAL_RUNNER_IMAGE,
  AuditPostureConfig,
  AUTONOMOUS_AUDIT_POSTURE,
  DEFAULT_AUDIT_POSTURE,
  FindingSeverityConfig,
  P2P3HandlingConfig,
  BudgetPeriod,
  CreditRates,
  DEFAULT_BUDGET_PERIOD,
  DEFAULT_SPECULATION_THRESHOLD,
  DEFAULT_SPECULATIVE_INTEGRATION_DEPTH,
  ForgePersona,
  GovernancePosture,
  HealthHint,
  MergeIntegration,
  NotificationTargetRef,
  PartialAllocatorConfig,
  PartialForgePersona,
  ProjectBudget,
  ReviewPolicy,
  RoleId,
  RoutingChain,
  RoutingChainEntry,
  RoutingTable,
  SpeculationThreshold,
  UnknownConfigVersionError,
  emptyRoutingTable,
  resolveRunWorkspaceReaperConfig,
  resolveWorkerConcurrency,
} from "./shared.js";
export type { RunWorkspaceReaperConfig, WorkerConcurrencyLayers } from "./shared.js";

export {
  DEFAULT_MANAGED_CREDENTIAL_REF,
  DEFAULT_MANAGED_ENDPOINT,
  ManagedProviderConfig,
  ProviderMode,
  defaultManagedProviderConfig,
  resolveHarnessEndpointOverride,
} from "./managedProvider.js";
export type { HarnessEndpointOverride } from "./managedProvider.js";

export {
  OrgAuditGateTarget,
  OrgConfigV1,
  OrgConfigVersioned,
  OrgDefaultCredentials,
  OrgGithubAppInstallation,
  SUPPORTED_ORG_CONFIG_VERSIONS,
  creditRatesFromOrgConfig,
  defaultOrgConfigV1,
  migrateOrgConfig,
  orgConfigJsonSchema,
} from "./orgConfig.js";

export {
  applyOnMerge,
  buildConfigPrTitle,
  gatedConfigWrite,
  isBucketBChange,
  renderTanrenYaml,
  renderTanrenYamlDiff,
} from "./tanrenConfigGate.js";
export type {
  ConfigYamlDiffLine,
  GatedConfigWriteInput,
  GatedConfigWriteResult,
  GateConfigPullRequest,
} from "./tanrenConfigGate.js";

export {
  DEFAULT_UPGRADE_POLICY,
  ProjectConfigV1,
  ProjectConfigVersioned,
  ProjectCredentialRefs,
  ProjectEnvironmentRef,
  ProjectLifecycle,
  ProjectUpgradePolicy,
  SUPPORTED_PROJECT_CONFIG_VERSIONS,
  defaultProjectConfigV1,
  isAbsentProjectConfig,
  migrateProjectConfig,
  projectConfigJsonSchema,
} from "./projectConfig.js";
