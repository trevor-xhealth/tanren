import { Client } from "ssh2";
import type { ClientChannel, ServerHostKeyAlgorithm } from "ssh2";
import type { RunnerHandle, SshRunnerHandle } from "../contracts/allocator.js";
import { asSshRunnerHandle } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type {
  ActivityWatchdog,
  RunnerCommand,
  CommandResult,
  CommandSubstrate,
  ProbeObservation,
  StallKind,
} from "../contracts/commandSubstrate.js";
import { buildSshExecCommand } from "./command.js";
import { hostKeyFingerprintMatches } from "./fingerprint.js";
import {
  capturedOutput,
  createRunState,
  formatTarget,
  messageFromError,
  type RunState,
  sshFailureResult,
  stallKindMessage,
} from "./runState.js";
import {
  appendWorkSignature,
  distinctRecentOutput,
  isWedgedNonAdvancing,
  MIN_UNOBSERVABLE_PROBE_REPEATS,
  workSignature,
} from "./watchdogProgress.js";

// The default cadence at which the activity watchdog consults its `livenessProbe`
// between output chunks. A poll INTERVAL (how often to ask "is it alive?"), NOT a
// total-duration budget — every tick that finds life RESETS, so it never accumulates
// toward a kill.
const DEFAULT_PROBE_INTERVAL_MS = 5_000;

// The default connect-ESTABLISHMENT bound (TCP connect + SSH handshake/auth) applied
// when a command supplies no `connectTimeoutMs`. This is the ONE legitimate time
// bound the substrate keeps: a connection that never establishes has no running work
// to lose. It bounds ONLY the handshake — once the channel is up the command runs
// UNBOUNDED, governed solely by the activity watchdog.
const DEFAULT_CONNECT_ESTABLISH_MS = 30_000;

type Ssh2Client = Pick<Client, "connect" | "destroy" | "end" | "exec" | "once" | "on">;
type Ssh2ClientFactory = () => Ssh2Client;

export interface SshCommandSubstrateOptions {
  clientFactory?: Ssh2ClientFactory;
  connectTimeoutMs?: number;
  serverHostKeyAlgorithms?: ServerHostKeyAlgorithm[];
}

export class SshCommandSubstrate implements CommandSubstrate {
  private readonly clientFactory: Ssh2ClientFactory;

  constructor(
    private readonly secrets: SecretStore,
    private readonly options: SshCommandSubstrateOptions = {},
  ) {
    this.clientFactory = options.clientFactory ?? (() => new Client());
  }

  async run(handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    // The CommandSubstrate contract surface is the OPAQUE RunnerHandle; the SSH
    // impl narrows it to its concrete SshRunnerHandle (LOUD if a non-SSH handle is
    // ever routed here) and reads its reach fields from there.
    const target = asSshRunnerHandle(handle);
    const identity = await this.secrets.get(target.identitySecretRef);
    if (identity === undefined) {
      return sshFailureResult(target, `missing SSH identity secret: ${target.identitySecretRef}`);
    }

    let execCommand: string;
    try {
      execCommand = buildSshExecCommand(command);
    } catch (error) {
      return sshFailureResult(target, messageFromError(error));
    }

    return await this.runClient(target, command, identity.value, execCommand);
  }

