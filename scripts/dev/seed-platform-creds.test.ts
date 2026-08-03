import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemorySecretStore } from "../../services/orchestrator/src/engine/contracts/secretStore.js";
import { DEFAULT_MANAGED_CREDENTIAL_REF } from "../../services/orchestrator/src/engine/config/managedProvider.js";
import { PROOF_SIGNING_KEY_REF } from "../../services/orchestrator/src/engine/cas/proofSigningKey.js";
import {
  generateEd25519SigningKeyPem,
  PROOF_SIGNING_KEY_ENV,
  PROOF_SIGNING_KEY_ROTATE_ENV,
  UnusableExistingSigningKeyError,
} from "./proofSigningKeyProvisioning.js";
import {
  describeSeededRef,
  LOCAL_FALLBACK_ENV_FILE,
  MANAGED_ROUTER_KEY_ENV,
  MissingSeedSecretError,
  parseAllowlistedEnvFile,
  resolveSeedSecrets,
  SECRET_ENV_FILE_ENV,
  SEED_SECRET_ALLOWLIST,
  seedPlatformCredentials,
  UnknownPlatformRefError,
} from "./seed-platform-creds.js";

/** Seed with an empty env-file reader so no operator-local `.env.validation.local`
 * in the checkout can influence a test. */
const noEnvFiles = (): Record<string, string> => ({});

describe("seedPlatformCredentials", () => {
  it("writes the managed-router key to the platform ref from the env var", async () => {
    const store = new InMemorySecretStore();
    const written = await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "sk-or-test-123" }, noEnvFiles);

    expect(written.map((outcome) => outcome.ref)).toContain(DEFAULT_MANAGED_CREDENTIAL_REF);
    const stored = await store.get(DEFAULT_MANAGED_CREDENTIAL_REF);
    expect(stored?.value).toBe("sk-or-test-123");
  });

  it("is platform-scoped — never writes a tenant-namespaced credential ref", async () => {
    const store = new InMemorySecretStore();
    await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "sk-or-test-123" }, noEnvFiles);

    // Both platform refs live under `credential/<...>/platform/...`, NOT the
    // tenant `credential/<kind>/org/...` shape the operator API derives.
    const refs = await store.list("credential/");
    expect([...refs].sort()).toStrictEqual([DEFAULT_MANAGED_CREDENTIAL_REF, PROOF_SIGNING_KEY_REF].sort());
    expect(refs.every((ref) => !ref.includes("/org/") && !ref.includes("/me/"))).toBe(true);
  });

  it("is idempotent: re-seeding upserts the same ref with the new value", async () => {
    const store = new InMemorySecretStore();
    await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "sk-or-old" }, noEnvFiles);
    await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "sk-or-new" }, noEnvFiles);

    const refs = await store.list("credential/");
    expect([...refs].sort()).toStrictEqual([DEFAULT_MANAGED_CREDENTIAL_REF, PROOF_SIGNING_KEY_REF].sort());
    const stored = await store.get(DEFAULT_MANAGED_CREDENTIAL_REF);
    expect(stored?.value).toBe("sk-or-new");
  });

  it("FAILS LOUD (typed MissingSeedSecretError) when no source yields a key — no silent skip", async () => {
    const store = new InMemorySecretStore();
    // The injected reader keeps this no-source proof independent of an operator's
    // local fallback file in the checkout.
    await expect(seedPlatformCredentials(store, {}, () => ({}))).rejects.toThrow(MissingSeedSecretError);
  });

  it("FAILS LOUD when the key env var is blank/whitespace, and writes nothing", async () => {
    const store = new InMemorySecretStore();
    await expect(seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "   " }, () => ({}))).rejects.toThrow(
      MissingSeedSecretError,
    );
    // Fail-before-write: a blank value must not leave a half-seeded platform ref.
    expect(await store.list("credential/")).toStrictEqual([]);
  });

  it("trims surrounding whitespace from the seeded key", async () => {
    const store = new InMemorySecretStore();
    await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "  sk-or-padded\n" }, noEnvFiles);
    const stored = await store.get(DEFAULT_MANAGED_CREDENTIAL_REF);
    expect(stored?.value).toBe("sk-or-padded");
  });
});

