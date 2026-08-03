# GitHub App connectivity (P3-0003)

Tanren's preferred GitHub integration is a **per-org GitHub App
installation** that mints short-lived, auto-rotating installation tokens. These
tokens are used for repo clone, draft-PR creation, and publishing the native
`tanren/gate` verdict as a commit status. For greenfield projects they are also
used to create the target organization repository. A static
personal-access-token (PAT) path is used when no App is installed (the dev /
self-hosted no-App path).

This is an **operator setup step**: you register the App once for the Tanren
deployment, store its credentials in Vault, and then each org installs it. The
orchestrator does not require the App to exist for tests or dev — without it,
the static-token path is used unchanged.

## 1. Register the GitHub App (one-time, per deployment)

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Permissions (repository). These are **not** interchangeable — the capability
   probe classifies them by severity, and so should you:

   **Required for every run** (without any one of them, no run can complete):
   **Commit statuses: Read & write** (Tanren publishes its own `tanren/gate`
   verdict via `POST /repos/{owner}/{repo}/statuses/{sha}`, and that verdict is
   the merge authority — a missing grant 403s and kills the run), **Contents:
   Read & write**, **Pull requests: Read & write**, **Metadata: Read-only**.

   **Optional, per feature:** **Administration: Read & write** — only for
   greenfield repo creation via `POST /orgs/:owner/repos`; brownfield projects
   never need it. **Issues: Read & write** and **Webhooks: Read & write** — only
   for issue-sourced intake (reading tracked issues, syncing comments/state back,
   and provisioning the repository webhook).

   Organization: **Members: Read-only** (review-gate routing). Do not grant
   Secrets unless a future feature explicitly requires it.

   After installing, verify with `GET /orgs/:orgId/github`: `runReady` must be
   `true`. Any `permissionGaps` entry with `severity: "run_fatal"` means runs
   will fail — `feature_blocking` entries only cost the named optional feature.

3. Set the **Setup / Callback URL** to:
   `https://<orchestrator-public-url>/auth/github-app/callback`
4. Generate a **private key** (downloads a `.pem`). Note the numeric **App ID**.
5. Note the App's public **install URL**:
   `https://github.com/apps/<app-slug>/installations/new`

## 2. Store the App credential in Vault

The App identity (App ID + private-key PEM) is stored as a single write-only
credential under a `credential/github_app/...` ref. The private key never leaves
Vault-derived memory and is never logged or rendered.

Import via the credentials route (org- or me-scoped), with `?kind=github_app`:

```http
POST /orgs/<orgId>/credentials?kind=github_app
Content-Type: application/json

{
  "ref": "credential/github_app/org/<orgId>/default",
  "appId": "123456",
  "privateKeyPem": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
}
```

The response is redacted (`{ credentialKind, ref, appId, redacted: true }`); the
private key is never returned.

## 3. Wire the orchestrator environment

| Variable                           | Purpose                                      |
| ---------------------------------- | -------------------------------------------- |
| `TANREN_GITHUB_APP_CREDENTIAL_REF` | Vault ref of the App credential from step 2. |
| `TANREN_GITHUB_APP_INSTALL_URL`    | The App install URL from step 1.             |

The install route (`/auth/github-app/*`) only mounts when both
`TANREN_GITHUB_APP_CREDENTIAL_REF` and `TANREN_GITHUB_APP_INSTALL_URL` are set.

For the dashboard onboarding affordance, set `TANREN_PUBLIC_BASE_URL` (the
canonical orchestrator public base URL) so the org-setup wizard renders the
**install github app** button pointing at the orchestrator install flow. The
dashboard reads the App install URL itself from the orchestrator's
`/auth/providers` (sourced from `TANREN_GITHUB_APP_INSTALL_URL`).

## 4. Install the App on an org

1. In the dashboard org-setup wizard (step 1), click **install github app**, or
   navigate directly to
   `https://<orchestrator-public-url>/auth/github-app/install?orgId=<orgId>`.
2. The orchestrator sets a signed state cookie and redirects to GitHub, where
   the operator selects which repos the App can touch.
3. GitHub redirects back to `/auth/github-app/callback?installation_id=…&state=…`.
   The orchestrator validates the state, verifies it can mint an installation
   token, and persists
   `{ installationId, appId, credentialRef, installedAt }` to
   `organizations.config.github_app` (JSONB; no DB migration).

## How the token resolver chooses App vs. static

For repo clone, draft PR, and publishing the `tanren/gate` status, the resolver
(`engine/credentials/githubTokenResolver.ts`) picks, in order:

1. **App installation token** — when the org's
   `organizations.config.github_app.installationId` is set. A short-lived
   (~10 min) RS256 App JWT is signed with the private key (`iss` = App ID) and
   exchanged at `POST /app/installations/{id}/access_tokens` for a ~1 h
   installation token. Tokens are cached per installation and re-minted before
   expiry, or immediately on a `401` (the HTTP client retries once with a fresh
   token).
2. **Static token** — otherwise, the resolver reads the static `github_token`
   credential ref resolved from the run override, project configuration, or org
   default. If neither that ref nor an App installation exists, the run fails
   configuration validation.

Installation tokens are used over HTTPS as the `x-access-token` password for
`git push`, identical to a PAT, so the workspace push command is unchanged.
