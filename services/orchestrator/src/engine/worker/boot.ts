// Shared run-executor worker boot. Builds the same
// pools/secrets/allocator/ssh/github wiring the in-process boot used, seeds the
// runner identity secret, and starts the worker loop. Used by BOTH the
// in-process flag path (main.ts, TANREN_RUN_WORKER=1) and the standalone
// `worker-main.ts` entrypoint (the data-plane container). The worker is now a
// standalone deployable; this is the single construction site so the two paths
// can never drift. See ROADMAP.md.

import { createDbPool } from "@tanren/db";
import type pg from "pg";
import { buildAllocatorFromEnv } from "../allocators/index.js";
import { resolveWorkerConcurrency } from "../config/index.js";
import { buildSecretStore, type SecretStore } from "../contracts/index.js";
import { startAutonomyLoops, type AutonomyLoops } from "./autonomyLoops.js";
import { TimedGitHubHttpClient, TimedCommandSubstrate, createLogger } from "../observability/index.js";
// `FetchGitHubHttpClient` is the raw transport (wrapped by `TimedGitHubHttpClient` below);
// `GithubAppTokenMinter` (re-exported from `github.js`) caches the App installation token
// the clone/CI/merge stages reuse.
import { FetchGitHubHttpClient, GithubAppTokenMinter } from "../providers/github.js";
import { SshCommandSubstrate } from "../ssh/index.js";
import { assertStandaloneClaimMtlsConfigured, buildClaimClientFromEnv } from "./claimClientFromEnv.js";
import { resolveRunnerIdentitySecretRef, seedRunnerIdentitySecret } from "./runnerIdentityFromEnv.js";
import {
  assertStandaloneRemoteWritesConfigured,
  buildRunStateWriterFromEnv,
  remoteWritesEnabled,
} from "./runStateWriterFromEnv.js";
import type { JobReaper } from "./jobReaper.js";
import type { RunWorker } from "./runWorker.js";
import {
  buildEnvCreationFromEnv,
  buildRunCredentialScoping,
  startFlyMachineOrphanSweeper,
  startRunnerRowOrphanSweeper,
  startRunWorker,
  startRunWorkspaceReaper,
  type FlyMachineOrphanSweeper,
  type RunnerRowOrphanSweeper,
  type RunWorkspaceReaper,
} from "./lifecycle.js";

const log = createLogger("run-worker");

/**
 * Which entrypoint is booting the worker — the EXPLICIT mode that gates the
 * de-privilege loud-fail (no silent env-absent inference):
 *   - `"standalone"`: the data-plane container (`worker-main.ts`). The mTLS claim
 *     endpoint + remote run-state writes are REQUIRED; booting without them throws
 *     LOUDLY rather than silently reverting to the direct `job_queue` DB-CAS /
 *     direct tenant-table writes (the privilege the plane split removes).
 *   - `"in-process"`: the single-process dev convenience (`main.ts`,
 *     TANREN_RUN_WORKER=1) and the smoke/test harness. It SHARES the API's pool,
 *     so the direct-DB claim + writes are intended — the mTLS config stays optional.
 */
export type WorkerBootMode = "standalone" | "in-process";

