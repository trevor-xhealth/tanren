// env P0b/c — the project-command-vs-harness two-path separation for mise.
//
// The crux of wiring point 5: the PROJECT's gate/bootstrap commands run mise-ACTIVATED
// (so a bare `node`/`pnpm` resolves to the project's `mise.toml`-declared toolchain),
// while the HARNESS path (codex writer + answerer) is NEVER mise-activated (it keeps
// the runner's isolated node, per P0a). These tests pin both halves:
//   - `withMiseActivation` prefixes the project command with a guarded NON-INTERACTIVE
//     `mise activate bash --shims` (NOT the interactive hook mode — see below);
//   - `miseProvisionCommand` is a guarded `mise trust && mise install`;
//   - the codex exec command builders contain NO mise activation (the harness path).

import { describe, expect, it } from "vitest";
import {
  MISE_LOCK_SLICE_SECONDS,
  MISE_LOCK_WAIT_SECONDS,
  MISE_SHARED_LOCK_FILE,
  miseProvisionCommand,
  miseRunScope,
  miseSharedDirPrelude,
  withMiseActivation,
} from "../src/engine/ssh/miseActivate.js";
import { buildCodexAnswererExecCommand, buildCodexExecCommand } from "../src/engine/providers/codexExecCommand.js";
import { TANREN_BIN_ENV, workspaceToolBinDir } from "../src/engine/ssh/workspaceToolPath.js";

// Two concurrent runs on the ONE static runner container, as the SAME unix user — the
// posture the whole per-run-scope change exists for.
const RUN_A = "/workspace/runs/run_alpha/repo";
const RUN_B = "/workspace/runs/run_bravo/repo";

describe("withMiseActivation · the PROJECT-command path is mise-activated", () => {
  it("prefixes the command with a NON-INTERACTIVE `--shims` activate, guarded on a mise.toml", () => {
    const wrapped = withMiseActivation("pnpm install", RUN_A);
    // SHIMS / non-interactive activation: `--shims` emits a plain POSIX
    // `export PATH="…/shims:$PATH"` that IMMEDIATELY puts the toolchain on PATH for the
    // rest of the `bash -c`/`sh -c` command. This is the crux of the fix.
    // The activation's STATUS is checked before its output is evaluated: `eval "$(…)"`
    // reports eval's status, so a `mise activate` that died evaluated to an empty string
    // and "succeeded", leaving the project's command to run without its declared toolchain.
    expect(wrapped).toContain('__tanren_mise_activate="$(mise activate bash --shims)"');
    expect(wrapped).toContain('eval "$__tanren_mise_activate"');
    expect(wrapped).toContain("toolchain activation FAILED");
    // NOT the bare/hook mode: `mise activate bash` (no `--shims`) installs an INTERACTIVE
    // precmd/chpwd hook that never fires for a non-interactive `bash -c`, and its bash-only
    // syntax `eval`s to an error under a `sh`/dash project shell — so PATH is never set and
    // a bare `pnpm` is `not found` (the observed apex exit-127 failure).
    expect(wrapped).not.toContain('eval "$(mise activate bash)"');
    // GUARDED: only activates when a mise.toml is present in the cwd, so a project that
    // declared no toolchain runs unchanged (the activation is a no-op skip).
    expect(wrapped).toContain("[ -f 'mise.toml' ]");
    // Non-interactive.
    expect(wrapped).toContain("MISE_YES=1");
    // The project's own command still runs AFTER the prelude (verbatim, at the tail).
    expect(wrapped.endsWith("pnpm install")).toBe(true);
  });

  it("exports the run-scoped TOOL DIRECTORY and puts it on PATH BENEATH the mise prelude", () => {
    // `withMiseActivation` is the single entry point at which BOTH halves of the project
    // environment are applied — the declared mise toolchain and `$TANREN_BIN`, the writable
    // run-scoped bin a repository's own `setup.run` installs native binaries into. A
    // command that got one half and not the other is the bug class this suite exists for,
    // and this file asserted only the mise half.
    const wrapped = withMiseActivation("pnpm install", RUN_A);
    expect(wrapped).toContain(`export ${TANREN_BIN_ENV}="${workspaceToolBinDir(RUN_A)}"`);
    expect(wrapped).toContain(`export PATH="${workspaceToolBinDir(RUN_A)}:$PATH"`);
    // PRECEDENCE, and it is a pure string property so it is cheap to pin here: the tool
    // directory is prepended FIRST, so the mise prelude's own prepend lands on top of it
    // and a version the repository actually DECLARED always outranks a same-named binary
    // its setup happened to drop in the tool dir.
    expect(wrapped.indexOf(TANREN_BIN_ENV)).toBeLessThan(wrapped.indexOf("mise activate"));
  });

  it("scopes the tool directory per RUN, exactly as it scopes the mise config", () => {
    // A shared `~/.local/bin` across three runs in one container is the cross-run
    // contamination the per-run mise config exists to prevent, wearing a different hat.
    expect(withMiseActivation("pnpm install", RUN_B)).not.toContain("run_alpha");
    expect(workspaceToolBinDir(RUN_A)).not.toBe(workspaceToolBinDir(RUN_B));
  });

  it("is a no-op-shaped guard — a no-toolchain project's command runs even with no mise.toml", () => {
    // The guard is an `if … fi;` chained with `;` (NOT `&&`): a missing mise.toml SKIPS
    // activation but the project command still runs. Assert the chain uses `fi; ` before
    // the command, not `fi && `.
    const wrapped = withMiseActivation("echo hi", RUN_A);
    expect(wrapped).toContain("fi; echo hi");
    expect(wrapped).not.toContain("fi && echo hi");
  });
});

