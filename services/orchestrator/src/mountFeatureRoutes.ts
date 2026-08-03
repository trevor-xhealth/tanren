// The orchestrator's feature-route mount table, extracted from `buildApp` in
// main.ts. `buildApp` owns app construction, auth, the inline run/spec/CI
// handlers, and lifecycle; this module owns the long, declarative list of
// `app.route(...)` registrations for the create*Routes factories. Splitting it
// out keeps main.ts's import count and `buildApp`'s length focused without
// changing any wiring — every registration here is byte-for-byte the prior
// inline call, in the same order.

import type { Hono } from "hono";
import type pg from "pg";
import { orgScopingPool } from "./engine/data/orgScopedDb.js";
import { PgEventStore } from "./engine/eventStore.js";
import type { Allocator, SecretStore, CommandSubstrate } from "./engine/contracts/index.js";
import { buildForgeRouteAnswererFactories } from "./engine/forge/routeFactories.js";
import type { GitHubHttpClient } from "./engine/providers/github.js";
import type { GithubAppTokenMinter } from "./engine/providers/githubAppTokenMinter.js";
import { mountGithubAppInstallFromEnv } from "./routes/auth/githubAppInstall.js";
import { mountBehaviorSurfaces } from "./routes/behaviorCoverage/mount.js";
import { mountBrownfieldRoutes } from "./routes/brownfield/mount.js";
import { createCredentialRoutes, type CredentialRegistry } from "./routes/credentials/index.js";
import {
  createDesignEcosystemRoutes,
  createDesignPublicRoutes,
  createDesignStudioRoutes,
} from "./routes/designStudio/index.js";
import { createDiscoveryRoutes } from "./routes/discovery/index.js";
import { createDoctorRoutes } from "./routes/doctor/index.js";
import { mountReportRoutes, type MountReportRoutesDeps } from "./routes/experiments/mount.js";
import { createForgeAskRoutes, createForgeProposalRoutes, createForgeRoutes } from "./routes/forge/mount.js";
import { createInboxRoutes } from "./routes/inbox/index.js";
import { createAuditRoutes } from "./routes/audits/index.js";
import { createIssueWebhookRoutes } from "./routes/githubWebhooks/index.js";
import { createInsightRoutes } from "./routes/insights/index.js";
import { createIntegrationRoutes, createIntegrationReadRoutes } from "./routes/integrations/index.js";
import { createRequirementCompilerRoutes } from "./routes/requirementCompiler/index.js";
import { createMilestoneRoutes } from "./routes/milestones/index.js";
import { createNotificationRoutes } from "./routes/notifications/index.js";
import {
  buildLiveLoadFragmentLibrary,
  buildLiveMaterializeTemplate,
  buildLiveRunFragmentAuthoring,
  createOnboardingRoutes,
} from "./routes/onboarding/index.js";
import {
  createAiProviderRoutes,
  type ConfigGateGithubFactory,
  createDeployRoutes,
  createGithubConnectRoutes,
  createOrgRoutes,
} from "./routes/orgs/index.js";
import { createPersonaRoutes } from "./routes/personas/index.js";
import { createProjectRoutes } from "./routes/projects/index.js";
import { createRecoveryRoutes } from "./routes/recovery/index.js";
import { createRunRoutes } from "./routes/runs/index.js";
import { mountProjectWorkSurfaces } from "./routes/issueLoops/mount.js";
import type { ActorContextEnv } from "./middleware/auth.js";

/** The benchmark scheduler's live infra (the route supplies the pool itself). */
export type BenchmarkRouteInfra = NonNullable<MountReportRoutesDeps["benchmark"]>;

export interface FeatureRouteDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  /** The shared (timed) GitHub HTTP client every run/merge-lifecycle route host seam builds over. */
  githubHttp: GitHubHttpClient;
  githubAppMinter: GithubAppTokenMinter;
  credentialRegistry: CredentialRegistry;
  configGateGithub: ConfigGateGithubFactory;
  vaultHealthCheck: () => Promise<{ ok: boolean; status: number }>;
  // The runner allocator + SSH substrate + identity ref the run worker uses —
  // the Forge answerer factories allocate a short-lived runner per model call to
  // run the REAL provider answerer (engine/forge/providerFactory.ts). Same
  // values `buildApp` assembles for the benchmark infra.
  allocator: Allocator;
  ssh: CommandSubstrate;
  identitySecretRef: string;
  // B1 (webhook provisioning): the public base URL Tanren is reachable at, so the
  // inbox webhook-provision endpoint can construct the GitHub `issues` callback URL.
  // Omitted → the provisioning endpoint is not mounted.
  publicBaseUrl?: string;
  // Live benchmark infra (allocator + SSH + runner identity + the shared LISTEN
  // connection) so the benchmark scheduler runs REAL trials — the post-merge
  // accept tier and the LISTEN/NOTIFY terminal await. Omitted (the default) →
  // the runner's own defaults apply (no-op accept, poll await): the route still
  // schedules + persists trials, but the live verdict/await are not wired.
  benchmark?: BenchmarkRouteInfra;
}

