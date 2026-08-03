// plannerRunUsage — the run's CODEX-specific usage/cost builders, split out of
// plannerRunAdapters to keep that file under the 500-line architecture cap. Both
// are codex-subscription-specific: the OpenRouter real-cost capturer and the
// ccusage/codexbar usage probe. The probe's per-role gating (build it when ANY
// role is codex) lives in plannerRunAdapters' resolveRunAdaptersWithBudgetPreflight.
//
// TWO WORDS SPELLED "BYOK". Both builders below used to gate on
// `context.endpointBaseUrl !== undefined` — the tanren-MANAGED platform endpoint —
// as a proxy for questions it does not answer:
//
//   tanren-BYOK      the TENANT's credential rather than the platform's. Says
//                    NOTHING about who the biller is or what auth codex uses.
//   OpenRouter-BYOK  the tenant attached their own UPSTREAM provider keys inside
//                    OpenRouter, so OpenRouter charges only a routing fee and the
//                    real inference cost lands on the upstream provider's invoice.
//
// Conflating them produced two real defects, both fixed here — see
// docs/_design/openrouter-cost-attribution.md §4.4.

import { SshCcusageAccountant, SshCodexbarUsageMonitor, SshUsageProbe, type UsageProbe } from "../usage/index.js";
import { buildManagedGenerationCostCapturer, type RealProviderCostCapturer } from "../costs/generationCostCapture.js";
import { credentialTypeForRef, providerSlugForRef } from "../credentials/credentialType.js";
import { DEFAULT_MANAGED_ENDPOINT } from "../config/managedProvider.js";
import type { AppendEvent } from "./subtaskLoop.js";
import type { PlannerRunAdapterContext, RunPlannerLoopInput } from "./plannerRun.js";

// The DISCRIMINATED outcome of the OpenRouter real-cost capturer resolution. A run
// routed THROUGH OpenRouter builds the `capturer` (it queries the per-call
// `usage.cost`); a run on any other credential has no OpenRouter metering surface at
// all — that capture has no analog there, so it is EXPLICITLY skipped (`skipped`),
// NOT a silent undefined and NEVER an empty ref pushed through the validator. The
// caller narrates the skip loudly (`cost.managed_metering_skipped`).
export type ManagedCapturerResolution =
  | { capturer: RealProviderCostCapturer }
  | { capturer: undefined; skipped: "byok_no_platform_metering_ref" };

/**
 * Does this run route codex THROUGH OpenRouter with an OpenRouter credential?
 *
 * This is the SAME predicate `credentials/codexMaterializer.ts` dispatches on when
 * it decides to write the `[model_providers.openrouter]` config.toml block: managed
 * mode, OR a BYOK `credential/openrouter/` api_key. Either way OpenRouter bills the
 * KEY'S OWNER, so OpenRouter's `total_cost` IS the real deduction and the per-call
 * capture applies. (Whether the tenant additionally attached upstream provider keys
 * INSIDE OpenRouter — OpenRouter-BYOK, where total_cost is only a routing fee — is
 * NOT knowable from here; `costs/openRouterCost.ts` now detects that from
 * OpenRouter's OWN `cost_details.upstream_inference_cost` rather than a
 * caller-declared flag.)
 */
export function routesThroughOpenRouter(input: RunPlannerLoopInput): boolean {
  if (input.context.endpointBaseUrl !== undefined) {
    return true;
  }
  const authRef = input.context.defaultLlm?.authRef ?? "";
  return credentialTypeForRef(authRef) === "api_key" && providerSlugForRef(authRef) === "openrouter";
}