describe("miseRunScope · one runner, three concurrent runs, no shared mise state", () => {
  it("gives two different runs different config and marker files, and the SAME lock file", () => {
    const a = miseRunScope(RUN_A);
    const b = miseRunScope(RUN_B);
    // ISOLATION: the config is what `mise use --global` writes and what `mise which` /
    // `mise current` read back. Shared, run A verifies against the version run B just
    // wrote — the "last writer wins" half of the defect, which no lock can fix.
    expect(a.configFile).not.toBe(b.configFile);
    // ISOLATION: the marker is the activation trigger. Shared, run A's successful
    // provision makes run B activate a toolchain B never provisioned.
    expect(a.markerFile).not.toBe(b.markerFile);
    // SHARED, ON PURPOSE: mutual exclusion over the one shared MISE_DATA_DIR is the
    // point — two runs each taking their OWN lock would serialise nothing at all.
    expect(a.lockFile).toBe(b.lockFile);
    expect(a.lockFile).toBe(MISE_SHARED_LOCK_FILE);
  });

  it("puts a production run's mise state in the RUN dir, outside the repo Tanren did not author", () => {
    const scope = miseRunScope(RUN_A);
    // `/workspace/runs/<runId>` — the sandbox root, one level ABOVE `…/repo`, so the
    // writer's diff, the bootstrap commit and the pushed branch stay untouched.
    expect(scope.configFile).toBe("/workspace/runs/run_alpha/tanren-mise-config.toml");
    expect(scope.markerFile).toBe("/workspace/runs/run_alpha/tanren-mise-provisioned");
    // Nothing lands under `…/repo`, which IS the repository tree.
    expect(scope.configFile).not.toContain("/repo/");
    expect(scope.markerFile).not.toContain("/repo/");
  });

  it("falls back to a deterministic per-workspace name for a path that is not a run sandbox", () => {
    // The `rawInput.workspacePath` override seam (workflow/plannerRun.ts) and the
    // container fixtures pass paths of other shapes. Deterministic, never a throw.
    const first = miseRunScope("/home/tanren/tanren-toolchain-proof");
    expect(first).toEqual(miseRunScope("/home/tanren/tanren-toolchain-proof"));
    // Still PER-WORKSPACE — the isolation claim must not quietly collapse off the
    // production path, which is exactly where a fixture would stop reproducing the bug.
    expect(first.configFile).not.toBe(miseRunScope("/home/tanren/other-proof").configFile);
    // Home-scoped and shell-safe: `$HOME` expands, and the derived name carries no other
    // metacharacter, because these paths are emitted inside double quotes.
    expect(first.configFile.startsWith("$HOME/.tanren-mise-")).toBe(true);
    expect(first.configFile).toMatch(/^\$HOME\/\.tanren-mise-[A-Za-z0-9-]+-config\.toml$/u);
  });
});

