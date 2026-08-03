// credential→project→run resolution.
//
// A run needs a Codex credential ref (to build the four Codex roles) and a
// GitHub credential ref (to publish the draft PR + poll CI). A caller may pass
// both explicitly, but this resolver lets a dashboard-created project resolve
// them from project config or org defaults, so a run can be triggered without
// the caller threading the refs by hand.
//
// Priority, per kind: explicit override → project config → org default →
// `MissingCredentialError`. The GitHub kind is APP-FIRST: when no static ref
// resolves but the org installed the GitHub App, it resolves to the EXPLICIT
// `{ kind: "app" }` decision (the run mints an installation token downstream from
// the threaded `context.installation` — the SAME `resolveGithubToken` path
// greenfield repo-creation, webhook intake, and the merge stage take); only NEITHER
// a static ref NOR the App throws `MissingCredentialError`. The org scope is an
// EXPLICIT discriminated value (`OrgScope`) — a REAL `{ kind: "org", orgId }` (an
// empty/blank org id is a scoping bug that throws `UnscopedOrgError`, never a quiet
// BYOK degrade) or the NAMED `{ kind: "unscopedPlatform" }` org-less mode. The
// resolver is PURE w.r.t. the orchestrator workflow — it only reads
// `organizations.config` for the org defaults + the App-installation block; it does
// NOT mutate state and does NOT itself touch the workflow. The run executor's context
// loader (runExecutionContext) calls this and threads the result into
// `PlannerRunContext`.

import type pg from "pg";
import {
  type ProviderMode,
  defaultManagedProviderConfig,
  resolveHarnessEndpointOverride,
  type HarnessEndpointOverride,
} from "../config/managedProvider.js";
import {
  bindOrgGithubCredentialRefs,
  migrateOrgConfig,
  type OrgConfigV1,
  type OrgDefaultCredentials,
} from "../config/orgConfig.js";
import type { ProjectConfigV1 } from "../config/projectConfig.js";
import type { RoutingChainEntry } from "../config/shared.js";
import { canonicalOrgGithubCredentialRef } from "./refNamespace.js";

type OrgConfigClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** Which run-critical credential kinds the resolver covers. */
export type RunCredentialKind = "llm_default" | "github_token";

/**
 * The resolver's EXPLICIT, discriminated GitHub-credential decision — NOT a bare
 * string where `""` secretly means "App-minted". The two legitimate states are
 * NAMED:
 *   - `{ kind: "static", ref }` — a STATIC `github_token` ref resolved (override →
 *     project → org default); `ref` is a non-empty, grammar-validated credential
 *     ref.
 *   - `{ kind: "app" }` — NO static ref resolved, but the org installed the GitHub
 *     App, so the run mints an INSTALLATION token downstream from the threaded
 *     `context.installation` (the SAME `resolveGithubToken` path greenfield
 *     repo-creation / webhook intake / merge take). There is no ref to carry.
 * The third state — NEITHER a static ref NOR the App — is NOT representable here:
 * it throws `MissingCredentialError("github_token")` (fail-closed). This is the
 * v30-class fix made structural: an "App, no static ref" state can no longer be
 * mistaken for a validated empty string, because it is a distinct VARIANT, not a
 * bare `""` that flows into a credential-ref validator.
 */
export type ResolvedGithubCredential = { kind: "static"; ref: string } | { kind: "app" };

/**
 * Collapse the discriminated {@link ResolvedGithubCredential} to the WIRE string
 * the run context + every downstream git op already consume: a `static` decision
 * carries its `ref`; an `app` decision is the documented EMPTY-STRING App sentinel
 * (every downstream git op reads `ref.trim() === ""` ⇒ "mint the App token from
 * `context.installation`", via `normalizeStaticGithubRef`). This is the ONE place
 * the explicit variant becomes the sentinel — the empty string is produced HERE,
 * NAMED, never conjured by a `?? ""` somewhere mid-pipeline.
 */
export function githubCredentialRefForWire(credential: ResolvedGithubCredential): string {
  return credential.kind === "static" ? credential.ref : "";
}

