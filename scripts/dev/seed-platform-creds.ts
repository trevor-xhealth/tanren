// Hosting/boot seeder for PLATFORM-scoped secret-store refs.
//
// This is the deploy-layer's job, deliberately SEPARATE from the userland
// credential routes (`routes/credentials/index.ts`, which write only
// tenant-namespaced refs `credential/<kind>/org/<org>/...` and by design CANNOT
// write `platform/`-scoped refs). A platform/hosting credential — the SaaS
// managed-LLM router key every tenant routes THROUGH under
// `providerMode: managed` — is provisioned by the hosting layer, not by a
// tenant. Vault is the system's secret store; a fresh stack (`down-dev -v` wipes
// the dev Vault) leaves the platform ref UNSEEDED, and managed mode then
// HARD-FAILS at `resolveRawProviderKey` (correctly — no silent fallback). This
// seeder is the sanctioned, repeatable way to (re)seed those platform refs.
//
// What it seeds today — two platform-scoped refs, each with its OWN provisioning
// shape:
//   1. `managed-router-key` → `DEFAULT_MANAGED_CREDENTIAL_REF`
//      (`credential/openrouter/platform/default`): an EXTERNALLY-ISSUED secret.
//      Tanren cannot mint an OpenRouter key, so this ref is `required-env` — it
//      fails loud when no source yields it.
//   2. `proof-signing-key` → `PROOF_SIGNING_KEY_REF`
//      (`credential/proof-substrate/platform/ed25519-signing-key`): the proof
//      substrate's ed25519 seal identity. Nothing external issues it — it is
//      SELF-PROVISIONED here (generated locally as PKCS#8 PEM) unless an operator
//      supplies their own via `TANREN_PROOF_SIGNING_KEY`. Without it the substrate
//      refuses to seal (`ProofSigningKeyUnavailableError`) and every autonomous
//      merge loses its audit trail, so a stack that boots must have it.
//
// The signing key's own rules — generate-if-absent, NEVER rotate implicitly,
// validate with the substrate's own loader — live in
// `proofSigningKeyProvisioning.ts`; this file orchestrates the refs.
//
// PORTABILITY: every seed secret is resolved through a PORTABLE precedence
// (see `resolveSeedSecrets` below) — exported env > `TANREN_SECRET_ENV_FILE` >
// the plaintext-local `.env.validation.local`. Tanren stays agnostic to WHO
// produces the env-file (sops / 1Password / Vault-agent / …); it only reads a
// fixed ALLOWLIST of known keys from whatever file is pointed at, never blindly
// exporting arbitrary vars. There is NO dependency on Nix, sops, or any
// machine-specific path.
//
// Contract:
//   - Resolves each ref's value via the portable precedence above.
//   - FAIL-LOUD if a `required-env` ref resolves from no source — a typed
//     `MissingSeedSecretError` naming all three sources tried (no silent skip).
//   - FAIL-LOUD on unusable key material — candidate ed25519 material is validated
//     with the SUBSTRATE's own loader BEFORE any write, so a bad key is rejected at
//     provisioning time rather than at the first seal.
//   - Writes ONLY platform-scoped refs (never a tenant route).
//   - Idempotent: re-running re-seeds `required-env` refs to the same value and
//     leaves an existing signing key untouched.
//   - Never logs the secret VALUE — only the ref, the action, and (for a signing
//     key) the non-invertible `ed25519:<sha256-of-public-key>` fingerprint that
//     already appears in every sealed bundle.
//
// Invoked via `just seed-platform-creds` (and folded into `just up-dev`). An
// optional list of ref NAMES (`managed-router-key`, `proof-signing-key`) narrows
// the run to a subset; no names seeds them all.

import { readFileSync } from "node:fs";

import {
  buildSecretStore,
  type SecretStoreEnv,
} from "../../services/orchestrator/src/engine/contracts/secretStoreFactory.js";
import { DEFAULT_MANAGED_CREDENTIAL_REF } from "../../services/orchestrator/src/engine/config/managedProvider.js";
import { PROOF_SIGNING_KEY_REF } from "../../services/orchestrator/src/engine/cas/proofSigningKey.js";
import type { SecretStore } from "../../services/orchestrator/src/engine/contracts/secretStore.js";
import {
  PROOF_SIGNING_KEY_ENV,
  provisionProofSigningKey,
  type SigningKeyAction,
} from "./proofSigningKeyProvisioning.js";