describe("miseProvisionCommand · workspace-prep provisions the declared toolchain", () => {
  it("is a guarded `mise trust && mise install`, loud (no silent skip on a real failure)", () => {
    const cmd = miseProvisionCommand(RUN_A);
    expect(cmd).toContain("mise trust 'mise.toml'");
    expect(cmd).toContain("mise install");
    // trust THEN install, chained with `&&` so a failed trust aborts before install
    // (and the caller runs it under `set -e`, so a failed install is a LOUD halt).
    expect(cmd.indexOf("mise trust")).toBeLessThan(cmd.indexOf("mise install"));
    // GUARDED on the mise.toml being present so a no-toolchain project is a no-op skip.
    expect(cmd).toContain("[ -f 'mise.toml' ]");
    expect(cmd).toContain("skipping mise install");
  });

  it("holds the SHARED lock across `mise install`, because that writes the shared data dir", () => {
    const cmd = miseProvisionCommand(RUN_A);
    // The repo's own mise.toml outranks Tanren's per-run config in mise's hierarchy, so
    // this branch is not exposed to the config race — but `mise install` still mutates
    // the ONE shared installs tree, which is the `ln -sf … File exists` failure.
    expect(cmd).toContain(`flock -w ${String(MISE_LOCK_SLICE_SECONDS)} 9`);
    expect(cmd).toContain(`9>"${MISE_SHARED_LOCK_FILE}"`);
    expect(cmd.indexOf("flock")).toBeLessThan(cmd.indexOf("mise install"));
    // The WAIT is sliced and announced (stderr), because the lock lives outside the
    // workspace the activity watchdog probes: a single silent `flock -w 900` is read as a
    // wedged command and the connection is destroyed roughly twenty times sooner than the
    // declared budget. The heartbeat is what makes the budget real.
    expect(cmd).toContain("waiting for the shared mise lock");
    expect(cmd).toContain(`[ "$__tanren_mise_waited" -lt ${String(MISE_LOCK_WAIT_SECONDS)} ]`);
    // A `mise install` that FAILS under the lock is re-raised, not overwritten by the
    // lock-sentinel test that used to be the construct's last command.
    expect(cmd).toContain("|| __tanren_mise_rc=$?");
    expect(cmd).toContain('exit "$__tanren_mise_rc"');
    // Same run, same per-run config export as every other mise-touching command.
    expect(cmd).toContain('MISE_GLOBAL_CONFIG_FILE="/workspace/runs/run_alpha/tanren-mise-config.toml"');
  });
});