/**
 * The resolved credentials a run needs. `defaultLlm` is the provider-agnostic
 * routing entry {cli, model, authRef} that heads every loop-role chain a project
 * leaves empty — NOT a Codex-specific ref.
 *
 * `github` is the EXPLICIT discriminated GitHub decision (static-ref vs App-minted —
 * see {@link ResolvedGithubCredential}); `githubCredentialRef` is its WIRE form (the
 * static ref, or the empty-string App sentinel) for the downstream `PlannerRunContext`
 * + git ops that consume a bare string. Both describe the SAME decision — `github` is
 * the type-safe view, `githubCredentialRef` the legacy wire view — so a caller that
 * wants to branch on "static vs App" reads `github.kind` instead of testing `=== ""`.
 *
 * SaaS Tier-B #5: `providerMode` records WHICH source the default LLM came from.
 * Under `managed`, `defaultLlm.authRef` is the platform-owned ref (e.g.
 * `credential/openrouter/platform/default`) and `endpointOverride` carries the
 * OpenAI-compatible base URL the harness must be pointed at. Under `byok`
 * (default) `defaultLlm` is the tenant's own resolved default entry and
 * `endpointOverride` is undefined. The GitHub credential is ALWAYS the tenant's;
 * managed mode only swaps the LLM provider source.
 */
export interface ResolvedRunCredentials {
  defaultLlm: RoutingChainEntry;
  github: ResolvedGithubCredential;
  githubCredentialRef: string;
  providerMode: ProviderMode;
  endpointOverride?: HarnessEndpointOverride;
}

export type ResolvedLlmCredentials = Pick<ResolvedRunCredentials, "defaultLlm" | "providerMode" | "endpointOverride">;

/** Per-kind explicit overrides (e.g. a re-run with a pinned GitHub ref). */
export interface RunCredentialOverride {
  githubCredentialRef?: string;
}

export interface ResolveCredentialsInput {
  /** The project's typed config (already migrated to V1). */
  projectConfig: Pick<ProjectConfigV1, "credentials" | "providerMode">;
  /**
   * The org scope whose `config.defaultCredentials` provides the fallback layer.
   * This is a DISCRIMINATED scope, NOT a bare string that can quietly be `""`: a
   * missing tenant scope is a BUG, not a license to fall back to BYOK.
   *
   *   - `{ kind: "org", orgId }` — a REAL run/forge path scoped to a tenant. `orgId`
   *     MUST be non-empty; an empty one is a scoping bug and throws
   *     {@link UnscopedOrgError} (never a silent degrade to project-config-only BYOK).
   *   - `{ kind: "unscopedPlatform" }` — the EXPLICIT, opt-in "resolve from project
   *     config only" mode (no org row, no org defaults, `byok` provider mode). This
   *     is the ONE legitimate no-org-defaults case and a caller must NAME it; it is
   *     never reached by coercing an absent org to `""`.
   */
  orgScope: OrgScope;
  /** Highest-priority refs; wins over project config + org default. */
  override?: RunCredentialOverride;
}

/**
 * The credential resolver's org scope — the EXPLICIT replacement for a bare `orgId`
 * string that callers used to coerce with `?? ""`. See {@link ResolveCredentialsInput}.
 */
export type OrgScope = TenantScope | { kind: "unscopedPlatform" };

/**
 * The NARROWED variant of {@link OrgScope} carried by every tenant-scoped path (run
 * / forge project surface / design writer + oracle). It is the ONLY legitimate scope
 * for a run — the `unscopedPlatform` variant is reserved for the greenfield forge
 * interview and is NOT reachable from a run. Callers on a run path receive this
 * narrower type from {@link orgScopeFromRunOrgId} and can read `orgId` directly
 * without a `kind === "org"` branch (the branch is unreachable by the type).
 */
export type TenantScope = { kind: "org"; orgId: string };

