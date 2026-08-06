// Mise activation helper (environment-management.md §3 Layer 2): make the project's
// `mise`-provisioned toolchain ACTIVE for the project's OWN command execution, so a
// bare `node`/`pnpm`/etc in the project's bootstrap/gate command resolves to the
// version the project DECLARED in its `mise.toml` (provisioned at workspace-prep via
// `mise install`), rather than the runner's harness node.
//
// THE TWO-PATH SEPARATION (the crux of P0b/c):
//   - PROJECT-COMMAND path — the project's bootstrap + gate tiers (and the build/
//     deploy commands that run through the gate). These run the project's DECLARED
//     shell, which may call a bare `pnpm`/`node`/`python`. They MUST be mise-activated
//     so those resolve to the project's declared toolchain. `withMiseActivation`
//     prefixes them with `eval "$(mise activate bash --shims)"` (the documented
//     non-interactive / CI activation — see `miseActivationPrelude` for WHY hook-mode
//     is wrong here), guarded on a `mise.toml` being present in the cwd (so a project
//     that declared no toolchain is unaffected — the activation is a no-op).
//   - HARNESS / answerer path — `codex` (writer + Checker/Auditor). It runs on the
//     runner's OWN isolated node (P0a installs the harness node on the system PATH and
//     does NOT globally activate mise). This module is NEVER applied there: the codex
//     exec path (engine/providers/codex.ts) builds its command directly and stays on
//     the harness node, untouched by the project's toolchain.
//   - PROJECT-HOOK path — a Tanren-issued `git commit` that leaves the repo's hook path
//     LIVE (`withProjectHookToolchain`). The git binary is the harness's, but the hook
//     it fires is the PROJECT's code, so the hook needs the PROJECT's toolchain. See
//     that function for the full rationale; it is the same activation, invoked for a
//     third reason, and it does NOT put the project's toolchain on the harness path —
//     the codex exec that produced the changes has already exited by then.
//
// SECURITY: like the app-env prelude, the activation is prepended ONLY to the EXECUTED
// command string handed to the SSH substrate — never to a logged/emitted command (gate
// `step.run`, the bootstrap error's `command`), so the original command still flows
// into every event. The prelude contains no secret material.

import { quoteSshShellArg } from "./command.js";
import { workspaceScopePrefix } from "./workspaceScope.js";
import { withWorkspaceToolPath } from "./workspaceToolPath.js";

// The conventional path of the project's `mise.toml` (mirrors
// SKELETON_MISE_CONFIG_PATH; kept local so this ssh helper has no scaffold dep). The
// guard tests for THIS file in the command's cwd before activating. Exported because
// Layer-1 detection (workspace/toolchainDeclarations.ts) keys its "defer to the repo's
// own mise config" short-circuit on the SAME path — one definition, never two that drift.
export const MISE_CONFIG_REL_PATH = "mise.toml";

// The script the runner image writes to publish its SHARED mise data + cache dirs
// (runner/Dockerfile: `printf 'export MISE_DATA_DIR=…\nexport MISE_CACHE_DIR=…\n' >
// /etc/profile.d/tanren-mise-shared-dir.sh`). The image OWNS this path and its contents;
// the engine only sources it.
const MISE_SHARED_DIR_PROFILE_SCRIPT = "/etc/profile.d/tanren-mise-shared-dir.sh";

