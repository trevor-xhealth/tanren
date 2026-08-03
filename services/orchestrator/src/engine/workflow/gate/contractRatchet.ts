// THE GATE-CONTRACT RATCHET, wired to a real workspace: read the BASELINE `.tanren/ci.yml` out
// of git history and refuse to be graded by a head contract that demands less than it (see
// `engine/ci/ratchet.ts` for what "less" means and why it is a ratchet rather than a ban).
//
// WHERE THE BASELINE COMES FROM. The floor is "the contract this line of work started from",
// resolved in this order:
//   1. an EXPLICIT revision the caller names. The run loop passes the run's own base commit —
//      a commit TANREN created (workspace bootstrap), before the writer ran, so the writer
//      cannot choose it. This is the enforcing path, and it is fail-closed: a named revision
//      that cannot be read throws {@link GateContractBaselineError} rather than skipping.
//   2. `origin/HEAD` — the remote's OWN declared default branch, discovered with no
//      branch-name convention baked in. The merge-base of the head with it is the divergence
//      point, so a trunk that moves under an in-flight run does not retro-fail it. This covers
//      tanren-made full clones (the fresh-runner merge gate) with zero plumbing.
//   3. the shallow graft boundary, for a `--depth 1` clone: the commit the workspace was
//      created at, which is precisely the contract as it stood when the run began.
// When none resolves — a workspace that is neither shallow nor carries `origin/HEAD` (a
// `jj git clone --colocate` tree is the real example: it writes `refs/remotes/origin/<branch>`
// but no `origin/HEAD`) — the probe reports NO baseline and the ratchet is skipped. That is a
// deliberate, documented limit rather than a bypass: those workspaces are tanren-created clones
// the writer never touches, and their head content already passed the run-loop ratchet.
//
// WHAT THIS DOES NOT PROTECT. The ratchet compares the DECLARATIVE contract. It does not read
// the `run:` command strings, which are opaque shell by design (tanren names no stack), so a
// writer that leaves `.tanren/ci.yml` untouched and instead hollows out what those commands
// invoke — the justfile recipe, the test config, the tests themselves — reaches the gate by a
// path this module cannot see. The evidence contract still bites there (a hollowed test run
// that executes 151 of 11000 tests fails `minTests`), which is why the ratchet's job is
// specifically to keep that threshold from being lowered.
import type { RunnerHandle } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import {
  type CiConfigV1,
  DEFAULT_CI_CONFIG,
  detectGateWeakening,
  GateContractBaselineError,
  GateContractWeakenedError,
  resolveCiConfig,
} from "../../ci/index.js";
import { quoteSshShellArg } from "../../ssh/command.js";
import { outputOnlyWatchdog } from "../../ssh/activityWatchdog.js";
import { CI_CONFIG_FILENAME } from "./resolveGateConfig.js";
import { invalidCiConfigGateOutcome, isInvalidCiConfigError } from "./gateConfigFailure.js";
import type { CiWhen } from "../../ci/index.js";
import type { GateAppendEvent } from "./runGateTier.js";
import type { GateOutcome } from "./runGateForWhen.js";

// Sentinel first lines the in-workspace probe emits. They are ALWAYS printed by a real shell,
// so an empty stdout is unambiguously "no shell ran this" — the fake-substrate unit path, which
// resolves no baseline and therefore runs no ratchet (mirroring how `readCiConfigText` treats an
// empty read as "no config"). A real runner can never produce that.
const BASELINE_PRESENT = "tanren-baseline:present";
const BASELINE_ABSENT = "tanren-baseline:absent";
const BASELINE_NO_ANCHOR = "tanren-baseline:no-anchor";

/** The baseline contract for a workspace: its text, its documented absence, or no anchor at all. */
export type ContractBaseline =
  | { kind: "present"; config: CiConfigV1 }
  | { kind: "absent"; config: CiConfigV1 }
  | { kind: "unanchored" };

