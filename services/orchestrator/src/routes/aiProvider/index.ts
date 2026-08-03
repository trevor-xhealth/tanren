// Wave-2 operator API: the "Connect AI provider" + billing-mode settings surface.
//
// Mirrors a real "Connect your AI provider" settings screen so the operator API
// is a 1-1 mirror of the product UX — no Vault-seeding, no raw config PATCH, no
// excessive env. Three dedicated, discoverable endpoints (the same dedicated-
// endpoint pattern as routes/projects/budget.ts + the org-budget routes):
//
//   POST /orgs/:orgId/ai-provider  { provider, apiKey? | authJson?, makeDefault? }
//     → connect a BYOK LLM provider. Stores the secret under a COST-CLASSIFIABLE
//       ref (engine/credentials/aiProvider.ts) so `classifyAuthRef` prices it,
//       records it in the credential registry, and (default) wires it as the
//       org's default LLM credential + flips providerMode → "byok" through the
//       SAME org-config path the rest of config uses. Returns
//       { provider, ref, classifiedAs: "<billing_mode>/<provider>", isDefault }
//       so the operator KNOWS the budget gate will meter it. The secret VALUE is
//       never returned or logged.
//
//   GET  /orgs/:orgId/ai-provider
//     → list connected providers (ref + provider + classifiedAs + isDefault),
//       values never exposed.
//
//   PUT  /orgs/:orgId/billing  { mode: "managed" | "byok" }
//     → the managed-vs-BYOK toggle as a clean setting (replaces hand-editing
//       `providerMode` in the config blob). Managed mode resolves the platform
//       credential as today (a hosting concern).
//
// All routes run org-scoped under RLS (the route is mounted on the orchestrator's
// `scopedPool`) and are actor-authorized: reads require org membership, writes
// require org admin.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { migrateOrgConfig, mutateOrgConfig, type OrgConfigV1 } from "../../engine/config/orgConfig.js";
import { ProviderMode } from "../../engine/config/managedProvider.js";
import type { RoutingChainEntry } from "../../engine/config/shared.js";
import { PgEventStore, type EventStore } from "../../engine/eventStore.js";
import {
  AI_PROVIDERS,
  type AiProvider,
  aiProviderSecretKind,
  classifiedAsLabel,
  deriveAiProviderRef,
} from "../../engine/credentials/aiProvider.js";
import { credentialTypeForRef, providerSlugForRef } from "../../engine/credentials/credentialType.js";
import {
  FULL_ROLE_CLIS,
  harnessAcceptsApiKeyProvider,
  harnessAcceptsCredentialType,
} from "../../engine/providers/harnessCapability.js";
import { storeCodexAuthBundle } from "../../engine/credentials/codexAuth.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";
import type { CredentialRegistry } from "../credentials/index.js";
import { SecretStoreCredentialRegistry } from "../credentials/index.js";

interface AiProviderRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  /** Shared credential registry (durable list). Defaults to the SecretStore-backed one. */
  registry?: CredentialRegistry;
  /** Event store used to publish credential repair signals. Defaults to Postgres. */
  events?: EventStore;
}

type CredentialConfiguredKind = "codex_chatgpt_auth" | "opaque";

// The connect body. Exactly one of `apiKey` (OpenRouter/Anthropic/OpenAI) or
// `authJson` (the Codex ChatGPT bundle) is required, matching the provider's
// secret kind — enforced in the handler so the error names the expected field.
// `name` is the trailing ref segment (defaults to "default"); `makeDefault`
// defaults to true (connecting a provider wires it for runs unless opted out).
const ConnectBody = z
  .object({
    provider: z.enum(AI_PROVIDERS),
    apiKey: z.string().min(1).optional(),
    authJson: z.string().min(1).optional(),
    name: z.string().min(1).default("default"),
    makeDefault: z.boolean().default(true),
  })
  .strict();

const BillingPutBody = z.object({ mode: ProviderMode }).strict();

/** The connect response — confirms the connected key WILL be cost-metered. */
interface ConnectView {
  provider: AiProvider;
  ref: string;
  classifiedAs: string;
  isDefault: boolean;
}

/** One row of the GET list — values never exposed. */
interface ConnectedProviderView {
  provider: AiProvider;
  ref: string;
  classifiedAs: string;
  isDefault: boolean;
}

