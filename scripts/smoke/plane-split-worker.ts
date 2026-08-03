// Cross-process plane-split smoke. Proves the run-executor worker is a
// STANDALONE deployable that claims over the mTLS CONTROL-PLANE endpoint: a run
// enqueued against the shared Postgres (same `job_queue` insert as the
// control-plane API) is CLAIMED + EXECUTED by the separate `worker` compose
// container — across the API↔worker process boundary — and finalized under the
// RLS-enforced `tanren_app` runtime role.
//
// Direct claim-channel proof: the smoke hits the live orchestrator's
// `/internal/claim-job` (a) with the worker's client cert → claims + returns
// org_id, (b) without a cert → TLS handshake rejected. The worker is itself
// configured to claim through this endpoint (TANREN_CLAIM_ENDPOINT_URL), so the
// cross-process boundary below also exercises that mTLS path.
//
// This script runs NO worker in-process — it only seeds + enqueues, then
// observes the live DB until the OTHER process claims + finalizes the job.
//
// Credential-free run: no Codex/GitHub creds, so the worker's real
// claim→execute loop throws on credential resolve + fails the job. The durable
// cross-process signal is the `job_queue` row — only the worker process could
// have written its terminal state (`failed`, org stamped, `failure_kind` set).
// The run row also finalizes to terminal `halted`: the worker's early-failure
// finalize org-scopes its UPDATE from the CLAIMED org (carried on the queue
// row, known at claim-time), so RLS admits the write even though credential
// threw before the run's context loaded. Pre-fix this finalize ran unscoped
// and RLS denied it, leaving the run stuck `queued`. We confirm the data
// plane is RLS-gated: run row readable under run's org scope on `tanren_app`,
// DENIED under empty scope (deny-by-default).
//
// Direct WRITE-endpoint proof `proveMtlsWriteEndpoints`: (a) without cert →
// TLS reject on a write endpoint; (b) with worker cert → finalize + event
// append land server-side under RLS, retry no-op (exactly-once). When the
// worker is run with TANREN_DATA_PLANE_REMOTE_WRITES=1, the cross-process run
// below also finalizes via these endpoints. See ROADMAP.md.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createDbPool } from "../../db/src/index.js";
import { proveDataPlaneWriteDenied, proveDeprivilegeEnabled } from "./plane-split-deprivilege.js";

// The dev mTLS material `just gen-mtls-certs` writes to $TANREN_RUNTIME_DIR/mtls — a
// PERSISTENT host dir (default ~/.config/tanren/runtime/mtls), NOT /tmp which is cleaned mid-run. TANREN_MTLS_DIR overrides.
const RUNTIME_DIR = process.env["TANREN_RUNTIME_DIR"] ?? `${process.env["HOME"] ?? ""}/.config/tanren/runtime`;
const MTLS_DIR = process.env["TANREN_MTLS_DIR"] ?? `${RUNTIME_DIR}/mtls`;
// The orchestrator's internal mTLS listener, reachable on the host (compose maps
// no host port for :3110, so the smoke talks to it via the published API host —
// override with TANREN_CLAIM_ENDPOINT_HOST when the listener is host-exposed).
const CLAIM_ENDPOINT = process.env["TANREN_CLAIM_ENDPOINT_SMOKE_URL"] ?? "https://localhost:3110";

const OWNER_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
// The restricted runtime role the worker container actually connects as — we
// read the worker's results through it to prove the data lives under enforced
// RLS (the run's org scope admits its own rows).
const APP_URL = process.env["TANREN_APP_DATABASE_URL"] ?? "postgres://tanren_app:tanren_app@localhost:5432/tanren";
const POLL_MS = 2_000;

const orgId = `org_planesplit_${randomUUID().slice(0, 8)}`;
const projectId = `project_${randomUUID()}`;
const specId = `spec_${randomUUID()}`;
const runId = `run_${randomUUID()}`;
const plannerTaskId = `task_${randomUUID()}`;

