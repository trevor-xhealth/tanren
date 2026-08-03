// The paths seeded into a workspace checkout's LOCAL git ignore
// (`$GIT_DIR/info/exclude`) right after clone — see `seedWorkspaceLocalIgnore`
// in ./bootstrap.ts, which is the only consumer.
//
// WHY: every gate and every writer iteration runs `git add -A` (bootstrap.ts's
// `commitBootstrapState`, providers/writerGit.ts, providers/codexGit.ts). Any
// build/dependency/cache tree a bootstrap or gate leaves behind is therefore
// swept into the writer's diff. That already caused one live failure — a prior
// gate's `pnpm install` left `node_modules/` in the tree, `git add -A` committed
// it, and the checker prompt ballooned to 46MB, past the model's input limit.
// The original fix listed exactly `node_modules/` and `dist/`, which only covers
// Node. A `terraform init` (provider binaries, routinely 200MB–1GB), a `uv sync`
// (`.venv/`), a `cargo build` (`target/`) or a `go mod vendor` reproduces the
// same failure in a repo that is not a Node monorepo.
//
// HOW IT INTERACTS WITH THE REPO'S OWN `.gitignore` (decision 2). This list is
// ADDITIVE, and deliberately sits at the LOWEST precedence layer git offers for
// per-checkout rules. git consults, in increasing precedence:
//   core.excludesFile  <  $GIT_DIR/info/exclude  <  .gitignore (deepest wins)
// so a brownfield repo that ships `.gitignore` keeps the last word: a
// `!build/` (or any more specific negation) in a tracked `.gitignore` OVERRIDES
// anything written here. Most entries below are therefore redundant with what a
// normal repo already ignores — that redundancy is the point (the exclude has to
// hold for repos whose `.gitignore` is absent, partial, or wrong for the stack
// the gate actually installed), and redundancy cannot produce a conflict because
// duplicate ignore rules are idempotent. Ignores also apply ONLY to UNTRACKED
// files: a repo that legitimately TRACKS `build/` keeps every modification to
// those files in the writer's diff regardless of what this list says.
//
// PRECISION (decision 1). Two tiers, because a blanket substring match would
// silently drop source files — a strictly worse failure than a large diff.

// Tier 1 — directory names that are NEVER a source directory in practice, so
// they are matched at ANY depth (a gitignore pattern whose only slash is the
// trailing one matches in every subdirectory). This is what catches a per-package
// `services/api/__pycache__/` or `apps/web/.next/` in a monorepo.
//
// Every entry ends in `/` so it matches a DIRECTORY only — a source file named
// `dist`, `coverage` or `venv` is still staged.
const ANY_DEPTH_OUTPUT_DIRS = [
  // Node / JS
  "node_modules/",
  "dist/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".astro/",
  ".turbo/",
  ".parcel-cache/",
  ".nyc_output/",
  ".pnpm-store/",
  ".yarn/cache/",
  ".yarn/unplugged/",
  // Python
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.egg-info/",
  ".eggs/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".tox/",
  ".nox/",
  ".ipynb_checkpoints/",
  // Infrastructure
  ".terraform/",
  ".terragrunt-cache/",
  // JVM
  ".gradle/",
  // Other ecosystems
  ".dart_tool/",
  ".stack-work/",
  "_build/",
  // Stack-agnostic
  "coverage/",
  ".cache/",
] as const;

// Tier 2 — names that ARE mainstream build output (Cargo/Maven `target/`,
// Gradle/CMake `build/`, Go/Composer `vendor/`, Mix `deps/`, bundler `out/`) but
// are ALSO legitimate SOURCE directory names (a `build/` of build scripts, a
// Java module literally named `target`, a hand-written `vendor/` of patched
// third-party code). Blanket-ignoring them at any depth would silently delete
// such a directory from every writer diff.
//
// These are therefore ANCHORED to the repository root with a leading `/`, which
// in `$GIT_DIR/info/exclude` resolves against the top level of the work tree.
// That covers where the size monsters actually land — a Cargo workspace's
// `target/` and a Go module's `vendor/` are root-level by construction — while
// leaving `packages/parser/target/` or `src/build/` fully stageable.
//
// Deliberately NOT listed: `bin/` and `obj/`. `bin/` at a repo root is far more
// often committed scripts than output, and .NET's `bin/`+`obj/` are per-project
// (so root anchoring would not catch them anyway) and small. Their absence is a
// large-diff risk, which is the failure we prefer.
const ROOT_ONLY_OUTPUT_DIRS = ["/build/", "/target/", "/out/", "/vendor/", "/deps/"] as const;

/**
 * Build/dependency/cache output written to a workspace checkout's
 * `$GIT_DIR/info/exclude` after clone, so no later `git add -A` can sweep an
 * install tree into the writer's diff. Never a committed `.gitignore`.
 */
export const WORKSPACE_LOCAL_IGNORE_PATHS = [...ANY_DEPTH_OUTPUT_DIRS, ...ROOT_ONLY_OUTPUT_DIRS] as const;
