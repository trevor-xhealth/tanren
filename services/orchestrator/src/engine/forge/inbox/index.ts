// candidate-inbox barrel. The inbox route + tests import the typed
// surface from here.

export {
  SourceKind,
  InboxSourceState,
  InboxSource,
  InboxSourceAttention,
  ActiveGitHubIssuesConfig,
  ActiveLinearIssuesConfig,
  ActiveIssuesConfig,
  ActiveSentryConfig,
  parseInboxSourceCreateConfig,
  parsePersistedInboxSourceConfig,
  TriageVerdict,
  TriageRoutableSpec,
  TriageEntityAnchor,
  CandidateTriage,
  CandidateStatus,
  Candidate,
  type IngestedItem,
  type SourceConnector,
  type TriageAnswerer,
  type TriageAnswererContext,
} from "./types.js";

export { wrapProviderTriageAnswerer, type WrapProviderTriageAnswererOptions } from "./providerAnswerer.js";
export { buildTriagePrompt } from "./prompt.js";

export {
  IntakeSourceAuthError,
  IntakeSourceAuthorityError,
  IntakeSourceFetchError,
  IntakeSourceRateLimitError,
  IntakeSourceResourceError,
  UnsupportedInboxProviderError,
  assertIntakeResponseOk,
  assertIssuesProviderIs,
  assertNoSourceCredentialOverride,
  assertSupportedIssuesProvider,
  resolveIssuesProvider,
  type IntakeSourceProvider,
  type IssuesProvider,
} from "./connectorErrors.js";

export { createGitHubIssuesConnector, type GitHubConnectorDeps } from "./githubConnector.js";

export { createIssuesDispatcher, type IssuesDispatcherDeps } from "./issuesDispatcher.js";

export {
  createLinearConnector,
  buildPgLinearIntakeAuthority,
  FetchLinearHttpClient,
  LINEAR_GRAPHQL_ENDPOINT,
  type LinearConnectorDeps,
  type LinearIntakeAuthority,
  type LinearHttpClient,
  type LinearHttpRequest,
  type LinearHttpResponse,
} from "./linearConnector.js";

export {
  createSentryConnector,
  buildPgSentryIntakeAuthority,
  FetchSentryHttpClient,
  type SentryConnectorDeps,
  type SentryIntakeAuthority,
  type SentryHttpClient,
  type SentryHttpRequest,
  type SentryHttpResponse,
} from "./sentryConnector.js";

export { buildInboxConnectorMap, type BuildConnectorMapDeps } from "./connectorMap.js";

// The `inbox_sources` + `candidates` store lives on the `Repositories` seam
// (engine/repositories/inbox.ts); re-exported here so the forge-internal callers
// keep their by-name import.
export { InboxStore, type CreateSourceInput } from "../../repositories/inbox.js";

export { ensureIssuesInboxSource, type EnsureIssuesSourceInput, type EnsureIssuesSourceResult } from "./repoLink.js";

export { resolveProjectPlacement, type PlacementResolution, type PlacementAmbiguityReason } from "./placement.js";

export {
  ingestSource,
  autoRouteCandidate,
  acceptCandidate,
  foldCandidate,
  dismissCandidate,
  closeDuplicateCandidate,
  CandidateNotFoundError,
  CandidateNotPlaceableError,
  TriageAnswererUnconfiguredError,
  type InboxEngineDeps,
  type IngestResult,
  type AutoRouteDeps,
  type AutoRouteResult,
  type AcceptCandidateInput,
  type AcceptCandidateResult,
} from "./engine.js";

// §3.3 entity-anchored Claims — the on-triage CONSULT + ANCHOR intake helpers.
export {
  anchorClaimForCandidate,
  claimAlreadySelfResolved,
  type ClaimEventSink,
  type ClaimLedgerConfig,
} from "./claimsIntake.js";

// §3.3 entity-anchored Claims — the self-validation sweep driver (the durable form
// of the §2.3 staleness check). A scheduler/audit run invokes it over a project.
export {
  selfValidateProjectClaims,
  type EntityClaimProbe,
  type ClaimValidationEventSink,
  type SelfValidateProjectInput,
  type SelfValidateProjectResult,
} from "./claimSelfValidationDriver.js";
