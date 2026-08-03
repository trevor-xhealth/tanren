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
//
// SECURITY: like the app-env prelude, the activation is prepended ONLY to the EXECUTED
// command string handed to the SSH substrate — never to a logged/emitted command (gate
// `step.run`, the bootstrap error's `command`), so the original command still flows
// into every event. The prelude contains no secret material.

import { quoteSshShellArg } from "./command.js";

// The conventional path of the project's `mise.toml` (mirrors
// SKELETON_MISE_CONFIG_PATH; kept local so this ssh helper has no scaffold dep). The
// guard tests for THIS file in the command's cwd before activating. Exported because
// Layer-1 detection (workspace/toolchainDeclarations.ts) keys its "defer to the repo's
// own mise config" short-circuit on the SAME path — one definition, never two that drift.
export const MISE_CONFIG_REL_PATH = "mise.toml";

// Marker written by a SUCCESSFUL, VERIFIED Tanren toolchain provision (workspace/
// toolchainProvision.ts). It lives in the runner user's home — runner-scoped, like the
// global mise config it pairs with, and deliberately OUTSIDE the workspace so Tanren
// never materializes a file into a repository it did not author. Its presence is the
// second activation trigger below.
export const TOOLCHAIN_PROVISIONED_MARKER = "$HOME/.tanren-toolchain-provisioned";

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
function miseActivationPrelude(): string {
  return (
    `if [ -f ${quoteSshShellArg(MISE_CONFIG_REL_PATH)} ]; then ` +
    `export MISE_YES=1; eval "$(mise activate bash --shims)"; ` +
    `elif [ -f "${TOOLCHAIN_PROVISIONED_MARKER}" ]; then ` +
    `export MISE_YES=1; eval "$(mise env -s bash)"; fi; `
  );
}

/**
 * Prepend the mise-activation prelude to a PROJECT command so a bare `node`/`pnpm`/etc
 * resolves to the project's `mise.toml`-declared toolchain. Self-guarding: when the
 * workspace ships no `mise.toml` (the project declared no toolchain) the activation is
 * skipped and the command runs unchanged. Apply ONLY to the project-command paths
 * (bootstrap + gate tiers + build/deploy-through-gate) — NEVER to the codex/harness path.
 */
export function withMiseActivation(command: string): string {
  return `${miseActivationPrelude()}${command}`;
}

// The mise PROVISIONING commands run at workspace-prep, BEFORE the project's bootstrap,
// when a `mise.toml` is present: `mise trust` (mise's config-trust security gate — the
// config is Tanren-materialized + trusted) then `mise install` (download the declared
// toolchain into the `tanren` user space). LOUD on failure: the caller runs these with
// `set -e` so a failed install HALTS the run (no silent skip), per the no-silent-fallback
// doctrine. GUARDED on the mise.toml being present so a no-toolchain project is a no-op.
// `MISE_YES=1` makes trust/install non-interactive.
export function miseProvisionCommand(): string {
  return (
    `if [ -f ${quoteSshShellArg(MISE_CONFIG_REL_PATH)} ]; then ` +
    `export MISE_YES=1; mise trust ${quoteSshShellArg(MISE_CONFIG_REL_PATH)} && mise install; ` +
    `else echo ${quoteSshShellArg("tanren: no mise.toml - skipping mise install (project declared no toolchain)")}; fi`
  );
}
