# Mutation testing — cluster map, baselines, and cadence

Mutation testing turns "how strong are the tests" into a number. [Stryker][stryker]
introduces small faults (mutants) into scoped source and checks whether the
existing vitest suite catches them. A **survived** mutant is a behavior the tests
do not actually pin. This is the Track C §5 longevity asset
(`docs/architecture/portability-and-longevity.md`).

It is **slow** and deliberately **NOT** part of the per-PR gate (`just ci` /
`just fast-check`). It runs two ways:

- **on demand / per-cluster** — `just mutation` (the original high-value scope)
  and `just mutation-cluster <name>` for one cluster. Each cluster config carries
  a ratcheted `break` floor that **gates regressions** locally.
- **weekly / whole-repo** — the scheduled `.github/workflows/mutation-weekly.yml`
  job runs `just mutation-full` (the whole orchestrator backend) plus the
  refactor-target backend clusters, uploads the report as an artifact, and tracks
  the **global trend**. It does **not** block PRs.

## Cluster map

Each cluster is a `stryker.<name>.mjs` config that mutates a disjoint slice of
`services/orchestrator/src/**` (the DAL cluster also reaches `db/src/orgScope.ts`).
The clusters are disjoint so they can be measured and ratcheted independently.

| Cluster     | Config                    | Scope (mutated)                                                       | Baseline    | `break` |
| ----------- | ------------------------- | --------------------------------------------------------------------- | ----------- | ------- |
| core        | `stryker.config.mjs`      | planner/checker/auditor, credentials, seam contracts, allocators      | 39.89%¹     | 42      |
| runloop     | `stryker.runloop.mjs`     | `engine/workflow/**` run-loop stages                                  | 81.99%      | 0²      |
| alloc       | `stryker.alloc.mjs`       | `engine/allocators/**` + allocator contract                           | 84.03%      | 82      |
| wf          | `stryker.wf.mjs`          | `subtaskStages.ts` + `subtaskCost.ts`                                 | 91.33%      | 90      |
| forge       | `stryker.forge.mjs`       | `engine/forge/**` conversation + write-approval                       | 82.28%      | 80      |
| notify      | `stryker.notify.mjs`      | `engine/notifications/**` channels + dispatch                         | 87.04%      | 85      |
| secrets     | `stryker.secrets.mjs`     | SecretStore seam + GCP/AWS/1Password/Vault backends                   | 95.96%      | 95      |
| inbox       | `stryker.inbox.mjs`       | `engine/forge/inbox/**` source connectors + dispatcher + triage       | 83.57%      | 83      |
| auth        | `stryker.auth.mjs`        | operator `auth/**` providers + identity store + `middleware/auth.ts`  | 78.43%      | 78      |
| costs       | `stryker.costs.mjs`       | 4-source cost model + CostRecorder + DORA reducer + insight detectors | 87.54%      | 87      |
| **repos**   | `stryker.repos.mjs`       | `engine/repositories/**` state stores                                 | **84.62%**  | 84      |
| **worker**  | `stryker.worker.mjs`      | `engine/worker/**` run executor + reaper + boot                       | **70.95%**  | 69      |
| **dal**     | `stryker.dal.mjs`         | `engine/data/**` + `db/src/orgScope.ts` org-scope seam                | **97.78%³** | 97      |
| commit-gate | `stryker.commit-gate.mjs` | `providers/writerCommitGate.ts` + `workflow/commitGateSteering.ts`    | 97.67%⁴     | 97      |