// The proof-substrate signing key is the one ref Tanren can MINT itself; these
// pin its provisioning rules. That it actually makes the substrate seal + verify
// is proven separately, against the real substrate, in
// `seed-platform-creds.proof-substrate.test.ts`.
describe("seedPlatformCredentials — the self-provisioned proof signing key", () => {
  const routerEnv = { [MANAGED_ROUTER_KEY_ENV]: "sk-or-test-123" };

  it("generates ed25519 PKCS#8 PEM material when the ref is empty", async () => {
    const store = new InMemorySecretStore();
    const outcomes = await seedPlatformCredentials(store, routerEnv, noEnvFiles);

    const proof = outcomes.find((outcome) => outcome.ref === PROOF_SIGNING_KEY_REF);
    expect(proof?.action).toBe("generated");
    expect(proof?.signingKeyId).toMatch(/^ed25519:[0-9a-f]{64}$/u);
    expect((await store.get(PROOF_SIGNING_KEY_REF))?.value).toContain("BEGIN PRIVATE KEY");
  });

  it("PRESERVES an existing key on re-run — no silent rotation, and no write at all", async () => {
    const store = new InMemorySecretStore();
    await seedPlatformCredentials(store, routerEnv, noEnvFiles);
    const first = (await store.get(PROOF_SIGNING_KEY_REF))?.value;

    const again = await seedPlatformCredentials(store, routerEnv, noEnvFiles);
    expect(again.find((outcome) => outcome.ref === PROOF_SIGNING_KEY_REF)?.action).toBe("preserved");
    expect((await store.get(PROOF_SIGNING_KEY_REF))?.value).toBe(first);
  });

  it("rotates ONLY on the explicit opt-in flag", async () => {
    const store = new InMemorySecretStore();
    await seedPlatformCredentials(store, routerEnv, noEnvFiles);
    const first = (await store.get(PROOF_SIGNING_KEY_REF))?.value;

    const rotated = await seedPlatformCredentials(
      store,
      { ...routerEnv, [PROOF_SIGNING_KEY_ROTATE_ENV]: "1" },
      noEnvFiles,
    );
    expect(rotated.find((outcome) => outcome.ref === PROOF_SIGNING_KEY_REF)?.action).toBe("generated");
    expect((await store.get(PROOF_SIGNING_KEY_REF))?.value).not.toBe(first);
  });

  it("FAILS LOUD on a non-boolean rotate flag rather than ignoring a typo", async () => {
    const store = new InMemorySecretStore();
    await expect(
      seedPlatformCredentials(store, { ...routerEnv, [PROOF_SIGNING_KEY_ROTATE_ENV]: "yes-please" }, noEnvFiles),
    ).rejects.toThrow(/is not a boolean/u);
  });

  it("accepts operator-supplied PEM, including the `\\n`-escaped dotenv form", async () => {
    const pem = generateEd25519SigningKeyPem();
    const store = new InMemorySecretStore();
    await seedPlatformCredentials(
      store,
      { ...routerEnv, [PROOF_SIGNING_KEY_ENV]: pem.trim().replaceAll("\n", "\\n") },
      noEnvFiles,
    );
    expect((await store.get(PROOF_SIGNING_KEY_REF))?.value).toBe(pem.trim());
  });

  it("REJECTS non-ed25519 / unparseable supplied material BEFORE writing anything", async () => {
    const store = new InMemorySecretStore();
    await expect(
      seedPlatformCredentials(store, { ...routerEnv, [PROOF_SIGNING_KEY_ENV]: "not-a-pem" }, noEnvFiles),
    ).rejects.toThrow(/malformed/u);
    expect(await store.list("credential/")).toStrictEqual([]);
  });

  it("refuses to implicitly overwrite an already-stored value that is not usable key material", async () => {
    const store = new InMemorySecretStore();
    await store.put({ ref: PROOF_SIGNING_KEY_REF, value: "garbage-from-a-bad-provisioner" });
    await expect(seedPlatformCredentials(store, routerEnv, noEnvFiles)).rejects.toThrow(
      UnusableExistingSigningKeyError,
    );
    expect((await store.get(PROOF_SIGNING_KEY_REF))?.value).toBe("garbage-from-a-bad-provisioner");
  });
});