/**
 * Build an `{ kind: "org" }` scope from a real org id, failing LOUD on an empty/blank
 * one. The run + forge paths thread their row's `org_id` through THIS instead of
 * `?? ""`: `projects.org_id` / `runs.org_id` are NOT-NULL, so an empty org id at a
 * run path is a scoping/RLS-denial bug — it must be a loud error, not a quiet BYOK
 * degrade. The `unscopedPlatform` mode is reached only by NAMING it directly, never
 * by an empty string flowing through here. Returns the NARROWED {@link TenantScope}
 * (not the broader {@link OrgScope}) so downstream tenant-only consumers can read
 * `orgId` with no `kind === "org"` branch.
 */
export function orgScopeFromRunOrgId(orgId: string | null | undefined): TenantScope {
  if (typeof orgId !== "string" || orgId.trim() === "") {
    throw new UnscopedOrgError();
  }
  return { kind: "org", orgId };
}

/**
 * Thrown when a run/forge credential resolve carries an EMPTY/absent org id where a
 * real tenant scope is required. A real run row always has a NOT-NULL `org_id`, so an
 * empty one is a scoping bug — failing loud here surfaces it instead of silently
 * choosing BYOK / no-App behavior for an unscoped org (the no_silent_fallbacks
 * doctrine). A genuinely org-less path must opt into `{ kind: "unscopedPlatform" }`.
 */
export class UnscopedOrgError extends Error {
  constructor() {
    super(
      "credential resolve received an empty org id where a real tenant scope is required " +
        "(a missing org scope is a bug, not a license to fall back to BYOK; opt into " +
        "{ kind: 'unscopedPlatform' } for the genuinely org-less platform path)",
    );
    this.name = "UnscopedOrgError";
  }
}

/**
 * The org-config fields the provider-mode resolution reads. Pulled once
 * alongside `defaultCredentials` so a managed run never makes a second org read.
 * `hasGithubApp` records whether the org installed the GitHub App: when no static
 * `github_token` ref resolves but the App IS installed, the run resolves an App
 * installation token downstream (the SAME path greenfield/webhook/merge use) — so
 * an App-first org never needs a static PAT to RUN.
 */
interface OrgProviderModeConfig {
  defaults?: OrgDefaultCredentials;
  providerMode: ProviderMode;
  hasGithubApp: boolean;
}

/**
 * Thrown when a required credential kind cannot be resolved from any layer.
 * `kind` names which one is missing so the executor can render a precise
 * "bind a Codex bundle / GitHub token" prompt rather than a generic failure.
 */
export class MissingCredentialError extends Error {
  readonly kind: RunCredentialKind;

  constructor(kind: RunCredentialKind) {
    super(
      kind === "llm_default"
        ? "No default LLM resolved for this run (project config and org default are both unset)"
        : "No GitHub credential resolved for this run (no static ref in project config / org default, and the org has not installed the GitHub App)",
    );
    this.name = "MissingCredentialError";
    this.kind = kind;
  }
}

/**
 * Thrown when an `{ kind: "org" }` scope's org row reads back ABSENT. A real run
 * always has a real org row, so an empty read is a scoping/RLS-denial bug (the read
 * ran off-scope and the deny-by-default policy returned zero rows) — NOT a
 * legitimate "org has no config" signal. Failing loudly here surfaces the scoping
 * bug instead of silently degrading a managed org to BYOK. (The genuinely org-less
 * path is the EXPLICIT `{ kind: "unscopedPlatform" }` scope, which never reaches
 * this read.)
 */
export class OrgProviderModeUnresolved extends Error {
  readonly orgId: string;

  constructor(orgId: string) {
    super(
      `Org provider-mode config could not be resolved for org ${JSON.stringify(orgId)}: the organizations row read back empty for a non-empty org id (a scoping/RLS-denial bug, not "no config")`,
    );
    this.name = "OrgProviderModeUnresolved";
    this.orgId = orgId;
  }
}

/**
 * Resolve a run's Codex + GitHub credential refs. Reads the org's
 * `defaultCredentials` from `organizations.config` once and applies the
 * override → project → org-default priority for each kind. Throws
 * `MissingCredentialError` for the first kind that resolves to nothing.
 */