/** What {@link bootRunWorker} returns so callers (and tests) can drain + assert. */
export interface BootedRunWorker {
  worker: RunWorker;
  reaper: JobReaper;
  /** Worker-owned reconciliation of terminal integration staged-secret cleanup. */
  integrationSecretCleanupReaper: { readonly isRunning: boolean; stop(): Promise<void> };
  /** The runtime (`tanren_app`) pool the worker claims + writes through. */
  pool: pg.Pool;
  secrets: SecretStore;
  /**
   * The autonomy background loops (autonomy-engine.md §1a + §1d): the DagWalker
   * subscriber that turns the spec DAG into self-driving execution, plus the
   * autonomous-intake loops (webhook-fallback poller + the now-on-a-loop audit
   * scheduler) that ingest issues/signals and auto-route into the DAG/inbox.
   * Co-located with the worker boot because they share the runtime pool + the
   * same executor + allocator.
   */
  autonomy: AutonomyLoops;
  /**
   * The run-sandbox reaper (layer 2 of the ≈204 GB disk-leak fix): the periodic
   * sweep of a LONG-LIVED runner's `/workspace/runs/*` that removes stale, non-active
   * run dirs. Present only when the allocator is long-lived (static); undefined for
   * ephemeral kinds whose sandbox dies with the container on release.
   */
  runWorkspaceReaper: RunWorkspaceReaper | undefined;
  /**
   * The runner-row orphan sweeper (task #9): the orchestrator-side reconciler
   * for `runners` rows the in-memory `release()` missed (orchestrator-crash-mid-
   * run shape). Wired ONLY for the long-lived allocator kinds (static,
   * manual-ssh) — cloud / sidecar kinds have their own teardown + sweeper
   * paths. Undefined for the ephemeral kinds.
   */
  runnerRowOrphanSweeper: RunnerRowOrphanSweeper | undefined;
  /**
   * The Fly-machine orphan sweeper (apex-v96 guard): the durable out-of-band
   * reconciler that reaps accumulated Fly machines the inline post-verify reap
   * missed (keeping only the release_instances-recorded live machine per
   * single-instance app). Always on — a clean no-op when no Fly deployment is live.
   */
  flyMachineOrphanSweeper: FlyMachineOrphanSweeper;
  /** Drain the worker + reaper + autonomy loops + run-sandbox reaper + orphan sweepers (the SIGTERM path). */
  stop: () => Promise<void>;
}

/**
 * Build the run-executor worker's dependencies from the environment and start
 * its claim→plan→write→check→audit loop.
 *
 * Pools mirror the API exactly: the runtime pool is `createDbPool()`
 * (`DATABASE_URL`, the restricted `tanren_app` role under R3b); the BYPASSRLS
 * `tanren_system` pool is resolved lazily by `runWithSystemScope`/the reaper from
 * `TANREN_SYSTEM_DATABASE_URL`. The split is layered: a bare process boundary
 * (the worker claims directly from `job_queue` via DB-CAS); an mTLS control-plane
 * claim; and the full data-plane de-privilege — each gated by config.
 *
 * Does NOT run migrations: the control-plane API owns the migrate step (the
 * worker container `depends_on` it), and the in-process flag path already
 * migrated in `createApp` before this runs.
 */
