<!-- cspell:ignore PQEF Twnkf -->

# OpenRouter cost attribution: why `cost_usd` is NULL on every codex call, and what to do about it

Status: design + interim implementation.
Scope: `services/orchestrator/src/engine/costs/**`, `engine/providers/codex*`,
`engine/workflow/plannerRunUsage.ts`, `engine/workflow/budgetPreflight.ts`,
`engine/dag/budgetGate.ts`.

---

## 1. The finding, restated with first-hand evidence

Tanren routes every agent role through `codex exec --json` pointed at OpenRouter
(`engine/credentials/codexMaterializer.ts` writes the `config.toml`
`[model_providers.openrouter]` block with `base_url` + `env_key`).

`engine/costs/recorder.ts` can only write a real dollar figure when a caller hands
it `realProviderCostUsd`. That value comes from `costs/generationCostCapture.ts`,
which needs OpenRouter's `gen-` generation id, which `providers/openRouterGenerationId.ts`
must find in codex's JSONL stream.

**It is not there.** Verbatim, live, from `codex-cli 0.145.0`:

```
$ printf 'Reply with exactly: ok' | codex exec --json --sandbox read-only \
    --skip-git-repo-check --cd <dir> -
{"type":"thread.started","thread_id":"019fc5dc-a605-7431-8a92-ed7c0d147d64"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
{"type":"turn.completed","usage":{"input_tokens":17665,"cached_input_tokens":11008,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
```

Read that carefully. Codex does not merely drop the response envelope — it mints
its own ids. `item.id` is `"item_0"`, an **ordinal**: even the upstream _item_ id
(`msg_…`) is discarded. `thread_id` is a codex-local UUID. And `usage` is five
token counters with **no cost field**.

I checked three further seams for the same id, all negative on 0.145.0:

| Seam                                                | Does it carry the upstream generation id?                                                                                                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex exec --json` stdout                          | **No** — vocabulary above; `findOpenRouterGenerationId` has nothing to match.                                                                                                                                     |
| `$CODEX_HOME/sessions/**/rollout-*.jsonl`           | **No** — `response_item` payloads carry item ids (`msg_`, `rs_`, `ctc_`); `token_count` payloads carry token counters + rate-limit windows. No response envelope, no cost.                                        |
| codex OTEL (`codex.sse_event`, `codex.api_request`) | **No** — attributes are token counts, `ttft_ms`, `service_tier`, `model_reasoning_effort`, HTTP status, and (on the ChatGPT-backend auth path only) `auth.request_id` / `auth.cf_ray`. No provider generation id. |
| `codex exec --help`                                 | No raw/passthrough event flag exists.                                                                                                                                                                             |

The only surface in the binary that hints at raw upstream events is the
**app-server** JSON-RPC protocol's `thread/start` parameter
`experimental_raw_events` — a different protocol, marked experimental, and one
tanren does not speak.

Meanwhile OpenRouter _does_ put both facts on the wire, in the very stream codex
is reading (MITM capture of codex's `base_url`):

```json
{
  "type": "response.completed",
  "response": {
    "id": "gen-1785730085-ifPQEF4jf7RVwCvTwnkf",
    "usage": { "input_tokens": 17665, "output_tokens": 5, "cost": 0.0011782784 }
  }
}
```

**Conclusion: the loss is inside the codex CLI, not at OpenRouter, and not in
tanren's parser.** `findOpenRouterGenerationId` is correct and is verified against
the real upstream envelope in the negative-control test; it simply never receives
one.

## 2. Why NULL cost is not cosmetic — the deadlock, proven

`engine/dag/budgetGate.ts` counts rows matching
`cost_usd IS NULL AND (billing_mode = 'per_token' OR billing_mode = 'unattributed')`
as `unpriced`, and any `unpriced > 0` sets `failClosed: "unpriced_spend"`.
A `credential/openrouter/` ref classifies as `per_token` (correctly — OpenRouter
is token-billed), so **every codex call on a budgeted project adds a row that
trips the gate**, and the rows are the run's own, so raising the ceiling cannot
remove them.

Proven against a real Postgres with the real `CostRecorder`, the real
`PgBudgetGate`, and the real codex bytes above
(`services/orchestrator/tests/openRouterCostAttribution.integration.test.ts`):
three recorded calls → `failClosed: 'unpriced_spend'` at ceilings of \$50, \$500,
\$50 000 and \$1 000 000 000. See §8 for the verbatim run.

Note the gate is **not wrong**. It is doing exactly what it was built to do:
refuse to let spend it cannot count run under a ceiling. The defect is that
tanren silently walks into that state, mid-run, after already spending money it
did not count, and then presents the operator with a pause whose only advertised
remedy (raise the ceiling) is inert.

## 3. Options considered

### A. Derive a fact from codex's own re-emitted `.usage.*`

**Rejected — there is no fact there.** Codex's `turn.completed.usage` is
`{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
reasoning_output_tokens}`. Tokens, no dollars. Converting tokens to dollars
requires a rate table, which is precisely the list-rate estimate
`engine/costs/sources.ts` forbids for `cost_usd` ("REAL SPEND IS A FACT
(binding)"). Those tokens already feed the _notional_ axis, which is the correct
home for a computed figure and where they already are.

### B. A local metering shim as codex's `base_url`

Architecturally available: tanren writes the `config.toml`, so it owns the
endpoint. A pass-through that observes `response.completed.id` /
`usage.cost` and reports it would give **exact per-call attribution** — the
highest fidelity of any option, and the only one that produces a per-call fact
rather than an apportioned one.

Weighed critically, and **rejected as the primary fix**:

- _Doctrine_: `scripts/check-architecture-substrate.mjs`'s `no-host-process-spawn`
  bans the **engine** importing `child_process`. A shim running on the **runner**
  over the SSH `CommandSubstrate` is the normal workload path and does not violate
  the letter of that rule. So the doctrine is not the blocker — the engineering is.
- _Blast radius_: it is inline on the critical path of every agent call. If the
  shim is not up, every role fails. Tanren's whole substrate story is "no host
  process management"; this reintroduces per-runner process supervision, health,
  restart and version-skew, for an accounting feature.
- _Security_: the shim must terminate the credential and see every prompt and
  completion in plaintext. That is a materially worse posture than today, where
  the key lives only in a chmod-600 env file the CLI reads.
- _Cost of being wrong_: a bug in the shim corrupts agent output, not just
  accounting.

It should stay on the table as the **fallback if upstream codex declines**, and
it is the only path to true per-call exactness. It is not something to ship as a
side effect of an accounting fix.

### C. Correlate against OpenRouter's own APIs without an id

**Rejected, and I want to be blunt about why.** OpenRouter exposes
`GET /api/v1/generation?id=` — _by id only_. There is no "list my recent
generations" endpoint to correlate against; the nearest thing (`/api/v1/activity`)
is **daily aggregate**, not per-call. So the only way to build this option is a
time-window heuristic over aggregates.

Even if such a listing existed: tanren runs many roles against one key, and many
runs concurrently against one project. Matching "a generation that finished around
when my call finished, costing about what my tokens suggest" is a **guess wearing
a fact's clothing** — it would be written into `cost_usd`, the column the doctrine
reserves for metered facts, and it would be indistinguishable from a real capture
downstream. This is worse than NULL, because NULL is honest and this is not.

### D. Per-run OpenRouter key + run-end key-usage reconcile

Genuinely interesting, and the only _exact_ option besides the shim. OpenRouter's
provisioning API (`POST /api/v1/keys` with a provisioning key) mints a key whose
object carries a cumulative `usage` in dollars, readable at
`GET /api/v1/keys/{hash}`. Mint one key per run, materialize it into the run's
`CODEX_HOME`, read `usage` at run end. **The key is the correlation handle**, so
there is no time window and no concurrency ambiguity: that number is exactly this
run's spend, reported by the biller. Apportioning it across the run's rows by
token share is the _same_ honesty contract tanren already ships for
`cost_basis='ccusage'` and `'credits'`, and `CostRecorder.applyReconcile` already
implements the apportion.

**Rejected for now, on one decisive structural ground and three practical ones:**

1. **It does not fix the deadlock.** A run-end reconcile leaves every row NULL
   _during_ the run. `checkIterationBudget` runs every loop iteration, so a
   budgeted project still trips `unpriced_spend` on its first codex call and parks
   before the reconcile ever happens. Making the gate ignore "rows pending
   reconcile" would be a fail-_open_ — assuming \$0 for spend we have not counted
   — which is exactly the hole `BUDGET-SAFETY C1/C1b` closed.
2. It requires a new credential kind (a provisioning key), which a BYOK tenant
   supplying a plain inference key cannot provide. Those tenants stay unattributable
   either way.
3. It is a live-API lifecycle (mint / materialize / read / revoke, plus every
   failure path) that I cannot test end-to-end here — no provisioning key is
   available in this environment. Shipping an untested live integration and
   calling it done would be the overstatement this exercise is trying to avoid.
4. OpenRouter's key `usage` is eventually consistent relative to the last
   generation; a reconcile fired the instant a run ends can under-read.

It remains the right **follow-up** for accurate _reporting_ (as a third reconcile
basis alongside ccusage and credits), and it is written up as such below. It is
not a budget-gate fix.

### E. Fix it upstream in codex, and ship an honest interim

**Chosen.**

The defect is one line of vocabulary in a CLI we do not own: `codex exec --json`
should surface the provider's response id (and, when the provider reports one, its
`usage.cost`) on `turn.completed`. Everything tanren needs is already built and
already tested — `openRouterGenerationId.ts`, `openRouterCost.ts`,
`generationCostCapture.ts`, `cost_basis='provider_response'` — and it all starts
working the day that id arrives. Building a second, worse capture path inside
tanren to route around a missing field in a dependency is the wrong shape.

So the interim's job is **not** to manufacture a number. It is to stop tanren
lying by omission:

- name the limitation, up front, in the run's own timeline;
- refuse to start a run under a ceiling it cannot enforce, instead of spending
  uncounted money and _then_ parking on a pause the operator cannot clear;
- tell the operator the remedy that actually works (set the limit on the
  OpenRouter key, where the biller enforces it);
- and fix the two _real, independent_ capture bugs found along the way, so that
  the day codex surfaces the id, capture works for BYOK too.

## 4. Recommendation (what is implemented)

### 4.1 A route-metering capability, stated once

New `engine/costs/meterability.ts`. `resolveRouteMetering({cli, authRef, hasUsageProbe})`
returns a discriminated result:

- `{ kind: "provider_response" }` — the route can capture a per-call fact (an
  OpenRouter credential on a harness that surfaces generation ids).
- `{ kind: "run_reconcile" }` — no per-call fact, but a run-end probe (ccusage /
  credit drawdown) prices the rows, and the gate does not count those NULLs as
  unpriced (they are `subscription`/`self_hosted`).
- `{ kind: "unmeterable", reason, detail }` — `reason` from a **closed** enum:
  - `harness_discards_generation_id` — the case in this document. `detail`
    carries the verified codex version, so a capability claim about someone
    else's software is always dated.
  - `byok_upstream_invoice` — a raw `credential/anthropic/` or
    `credential/openai-api/` key whose real charge lands on an invoice tanren
    cannot read. Pre-existing, previously unnamed.

The set of harnesses known to surface a generation id
(`HARNESSES_SURFACING_GENERATION_ID`) is **empty**, and that emptiness is the
finding rather than an oversight — every harness tanren drives re-emits its own
vocabulary. Adding one entry is the whole fix once a harness gains the capability.

A per*token route is judged the same way with or without a usage probe, and that
is deliberate: a run-end reconcile lands after the per-iteration gate has already
latched, so a probe cannot rescue a route whose rows are NULL \_during* the run.

This is the single place the limitation is written down, with its evidence, and
the single thing to delete when codex fixes it.

### 4.2 The preflight covers both failure modes

`engine/workflow/budgetPreflight.ts` already implemented the _symmetric_ safety
check (M6): a subscription/self-hosted credential with no usage probe means the
ceiling can never fire → **under**-enforcement → fail closed at setup with
`cost.ceiling_unreachable`. Its own comment says a `per_token` credential "prices
every call from the provider table (reachable)" — **that comment is stale**; the
static rate table was removed, so `per_token` no longer prices anything without a
captured fact.

The check is generalized to `assertBudgetCeilingEnforceable`, covering both:

|                        | credential                           | consequence                                                 | verdict              |
| ---------------------- | ------------------------------------ | ----------------------------------------------------------- | -------------------- |
| unreachable (existing) | subscription / self-hosted, no probe | ceiling never fires                                         | fail closed at setup |
| **unmeterable (new)**  | `per_token` on an unmeterable route  | every row NULL → gate fails closed permanently, unclearable | fail closed at setup |

New event `cost.ceiling_unenforceable` (payload: `refKind`, `cli`, `billingMode`,
`ceilingUsd`, `reason`, `remedy`) and `UnenforceableBudgetCeilingError`, whose
message names the route, says in as many words that **raising the ceiling will not
help**, and points at the remedy that does work: set the spend limit on the
OpenRouter key itself.

Refusing at setup is strictly better than parking mid-run: no runner is burned and
no uncounted money is spent. `UnreachableBudgetCeilingError` is retained as a
subclass alias so existing catchers and tests keep working.

### 4.3 Narrate the route on every run, not just budgeted ones

New `cost.route_unmeterable`, emitted once at run setup whenever the route cannot
produce per-call facts — **including when no ceiling is set**. Today an operator on
an unbudgeted project gets no signal at all that `cost_usd` will be NULL for the
entire run; they discover it when they look at a spend report and see zero.

### 4.4 Two real, independent capture bugs — fixed

**(a) `plannerRunUsage.ts:31-38` disables capture for BYOK. It should not.**
`buildManagedCapturerForRun` builds the OpenRouter cost capturer only when
`input.context.endpointBaseUrl !== undefined`. That flag means "tanren-managed
platform endpoint", but it is being used as a proxy for "is there a metering
credential". A tenant-supplied `credential/openrouter/` key _is_ a metering
credential: OpenRouter bills that key's owner, so `total_cost` is the real
deduction from the tenant's OpenRouter balance.

Two different meanings of "BYOK" are conflated:

- tanren-BYOK — the _tenant's_ credential rather than the platform's. Says nothing
  about who OpenRouter bills.
- OpenRouter-BYOK — the tenant has attached their own _upstream provider_ keys
  inside OpenRouter, so OpenRouter charges only a routing fee and the real
  inference cost lands on the upstream provider's invoice.

`openRouterCost.ts` correctly refuses to record a figure in the second case — but
it decides which case it is from a **caller-declared flag** (`billingModel`) fed
by the _first_ meaning. That is a guess in the shape of a fact.

Fixed both ways: the capturer is built whenever the run routes through OpenRouter
with an OpenRouter credential (the same predicate `codexMaterializer.ts` uses:
managed **or** `providerSlugForRef(ref) === "openrouter"`), and the
upstream-billed determination becomes **data-driven** — OpenRouter's own
`cost_details.upstream_inference_cost` on the generation record. A positive value
means the account was charged only a routing fee, so `total_cost` is _not_ the
whole real spend and is refused as authoritative (NULL + loud), exactly as before
but for a checkable reason instead of a declared one.

This changes no behavior today (there is still no generation id to query with),
but it means the capture path is _correct_ when codex is fixed, rather than
correct-only-for-managed.

**(b) `plannerRunUsage.ts:88` fires a spurious `usage.read_failed` every preflight.**
`defaultUsageProbe` wires the codexbar subscription-window monitor when
`endpointBaseUrl === undefined`. The intent (per its own comment) is "wire it only
for a BYOK _ChatGPT-subscription_ run, because a run routed through OpenRouter has
no account window and codexbar exits nonzero by design". But a BYOK
`credential/openrouter/` run — the common deployment — has no `endpointBaseUrl`
either, so it gets the monitor, codexbar exits nonzero, and every pre-flight emits
a spurious `usage.read_failed`. Fixed by gating on the credential actually being a
ChatGPT bundle (`credential/codex/`), which is what "has an account window"
literally means.

### 4.5 Operator legibility

`ProjectBudgetState` / `BudgetView` gain `unpricedCount` — the gate already
computes it and then throws it away. `failClosed: "unpriced_spend"` with
`unpricedCount: 47` tells an operator what a bare boolean cannot.

### 4.6 Drift detection in the other direction

`subtaskCost.ts`'s `captureRealProviderCostUsd` silently returns `null` when no
generation id is present. On a route classified **meterable**, that silence is the
symptom of exactly the regression this document is about. It now emits
`cost.generation_id_missing` (once per run — the flag lives on the cost context)
so the day codex's vocabulary changes again, tanren says so instead of quietly
reverting to NULL.

## 5. The `role` column decision

**Decision: do not add a `role` column in this change. Put role in
`cost_source_raw` and put the real model id in `model`.**

Rationale:

- Migrations here are one-owner-one-slot by contract, and another workstream may
  want the slot. This change should not consume it for a field that has a
  zero-migration home.
- `cost_records.cost_source_raw` is already `jsonb NOT NULL DEFAULT '{}'`, already
  written by `CostRecorder.record`, and already carries provenance (`authRef`,
  `billingMode`, `costBasis`, `provider`, `rawUsage`). `role` is provenance. It
  belongs there.
- The _actual_ harm of the status quo is not the missing column — it is that role
  is being smuggled through `model`. All eight answerer/writer sites write
  `"tanren-writer"`, `"tanren-planner"`, … into `cost_records.model`. Those are
  not model ids. `computeNotionalUsd` looks them up in the LiteLLM price source,
  finds nothing, and returns NULL — so **`notional_cost_usd` is structurally NULL
  in every deployment**, and `cost.notional_unpriced` fires on 100% of rows,
  which trains operators to ignore it.

  That is doubly bad here: notional is the _only_ axis that still works when real
  spend is unmeterable. Fixing it is what gives an operator a usable number today.

So: `CostRecordContext` gains `role`, stamped into `cost_source_raw`; the adapters
expose the model id they actually send (`AnswererAdapter.model` / `WriterAdapter.model`,
**optional** so the ~40 test fixtures that implement these interfaces need no
change), and the eight call sites pass it. An adapter that declares no model (a
`fake` fixture) records `model: ""`, which the recorder already treats as the
honest "no model id → notional NULL, stay quiet" path.

If a `role` column is later wanted for indexed group-by reporting, it is a clean
backfill from `cost_source_raw->>'role'`. Recommended as a follow-up with its own
migration slot, not smuggled into this one.

## 6. What remains unattributable under this design

First, so the ledger is balanced, what this change **does** recover:

- The **notional axis**, which was structurally NULL in every deployment because
  role was smuggled through `model` (§5). Real codex rows now carry a real model
  id, so `notional_cost_usd` is computed from real LiteLLM rates and
  `cost.notional_unpriced` stops firing on 100% of rows. That is not real spend —
  it is a computed list value — but it is the only usable number an operator gets
  on an unmeterable route, and it was broken.
- The **correctness** (not the reachability) of the per-call capture path for BYOK
  OpenRouter, and the removal of a caller-declared guess in favour of OpenRouter's
  own `upstream_inference_cost` (§4.4).
- The **spurious `usage.read_failed`** on every BYOK-OpenRouter pre-flight (§4.4b).

Now the part that matters, stated plainly:

1. **Every codex-routed call still records `cost_usd = NULL`.** This change does
   not recover a single dollar of real spend. It cannot: the number is destroyed
   inside a CLI tanren does not own. Anyone reading this design hoping for
   "OpenRouter costs now show up in tanren" should stop here — they do not.
2. **A budgeted project on a codex→OpenRouter route still cannot run.** It now
   refuses at setup with a precise reason instead of deadlocking mid-run, which is
   better, but the capability is not restored. The honest remedy is an OpenRouter
   key spend limit, enforced by the biller.
3. **BYOK `credential/anthropic/` and `credential/openai-api/` keys stay
   unattributable** (`byok_upstream_invoice`) — the charge lands on an invoice
   tanren cannot read. Unchanged, now named.
4. **OpenRouter-BYOK (tenant upstream keys attached inside OpenRouter) stays
   partially unattributable** even once the id flows: `total_cost` is the routing
   fee, and the inference cost is on the upstream provider's bill. The design now
   _detects_ this from `upstream_inference_cost` and refuses to record the partial
   figure, rather than under-counting.
5. **Per-call exactness is unreachable without either the codex fix or the shim.**
   Option D would give exact _run-level_ totals, apportioned to rows — good enough
   for reporting, not for the in-run gate.

## 7. Can a ceiling now be safely set?

- **On a codex→OpenRouter project: no**, and tanren now says so at setup rather
  than discovering it three calls in. Set the limit on the OpenRouter key.
- **On a subscription (`credential/codex/`) project with a usage probe: yes**,
  unchanged — ccusage / credit drawdown reconcile prices those rows at run end.
- **On a route with a per-call capture path: yes** — and after §4.4(a) that
  correctly includes BYOK OpenRouter, once codex surfaces the id.

The gate itself was never unsafe. It was illegible.

## 8. The negative control, verbatim

`services/orchestrator/tests/openRouterCostAttribution.integration.test.ts`, real
Postgres, real `CostRecorder`, real `PgBudgetGate`, real codex bytes.

**BEFORE** (unfixed code; part C removed, because
`assertBudgetCeilingEnforceable` did not exist yet — the module-load failure was
itself the proof):

```
$ DATABASE_URL=postgres://tanren:tanren@localhost:5432/tanren TANREN_RLS_DB_TEST=1 \
    pnpm exec vitest run …/openRouterCostAttributionBefore.integration.test.ts

 ✓ A. … > OpenRouter DOES surface the id + the real cost upstream 1ms
 ✓ A. … > codex exec --json surfaces NO generation id — so per-call capture can never fire 0ms
 ✓ A. … > codex's re-emitted usage carries NO cost field — no fact is derivable from it 4ms
 ✓ B/C. … > every codex→OpenRouter row lands cost_usd NULL / per_token / unknown 1ms
 ✓ B/C. … > the run's OWN rows trip failClosed 'unpriced_spend' 7ms
 ✓ B/C. … > RAISING THE CEILING DOES NOT CLEAR IT — the project self-deadlocks 30ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