// Make the runner image's WARM mise baseline actually reachable, for every mise
// invocation the engine makes.
//
// The image bakes a warm baseline into a shared, world-readable dir and publishes its
// location three ways (runner/Dockerfile): the `TANREN_MISE_*` image ENV, the
// `/etc/profile.d` script above, and an append to `~/.bashrc`. NONE of them reach us:
//
//   - We run commands over a NON-LOGIN, NON-INTERACTIVE `ssh exec` (ssh2Substrate →
//     `client.exec`), which sources neither `/etc/profile.d` nor — past Debian's early
//     non-interactive return — `~/.bashrc`.
//   - The image ENV belongs to the sshd DAEMON's process environment. sshd builds a
//     fresh environment for the session and does NOT forward arbitrary daemon variables;
//     the runner's sshd_config sets no `SetEnv`, `AcceptEnv` or `PermitUserEnvironment`,
//     and the entrypoint writes no `/etc/environment`. So `$TANREN_MISE_DATA_DIR` is
//     EMPTY in the session, even though a container-exec probe (which DOES inherit the
//     image ENV) shows it set — a trap when reproducing this by hand.
//
// So `MISE_DATA_DIR` arrives unset and mise silently resolves its own `$HOME` defaults:
//
//   $ ssh runner 'mise doctor'          # the exec the engine actually performs
//   dirs:
//     data:  ~/.local/share/mise        # cold — re-downloaded every run
//     cache: ~/.cache/mise
//
// The whole warm-baseline mechanism is inert: every run re-downloads a toolchain the
// image already ships, into a dir shared by every concurrent run on that runner and
// pinned by nobody.
//
// The fix uses the one publication route that survives a non-login exec: SOURCE the
// image's own script. GUARDED on it being readable, so a runner that publishes no shared
// dir (a bare `manual_ssh` host, a non-Tanren image) keeps mise's defaults exactly as
// before — the engine never invents a path the substrate did not offer. Written as
// `if … fi` rather than `[ -r … ] && .` because the provision command runs under
// `set -e`, where a false `&&` chain would abort the whole command.
//
// EVERY mise seam shares this prelude ON PURPOSE: `mise install` must write where
// `mise activate --shims` will later read. Pinning one without the other would install
// the toolchain into a dir the activation does not look in. There are three seams now
// (activation, the repo-owns-a-mise.toml provision, and the detected-toolchain
// provision), so all of them reach it through the ONE preamble {@link miseScopeExport}
// instead of each remembering to prepend it.
const MISE_SHARED_DIR_PRELUDE = `if [ -r ${MISE_SHARED_DIR_PROFILE_SCRIPT} ]; then . ${MISE_SHARED_DIR_PROFILE_SCRIPT}; fi; `;

/** The shared-dir prelude, exported for the agreement + guard assertions in the tests. */
export function miseSharedDirPrelude(): string {
  return MISE_SHARED_DIR_PRELUDE;
}

// PER-RUN MISE SCOPE — the concurrency fix.
//
// Every run on a runner executes as the SAME unix user against ONE long-lived container
// (StaticRunnerAllocator, `fixed_pool`, worker concurrency 3 by default). A single
// runner-scoped mise global config + a single runner-scoped "provisioned" marker are
// therefore SHARED MUTABLE STATE between concurrent runs: run A writes `pnpm@10`, run B
// writes `pnpm@11` to the same file, and A then VERIFIES against B's config. The config
// and the marker are made per-run here; only the installs tree stays shared.
//
// WHAT STAYS SHARED, DELIBERATELY: `MISE_DATA_DIR`, whatever the runner image published
// it as above. The image bakes a warm toolchain baseline into it (runner/Dockerfile),
// which is the whole point of {@link miseSharedDirPrelude}, so a per-run data dir
// would cold-download node/pnpm/python/go on every run. Concurrent WRITES to that tree
// (`installs/<tool>/latest` symlinks) are instead serialised with `flock` on
// {@link MISE_SHARED_LOCK_FILE} — shared ON PURPOSE, because a per-run lock excludes
// nothing.

/** The mutual-exclusion point for the SHARED mise data dir. One path for the whole
 * runner: two runs holding two different locks would serialise nothing. */
export const MISE_SHARED_LOCK_FILE = "$HOME/.tanren-mise.lock";

/** Bounded TOTAL wait for {@link MISE_SHARED_LOCK_FILE}. Generous — the holder may be doing
 * a cold toolchain download — but BOUNDED, and a timeout is a loud nonzero exit. */
export const MISE_LOCK_WAIT_SECONDS = 900;

/**
 * The slice the wait is taken in, so it stays OBSERVABLE.
 *
 * A single `flock -w 900` is a 15-minute silence, and the watchdog every mise seam runs
 * under (ssh/activityWatchdog.ts, class `vcs`) is output-driven with the WORKSPACE tree as
 * its liveness probe. The shared lock and the shared mise data dir are both OUTSIDE the
 * workspace, so a run parked on the lock writes nothing the probe can see and emits nothing:
 * three identical signatures at the 15s probe cadence (~45s) and the substrate DESTROYS the
 * connection and surfaces a stall. The 900s budget was therefore unreachable — a contended
 * lock did not wait, it killed the command, roughly twenty times sooner than the constant
 * above claims.
 *
 * So the wait is taken in slices and says so between them. The heartbeat is sign-of-life the
 * watchdog resets on (any stdout OR stderr chunk resets it), which makes the declared budget
 * the budget that is actually enforced. It goes to STDERR so the provision's stdout stays
 * exactly the frame stream its parsers read.
 */