/**
 * Mount every feature route on `app`. Registration order is preserved from the
 * prior inline block in `buildApp`; behavior is identical.
 */
export function mountFeatureRoutes(app: Hono<ActorContextEnv>, deps: FeatureRouteDeps): void {
  const { pool, secrets, githubHttp, githubAppMinter, credentialRegistry, configGateGithub, vaultHealthCheck } = deps;
  const benchmarkInfra = deps.benchmark;
  // RLS R3b: every `/orgs/:orgId/*` (+ `/orgs/:orgId/credentials`) operator route
  // handler runs its tenant-table reads/writes on this org-scoping pool. Combined
  // with the per-request `runWithJobOrgId` org scope the auth middleware
  // establishes, each handler `.query` opens a SHORT `runWithOrgScope` per
  // statement stamped with the request's org — so under the runtime `tanren_app`
  // role the deny-by-default RLS policies admit the handler's rows. With no org
  // scope set (a bootstrap/unscoped request) the proxy is behavior-identical to
  // the bare pool. The seam is a drop-in `pg.Pool`; factories need no edits, and
  // self-scoping helpers (`createProject`/`createSpec` `runWithOrgScope`,
  // `resolveWritableClient`) still resolve correctly through it.
  const scopedPool = orgScopingPool(pool);
  // The per-surface Forge answerer factories: each Forge ideation surface
  // resolves a REAL provider answerer (no deterministic fallback — §8a) by
  // allocating a runner per model call against the shared infra (the same
  // allocator / SSH / identity ref the run worker uses). Each route calls its
  // factory with the request's org/project target.
  //
  // The factories get the `scopedPool` (NOT the bare `pool`): a Forge answerer's
  // org/project config reads (interview/discovery/triage/recon/conversation) must
  // carry the request's org GUC, or under the `tanren_app` RLS role they read
  // ZERO rows and the resolution wrongly degrades. The proxy opens a short
  // org-scoped txn per `.query` from the request's ambient org id.
  const forgeInfra = {
    pool: scopedPool,
    secrets,
    allocator: deps.allocator,
    ssh: deps.ssh,
    identitySecretRef: deps.identitySecretRef,
  };
  const forgeAnswerers = buildForgeRouteAnswererFactories(forgeInfra);
  // gv-15: the existing gv-7..14 authority must be registered on the real
  // production app. The dashboard consumes these routes; a constructed but
  // unmounted factory is not an HTTP surface.
  forgeAnswerers.mountGovernanceRoutes(app);
  app.route("/orgs", createOrgRoutes({ pool: scopedPool, configGateGithub }));
  // Wave-2 operator API: the "Connect AI provider" + billing-mode settings surface.
  // Mounted on the org-scoping pool (reads/writes `organizations.config` under RLS)
  // and sharing the durable credential registry so a connected provider appears in
  // the credential list. Stores BYOK keys under a COST-CLASSIFIABLE ref so the
  // budget gate meters them (routes/aiProvider/index.ts).
  app.route("/orgs", createAiProviderRoutes({ pool: scopedPool, secrets, registry: credentialRegistry }));
  // Wave-2 operator API: human-drivable "Connect GitHub" (App install OR token,
  // server-stamped `installedAt`, no raw config PATCH) + the connected identity's
  // REAL capability check (`runReady` + severity-classified permission gaps,
  // read declaratively from the granted permission set) + the onboarding readiness
  // checklist. Org-scoped on the scoped pool; the shared minter caches App tokens.
  // The managed App credential ref (when configured via env) backs an install
  // connect that omits a `credentialRef`.
  app.route(
    "/orgs",
    createGithubConnectRoutes({
      pool: scopedPool,
      secrets,
      minter: githubAppMinter,
      ...(process.env["TANREN_GITHUB_APP_CREDENTIAL_REF"] === undefined ||
      process.env["TANREN_GITHUB_APP_CREDENTIAL_REF"] === ""
        ? {}
        : { appCredentialRef: process.env["TANREN_GITHUB_APP_CREDENTIAL_REF"] }),
    }),
  );
  app.route(
    "/orgs",
    // GREENFIELD: the `/projects/greenfield` create path mints the org's GitHub App
    // token + creates a brand-new repo through the `CodeHost.createRepo` seam
    // (constructed from `githubHttp`), so the project routes carry the
    // secrets/http/minter deps (the brownfield-link route uses the same App resolution).
    createProjectRoutes({ pool: scopedPool, secrets, githubHttp, githubAppMinter }),
  );
  // The app-env-to-Actions-secrets + CI-ingest-secrets routes are GONE: the native gate
  // runs the project's tests over SSH with the app env materialized in-process, and the
  // per-test JUnit grain is ingested in-process from the runner — no Actions secrets,
  // no JUnit-upload webhook (the no-Actions delivery model).
  // Project work-intake surfaces (spec CRUD + the bh-1 back-half IssueLoop
  // aggregate read surface) on the org-scoping pool, folded into one sub-mount —
  // see routes/issueLoops/mount.ts. Specs mount first (same path/order as the
  // prior inline call); the issue-loop read surface follows.
  mountProjectWorkSurfaces(app, scopedPool);
  app.route("/orgs", createPersonaRoutes({ pool: scopedPool }));
  // Runtime-verification behavior surfaces (persona/behavior-revision API + the
  // rv-4 behavior-coverage selection authority) on the org-scoping pool, folded
  // into one sub-mount — see routes/behaviorCoverage/mount.ts. Same routes, same
  // paths, same deps, same registration order as the prior inline calls.
  mountBehaviorSurfaces(app, scopedPool);
  app.route("/orgs", createMilestoneRoutes({ pool: scopedPool }));
  mountBrownfieldRoutes(app, {
    pool: scopedPool,
    secrets,
    githubHttp,
    githubAppMinter,
    reconAnswererFactory: forgeAnswerers.recon,
  });
  // GitHub App install flow; mounts only when configured via env.
  // SECURITY (H1): the install/callback handlers write the org's
  // `config.github_app` and self-authorize the request actor against the TARGET
  // org (org-admin), so they run on the org-scoping pool — never the raw pool.
  mountGithubAppInstallFromEnv(app, { pool: scopedPool, secrets, minter: githubAppMinter });
  app.route("/orgs", createForgeRoutes({ pool: scopedPool, secrets, githubHttp }));
  // thick-Forge LLM conversation endpoint (⌘K chat morph); the answerer
  // is the real provider conversation answerer, resolved per-request.
  app.route(
    "/orgs",
    createForgeAskRoutes({
      pool: scopedPool,
      secrets,
      githubHttp,
      answererFactory: forgeAnswerers.conversation,
    }),
  );
  // write-action approval: approve/reject proposed write actions.
  app.route("/orgs", createForgeProposalRoutes({ pool: scopedPool }));
  // The forge-CI webhook (`/github/webhooks/ci`) is GONE: the native gate is the
  // merge authority (no-Actions delivery model), so there is no forge check-run
  // state for a webhook to advance.
  // P1d autonomous intake — the GitHub issues WEBHOOK RECEIVER (autonomy-engine.md
  // §1d). GitHub posts to `/github/webhooks/issues/:sourceId`; the receiver
  // verifies the source's signature (mandatory), triages with the real provider
  // answerer, and inserts an auto-routable issue into the DAG (else inbox). Like
  // the CI receiver it resolves its tenant server-side, so it keeps the bare pool;
  // the auto-route DAG insert runs under the resolved org's RLS scope internally.
  // §3.6: the receiver now persists-then-202s and a background processor (kicked
  // best-effort here, GUARANTEED by the poller's sweeper) triages/routes. The
  // processor's autonomous DAG-insert deps default to the system actor internally.
  app.route("/", createIssueWebhookRoutes({ pool, secrets, answererFactory: forgeAnswerers.triage }));
  // The JUnit-upload webhook (`/webhooks/ci/junit`) is GONE: the native gate ingests the
  // runner's JUnit report IN-PROCESS after it runs (no Actions upload step, no HMAC).
  app.route("/orgs", createInsightRoutes({ pool: scopedPool }));
  // spec discovery — the model DERIVES proposed specs + DAG placement
  // from the insight; accept → create specs with provenance.
  app.route("/orgs", createDiscoveryRoutes({ pool: scopedPool, answererFactory: forgeAnswerers.discovery }));
  // greenfield onboarding — Forge vision interview → derived product
  // graph via the existing creation paths; the real provider interview answerer.
  app.route(
    "/orgs",
    createOnboardingRoutes({
      pool: scopedPool,
      secrets,
      answererFactory: forgeAnswerers.interview,
      // WS-D3: the design phase elaborates the captured intent into the designed
      // HEAD `DesignContract` during derive, before the build nodes run.
      designAgentFactory: forgeAnswerers.designAgent,
      githubHttp,
      githubAppMinter,
      // COMPOSE+MATERIALIZE seam (docs/roadmap/templating-system.md): every
      // greenfield derive composes a fragment template + materializes it into a
      // fresh seed repo.
      materializeTemplate: (ctx) =>
        buildLiveMaterializeTemplate(
          {
            pool: scopedPool,
            secrets,
            githubHttp,
            ...(githubAppMinter === undefined ? {} : { githubAppMinter }),
          },
          ctx,
        ),
      // F2 — per-fragment authoring DAG: a REAL LLM-backed authorer (the
      // allocating Forge answerer adapter — same infra as planner/checker/
      // auditor) drives a writer-validate convergence loop; the validated
      // fragment lands in the org `fragments` table. No stub fallback.
      runFragmentAuthoring: (ctx) =>
        buildLiveRunFragmentAuthoring(
          {
            pool: scopedPool,
            // v66 fix: wire the durable event store so `fragment.authoring.*`
            // events land in the DB — the templating-system doctrine points
            // operators to those events when F2 halts. Mirrors the pattern in
            // `plannerRun.ts` and `driveCi.ts`. EventStore is now REQUIRED on
            // the seam (no silent-degradation, per writer-seam discipline).
            eventStore: new PgEventStore(scopedPool),
            authorer: forgeAnswerers.fragmentAuthorer({ orgId: ctx.orgId }),
          },
          ctx,
        ),
      // F2 — unified library (bundled core + org-authored fragments). Shadowing:
      // an org fragment with the same (kind, label) wins over the bundled.
      loadFragmentLibrary: buildLiveLoadFragmentLibrary(scopedPool),
      // ds-composer — compose+publish the project's WEB DESIGN SYSTEM during derive.
      // This makes ds-3's F2D authoring loop genuinely callable in production and
      // lights up the run-context reader (`resolveProjectWebDesignSystem`). The
      // design-fragment writer is the SAME allocating Forge answerer infra as F2.
      composeDesignSystem: forgeAnswerers.designSystemComposer,
    }),
  );
  // candidate inbox — issue sources → Forge triage → discovery accept;
  // connector reads via the App resolver, the real provider triage answerer.
  app.route(
    "/orgs",
    createInboxRoutes({
      pool: scopedPool,
      secrets,
      githubHttp,
      answererFactory: forgeAnswerers.triage,
      // B1: enable the webhook-provision endpoint (needs the App minter + a public
      // callback URL). Absent publicBaseUrl ⇒ the endpoint stays unmounted.
      githubAppMinter,
      ...(deps.publicBaseUrl === undefined ? {} : { publicBaseUrl: deps.publicBaseUrl }),
    }),
  );
  // scheduled audits — recurring read-only Answerer passes (the audit
  // job library). A run executes the REAL read-only pass (the audit answerer
  // indexes the project's repo READ-ONLY and surfaces findings); each finding is
  // triaged by the real provider answerer and, when auto-routable, COMMITTED INTO
  // THE DAG as a spec (no operator) — the same hand-off the autonomous loop runs.
  app.route(
    "/orgs",
    createAuditRoutes({
      pool: scopedPool,
      passRunner: forgeAnswerers.auditPassRunnerFor({ githubHttp, githubAppMinter }),
      answererFactory: forgeAnswerers.triage,
    }),
  );
  // Tanren-native templating (wave 1): the template REGISTRY — register/list/get
  // templates + transition lifecycle status, org-scoped on the scoped pool (RLS
  // bounds each query to the org's own templates plus the cross-org official tier).
  //
  // DORA delivery metrics + the benchmark experiment/cell report+CRUD surface.
  // The benchmark scheduler runs on the scoped pool; its live accept/await seams
  // carry their own infra (allocator/ssh/identity/notify) when the boot wired it.
  mountReportRoutes(app, {
    pool: scopedPool,
    // SP-3 × mq-15 connect-up: the mq-15 merge-train export route re-verifies each served
    // bundle via the sole production `PgProofSubstrate`, built inside the report mount from
    // this secret store (keeping this table's runtime-import count in check).
    secrets,
    ...(benchmarkInfra === undefined ? {} : { benchmark: benchmarkInfra }),
  });
  // Codex H3 Surface 6 #17/#18: hand the API-plane secrets store to the route
  // factory so it can build the SAME production channel registry the worker
  // boot did and reject POSTs that route to an unwired channel. Both surfaces
  // agree on the same wired set — the boot-time `requiredChannels` guard threw
  // already if any kind was unwired; the route-write check is belt to that
  // boot suspenders.
  app.route(
    "/orgs",
    createNotificationRoutes({
      pool: scopedPool,
      productionChannelDeps: { pool, secrets, ...(githubAppMinter !== undefined && { githubAppMinter }) },
    }),
  );
  // capability-driven onboarding — "enable error tracking / notify /
  // deploy" resolves the org grant, builds the provisioner with PRODUCTION deps,
  // applies confirm-with-smart-default, persists the artifact (inbox source /
  // notification target / projects.config / secret refs), and emits
  // `integration.provisioned` (refs only). Org-scoped on the scoped pool; the
  // configured SecretStore backs the provisioner's transports.
  // in-7: the derive seam authors any MISSING provider integration definition
  // fragment via the real allocating Forge writer (F2, convergent) — never a stub.
  app.route(
    "/orgs",
    createIntegrationRoutes({
      pool: scopedPool,
      secrets,
      integrationFragmentAuthorer: forgeAnswerers.integrationFragmentAuthorer,
    }),
  );
  // in-20: the integration HTTP READ surface (lifecycle inventory, requirements,
  // capability nodes, bindings with the in-15 appEnvHash proof, delivery-DAG
  // status) — GET-only, versioned under `/v1/orgs`, org+project-RLS guarded.
  // Mirrors the rv-22 read surface (`createVerificationReadRoutes`) shape. The
  // response shapes are pinned by BOTH the byte-exact `contracts/json/integrations/**`
  // mirror (via `engine/schemaExport/catalog.ts`) and the semantic
  // `contracts/integration-read-compat/v1.json` floor (mirroring rv-read-compat).
  app.route("/v1/orgs", createIntegrationReadRoutes({ pool: scopedPool }));
  app.route("/orgs", createRunRoutes({ pool: scopedPool }));
  // in-5: the requirement-compiler CALLABLE PRODUCER. The allocating Forge adapter
  // (the SAME infra every Forge surface uses) backs the actor — production wires it
  // via `forgeInfra`; the actor re-validates every LLM candidate via
  // `parseIntegrationRequirement` (fail-loud, no lexical fallback). Org-scoped on
  // the scoped pool; events append through the sole PgEventStore.
  app.route("/orgs", createRequirementCompilerRoutes({ pool: scopedPool, forgeInfra }));
  // Codex H3 Surface 7 finding #21: the operator-facing manual_external DEPLOY
  // CONFIRMATION route. `POST /orgs/:orgId/projects/:projectId/deploys/:deploymentId/confirm`
  // flips a pending-manual-confirmation attestation → confirmed + emits
  // `deploy.manual_confirmed`. Org-scoped on the scoped pool (RLS bounds the
  // confirm to the tenant's own attestation rows).
  app.route("/orgs", createDeployRoutes({ pool: scopedPool }));
  app.route("/orgs", createRecoveryRoutes({ pool: scopedPool }));
  // ds-5 WITHIN-ORG DESIGN REUSE surface (Studio catalog, per-project reuse
  // binding, render-verdict evidence lab, artifact export index + real byte
  // download), versioned under `/v1/orgs` like the rv-22 read surface. The export
  // download streams the SAME local CAS bytes the greenfield composer wrote (the
  // route self-defaults to DEFAULT_DESIGN_ARTIFACT_ROOT); an absent byte fails
  // LOUD (503), never fake.
  app.route("/v1/orgs", createDesignStudioRoutes({ pool: scopedPool }));
  // ds-8 cross-org bridge: one admin command dispatcher plus a deliberately
  // metadata-only public projection. Both services use the real system scope
  // for narrow cross-org reads and never expose artifact/download coordinates.
  app.route("/v1/orgs", createDesignEcosystemRoutes({ pool: scopedPool }));
  app.route("/v1", createDesignPublicRoutes({ pool: scopedPool }));
  // Credentials mount at root but every endpoint is `/orgs/:orgId/credentials/*`
  // and reads/writes the org's `config` (RLS-enabled `organizations`), so it gets
  // the org-scoping pool too.
  app.route("/", createCredentialRoutes({ pool: scopedPool, secrets, registry: credentialRegistry }));
  app.route(
    "/",
    createDoctorRoutes({
      pool,
      secrets,
      vaultHealthCheck,
    }),
  );
}
