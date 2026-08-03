// PROVISIONING for the proof-substrate signing key — the one platform secret
// Tanren can MINT rather than receive from an external issuer.
//
// Split out of `seed-platform-creds.ts` (which orchestrates ALL platform refs)
// because this ref alone carries key-material rules: generate-if-absent,
// never-rotate-implicitly, and validate-with-the-substrate's-own-loader.
//
// SELF-PROVISIONING IS NOT AUTO-GENERATION AT USE. `PgProofSubstrate` never mints
// a key — it resolves one from the `SecretStore` or fails loud. Generation happens
// ONLY here, in an explicit operator-run provisioning step, and only when the ref
// is empty. That keeps signatures durable: a restarted stack re-resolves the SAME
// key, so bundles sealed yesterday still verify today.

import { generateKeyPairSync } from "node:crypto";

import { loadEd25519SigningKey } from "../../services/orchestrator/src/engine/cas/proofSigningKey.js";
import type { SecretStore } from "../../services/orchestrator/src/engine/contracts/secretStore.js";
import type { SecretStoreEnv } from "../../services/orchestrator/src/engine/contracts/secretStoreFactory.js";

/**
 * OPTIONAL override for the proof-substrate signing key: an ed25519 PKCS#8 PEM
 * private key. Supply it to carry ONE platform identity across stacks (or to
 * inject a key your own secret manager issued); leave it unset and the seeder
 * generates a key the first time and preserves it thereafter.
 *
 * A dotenv file cannot hold the PEM's real newlines, so a `\n`-escaped single-line
 * value is accepted too (see `normalizeSigningKeyPem`).
 */
export const PROOF_SIGNING_KEY_ENV = "TANREN_PROOF_SIGNING_KEY";

/**
 * EXPLICIT opt-in to rotating the proof signing key. Rotation is destructive to
 * the audit trail — bundles sealed under the previous key stop verifying — so it
 * never happens implicitly. Accepts `1`/`true` (case-insensitive); any other
 * non-blank value is a hard error rather than a silently-ignored typo.
 */
export const PROOF_SIGNING_KEY_ROTATE_ENV = "TANREN_PROOF_SIGNING_KEY_ROTATE";

/** What provisioning did. `preserved` means NOTHING was written — the existing
 * value was kept (the no-silent-rotation guarantee). */
export type SigningKeyAction = "written" | "generated" | "preserved";

/** A decided key, computed BEFORE anything is stored. `signingKeyId` is the same
 * non-invertible public-key fingerprint that appears in every sealed bundle. */
export interface ProvisionedSigningKey {
  readonly value: string;
  readonly action: SigningKeyAction;
  readonly signingKeyId: string;
}

/**
 * An already-provisioned signing key that no longer parses. Regenerating it
 * silently would be an undisclosed rotation, so this is fatal and names the
 * explicit opt-in that resolves it.
 */
export class UnusableExistingSigningKeyError extends Error {
  constructor(ref: string, cause: unknown) {
    super(
      `seed-platform-creds: the value already stored at ${ref} is not usable ed25519 material ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). ` +
        `Refusing to overwrite it implicitly — that would silently rotate the proof-signing identity and ` +
        `invalidate verification of every bundle sealed under it. Re-run with ${PROOF_SIGNING_KEY_ROTATE_ENV}=1 ` +
        `to replace it deliberately, or set ${PROOF_SIGNING_KEY_ENV} to the intended key.`,
      { cause },
    );
    this.name = "UnusableExistingSigningKeyError";
  }
}

/** Mint a fresh ed25519 private key as PKCS#8 PEM — the exact shape
 * `resolveSigningKey` expects. Local and offline: no issuer, no network. */
export function generateEd25519SigningKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

/** A dotenv line cannot carry the PEM's real newlines, so an operator staging the
 * key in an env-file writes `\n` escapes. Restore them; a value that already has
 * real newlines (the normal exported-env case) passes through untouched. */
export function normalizeSigningKeyPem(raw: string): string {
  return raw.includes("\\n") ? raw.replaceAll("\\n", "\n") : raw;
}

/** Read an explicit boolean opt-in. Unset/blank is `false`; anything that is not
 * a recognized true/false token is a hard error, never a silently-ignored typo
 * on a destructive knob. */
export function readExplicitFlag(env: SecretStoreEnv, name: string): boolean {
  const raw = env[name];
  if (typeof raw !== "string" || raw.trim() === "") return false;
  const token = raw.trim().toLowerCase();
  if (token === "1" || token === "true") return true;
  if (token === "0" || token === "false") return false;
  throw new Error(`seed-platform-creds: ${name}="${raw}" is not a boolean — use 1/true or 0/false.`);
}

/**
 * Decide the ed25519 signing key WITHOUT writing anything: operator-supplied
 * material wins, else an already-provisioned key is PRESERVED, else a new key is
 * generated. Every branch validates through `loadEd25519SigningKey` — the
 * SUBSTRATE's own loader — so nothing that would fail at seal time can reach the
 * store, and the caller learns the resulting `signingKeyId` up front.
 */
export async function provisionProofSigningKey(input: {
  readonly ref: string;
  readonly supplied: string | undefined;
  readonly secrets: SecretStore;
  readonly env: SecretStoreEnv;
}): Promise<ProvisionedSigningKey> {
  const { ref, supplied, secrets, env } = input;
  if (supplied !== undefined) {
    const value = normalizeSigningKeyPem(supplied);
    return { value, action: "written", signingKeyId: loadEd25519SigningKey(value, ref).signingKeyId };
  }
  if (!readExplicitFlag(env, PROOF_SIGNING_KEY_ROTATE_ENV)) {
    const existing = await secrets.get(ref);
    if (existing !== undefined && existing.value.trim() !== "") {
      let signingKeyId: string;
      try {
        ({ signingKeyId } = loadEd25519SigningKey(existing.value, ref));
      } catch (error) {
        throw new UnusableExistingSigningKeyError(ref, error);
      }
      // No write at all — the durable key stays byte-for-byte as it was.
      return { value: existing.value, action: "preserved", signingKeyId };
    }
  }
  const value = generateEd25519SigningKeyPem();
  return { value, action: "generated", signingKeyId: loadEd25519SigningKey(value, ref).signingKeyId };
}
