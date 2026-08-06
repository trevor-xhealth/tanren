// THE FAIL-CLOSED SHAPES of the provision command, and the stall carve-out on the
// infrastructure classifier. Split from ./toolchainProvision.test.ts, which is at its
// file-length ceiling; the subject is the same command builder.

import { describe, expect, it } from "vitest";
import { MISE_LOCK_SLICE_SECONDS, MISE_LOCK_WAIT_SECONDS, miseRunScope } from "../src/engine/ssh/miseActivate.js";
import { detectToolchainRequirements } from "../src/engine/workspace/toolchainDeclarations.js";
import {
  classifyToolchainFault,
  NO_DECLARATION_NOTICE,
  toolchainProvisionCommand,
  WorkspaceToolchainUnavailableError,
} from "../src/engine/workspace/toolchainProvision.js";

const workspacePath = "/ws/run/repo";
const RUN_A = "/workspace/runs/run_alpha/repo";
const MAINSTREAM_DECLARATIONS = [
  { path: "package.json", contents: '{"packageManager":"pnpm@11.19.0"}' },
  { path: "uv.lock", contents: "" },
];

describe("toolchainProvisionCommand · fails closed WITHOUT leaning on the caller's `set -e`", () => {
  // THE DEFECT. `provisionMiseToolchain` wraps the whole provision in `set -e`; the
  // per-gate door (`ensureWorkspaceDepsInstalled`) deliberately does not, because the
  // provision has to leave its exports and its `mise env` PATH in the SAME shell that then
  // runs the project's bootstrap. Under that caller every masked failure was reported as a
  // successful provision: the command is a `;`-joined list, so its status was only its LAST
  // element's — a `printf` — and `underMiseLock` ended on a lock-sentinel test that returns
  // 0 whenever the lock opened. A failed `mise install` therefore ran the project's own
  // bootstrap against a toolchain that was never installed.
  const a = (): string => toolchainProvisionCommand(detectToolchainRequirements(MAINSTREAM_DECLARATIONS), RUN_A);

  it("re-raises the status of the work done under the lock", () => {
    expect(a()).toContain("|| __tanren_mise_rc=$?");
    expect(a()).toContain('[ "$__tanren_mise_rc" = 0 ] ||');
    expect(a()).toContain('exit "$__tanren_mise_rc"');
    // …and it is raised AFTER the lock-sentinel check, so a skipped group still reports the
    // skip rather than the body status it never produced.
    expect(a().indexOf('[ "$__tanren_mise_lock" = 1 ]')).toBeLessThan(a().indexOf('[ "$__tanren_mise_rc" = 0 ]'));
  });

  it("chains the locked body with `&&`, so a failed trust never reaches `mise use`", () => {
    expect(a()).toContain(`mise trust "${miseRunScope(RUN_A).configFile}" && mise use --global`);
    expect(a()).not.toContain(`mise trust "${miseRunScope(RUN_A).configFile}"; mise use --global`);
  });

  it("checks `mise env`'s status instead of eval-ing a command substitution that swallowed it", () => {
    // `eval "$(mise env -s bash)"` reports EVAL's status, never the substitution's: a dead
    // `mise env` evaluates to an empty string and "succeeds", and the verification below
    // then probes an un-updated PATH.
    expect(a()).not.toContain('eval "$(mise env -s bash)"');
    expect(a()).toContain('__tanren_mise_env="$(mise env -s bash)" ||');
    expect(a()).toContain('eval "$__tanren_mise_env"');
  });

  it("checks the marker write, because the marker is what activates the toolchain later", () => {
    expect(a()).toContain(`: > "${miseRunScope(RUN_A).markerFile}" ||`);
    expect(a()).toContain("could not write the provisioned marker");
  });

  it("makes the shared-lock WAIT observable, so the activity watchdog does not read it as wedged", () => {
    // The lock and the shared mise data dir live OUTSIDE the workspace, and the `vcs`
    // watchdog's liveness probe only looks INSIDE it. A single `flock -w 900` is therefore
    // 15 minutes of silence against a watchdog that destroys the connection after ~45s of
    // it — the declared budget was unreachable, and a contended lock killed the command
    // rather than waiting for it. The wait is taken in slices that report progress.
    const cmd = a();
    expect(MISE_LOCK_SLICE_SECONDS).toBeLessThan(MISE_LOCK_WAIT_SECONDS);
    expect(cmd).toContain("waiting for the shared mise lock");
    expect(cmd).toContain(`__tanren_mise_waited=$((__tanren_mise_waited + ${String(MISE_LOCK_SLICE_SECONDS)}))`);
    // A `flock` that is MISSING (127) is not a contended lock and must not be retried in
    // the wait loop until the budget runs out.
    expect(cmd).toContain('[ "$__tanren_flock_rc" = 1 ] ||');
    expect(cmd).toContain("flock is unavailable on this runner");
  });
});