  private async runClient(
    target: SshRunnerHandle,
    command: RunnerCommand,
    privateKey: string,
    execCommand: string,
  ): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve) => {
      const client = this.clientFactory();
      // Retention DEFAULTS to "full": the ~19 consumers that reconstruct a whole file or
      // parse/count across the whole stream must never be truncated implicitly. A call
      // site opts into "bounded" when it can show only a tail is read.
      const retention = command.outputRetention ?? "full";
      const state: RunState = createRunState(retention);
      let hostKeyFailure: string | undefined;

      // The watchdog is the SOLE hang detector — every command runs one. When the
      // caller supplies none, a default OUTPUT-DRIVEN watchdog (no probe) governs: it
      // still never kills for elapsed time, only surfaces a recoverable stall on a
      // genuine silent death. Callers wanting a silent-op liveness probe build their
      // watchdog via the shared `buildActivityWatchdog` factory.
      const watchdog: ActivityWatchdog = command.watchdog ?? { onQuiet: "surface" };

      const settle = (result: CommandResult, close: "end" | "destroy" = "end"): void => {
        if (state.settled) {
          return;
        }
        state.settled = true;
        if (state.probeTimer !== undefined) {
          clearInterval(state.probeTimer);
        }
        if (close === "destroy") {
          client.destroy();
        } else {
          client.end();
        }
        resolve(result);
      };

      const fail = (message: string): void => {
        settle(
          {
            ...sshFailureResult(target, message),
            ...capturedOutput(state),
          },
          "destroy",
        );
      };

      client.once("ready", () => {
        client.exec(execCommand, (error, stream) => {
          if (error !== undefined) {
            fail(messageFromError(error));
            return;
          }
          this.collectStream(
            stream,
            state,
            (channelError) => fail(messageFromError(channelError)),
            () => {
              settle({
                exitCode: state.exitCode,
                ...capturedOutput(state),
                signal: state.signal,
              });
            },
          );
          // The watchdog arms only AFTER the channel is up (the connect-establishment
          // bound governs the handshake; the watchdog governs the running command).
          this.armActivityWatchdog(target, state, watchdog, client, resolve);
          if (command.stdin !== undefined) {
            stream.end(command.stdin);
          }
        });
      });
      // PERSISTENT listener (`.on`, not `.once`): ssh2 emits "error" AGAIN during
      // teardown after a pre-handshake connection loss (e.g. "Connection lost
      // before handshake" then a second protocol error once `client.destroy()`
      // runs in settle()). With `.once` that second emission has no listener and
      // Node's EventEmitter throws an unhandled "error" → the whole control plane
      // exits(1) on a single transient SSH blip. The `state.settled` guard makes a
      // repeat invocation a harmless no-op, so we keep listening and swallow it.
      // A long-lived listener on a destroyed client is fine — it is GC'd with the
      // client when this run's promise settles.
      client.on("error", (error: Error) => fail(hostKeyFailure ?? messageFromError(error)));
      const connectMs = this.options.connectTimeoutMs ?? command.connectTimeoutMs ?? DEFAULT_CONNECT_ESTABLISH_MS;
      // The connect-ESTABLISHMENT timeout (handshake only): a connection that never
      // comes up has no running work to lose. This is the ONE legitimate time bound;
      // it governs ONLY the handshake — once the channel is up the command runs
      // UNBOUNDED, governed solely by the ActivityWatchdog (progress-based).
      // NOTE: we deliberately omit ssh2's `timeout` connect-config option. In ssh2
      // 1.17.0, `timeout` is forwarded to the underlying socket as a connection-
      // LIFETIME idle timeout (socket.setTimeout) — NOT a handshake-only bound. A
      // codex command with >30s reasoning gaps (no stdout) would fire the ssh2
      // 'timeout' event mid-run and kill a still-alive command, which is a disguised
      // wall-clock deadline (the whole class eradicated in #609–#622). `readyTimeout`
      // is the correct handshake-only bound and is all we need here.
      // Keepalive detects a genuinely DEAD TCP connection (the legitimate concern the
      // socket idle-timeout was crudely serving) without killing a working-but-silent
      // command. CRUCIAL DISTINCTION: a keepalive probe is a TRANSPORT-level SSH ping the
      // peer answers from its protocol stack — INDEPENDENT of whether the running command
      // emits output — so a quiet-but-alive command (a long silent `jj rebase`, a stalled-
      // but-connected download) keeps ANSWERING the probes and is NEVER killed. The probe
      // ERRORS only on UNANSWERED pings = a truly dead socket (peer gone / network
      // partition). So `keepaliveCountMax` is a DEAD-SOCKET detector, not a wall-clock budget
      // on working code. #638 set it to 1440 (15s × 1440 ≈ 6 HOURS) mirroring the runner
      // sshd's ClientAliveCountMax — far too long: a job whose runner connection genuinely
      // died sat undetected for hours (the apex-v45 wedge class — the ActivityWatchdog is the
      // primary catch, but this is the transport backstop and it must not lag by 6h). We
      // declare a dead socket after 40 unanswered probes — 15s × 40 = 10 MINUTES — long
      // enough to ride out a transient network blip, short enough to surface a dead socket
      // promptly. It never touches a live command (which answers every probe).
      client.once("timeout", () => fail(`SSH connection failed to establish within ${connectMs}ms`));
      client.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey,
        authHandler: ["publickey"],
        hostHash: "sha256",
        hostVerifier: (fingerprint: string) => {
          const matches = hostKeyFingerprintMatches(fingerprint, target.hostKeyFingerprint);
          if (!matches) {
            hostKeyFailure = `SSH host key fingerprint mismatch for ${formatTarget(target)}`;
          }
          return matches;
        },
        readyTimeout: connectMs,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 40,
        algorithms:
          this.options.serverHostKeyAlgorithms === undefined
            ? undefined
            : { serverHostKey: this.options.serverHostKeyAlgorithms },
      });
    });
  }

  private collectStream(
    stream: ClientChannel,
    state: RunState,
    onError: (error: unknown) => void,
    onClose: () => void,
  ): void {
    // Fold output into TWO bounded sinks (F-9): the RETAINED capture the caller receives
    // (head+tail under `"bounded"`, everything under the `"full"` default) and the small
    // RECENT window the watchdog drains each tick. Neither is the unbounded `+=` this
    // replaced. Stamp `lastActivityAt` as the last-output time: diagnostic evidence for
    // `quietForMs`, not the progress trigger (which is the work-signature advancement read
    // in tickWatchdog).
    const markActivity = (): void => {
      state.lastActivityAt = Date.now();
    };
    stream.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      state.stdout.append(text);
      state.recentOutput.append(text);
      markActivity();
    });
    stream.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      state.stderr.append(text);
      state.recentOutput.append(text);
      markActivity();
    });
    stream.on("error", onError);
    stream.stderr.on("error", onError);
    stream.once("exit", (code: number | null, signal?: string) => {
      state.exitCode = code;
      state.signal = signal;
    });
    stream.once("close", onClose);
  }

  // Arm the PROGRESS-BASED activity watchdog (the doctrine's wall-clock-kill replacement).
  // It does NOT count toward any total-duration budget. On a recurring poll CADENCE it
  // snapshots a WORK SIGNATURE of the exec — the recent OUTPUT TAIL folded with the remote
  // WORKSPACE signature the `livenessProbe` reads (for SILENT ops like a long `jj rebase` the
  // probe IS the signal: the workspace tree GROWING — file count + byte total, which advance as files
  // are written, and which a single heartbeat-touched lock file canNOT advance — apex-v45) —
  // and feeds the SEQUENCE into the shared convergence detector. A CHANGING signature (new
  // distinct output OR an advancing workspace) is genuine progress → RESET → continue
  // UNBOUNDED. Output chunks ALSO short-circuit a tick (see collectStream + the fast path
  // below). The watchdog fires ONLY when the work signature is at a FIXED POINT across
  // successive checks — no new output AND no workspace advance — which covers BOTH a
  // dead/zombied/deadlocked process AND a WEDGED-BUT-BUSY one (an infinite loop emitting
  // byte-identical output, a CPU-burn touching nothing). Even then it SURFACES a recoverable
  // `stalled` result by default (never destroying possibly-recoverable work) unless
  // `onQuiet: "kill"`. A genuinely-advancing process is never killed regardless of elapsed time.
  private armActivityWatchdog(
    target: SshRunnerHandle,
    state: RunState,
    watchdog: ActivityWatchdog,
    client: Ssh2Client,
    resolve: (result: CommandResult) => void,
  ): void {
    const onQuiet = watchdog.onQuiet ?? "surface";
    // Baseline the tick window at arm time so the first tick can tell whether output arrived since.
    state.lastProbeTickAt = Date.now();
    // The probe poll cadence (an INTERVAL, not a deadline — it resets on every sign of life).
    const intervalMs = watchdog.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    state.probeTimer = setInterval(() => {
      void this.tickWatchdog(target, state, watchdog, onQuiet, client, resolve);
    }, intervalMs);
    // Do not hold the event loop open on the probe tick alone.
    state.probeTimer.unref?.();
  }

  private async tickWatchdog(
    target: SshRunnerHandle,
    state: RunState,
    watchdog: ActivityWatchdog,
    onQuiet: "surface" | "kill",
    client: Ssh2Client,
    resolve: (result: CommandResult) => void,
  ): Promise<void> {
    // RE-ENTRY GUARD (F-10). The tick runs on a `setInterval`, so when a probe is slower
    // than the cadence the ticks USED to overlap — each opening its own SSH exec channel
    // against the very runner that is already struggling, compounding the slowness that
    // triggered it. A tick that arrives while the previous probe is still in flight is
    // simply skipped: the in-flight probe will report, and nothing about the running command
    // is bounded by how many ticks we skipped.
    if (state.settled || state.probeInFlight) {
      return;
    }
    state.lastProbeTickAt = Date.now();
    // PROGRESS backstop: snapshot a WORK SIGNATURE — the NEW DISTINCT OUTPUT since the prior
    // snapshot (rate-independent — see distinctRecentOutput) folded with the remote WORKSPACE
    // signature the probe reads — and feed the SEQUENCE into the shared convergence detector.
    // The output content folded INTO the signature is what distinguishes a streaming process
    // (new distinct lines = an advancing signature) from a wedged-busy one (byte-identical
    // output = a fixed signature, however fast it repeats); for SILENT ops the probe IS the
    // signal (blocks/inodes consumed + the workspace's top-level digest).
    const observation = await this.readObservation(state, watchdog);
    if (state.settled) {
      return;
    }
    // DRAIN the bounded recent-output window (F-9): everything that arrived since the last
    // tick, deduped to its DISTINCT lines (rate-independent — see distinctRecentOutput).
    // `priorLen` is 0 because the window already contains only the increment — no
    // re-concatenation of the whole retained stream, and no char cursor to keep in sync.
    const recent = distinctRecentOutput(state.recentOutput.drain(), 0);
    // An UNOBSERVABLE probe is NOT a fixed point (F-10) — it is the ABSENCE of evidence, and
    // it is routed away from the progress read entirely so a slow or failing side-channel can
    // never be re-told as "the step stalled". A watchdog with NO probe at all is a different
    // case: output alone decides, exactly as before.
    if (watchdog.livenessProbe !== undefined && observation?.observed !== true) {
      this.tickUnobservable(target, state, onQuiet, recent.content, client, resolve);
      return;
    }
    state.unobservableProbeStreak = 0;
    const workspaceSig = observation?.observed === true ? observation.signature : undefined;
    const signature = workSignature(recent.content, workspaceSig);
    const priorSignature = state.workSignatures.at(-1);
    state.workSignatures = appendWorkSignature(state.workSignatures, signature);
    // CROSS-LAYER sign-of-life bridge (task #24, apex v52/v53). The watchdog already
    // detects work-signature advancement on every probe tick (the negation of the
    // fixed-point read below). On ticks where the signature ADVANCED — either the FIRST
    // ever (no prior) or the new one differs from the previous — invoke `onProgress` so
    // the writer pipeline can bridge the signal (emitting `writer.subtask.progress`) to
    // any parent progress reader. A throw from `onProgress` MUST NOT bubble into the tick
    // (it would crash the probe loop and look like a stall) — swallow it. Composes with
    // the `MIN_NON_ADVANCING_NEIGHBOR_REPEATS_*` streak floor (see watchdogProgress.ts)
    // so a brief mid-IO-burst signature plateau on a legitimately slow writer does not
    // trip a spurious wedge.
    const signatureAdvanced = priorSignature === undefined || priorSignature !== signature;
    if (signatureAdvanced && watchdog.onProgress !== undefined) {
      try {
        watchdog.onProgress({
          outputBytesAdvanced: recent.content.length,
          workspaceSignature: workspaceSig,
          workSignatureAdvanced: true,
        });
      } catch {
        // event-emit failure must not bubble into the watchdog tick
      }
    }
    // The verdict turns ENTIRELY on whether the WORK SIGNATURE is ADVANCING. A CHANGING
    // signature (new distinct output OR an advancing workspace) is genuine progress → continue
    // UNBOUNDED, no matter the elapsed time. A FIXED POINT (no new distinct output AND no
    // workspace advance across successive checks) is a WEDGE — dead/zombied OR busy-but-not-
    // advancing (an infinite loop spewing identical lines / a CPU-burn touching nothing) — and
    // surfaces a stall. The decision is signature IDENTITY, never a duration.
    if (!isWedgedNonAdvancing(state.workSignatures, { minNonAdvancingRepeats: watchdog.minNonAdvancingRepeats })) {
      return;
    }
    // The work signature is at a fixed point: no NEW distinct work across the checks.
    // `quietForMs` is EVIDENCE of how long since the last output — diagnostic only; the trigger
    // is the non-advancing work signature, never a fixed quiet duration on its own.
    const quietForMs = Date.now() - state.lastActivityAt;
    this.fireWatchdog(target, state, onQuiet, quietForMs, client, resolve, "no_progress");
  }

  // Run the probe under the re-entry guard. Returns `undefined` when the watchdog has no
  // probe at all (the output-only class — output alone decides, exactly as before). A probe
  // that THREW is an unobservable read, not a signature and not a fixed point.
  private async readObservation(state: RunState, watchdog: ActivityWatchdog): Promise<ProbeObservation | undefined> {
    if (watchdog.livenessProbe === undefined) {
      return undefined;
    }
    state.probeInFlight = true;
    try {
      return await watchdog.livenessProbe();
    } catch {
      return { observed: false, reason: "probe_failed" };
    } finally {
      state.probeInFlight = false;
    }
  }

  // A tick whose probe OBSERVED NOTHING (F-10). The old code folded this into a fixed
  // sentinel, so two consecutive slow/failed reads reached the progress floor and aborted a
  // healthy step. It now contributes NOTHING to the work-signature history — the trailing
  // streak neither advances nor resets — and is tracked on its own, wider streak instead.
  //
  //   - New distinct output this tick? The step is demonstrably alive whether or not we can
  //     see its workspace: reset the streak and stop.
  //   - Otherwise the streak grows, and only once it reaches MIN_UNOBSERVABLE_PROBE_REPEATS
  //     do we surface — under `"probe_unobservable"`, never disguised as a stalled agent —
  //     so a permanently blind probe cannot leave a genuinely wedged step unwatched forever.
  private tickUnobservable(
    target: SshRunnerHandle,
    state: RunState,
    onQuiet: "surface" | "kill",
    recentContent: string,
    client: Ssh2Client,
    resolve: (result: CommandResult) => void,
  ): void {
    if (recentContent !== "") {
      state.unobservableProbeStreak = 0;
      return;
    }
    state.unobservableProbeStreak += 1;
    if (state.unobservableProbeStreak < MIN_UNOBSERVABLE_PROBE_REPEATS) {
      return;
    }
    const quietForMs = Date.now() - state.lastActivityAt;
    this.fireWatchdog(target, state, onQuiet, quietForMs, client, resolve, "probe_unobservable");
  }

  // The watchdog fired on a genuine absence of all signals. SURFACE a recoverable `stalled`
  // result (default — the caller re-drives) or KILL the transport (`onQuiet: "kill"`).
  private fireWatchdog(
    target: SshRunnerHandle,
    state: RunState,
    onQuiet: "surface" | "kill",
    quietForMs: number,
    client: Ssh2Client,
    resolve: (result: CommandResult) => void,
    stallKind: StallKind,
  ): void {
    if (state.settled) {
      return;
    }
    state.settled = true;
    if (state.probeTimer !== undefined) {
      clearInterval(state.probeTimer);
    }
    client.destroy();
    if (onQuiet === "surface") {
      resolve({
        exitCode: null,
        ...capturedOutput(state),
        signal: state.signal,
        stalled: true,
        stallKind,
        quietForMs,
      });
      return;
    }
    resolve({
      ...sshFailureResult(target, stallKindMessage(stallKind)),
      ...capturedOutput(state),
      stalled: true,
      stallKind,
      quietForMs,
    });
  }
}
