// NEGATIVE CONTROL for the proof-substrate signing key's PROVISIONING PATH.
//
// The substrate refuses to sign without a key at `PROOF_SIGNING_KEY_REF`, and its
// error tells the operator to provision it "via scripts/dev/seed-platform-creds.ts".
// These tests hold that instruction to account END-TO-END: they drive the REAL
// seeder against a REAL `SecretStore` and then the REAL `PgProofSubstrate` at the
// REAL well-known ref (never an injected test ref), and assert the substrate can
// actually SEAL and VERIFY a bundle afterwards.
//
// Non-vacuous by construction: the "unseeded" case proves the loud failure, and the
// "seeded" case proves the seeder is what removes it. Against a seeder that cannot
// provision the ref, the seeded cases FAIL with ProofSigningKeyUnavailableError.
//
// DB-free: `constructBundle` + `verify` touch no Postgres (only `ingestUnits` /
// `persistBundle` do), so the pool below is a never-consulted placeholder.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  PgProofSubstrate,
  PROOF_SIGNING_KEY_REF,
} from "../../services/orchestrator/src/engine/cas/pgProofSubstrate.js";
import { ProofSigningKeyUnavailableError } from "../../services/orchestrator/src/engine/cas/proofSigningKey.js";
import {
  contentDigestOf,
  type BundleBindings,
  type Digest,
  type ProofUnitRef,
} from "../../services/orchestrator/src/engine/contracts/cas.js";
import { InMemorySecretStore } from "../../services/orchestrator/src/engine/contracts/secretStore.js";
import { MANAGED_ROUTER_KEY_ENV, type SeededRef, seedPlatformCredentials } from "./seed-platform-creds.js";

const ORG = "org_proof_seed";
const PROJECT = "project_proof_seed";

/** The pool is never consulted by construct/seal/verify; connecting is a bug. */
class UnusedPool {
  public async connect(): Promise<never> {
    throw new Error("the proof-seal/verify path must not touch Postgres");
  }
}

function substrateAt(secrets: InMemorySecretStore): PgProofSubstrate {
  // No `signingKeyRef` override — this must read the SAME well-known platform ref
  // the seeder writes, or the test proves nothing about provisioning.
  return new PgProofSubstrate(new UnusedPool() as unknown as pg.Pool, secrets);
}

function members(): ProofUnitRef[] {
  return ["unit-a", "unit-b", "unit-c"].map((subject) => ({
    digest: contentDigestOf(new TextEncoder().encode(subject)),
    kind: "test",
    verdict: "passed" as const,
  }));
}

function bindings(): BundleBindings {
  return {
    integrationNodeId: "inode_seed",
    memberSetHash: `sha256:${"a".repeat(64)}`,
    preparedHeadSha: "head-sha",
    jjTreeId: `sha256:${"b".repeat(64)}`,
    artifactDigest: `sha256:${"c".repeat(64)}` as Digest,
    expectedMainSha: "main-sha",
    issuedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-01T01:00:00.000Z",
    nonce: "nonce-seed",
  };
}

/** Seed the platform refs with NO env-file on disk (hermetic) — the managed-router
 * key is supplied inline so its own fail-loud arm is not what we are testing. */
async function seed(secrets: InMemorySecretStore, env: Record<string, string> = {}): Promise<SeededRef[]> {
  return seedPlatformCredentials(secrets, { [MANAGED_ROUTER_KEY_ENV]: "sk-or-seed-test", ...env }, () => ({}));
}

describe("proof substrate × platform-cred seeder — the provisioning path", () => {
  it("WITHOUT seeding: sealing fails LOUD at the well-known ref (never a fabricated signature)", async () => {
    const substrate = substrateAt(new InMemorySecretStore());
    await expect(
      substrate.constructBundle({ orgId: ORG, projectId: PROJECT, members: members(), bindings: bindings() }),
    ).rejects.toThrow(ProofSigningKeyUnavailableError);
  });

  it("AFTER seeding: the substrate seals a bundle and verifies it VALID", async () => {
    const secrets = new InMemorySecretStore();
    const seeded = await seed(secrets);
    const proofRef = seeded.find((outcome) => outcome.ref === PROOF_SIGNING_KEY_REF);
    expect(proofRef?.action).toBe("generated");

    const substrate = substrateAt(secrets);
    const bundle = await substrate.constructBundle({
      orgId: ORG,
      projectId: PROJECT,
      members: members(),
      bindings: bindings(),
    });
    expect(bundle.signingKeyId).toMatch(/^ed25519:[0-9a-f]{64}$/u);
    // The seeder REPORTS the same key identity the bundle is sealed under, so an
    // operator can match a stack's provisioning log to a bundle's signingKeyId.
    expect(bundle.signingKeyId).toBe(proofRef?.signingKeyId);
    expect(bundle.rootSignature.byteLength).toBe(64);
    await expect(substrate.verify(bundle)).resolves.toStrictEqual({ valid: true });
  });

  it("IDEMPOTENT: re-seeding does not rotate the key — a bundle sealed earlier still verifies", async () => {
    const secrets = new InMemorySecretStore();
    await seed(secrets);
    const before = await secrets.get(PROOF_SIGNING_KEY_REF);

    const substrate = substrateAt(secrets);
    const bundle = await substrate.constructBundle({
      orgId: ORG,
      projectId: PROJECT,
      members: members(),
      bindings: bindings(),
    });

    const reseeded = await seed(secrets);
    expect(reseeded.find((outcome) => outcome.ref === PROOF_SIGNING_KEY_REF)?.action).toBe("preserved");
    expect((await secrets.get(PROOF_SIGNING_KEY_REF))?.value).toBe(before?.value);
    // The decisive assertion: signatures stay verifiable across re-seeds.
    await expect(substrate.verify(bundle)).resolves.toStrictEqual({ valid: true });
  });
});