¹ Core's full-scope number is a Stryker scoping artifact (planner/checker/auditor
read 0% in the aggregate run); measured in isolation via `runloop` they score
~82%. ² `runloop` has `break: 0` because its members overlap the `core` scope's
ratchet. ³ DB-free measurement — see the backend note below. ⁴ 84 killed, 2
survived, 86 mutants: `commitGateSteering.ts` 100% (32/32), `writerCommitGate.ts`
96.30% (52/54). Both survivors are the `buildActivityWatchdog({…})` argument in
`stageWorkspaceChanges`, which no test seam observes. The cluster mutates only the
two commit-gate helper modules — NOT the adapters (`writerGit.ts` / `codexGit.ts`)
or the routing (`writerStage.ts` / `subtaskInnerLoop.ts`) that carry a rejection to
the writer — so its score is a statement about the classification seam and the
steering text, not about the recovery feature as a whole (#1420 review).

The **bold** clusters (repos / worker / dal) are the **refactor-target backend**:
the DAL / repositories / run-executor layer slated for the RLS +
control-plane/data-plane split and the eventual native/Rust harness. Their
baselines were captured **before** that rearchitecture so the refactor can be
held to "did not weaken the tests." They were then ratcheted to current strength
(repos 84.62%, worker 70.95%, dal 97.78% DB-free) in #166/#167/#168 — the
"first measurement" numbers below are the historical pre-ratchet baseline.

## Backend refactor-target baselines (first measurement)

Measured on branch `ci/scheduled-mutation-and-backend-baseline`, DB-free
(`vitest.stryker.config.ts`, no Postgres):

- **repos — 51.28%** (20 killed of 39 mutants). Per file: `actors.ts` 100,
  `runs.ts` 75, `specs.ts` 66.67, `tasks.ts` 37.50, `jobs.ts` 25.00. The
  dominant survivors are the `SELECT_*_COLUMNS` column-list StringLiterals and
  `ORDER BY` / `LIMIT` clause text the stub-client suite
  (`stateRepositories.test.ts`) does not assert against a live query.
- **worker — 38.25%** (159 killed + 7 timeout of 434 mutants). Per file:
  `runExecutor.ts` 44.71, `runExecutionContext.ts` 41.67, `jobReaper.ts` 40.86,
  `runWorker.ts` 38.46, `boot.ts` 25.00, `lifecycle.ts` 18.00. DB-free coverage
  comes from `workerBoot.test.ts`, `jobReaper.test.ts`, and
  `acceptanceHardTier.test.ts`; many survivors live in claim/lease/lineage SQL +
  pool-wiring branches only the RLS-DB integration suite drives.
- **dal — 38.89%** (35 killed of 90 mutants). `db/src/orgScope.ts` 44.64,
  `services/.../engine/data/orgScopedDb.ts` 29.41. **This understates the true
  strength**: the strongest coverage (the `SET LOCAL app.current_org_id`
  transaction, the policy-scoped reads/writes) lives in the RLS-DB-gated
  integration suite (`rlsR2*` / `rlsR3a*`), which **skips** without
  `TANREN_RLS_DB_TEST=1` + a superuser Postgres. For the full DAL number, run the
  RLS DB harness before the cluster (see below).

> Whole-repo (`just mutation-full`) baseline: **pending the first scheduled
> weekly run** — the full orchestrator-wide run is too slow to complete on the
> authoring branch. Record the first number here once `mutation-weekly` lands its
> initial artifact. **PR #762 (Wave F, 2026-07-06, task #17) restored the
> `mutation-weekly.yml` workflow** by excluding `env-read-whitelist.test.ts`
> from the Stryker sandbox (the whitelist scans the whole repo, which the
> Stryker sandbox can't stand up) and bumping `dryRunTimeoutMinutes: 15` so
> the whole-repo dry-run has room to complete.

## How to run

```sh
just mutation                 # original high-value scope (stryker.config.mjs)
just mutation-cluster repos   # one cluster (repos|worker|dal|alloc|wf|forge|notify|secrets|inbox|auth|costs|runloop|commit-gate)
just mutation-full            # WHOLE orchestrator backend — slow; weekly job
```

For the **true DAL/worker number**, give the integration suite a Postgres so the
RLS-gated tests run instead of skipping:

```sh
TANREN_RLS_DB_TEST=1 DATABASE_URL=postgres://...superuser... just mutation-cluster dal
```

## How to read the report

`just mutation-full` writes `reports/mutation/full/index.html` (browse per-file,
click a line to see survived/killed mutants) and `reports/mutation/full/mutation.json`
(machine-readable score). Both live under the gitignored `reports/`. The weekly
workflow uploads them as the `mutation-full-report` artifact (30-day retention).
The per-cluster `just mutation-cluster` runs print a `clear-text` table to stdout.
A **survived** mutant is the actionable signal: a fault the tests let through —
add a behavior assertion that kills it (do not assert implementation details).

## Policy

- **Per-cluster `break` floors gate regressions on demand.** Each floor sits just
  below its measured baseline, so the cluster run passes today and any drop below
  the floor fails the run. Strengthening a cluster = kill survivors, then raise
  that cluster's floor to the new measured score. Never lower a floor.
- **The weekly job tracks the global trend** and does not gate PRs. It is the
  early-warning signal that whole-repo test strength is drifting.
- **Baselines, not strengthening passes.** The refactor-target backend clusters
  were added to record numbers before a rearchitecture; production source is
  unchanged. Killing their survivors (especially the worker / DAL DB-bound
  branches) is follow-up work.

[stryker]: https://stryker-mutator.io/
