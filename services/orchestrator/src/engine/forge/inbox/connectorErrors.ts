/* eslint-disable max-classes-per-file -- one cohesive exported intake error taxonomy */
// Intake source-connector fetch errors (no-silent-fallbacks doctrine).
//
// A source connector (`github`/`sentry`) pulls open issues over
// HTTP. The binding doctrine: a credential/auth or transport/HTTP failure is a
// LOUD hard failure, NEVER a quiet degrade to "no issues" (an empty list). Only a
// genuine 200-with-an-empty-list is an empty result.
//
// The prior connectors returned `[]` on ANY non-200 (or a 200 with an
// unparseable body), so a 401 ("bad token") or a 500/transport error looked
// identical to "the project has no open issues" — silently breaking issue
// triage. These two error types make that distinction first-class:
//   • {@link IntakeSourceAuthError} — a 401/403: the credential is missing,
//     expired, or denied. A CREDENTIAL-RESOLUTION failure (a misconfiguration),
//     so the intake poller re-throws it LOUDLY at the tick boundary rather than
//     retrying forever (see `isCredentialResolutionError`).
//   • {@link IntakeSourceFetchError} — any OTHER unexpected response (a 5xx, a
//     rate-limit, an unparseable 200 body): the fetch FAILED, so it is not "no
//     issues". The poller logs it and retries on the next due tick (a genuine
//     transient), but the connector never swallows it as an empty list.

/** The connectors that pull from an external issue/error source. */
export type IntakeSourceProvider = "github" | "sentry" | "linear";

/** The issue-tracker providers the `issues` source kind dispatches to. */
export type IssuesProvider = "github" | "linear";

/**
 * An `issues` source asked for a provider/credential shape that Tanren does not
 * support. Bare-token intake (a source-owned `tokenRef`) was deleted rather than
 * adapted onto the integration-grant plane, and Jira has not yet been adapted;
 * this error keeps a persisted stale config from being mistaken for a transient
 * GitHub failure.
 */
export class UnsupportedInboxProviderError extends Error {
  readonly retriable = false as const;
  readonly requestedProvider: string | null;

  constructor(requestedProvider: string | null, detail: string) {
    super(`unsupported inbox provider configuration: ${detail}`);
    this.name = "UnsupportedInboxProviderError";
    this.requestedProvider = requestedProvider;
  }
}

/**
 * Reject caller/source-owned reusable credential coordinates before any secret
 * or provider I/O. Credential selection belongs to the source's organization,
 * never to JSON stored on an inbox source.
 */
export function assertNoSourceCredentialOverride(config: unknown): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (["tokenRef", "staticRef", "credentialRef", "githubCredentialRef"].includes(key)) {
        throw new UnsupportedInboxProviderError(
          null,
          `source-owned ${key} authority is not supported; use the organization-bound credential`,
        );
      }
      visit(child);
    }
  };
  visit(config);
}

/**
 * Resolve which issue-tracker connector an `issues` source belongs to, fail-closed.
 *
 * The `issues` kind serves more than one provider, so SOMETHING must discriminate.
 * The rule is deliberately asymmetric:
 *   • NO `provider` key ⇒ GitHub. GitHub predates the discriminator and every
 *     persisted GitHub row omits it; `ActiveGitHubIssuesConfig` stays untouched.
 *   • `provider: "linear"` ⇒ Linear, whose one canonical shape carries it.
 *   • `provider: "github"` is STILL refused. When `issues` served GitHub alone the
 *     key was a redundant second authority for a fact the kind already stated —
 *     that objection is specific to GitHub and survives Linear's arrival.
 *   • Every other value — a deleted provider (`jira`), a typo, a non-string — is a
 *     LOUD refusal. Widening the kind must not widen it to anything.
 *
 * Source-owned credential coordinates are rejected first, on every arm.
 */
export function resolveIssuesProvider(config: unknown): IssuesProvider {
  assertNoSourceCredentialOverride(config);
  if (typeof config !== "object" || config === null || Array.isArray(config)) return "github";
  const record = config as Record<string, unknown>;
  if (!Object.hasOwn(record, "provider")) return "github";
  const provider = record["provider"];
  if (provider === "linear") return "linear";
  throw new UnsupportedInboxProviderError(
    typeof provider === "string" ? provider : null,
    provider === "github"
      ? "the provider discriminator was removed for GitHub; kind 'issues' with no provider is the sole GitHub authority"
      : `issues sources support only GitHub (no provider) and Linear (provider 'linear') (received ${typeof provider === "string" ? `'${provider}'` : "a non-string provider"})`,
  );
}

/** Reject an `issues` config whose provider/credential shape is unsupported. */
export function assertSupportedIssuesProvider(config: unknown): void {
  resolveIssuesProvider(config);
}