describe("the shared-mise-state defect · what must NOT be in the built commands any more", () => {
  it("never names the runner-wide marker two concurrent runs used to collide on", () => {
    // NEGATIVE CONTROL for bug 3. `$HOME/.tanren-toolchain-provisioned` was written by
    // whichever run provisioned first and then read by all three.
    for (const command of [
      withMiseActivation("just bootstrap", RUN_A),
      withMiseActivation("just bootstrap", RUN_B),
      miseProvisionCommand(RUN_A),
    ]) {
      expect(command).not.toContain(".tanren-toolchain-provisioned");
    }
  });

  it("never leaves a mise command on the runner-wide DEFAULT global config", () => {
    // NEGATIVE CONTROL for bug 2. Every branch that runs `mise` must first pin
    // MISE_GLOBAL_CONFIG_FILE; a branch that forgets falls back to
    // /home/tanren/.config/mise/config.toml, which is shared by all three runs.
    const wrapped = withMiseActivation("just bootstrap", RUN_A);
    // BOTH prelude branches export it — the repo-mise.toml one and the Tanren-provisioned
    // one — so neither can silently read the runner-wide config another run just wrote.
    expect(wrapped.split('MISE_GLOBAL_CONFIG_FILE="').length - 1).toBe(2);
    expect(wrapped.indexOf("MISE_GLOBAL_CONFIG_FILE=")).toBeLessThan(wrapped.indexOf("mise activate"));
    expect(wrapped.lastIndexOf("MISE_GLOBAL_CONFIG_FILE=")).toBeLessThan(wrapped.indexOf("mise env -s bash"));
    expect(wrapped).not.toContain("/home/tanren/.config/mise/config.toml");
  });

  it("activates on THIS run's marker and THIS run's config, and no other run's", () => {
    const wrapped = withMiseActivation("just bootstrap", RUN_A);
    // The per-run activation trigger, spelled out: the marker the same run's provision
    // wrote (toolchainProvision.ts `: > "<marker>"`), inside the run's own sandbox.
    expect(wrapped).toContain('[ -f "/workspace/runs/run_alpha/tanren-mise-provisioned" ]');
    expect(wrapped).toContain('MISE_GLOBAL_CONFIG_FILE="/workspace/runs/run_alpha/tanren-mise-config.toml"');
    // A sibling run's state is nowhere in it.
    expect(wrapped).not.toContain("run_bravo");
    // …and the reverse holds, so neither run is privileged by construction.
    expect(withMiseActivation("just bootstrap", RUN_B)).not.toContain("run_alpha");
  });
});