export const MISE_LOCK_SLICE_SECONDS = 10;

/** The mise state a single run owns, plus the lock it shares with every other run. */
export interface MiseRunScope {
  /** `MISE_GLOBAL_CONFIG_FILE` for every mise call this run makes. Per-run. */
  readonly configFile: string;
  /** Written by a successful, VERIFIED provision; the activation trigger. Per-run. */
  readonly markerFile: string;
  /** `flock` target guarding writes to the SHARED data dir. Runner-wide, not per-run. */
  readonly lockFile: string;
}

/**
 * Map a workspace path to the mise state that run owns. Pure.
 *
 * For the production shape `/workspace/runs/<runId>/repo` the files land in the RUN dir —
 * outside the repo, so Tanren still never materializes a file into a repository it did
 * not author, and end-of-run teardown reclaims them with the sandbox. Any other shape
 * (the `rawInput.workspacePath` override seam, fixtures) falls back to a deterministic
 * per-workspace name in the runner user's home rather than throwing.
 */
export function miseRunScope(workspacePath: string): MiseRunScope {
  // The prefix rule ("a path only this run owns, outside the repo tree") lives in
  // ./workspaceScope.ts — shared with the workspace TOOL DIRECTORY, which needs the
  // identical rule. The emitted strings are unchanged.
  const prefix = workspaceScopePrefix(workspacePath, "mise");
  return { configFile: `${prefix}-config.toml`, markerFile: `${prefix}-provisioned`, lockFile: MISE_SHARED_LOCK_FILE };
}

/**
 * The preamble every mise-touching command in a run starts from. It settles the two
 * things every seam must agree on, and it is ONE function so they cannot drift:
 *
 *   - WHERE MISE READS AND WRITES — {@link miseSharedDirPrelude}, the image's own
 *     published shared data/cache dirs. Provision, verification and activation are
 *     separate SSH commands; if any of them resolves a different `MISE_DATA_DIR` the
 *     install lands where the activation does not look, and the failure is silent right
 *     up until the project's bootstrap reports `pnpm: not found`.
 *   - WHOSE CONFIG IT USES — this run's, never the runner-wide one two concurrent runs
 *     would fight over.
 */
export function miseScopeExport(scope: MiseRunScope): string {
  return `${miseSharedDirPrelude()}export MISE_YES=1 MISE_GLOBAL_CONFIG_FILE="${scope.configFile}"`;
}

/**
 * Run `body` holding the runner-wide mise lock, in ONE shell (no extra SSH round-trip).
 * `9>` opens the lock file for the brace group only, so the lock is released the moment
 * the group ends — including on the `exit` paths inside `body`.
 *
 * TWO loud failures, because there are two ways to end up NOT holding the lock:
 *   - `flock` timed out (or is not on this runner) — the `||` branch exits nonzero;
 *   - the lock file could not be OPENED — measured: a failed redirection on a compound
 *     command is NOT caught by `set -e` in bash or dash. The shell prints its own error,
 *     skips the whole group and carries on with status 0. The `__tanren_mise_lock`
 *     sentinel is set INSIDE the group, so a skipped group is caught after it.
 * Either way the shared installs tree is never written unsynchronised — which is the
 * `ln -sf … File exists` defect itself — and never silently skipped.
 *
 * AND A THIRD WAY TO FAIL: `body` ITSELF. The lock sentinel test was the LAST command of
 * the construct, so ITS status — 0 whenever the lock opened — became the construct's
 * status and a failed `mise trust`/`mise install`/`mise use` inside the group was
 * overwritten with success. That stayed invisible because ONE caller
 * (`provisionMiseToolchain`) wraps the whole provision in `set -e`; the per-gate caller
 * (`ensureWorkspaceDepsInstalled`) deliberately does NOT, and there the masked failure let
 * the project's bootstrap run against a toolchain that never installed — the exact silent
 * degradation this module exists to remove. So `body`'s status is CAPTURED inside the
 * group and re-raised after the sentinel check: nonzero under EITHER caller. The `||`
 * around it is also what stops `set -e` from bailing out BEFORE the lock is released.
 *
 * NOT `( set -e; … )` AT THE CALL SITE, which is the obvious-looking alternative and does
 * neither job. POSIX ignores `-e` for any command of an AND-OR list other than the last,
 * and that extends into a subshell: `( set -e; false; echo x ) && y` runs both — measured
 * in sh, bash and dash. A subshell would also DISCARD the `export`s and the `mise env`
 * PATH the provision must leave behind for the bootstrap chained after it.
 */