export function createAiProviderRoutes(options: AiProviderRoutesOptions) {
  const registry = options.registry ?? new SecretStoreCredentialRegistry(options.secrets);
  const events = options.events ?? new PgEventStore(options.pool);
  const app = new Hono<ActorContextEnv>();

  // POST /orgs/:orgId/ai-provider — connect a BYOK LLM provider.
  app.post("/:orgId/ai-provider", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    const parsed = ConnectBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_ai_provider", issues: parsed.error.issues }, 400);
    }
    const { provider, name, makeDefault } = parsed.data;

    // Derive the tenant-namespaced, cost-classifiable ref. The slug is keyed off
    // the provider so the prefix matches `classifyAuthRef` — the guarantee that
    // the connected key is metered.
    let ref: string;
    try {
      ref = deriveAiProviderRef({ provider, scope: "org", ownerId: orgId, name });
    } catch (error) {
      return c.json({ error: "invalid_ai_provider", message: messageOf(error) }, 400);
    }

    // If the caller asked to make this the org default, resolve the full-role
    // harness for it BEFORE storing — so an incompatible default request fails LOUD
    // here and never leaves an orphaned secret. For a raw api_key the choice is
    // PROVIDER-SLUG-aware (NOT just credential-type): an anthropic key → claude,
    // an openrouter/openai-api key → codex (the cli whose materializer delivers
    // that provider's raw key). A bundle credential matches on credential-type.
    // A null/undefined result is a hard 400, not a silent connect-without-default.
    // Recomputed nowhere else: this `defaultCli` is the entry's cli below.
    let defaultCli: string | undefined;
    if (makeDefault) {
      const credentialType = credentialTypeForRef(ref);
      if (credentialType === null) {
        return c.json({ error: "invalid_ai_provider_default", message: "connected ref is not an LLM credential" }, 400);
      }
      if (credentialType === "api_key") {
        const slug = providerSlugForRef(ref);
        defaultCli = slug === null ? undefined : FULL_ROLE_CLIS.find((cli) => harnessAcceptsApiKeyProvider(cli, slug));
        if (defaultCli === undefined) {
          return c.json(
            {
              error: "invalid_ai_provider_default",
              message: `no full-role harness delivers a ${JSON.stringify(slug)} api_key as a default; connect a Codex/Claude bundle, or route this provider to a writer role explicitly`,
            },
            400,
          );
        }
      } else {
        defaultCli = FULL_ROLE_CLIS.find((cli) => harnessAcceptsCredentialType(cli, credentialType));
        if (defaultCli === undefined) {
          return c.json(
            {
              error: "invalid_ai_provider_default",
              message: `no full-role harness accepts a ${credentialType} credential as a default; connect a Codex/Claude bundle, or route this provider to a writer role explicitly`,
            },
            400,
          );
        }
      }
    }

    // Store the secret under that ref. Codex takes the validated ChatGPT bundle
    // (reusing the existing import path); the API-key providers store the raw
    // token as the secret VALUE. Either way the value is never returned/logged.
    const secretKind = aiProviderSecretKind(provider);
    try {
      if (secretKind === "auth_bundle") {
        if (parsed.data.authJson === undefined) {
          return c.json(
            { error: "invalid_ai_provider", message: "codex requires authJson (the ChatGPT auth bundle)" },
            400,
          );
        }
        await storeCodexAuthBundle(options.secrets, { ref, authJson: parsed.data.authJson });
      } else {
        if (parsed.data.apiKey === undefined) {
          return c.json({ error: "invalid_ai_provider", message: `${provider} requires apiKey` }, 400);
        }
        await options.secrets.put({ ref, value: parsed.data.apiKey });
      }
    } catch (error) {
      return c.json({ error: "invalid_ai_provider", message: messageOf(error) }, 400);
    }

    // Record it in the durable registry so it appears in the credential list.
    // The cost classification keys on the ref PREFIX (not this `kind`), so the
    // kind is just metadata: the codex bundle records as `codex_chatgpt_auth`,
    // the API-key providers as `opaque`.
    const recordKind: CredentialConfiguredKind = secretKind === "auth_bundle" ? "codex_chatgpt_auth" : "opaque";
    await registry.put({ ref, kind: recordKind, scope: "org", ownerId: orgId, createdAt: new Date().toISOString() });

    // Wire it as the org's default LLM, through the SAME org-config path the rest
    // of config uses (read-modify-write of `organizations.config`). The default is
    // a provider-agnostic routing entry {cli, model, authRef}: `defaultCli` above
    // is the FULL-ROLE harness whose materializer can actually deliver THIS
    // credential (a bundle by credential-type; a raw api_key by PROVIDER SLUG —
    // anthropic→claude, openrouter/openai-api→codex) — so the (cli, authRef) pair
    // is valid at run time, not a facade. An incompatible credential is REJECTED
    // loudly above, never silently wired to a harness that cannot read it.
    // `providerMode: "byok"` resolves the tenant credential. `makeDefault: false`
    // connects without changing routing.
    let isDefault = false;
    if (makeDefault && defaultCli !== undefined) {
      const exists = await loadOrgConfig(options.pool, orgId);
      if (exists === undefined) {
        return c.json({ error: "org_not_found" }, 404);
      }
      // No `model`: connecting a provider selects the CREDENTIAL, not a model.
      // An ABSENT model is the routing schema's NAMED "use this provider's pinned
      // default", which each adapter substitutes at run time. It must NOT be the
      // literal `"default"` — that is a sentinel no resolver understands, and it
      // used to pass through verbatim into the generated codex `config.toml` and
      // 400 at the provider. An operator who wants a specific model sets it on the
      // routing entry explicitly.
      const defaultLlm: RoutingChainEntry = { cli: defaultCli, authRef: ref };
      // Progress-based mutate: re-merge after a lost race so concurrent org-config
      // field writes are not clobbered by a precomputed full-document overwrite.
      await mutateOrgConfigFor(options.pool, orgId, (raw) => {
        const loaded = migrateOrgConfig(raw);
        return migrateOrgConfig({
          ...loaded,
          providerMode: "byok",
          defaultCredentials: { ...loaded.defaultCredentials, defaultLlm },
        });
      });
      isDefault = true;
    }
    await emitCredentialConfiguredForOrgProjects(options.pool, events, orgId, {
      provider,
      credentialKind: recordKind,
      ref,
      redacted: true,
    });

    // `classifiedAsLabel` re-classifies the derived ref (throws if it is not a
    // metered prefix), so the returned label can never disagree with how runs
    // price it.
    const view: ConnectView = { provider, ref, classifiedAs: classifiedAsLabel(ref), isDefault };
    return c.json(view, 201);
  });

  // GET /orgs/:orgId/ai-provider — list connected providers (values never exposed).
  app.get("/:orgId/ai-provider", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const loaded = await loadOrgConfig(options.pool, orgId);
    if (loaded === undefined) {
      return c.json({ error: "org_not_found" }, 404);
    }
    const defaultRef = loaded.defaultCredentials?.defaultLlm?.authRef;
    const records = await registry.list({ scope: "org", ownerId: orgId });
    const providers: ConnectedProviderView[] = [];
    for (const record of records) {
      const provider = providerForRef(record.ref);
      if (provider === undefined) {
        // Not an AI-provider credential (e.g. a github_token) — skip.
        continue;
      }
      providers.push({
        provider,
        ref: record.ref,
        classifiedAs: classifiedAsLabel(record.ref),
        isDefault: record.ref === defaultRef,
      });
    }
    return c.json({ providerMode: loaded.providerMode, providers });
  });

  // PUT /orgs/:orgId/billing — the managed-vs-BYOK toggle as a clean setting.
  app.put("/:orgId/billing", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    const parsed = BillingPutBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_billing_mode", issues: parsed.error.issues }, 400);
    }
    const exists = await loadOrgConfig(options.pool, orgId);
    if (exists === undefined) {
      return c.json({ error: "org_not_found" }, 404);
    }
    const written = await mutateOrgConfigFor(options.pool, orgId, (raw) => {
      return migrateOrgConfig({ ...migrateOrgConfig(raw), providerMode: parsed.data.mode });
    });
    return c.json({ mode: migrateOrgConfig(written.config).providerMode });
  });

  return app;
}

