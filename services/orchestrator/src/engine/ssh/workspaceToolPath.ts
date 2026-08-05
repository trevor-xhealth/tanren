// THE WORKSPACE TOOL DIRECTORY — a writable, run-scoped `bin` that is on `PATH` for every
// command that runs the PROJECT's code, and the documented destination for the tools that
// a project's environment needs and Layer 2 (mise) does not provide.
//
// WHY THIS EXISTS. Tanren provisions a project's LANGUAGE toolchain through mise
// (environment-management.md §3 Layer 2) and that covers node/python/go/pnpm/uv. It does
// not cover the rest of a real repository's toolchain: `gitleaks`, `shellcheck`,
// `terraform`, `protoc`, `hadolint` — native binaries a project's own gates and commit
// hooks call by name. Before this module a repository had NOWHERE TO PUT ONE. Measured on
// a live runner, in the exact shell `buildSshExecCommand` produces:
//
//   PATH=/usr/local/bin:/usr/bin:/bin:/usr/games
//
// Every one of those is root-owned; the `tanren` user is non-root and the image installs
// no `sudo` ON PURPOSE (runner/Dockerfile: "The non-root `tanren` user that runs the gate
// cannot apt-install at runtime"). mise activation adds only mise's OWN tool directories.
// So a repository could declare an install command, run it, and still watch its own
// pre-commit hook fail on `error: gitleaks is not installed or not on PATH` — the binary
// existed, in a directory nothing would ever look in. A `setup` verb with no writable
// destination on `PATH` is a verb with nowhere to write; this module is the other half.
//
// WHAT IT IS NOT. It is not a place Tanren puts anything. Tanren creates the directory and
// exports it; what lands inside is entirely the project's, installed by the project's own
// declared `setup.run` (workspace/setup.ts). Tanren names no tool here — the doctrine's
// "Tanren core hardcodes ZERO project toolchain" holds exactly as before.
//
// RUN-SCOPED, NOT RUNNER-WIDE. Three runs share one container as one unix user. A shared
// `$HOME/.local/bin` would let run A's `terraform 1.9` be found by run B, which pinned
// 1.7 — the same class of cross-run contamination that a per-run mise config was just
// introduced to close. The directory is therefore named from the workspace path
// ({@link workspaceScopePrefix}) and torn down with the run's sandbox. `$HOME/.local/bin`
// is deliberately NOT added to `PATH` for the same reason, despite being the XDG
// convention a setup script might otherwise reach for.

import { workspaceScopePrefix } from "./workspaceScope.js";

/**
 * The env var that names the tool directory. A project's declared `setup.run` installs
 * into `"$TANREN_BIN"`; this is the contract between Tanren and that command, and the
 * only thing a repository has to know to make a native binary reachable.
 */
export const TANREN_BIN_ENV = "TANREN_BIN";

/** The run's tool directory. Pure. Outside the repo tree — Tanren never materializes a
 * path into a repository it did not author. */
export function workspaceToolBinDir(workspacePath: string): string {
  return workspaceScopePrefix(workspacePath, "bin");
}

/**
 * Prepend the tool-directory prelude to a PROJECT command: export `$TANREN_BIN` and put it
 * on `PATH`.
 *
 * PRECEDENCE. The directory is prepended to `PATH` HERE, and the mise activation that
 * follows prepends its own directories AFTER — so a tool the repository DECLARED a version
 * for (node, pnpm, python: Layer 1 + Layer 2) always wins over anything of the same name in
 * the tool directory. That ordering is the point: this directory extends the project's
 * environment, it never silently overrides the part of it the repository pinned.
 *
 * UNCONDITIONAL, and deliberately so — unlike the mise activation next to it, there is no
 * guard. The export costs nothing when the directory is empty or absent (a `PATH` entry
 * that does not exist is inert), and a guard would mean a project's `setup.run` could
 * install a binary into a directory that a LATER command then does not have on `PATH` —
 * exactly the failure this module exists to remove.
 */
export function withWorkspaceToolPath(command: string, workspacePath: string): string {
  const bin = workspaceToolBinDir(workspacePath);
  return `export ${TANREN_BIN_ENV}="${bin}"; export PATH="${bin}:$PATH"; ${command}`;
}