export async function resolveCredentialsForRun(
  pool: OrgConfigClient,
  input: ResolveCredentialsInput,
): Promise<ResolvedRunCredentials> {
  const orgConfig = await loadOrgProviderModeConfig(pool, input.orgScope);
  const projectCredentials = input.projectConfig.credentials ?? {};
  const llm = resolveLlmCredentials(input.projectConfig, orgConfig);

  // GitHub is ALWAYS the tenant's credential — managed mode only swaps the LLM
  // provider source, never the repo identity used to publish PRs / poll CI.
  //
  // App-first: a STATIC `github_token` ref (override → project → org default) wins
  // when present. When NONE resolves but the org installed the GitHub App, the run
  // resolves an App INSTALLATION token downstream (the SAME `resolveGithubToken`
  // path greenfield repo-creation, the webhook intake, and the merge stage take) —
  // the EXPLICIT `{ kind: "app" }` decision (NOT a bare `""`); the wire form below
  // collapses it to the documented empty-string App sentinel every downstream git op
  // already reads as "no static ref ⇒ mint the App token from `context.installation`".
  //
  // FAIL-CLOSED: when NEITHER a static ref NOR the App resolves, `resolveGithubCredential`
  // throws `MissingCredentialError("github_token")` — loud, never a silent default or
  // PAT workaround, and never a representable empty-and-no-App state.
  const github = resolveGithubCredential(
    input.orgScope,
    input.override?.githubCredentialRef,
    projectCredentials.githubCredentialRef,
    orgConfig.defaults?.github_token,
    orgConfig.hasGithubApp,
  );

  return {
    defaultLlm: llm.defaultLlm,
    github,
    githubCredentialRef: githubCredentialRefForWire(github),
    providerMode: llm.providerMode,
    ...(llm.endpointOverride && { endpointOverride: llm.endpointOverride }),
  };
}

/** Resolve only the model credential layers for a Forge answerer (no fake GitHub ref). */
export async function resolveLlmCredentialsForForge(
  pool: OrgConfigClient,
  input: Pick<ResolveCredentialsInput, "projectConfig" | "orgScope">,
): Promise<ResolvedLlmCredentials> {
  return resolveLlmCredentials(input.projectConfig, await loadOrgProviderModeConfig(pool, input.orgScope));
}

function resolveLlmCredentials(
  projectConfig: Pick<ProjectConfigV1, "credentials" | "providerMode">,
  orgConfig: OrgProviderModeConfig,
): ResolvedLlmCredentials {
  const providerMode: ProviderMode = projectConfig.providerMode ?? orgConfig.providerMode;
  if (providerMode === "managed") {
    // MANAGED mode resolves the PLATFORM shell, deliberately without reading the
    // tenant's `defaultCredentials.defaultLlm`: the platform credential ref +
    // endpoint are DEPLOY/hosting config, not userland. That is not an accident of
    // this branch — `OrgConfigV1` is `.strict()` and has NO managed-provider block
    // at all, so an org row CANNOT express a managed credential/endpoint override
    // (see `managedProvider.ts`, and the org-config test that asserts a userland
    // `managedProvider` block is REJECTED). A tenant chooses the MODE; the hosting
    // layer owns the shell.
    //
    // The MODEL is omitted for the same reason it must not be borrowed from the
    // tenant entry: `defaultLlm` is an atomic (cli, model, authRef) triple whose
    // cli↔authRef compatibility `DefaultLlmEntry` validates as a unit, and a
    // tenant's model id is namespaced for THEIR route (codex-direct
    // `gpt-5.6-luna`) — replaying it on the platform's OpenRouter route (which
    // needs `openai/gpt-5.6-luna`) would be a silent namespace mis-wire. An
    // ABSENT model is the schema's NAMED "use the provider's pinned default", and
    // the codex OpenRouter path substitutes `CODEX_OPENROUTER_MODEL` for it. It is
    // never the `"default"` string — that sentinel reached OpenRouter verbatim and
    // 400'd every managed model call.
    const managed = defaultManagedProviderConfig();
    return {
      defaultLlm: { cli: "codex", authRef: managed.credentialRef },
      providerMode,
      endpointOverride: resolveHarnessEndpointOverride("managed", managed),
    };
  }
  return {
    defaultLlm: pickEntry("llm_default", projectConfig.credentials?.defaultLlm, orgConfig.defaults?.defaultLlm),
    providerMode,
  };
}