// REGRESSION — the runner image bakes a warm mise baseline into a shared dir and
// publishes its location via `/etc/profile.d/tanren-mise-shared-dir.sh`. A non-login
// `ssh exec` sources no profile script, and sshd forwards none of the image ENV (no
// SetEnv / AcceptEnv / PermitUserEnvironment on the runner), so nothing reached the
// engine: every mise call fell back to mise's `$HOME` defaults, the baked baseline was
// never used, and the toolchain landed in an unpinned dir shared by every concurrent run.
describe("mise reaches the shared data/cache dirs the runner image publishes", () => {
  it("EVERY mise seam sources the image's published script — the SAME one", () => {
    // Install-where-activation-reads. If the seams ever diverge — or one stops sourcing —
    // `mise install` writes somewhere `mise activate --shims` will not look, and a bare
    // `pnpm` is `not found` again. They share one preamble so they cannot drift apart.
    const prelude = miseSharedDirPrelude();
    expect(withMiseActivation("pnpm install", RUN_A)).toContain(prelude);
    expect(miseProvisionCommand(RUN_A)).toContain(prelude);
    expect(prelude).toContain(". /etc/profile.d/tanren-mise-shared-dir.sh");
  });

  it("sources BEFORE mise runs, in every seam (a pin after the command is no pin at all)", () => {
    const provision = miseProvisionCommand(RUN_A);
    expect(provision).toContain("tanren-mise-shared-dir.sh");
    expect(provision.indexOf("tanren-mise-shared-dir.sh")).toBeLessThan(provision.indexOf("mise trust"));
    const activation = withMiseActivation("pnpm install", RUN_A);
    expect(activation).toContain("tanren-mise-shared-dir.sh");
    expect(activation.indexOf("tanren-mise-shared-dir.sh")).toBeLessThan(activation.indexOf("mise activate"));
  });

  it("NEGATIVE CONTROL: reads the substrate's own declaration, never an invented path", () => {
    // The fail-open this blocks. Two of them, in fact:
    //   1. An unconditional `export MISE_DATA_DIR=/opt/tanren/mise` would point every
    //      `manual_ssh` host and every non-Tanren runner image at a dir that does not
    //      exist. So the engine hard-codes NO mise dir — it sources the script the image
    //      itself wrote, and the VALUES stay the image's to choose.
    //   2. Reading `$TANREN_MISE_DATA_DIR` instead would be a silent no-op on the real
    //      path: that variable is the sshd DAEMON's environment, which sshd does not
    //      forward into the session. A container-exec probe shows it set; over ssh it is
    //      empty. Assert the prelude does not depend on it.
    const prelude = miseSharedDirPrelude();
    expect(prelude).toContain("[ -r /etc/profile.d/tanren-mise-shared-dir.sh ]");
    expect(prelude).not.toContain("TANREN_MISE_DATA_DIR");
    expect(prelude).not.toContain("export MISE_DATA_DIR");
    expect(prelude).not.toContain("export MISE_CACHE_DIR");
  });

  it("is `set -e` safe — a runner without the script must not abort the command", () => {
    // The provision command runs as `set -e; <provision>`. A `[ -r … ] && . …` chain
    // returns 1 when the file is absent, which under `set -e` would kill the whole
    // command on exactly the runners this is supposed to leave alone. It must be `if/fi`.
    const prelude = miseSharedDirPrelude();
    expect(prelude.startsWith("if [ -r ")).toBe(true);
    expect(prelude.trimEnd().endsWith("fi;")).toBe(true);
    expect(prelude).not.toContain("&& .");
  });

  it("stays a no-op for a project that declared no toolchain (lives inside the activation guard)", () => {
    const wrapped = withMiseActivation("echo hi", RUN_A);
    expect(wrapped).toContain("fi; echo hi");
    expect(wrapped.indexOf("[ -f 'mise.toml' ]")).toBeLessThan(wrapped.indexOf("tanren-mise-shared-dir.sh"));
  });

  it("SHARES the data dir across runs while the config stays per-run — both, on purpose", () => {
    // The shared dir is what makes the image's warm baseline worth baking; the per-run
    // config is what stops run B's toolchain being activated for run A. Isolating the
    // data dir too would cold-download the whole toolchain on every run, so the shared
    // WRITES are serialised with `flock` instead (see the lock-scope tests above).
    const a = withMiseActivation("just bootstrap", RUN_A);
    const b = withMiseActivation("just bootstrap", RUN_B);
    const prelude = miseSharedDirPrelude();
    expect(a).toContain(prelude);
    expect(b).toContain(prelude);
    expect(a).toContain(miseRunScope(RUN_A).configFile);
    expect(b).not.toContain(miseRunScope(RUN_A).configFile);
  });
});

describe("the HARNESS / codex path is NEVER mise-activated (stays on the runner's isolated node)", () => {
  const codexInput = { codexHome: "/home/tanren/.codex/run_x", workspace: "/ws/run_x/repo" };

  it("the codex writer exec command contains NO mise activation", () => {
    const cmd = buildCodexExecCommand(codexInput);
    expect(cmd).toContain("codex exec");
    expect(cmd).not.toContain("mise activate");
    expect(cmd).not.toContain("mise install");
    expect(cmd).not.toContain("mise.toml");
  });

  it("the codex answerer exec command contains NO mise activation", () => {
    const cmd = buildCodexAnswererExecCommand({
      ...codexInput,
      schemaPath: "/home/tanren/.codex/run_x/v.schema.json",
      outputPath: "/home/tanren/.codex/run_x/v.response.json",
    });
    expect(cmd).toContain("codex exec");
    expect(cmd).not.toContain("mise activate");
    expect(cmd).not.toContain("mise install");
    expect(cmd).not.toContain("mise.toml");
  });
});
