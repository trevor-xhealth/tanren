// Reads the target repo's native gate definition (`.tanren/ci.yml`) off the
// bootstrapped runner workspace and resolves it into a typed CiConfigV1. This is the
// SAME file `configInjection` writes — the native delivery model's single gate
// definition (NOT a GitHub Actions workflow). When the file is ABSENT we hand
// `undefined` to resolveCiConfig, which yields the documented default tiers — never a
// silent empty gate. Invalid YAML/shape throws from the resolver, failing the run
// loudly rather than gating against nothing. A READ FAILURE (substrate error,
// timeout, nonzero exit) is NOT treated as "absent": it throws, so a transient
// substrate hiccup can never silently downgrade a repo's real gate to the defaults.
import { bootstrapCommand, type CiConfigV1, resolveCiConfig } from "../../ci/index.js";
import type { RunnerHandle } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import { quoteSshShellArg } from "../../ssh/command.js";
import { outputOnlyWatchdog } from "../../ssh/activityWatchdog.js";

// The native gate-definition path, relative to the workspace root. Exported so the
// gate-contract ratchet (contractRatchet.ts) reads the SAME path out of git history — one
// definition of "the repo's gate contract", never two that can drift apart.
export const CI_CONFIG_FILENAME = ".tanren/ci.yml";

export interface ResolveGateConfigInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
}

/**
 * Thrown when reading `.tanren/ci.yml` over the substrate FAILS (substrate error,
 * timeout, or nonzero/null exit). This is DISTINCT from the file being absent: an
 * absent file is a legitimate "no config → default tiers" signal, but a read
 * FAILURE must fail the run loudly (no-silent-fallback doctrine) rather than be
 * mistaken for "absent" and silently downgrade the repo's real gate to defaults.
 */
export class GateConfigReadError extends Error {
  constructor(detail: string) {
    super(`failed to read ${CI_CONFIG_FILENAME} from the runner workspace: ${detail}`);
    this.name = "GateConfigReadError";
  }
}

// Reads `<workspace>/.tanren/ci.yml` over SSH. Returns the raw file text when the
// file is present and non-empty, or `undefined` when it is genuinely ABSENT. The
// `cat`-if-present command emits nothing and exits 0 when the file does not exist,
// so an exit-0 empty read is the unambiguous "no config" case (→ undefined). A real
// read failure (substrate error, timeout, nonzero/null exit) is NOT "absent" — it
// throws {@link GateConfigReadError} so the run fails loudly instead of silently
// gating against the defaults.
async function readCiConfigText(input: ResolveGateConfigInput): Promise<string | undefined> {
  const path = `${input.workspacePath.replace(/\/+$/u, "")}/${CI_CONFIG_FILENAME}`;
  const result = await input.ssh.run(input.target, {
    command: `if [ -f ${quoteSshShellArg(path)} ]; then cat ${quoteSshShellArg(path)}; fi`,
    // INFRA config read: output-driven watchdog, no wall-clock kill.
    watchdog: outputOnlyWatchdog(),
  });
  if (result.failure !== undefined) {
    const detail = "message" in result.failure ? result.failure.message : result.failure.reason;
    throw new GateConfigReadError(`substrate ${result.failure.kind}: ${detail}`);
  }
  if (result.stalled === true) {
    throw new GateConfigReadError("stalled (no sign of life)");
  }
  if (result.exitCode !== 0) {
    throw new GateConfigReadError(`nonzero exit ${String(result.exitCode)}`);
  }
  return result.stdout.trim() === "" ? undefined : result.stdout;
}

// Reads `<workspace>/.tanren/ci.yml` over SSH and resolves it. A missing file
// resolves to the default config — never a silent empty gate. Invalid YAML/shape
// throws from the resolver, failing the run loudly rather than gating against
// nothing.
export async function resolveGateConfig(input: ResolveGateConfigInput): Promise<CiConfigV1> {
  return resolveCiConfig(await readCiConfigText(input));
}

// Resolves the bootstrap command for the workspace-bootstrap step from the repo's
// `.tanren/ci.yml` `bootstrap.run` (conventionally `just bootstrap`). Returns
// `undefined` when the repo declares no config file, so the caller's stack-agnostic
// DEFAULT_BOOTSTRAP_COMMAND LOUD-fallback applies (`just bootstrap` if a justfile is
// present, else a loud failure) — we only override that default when the repo
// actually ships a `.tanren/ci.yml` WITH a `bootstrap.run`. A present-but-invalid
// config still throws from resolveCiConfig, surfacing a misconfigured repo loudly.
// NOTE: `bootstrap.run` is OPTIONAL with no schema default, so a config that omits
// `bootstrap` (or `bootstrap.run`) yields `undefined` here too — the caller's
// fallback applies, NOT a baked-in command.
export async function resolveBootstrapCommand(input: ResolveGateConfigInput): Promise<string | undefined> {
  const text = await readCiConfigText(input);
  if (text === undefined) {
    return undefined;
  }
  return bootstrapCommand(resolveCiConfig(text));
}