export function underMiseLock(scope: MiseRunScope, body: string): string {
  const slice = String(MISE_LOCK_SLICE_SECONDS);
  const budget = String(MISE_LOCK_WAIT_SECONDS);
  // The sliced, ANNOUNCED wait. `flock` exits 1 on timeout; ANY other nonzero (127 when the
  // runner has no flock at all) is not a contended lock and must not be retried in a loop.
  const acquire =
    `while :; do flock -w ${slice} 9 && { __tanren_mise_lock=1; break; }; __tanren_flock_rc=$?; ` +
    `[ "$__tanren_flock_rc" = 1 ] || ` +
    `{ printf '%s\\n' ${quoteSshShellArg(lockUnavailableMessage(scope))} >&2; exit 1; }; ` +
    `__tanren_mise_waited=$((__tanren_mise_waited + ${slice})); ` +
    `[ "$__tanren_mise_waited" -lt ${budget} ] || ` +
    `{ printf '%s\\n' ${quoteSshShellArg(lockTimedOutMessage(scope))} >&2; exit 1; }; ` +
    `printf '%s %s/%s\\n' ${quoteSshShellArg(lockWaitingMessage(scope))} "$__tanren_mise_waited" ${budget} >&2; ` +
    `done`;
  return (
    `__tanren_mise_lock=0; __tanren_mise_rc=0; __tanren_mise_waited=0; ` +
    `{ ${acquire}; { ${body}; } || __tanren_mise_rc=$?; } 9>"${scope.lockFile}"; ` +
    `[ "$__tanren_mise_lock" = 1 ] || { printf '%s\\n' ${quoteSshShellArg(lockUnopenableMessage(scope))} >&2; exit 1; }; ` +
    `[ "$__tanren_mise_rc" = 0 ] || { printf '%s\\n' ${quoteSshShellArg(lockedBodyFailedMessage(scope))} >&2; ` +
    `exit "$__tanren_mise_rc"; }`
  );
}

function lockTimedOutMessage(scope: MiseRunScope): string {
  return (
    `tanren: toolchain provision FAILED - could not take the shared mise lock (${scope.lockFile}) within ` +
    `${String(MISE_LOCK_WAIT_SECONDS)}s. Concurrent runs share one mise data dir; Tanren will not write it ` +
    `unsynchronised.`
  );
}

function lockUnavailableMessage(scope: MiseRunScope): string {
  return (
    `tanren: toolchain provision FAILED - flock is unavailable on this runner, so the shared mise lock ` +
    `(${scope.lockFile}) cannot be taken. Concurrent runs share one mise data dir; Tanren will not write it ` +
    `unsynchronised.`
  );
}

/** The heartbeat that makes the wait visible — to the operator tailing the run, and to the
 * activity watchdog, which would otherwise read a silent lock wait as a wedged command. */
function lockWaitingMessage(scope: MiseRunScope): string {
  return `tanren: waiting for the shared mise lock (${scope.lockFile}) - another run holds it; seconds waited:`;
}

function lockUnopenableMessage(scope: MiseRunScope): string {
  return (
    `tanren: toolchain provision FAILED - could not OPEN the shared mise lock (${scope.lockFile}), so the ` +
    `toolchain install was skipped rather than run unsynchronised against the shared mise data dir.`
  );
}

function lockedBodyFailedMessage(scope: MiseRunScope): string {
  return (
    `tanren: toolchain provision FAILED - the mise work held under the shared lock (${scope.lockFile}) exited ` +
    `nonzero. The declared toolchain is NOT installed; Tanren halts here rather than running the project's own ` +
    `commands against whatever the runner image happens to carry.`
  );
}