async function seedQueuedRun(): Promise<void> {
  // Seed as the OWNER (bypasses RLS as table owner) — this stands in for the
  // control-plane API's enqueue, using the SAME job_queue insert shape. The
  // worker container will claim it cross-process.
  const owner = createDbPool(OWNER_URL);
  try {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name)
       VALUES ($1, 'github_user', $1, 'planesplit-smoke', 'Plane-split Smoke')
       ON CONFLICT (id) DO NOTHING`,
      [orgId],
    );
    await owner.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, allocator, org_id)
       VALUES ($1, 'planesplit-smoke', 'https://github.com/cat-cave/tanren-fixture-easy', 'main', $2, 'local-docker', $3)`,
      [projectId, "ghcr.io/cat-cave/tanren-runner:v0", orgId],
    );
    await owner.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, status)
       VALUES ($1, $2, $3, 'Plane-split worker proof', 'Cross-process claim+execute', $4::jsonb, 'in_flight')`,
      [specId, projectId, orgId, JSON.stringify(["worker claims it across the process boundary"])],
    );
    await owner.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'cli', 'tanren/planesplit-smoke', 'queued')`,
      [runId, specId, projectId, orgId],
    );
    await owner.query(
      // Mirrors createQueuedRunFromSpec's placeholder row (UNASSIGNED_PLANNER_CLI).
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'plan', 'Plan spec implementation', 'queued', 'answerer', 'unassigned', NULL)`,
      [plannerTaskId, runId, orgId],
    );
    // The same job_queue insert createQueuedRunFromSpec does — stamps org_id so the worker hydrates under runWithOrgScope.
    await owner.query(
      `INSERT INTO job_queue (run_id, task_id, task_kind, payload, org_id)
       VALUES ($1, $2, 'plan', $3::jsonb, $4)`,
      [runId, plannerTaskId, JSON.stringify({ specId, projectId }), orgId],
    );
  } finally {
    await owner.end();
  }
}

interface JobObservation {
  status: string | undefined;
  attempts: number;
  failureKind: string | null;
  jobOrgId: string | null;
  // PgJobQueue.heartbeat ticks heartbeat_at each cycle while claim is held —
  // pair with status-identity below for a true sign-of-life stall check.
  heartbeatAtMs: number | null;
}

// The cross-process signal: the job_queue row (OUTSIDE RLS, read on the owner
// connection). A separate process claiming + finishing the job moves it out of
// `queued` and stamps a terminal state.
async function observeJob(owner: ReturnType<typeof createDbPool>): Promise<JobObservation> {
  const row = await owner.query<{
    status: string;
    attempts: number;
    failure_kind: string | null;
    org_id: string | null;
    heartbeat_at: Date | null;
  }>("SELECT status, attempts, failure_kind, org_id, heartbeat_at FROM job_queue WHERE task_id = $1", [plannerTaskId]);
  const job = row.rows[0];
  return {
    status: job?.status,
    attempts: job?.attempts ?? 0,
    failureKind: job?.failure_kind ?? null,
    jobOrgId: job?.org_id ?? null,
    heartbeatAtMs: job?.heartbeat_at instanceof Date ? job.heartbeat_at.getTime() : null,
  };
}

// Prove the data plane is RLS-gated AND that the worker finalized the run: as the
// `tanren_app` runtime role (the role the worker container connects as), read the
// run under the run's org scope (admitted) and under an EMPTY scope (denied,
// deny-by-default). Returns [scopedRows, emptyScopeRows, scopedStatus] where
// scopedStatus is the run's terminal status seen under its own org scope.
async function rlsVisibility(): Promise<[number, number, string | undefined]> {
  const app = createDbPool(APP_URL);
  try {
    const read = async (org: string | null): Promise<{ rows: number; status: string | undefined }> => {
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_org_id', $1, true)", [org ?? ""]);
        const result = await client.query<{ status: string }>("SELECT status FROM runs WHERE run_id = $1", [runId]);
        await client.query("COMMIT");
        return { rows: result.rowCount ?? 0, status: result.rows[0]?.status };
      } finally {
        client.release();
      }
    };
    const scoped = await read(orgId);
    const empty = await read(null);
    return [scoped.rows, empty.rows, scoped.status];
  } finally {
    await app.end();
  }
}

// Seed a SECOND queued run whose job the smoke claims DIRECTLY
// over the mTLS endpoint. It uses a DISTINCT task_kind (`demo`, an existing
// allowed kind) so the worker container — which claims only `plan` — never
// steals it; the smoke's mTLS claim is the only consumer, making the
// direct-claim proof deterministic.
const mtlsRunId = `run_${randomUUID()}`;
const mtlsTaskId = `task_${randomUUID()}`;
const MTLS_PROBE_KIND = "demo";

async function seedMtlsClaimRun(): Promise<void> {
  const owner = createDbPool(OWNER_URL);
  try {
    await owner.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'cli', 'tanren/planesplit-mtls', 'queued')`,
      [mtlsRunId, specId, projectId, orgId],
    );
    await owner.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'plan', 'Plan (mTLS claim proof)', 'queued', 'answerer', 'fake', 'gpt-5-codex')`,
      [mtlsTaskId, mtlsRunId, orgId],
    );
    await owner.query(
      `INSERT INTO job_queue (run_id, task_id, task_kind, payload, org_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [mtlsRunId, mtlsTaskId, MTLS_PROBE_KIND, JSON.stringify({ specId, projectId }), orgId],
    );
  } finally {
    await owner.end();
  }
}

