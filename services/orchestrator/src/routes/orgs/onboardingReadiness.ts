// THE ONBOARDING READINESS CHECKLIST — what `GET /orgs/:orgId/onboarding-status`
// reports, and the rule that decides `ready`.
//
// Split out of the sibling `github.ts` (which was at the 500-line cap) when the
// checklist became ROUTE-AWARE. The defect that forced it:
//
//   Readiness held `ready:false` until a dollar ceiling was set. But
//   `assertBudgetCeilingEnforceable` FAILS THE RUN CLOSED at setup when that ceiling
//   sits on a route whose spend cannot be metered — codex driving OpenRouter, where
//   the harness discards the generation id, so every call records cost_usd = NULL and
//   the budget gate latches permanently on the run's OWN rows. The configuration
//   tanren called "ready" was therefore precisely the one that could not run on the
//   provider it had just been configured with, and tanren's own refusal event named
//   the remedy — "remove the tanren dollar ceiling for this project" — i.e. become
//   un-`ready`. An operator following the checklist could not reach a state that was
//   both `ready` and runnable.
//
// THE FIX. A ceiling is a checklist REQUIREMENT only where a ceiling can actually be
// enforced. The question is asked of `classifyCeilingEnforceability` — the SAME
// function the run-setup refusal answers with — so readiness and the refusal cannot
// drift apart. Three outcomes, and the operator is told which one applies and why:
//
//   enforceable route + no ceiling  → BLOCKING next step (unchanged, the old rule).
//   unmeterable route + no ceiling  → ADVISORY: no tanren ceiling is required or even
//                                     possible here; bound spend at the provider's own
//                                     key limit. `ready` is TRUE, and the run starts.
//   unmeterable route + a ceiling   → BLOCKING next step to REMOVE it. This is the
//                                     state the old checklist pushed operators into
//                                     and then called ready; every run on it dies at
//                                     setup, so it must not read as ready.
//
// The refusal itself is untouched. A silently-unenforced ceiling is worse than no
// ceiling, so the fix is in what readiness ASKS FOR, never in what the run ACCEPTS.

import { defaultManagedProviderConfig } from "../../engine/config/managedProvider.js";
import type { OrgConfigV1 } from "../../engine/config/orgConfig.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import { describeGithubPermissionGap, type GithubCapability } from "../../engine/credentials/githubCapability.js";
import { classifyCeilingEnforceability } from "../../engine/workflow/budgetPreflight.js";

/** The AI-provider connectivity signal, as the checklist reports it. */
export interface AiProviderStatus {
  connected: boolean;
  classifiedAs?: string;
}

/** The resolved GitHub connection the checklist reads (see `github.ts`). */
export interface ReadinessGithubInput extends Pick<GithubCapability, "runReady" | "canCreateRepos" | "permissionGaps"> {
  connected: boolean;
}

/**
 * Whether a tanren dollar ceiling is a readiness REQUIREMENT for this org's route.
 *
 *  - `required`     — the route meters real spend, so a ceiling is enforceable and
 *                     the checklist demands one.
 *  - `refused`      — tanren would REFUSE a ceiling on this route at run setup, so
 *                     the checklist must not ask for one (and blocks on a set one).
 *  - `undetermined` — no AI provider is connected yet, so there is no route to judge.
 */
export type CeilingRequirement = "required" | "refused" | "undetermined";

export interface OnboardingStatus {
  aiProvider: AiProviderStatus;
  github: { connected: boolean; runReady: boolean; canCreateRepos: boolean };
  budget: {
    ceilingUsd: number | null;
    /** Whether a ceiling is required, refused, or undetermined for this org's route. */
    ceilingRequirement: CeilingRequirement;
    /**
     * Plain-language reason the requirement is what it is — always present, so the
     * operator never has to infer why a ceiling is (or is not) being asked for.
     */
    ceilingRequirementReason: string;
  };
  ready: boolean;
  /** Steps that MUST be done before the org can run; each one keeps `ready` false. */
  nextSteps: string[];
  /** Optional capabilities that are unavailable; these do NOT hold back `ready`. */
  advisories: string[];
}