// The mise activation prelude. It uses the `--shims` mode of `mise activate`, which
// emits a plain, POSIX `export PATH="…/shims:$PATH"` that IMMEDIATELY puts the project's
// mise shims on PATH for the rest of the `bash -c`/`sh -c` command (the shims dispatch
// to the per-dir active version resolved from `mise.toml`); we `eval` it so a bare
// `node`/`pnpm` resolves to the declared version.
//
// WHY NOT plain `eval "$(mise activate bash)"` (the hook mode): that emits an
// INTERACTIVE shell hook (a `mise()` shim function + a `_mise_hook` precmd/chpwd hook)
// whose PATH update fires only on an interactive prompt or a `cd` — NOT immediately for
// the non-interactive `bash -c "<prelude>; <command>"` we run over SSH, so a bare
// `pnpm` would not be found (the observed failure: `mise install` provisions
// node+pnpm fine, then `pnpm install` dies with `sh: pnpm: not found`, exit 127). The
// hook-mode output is also full of bash-only syntax (`__MISE_FLAGS=()` arrays,
// `declare -f`, `[[ … ]]`), so under a non-bash project shell (e.g. a `just` recipe run
// via `sh`/dash, the actual live failure shell) it `eval`s to a syntax error and never
// touches PATH at all. The `--shims` export is POSIX-clean and is inherited by child
// shells, so the toolchain survives into `just`/`sh -c` sub-invocations too.
//
// TWO GUARDED BRANCHES, and the split is deliberate:
//
//   1. The repo ships its OWN `mise.toml` — unchanged: `mise activate --shims`, mise's
//      own dynamic per-directory activation, exactly as before. A repo that states its
//      toolchain explicitly gets mise's native behaviour, untouched.
//
//   2. Tanren DETECTED and provisioned the toolchain from the repo's standard
//      declarations (`package.json#packageManager`, `.nvmrc`, a lockfile, …) — the
//      marker is present. Here we use `mise env -s bash`, which emits a plain POSIX
//      `export PATH=<installs of the RESOLVED tools>:$PATH`, and NOT the shims dir.
//      WHY THE DIFFERENCE: the shims directory contains a shim for every tool in the
//      runner's shared mise store, including ones this repo never declared. Putting it
//      on PATH shadows them — a repo that declared only pnpm but calls the runner's
//      baseline `go` gets `mise ERROR No version is set for shim: go` instead of the
//      working binary that was there a moment ago. That is measured behaviour on the
//      golden image, not a theoretical concern. Branch 1 accepts that exposure because
//      the repo asked for mise by name; branch 2 must not introduce it for the far
//      larger population of repos that never mentioned mise at all. `mise env` puts
//      ONLY the declared tools on PATH, so nothing undeclared is shadowed.
//
// Both branches emit a plain `export PATH=…` that takes effect IMMEDIATELY in the
// non-interactive `bash -c`/`sh -c` we run over SSH and is inherited by child shells,
// so the toolchain survives into `just`/`sh -c` sub-invocations.
//
// GUARDED: with neither trigger present the activation is skipped and the command runs
// exactly as before — a pure no-op. `MISE_YES=1` keeps any mise sub-action
// non-interactive. The whole prelude is one `if … fi; ` statement chained before the
// real command with `;` (NOT `&&`): a project with no toolchain must still run its
// command — the guard is a skip, not a gate.
//
// PER-RUN SCOPE: both branches export THIS run's `MISE_GLOBAL_CONFIG_FILE`, and branch 2
// triggers on THIS run's marker ({@link miseRunScope}). Sharing either with the other
// runs on the container is what let run B's toolchain be activated for run A's gate.
function miseActivationPrelude(workspacePath: string): string {
  const scope = miseRunScope(workspacePath);
  // `eval "$(…)"` reports the status of EVAL, never of the command substitution inside it:
  // a `mise activate` / `mise env` that exited nonzero evaluates to an EMPTY string and
  // "succeeds", so the project's command runs with its declared toolchain absent and the
  // only evidence is a line on stderr. That is the silent degradation this module exists to
  // remove, sitting inside the module. Captured, CHECKED, then evaluated.
  //
  // A failure here is a HALT, not a skip. Both branches are entered only after the guard
  // has established that this run HAS a toolchain to activate — the repo's own `mise.toml`,
  // or a marker written by a provision that verified every declared binary. Running the
  // project's command anyway would run it against whatever the image happens to carry. The
  // guard is still a pure skip for a repo that declared nothing: that path enters neither
  // branch and the `if … fi; ` chains straight into the command, exactly as before.
  const activate = (source: string): string =>
    `__tanren_mise_activate="$(${source})" || ` +
    `{ printf '%s\\n' ${quoteSshShellArg(activationFailedMessage(source))} >&2; exit 1; }; ` +
    `eval "$__tanren_mise_activate"`;
  return (
    `if [ -f ${quoteSshShellArg(MISE_CONFIG_REL_PATH)} ]; then ` +
    `${miseScopeExport(scope)}; ${activate("mise activate bash --shims")}; ` +
    `elif [ -f "${scope.markerFile}" ]; then ` +
    `${miseScopeExport(scope)}; ${activate("mise env -s bash")}; fi; `
  );
}