/**
 * Resolve the run's GitHub credential under the App-first policy, as the EXPLICIT
 * discriminated {@link ResolvedGithubCredential} — never a bare `""` sentinel. A
 * non-empty STATIC ref (override → project → org default) ⇒ `{ kind: "static", ref }`.
 * When none resolves but the org installed the App (`hasGithubApp`) ⇒ `{ kind: "app" }`
 * (the run mints the installation token from `context.installation` downstream). When
 * NEITHER resolves, throw `MissingCredentialError("github_token")` (fail-closed) — the
 * empty-and-no-App state is NOT representable.
 */
function resolveGithubCredential(
  scope: OrgScope,
  override: string | undefined,
  projectRef: string | undefined,
  orgDefaultRef: string | undefined,
  hasGithubApp: boolean,
): ResolvedGithubCredential {
  for (const layer of [override, projectRef, orgDefaultRef]) {
    if (typeof layer === "string" && layer.trim() !== "") {
      if (scope.kind !== "org") {
        throw new UnscopedOrgError();
      }
      return {
        kind: "static",
        ref: canonicalOrgGithubCredentialRef({ orgId: scope.orgId, supplied: layer, kind: "github_token" }),
      };
    }
  }
  if (hasGithubApp) {
    return { kind: "app" };
  }
  throw new MissingCredentialError("github_token");
}

/** First present routing-entry layer wins; otherwise the kind is unresolved. */
function pickEntry(kind: RunCredentialKind, ...layers: Array<RoutingChainEntry | undefined>): RoutingChainEntry {
  for (const layer of layers) {
    if (layer !== undefined) {
      return layer;
    }
  }
  throw new MissingCredentialError(kind);
}

/**
 * Read + validate the org's default credential refs AND its provider-mode block
 * in a single read. A present org row is parsed through `migrateOrgConfig`, which
 * fail-hard rejects a row missing an explicit `version` (no silent `byok`
 * default for unversioned rows).
 *
 * Scope-driven, no-fallback:
 *   - `{ kind: "unscopedPlatform" }` — the EXPLICIT org-less mode: no org read at
 *     all, no defaults, the `byok` default mode. This is the ONE legitimate
 *     no-org-defaults case, and a caller reaches it only by NAMING the scope (never
 *     by coercing an absent org to `""`).
 *   - `{ kind: "org", orgId }` with an ABSENT row → THROW {@link OrgProviderModeUnresolved}:
 *     a real run always has a real org row, so an empty read is a scoping/RLS-denial
 *     bug, NOT "no config", and must not silently degrade managed → byok.
 */
async function loadOrgProviderModeConfig(pool: OrgConfigClient, scope: OrgScope): Promise<OrgProviderModeConfig> {
  if (scope.kind === "unscopedPlatform") {
    return { providerMode: "byok", hasGithubApp: false };
  }
  const result = await pool.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [scope.orgId]);
  const row = result.rows[0];
  if (row === undefined) {
    throw new OrgProviderModeUnresolved(scope.orgId);
  }
  const config: OrgConfigV1 = bindOrgGithubCredentialRefs(migrateOrgConfig(row.config), scope.orgId);
  return {
    defaults: config.defaultCredentials,
    providerMode: config.providerMode,
    // App-first run resolution: an installed App lets the run mint an installation
    // token even with no static `github_token` ref (the `unscopedPlatform` mode reads
    // no row, so no App — it stays static-ref-or-throw).
    hasGithubApp: config.github_app !== undefined,
  };
}