/**
 * The org's DEFAULT spend-bearing route — the `(cli × credential)` pair a run on
 * this org resolves when no project overrides it. Mirrors `resolveLlmCredentials`
 * exactly (managed mode pins codex + the platform OpenRouter ref; byok takes the
 * org's `defaultLlm`), which is what makes the readiness verdict the same verdict
 * the run gets. A PROJECT may override both layers — stated in the guidance text so
 * the org-level answer is never mistaken for a per-project guarantee.
 */
export interface OrgDefaultRoute {
  cli: string;
  authRef: string;
  hasUsageProbe: boolean;
}

export function resolveOrgDefaultRoute(config: OrgConfigV1): OrgDefaultRoute | undefined {
  if (config.providerMode === "managed") {
    return withProbe({ cli: "codex", authRef: defaultManagedProviderConfig().credentialRef });
  }
  const defaultLlm = config.defaultCredentials?.defaultLlm;
  return defaultLlm === undefined ? undefined : withProbe({ cli: defaultLlm.cli, authRef: defaultLlm.authRef });
}

/**
 * The run-end usage probe (ccusage / codexbar) is CODEX-specific, and ceiling
 * reachability is gated on the WRITER being the probed harness — exactly
 * `resolveRunAdaptersWithBudgetPreflight`'s `writerObservable`. An org whose default
 * writer is codex therefore gets the probe; any other harness does not.
 */
function withProbe(route: { cli: string; authRef: string }): OrgDefaultRoute {
  return { ...route, hasUsageProbe: route.cli === "codex" };
}

interface BudgetChecklist {
  requirement: CeilingRequirement;
  reason: string;
  nextStep?: string;
  advisory?: string;
}

/**
 * Decide the budget checklist item for a route. The ONLY place readiness reasons
 * about ceilings, and it delegates the enforceability question wholesale.
 */
function budgetChecklist(ceilingUsd: number | null, route: OrgDefaultRoute | undefined): BudgetChecklist {
  if (route === undefined) {
    return {
      requirement: "undetermined",
      reason:
        "Whether runs need a tanren dollar ceiling depends on the provider route: connect an AI provider first and this item resolves to required or not-applicable.",
    };
  }
  const verdict = classifyCeilingEnforceability(route);
  if (verdict.kind === "enforceable") {
    const reason = `A tanren dollar ceiling IS enforceable over this org's default ${route.cli} route, so runs must carry one.`;
    return ceilingUsd === null
      ? {
          requirement: "required",
          reason,
          nextStep: `Set a default budget ceiling: PUT /orgs/:orgId/budget so runs have a spend cap. Required because tanren can meter real spend on this org's default ${route.cli} route and therefore enforce the cap.`,
        }
      : { requirement: "required", reason };
  }
  // The route cannot honour a ceiling. Asking for one would hand the operator a
  // configuration that dies at run setup, so the checklist asks for the opposite.
  // Named by the secret-free ref KIND the refusal itself carries — never the full
  // authRef (whose trailing segment is the credential name).
  const where = `${route.cli} × '${verdict.refKind}'`;
  const reason =
    `No tanren dollar ceiling is required for this org's default ${where} route — and none can be enforced: ` +
    `${verdict.detail}. Bound spend instead: ${verdict.remedy}. (A project that overrides the routing or its own ` +
    `default LLM is judged on ITS route when the run starts.)`;
  if (ceilingUsd === null) {
    return { requirement: "refused", reason, advisory: reason };
  }
  return {
    requirement: "refused",
    reason,
    nextStep:
      `Remove the default budget ceiling ($${ceilingUsd}): PUT /orgs/:orgId/budget with ceilingUsd:null. ` +
      `EVERY run on this org's default ${where} route FAILS CLOSED at setup while it is set, because ${verdict.detail}. ` +
      `Bound spend instead: ${verdict.remedy}.`,
  };
}

/**
 * Compose the readiness checklist from the org config + the resolved GitHub
 * connection. Read-only; aggregates the EXISTING config reads (AI provider,
 * GitHub, budget) into the single view a non-expert uses to know what is
 * configured and what is missing.
 */