The deadlock is real: three recorded calls, then `failClosed: 'unpriced_spend'`
at every ceiling tried — \$50, \$500, \$50 000, \$1 000 000 000.

**AFTER** (same file, part C restored):

```
 ✓ A. … > OpenRouter DOES surface the id + the real cost upstream
 ✓ A. … > codex exec --json surfaces NO generation id — so per-call capture can never fire
 ✓ A. … > codex's re-emitted usage carries NO cost field — no fact is derivable from it
 ✓ B/C. … > every codex→OpenRouter row lands cost_usd NULL / per_token / unknown
 ✓ B/C. … > the run's OWN rows trip failClosed 'unpriced_spend', and the count is now legible
 ✓ B/C. … > RAISING THE CEILING DOES NOT CLEAR IT — the project self-deadlocks
 ✓ B/C. … > C. THE FIX: the run-setup preflight refuses the run, naming the route limitation
 ✓ B/C. … > C. NON-VACUOUS: the same preflight PASSES a route whose spend can be judged
 ✓ B/C. … > C. and it stays out of the way when NO ceiling is configured
```

Read the AFTER honestly. Rows B are **unchanged** — they still land NULL, and the
gate still latches. What changed is that the run never gets there: the preflight
refuses at setup with `cost.ceiling_unenforceable` and an error that says
`RAISING THE CEILING WILL NOT CLEAR THE PAUSE` and names the remedy. The two
NON-VACUOUS cases exist so the refusal cannot be mistaken for "throws at
everything": a subscription route with a probe passes, and an unbudgeted project
on the same unmeterable route still runs.

## 9. Follow-ups (not implemented here)

1. **Upstream**: file the codex issue — surface the provider response id and
   `usage.cost` on `turn.completed` in `codex exec --json`. That single change
   turns this whole document off; `resolveRouteMetering`'s
   `harness_discards_generation_id` branch is then deleted and every existing
   tanren capture module starts working unmodified.
2. **Option D as a reporting basis**: per-run OpenRouter key + `GET /api/v1/keys/{hash}`
   usage delta as a third `applyReconcile` basis (`cost_basis='provider_response'`,
   apportioned by token share). Accurate run totals; still not an in-run gate.
3. **`role` column** with its own migration slot, backfilled from
   `cost_source_raw->>'role'`.
4. **The shim**, only if upstream declines.