/** The env var the managed-router key is read from (matches the manifest). */
export const MANAGED_ROUTER_KEY_ENV = "TANREN_E2E_MANAGED_ROUTER_KEY";

/** Env var naming a secure env-file (rendered by ANY secret manager) to source
 * seed secrets from when they are not already exported. Tanren is agnostic to
 * the producer — it only reads a fixed allowlist of known keys from the file. */
export const SECRET_ENV_FILE_ENV = "TANREN_SECRET_ENV_FILE";

/** Default plaintext-local fallback env-file (0600, `~/.config/tanren/secrets/`
 * symlinked into cwd by `just secrets-link`). Backwards-compatible source of
 * last resort — used only when neither exported env nor an env-file provides
 * the key. */
export const LOCAL_FALLBACK_ENV_FILE = ".env.validation.local";

/**
 * The FIXED ALLOWLIST of secret keys this seeder may load from an external
 * env-file (`TANREN_SECRET_ENV_FILE` or the local fallback). Only these keys are
 * ever read out of a file into the process; every other key in the file is
 * IGNORED — the seeder never blindly exports arbitrary vars from a file it is
 * pointed at. Add a key here only if a new platform ref legitimately needs it.
 */
export const SEED_SECRET_ALLOWLIST: readonly string[] = [MANAGED_ROUTER_KEY_ENV, PROOF_SIGNING_KEY_ENV];

/**
 * How a ref's value comes to exist:
 *   - `required-env`: only an EXTERNAL issuer can mint it; absent from every
 *     source is a hard failure.
 *   - `ed25519-signing-key`: Tanren can mint it. An operator-supplied value still
 *     wins; otherwise an existing ref is PRESERVED and an empty one is generated.
 */
type PlatformRefProvisioning = "required-env" | "ed25519-signing-key";

/** One platform-scoped ref to seed: a stable CLI `name`, the secret-store ref,
 * the env var its value is read from, and its provisioning shape. Add a sibling
 * here only for ANOTHER platform-scoped ref (never a tenant cred — those stay on
 * the operator credential API). Any env key referenced here must also be in
 * `SEED_SECRET_ALLOWLIST`. */
interface PlatformRefSpec {
  name: string;
  ref: string;
  env: string;
  description: string;
  provisioning: PlatformRefProvisioning;
}

const PLATFORM_REFS: readonly PlatformRefSpec[] = [
  {
    name: "managed-router-key",
    ref: DEFAULT_MANAGED_CREDENTIAL_REF,
    env: MANAGED_ROUTER_KEY_ENV,
    description: "managed-LLM platform router key (providerMode: managed)",
    provisioning: "required-env",
  },
  {
    name: "proof-signing-key",
    ref: PROOF_SIGNING_KEY_REF,
    env: PROOF_SIGNING_KEY_ENV,
    description: "proof-substrate ed25519 seal identity (PKCS#8 PEM)",
    provisioning: "ed25519-signing-key",
  },
];

/** What the seeder did to one ref. `preserved` means NOTHING was written — the
 * existing value was kept (the no-silent-rotation guarantee). */
export type SeedAction = SigningKeyAction;

/** Per-ref outcome. Carries NO secret value; `signingKeyId` is the same
 * non-invertible public-key fingerprint that appears in sealed bundles. */
export interface SeededRef {
  readonly ref: string;
  readonly action: SeedAction;
  readonly signingKeyId?: string;
}

/** A ref NAME passed on the command line that no spec declares. */
export class UnknownPlatformRefError extends Error {
  constructor(name: string, known: readonly string[]) {
    super(
      `seed-platform-creds: unknown platform ref "${name}" — known refs: ${known.join(", ")}. ` +
        `Pass no names to seed them all.`,
    );
    this.name = "UnknownPlatformRefError";
  }
}

/** Typed, loud error for the "no source yielded a key" case — names every
 * source tried so an operator knows exactly where to put the key. */
