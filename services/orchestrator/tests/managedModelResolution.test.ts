import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { migrateProjectConfig } from "../src/engine/config/index.js";
import { resolveCredentialsForRun } from "../src/engine/credentials/resolveCredentials.js";
import { buildEffectiveRouting } from "../src/engine/worker/runExecutionContext.js";
import { buildWriterAdapter } from "../src/engine/providers/adapterSelector.js";
import { CODEX_OPENROUTER_MODEL } from "../src/engine/providers/codexModel.js";

// The MANAGED-MODE MODEL-RESOLUTION contract, asserted END TO END: from the org
// row, through `resolveCredentialsForRun` → `buildEffectiveRouting` →
// `buildWriterAdapter` → the real codex writer → the materializer, down to the
// literal `model = …` line of the per-run codex `config.toml` that is written on
// the runner and the `model` the cost recorder reads off the adapter.
//
// This is the regression guard for the P0 where the managed branch wrote a
// `model: "default"` SENTINEL into the routing entry. `"default"` is not a
// sentinel any resolver understands — `resolveCodexOpenRouterModel` substitutes
// the pin only for `undefined` — so the literal passed through into config.toml
// and OpenRouter answered `400 "default is not a valid model ID"`, killing every
// managed model call. The fix is structural: `RoutingChainEntry.model` is
// OPTIONAL, absence MEANS "use the provider's pinned default", and managed mode
// omits it. Both directions are guarded here:
//   1. managed + no configured model  ⇒ the PIN reaches config.toml;
//   2. an explicitly-configured per-role model ⇒ that model reaches config.toml,
//      never overwritten by the pin.
// Asserting the generated config.toml (not a helper's return) is deliberate: the
// bug lived in the value that survived all the way to the harness.

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const MANAGED_REF = "credential/openrouter/platform/default";
const ORG_ID = "org_managed";
const BASE_SHA = "a".repeat(40);

// A model id an org might have stored on its BYOK default entry. Managed mode
// must NOT pick it up (the platform credential/endpoint are deploy config, and
// a BYOK-namespace id on an OpenRouter route would mis-resolve), so it doubles
// as the "managed ignores org config" assertion.
const ORG_BYOK_MODEL = "gpt-5.6-luna";