describe("classifyToolchainFault · a STALL is a liveness fault, never a missing toolchain", () => {
  it("declines a stalled result even when its partial output names a missing binary", () => {
    // A guard that wedged can carry a `pnpm: not found` the project's bootstrap wrote
    // moments earlier. Classified as infrastructure it halts a run the writer path could
    // have re-driven — and the message would read `exited unknown`, because a stall has no
    // exit code, instead of saying the command stopped showing signs of life.
    const detection = detectToolchainRequirements(MAINSTREAM_DECLARATIONS);
    const shared = { workspacePath, command: "just bootstrap", outputTail: "sh: 1: pnpm: not found", detection };
    expect(classifyToolchainFault({ ...shared, exitCode: null, stalled: true })).toBeUndefined();
    // The same output on a real nonzero exit still classifies — the narrowing is the STALL,
    // not the pattern.
    expect(classifyToolchainFault({ ...shared, exitCode: 127, stalled: false })).toBeInstanceOf(
      WorkspaceToolchainUnavailableError,
    );
  });
});

describe("toolchainProvisionCommand · this gate's config says what THIS gate detected", () => {
  const scope = miseRunScope(RUN_A);

  it("TRUNCATES the per-run config before adding, so a dropped declaration is really dropped", () => {
    // `mise use --global` is ADDITIVE (removal is `--remove`), and the config is per-RUN
    // while detection is per-GATE. A writer who deletes `.nvmrc` mid-run left the previous
    // gate's `node` entry in place, and the marker kept `mise env` putting it on PATH — the
    // repo gated against a tool it no longer declares, which is the same defect this PR
    // halts on, arriving by the back door.
    const command = toolchainProvisionCommand(detectToolchainRequirements(MAINSTREAM_DECLARATIONS), RUN_A);
    expect(command).toContain(`: > "${scope.configFile}" && mise trust "${scope.configFile}"`);
    expect(command).not.toContain(`[ -f "${scope.configFile}" ] ||`);
  });

  it("RETRACTS the marker when this gate detects nothing at all", () => {
    // Nothing declared now must mean nothing active. Left alone, the marker from an earlier
    // gate keeps activating a toolchain the current detection does not name.
    const command = toolchainProvisionCommand(detectToolchainRequirements([]), RUN_A);
    expect(command).toContain(`rm -f "${scope.markerFile}" "${scope.configFile}"`);
    expect(command).toContain(NO_DECLARATION_NOTICE);
  });
});

describe("classifyToolchainFault · a declared tool is matched by its BINARY, not its tool name", () => {
  it("recognizes `cargo` as the binary of a declared-but-unhonored `rust`", () => {
    // `unresolved[].tool` is a mise TOOL name; the shell reports a BINARY. They differ for
    // exactly the two interesting entries — rust→cargo, python→python3 — so a
    // `rust-toolchain.toml` the operator DID declare produced a halt telling them to declare
    // it.
    const detection = detectToolchainRequirements([{ path: "rust-toolchain.toml", contents: 'channel = "stable"\n' }]);
    expect(detection.unresolved[0]?.tool).toBe("rust");
    const fault = classifyToolchainFault({
      workspacePath,
      command: "just bootstrap",
      exitCode: 127,
      outputTail: "sh: 1: cargo: not found",
      stalled: false,
      detection,
    });
    expect(fault).toBeInstanceOf(WorkspaceToolchainUnavailableError);
    expect(fault?.message).toContain("'cargo' WAS declared, but Tanren could not turn that declaration");
    expect(fault?.message).not.toContain("Declare 'cargo' in one of those files");
  });
});