describe("seedPlatformCredentials — ref selection", () => {
  it("seeds ONLY the named ref, so a stack with no router key still gets its signing key", async () => {
    const store = new InMemorySecretStore();
    // No managed-router key in ANY source — the full run would fail loud, but the
    // self-provisioned subset must still come up.
    const outcomes = await seedPlatformCredentials(store, {}, noEnvFiles, ["proof-signing-key"]);
    expect(outcomes.map((outcome) => outcome.ref)).toStrictEqual([PROOF_SIGNING_KEY_REF]);
    expect(await store.list("credential/")).toStrictEqual([PROOF_SIGNING_KEY_REF]);
  });

  it("FAILS LOUD on an unknown ref name rather than silently seeding nothing", async () => {
    const store = new InMemorySecretStore();
    await expect(seedPlatformCredentials(store, {}, noEnvFiles, ["typo-key"])).rejects.toThrow(UnknownPlatformRefError);
    expect(await store.list("credential/")).toStrictEqual([]);
  });
});

// A tmp workspace holding env-files under our control, so file-precedence tests
// never depend on a real `.env.validation.local` in the repo checkout.
describe("resolveSeedSecrets — portable precedence + allowlist", () => {
  let dir: string;
  let envFilePath: string;
  let localFallbackPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seed-creds-"));
    envFilePath = join(dir, "external.env");
    localFallbackPath = join(dir, LOCAL_FALLBACK_ENV_FILE);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Injectable readFile that reads the local fallback from our tmp dir path
  // instead of cwd, so the test is hermetic.
  const readFile = (path: string, allow: readonly string[]): Record<string, string> => {
    const resolved = path === LOCAL_FALLBACK_ENV_FILE ? localFallbackPath : path;
    return parseAllowlistedEnvFile(resolved, allow);
  };

  it("exported env WINS over env-file WINS over local fallback (all three set)", () => {
    writeFileSync(envFilePath, `${MANAGED_ROUTER_KEY_ENV}=from-env-file\n`);
    writeFileSync(localFallbackPath, `${MANAGED_ROUTER_KEY_ENV}=from-local\n`);
    const resolved = resolveSeedSecrets(
      { [MANAGED_ROUTER_KEY_ENV]: "from-exported", [SECRET_ENV_FILE_ENV]: envFilePath },
      SEED_SECRET_ALLOWLIST,
      readFile,
    );
    expect(resolved[MANAGED_ROUTER_KEY_ENV]).toBe("from-exported");
  });

  it("env-file WINS over local fallback when exported env is absent", () => {
    writeFileSync(envFilePath, `${MANAGED_ROUTER_KEY_ENV}=from-env-file\n`);
    writeFileSync(localFallbackPath, `${MANAGED_ROUTER_KEY_ENV}=from-local\n`);
    const resolved = resolveSeedSecrets({ [SECRET_ENV_FILE_ENV]: envFilePath }, SEED_SECRET_ALLOWLIST, readFile);
    expect(resolved[MANAGED_ROUTER_KEY_ENV]).toBe("from-env-file");
  });

  it("falls back to .env.validation.local when neither exported env nor env-file provide the key", () => {
    writeFileSync(localFallbackPath, `${MANAGED_ROUTER_KEY_ENV}=from-local\n`);
    const resolved = resolveSeedSecrets({}, SEED_SECRET_ALLOWLIST, readFile);
    expect(resolved[MANAGED_ROUTER_KEY_ENV]).toBe("from-local");
  });

  it("ALLOWLIST: an env-file with an extra non-allowlisted key never loads that key", () => {
    writeFileSync(
      envFilePath,
      [
        `${MANAGED_ROUTER_KEY_ENV}=from-env-file`,
        "AWS_SECRET_ACCESS_KEY=should-never-load",
        "DATABASE_URL=postgres://should-never-load",
      ].join("\n"),
    );
    const resolved = resolveSeedSecrets({ [SECRET_ENV_FILE_ENV]: envFilePath }, SEED_SECRET_ALLOWLIST, readFile);
    expect(resolved[MANAGED_ROUTER_KEY_ENV]).toBe("from-env-file");
    expect(resolved).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(resolved).not.toHaveProperty("DATABASE_URL");
    // Only the allowlisted key ever appears in the resolved map.
    expect(Object.keys(resolved)).toStrictEqual([MANAGED_ROUTER_KEY_ENV]);
  });

  it("MissingSeedSecretError names all three sources when everything is empty", () => {
    // No files, no exported env, TANREN_SECRET_ENV_FILE points at a missing file.
    const missingPath = join(dir, "does-not-exist.env");
    const err = new MissingSeedSecretError(MANAGED_ROUTER_KEY_ENV, missingPath);
    expect(err.message).toContain(`exported env ($${MANAGED_ROUTER_KEY_ENV})`);
    expect(err.message).toContain(`$${SECRET_ENV_FILE_ENV}=${missingPath}`);
    expect(err.message).toContain(LOCAL_FALLBACK_ENV_FILE);
  });
});