/** Which connected AI provider a credential ref belongs to, or undefined. */
function providerForRef(ref: string): AiProvider | undefined {
  for (const provider of AI_PROVIDERS) {
    // Re-derive the prefix the same way the connect path does, anchored to the
    // slug — a ref is "this provider's" when it starts with `credential/<slug>/`.
    const prefix = providerRefPrefix(provider);
    if (ref.startsWith(prefix)) {
      return provider;
    }
  }
  return undefined;
}

/** `credential/<slug>/` for a provider — derived once from the shared mapping. */
function providerRefPrefix(provider: AiProvider): string {
  // Probe-derive a ref then slice to its `credential/<slug>/` prefix so this
  // never hard-codes a slug that could drift from `deriveAiProviderRef`.
  const probe = deriveAiProviderRef({ provider, scope: "org", ownerId: "probe", name: "probe" });
  const parts = probe.split("/");
  return `${parts[0]}/${parts[1]}/`;
}

async function loadOrgConfig(pool: pg.Pool, orgId: string): Promise<OrgConfigV1 | undefined> {
  // Lazy import keeps this route under the max-dependencies lint cap.
  const { OrganizationsStore } = await import("../../engine/repositories/organizations.js");
  const { systemActor } = await import("../../engine/state/actor.js");
  const snapshot = await OrganizationsStore.getConfigSnapshot(pool, orgId, systemActor);
  if (snapshot === undefined) {
    return undefined;
  }
  return migrateOrgConfig(snapshot.config);
}

async function mutateOrgConfigFor(
  pool: pg.Pool,
  orgId: string,
  mutate: (current: unknown) => OrgConfigV1,
): Promise<{ config: unknown }> {
  const { systemActor } = await import("../../engine/state/actor.js");
  return mutateOrgConfig(pool, orgId, systemActor, mutate);
}

async function emitCredentialConfiguredForOrgProjects(
  pool: pg.Pool,
  events: EventStore,
  orgId: string,
  payload: { provider: AiProvider; credentialKind: CredentialConfiguredKind; ref: string; redacted: true },
): Promise<void> {
  const projects = await pool.query<{ project_id: string }>("SELECT project_id FROM projects WHERE org_id = $1", [
    orgId,
  ]);
  await Promise.all(
    projects.rows.map((project) =>
      events.append({
        projectId: project.project_id,
        orgId,
        eventType: "credential.configured",
        payload,
      }),
    ),
  );
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
