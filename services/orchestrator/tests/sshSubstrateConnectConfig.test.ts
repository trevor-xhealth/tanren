// Regression tests for the apex v44 P0: the ssh2 connect-config `timeout` option
// (forwarded to socket.setTimeout in ssh2 1.17.0) was killing long-running codex
// commands that went quiet for >30s (reasoning gaps with no stdout). This is a
// disguised wall-clock deadline on a running command — the class eradicated in
// #609–#622. The fix: remove `timeout` from the connect config; use `readyTimeout`
// (handshake-only) + `keepaliveInterval`/`keepaliveCountMax` (dead-socket detection).
import { EventEmitter } from "node:events";
import type { Client, ClientChannel } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { SshCommandSubstrate } from "../src/engine/ssh/index.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  identitySecretRef: "runner/run_1/identity",
};

async function makeSubstrate(client: Client & EventEmitter): Promise<SshCommandSubstrate> {
  const secrets = new FakeSecretStore();
  await secrets.put({ ref: target.identitySecretRef, value: "private-key" });
  return new SshCommandSubstrate(secrets, { clientFactory: () => client });
}

describe("SSH substrate connect-config shape (apex v44 regression)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes readyTimeout + keepalive in the connect config and NO socket idle-timeout field", async () => {
    // The root cause: `timeout: connectMs` in the ssh2 connect config forwards to
    // socket.setTimeout (a connection-LIFETIME idle timeout). A codex command with a
    // >30s quiet gap (reasoning, no stdout) fires the ssh2 'timeout' event mid-run
    // and kills the still-alive command — a disguised wall-clock deadline. The fix
    // removes `timeout` entirely; `readyTimeout` remains (handshake-only bound, the
    // ONE legitimate time bound); keepalive detects a genuinely dead TCP connection.
    const { client, captureConfig } = createConfigCaptureClient();
    const substrate = await makeSubstrate(client);

    const runPromise = substrate.run(target, { command: "echo ok", connectTimeoutMs: 5_000 });
    await Promise.resolve();
    client.emit("error", new Error("done"));
    await runPromise;

    const config = await captureConfig;
    // `readyTimeout` is the handshake-only bound — expected.
    expect(config["readyTimeout"]).toBe(5_000);
    // keepalive must be present so a genuinely dead socket is still detected without
    // a socket idle timer (the keepalive probe fires and only declares dead after
    // keepaliveCountMax unanswered probes — never kills a quiet-but-alive command).
    expect(typeof config["keepaliveInterval"]).toBe("number");
    expect((config["keepaliveInterval"] as number) > 0).toBe(true);
    expect(typeof config["keepaliveCountMax"]).toBe("number");
    expect((config["keepaliveCountMax"] as number) > 0).toBe(true);
    // `timeout` MUST NOT be present — it is the socket idle-timeout that was killing
    // long-running commands with quiet gaps. Only the ActivityWatchdog (progress-based)
    // may surface a stall on a running command.
    expect("timeout" in config).toBe(false);
  });

  it("does NOT fail a command that produces no output for longer than the old 30s socket idle-timeout", async () => {
    // Before the fix: a codex command quiet for >30s fired ssh2 'timeout' mid-run,
    // returned result.failure → the command was classified `crashed` and the writer
    // was retried until the DAG bricked. After the fix: the 'timeout' event is only
    // emitted when readyTimeout fires during the HANDSHAKE (the client is not yet
    // 'ready'). A command that is UP (post-ready) and quiet for >30s must NOT fail;
    // only the ActivityWatchdog (progress-based) can surface a stall on genuine
    // non-progress — a command making progress (or finishing) runs unbounded.
    vi.useFakeTimers();
    const { client, stream } = createReadyClientWithManualClose();
    const substrate = await makeSubstrate(client);

    // Supply a watchdog whose workspace signature ADVANCES each probe tick (a build
    // making genuine progress with no stdout) — the ActivityWatchdog will never fire
    // on an advancing signature, so only a socket idle-timeout (the bug) could kill
    // this. With the fix applied, 60s of wall-clock with no stdout is fine.
    let mtime = 0;
    const runPromise = substrate.run(target, {
      command: "codex --json",
      watchdog: {
        livenessProbe: () => Promise.resolve({ observed: true as const, signature: `ws:${(mtime += 1)}` }),
        probeIntervalMs: 1_000,
      },
    });
    // Let exec/ready settle so the command is up (watchdog armed).
    await vi.advanceTimersByTimeAsync(0);
    // Advance WELL past the old 30s socket idle-timeout budget — the command must
    // still be running, not failed by a socket idle timer.
    await vi.advanceTimersByTimeAsync(60_000);
    // Resolve cleanly (the command finishes normally, not via watchdog).
    stream.emit("exit", 0);
    stream.emit("close");
    const result = await runPromise;

    // Must have exited cleanly; NOT failed via ssh_failed (no socket idle-timeout kill).
    expect(result.exitCode).toBe(0);
    expect(result.failure).toBeUndefined();
    expect(result.stalled).toBeFalsy();
  });
});

type ConnectConfig = Record<string, unknown>;

/**
 * A fake ssh2 Client that captures the full connect config so the test can assert
 * the shape: `readyTimeout` + keepalive present, no `timeout` field. Never
 * authenticates — the test settles it via an error emission.
 */
function createConfigCaptureClient(): {
  client: Client & EventEmitter;
  captureConfig: Promise<ConnectConfig>;
} {
  const emitter = new EventEmitter();
  let resolveConfig: (config: ConnectConfig) => void;
  const captureConfig = new Promise<ConnectConfig>((resolve) => {
    resolveConfig = resolve;
  });
  const client = Object.assign(emitter, {
    connect: (config: ConnectConfig) => {
      resolveConfig({ ...config });
      return client;
    },
    destroy: () => client,
    end: () => client,
    exec: () => client,
  });
  return { client: client as unknown as Client & EventEmitter, captureConfig };
}

/**
 * A fake ssh2 Client that completes the handshake ('ready') and exposes an
 * externally-controllable stream. Used to prove that a command running with no
 * output for >30s does NOT fail once the socket idle-timeout is removed.
 */
function createReadyClientWithManualClose(): {
  client: Client & EventEmitter;
  stream: EventEmitter;
} {
  const emitter = new EventEmitter();
  const stderr = new EventEmitter();
  const stream = Object.assign(new EventEmitter(), { stderr, end: () => stream });
  const client = Object.assign(emitter, {
    connect: () => {
      queueMicrotask(() => emitter.emit("ready"));
      return client;
    },
    destroy: () => client,
    end: () => client,
    exec: (_cmd: string, cb: (err: Error | undefined, ch: ClientChannel) => void) => {
      queueMicrotask(() => cb(undefined, stream as unknown as ClientChannel));
      return client;
    },
  });
  return { client: client as unknown as Client & EventEmitter, stream };
}