describe("parseAllowlistedEnvFile — defensive dotenv parsing", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seed-parse-"));
    file = join(dir, "some.env");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("handles comments, blank lines, quotes, and `export ` prefixes; ignores unknown keys", () => {
    writeFileSync(
      file,
      [
        "# a comment",
        "",
        `${MANAGED_ROUTER_KEY_ENV}="sk-or-double-quoted"`,
        "IGNORED_KEY=nope",
        "   # indented comment",
      ].join("\n"),
    );
    const parsed = parseAllowlistedEnvFile(file, [MANAGED_ROUTER_KEY_ENV]);
    expect(parsed).toStrictEqual({ [MANAGED_ROUTER_KEY_ENV]: "sk-or-double-quoted" });
  });

  it("strips single quotes and honors an `export KEY=` form", () => {
    writeFileSync(file, `export ${MANAGED_ROUTER_KEY_ENV}='sk-or-single'\n`);
    const parsed = parseAllowlistedEnvFile(file, [MANAGED_ROUTER_KEY_ENV]);
    expect(parsed[MANAGED_ROUTER_KEY_ENV]).toBe("sk-or-single");
  });

  it("returns {} for a missing file (no throw)", () => {
    expect(parseAllowlistedEnvFile(join(dir, "absent.env"), [MANAGED_ROUTER_KEY_ENV])).toStrictEqual({});
  });

  it("treats a blank value as unset (not an empty-string key)", () => {
    writeFileSync(file, `${MANAGED_ROUTER_KEY_ENV}=\n`);
    expect(parseAllowlistedEnvFile(file, [MANAGED_ROUTER_KEY_ENV])).toStrictEqual({});
  });
});

describe("seed logging — never prints the raw key", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seed-log-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("logs only refs + fingerprints — no raw key, and no PEM material, reaches stdout/stderr", async () => {
    const store = new InMemorySecretStore();
    const rawKey = "sk-or-super-secret-value-do-not-log";
    const suppliedPem = generateEd25519SigningKeyPem();
    const written = await seedPlatformCredentials(
      store,
      { [MANAGED_ROUTER_KEY_ENV]: rawKey, [PROOF_SIGNING_KEY_ENV]: suppliedPem },
      noEnvFiles,
    );

    // The REAL renderer main() uses — not a simulation that could drift from it.
    for (const outcome of written) {
      console.log(describeSeededRef(outcome));
    }
    console.log(`seed-platform-creds: done (${written.length} platform ref(s))`);

    const allOutput = [...logSpy.mock.calls.flat(), ...errSpy.mock.calls.flat()]
      .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
      .join("\n");

    expect(allOutput).not.toContain(rawKey);
    // The PRIVATE key must never surface — not the body, not even its PEM header.
    expect(allOutput).not.toContain("PRIVATE KEY");
    for (const pemLine of suppliedPem.split("\n").filter((candidate) => candidate.trim().length > 16)) {
      expect(allOutput).not.toContain(pemLine.trim());
    }
    expect(allOutput).toContain(`seeded platform ref ${DEFAULT_MANAGED_CREDENTIAL_REF}`);
    // The public-key FINGERPRINT is safe (it is already published in every bundle).
    expect(allOutput).toContain(PROOF_SIGNING_KEY_REF);
    expect(allOutput).toMatch(/ed25519:[0-9a-f]{64}/u);
  });
});
