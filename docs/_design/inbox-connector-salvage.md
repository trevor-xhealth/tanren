# Salvage assessment — the three abandoned inbox-connector branches

Assessed against `origin/main` at `8fa80c42`.

Branches (on the maintainer fork of this repository):

| branch                        | tip        | date       |
| ----------------------------- | ---------- | ---------- |
| `feat/sentry-inbox-connector` | `8d2241cf` | 2026-05-29 |
| `feat/linear-inbox-connector` | `1407e74a` | 2026-05-29 |
| `feat/jira-inbox-connector`   | `5c6d9d72` | 2026-05-29 |

## 0. Two facts that reframe the whole exercise

**(a) The branches do not share history with `main`.** `git merge-base origin/main <branch>`
exits 1 for all three — there is no common ancestor. `main`'s root commit is
`95bfb983` (`feat(integrations): IntegrationStateWriter control-plane + data-plane
de-priv (in-4, codex terra) (#1000)`); the branches' root is `6c51afd3`
(`chore: scaffold hello-world baseline`). The repository history was rebuilt.
"~220 commits behind" understates it: these branches are on a _retired history
line_. There is no rebase path. Any salvage is a re-application, not a merge.

**(b) All three connectors were merged, and two were then deliberately deleted.**
The Jira branch's own history contains `6eba20e6 Merge pull request #116 from
cat-cave/feat/linear-inbox-connector`, so Linear reached the old `main`. The
Sentry connector survives on today's `main` in evolved form. Linear and Jira do
not — and `main` records why, verbatim, in
`services/orchestrator/src/engine/forge/inbox/connectorErrors.ts:26-29`:

> An `issues` source asked for a provider/credential shape that Tanren does not
> support. **Linear/Jira bare-token intake was deleted rather than adapted onto the
> integration-grant plane**; this error keeps a persisted stale config from being
> mistaken for a transient GitHub failure.

This is evidence, not inference. The branches were not abandoned for lack of
interest; they were landed and then _reverted as a class_ because their auth
model was superseded.

## 1. What each branch actually built

All three share one design, authored in sequence over ~50 minutes:

- A `SourceConnector` (`{ kind, fetch(source) }`) per provider.
- A strict Zod config schema carried in `inbox_sources.config`, **including a
  `tokenRef` naming a secret-store entry**.
- An injectable `<Provider>HttpClient` transport plus a `Fetch<Provider>HttpClient`
  production impl, so tests drive a fake.
- A mapping to `IngestedItem` (`externalId`, `title`, `body`, `severity`,
  `projectId`), with a provider-stable `externalId` for idempotent re-poll.
- Registration in the connector `Map` keyed by `SourceKind`.

Per branch:

**Sentry** (`8d2241cf`, +356 / 4 files). `GET /api/0/projects/{org}/{project}/issues/`
with `query=is:unresolved`, `statsPeriod=14d`, Bearer token. Severity from Sentry
`level` (fatal/error→fail, warning→warn, else→info). Title falls back
title→culprit→metadata.value→shortId; body composed from permalink, culprit,
`type: value`, level, event count, users affected. `externalId = sentry-<id>`.
Wired under the existing `errors` kind. 6 tests appended to `candidateInbox.test.ts`.

**Linear** (`1407e74a`, +552 / 6 files). `POST https://api.linear.app/graphql` with
the token sent raw in `Authorization` (correct for Linear personal API keys).
Query `issues(filter, first: 50, orderBy: updatedAt)` selecting
`id/identifier/title/description/url/priority/labels`. Filter
`state.type nin [completed, canceled]`, optionally scoped by `team.id` / `project.id`;
label filtering done client-side. Severity from a bug/regression/critical label
first, then priority (1→fail, 2→warn), then perf/warn labels. `externalId =
linear-<uuid>`. Its structural contribution is `issuesConnector.ts`: a **provider
dispatcher** under the `issues` kind that reads `config.provider` (defaulting to
`github` when absent) and delegates. New test file, 9 tests.

**Jira** (`5c6d9d72`, +563 / 6 files). `POST /rest/api/3/search` with HTTP Basic
(`email` + API token). Config takes either an explicit `jql` or `project`/`status`.
Body from an ADF-or-plain description plus the Jira URL; `externalId = jira-<key>`.
Extends the same dispatcher to a third arm. New test file, 12 tests.

Every test is a real connector driven through a recording stub transport — no
`vi.mock`. That part of the work was sound and matches today's house style.

## 2. How much still applies

`services/orchestrator/src/engine/forge/inbox/` on `main` today:

