// Plane-split: behavior tests for the standalone worker entrypoint boot.
//
// What they prove (observable outcomes, no mock-only assertions):
//   1. `bootRunWorker` builds the runtime pool from DATABASE_URL and STARTS the
//      claim loop (a live, draining-capable RunWorker bound to that pool) — the
//      construction the standalone `worker-main.ts` container relies on.
//   2. The API does NOT run an in-process worker by default: `runWorkerEnabled()`
//      is false unless TANREN_RUN_WORKER=1 (the only gate main.ts consults before
//      starting the in-process worker), so the data plane is the `worker`
//      service unless the dev/test flag is explicitly set.
//
// No real DB is needed: bootRunWorker builds a lazy pg.Pool (connects only when
// the loop claims), and we stop the worker immediately so the slot drains before
// any claim completes. TANREN_SECRET_STORE=memory avoids Vault.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSystemPool } from "@tanren/db";
import { bootRunWorker, runWorkerEnabled, RunWorker } from "../src/engine/worker/index.js";
import { IntegrationSecretCleanupReaper } from "../src/engine/integrations/integrationSecretCleanupReaper.js";

const TEST_DB_URL = "postgres://tanren_app:tanren_app@127.0.0.1:5/tanren_planesplit_boot_test";

describe("plane-split P1 — standalone worker boot", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "DATABASE_URL",
    "TANREN_SYSTEM_DATABASE_URL",
    "TANREN_SECRET_STORE",
    "TANREN_RUN_WORKER",
    "TANREN_RUNNER_IDENTITY_KEY_PATH",
    // Saved/restored so the custom-ref / blank-ref cases can set it without leaking.
    "TANREN_RUNNER_IDENTITY_SECRET_REF",
    // Saved/restored so the "inline env is IGNORED" case can set it without leaking.
    "TANREN_RUNNER_IDENTITY_PRIVATE_KEY",
    "TANREN_ALLOCATOR_KIND",
    // The mTLS de-privilege env the standalone-mode boot guard reads (finding #5).
    "TANREN_CLAIM_ENDPOINT_URL",
    "TANREN_DATA_PLANE_TLS_CERT",
    "TANREN_DATA_PLANE_TLS_KEY",
    "TANREN_DATA_PLANE_TLS_CA",
    "TANREN_DATA_PLANE_REMOTE_WRITES",
    "TANREN_WRITE_ENDPOINT_URL",
  ];

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
    }
    process.env["DATABASE_URL"] = TEST_DB_URL;
    delete process.env["TANREN_SYSTEM_DATABASE_URL"];
    process.env["TANREN_SECRET_STORE"] = "memory";
    process.env["TANREN_ALLOCATOR_KIND"] = "static";
    // No identity to seed → bootRunWorker's seed step is a no-op (memory store).
    delete process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"];
    delete process.env["TANREN_RUNNER_IDENTITY_SECRET_REF"];
    delete process.env["TANREN_RUNNER_IDENTITY_PRIVATE_KEY"];
    // The in-process (default) cases run with NO mTLS env — the silent direct-DB
    // dev fallback. The standalone-guard cases set it explicitly below.
    delete process.env["TANREN_CLAIM_ENDPOINT_URL"];
    delete process.env["TANREN_DATA_PLANE_TLS_CERT"];
    delete process.env["TANREN_DATA_PLANE_TLS_KEY"];
    delete process.env["TANREN_DATA_PLANE_TLS_CA"];
    delete process.env["TANREN_DATA_PLANE_REMOTE_WRITES"];
    delete process.env["TANREN_WRITE_ENDPOINT_URL"];
    resetSystemPool();
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    resetSystemPool();
  });

  it("builds the runtime pool from DATABASE_URL and starts a worker loop that drains", async () => {
    const booted = await bootRunWorker();
    try {
      // The loop is live (started, not yet draining) and bound to the
      // DATABASE_URL runtime pool — exactly what the data-plane container runs.
      expect(booted.worker).toBeInstanceOf(RunWorker);
      expect(booted.worker.isDraining).toBe(false);
      expect((booted.pool.options as { connectionString?: string }).connectionString).toBe(TEST_DB_URL);
    } finally {
      // Drain BOTH the worker and the co-located reaper — the SIGTERM path the
      // standalone container uses. Proves graceful shutdown of the data plane.
      await booted.stop();
    }
    expect(booted.worker.isDraining).toBe(true);
  });

  it("does not enable the in-process worker by default (only TANREN_RUN_WORKER=1 does)", () => {
    delete process.env["TANREN_RUN_WORKER"];
    expect(runWorkerEnabled()).toBe(false);
    process.env["TANREN_RUN_WORKER"] = "0";
    expect(runWorkerEnabled()).toBe(false);
    process.env["TANREN_RUN_WORKER"] = "";
    expect(runWorkerEnabled()).toBe(false);
    process.env["TANREN_RUN_WORKER"] = "1";
    expect(runWorkerEnabled()).toBe(true);
  });

  it("starts a co-located reaper alongside the worker (both drain on stop)", async () => {
    const booted = await bootRunWorker();
    try {
      // The boot wires BOTH the worker and the lease reaper — the data plane's
      // crash-recovery side. `stop` must drain both without throwing.
      expect(booted.reaper).toBeDefined();
      expect(booted.integrationSecretCleanupReaper).toBeInstanceOf(IntegrationSecretCleanupReaper);
      expect(booted.integrationSecretCleanupReaper.isRunning).toBe(true);
    } finally {
      await booted.stop();
    }
    expect(booted.worker.isDraining).toBe(true);
    expect(booted.integrationSecretCleanupReaper.isRunning).toBe(false);
  });

  it("seeds the runner identity secret from a key FILE (the MOUNTED secret) under the default ref", async () => {
    // The runner identity PRIVATE key is delivered as a MOUNTED SECRET FILE
    // (TANREN_RUNNER_IDENTITY_KEY_PATH), never a plaintext env value. The worker
    // reads the file and seeds the identity into the (shared) secret store at the
    // default ref so the workflow's SSH substrate can resolve it.
    delete process.env["TANREN_RUNNER_IDENTITY_SECRET_REF"];
    const keyFile = join(mkdtempSync(join(tmpdir(), "tanren-runner-key-")), "id_ed25519");
    writeFileSync(keyFile, "FILE-PRIVATE-KEY");
    process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"] = keyFile;
    const booted = await bootRunWorker();
    try {
      expect((await booted.secrets.get("runner/local-docker/identity"))?.value).toBe("FILE-PRIVATE-KEY");
    } finally {
      await booted.stop();
    }
    rmSync(keyFile, { force: true });
  });

  it("seeds the runner identity secret under a custom ref when TANREN_RUNNER_IDENTITY_SECRET_REF is set", async () => {
    process.env["TANREN_RUNNER_IDENTITY_SECRET_REF"] = "runner/custom/key";
    const keyFile = join(mkdtempSync(join(tmpdir(), "tanren-runner-key-")), "id_ed25519");
    writeFileSync(keyFile, "CUSTOM-KEY");
    process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"] = keyFile;
    const booted = await bootRunWorker();
    try {
      // The custom ref is honored; the default ref is NOT seeded.
      expect((await booted.secrets.get("runner/custom/key"))?.value).toBe("CUSTOM-KEY");
      expect(await booted.secrets.get("runner/local-docker/identity")).toBeUndefined();
    } finally {
      await booted.stop();
    }
    rmSync(keyFile, { force: true });
    delete process.env["TANREN_RUNNER_IDENTITY_SECRET_REF"];
  });

  it('a BLANK TANREN_RUNNER_IDENTITY_SECRET_REF fails-closed to the validated default (never a silent "")', async () => {
    // SECURITY BOUNDARY: a blank ref must NOT become the live secret ref. The old
    // `process.env[...] ?? "..."` let `""` through (`??` only catches null/undefined),
    // so a blank value seeded the identity under the empty ref. Routing through the
    // shared parsed env contract (`emptyToUndefined` + `.min(1)` + default) makes a
    // blank ref resolve to the validated default — observable here: the identity is
    // seeded under the default ref, and NOTHING is written under the empty ref "".
    process.env["TANREN_RUNNER_IDENTITY_SECRET_REF"] = "";
    const keyFile = join(mkdtempSync(join(tmpdir(), "tanren-runner-key-")), "id_ed25519");
    writeFileSync(keyFile, "BLANK-REF-KEY");
    process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"] = keyFile;
    const booted = await bootRunWorker();
    try {
      expect((await booted.secrets.get("runner/local-docker/identity"))?.value).toBe("BLANK-REF-KEY");
      // The blank ref is never honored — no secret lands under the empty ref.
      expect(await booted.secrets.get("")).toBeUndefined();
    } finally {
      await booted.stop();
    }
    rmSync(keyFile, { force: true });
  });

  it("IGNORES a plaintext TANREN_RUNNER_IDENTITY_PRIVATE_KEY env (the inline path is deleted)", async () => {
    // The plaintext-env path was removed (secrets are secret-mounts, never env
    // VALUES). Setting the legacy env var must NOT seed anything — only the key
    // FILE path is honored.
    process.env["TANREN_RUNNER_IDENTITY_PRIVATE_KEY"] = "INLINE-PRIVATE-KEY";
    delete process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"];
    const booted = await bootRunWorker();
    try {
      expect(await booted.secrets.get("runner/local-docker/identity")).toBeUndefined();
    } finally {
      await booted.stop();
      delete process.env["TANREN_RUNNER_IDENTITY_PRIVATE_KEY"];
    }
  });

  it("does not seed any identity secret when the key path is unset", async () => {
    delete process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"];
    const booted = await bootRunWorker();
    try {
      // No key configured → the seed step is a no-op (the API may seed the
      // shared store instead); nothing is written under the default ref.
      expect(await booted.secrets.get("runner/local-docker/identity")).toBeUndefined();
    } finally {
      await booted.stop();
    }
  });

  it("does not seed when the key path is the empty string", async () => {
    process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"] = "";
    const booted = await bootRunWorker();
    try {
      expect(await booted.secrets.get("runner/local-docker/identity")).toBeUndefined();
    } finally {
      await booted.stop();
    }
  });

  // ---- finding #5: the standalone de-privilege boot guard (no silent fallback) ----

  it("STANDALONE mode WITHOUT the mTLS claim endpoint FAILS BOOT (never silently uses direct DB-CAS)", async () => {
    // The de-privileged data plane must claim over mTLS. With no endpoint the boot
    // would silently revert to the direct `job_queue` DB-CAS — re-acquiring the very
    // privilege the split removes. Mode "standalone" makes that a LOUD boot failure.
    await expect(bootRunWorker("standalone")).rejects.toThrow(/standalone data-plane worker requires the mTLS claim/u);
  });

  it("STANDALONE mode with the claim endpoint but remote-writes OFF FAILS BOOT (never silent direct writes)", async () => {
    // Claim endpoint + certs present, but remote-writes off → the worker would write
    // tenant tables directly on the de-privileged role. The guard rejects this too.
    process.env["TANREN_CLAIM_ENDPOINT_URL"] = "https://orchestrator:3110";
    process.env["TANREN_DATA_PLANE_TLS_CERT"] = "/etc/tanren/mtls/worker.crt";
    process.env["TANREN_DATA_PLANE_TLS_KEY"] = "/etc/tanren/mtls/worker.key";
    process.env["TANREN_DATA_PLANE_TLS_CA"] = "/etc/tanren/mtls/ca.crt";
    // TANREN_DATA_PLANE_REMOTE_WRITES intentionally unset (off).
    await expect(bootRunWorker("standalone")).rejects.toThrow(
      /standalone data-plane worker requires remote run-state/u,
    );
  });

  it("STANDALONE mode with the claim endpoint set but certs MISSING FAILS BOOT (no unauthenticated channel)", async () => {
    process.env["TANREN_CLAIM_ENDPOINT_URL"] = "https://orchestrator:3110";
    // No TANREN_DATA_PLANE_TLS_* certs — the partial-config guard fires.
    await expect(bootRunWorker("standalone")).rejects.toThrow(/mTLS cert env.*is incomplete/u);
  });

  it("IN-PROCESS dev mode boots WITHOUT any mTLS env (the documented single-process direct-DB path)", async () => {
    // The default mode is "in-process": it shares the API pool, so the direct-DB
    // claim + writes are intended. No mTLS env set, yet boot succeeds — the guard
    // is gated on standalone mode only, so the dev/smoke path is unaffected.
    const booted = await bootRunWorker("in-process");
    try {
      expect(booted.worker).toBeInstanceOf(RunWorker);
    } finally {
      await booted.stop();
    }
  });
});