// Resolves the OpenRouter real-cost capturer (or the explicit non-OpenRouter skip).
//
// FIXED (was: gated on `endpointBaseUrl !== undefined`): a tenant-supplied
// `credential/openrouter/` key IS a metering credential — OpenRouter bills that
// key's owner, so `/api/v1/generation`'s `total_cost` is the real deduction from the
// tenant's OpenRouter balance, queryable with the tenant's own key. Gating capture
// off "is this the platform endpoint" disabled real-spend capture for every BYOK
// OpenRouter deployment for no reason. A run on a NON-OpenRouter credential still
// returns the EXPLICIT `skipped` discriminant (there is genuinely no per-call dollar
// surface), rather than touching a platform ref that does not exist (the apex v30
// empty-ref class of crash).
export async function buildManagedCapturerForRun(input: RunPlannerLoopInput): Promise<ManagedCapturerResolution> {
  if (!routesThroughOpenRouter(input)) {
    return { capturer: undefined, skipped: "byok_no_platform_metering_ref" };
  }
  // A run routed through OpenRouter MUST carry a resolved default LLM authRef (the
  // OpenRouter credential ref). Missing it is a wiring bug — fail loud, never
  // quiet-degrade real-spend accounting to none.
  const credentialRef = input.context.defaultLlm?.authRef;
  if (credentialRef === undefined || credentialRef.trim() === "") {
    throw new Error("run routes through OpenRouter but has no resolved defaultLlm authRef — a wiring bug");
  }
  return {
    capturer: await buildManagedGenerationCostCapturer({
      secrets: input.secrets,
      managedCredentialRef: credentialRef,
      // A BYOK OpenRouter key with no explicit endpoint uses OpenRouter's own
      // default base URL — the SAME fallback codexMaterializer applies when it
      // writes that key's config.toml, so the cost query and the inference call
      // always address the same OpenRouter deployment.
      endpointBaseUrl: input.context.endpointBaseUrl ?? DEFAULT_MANAGED_ENDPOINT,
    }),
  };
}

// Resolve the run's per-call real-cost capturer AND narrate the skip. An
// OpenRouter-routed run returns the capturer; any other credential returns undefined
// AND emits the LOUD, intentional `cost.managed_metering_skipped` (no per-call
// dollar surface exists — explicit "no analog" branch, never an empty ref through
// the validator).
export async function resolveManagedCapturer(
  input: RunPlannerLoopInput,
  appendEvent: AppendEvent,
): Promise<RealProviderCostCapturer | undefined> {
  const resolution = await buildManagedCapturerForRun(input);
  if (resolution.capturer === undefined) {
    await appendEvent("cost.managed_metering_skipped", {
      providerMode: "byok",
      reason:
        "this run's credential is not an OpenRouter key, so the per-call real-cost query (OpenRouter's /api/v1/generation) has no analog and is skipped; real spend stays a metered FACT-or-NULL from the credential's own ledger (ccusage / credit drawdown)",
    });
  }
  return resolution.capturer;
}

// The default CODEX usage probe: the ccusage accountant + (subscription runs only)
// the codexbar window monitor over the run's shared CODEX_HOME. Built only when the
// run uses codex (gated by the caller) — provider/cli are codex-specific.
//
// The codexbar WINDOW monitor reads the codex ChatGPT-ACCOUNT subscription window,
// which only EXISTS when CODEX_HOME holds an account `auth.json` — i.e. when the
// credential is a `credential/codex/` ChatGPT bundle. Any api_key path (managed
// OpenRouter, BYOK OpenRouter, BYOK native OpenAI) has no account window, so
// codexbar exits nonzero by design ("codex account authentication required to read
// rate limits") and every preflight fires a SPURIOUS `usage.read_failed`.
//
// FIXED (was: gated on `endpointBaseUrl === undefined`): that flag treats a BYOK
// OpenRouter run — the common deployment, which has no endpoint override — as a
// subscription run, wiring codexbar against a CODEX_HOME that holds only an
// `openrouter.env` + `config.toml`. Gate on the credential actually being a ChatGPT
// bundle, which is what "has an account window" literally means. ccusage — the TOKEN
// accountant feeding notional cost — is ALWAYS wired: it reads the per-run
// CODEX_HOME session logs and works on every path.
export function defaultUsageProbe(input: RunPlannerLoopInput, ctx: PlannerRunAdapterContext): UsageProbe {
  const hasAccountWindow = credentialTypeForRef(input.context.defaultLlm?.authRef ?? "") === "codex_chatgpt_bundle";
  return new SshUsageProbe({
    ...(hasAccountWindow ? { monitor: new SshCodexbarUsageMonitor(input.ssh) } : {}),
    accountant: new SshCcusageAccountant(input.ssh),
    provider: "codex",
    cli: "codex",
    codexHome: ctx.codexHome,
    target: ctx.target,
    pressureThresholdPercent: input.pressureThresholdPercent,
  });
}