export function composeOnboardingStatus(
  config: OrgConfigV1,
  github: ReadinessGithubInput,
  aiProvider: AiProviderStatus,
): OnboardingStatus {
  const ceilingUsd = config.defaultBudget?.ceilingUsd ?? null;

  const nextSteps: string[] = [];
  if (!aiProvider.connected) {
    nextSteps.push("Connect an AI provider: import a Codex credential (or enable managed provider).");
  }
  // Severity decides which list a permission gap lands in. A `run_fatal` gap is a
  // BLOCKING next step (no run can finish without it); a `feature_blocking` gap is
  // an advisory (it costs one optional capability, e.g. greenfield repo creation
  // or issue-sourced intake, and must not hold a working org out of `ready`).
  const advisories: string[] = [];
  if (github.connected) {
    for (const gap of github.permissionGaps) {
      const target = gap.severity === "run_fatal" ? nextSteps : advisories;
      target.push(describeGithubPermissionGap(gap));
    }
  } else {
    nextSteps.push("Connect GitHub: POST /orgs/:orgId/github with an App installation or a token.");
  }
  // The budget item is ROUTE-AWARE: it can be a blocking "set one", a blocking
  // "remove the one you set", or a non-blocking advisory. See the module header.
  const budget = budgetChecklist(ceilingUsd, aiProvider.connected ? resolveOrgDefaultRoute(config) : undefined);
  if (budget.nextStep !== undefined) {
    nextSteps.push(budget.nextStep);
  }
  if (budget.advisory !== undefined) {
    advisories.push(budget.advisory);
  }

  // `nextSteps` is the readiness contract: anything still listed must keep the
  // org out of the ready state.
  const ready = nextSteps.length === 0;
  return {
    aiProvider,
    github: { connected: github.connected, runReady: github.runReady, canCreateRepos: github.canCreateRepos },
    budget: {
      ceilingUsd,
      ceilingRequirement: budget.requirement,
      ceilingRequirementReason: budget.reason,
    },
    ready,
    nextSteps,
    advisories,
  };
}

/**
 * The AI-provider connectivity signal from org config. NOT a pure config echo:
 * managed mode is reported connected ONLY after the platform-owned managed
 * credential ref RESOLVES in the SecretStore — a managed org whose platform
 * credential is absent/unresolvable is a LOUD platform-config error
 * ({@link ManagedProviderCredentialMissingError}), never a false `connected:true`.
 * A connected BYOK provider is one whose default LLM routing entry is set.
 * `classifiedAs` names the harness (e.g. "managed", "codex", "claude").
 */
export async function resolveAiProviderStatus(config: OrgConfigV1, secrets: SecretStore): Promise<AiProviderStatus> {
  if (config.providerMode === "managed") {
    // The platform credential ref/endpoint are DEPLOY config (no per-org override);
    // resolve the default managed ref and VERIFY it before reporting connected.
    const ref = defaultManagedProviderConfig().credentialRef;
    const secret = await secrets.get(ref);
    if (secret === undefined || secret.value === "") {
      throw new ManagedProviderCredentialMissingError(ref);
    }
    return { connected: true, classifiedAs: "managed" };
  }
  const defaultLlm = config.defaultCredentials?.defaultLlm;
  if (defaultLlm !== undefined) {
    return { connected: true, classifiedAs: defaultLlm.cli };
  }
  return { connected: false };
}

/**
 * Raised when an org is in `managed` provider mode but the platform-owned managed
 * credential ref resolves to no secret. This is a PLATFORM-config error (the
 * hosting layer failed to provision the managed key), surfaced loud as a
 * `managed_provider_credential_missing` (409) — never a false `connected:true`.
 */
export class ManagedProviderCredentialMissingError extends Error {
  constructor(public readonly ref: string) {
    super(
      `Managed provider credential ref '${ref}' resolves to no secret in the store: ` +
        "the platform managed credential is absent/unresolvable, so managed mode is NOT ready.",
    );
    this.name = "ManagedProviderCredentialMissingError";
  }
}
