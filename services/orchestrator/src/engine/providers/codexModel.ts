// The default model + reasoning-effort Tanren pins for every codex run
// (writer / planner / answerer path). Shared by the exec command builder
// (codexExecCommand.ts — the CLI-flag paths) and the OpenRouter config.toml
// generator (codexMaterializer.ts) so the pin lives in ONE place.
//
// Two model-id forms, one per credential path:
//   - OpenRouter (managed OR a BYOK OpenRouter key) routes THROUGH OpenRouter, so
//     the id must be the OpenRouter-namespaced form (`openai/gpt-5.6-luna`). It is
//     carried in the per-run config.toml (`model = …`).
//   - Direct codex (BYOK ChatGPT bundle OR BYOK native OpenAI key) talks to OpenAI
//     directly, so the id is the bare form (`gpt-5.6-luna`), passed as the
//     `codex exec -m` flag (there is no config.toml on those paths).
// Reasoning effort is `high` on every path (config.toml `model_reasoning_effort`
// for the OpenRouter path; `-c model_reasoning_effort="high"` for the direct path).

import { credentialTypeForRef, providerSlugForRef } from "../credentials/credentialType.js";

// The bare model id for codex's native/direct paths (BYOK bundle + BYOK OpenAI).
export const CODEX_DEFAULT_MODEL = "gpt-5.6-luna";

// The OpenRouter-namespaced model id for the config.toml OpenRouter paths
// (managed + BYOK OpenRouter). ~5× cheaper than 5.5 at parity — the run default.
export const CODEX_OPENROUTER_MODEL = "openai/gpt-5.6-luna";

// The reasoning effort every codex run uses (config.toml key + `-c` override value).
export const CODEX_REASONING_EFFORT = "high";

// A routing-chain model overrides the pinned run default. The direct and
// OpenRouter paths deliberately retain distinct defaults because their model
// namespaces differ, but an explicitly selected model is passed through as-is.
export function resolveCodexDirectModel(model?: string): string {
  return model ?? CODEX_DEFAULT_MODEL;
}

export function resolveCodexOpenRouterModel(model?: string): string {
  return model ?? CODEX_OPENROUTER_MODEL;
}

// The model id a codex adapter will ACTUALLY request — the value the cost recorder
// writes to `cost_records.model` and the notional price source looks up. It must be
// the same string the exec path pins, and the two namespaces differ (see above), so
// this mirrors `codexMaterializer`'s own OpenRouter-vs-direct dispatch: an explicit
// managed endpoint OR a BYOK `credential/openrouter/` api_key routes through
// OpenRouter (config.toml, namespaced id); everything else is direct (bare id).
export function recordedCodexModel(input: { credentialRef: string; endpointBaseUrl?: string; model?: string }): string {
  const routesThroughOpenRouter =
    input.endpointBaseUrl !== undefined ||
    (credentialTypeForRef(input.credentialRef) === "api_key" &&
      providerSlugForRef(input.credentialRef) === "openrouter");
  return routesThroughOpenRouter ? resolveCodexOpenRouterModel(input.model) : resolveCodexDirectModel(input.model);
}