export async function bootRunWorker(mode: WorkerBootMode = "in-process"): Promise<BootedRunWorker> {
  // De-privilege guard (no silent env-absent fallback): a STANDALONE data-plane
  // worker MUST claim + write over the mTLS control plane. Asserting BEFORE any
  // pool/secret construction makes a misconfigured standalone container fail boot
  // loudly instead of quietly running on the direct DB path. The in-process dev
  // mode skips this — it shares the API's pool by design (TANREN_RUN_WORKER=1).
  if (mode === "standalone") {
    assertStandaloneClaimMtlsConfigured();
    assertStandaloneRemoteWritesConfigured();
  }
  // Resolve the runner-identity SECRET REF through the SHARED parsed env contract
  // (`resolveRunnerIdentitySecretRef` → `parseOrchestratorEnv`), NOT a raw
  // `process.env[...] ?? default` — that bypassed `envSchema.ts` and let a BLANK
  // `""` become the live secret ref on this security boundary (`??` only catches
  // null/undefined, not `""`). The validated read fails-closed to the schema
  // default on blank/unset and crashes boot on a malformed ref.
  const identitySecretRef = resolveRunnerIdentitySecretRef();
  const pool = createDbPool();
  const secrets = buildSecretStore();
  await seedRunnerIdentitySecret(secrets, identitySecretRef);
  // When the control-plane claim endpoint + the data-plane mTLS
  // certs are configured, claim over the mTLS endpoint (so this container never
  // touches `job_queue` to claim); else fall back to the direct DB-CAS. The
  // standalone `worker` container sets the endpoint env; the single-process dev
  // path leaves it unset and claims directly.
  const claimClient = buildClaimClientFromEnv();
  log.info(
    claimClient === undefined
      ? "claiming via direct DB-CAS (no control-plane endpoint configured)"
      : "claiming via the mTLS control-plane endpoint",
  );
  // Audit finding D3/H3 sweep: the writer is REQUIRED everywhere downstream,
  // so this always returns a writer — `DirectRunStateWriter` (in-process,
  // byte-identical to the prior direct path) by default, `HttpRunStateWriter`
  // (mTLS to the control plane) when TANREN_DATA_PLANE_REMOTE_WRITES=1.
  const runStateWriter = buildRunStateWriterFromEnv(pool);
  log.info(
    remoteWritesEnabled()
      ? "writing run state via the mTLS control-plane endpoints"
      : "writing run state via direct in-process DB writes (remote-writes off)",
  );
  // Concurrency is a GOVERNED CONFIG KNOB, not an env var (autonomy-engine.md
  // §1.4): resolve the worker's slot ceiling from the config surface's
  // `AllocatorConfig.concurrency`. This process serves EVERY tenant, so it boots on
  // the schema default (no layers) — a single project's knob may not size the shared
  // slot pool. The per-project/org ceiling is resolved and spent by the DagWalker
  // (`buildConcurrencyResolver`), which knows the project it is walking.
  const concurrency = resolveWorkerConcurrency();
  log.info("concurrency ceiling resolved (config: allocator.concurrency)", { concurrency });
  // Hoisted so the run worker AND the P1d intake poller share the same allocator /
  // SSH / GitHub plumbing (the poller's triage answerer allocates a runner per
  // model call exactly as the Forge route factories do).
  const allocator = await buildAllocatorFromEnv(pool, secrets);
  const ssh = new TimedCommandSubstrate(new SshCommandSubstrate(secrets));
  // The run/merge lifecycle routes its VCS/CI ops through the `CodeHost` +
  // `VisibilityProjection` host seams (`hostFactory`) + the standalone credential
  // resolver, all built over this one shared (timed) GitHub HTTP client.
  const githubHttp = new TimedGitHubHttpClient(new FetchGitHubHttpClient());
  // Part 2: the shared App installation-token minter (cache lives here),
  // threaded into the workflow so the App-first CLONE token reuses the same
  // minted/cached installation token as the CI-poll / merge stages.
  const githubAppMinter = new GithubAppTokenMinter({ secrets });
  // Managed-hosting dimension D: the per-run credential-scoping seam. Built from the
  // BROAD VAULT_TOKEN (Vault backend only) and used ONLY to mint short-lived per-run
  // child tokens; the broad token is never handed to a runner. Undefined for a
  // non-Vault backend — that backend has no broad Vault token to de-privilege.
  const credentialScoping = buildRunCredentialScoping();
  log.info(
    credentialScoping === undefined
      ? "per-run credential scoping OFF (non-Vault secret store; reads use the backend store directly)"
      : "per-run credential scoping ON (each run reads via a short-lived Vault child token; dimension D)",
  );
  // Environment management (env-management.md §4 + §7 P4): the JIT env-image creation
  // seams, built from the env config surface (the build driver shelling
  // build-env-image.sh + the validation allocator/ssh). Gated ON only when a registry
  // is configured (`TANREN_ENV_REGISTRY`); OFF ⇒ undefined ⇒ the executor keeps P3's
  // golden-base no-match fallback. The validation runner is allocated from the SAME
  // shared allocator/ssh the run worker uses.
  const envCreation = buildEnvCreationFromEnv({ allocator, ssh, identitySecretRef });
  log.info(
    envCreation === undefined
      ? "JIT env-image creation OFF (TANREN_ENV_REGISTRY unset; off-baseline no-match falls back to the golden base)"
      : "JIT env-image creation ON (off-baseline no-match builds→validates→publishes a real env image)",
  );
  const { worker, reaper } = startRunWorker({
    pool,
    concurrency,
    allocator,
    // Same boundary-timing wrappers as the HTTP-server worker path; the worker
    // internals are untouched, only its injected SSH / GitHub clients decorated.
    ssh,
    secrets,
    ...(credentialScoping === undefined ? {} : { credentialScoping }),
    githubHttp,
    githubAppMinter,
    identitySecretRef,
    ...(claimClient === undefined ? {} : { claimClient }),
    runStateWriter,
    ...(envCreation === undefined ? {} : { envCreation }),
  });
  // Autonomy engine §1a + §1d: start the worker's autonomy background loops — the
  // per-project DagWalker (subscribes to the run-activity bus and self-drives the
  // DAG: on every terminal-run / merge.completed it enqueues ready specs THIS
  // worker then executes) and the autonomous-intake loops (the webhook-fallback
  // poller + the now-on-a-loop audit scheduler, both auto-routing into the
  // DAG/inbox). The driver becomes autonomous; no operator triggers each spec.
  const autonomy = await startAutonomyLoops({
    pool,
    secrets,
    allocator,
    ssh,
    githubHttp,
    identitySecretRef,
    // the DagWalker's base-shift coordinator builds a dependent's dynamic-base
    // integration state through the SAME GitHub HTTP client + App minter the
    // run/merge lifecycle uses.
    githubAppMinter,
    // Audit finding D3/H3 sweep: writer is now ALWAYS wired (Direct or HTTP).
    // The autonomy loops route EVERY tenant write through it — the DagWalker's
    // run-creation + dag.* events, the merge coordinator's merge-stage writes +
    // spec-status + conflict re-exec, the post-merge watcher's events, and the
    // intake's run/spec creation. The de-privileged data-plane role must never
    // write a tenant table directly (migrations 0031/0035).
    runStateWriter,
  });
  // Run-sandbox reaper (layer 2 of the ≈204 GB disk-leak fix): start the periodic
  // `/workspace/runs/*` sweep ONLY for a long-lived (static) runner — the builder reads
  // TANREN_ALLOCATOR_KIND and returns undefined (logging why) for an ephemeral kind,
  // whose sandbox is destroyed with its container on release. The per-run teardown
  // (layer 1, in the run's `finally`) runs for every kind regardless.
  const runWorkspaceReaper = startRunWorkspaceReaper({ pool, secrets, ssh, identitySecretRef });
  // Runner-row orphan sweeper (task #9): reconciles `runners` rows the in-memory
  // `release()` missed (orchestrator-crash-mid-run) for the long-lived allocator
  // kinds. Wired conditionally inside the starter — it reads the SAME
  // `resolveBootedAllocatorKind` the workspace reaper reads, so a typo'd kind
  // fails LOUD there rather than silently disabling the sweeper.
  const runnerRowOrphanSweeper = startRunnerRowOrphanSweeper({ pool });
  // Fly-machine orphan sweeper (apex-v96 guard): the durable out-of-band reconciler
  // that reaps accumulated Fly machines the inline post-verify reap missed. Always on
  // (its live-deployment enumeration is a system-scope SELECT that no-ops when no Fly
  // deploy is live), so a transient reap blip during a deploy self-corrects next sweep
  // instead of fragmenting a single-instance product's file store.
  const flyMachineOrphanSweeper = startFlyMachineOrphanSweeper({ pool, secrets });
  const { IntegrationSecretCleanupReaper } = await import("../integrations/integrationSecretCleanupReaper.js");
  const integrationSecretCleanupReaper = new IntegrationSecretCleanupReaper({ pool, secrets });
  integrationSecretCleanupReaper.start();
  const stop = async (): Promise<void> => {
    // Kick off every drain in PARALLEL (Codex RA1): the notify subscribers now
    // await their internal `subscribeWithReconnect` loops (Bug 2 fix), which
    // adds a small (millisecond) tail before autonomy.stop() resolves. Running
    // it serially before `worker.stop()` / `reaper.stop()` used to push the
    // (uninterruptible-sleep) `JobReaper` loop past its post-reap `if(draining)`
    // check into a 30s sleep — every workerBoot test then hung. Parallelizing
    // starts all drains at the same tick, so the reaper's own `draining` flag
    // is set BEFORE its first reap catch, and the subscriber drain runs
    // alongside worker/reaper drains.
    await Promise.all([
      autonomy.stop(),
      runWorkspaceReaper?.stop(),
      runnerRowOrphanSweeper?.stop(),
      flyMachineOrphanSweeper.stop(),
      integrationSecretCleanupReaper.stop(),
      worker.stop(),
      reaper.stop(),
    ]);
  };
  return {
    worker,
    reaper,
    pool,
    secrets,
    autonomy,
    runWorkspaceReaper,
    runnerRowOrphanSweeper,
    flyMachineOrphanSweeper,
    integrationSecretCleanupReaper,
    stop,
  };
}