function activationFailedMessage(source: string): string {
  return (
    `tanren: toolchain activation FAILED - '${source}' exited nonzero, so the toolchain this run provisioned is ` +
    `not on PATH. Tanren halts rather than running the project's own command against whatever toolchain the ` +
    `runner image happens to carry.`
  );
}

/**
 * Prepend the mise-activation prelude to a PROJECT command so a bare `node`/`pnpm`/etc
 * resolves to the project's `mise.toml`-declared toolchain. Self-guarding: when the
 * workspace ships no `mise.toml` (the project declared no toolchain) the activation is
 * skipped and the command runs unchanged. Apply ONLY to the project-command paths
 * (bootstrap + gate tiers + build/deploy-through-gate) — NEVER to the codex/harness path.
 *
 * `workspacePath` is REQUIRED: it selects the per-run mise config + marker
 * ({@link miseRunScope}), which is what keeps concurrent runs off each other's toolchain.
 */
export function withMiseActivation(command: string, workspacePath: string): string {
  // THE PROJECT ENVIRONMENT IS TWO HALVES, and this is the single entry point both are
  // applied at — deliberately, because a project command that got one half and not the
  // other is precisely the bug class this and #1418 exist to close.
  //   - The DECLARED language toolchain (mise), below.
  //   - The workspace TOOL DIRECTORY (`$TANREN_BIN`) — the writable, run-scoped `bin` a
  //     project's own `setup.run` installs native binaries into (gitleaks, shellcheck,
  //     terraform, …), which no manifest declares and mise does not provide. See
  //     ./workspaceToolPath.ts for why a repository otherwise has nowhere to put one.
  // Tool-path FIRST so the mise prelude's `PATH` prepend lands on top of it: a tool whose
  // version the repository actually DECLARED always outranks a same-named binary in the
  // tool directory.
  return withWorkspaceToolPath(`${miseActivationPrelude(workspacePath)}${command}`, workspacePath);
}

/**
 * Prepend the SAME activation to a Tanren-issued git command that runs the PROJECT's
 * commit hooks. Distinct from {@link withMiseActivation} only in WHY, and named so every
 * call site states which of the module's paths it is on.
 *
 * THE RULE: if Tanren issues a git command that leaves the repo's hook path live, that
 * command executes the project's code and must therefore carry the project's toolchain.
 * A `git commit` is not "a git command" from the hook's point of view — it is the
 * project's `.husky/pre-commit` (or lefthook, or a bare `.git/hooks/pre-commit`) running
 * `pnpm`/`node`/`bundle`. Those resolve against PATH, and the runner ships NO project
 * toolchain by design (runner/Dockerfile: mise is a binary on PATH, never globally
 * activated), so a commit shell without it has exactly the harness node and nothing
 * else. MEASURED on a live runner, in the exact shell `buildSshExecCommand` produces:
 *
 *   PATH=/usr/local/bin:/usr/bin:/bin:/usr/games
 *   pnpm: NOT-FOUND
 *   .husky/pre-commit: 2: pnpm: not found   →   husky - pre-commit script failed
 *
 * …while the same shell with this prelude resolves the provisioned
 * `…/mise/installs/pnpm/<version>/pnpm` and the hook RUNS AND PASSES. The toolchain was
 * never missing — `miseProvisionCommand` installed it at workspace-prep; it simply was
 * not on PATH for this subprocess, because `runWorkspaceSshCommand` adds no prelude and
 * the activation was wired at exactly three call sites, none of them a commit.
 *
 * WHY ACTIVATE RATHER THAN BYPASS THE HOOKS. A `git commit` CAN be taken off the repo's
 * hooks with `-c core.hooksPath=/dev/null`, and for a commit that is purely Tanren's own
 * bookkeeping — one that never reaches the PR — that is the right call. These commits are
 * NOT that: they carry content into the PR a reviewer will read, so suppressing their
 * hooks would be a silent policy change (Tanren deciding the project's pre-commit gate
 * does not apply to Tanren-authored content). The project's hook is also CORRECT: it
 * legitimately needs the toolchain. A hook that runs and passes is evidence; a hook that
 * was skipped is not. So we satisfy the hook instead of silencing it.
 *
 * SCOPE. Commit-time hooks only (pre-commit / prepare-commit-msg / commit-msg), which is
 * what the whole activation is guarded and proven for. `pre-push` hooks on the workspace
 * push paths are the same class of exposure and are deliberately NOT changed here: no
 * push-hook failure has been observed, and those commands carry auth material on stdin,
 * so they are left for a change that can prove itself the way this one does.
 */