export interface ContractRatchetInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  /**
   * A git revision naming the contract's floor. Present ⇒ the ratchet is ENFORCED and a
   * revision that cannot be read is a loud failure. Absent ⇒ the anchor is discovered
   * (`origin/HEAD`, then the shallow graft) and a workspace with neither is skipped.
   */
  baselineRevision?: string;
}

/**
 * The in-workspace shell that resolves the baseline anchor and prints the contract as of it.
 * Pure reads: `rev-parse` / `merge-base` / `rev-list` / `cat-file` / `show`. It never writes,
 * never fetches, and never fails the command — every outcome is a sentinel on stdout, so a
 * NONZERO exit genuinely means the substrate or the workspace is broken.
 */
function baselineProbeCommand(workspacePath: string, revision: string | undefined): string {
  // EXPLICIT anchor: the named commit verbatim. It IS the base — no merge-base, no discovery
  // fallback, so a caller that names a floor can never be silently downgraded to a weaker one.
  const anchorLines =
    revision === undefined
      ? [
          // (2) the remote's OWN declared default branch, then where this head diverged from it.
          "if git rev-parse --verify --quiet origin/HEAD >/dev/null 2>&1; then",
          '  anchor="$(git merge-base HEAD origin/HEAD 2>/dev/null || true)"',
          "fi",
          // (3) a `--depth 1` clone's graft: the commit this workspace was created at.
          'if [ -z "$anchor" ] && [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = true ]; then',
          '  anchor="$(git rev-list --max-parents=0 HEAD 2>/dev/null | tail -n 1)"',
          "fi",
        ]
      : [`anchor="$(git rev-parse --verify --quiet ${quoteSshShellArg(revision)}^{commit} || true)"`];
  return [
    `cd ${quoteSshShellArg(workspacePath)} || exit 1`,
    'anchor=""',
    ...anchorLines,
    'if [ -z "$anchor" ]; then',
    `  echo ${quoteSshShellArg(BASELINE_NO_ANCHOR)}`,
    `elif git cat-file -e "$anchor:${CI_CONFIG_FILENAME}" 2>/dev/null; then`,
    `  echo ${quoteSshShellArg(BASELINE_PRESENT)}`,
    `  git show "$anchor:${CI_CONFIG_FILENAME}"`,
    "else",
    `  echo ${quoteSshShellArg(BASELINE_ABSENT)}`,
    "fi",
  ].join("\n");
}

/**
 * Resolve the baseline contract for a workspace. An ABSENT baseline file is not a gap: it
 * resolves to the documented default config, which is the same floor the gate itself would use,
 * so a repo introducing its first `.tanren/ci.yml` is measured as strengthening.
 */
export async function resolveContractBaseline(input: ContractRatchetInput): Promise<ContractBaseline> {
  // An EMPTY revision is not a revision. The run's base sha is `""` on the fake-substrate unit
  // paths (workspace bootstrap returns `""` when no shell ran), and on a real runner it is
  // always a validated 40-hex sha — so "" unambiguously means "no real workspace", and falls
  // through to discovery rather than being treated as an unreadable floor.
  const explicit = input.baselineRevision === "" ? undefined : input.baselineRevision;
  const result = await input.ssh.run(input.target, {
    command: baselineProbeCommand(input.workspacePath, explicit),
    // INFRA read: output-driven watchdog, no wall-clock kill.
    watchdog: outputOnlyWatchdog(),
  });
  if (result.failure !== undefined || result.stalled === true || result.exitCode !== 0) {
    if (explicit === undefined) return { kind: "unanchored" };
    throw new GateContractBaselineError(explicit, describeReadFailure(result));
  }
  const [marker, ...rest] = result.stdout.split("\n");
  const head = (marker ?? "").trim();
  if (head === BASELINE_PRESENT) {
    return { kind: "present", config: resolveCiConfig(rest.join("\n")) };
  }
  if (head === BASELINE_ABSENT) {
    return { kind: "absent", config: DEFAULT_CI_CONFIG };
  }
  // NO SENTINEL AT ALL means no shell ran this — the fake-substrate unit path. A real shell
  // always reaches one of the three `echo`s (the only early exit is a failed `cd`, which exits
  // nonzero and was already handled above), so this can never be a writer covering its tracks.
  if (head === "") return { kind: "unanchored" };
  // A real shell that could not resolve the anchor. With a caller-named floor that is FAIL
  // CLOSED — being unable to tell whether the bar was lowered is not permission to lower it.
  if (explicit === undefined) return { kind: "unanchored" };
  throw new GateContractBaselineError(explicit, `unresolvable revision (${head})`);
}