export class MissingSeedSecretError extends Error {
  readonly key: string;
  constructor(key: string, envFilePath: string | undefined) {
    const sources = [
      `exported env ($${key})`,
      envFilePath === undefined
        ? `$${SECRET_ENV_FILE_ENV} (unset — point it at a secure env-file to use)`
        : `$${SECRET_ENV_FILE_ENV}=${envFilePath}`,
      `${LOCAL_FALLBACK_ENV_FILE} (plaintext-local fallback)`,
    ];
    super(
      `seed-platform-creds: could not resolve ${key} from any source — refusing to seed a platform credential to an empty value. ` +
        `Tried, in precedence order: ${sources.join(" -> ")}. ` +
        `Set the key in one of these (export it, point ${SECRET_ENV_FILE_ENV} at a secure env-file produced by any secret manager, or place it in ${LOCAL_FALLBACK_ENV_FILE}) and re-run.`,
    );
    this.name = "MissingSeedSecretError";
    this.key = key;
  }
}

/**
 * Parse a dotenv-style file, returning ONLY the allowlisted keys with non-blank
 * values. Defensive by design:
 *   - skips blank lines and `#` comments;
 *   - handles `KEY=value`, `export KEY=value`, and surrounding whitespace;
 *   - strips a single matched pair of surrounding single OR double quotes;
 *   - IGNORES any key not in `allowlist` (never exports arbitrary vars);
 *   - single-line values only (matches Tanren's .env files);
 *   - a missing/unreadable file yields an empty map (caller falls through).
 * Never throws on a malformed line — a malformed line is skipped, not fatal.
 */