interface ClaimAttempt {
  status: number | "tls_rejected";
  body: string;
}

// POST an internal endpoint over mTLS. `withClientCert=false` presents NO client
// cert, so the server's rejectUnauthorized tears down the handshake (authn
// closed). Returns the HTTP status + body, or `tls_rejected` on a handshake error.
function postOverMtls(path: string, payload: unknown, withClientCert: boolean): Promise<ClaimAttempt> {
  const ca = readFileSync(`${MTLS_DIR}/ca.crt`);
  const target = new URL(path, CLAIM_ENDPOINT);
  const body = JSON.stringify(payload);
  return new Promise<ClaimAttempt>((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        ca,
        rejectUnauthorized: true,
        ...(withClientCert
          ? { cert: readFileSync(`${MTLS_DIR}/worker.crt`), key: readFileSync(`${MTLS_DIR}/worker.key`) }
          : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", (error) => {
      // A handshake rejection (no/invalid client cert) surfaces as a socket/TLS
      // error, NOT an HTTP status — that IS the authn-closed proof.
      const message = String((error as { code?: string }).code ?? error);
      if (/ALERT|HANDSHAKE|ECONNRESET|EPROTO|SSL|TLS/iu.test(message)) {
        resolve({ status: "tls_rejected", body: message });
      } else {
        reject(error);
      }
    });
    req.write(body);
    req.end();
  });
}

function claimOverMtls(claimRunId: string, withClientCert: boolean): Promise<ClaimAttempt> {
  return postOverMtls("/internal/claim-job", { taskKind: MTLS_PROBE_KIND, runId: claimRunId }, withClientCert);
}