function describeReadFailure(result: Awaited<ReturnType<CommandSubstrate["run"]>>): string {
  if (result.failure !== undefined) {
    const detail = "message" in result.failure ? result.failure.message : result.failure.reason;
    return `substrate ${result.failure.kind}: ${detail}`;
  }
  if (result.stalled === true) return "stalled (no sign of life)";
  return `nonzero exit ${String(result.exitCode)}`;
}

/**
 * THE ENFORCEMENT. Throws {@link GateContractWeakenedError} when `headConfig` demands less at a
 * ratcheted lifecycle point than the workspace's baseline contract does. Returns normally when
 * the head is equal or stricter — including when the head STRENGTHENS the gate, which is the
 * case that must keep working: the run then proceeds and is graded by its own new, higher bar.
 *
 * A baseline that is INVALID (the repo shipped a broken contract that has since been fixed)
 * propagates the resolver's own validation error, which the gate boundary already treats as a
 * fail-closed, writer-fixable gate failure.
 */
export async function assertGateContractNotWeakened(
  input: ContractRatchetInput & { headConfig: CiConfigV1 },
): Promise<void> {
  const baseline = await resolveContractBaseline(input);
  if (baseline.kind === "unanchored") return;
  const findings = detectGateWeakening(baseline.config, input.headConfig);
  if (findings.length > 0) {
    throw new GateContractWeakenedError(findings);
  }
}

/**
 * GATE-CONTRACT RATCHET at the run loop's gate — re-measured on EVERY gate call, deliberately
 * NOT memoized alongside the config. The writer mutates the workspace between iterations, so a
 * contract lowered at iteration 5 must be caught at iteration 5; the memoized config would keep
 * grading against iteration 1's shape while the PUSHED head carried the weakened one.
 *
 * Returns the fail-closed gate FAILURE when the head `.tanren/ci.yml` demands less than the
 * contract this run is based on (or when an explicitly-named floor cannot be read), and
 * `undefined` when the run may proceed — including when it STRENGTHENED its own gate, which is
 * then what grades it. The failure message names `.tanren/ci.yml`, which is exactly what makes
 * the writer loop's existing contract-violation steering tell the writer to revert that file and
 * nothing else. Any other throw (a substrate fault) propagates loudly, unchanged.
 */
export async function gateContractRatchetFailure(args: {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  headConfig: CiConfigV1;
  baselineRevision: string | undefined;
  when: CiWhen;
  appendEvent: GateAppendEvent;
  taskId?: string;
}): Promise<Extract<GateOutcome, { passed: false }> | undefined> {
  try {
    await assertGateContractNotWeakened({
      ssh: args.ssh,
      target: args.target,
      workspacePath: args.workspacePath,
      headConfig: args.headConfig,
      ...(args.baselineRevision === undefined ? {} : { baselineRevision: args.baselineRevision }),
    });
    return undefined;
  } catch (error: unknown) {
    if (isInvalidCiConfigError(error)) {
      return await invalidCiConfigGateOutcome(error, args.when, args.appendEvent, args.taskId);
    }
    throw error;
  }
}