describe("managed-mode model resolution reaches the generated codex config.toml", () => {
  it("resolves the pinned OpenRouter model — never the 'default' sentinel — for a managed run", async () => {
    const pool = fakePool({
      [ORG_ID]: {
        version: 1,
        providerMode: "managed",
        defaultCredentials: {
          // A tenant BYOK default the managed branch deliberately does not read.
          defaultLlm: { cli: "codex", model: ORG_BYOK_MODEL, authRef: `credential/codex/org/${ORG_ID}/default` },
          github_token: `credential/github/org/${ORG_ID}/default`,
        },
      },
    });
    const projectConfig = migrateProjectConfig({ version: 1 });

    const resolved = await resolveCredentialsForRun(pool, {
      projectConfig,
      orgScope: { kind: "org", orgId: ORG_ID },
    });
    expect(resolved.providerMode).toBe("managed");

    const routing = buildEffectiveRouting(projectConfig.routing, resolved.defaultLlm);
    const writeHead = routing.write.chain[0];
    expect(writeHead).toBeDefined();

    const { ssh, secrets } = await managedRunnerFixture();
    const writer = buildWriterAdapter(
      { secrets, ssh, target, runId: "run_managed_model", endpointBaseUrl: resolved.endpointOverride?.baseUrl },
      writeHead!,
    );
    await writer.runWriter({ prompt: "make a managed edit", workspace: "/workspace/repo", baseSha: BASE_SHA });

    // THE assertion: the literal `model = …` line of the config.toml codex will
    // read on the runner carries a REAL OpenRouter model id.
    const materialization = ssh.commands[0]?.command.command ?? "";
    expect(materialization).toContain("config.toml");
    expect(materialization).toContain(`model = "${CODEX_OPENROUTER_MODEL}"`);
    expect(materialization).not.toContain('model = "default"');
    // Managed mode does not adopt the org's BYOK model (deploy config, not userland).
    expect(materialization).not.toContain(`model = "${ORG_BYOK_MODEL}"`);

    // The same real id is what the cost recorder writes to `cost_records.model`
    // (`args.adapter.model ?? ""`) — through the timing decorator the loop holds.
    expect(writer.model).toBe(CODEX_OPENROUTER_MODEL);

    // …and "use the provider's pinned default" is EXPRESSIBLE in the routing
    // entry: an ABSENT model, not a magic string no resolver understands.
    expect(resolved.defaultLlm.model).toBeUndefined();
  });

  it("honors an explicitly-configured per-role model instead of overwriting it with the pin", async () => {
    const explicitModel = "openai/gpt-5-mini";
    const pool = fakePool({
      [ORG_ID]: {
        version: 1,
        providerMode: "managed",
        defaultCredentials: { github_token: `credential/github/org/${ORG_ID}/default` },
      },
    });
    // The project pins its OWN writer model; the resolved managed default heads
    // only the roles the project leaves empty.
    const projectConfig = migrateProjectConfig({
      version: 1,
      routing: { write: { chain: [{ cli: "codex", model: explicitModel, authRef: MANAGED_REF }] } },
    });

    const resolved = await resolveCredentialsForRun(pool, {
      projectConfig,
      orgScope: { kind: "org", orgId: ORG_ID },
    });
    const routing = buildEffectiveRouting(projectConfig.routing, resolved.defaultLlm);
    const writeHead = routing.write.chain[0];
    expect(writeHead?.model).toBe(explicitModel);

    const { ssh, secrets } = await managedRunnerFixture();
    const writer = buildWriterAdapter(
      { secrets, ssh, target, runId: "run_explicit_model", endpointBaseUrl: resolved.endpointOverride?.baseUrl },
      writeHead!,
    );
    await writer.runWriter({ prompt: "make an edit", workspace: "/workspace/repo", baseSha: BASE_SHA });

    const materialization = ssh.commands[0]?.command.command ?? "";
    expect(materialization).toContain(`model = "${explicitModel}"`);
    expect(materialization).not.toContain(`model = "${CODEX_OPENROUTER_MODEL}"`);
    expect(writer.model).toBe(explicitModel);
  });
});

/**
 * Minimal `pg.Pool` stub for the single org-config read the resolver performs —
 * the same hand-written fake `resolveCredentials.test.ts` uses (no vi.mock).
 */
function fakePool(orgs: Record<string, unknown>): Pick<pg.Pool, "query"> {
  return {
    query: (async (_sql: string, params: unknown[]) => {
      const config = orgs[params[0] as string];
      return config === undefined ? { rows: [], rowCount: 0 } : { rows: [{ config }], rowCount: 1 };
    }) as unknown as pg.Pool["query"],
  };
}

/**
 * A runner fixture for one managed codex writer pass. The scripted results follow
 * the managed writer's command order with a threaded `baseSha` (no baseline
 * capture, no auth write-back): materialize config → codex exec → commit → diff → log.
 */
async function managedRunnerFixture(): Promise<{ ssh: ScriptedSsh; secrets: InMemorySecretStore }> {
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: MANAGED_REF, value: "sk-or-v1-managed" });
  const ssh = new ScriptedSsh([
    ok(""),
    ok("{}\n"),
    ok(""),
    ok("diff --git a/MANAGED.md b/MANAGED.md\n+managed\n"),
    ok(`${"f".repeat(40)}\tcodex writer\n`),
  ]);
  return { ssh, secrets };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

class ScriptedSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];

  constructor(private readonly results: CommandResult[]) {}

  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target: sshTarget, command });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error(`unexpected SSH command: ${command.command}`);
    }
    return result;
  }
}