| branch file                                                   | status on `main`                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| `sentryConnector.ts`                                          | **exists, superseded in place** — 203 → 265 lines             |
| `githubConnector.ts`                                          | exists, rewritten (credential resolution moved out of config) |
| `index.ts`                                                    | exists, re-exports a different surface                        |
| `issuesConnector.ts` (dispatcher)                             | **deleted** — replaced by `connectorMap.ts`                   |
| `linearConnector.ts`                                          | **deleted**                                                   |
| `jiraConnector.ts`                                            | **deleted**                                                   |
| `candidateInboxLinear.test.ts` / `candidateInboxJira.test.ts` | **deleted**                                                   |
| `routes/inbox/index.ts` connector wiring                      | moved to `engine/forge/inbox/connectorMap.ts`                 |

What survives conceptually:

- **The `SourceConnector` seam is unchanged.** `{ readonly kind: SourceKind; fetch(source): Promise<IngestedItem[]> }`
  in `types.ts:265` is exactly the shape the branches targeted.
- **`IngestedItem` is unchanged** (`types.ts:254`), including the
  `externalId`-as-idempotency-key contract.
- **The response-mapping logic is directly reusable.** Compare the branch's Sentry
  `severityFromLevel`/`titleFor`/`bodyFor`/`buildPath` with `main`'s: they are
  byte-identical. `main` kept the branch's mapping wholesale and replaced only the
  auth and the error handling. That is the strongest possible evidence that the
  _mapping_ half of the Linear/Jira work is still good.

What is superseded:

- **Auth.** `tokenRef` in source config is now an actively-rejected shape.
  `assertNoSourceCredentialOverride` (`connectorErrors.ts:47`) walks the config
  recursively and throws `UnsupportedInboxProviderError` on any `tokenRef`,
  `staticRef`, `credentialRef`, or `githubCredentialRef` key, at _source creation_
  and again at _connector boundary_, before any secret read or provider I/O.
  Credential authority is now org-bound: Sentry resolves an exact
  `EligibleOperationLease` per fetch via `PgIntegrationAuthority.authorizeOperation`
  and reads a generation-addressed secret via `secretValueForLease`.
- **The `provider` discriminator.** `assertSupportedIssuesProvider`
  (`connectorErrors.ts:72`) throws on _any_ `provider` key — including
  `provider: "github"` — with "the provider discriminator was removed; kind
  'issues' is the sole GitHub authority".
- **Silent degradation.** All three branches `return []` on a non-200. `main`
  forbids this: `assertIntakeResponseOk` (`connectorErrors.ts:181`) classifies
  401/403 → `IntakeSourceAuthError`, 429 → `IntakeSourceRateLimitError`,
  other stable 4xx → `IntakeSourceResourceError`, else `IntakeSourceFetchError`;
  a 200 whose body is not the expected array is also a loud throw. Only a genuine
  200-with-an-empty-array is "no issues".
- **Source lifecycle.** `main` added `state`/`attention`/`retryNotBefore` to
  `inbox_sources` (migration `0043`). A source that hits a permanent failure is
  _parked_ at `needs_attention` with a sanitized code
  (`classifyPermanentInboxSourceError`, `intake/issueSourceSeam.ts:99`) rather than
  retried forever.
- **One canonical persisted config.** `InboxSource` is now a `discriminatedUnion` on
  `kind`, each arm carrying exactly one strict config schema
  (`ActiveGitHubIssuesConfig`, `ActiveSentryConfig`, …). A `passthrough()` probe
  schema like the branch's `ProviderProbe` no longer type-checks against it.

## 3. Why each was abandoned

**Sentry — superseded by its own descendant.** Not abandoned in any meaningful
sense. It merged, and the integration-lifecycle work then rewrote its auth onto
the grant plane and its error handling onto the no-silent-fallbacks doctrine,
keeping the mapping verbatim.

**Linear and Jira — deleted, for a stated reason.** `connectorErrors.ts:26-29`
says it outright: bare-token intake was _deleted rather than adapted_. The two
connectors fought three invariants that landed after them:

1. **Org-scoped credential resolution.** `tokenRef` in source JSON lets a source
   row name any secret. `inboxSourceCreation.test.ts:280` ("rejects a foreign-org
   staticRef before persistence, secret resolution, or provider I/O") pins the
   confused-deputy case this creates.
2. **One canonical persisted config per kind.** The `ProviderProbe` +
   `.passthrough()` dispatcher is the opposite of a discriminated union with strict
   arms.
3. **Fail-closed intake.** `return []` on non-200 made a bad Linear token
   indistinguishable from an empty backlog.

Adapting them was a larger job than deleting them, and the Sentry adaptation had
to be done regardless. Deleting was the cheaper correct move. This is a
deliberate, documented removal — not neglect.

## 4. Verdicts

| branch                        | verdict                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat/sentry-inbox-connector` | **Discard.** Already on `main`, strictly better. There is nothing left to salvage; re-landing it would be a regression.                                                                                                                                                                                 |
| `feat/linear-inbox-connector` | **Harvest the design, rebuild the code.** The GraphQL query, the filter construction, the priority/label→severity mapping, and the `externalId` scheme are all still correct and worth copying. The auth, the dispatcher, the config schema, and the error handling must be rebuilt on the grant plane. |
| `feat/jira-inbox-connector`   | **Harvest the design, defer.** Same verdict as Linear, one tier lower in value. Jira Cloud's Basic-auth `email` + API token maps onto the grant plane less cleanly than Linear's single bearer token (the principal is an _account_, not an org), so it should follow Linear rather than accompany it.  |

## 5. Which connector to build, and why not Sentry

The brief's prior was that Sentry is the higher-value target. **That prior is
superseded by the code**: Sentry intake is already complete on `main` —
`sentryConnector.ts` (265 lines) resolves an exact integration lease per fetch,
`connectorMap.ts:55` wires it under `errors`, `integrationCatalog.ts:81` registers
the provider with an `errors.intake` operation, and `inboxConnectorWire.test.ts`
pins its wire shape and normalisation across 26 tests. Building Sentry again
produces nothing.

**Linear is the only one of the three that is genuinely absent**, and it is the
one the roadmap-intake capability needs.

### The migration question — answered

Adding Linear needs **no migration**:

- `inbox_sources.kind` _is_ CHECK-constrained
  (`db/src/schemaInbox.ts:66`: `IN ('issues','errors','system','manual','scheduled_audit')`),
  so a **new `SourceKind` would need a migration**. Linear therefore goes under the
  existing `issues` kind — as the abandoned branch's title said, and for a better
  reason than the branch had.
- `provider_kind` and `capability` are plain `text` with **no CHECK constraint and
  no enum type** anywhere (`db/src/schemaIntegrationConnections.ts:25,73,115,209,266`,
  `schemaIntegrationSelection.ts:20`, `schemaIntegrationRequirements.ts:28`). The
  provider registry is a TypeScript union plus a code-level catalog array in
  `services/orchestrator/src/engine/contracts/integrationCatalog.ts`.
- `intake` is already a member of `IntegrationPrivilegedOperation`
  (`contracts/integrationAuthority.ts:33`).
- `INTEGRATION_POLICY_CATALOG_REVISION` does **not** need bumping. It is compared
  per-grant (`integrationAuthorityImpl.ts:164`, `stale_policy_revision`); a purely
  additive provider entry changes no existing provider's required scopes, so
  existing Slack/Sentry grants stay eligible.

So the migration slot held by the sibling agent is not needed, and was not taken.

## 6. Design of the rebuilt Linear connector

### The `provider` discriminator, reinstated deliberately

`assertSupportedIssuesProvider` currently rejects _every_ `provider` key. The
reason given is that with one provider, an optional `provider: "github"` was a
redundant second authority for a fact the kind already stated. That reasoning is
correct **while `issues` has exactly one provider** and stops being correct the
moment it has two.

The rebuilt rule keeps the intent (one canonical shape, no second authority) while
admitting a second provider:

- **Absent `provider` ⇒ GitHub.** Existing rows and existing callers are untouched;
  `ActiveGitHubIssuesConfig` is unchanged.
- **`provider: "linear"` ⇒ Linear**, with `ActiveLinearIssuesConfig` as its one
  strict shape.
- **`provider: "github"` is still refused.** The redundant-second-authority
  objection applies to it specifically and still holds.
- **Every other `provider` value is refused**, fail-closed, at source creation
  (400 `unsupported_inbox_provider`, nothing persisted) and again at the connector
  boundary before any credential or provider I/O.
- **Any `tokenRef`/`staticRef`/`credentialRef` key is still refused**, on both
  arms. `assertNoSourceCredentialOverride` is untouched.

### Credential resolution

Identical in structure to Sentry, one provider along:

```
LinearIntakeAuthority({ orgId, projectId, resourceId })
  → PgIntegrationAuthority.authorizeOperation({
      providerKind: "linear", capability: "issues",
      operation: "intake", target: { resourceId }, actor: systemActor })
  → orgGrantFromLease → assertOrgGrantMatchesLease
  → secretValueForLease(GenerationAddressedIntegrationSecretStore, …)
```

The source config carries no credential coordinate. `resourceId` is the Linear
team key, which is what the grant's resource constraints scope against.

### Error handling

`assertIntakeResponseOk("linear", status, …)` for transport status, then an
explicit GraphQL-envelope check: a 200 carrying a non-empty `errors[]`, or lacking
`data.issues.nodes`, is an `IntakeSourceFetchError`. GraphQL's habit of returning
200 for application errors is exactly the silent-degrade this doctrine forbids, so
it gets its own loud path rather than falling through to "no issues".

### No caps, no polling knobs

`scripts/check-architecture-timeouts.mjs` bans cap-shaped identifiers and
retry/timeout caps. The connector adds none: no retry loop, no backoff, no
attempt counter. `first: 50` in the GraphQL query is a page size on a single
request (the same shape as GitHub's `per_page=50` and Sentry's `statsPeriod=14d`),
not a retry cap. Rate limiting is surfaced as `IntakeSourceRateLimitError` and
scheduled by the durable intake poller, which already owns that concern.

## 7. What this change lands, and what it does not

**Landed** — Linear roadmap intake, end to end from an operator-created source to
persisted candidates:

1. `integrationCatalog.ts` — `linear` provider, `issues` capability,
   `discover`/`bind`/`intake` operations. No catalog-revision bump: the entry is
   purely additive, so no existing grant becomes stale.
2. `linearPrincipalVerifier.ts` (new file — `principalVerifiers.ts` is at 453
   lines and a fifth verifier would breach the 500-line cap) — one authenticated
   GraphQL round trip that resolves the workspace as a stable `organization`
   principal AND proves the `read` scope by performing the same issue read
   `intake` will perform. Registered in `hasPrincipalVerifier` /
   `principalVerifierFor`.
3. `types.ts` — `ActiveLinearIssuesConfig` + `ActiveIssuesConfig`; the `issues`
   arm of `InboxSource` becomes a two-shape union, and the create/persist config
   decoders dispatch through the same fail-closed provider resolver.
4. `connectorErrors.ts` — `resolveIssuesProvider` (the one authority on "which
   provider is this") and `assertIssuesProviderIs` (each connector's own
   boundary check); `IntakeSourceProvider` gains `"linear"`.
5. `linearConnector.ts` — the connector, on the grant plane.
6. `issuesDispatcher.ts` + `connectorMap.ts` — the `issues` slot selects GitHub
   or Linear, with an unconfigured Linear authority failing loud rather than
   yielding a connector that quietly reads nothing.
7. `issueSourceSeam.ts` — a Linear source no longer forces GitHub credential
   resolution (an org that polls Linear and never installed the GitHub App is a
   legitimate configuration); the Pg Linear intake authority is threaded through.
8. `routes/inbox/sourceRecovery.ts` — a parked Linear source repairs against its
   integration grant, not the org GitHub credential.
9. `dashboard/src/api/integrations.ts` + `components/integrations/format.ts` —
   Linear is linkable and labelled, so an operator can actually connect the
   workspace the connector then reads.

**Not landed, and specified here instead:**

- **A Linear _provisioner_.** Sentry has `sentryProvisioner.ts` for creating
  projects and client keys. Linear intake needs none — it reads an existing
  workspace — so `provision` is deliberately absent from the catalog entry. If
  Tanren later wants to _create_ Linear issues (the write direction of the
  error→fix loop), that is a `provision`/`bind` workstream of its own.
- **The dashboard create-source form.** `services/dashboard/src/components/inbox`
  offers no provider selector; a Linear source is creatable through
  `POST /orgs/:orgId/inbox/sources` today. The surface work is a separate change
  with its own visual review.
- **Webhook intake.** GitHub `issues` sources support webhook provisioning
  (`routes/inbox/webhookProvision.ts`). Linear webhooks are a distinct
  authenticated callback shape and should follow the polling path landing first.
- **Jira.** Per §4.
- **A live-credential integration test.** See §8.

## 8. Honest limits

The connector has **not** been exercised against the real Linear API. Every test
drives the real connector through a recording stub transport with a hand-built
payload matching Linear's documented GraphQL response envelope. The mapping,
the request shape, the auth-header form, the error classification, and the
fail-closed gate are all proven; **that Linear's live API returns precisely this
envelope is not.** The first live run should be treated as the real integration
test. This is the same evidentiary standard the Sentry connector on `main` meets
— `inboxConnectorWire.test.ts` is also stub-driven — so it is not a regression in
rigour, but it is a real gap and it is worth closing with a credentialed
smoke test before anyone depends on Linear intake in anger.
