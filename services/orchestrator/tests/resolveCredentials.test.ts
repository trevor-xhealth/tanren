import type pg from "pg";
import { describe, expect, it } from "vitest";
import { migrateProjectConfig } from "../src/engine/config/index.js";
import {
  MissingCredentialError,
  type OrgScope,
  OrgProviderModeUnresolved,
  UnscopedOrgError,
  orgScopeFromRunOrgId,
  resolveCredentialsForRun,
} from "../src/engine/credentials/resolveCredentials.js";

/** A real tenant scope built from a non-empty org id (the run-path shape). */
function orgScope(orgId: string): OrgScope {
  return { kind: "org", orgId };
}

/**
 * Minimal pg.Pool stub for the single org-config read the resolver performs.
 * `config` is whatever the named org row carries (raw JSONB), so a test can
 * exercise bare `version:1` rows, rows with `defaultCredentials`, and missing rows.
 */
function fakePool(orgs: Record<string, unknown>): Pick<pg.Pool, "query"> {
  return {
    query: (async (_sql: string, params: unknown[]) => {
      const orgId = params[0] as string;
      const config = orgs[orgId];
      return config === undefined ? { rows: [], rowCount: 0 } : { rows: [{ config }], rowCount: 1 };
    }) as unknown as pg.Pool["query"],
  };
}

const codexProjectRef = "credential/codex/org/org_1/project";
const githubProjectRef = "credential/github/org/org_1/project";
const codexOrgRef = "credential/codex/org/org_1/default";
const githubOrgRef = "credential/github/org/org_1/default";

/** The default LLM routing entry shape stored under `defaultLlm`. */
function codexEntry(authRef: string) {
  return { cli: "codex", model: "default", authRef };
}