// Prove the control-plane mTLS claim endpoint directly: (1) a NO-cert caller is
// rejected at TLS, (2) the worker's client cert claims the seeded job + gets its
// org_id back. The claim is the SAME atomic CAS, only over mTLS.
async function proveMtlsClaimEndpoint(): Promise<void> {
  await seedMtlsClaimRun();
  process.stdout.write(`[plane-split-smoke] seeded mTLS-claim run ${mtlsRunId}; probing /internal/claim-job…\n`);

  const noCert = await claimOverMtls(mtlsRunId, false);
  if (noCert.status !== "tls_rejected" && noCert.status !== 401) {
    throw new Error(`mTLS authn NOT enforced: a no-cert caller got status ${String(noCert.status)} (expected reject)`);
  }
  process.stdout.write(`[plane-split-smoke] authn closed: no-cert claim rejected (${String(noCert.status)})\n`);

  const withCert = await claimOverMtls(mtlsRunId, true);
  if (withCert.status !== 200) {
    throw new Error(`mTLS claim failed: trusted caller got status ${String(withCert.status)} — ${withCert.body}`);
  }
  const parsed = JSON.parse(withCert.body) as { job: { runId?: string; orgId?: string } | null };
  if (parsed.job?.runId !== mtlsRunId) {
    throw new Error(`mTLS claim returned the wrong job: ${JSON.stringify(parsed.job)}`);
  }
  if (parsed.job.orgId !== orgId) {
    throw new Error(`mTLS claim dropped the org thread: expected ${orgId}, got ${String(parsed.job.orgId)}`);
  }
  process.stdout.write(
    `[plane-split-smoke] PROOF (P2): the trusted worker cert claimed ${mtlsRunId} over mTLS via ` +
      `/internal/claim-job — org=${String(parsed.job.orgId)} (same atomic CAS, transport behind mutual TLS)\n`,
  );
}

// A run the smoke finalizes DIRECTLY over the mTLS write
// endpoints (distinct run_id so it never races the worker container).
const writeRunId = `run_${randomUUID()}`;