export function withProjectHookToolchain(command: string, workspacePath: string): string {
  // TANREN'S OWN GIT IS PINNED BEFORE THE PROJECT'S TOOLCHAIN GOES ON PATH.
  //
  // Branch 1 of the activation prepends the project's mise SHIMS directory, which carries a
  // shim for every tool in the runner's mise store — including `git`, if the project
  // declared one. Only the HOOK needed the project's PATH; Tanren's own `git add` /
  // `git commit` / `git rev-parse` were swept along with it, so a project-pinned or broken
  // git could stop Tanren committing at all, and the sha `git rev-parse` prints — the
  // writer's diff base — would come from a binary the project chose. Resolving it FIRST,
  // into an exported absolute path the call sites name explicitly, keeps the two apart:
  // Tanren's git stays the harness's, the hook subprocess still inherits the project's
  // PATH, and every call site says which of the two it is using.
  //
  // Falls back to the bare word when `command -v` finds nothing, so a substrate with no git
  // fails exactly the way it always did rather than in a new and less legible way.
  const pinGit =
    `${TANREN_GIT_ENV}="$(command -v git 2>/dev/null || true)"; ` +
    `[ -n "$${TANREN_GIT_ENV}" ] || ${TANREN_GIT_ENV}=git; export ${TANREN_GIT_ENV}; `;
  return `${pinGit}${withMiseActivation(command, workspacePath)}`;
}

/** The environment variable carrying the HARNESS git, resolved BEFORE any project
 * activation. See {@link withProjectHookToolchain}. */
export const TANREN_GIT_ENV = "TANREN_GIT";

/** How a Tanren-issued git command spells `git` when it runs under
 * {@link withProjectHookToolchain}. */
export const TANREN_GIT = `"$${TANREN_GIT_ENV}"`;

// The mise PROVISIONING commands run at workspace-prep, BEFORE the project's bootstrap,
// when a `mise.toml` is present: `mise trust` (mise's config-trust security gate — the
// config is Tanren-materialized + trusted) then `mise install` (download the declared
// toolchain into the `tanren` user space). LOUD on failure: the caller runs these with
// `set -e` so a failed install HALTS the run (no silent skip), per the no-silent-fallback
// doctrine. GUARDED on the mise.toml being present so a no-toolchain project is a no-op.
// `MISE_YES=1` makes trust/install non-interactive.
//
// UNDER THE SHARED LOCK: the repo's own `mise.toml` outranks Tanren's per-run config in
// mise's hierarchy, but `mise install` still writes the SHARED data dir, so this path
// needs the same mutual exclusion the detected-toolchain path does.
export function miseProvisionCommand(workspacePath: string): string {
  const scope = miseRunScope(workspacePath);
  const install = `mise trust ${quoteSshShellArg(MISE_CONFIG_REL_PATH)} && mise install`;
  return (
    `if [ -f ${quoteSshShellArg(MISE_CONFIG_REL_PATH)} ]; then ` +
    `${miseScopeExport(scope)}; ${underMiseLock(scope, install)}; ` +
    `else echo ${quoteSshShellArg("tanren: no mise.toml - skipping mise install (project declared no toolchain)")}; fi`
  );
}