export function parseAllowlistedEnvFile(path: string, allowlist: readonly string[]): Record<string, string> {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return {};
  }
  const allow = new Set(allowlist);
  const out: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    // Strip an optional leading `export ` (dotenv files sometimes carry it).
    const line = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    // ALLOWLIST gate — ignore any key not on the allowlist.
    if (!allow.has(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // A blank value is treated as unset (not an empty-string key).
    if (value.trim() === "") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Resolve every allowlisted seed secret through the PORTABLE precedence:
 *   1. already exported in `env` (non-blank) → highest precedence;
 *   2. else `TANREN_SECRET_ENV_FILE=<path>` → load the allowlisted keys from it;
 *   3. else the plaintext-local `.env.validation.local` fallback.
 * Returns only keys that resolved to a non-blank value. Reads NOTHING outside
 * the allowlist from any file. Pure w.r.t. `process.env` — never mutates it.
 *
 * `readFile` is injectable for tests; defaults to the real allowlisted parser.
 */
export function resolveSeedSecrets(
  env: SecretStoreEnv,
  allowlist: readonly string[] = SEED_SECRET_ALLOWLIST,
  readFile: (path: string, allow: readonly string[]) => Record<string, string> = parseAllowlistedEnvFile,
): Record<string, string> {
  const resolved: Record<string, string> = {};

  // 2 + 3: gather file-sourced values (env-file wins over local fallback).
  const local = readFile(LOCAL_FALLBACK_ENV_FILE, allowlist);
  const envFilePath = typeof env[SECRET_ENV_FILE_ENV] === "string" ? env[SECRET_ENV_FILE_ENV]!.trim() : "";
  const fromEnvFile: Record<string, string> = envFilePath === "" ? {} : readFile(envFilePath, allowlist);

  for (const key of allowlist) {
    // 1: exported env wins outright.
    const exported = env[key];
    if (typeof exported === "string" && exported.trim() !== "") {
      resolved[key] = exported.trim();
      continue;
    }
    // 2: env-file next.
    const fileValue = fromEnvFile[key];
    if (fileValue !== undefined && fileValue.trim() !== "") {
      resolved[key] = fileValue.trim();
      continue;
    }
    // 3: plaintext-local fallback.
    const localValue = local[key];
    if (localValue !== undefined && localValue.trim() !== "") {
      resolved[key] = localValue.trim();
    }
  }
  return resolved;
}

/** Narrow `PLATFORM_REFS` to the named subset (all of them when `names` is
 * empty). An unknown name is fatal — a typo must never silently seed nothing. */
function selectPlatformRefs(names: readonly string[]): readonly PlatformRefSpec[] {
  if (names.length === 0) return PLATFORM_REFS;
  return names.map((name) => {
    const spec = PLATFORM_REFS.find((candidate) => candidate.name === name);
    if (spec === undefined) {
      throw new UnknownPlatformRefError(
        name,
        PLATFORM_REFS.map((candidate) => candidate.name),
      );
    }
    return spec;
  });
}

/** A decided write, computed BEFORE anything is stored. */
interface PlannedRef extends SeededRef {
  readonly spec: PlatformRefSpec;
  readonly value: string;
}

/**
 * Seed the selected platform-scoped refs into the configured SecretStore. Every
 * ref's value is DECIDED first (resolution + validation) so a missing or unusable
 * value fails BEFORE any write — a partial env never leaves the platform
 * half-seeded. Idempotent: `required-env` refs upsert the same value, and an
 * already-provisioned signing key is preserved untouched. Returns the per-ref
 * outcomes (never the values) for the caller to report.
 */
export async function seedPlatformCredentials(
  secrets: SecretStore,
  env: SecretStoreEnv = process.env,
  readFile: (path: string, allow: readonly string[]) => Record<string, string> = parseAllowlistedEnvFile,
  refNames: readonly string[] = [],
): Promise<SeededRef[]> {
  const secretsMap = resolveSeedSecrets(env, SEED_SECRET_ALLOWLIST, readFile);
  const envFilePathRaw = env[SECRET_ENV_FILE_ENV];
  const envFilePath =
    typeof envFilePathRaw === "string" && envFilePathRaw.trim() !== "" ? envFilePathRaw.trim() : undefined;

  const planned: PlannedRef[] = [];
  for (const spec of selectPlatformRefs(refNames)) {
    const supplied = secretsMap[spec.env];
    if (spec.provisioning === "ed25519-signing-key") {
      const key = await provisionProofSigningKey({ ref: spec.ref, supplied, secrets, env });
      planned.push({ spec, ref: spec.ref, ...key });
      continue;
    }
    if (supplied === undefined) {
      throw new MissingSeedSecretError(spec.env, envFilePath);
    }
    planned.push({ spec, value: supplied, action: "written", ref: spec.ref });
  }

  const outcomes: SeededRef[] = [];
  for (const plan of planned) {
    if (plan.action !== "preserved") {
      await secrets.put({ ref: plan.ref, value: plan.value });
    }
    outcomes.push(
      plan.signingKeyId === undefined
        ? { ref: plan.ref, action: plan.action }
        : { ref: plan.ref, action: plan.action, signingKeyId: plan.signingKeyId },
    );
  }
  return outcomes;
}

/** Render one outcome for the console. Refs, actions, and the public-key
 * FINGERPRINT only — never a secret value. */
export function describeSeededRef(outcome: SeededRef): string {
  const fingerprint = outcome.signingKeyId === undefined ? "" : ` [${outcome.signingKeyId}]`;
  switch (outcome.action) {
    case "generated":
      return `seed-platform-creds: generated a new key for platform ref ${outcome.ref}${fingerprint}`;
    case "preserved":
      return `seed-platform-creds: platform ref ${outcome.ref} already provisioned — left unchanged${fingerprint}`;
    default:
      return `seed-platform-creds: seeded platform ref ${outcome.ref}${fingerprint}`;
  }
}

async function main(): Promise<void> {
  const secrets = buildSecretStore(process.env);
  // Positional args narrow the run to named refs (`proof-signing-key`, …).
  const refNames = process.argv.slice(2).filter((arg) => arg.trim() !== "");
  const outcomes = await seedPlatformCredentials(secrets, process.env, parseAllowlistedEnvFile, refNames);
  for (const outcome of outcomes) {
    console.log(describeSeededRef(outcome));
  }
  console.log(`seed-platform-creds: done (${outcomes.length} platform ref(s))`);
}

// Run as a script (not when imported by a test). `import.meta.url` ends with this
// file's path when invoked directly via tsx.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