async function seedWriteProbeRun(): Promise<void> {
  const owner = createDbPool(OWNER_URL);
  try {
    await owner.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'cli', 'tanren/planesplit-p3-write', 'running')`,
      [writeRunId, specId, projectId, orgId],
    );
  } finally {
    await owner.end();
  }
}

// Read the write-probe run's terminal status + the run.failed event count via the
// OWNER connection (job_queue/owner reads bypass RLS), to confirm the endpoint's
// server-side org-scoped write landed.
async function readWriteProbeRun(): Promise<{ status: string | undefined; events: number }> {
  const owner = createDbPool(OWNER_URL);
  try {
    const run = await owner.query<{ status: string }>("SELECT status FROM runs WHERE run_id = $1", [writeRunId]);
    const ev = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM events WHERE run_id = $1 AND event_type = 'run.failed'",
      [writeRunId],
    );
    return { status: run.rows[0]?.status, events: Number(ev.rows[0]?.n ?? "0") };
  } finally {
    await owner.end();
  }
}

// Prove the control-plane mTLS WRITE endpoints directly: (1) a NO-cert caller
// is rejected at TLS on a write endpoint; (2) the worker's client cert finalizes a
// seeded run + appends its run.failed event over mTLS, and the rows LAND under the
// control plane's enforced-RLS org scope — server-side, so the data plane wrote
// nothing directly. A retried finalize is a no-op (exactly-once).
async function proveMtlsWriteEndpoints(): Promise<void> {
  await seedWriteProbeRun();
  process.stdout.write(`[plane-split-smoke] seeded write-probe run ${writeRunId}; probing /internal/finalize-run…\n`);

  const noCert = await postOverMtls(
    "/internal/finalize-run",
    { runId: writeRunId, orgId, status: "halted", outcome: "halted", fromStatuses: ["running", "queued"] },
    false,
  );
  if (noCert.status !== "tls_rejected" && noCert.status !== 401) {
    throw new Error(`P3 write authn NOT enforced: no-cert finalize got ${String(noCert.status)} (expected reject)`);
  }
  process.stdout.write(`[plane-split-smoke] authn closed: no-cert write rejected (${String(noCert.status)})\n`);

  const finalize = await postOverMtls(
    "/internal/finalize-run",
    { runId: writeRunId, orgId, status: "halted", outcome: "halted", fromStatuses: ["running", "queued"] },
    true,
  );
  if (finalize.status !== 200) {
    throw new Error(`P3 finalize-run failed: trusted caller got ${String(finalize.status)} — ${finalize.body}`);
  }
  const finalized = JSON.parse(finalize.body) as { updated: boolean; specId?: string };
  if (!finalized.updated || finalized.specId !== specId) {
    throw new Error(`P3 finalize-run did not move the run: ${finalize.body}`);
  }

  const event = await postOverMtls(
    "/internal/append-event",
    {
      runId: writeRunId,
      specId,
      projectId,
      orgId,
      eventType: "run.failed",
      // run.failed is PUBLIC + redacted: its payload carries ONLY a closed-vocabulary
      // failureCode + stage + a FIXED safe summary (never a raw error string) — see
      // engine/worker/runFailureClassifier.ts. The server-side append re-parses against
      // RunFailedPayload (strict, all four fields required), so the proof must send the
      // real redacted shape, not the legacy `{ status, message }`.
      payload: {
        status: "halted",
        failureCode: "internal",
        stage: "run",
        message: "plane-split P3 write-endpoint proof",
      },
    },
    true,
  );
  if (event.status !== 204) {
    throw new Error(`P3 append-event failed: trusted caller got ${String(event.status)} — ${event.body}`);
  }

  // Exactly-once: a retried finalize matches no row now (the run is halted), so
  // it is a no-op — proving a retry never double-finalizes.
  const retry = await postOverMtls(
    "/internal/finalize-run",
    { runId: writeRunId, orgId, status: "halted", outcome: "halted", fromStatuses: ["running", "queued"] },
    true,
  );
  const retryResult = JSON.parse(retry.body) as { updated: boolean };
  if (retry.status !== 200 || retryResult.updated !== false) {
    throw new Error(`P3 finalize-run is NOT exactly-once: a retry re-finalized (${retry.body})`);
  }

  const persisted = await readWriteProbeRun();
  if (persisted.status !== "halted") {
    throw new Error(`P3 write did not land: run ${writeRunId} status=${String(persisted.status)} (expected halted)`);
  }
  if (persisted.events < 1) {
    throw new Error(`P3 append-event did not land: 0 run.failed events for ${writeRunId}`);
  }
  process.stdout.write(
    `[plane-split-smoke] PROOF (P3): the trusted worker cert finalized ${writeRunId} + appended its event over ` +
      `mTLS via /internal/finalize-run + /internal/append-event — rows landed server-side under enforced RLS ` +
      `(status=${persisted.status}, run.failed events=${persisted.events}); a retried finalize was a no-op ` +
      `(exactly-once). The data plane wrote NO tenant tables directly.\n`,
  );
}

// The worker has finished with the job once it leaves `queued`/`claimed`/`running`.
const QUEUE_TERMINAL = new Set(["done", "failed", "cancelled", "dead_letter"]);

async function main(): Promise<void> {
  // Seed the org/project/spec + the worker's queued run FIRST (this creates the
  // org/project/spec the mTLS-claim run below reuses), then enqueue.
  await seedQueuedRun();
  process.stdout.write(
    `[plane-split-smoke] seeded queued run ${runId} (org ${orgId}); waiting for the worker container…\n`,
  );

  // Prove the control-plane mTLS claim endpoint directly
  // (authn-closed + a trusted claim that threads org_id) on its OWN seeded job,
  // claimed by run_id so it never races the worker container's job above.
  await proveMtlsClaimEndpoint();

  // Prove the control-plane mTLS WRITE endpoints directly
  // (authn-closed + a trusted finalize/append that lands rows server-side under
  // enforced RLS, exactly-once) on its OWN seeded run.
  await proveMtlsWriteEndpoints();

  // The de-privilege CUTOVER: when proving the de-privilege, confirm a
  // direct tenant write by the de-privileged data-plane role is denied by
  // Postgres BEFORE waiting on the worker — a fast, deterministic negative proof.
  if (proveDeprivilegeEnabled()) {
    await proveDataPlaneWriteDenied({ orgId, runId, specId, projectId });
  }

  const owner = createDbPool(OWNER_URL);
  // Halt when both (a) status held identical across STALL_WINDOW polls AND
  // (b) heartbeat_at did not tick across that same window. Both signals flat
  // = the worker is truly dead. Either signal advancing = alive, keep waiting.
  const STALL_WINDOW = 20;
  const statusHistory: string[] = [];
  const heartbeatHistory: (number | null)[] = [];
  try {
    let claimed = false;
    for (;;) {
      const job = await observeJob(owner);
      if (!claimed && job.status !== undefined && job.status !== "queued") {
        claimed = true;
        process.stdout.write(
          `[plane-split-smoke] worker container CLAIMED the job (job_queue status: ${job.status})\n`,
        );
      }
      if (job.status !== undefined && QUEUE_TERMINAL.has(job.status)) {
        if (job.jobOrgId !== orgId) {
          throw new Error(`job org mismatch: expected ${orgId}, got ${String(job.jobOrgId)}`);
        }
        const [scopedRows, emptyScopeRows, runStatus] = await rlsVisibility();
        if (scopedRows < 1) {
          throw new Error("run not visible under its own org scope on the tanren_app role (RLS misconfigured)");
        }
        if (emptyScopeRows !== 0) {
          throw new Error("run visible under an EMPTY scope on tanren_app — RLS deny-by-default not enforced");
        }
        // The worker's early-failure finalize must have moved the run OUT of
        // `queued` (org-scoped from the claimed org). A run stuck `queued` is the
        // exact bug fix/rls-early-failure-finalize-scope eliminates.
        if (runStatus === "queued" || runStatus === undefined) {
          throw new Error(
            `run stuck in non-terminal state (status=${String(runStatus)}) — the worker's early-failure ` +
              `finalize did not org-scope its UPDATE (RLS denied it). This is the stuck-queued regression.`,
          );
        }
        process.stdout.write(
          `[plane-split-smoke] PROOF: the standalone worker container claimed + finished the job across the ` +
            `API↔worker process boundary — job_queue status=${job.status} attempts=${job.attempts} ` +
            `failureKind=${String(job.failureKind)} org=${String(job.jobOrgId)}; the run finalized to a terminal ` +
            `state (status=${String(runStatus)}) and is org-scoped under the tanren_app role ` +
            `(scoped=${scopedRows} row, empty-scope=${emptyScopeRows} rows / deny-by-default)\n`,
        );
        return;
      }
      // Only meaningful AFTER claim — pre-claim, heartbeat_at is NULL and
      // status is 'queued' (both frozen), so this would kill a slow-to-start
      // worker (wall-clock in disguise). Wait unbounded for claim itself.
      if (claimed) {
        statusHistory.push(job.status ?? "<undefined>");
        if (statusHistory.length > STALL_WINDOW) statusHistory.shift();
        heartbeatHistory.push(job.heartbeatAtMs);
        if (heartbeatHistory.length > STALL_WINDOW) heartbeatHistory.shift();
        if (statusHistory.length === STALL_WINDOW && new Set(statusHistory).size === 1) {
          const heartbeatAdvanced = new Set(heartbeatHistory).size > 1;
          if (!heartbeatAdvanced) {
            throw new Error(
              `STALL: post-claim job_queue status held identical at '${statusHistory[0]}' AND heartbeat_at did not advance ` +
                `across ${STALL_WINDOW} polls (~${(STALL_WINDOW * POLL_MS) / 1000}s) for run ${runId} — worker dead, halt loud.`,
            );
          }
        }
      }
      await new Promise((resolve) => {
        setTimeout(resolve, POLL_MS);
      });
    }
  } finally {
    await owner.end();
  }
}

await main();