/**
 * Assert an `issues` config belongs to THIS connector before it does any work.
 * The dispatcher already routed by provider; a connector that trusted that alone
 * would silently mis-read a config it does not own if the map were ever mis-wired.
 */
export function assertIssuesProviderIs(expected: IssuesProvider, config: unknown): void {
  const actual = resolveIssuesProvider(config);
  if (actual !== expected) {
    throw new UnsupportedInboxProviderError(actual, `the ${expected} issues connector cannot read a ${actual} source`);
  }
}

/** A selected integration authority is permanently unavailable for this source. */
export class IntakeSourceAuthorityError extends Error {
  readonly retriable = false as const;
  readonly provider: IntakeSourceProvider;

  constructor(provider: IntakeSourceProvider, detail: string) {
    super(`${provider} intake source authority unavailable: ${detail}`);
    this.name = "IntakeSourceAuthorityError";
    this.provider = provider;
  }
}

/**
 * A 401/403 from an intake source: the credential is missing, expired, or denied.
 * This is a CREDENTIAL-RESOLUTION failure (a misconfiguration the operator must
 * fix — rotate/re-grant the token), so `isCredentialResolutionError` classes it
 * with the GitHub credential errors and the poller re-throws it LOUDLY. NOT a
 * silent empty fetch.
 */
export class IntakeSourceAuthError extends Error {
  readonly retriable = false as const;
  readonly provider: IntakeSourceProvider;
  readonly status: number;

  constructor(provider: IntakeSourceProvider, status: number, detail: string) {
    super(
      `${provider} intake source: authentication failed (HTTP ${status}) — ${detail}. ` +
        `The credential is missing, expired, or denied; this is NOT "no issues". ` +
        `Rotate or re-grant the source's token.`,
    );
    this.name = "IntakeSourceAuthError";
    this.provider = provider;
    this.status = status;
  }
}

/**
 * An unexpected non-200 (or a 200 with a body that does not parse to the expected
 * shape) from an intake source: the fetch FAILED, so the result is unknown — it is
 * NOT a genuine empty list. A transient (a 5xx, a rate-limit, a malformed body);
 * the poller logs it and retries next tick, but the connector never degrades it to
 * `[]`.
 */
export class IntakeSourceFetchError extends Error {
  readonly retriable = true as const;
  readonly provider: IntakeSourceProvider;
  readonly status: number;

  constructor(provider: IntakeSourceProvider, status: number, detail: string) {
    super(
      `${provider} intake source: fetch failed (HTTP ${status}) — ${detail}. ` +
        `This is NOT "no issues"; the source could not be read.`,
    );
    this.name = "IntakeSourceFetchError";
    this.provider = provider;
    this.status = status;
  }
}

/** A provider-directed transient delay. Pollers persist the deadline and move on. */
export class IntakeSourceRateLimitError extends Error {
  readonly retriable = true as const;
  readonly status = 429 as const;

  constructor(
    readonly provider: IntakeSourceProvider,
    readonly retryAfterMs: number,
  ) {
    super(`${provider} intake source is rate limited; retry after ${retryAfterMs}ms`);
    this.name = "IntakeSourceRateLimitError";
  }
}

/** A stable provider resource/configuration 4xx that cannot self-heal by retry. */
export class IntakeSourceResourceError extends Error {
  readonly retriable = false as const;

  constructor(
    readonly provider: IntakeSourceProvider,
    readonly status: number,
    detail: string,
  ) {
    super(`${provider} intake resource unavailable (HTTP ${status}) — ${detail}`);
    this.name = "IntakeSourceResourceError";
  }
}

/**
 * Classify an intake-source HTTP response. A 200 with an array (or, for the
 * GraphQL/REST shapes, a parseable body) is the caller's to map. A 401/403 is a
 * LOUD {@link IntakeSourceAuthError}; any other non-200 is a LOUD
 * {@link IntakeSourceFetchError}. The caller checks the body shape AFTER this for
 * the 200 case and throws {@link IntakeSourceFetchError} on an unparseable 200.
 */
export function assertIntakeResponseOk(
  provider: IntakeSourceProvider,
  status: number,
  detail = "",
  retryAfterMs?: number,
): void {
  if (status === 200) return;
  if (status === 401 || status === 403) {
    throw new IntakeSourceAuthError(provider, status, detail === "" ? "credential rejected" : detail);
  }
  if (status === 429) {
    throw new IntakeSourceRateLimitError(provider, retryAfterMs ?? 60_000);
  }
  if (status >= 400 && status < 500 && ![408, 409, 425].includes(status)) {
    throw new IntakeSourceResourceError(provider, status, detail === "" ? "resource rejected" : detail);
  }
  throw new IntakeSourceFetchError(provider, status, detail === "" ? "unexpected response" : detail);
}