describe("resolveCredentialsForRun", () => {
  it("prefers project config over the org default", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
      },
    });
    const projectConfig = migrateProjectConfig({
      version: 1,
      credentials: { defaultLlm: codexEntry(codexProjectRef), githubCredentialRef: githubProjectRef },
    });
    const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgScope: orgScope("org_1") });
    expect(resolved).toEqual({
      defaultLlm: codexEntry(codexProjectRef),
      github: { kind: "static", ref: githubProjectRef },
      githubCredentialRef: githubProjectRef,
      providerMode: "byok",
    });
  });

  it("falls back to the org default when project config omits a kind", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
      },
    });
    // Project binds only the GitHub ref; the default LLM inherits the org default.
    const projectConfig = migrateProjectConfig({
      version: 1,
      credentials: { githubCredentialRef: githubProjectRef },
    });
    const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgScope: orgScope("org_1") });
    expect(resolved).toEqual({
      defaultLlm: codexEntry(codexOrgRef),
      github: { kind: "static", ref: githubProjectRef },
      githubCredentialRef: githubProjectRef,
      providerMode: "byok",
    });
  });

  it("lets an explicit GitHub override win over both project config and org default", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
      },
    });
    const projectConfig = migrateProjectConfig({
      version: 1,
      credentials: { defaultLlm: codexEntry(codexProjectRef), githubCredentialRef: githubProjectRef },
    });
    const resolved = await resolveCredentialsForRun(pool, {
      projectConfig,
      orgScope: orgScope("org_1"),
      override: { githubCredentialRef: "credential/github/org/org_1/pin" },
    });
    expect(resolved).toEqual({
      defaultLlm: codexEntry(codexProjectRef),
      github: { kind: "static", ref: "credential/github/org/org_1/pin" },
      githubCredentialRef: "credential/github/org/org_1/pin",
      providerMode: "byok",
    });
  });

  it("resolves from org defaults when the project binds nothing", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
      },
    });
    // A project with no bound credentials key (bare version:1 config).
    const projectConfig = migrateProjectConfig({ version: 1 });
    const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgScope: orgScope("org_1") });
    expect(resolved).toEqual({
      defaultLlm: codexEntry(codexOrgRef),
      github: { kind: "static", ref: githubOrgRef },
      githubCredentialRef: githubOrgRef,
      providerMode: "byok",
    });
  });

  it("throws MissingCredentialError naming the unresolved kind (github)", async () => {
    const pool = fakePool({
      org_1: { version: 1, defaultCredentials: { defaultLlm: codexEntry(codexOrgRef) } },
    });
    const projectConfig = migrateProjectConfig({ version: 1 });
    await expect(resolveCredentialsForRun(pool, { projectConfig, orgScope: orgScope("org_1") })).rejects.toMatchObject({
      name: "MissingCredentialError",
      kind: "github_token",
    });
  });

  // App-first run resolution (apex v22 finding #2): an org that installed the
  // GitHub App but bound NO static `github_token` can both create the repo
  // (greenfield) AND RUN — the run resolves the EXPLICIT `{ kind: "app" }` decision
  // (wire form: the empty App sentinel), so downstream git ops mint the installation
  // token from `context.installation`.
  const githubAppBlock = {
    installationId: "12345678",
    appId: "987654",
    credentialRef: "credential/github_app/org/org_1/private_key",
    installedAt: "2026-06-08T00:00:00.000Z",
  };

  it("App-only org (App installed, NO static github_token) resolves the EXPLICIT { kind: 'app' } decision, NOT MissingCredentialError", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        github_app: githubAppBlock,
        // The LLM is bound (so resolution reaches the github kind); GitHub has NO
        // static ref anywhere — only the installed App.
        defaultCredentials: { defaultLlm: codexEntry(codexOrgRef) },
      },
    });
    const projectConfig = migrateProjectConfig({ version: 1 });
    const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgScope: orgScope("org_1") });
    // The "App, no static ref" state is the EXPLICIT discriminated variant — NOT a
    // bare validated empty string.
    expect(resolved.github).toEqual({ kind: "app" });
    // Its WIRE form is the documented empty App sentinel: downstream reads "" as
    // "no static ref ⇒ mint the App token from context.installation".
    expect(resolved.githubCredentialRef).toBe("");
    expect(resolved.providerMode).toBe("byok");
    expect(resolved.defaultLlm).toEqual(codexEntry(codexOrgRef));
  });

  it("a STATIC github_token still wins over an installed App (explicit ref is authoritative)", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        github_app: githubAppBlock,
        defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
      },
    });
    const projectConfig = migrateProjectConfig({ version: 1 });
    const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgScope: orgScope("org_1") });
    expect(resolved.github).toEqual({ kind: "static", ref: githubOrgRef });
    expect(resolved.githubCredentialRef).toBe(githubOrgRef);
  });

  it("FAIL-CLOSED: neither a static github_token NOR the App ⇒ MissingCredentialError stays loud", async () => {
    const pool = fakePool({
      // No github_app, no github_token — only the LLM is bound.
      org_1: { version: 1, defaultCredentials: { defaultLlm: codexEntry(codexOrgRef) } },
    });
    const projectConfig = migrateProjectConfig({ version: 1 });
    await expect(resolveCredentialsForRun(pool, { projectConfig, orgScope: orgScope("org_1") })).rejects.toMatchObject({
      name: "MissingCredentialError",
      kind: "github_token",
    });
  });

  it("throws MissingCredentialError for the default LLM first when both are unresolved", async () => {
    const pool = fakePool({ org_1: { version: 1 } });
    const projectConfig = migrateProjectConfig({ version: 1 });
    let caught: unknown;
    try {
      await resolveCredentialsForRun(pool, { projectConfig, orgScope: orgScope("org_1") });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingCredentialError);
    expect((caught as MissingCredentialError).kind).toBe("llm_default");
  });

  it("THROWS OrgProviderModeUnresolved when a NON-EMPTY org id reads back no row (scoping/denial bug, not 'no config')", async () => {
    const pool = fakePool({});
    const projectConfig = migrateProjectConfig({
      version: 1,
      credentials: { defaultLlm: codexEntry(codexProjectRef), githubCredentialRef: githubProjectRef },
    });
    let caught: unknown;
    try {
      await resolveCredentialsForRun(pool, { projectConfig, orgScope: orgScope("ghost") });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrgProviderModeUnresolved);
    expect((caught as OrgProviderModeUnresolved).orgId).toBe("ghost");
  });

  it("FAILS LOUD (UnscopedOrgError) when a run path resolves credentials with an EMPTY org id — never a silent BYOK degrade", () => {
    // The run/forge callers build their scope via `orgScopeFromRunOrgId(row.org_id)`;
    // an empty/blank/absent org id at a run path is a scoping bug and must throw, not
    // quietly fall back to project-config-only BYOK (the no_silent_fallbacks doctrine).
    // An ABSENT (undefined) org id — modeled as a typed variable so the missing-scope
    // case is covered without a useless literal `undefined` at the call site.
    const absentOrgId: string | undefined = ((): string | undefined => undefined)();
    expect(() => orgScopeFromRunOrgId("")).toThrow(UnscopedOrgError);
    expect(() => orgScopeFromRunOrgId("   ")).toThrow(UnscopedOrgError);
    expect(() => orgScopeFromRunOrgId(null)).toThrow(UnscopedOrgError);
    expect(() => orgScopeFromRunOrgId(absentOrgId)).toThrow(UnscopedOrgError);
  });

  it("rejects GitHub resolution in the explicit org-less platform scope", async () => {
    // The org-less mode is reached only by NAMING it — never by coercing an absent
    // org to "". No org row exists; resolution uses project config + the byok default.
    const pool = fakePool({});
    const projectConfig = migrateProjectConfig({
      version: 1,
      credentials: { defaultLlm: codexEntry(codexProjectRef), githubCredentialRef: githubProjectRef },
    });
    await expect(
      resolveCredentialsForRun(pool, {
        projectConfig,
        orgScope: { kind: "unscopedPlatform" },
      }),
    ).rejects.toBeInstanceOf(UnscopedOrgError);
  });

  it("names the default LLM vs GitHub in the MissingCredentialError message", async () => {
    const llmMissing = new MissingCredentialError("llm_default");
    expect(llmMissing.message).toContain("default LLM");
    expect(llmMissing.kind).toBe("llm_default");
    const githubMissing = new MissingCredentialError("github_token");
    expect(githubMissing.message).toContain("GitHub credential");
    expect(githubMissing.kind).toBe("github_token");
  });

  it("ignores blank/whitespace GitHub override refs and falls through to the next layer", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
      },
    });
    const projectConfig = migrateProjectConfig({ version: 1 });
    const resolved = await resolveCredentialsForRun(pool, {
      projectConfig,
      orgScope: orgScope("org_1"),
      override: { githubCredentialRef: "   " },
    });
    expect(resolved.githubCredentialRef).toBe(githubOrgRef);
  });

  // SaaS Tier-B #5: BYOK-vs-managed provider seam. These assert OUTCOMES — the
  // resolved default LLM entry + the endpoint override — not mock calls.
  describe("managed provider mode", () => {
    const platformRef = "credential/openrouter/platform/default";

    it("resolves the PLATFORM credential + managed endpoint when the org is managed", async () => {
      const pool = fakePool({
        org_1: {
          version: 1,
          providerMode: "managed",
          defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
        },
      });
      const projectConfig = migrateProjectConfig({ version: 1 });
      const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgScope: orgScope("org_1") });
      expect(resolved.providerMode).toBe("managed");
      // The tenant's own default LLM is NOT used — the platform ref is. The entry
      // carries NO `model`: the platform shell is deploy config, and an ABSENT
      // model is the routing schema's "use the provider's pinned default" (the
      // codex OpenRouter path substitutes CODEX_OPENROUTER_MODEL). It is NOT the
      // `"default"` sentinel, which reached OpenRouter verbatim and 400'd.
      expect(resolved.defaultLlm).toEqual({ cli: "codex", authRef: platformRef });
      expect(resolved.defaultLlm.model).toBeUndefined();
      expect(resolved.defaultLlm.authRef).not.toBe(codexOrgRef);
      // GitHub stays the tenant's own credential.
      expect(resolved.githubCredentialRef).toBe(githubOrgRef);
      // The harness is pointed at the OpenRouter OpenAI-compatible endpoint.
      expect(resolved.endpointOverride).toEqual({ baseUrl: "https://openrouter.ai/api/v1" });
    });

    it("lets a project override the org's byok default into managed", async () => {
      const pool = fakePool({
        org_1: { version: 1, providerMode: "byok", defaultCredentials: { github_token: githubOrgRef } },
      });
      const projectConfig = migrateProjectConfig({ version: 1, providerMode: "managed" });
      const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgScope: orgScope("org_1") });
      expect(resolved.providerMode).toBe("managed");
      expect(resolved.defaultLlm.authRef).toBe(platformRef);
    });

    it("lets a project pin back to byok over a managed org default", async () => {
      const pool = fakePool({
        org_1: {
          version: 1,
          providerMode: "managed",
          defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
        },
      });
      const projectConfig = migrateProjectConfig({ version: 1, providerMode: "byok" });
      const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgScope: orgScope("org_1") });
      expect(resolved.providerMode).toBe("byok");
      expect(resolved.defaultLlm).toEqual(codexEntry(codexOrgRef));
      expect(resolved.endpointOverride).toBeUndefined();
    });

    it("never throws MissingCredentialError for the LLM kind in managed mode", async () => {
      // No default LLM anywhere; managed mode resolves the platform ref instead.
      const pool = fakePool({
        org_1: { version: 1, providerMode: "managed", defaultCredentials: { github_token: githubOrgRef } },
      });
      const resolved = await resolveCredentialsForRun(pool, {
        projectConfig: migrateProjectConfig({ version: 1 }),
        orgScope: orgScope("org_1"),
      });
      expect(resolved.defaultLlm.authRef).toBe(platformRef);
    });
  });
});
