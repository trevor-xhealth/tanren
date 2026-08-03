// The `codex exec` command builders (Writer + Answerer) and the per-run key
// env-sourcing / user-config flag helpers. Split out of codex.ts so the adapter
// file stays under the 500-line architecture cap; the materializer
// (codexMaterializer.ts) decides WHICH delivery applies and the adapter passes
// the resulting flags here.

import { quoteSshShellArg } from "../ssh/command.js";
import { codexManagedEnvPath } from "../credentials/codexMaterializer.js";
import { CODEX_REASONING_EFFORT, recordedCodexModel, resolveCodexDirectModel } from "./codexModel.js";

// Re-exported so codex.ts reaches the adapter's DECLARED model id (WriterAdapter
// .model → `cost_records.model`) through the same command-builder module it already
// imports, rather than taking a second dependency edge on codexModel.js.
export { recordedCodexModel };

export function buildCodexExecCommand(input: {
  codexHome: string;
  workspace: string;
  model?: string;
  managed?: boolean;
  nativeApiKeyEnvFile?: string;
}): string {
  return [
    ...codexKeyEnvPrefix(input.codexHome, input.managed, input.nativeApiKeyEnvFile),
    `CODEX_HOME=${quoteSshShellArg(input.codexHome)}`,
    "codex exec",
    "--sandbox workspace-write",
    "--json",
    // Pin the run default model + reasoning on the DIRECT paths (BYOK bundle / BYOK
    // native-OpenAI) via CLI flags — those paths write no config.toml. The OpenRouter
    // paths (managed OR BYOK key) carry the model in the per-run config.toml instead,
    // so this is empty there (see codexModelFlags).
    ...codexModelFlags(input.managed, input.model),
    // BYOK bundle / BYOK native-OpenAI: ignore any host-level codex config (no
    // config.toml is written). OpenRouter (managed OR BYOK key): we DELIBERATELY do
    // NOT pass --ignore-user-config so codex reads the per-run CODEX_HOME/config.toml
    // that declares the OpenRouter provider + selects it (the cookbook path).
    ...codexUserConfigFlag(input.managed),
    "--cd",
    quoteSshShellArg(input.workspace),
    "-",
  ].join(" ");
}

export function buildCodexAnswererExecCommand(input: {
  codexHome: string;
  workspace: string;
  schemaPath: string;
  outputPath: string;
  model?: string;
  managed?: boolean;
  nativeApiKeyEnvFile?: string;
}): string {
  return [
    ...codexKeyEnvPrefix(input.codexHome, input.managed, input.nativeApiKeyEnvFile),
    `CODEX_HOME=${quoteSshShellArg(input.codexHome)}`,
    "codex exec",
    "--sandbox read-only",
    "--json",
    // Same model/reasoning pin as the writer — CLI flags on the direct paths, the
    // config.toml on the OpenRouter paths (empty here for managed).
    ...codexModelFlags(input.managed, input.model),
    ...codexUserConfigFlag(input.managed),
    "--ignore-rules",
    "--skip-git-repo-check",
    "--cd",
    quoteSshShellArg(input.workspace),
    "--output-schema",
    quoteSshShellArg(input.schemaPath),
    "--output-last-message",
    quoteSshShellArg(input.outputPath),
    "-",
  ].join(" ");
}

// Sources the per-run key env file the materializer wrote (chmod 600) before
// invoking codex, so the key reaches codex via the env WITHOUT ever appearing in
// the command string. Two env-file shapes:
//   - OpenRouter (managed OR BYOK key) ⇒ OPENROUTER_API_KEY (codexManagedEnvPath),
//     the `env_key` the config.toml provider block names;
//   - BYOK native-OpenAI ⇒ OPENAI_API_KEY (nativeApiKeyEnvFile), no config.toml.
// BYOK bundle ⇒ no prefix (auth.json carries the credential).
function codexKeyEnvPrefix(codexHome: string, managed?: boolean, nativeApiKeyEnvFile?: string): string[] {
  if (managed === true) {
    return [`.`, quoteSshShellArg(codexManagedEnvPath(codexHome)), "&&"];
  }
  if (nativeApiKeyEnvFile !== undefined) {
    return [`.`, quoteSshShellArg(nativeApiKeyEnvFile), "&&"];
  }
  return [];
}

// OpenRouter (managed OR BYOK key) omits `--ignore-user-config` so
// CODEX_HOME/config.toml is honored; every other path (BYOK bundle / BYOK
// native-OpenAI) pins it. (UNVERIFIED LIVE — see the NOTE below.)
function codexUserConfigFlag(managed?: boolean): string[] {
  return managed === true ? [] : ["--ignore-user-config"];
}

// The model + reasoning-effort pin for the DIRECT codex paths (BYOK ChatGPT bundle
// / BYOK native-OpenAI key) — those paths write no config.toml, so the model
// (`-m gpt-5.6-luna`) and reasoning (`-c model_reasoning_effort="high"`) are passed
// as CLI flags. The OpenRouter paths (managed OR a BYOK OpenRouter key, `managed:
// true`) carry BOTH in the per-run config.toml the materializer writes — codex reads
// it because those runs DROP `--ignore-user-config` — so this returns nothing there
// (a bare `-m gpt-5.6-luna` would be the wrong, non-namespaced id for OpenRouter).
function codexModelFlags(managed?: boolean, model?: string): string[] {
  if (managed === true) {
    return [];
  }
  return [
    "-m",
    quoteSshShellArg(resolveCodexDirectModel(model)),
    "-c",
    quoteSshShellArg(`model_reasoning_effort="${CODEX_REASONING_EFFORT}"`),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTE (codex OpenRouter path — needs a LIVE codex verification before relying on
// it in production): OpenRouter's Codex-CLI cookbook configures codex via
// `config.toml` (`model_provider = "openrouter"` + `[model_providers.openrouter]`
// with `base_url` + `env_key="OPENROUTER_API_KEY"`). We materialize exactly that
// into the per-run CODEX_HOME and DROP `--ignore-user-config` for OpenRouter runs
// (managed OR a BYOK OpenRouter key) so codex reads it. It is UNVERIFIED whether
// `codex exec` (a) honors a CODEX_HOME `config.toml` written this way and (b)
// routes through OpenRouter end-to-end under these flags. The BYOK bundle path
// (auth.json + `--ignore-user-config`) is UNCHANGED and remains the proven one.
// The BYOK native-OpenAI path (OPENAI_API_KEY env + `--ignore-user-config`, no
// config.toml) is codex's documented native auth and is the lower-risk api_key
// path. Verify the OpenRouter codex path against a real key before depending on it.
// ─────────────────────────────────────────────────────────────────────────────
