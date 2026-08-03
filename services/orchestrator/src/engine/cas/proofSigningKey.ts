/**
 * SP-3 ProofSubstrate — the ed25519 signing-key resolution seam.
 *
 * The proof substrate is a PLATFORM signing identity (one signer, so any holder
 * of the public key can verify a bundle offline), NOT a per-run/per-org key. The
 * private key is resolved from the `SecretStore` at a well-known PLATFORM ref
 * (mirroring the `credential/<provider>/platform/...` shape of the managed
 * provider key). It is PKCS#8 PEM ed25519 material.
 *
 * FAIL-LOUD, NEVER FABRICATE: a missing key throws `ProofSigningKeyUnavailableError`
 * (naming the ops step) — the substrate NEVER signs with an empty/zero key and
 * NEVER returns a fabricated signature. Malformed or non-ed25519 material throws
 * `ProofSigningKeyMalformedError`. The key is durable (resolved from the store,
 * never auto-generated), so signatures stay verifiable across restarts.
 */

import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import type { SecretStore } from "../contracts/secretStore.js";
import { contentDigestOf } from "../contracts/cas.js";

/**
 * The well-known PLATFORM secret ref holding the ed25519 proof-signing private
 * key (PKCS#8 PEM). Bare, non-org path — this is a single platform identity.
 * Provision with the platform-credential seeder (see
 * `scripts/dev/seed-platform-creds.ts`) or the deployment's secret manager.
 */
export const PROOF_SIGNING_KEY_REF = "credential/proof-substrate/platform/ed25519-signing-key";

export class ProofSigningKeyUnavailableError extends Error {
  public override readonly name = "ProofSigningKeyUnavailableError";
  public constructor(ref: string) {
    super(
      `Proof-substrate signing key is not provisioned at "${ref}". ` +
        `Provision an ed25519 PKCS#8 PEM private key at this platform secret ref ` +
        `(e.g. via scripts/dev/seed-platform-creds.ts or the deployment secret manager) ` +
        `before sealing proof bundles. The substrate refuses to sign without it.`,
    );
  }
}

export class ProofSigningKeyMalformedError extends Error {
  public override readonly name = "ProofSigningKeyMalformedError";
  public constructor(ref: string, reason: string) {
    super(`Proof-substrate signing key at "${ref}" is malformed: ${reason}`);
  }
}

/** A resolved, validated ed25519 keypair plus its stable public-key fingerprint id. */
export interface ResolvedSigningKey {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** `ed25519:<hex>` fingerprint of the raw public key — a stable, non-invertible key id. */
  readonly signingKeyId: string;
}

/**
 * Derive a stable, non-invertible key id from the raw ed25519 public key bytes.
 * Deliberately a FINGERPRINT (sha256 of the SPKI-exported raw key), NOT the key
 * itself: a bundle's `signingKeyId` therefore cannot carry substitute key
 * material that `verify` would trust — trust is always rooted in the resolved
 * `SecretStore` key, and the id is only used to detect a key mismatch.
 */
export function deriveSigningKeyId(publicKey: KeyObject): string {
  const raw = publicKey.export({ type: "spki", format: "der" });
  return `ed25519:${contentDigestOf(new Uint8Array(raw)).slice("sha256:".length)}`;
}

/**
 * Parse + validate raw PKCS#8 PEM material as the platform ed25519 signing key.
 * Throws `ProofSigningKeyMalformedError` when unparseable or not ed25519 — the
 * SINGLE definition of "acceptable proof-signing material".
 *
 * Exported so a PROVISIONER (the platform-credential seeder,
 * `scripts/dev/seed-platform-creds.ts`) validates candidate material against the
 * exact same rule the substrate enforces at seal time, BEFORE writing it to the
 * secret store — an operator learns their key is unusable at provisioning time,
 * not at the first merge. This is validation only: nothing here generates key
 * material, so the substrate itself still NEVER auto-generates a key.
 */
export function loadEd25519SigningKey(pem: string, ref: string): ResolvedSigningKey {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch (error) {
    throw new ProofSigningKeyMalformedError(ref, error instanceof Error ? error.message : "unparseable private key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new ProofSigningKeyMalformedError(
      ref,
      `expected an ed25519 key, got ${privateKey.asymmetricKeyType ?? "unknown"}`,
    );
  }
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, signingKeyId: deriveSigningKeyId(publicKey) };
}

/**
 * Resolve + validate the platform ed25519 signing key from the store. Throws
 * `ProofSigningKeyUnavailableError` when absent (fail-loud, never sign-with-nothing)
 * and `ProofSigningKeyMalformedError` when the material is unparseable or not
 * ed25519.
 */
export async function resolveSigningKey(secrets: SecretStore, ref: string): Promise<ResolvedSigningKey> {
  const secret = await secrets.get(ref);
  if (secret === undefined || secret.value.trim() === "") {
    throw new ProofSigningKeyUnavailableError(ref);
  }
  return loadEd25519SigningKey(secret.value, ref);
}
