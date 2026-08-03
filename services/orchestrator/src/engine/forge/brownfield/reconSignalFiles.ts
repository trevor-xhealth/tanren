// Brownfield recon's SIGNAL-FILE policy: which of a repo's files are worth
// spending the bounded content budget on, and in what order.
//
// PURE — no I/O. `githubRepoReader.ts` owns the reading; this module owns the
// judgement, the way `workflowIntentTaxonomy.ts` owns the vocabulary its
// classifier reasons with.
//
// Recon reads content for only a bounded slice of a linked repo, so WHICH files
// it reads is the whole game, and that decomposes into two questions this module
// answers separately:
//
//   1. CANDIDATES — what counts as a project's defining file at all. A set that
//      only knows `package.json` / `tsconfig` renders a Python, Go, Rust, JVM,
//      Ruby, PHP, .NET or Terraform repo — and every polyglot monorepo — mute:
//      its most informative files never match, so no amount of reordering can
//      reach them and they arrive at the Answerer with EMPTY previews.
//   2. RANK — which candidates win when there are more of them than slots.
//      Reading "whatever the tree API listed first" is reading whatever sorts
//      first alphabetically, which in any layered repo means the `.github/`
//      directory and the earliest nested workspaces.
//
// Deliberately NOT candidates: LOCKFILES (`package-lock.json`, `pnpm-lock.yaml`,
// `uv.lock`, `Cargo.lock`, `go.sum`, `Gemfile.lock`, `composer.lock`, …). They
// are the largest files in most repos and the least informative per byte — a
// resolved dependency graph restates what the manifest beside them already
// declares. They still reach the Answerer as EVIDENCE, because every blob in the
// tree is indexed path-only: seeing `uv.lock` in the index establishes "this is
// a uv-managed Python repo" without burning a content slot a real manifest
// could have used. The patterns below are exact enough that this falls out for
// free (`pipfile` does not match `Pipfile.lock`, `cargo.toml` does not match
// `Cargo.lock`).

// How a pattern is matched, most specific form first:
//   • contains "/" → a DIRECTORY-shaped signal, matched as a substring of the
//     whole path (`.github/workflows/`, `prisma/schema.prisma`).
//   • contains "*" → ONE wildcard against the file's BASENAME: it must start
//     with the text before the star and end with the text after it
//     (`requirements*.txt`, `*.tf`, `vite.config.*`).
//   • otherwise → an EXACT basename match (`go.mod`, `package.json`).
// Every pattern is written lower-case; matching lower-cases the path, so
// `Cargo.toml` and `CARGO.TOML` both match `cargo.toml`.
//
// Basename anchoring is what makes extension families expressible at all, and it
// removes the over-matching a bare path substring had: `readme` used to match
// `docs/readme-generator/src/build.ts`, and `package.json` used to match
// `tools/package.json.template`.

// Project definition, dependency manifests and build configuration — the files
// that describe how a repo is assembled, per ecosystem.
const MANIFEST_PATTERNS = [
  // JS / TS: package manifest, compiler + monorepo build configuration.
  "package.json",
  "tsconfig*.json",
  "turbo.json",
  "nx.json",
  "pnpm-workspace.yaml",
  "lerna.json",
  "vite.config.*",
  "next.config.*",
  // Python: PEP 518 project file, legacy setuptools, pinned deps, Pipenv.
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements*.txt",
  "pipfile",
  // Go, Rust.
  "go.mod",
  "go.work",
  "cargo.toml",
  // JVM: Maven and both Gradle dialects.
  "pom.xml",
  "build.gradle*",
  "settings.gradle*",
  // Ruby, PHP, .NET.
  "gemfile",
  "*.gemspec",
  "composer.json",
  "*.csproj",
  "*.sln",
  // Data layer.
  "prisma/schema.prisma",
  // Infrastructure + packaging: how the thing is built, shipped and deployed.
  "dockerfile*",
  "docker-compose*.yml",
  "docker-compose*.yaml",
  "compose.yml",
  "compose.yaml",
  "*.tf",
  "chart.yaml",
  // Task runners — usually the most honest statement of a repo's real workflow.
  "makefile",
  "justfile",
  "taskfile*",
];

// The contracts a repo enforces across itself: CI pipelines (any provider, not
// just GitHub — a GitLab/CircleCI/Azure/Jenkins repo is no less worth
// onboarding) and code ownership.
const CI_PATTERNS = [
  ".github/workflows/",
  ".gitlab-ci.yml",
  ".circleci/",
  "azure-pipelines*",
  "jenkinsfile",
  "codeowners",
];

// Prose. The least dense of the three classes, but the only one that states
// intent in the authors' own words.
const DOC_PATTERNS = ["readme*"];

// Every pattern recon pulls content for — the union of the classes above.
const SIGNAL_PATTERNS = [...MANIFEST_PATTERNS, ...CI_PATTERNS, ...DOC_PATTERNS];

// Selection tiers, most-informative first. Root-level files describe the WHOLE
// repo, so they lead regardless of class (and there are only ever a handful of
// them); then the repo-wide contracts; then nested manifests; then nested prose.
const ROOT_TIER = 0;
const CI_TIER = 1;
const NESTED_MANIFEST_TIER = 2;
const NESTED_DOC_TIER = 3;

function basenameOf(lowerPath: string): string {
  const lastSlash = lowerPath.lastIndexOf("/");
  return lastSlash === -1 ? lowerPath : lowerPath.slice(lastSlash + 1);
}

function matchesPattern(lowerPath: string, lowerBase: string, pattern: string): boolean {
  if (pattern.includes("/")) return lowerPath.includes(pattern);
  const star = pattern.indexOf("*");
  if (star === -1) return lowerBase === pattern;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  // The length guard stops prefix and suffix from overlapping, so `*.tf` does
  // not match a file literally named `.tf`.
  return (
    lowerBase.length >= prefix.length + suffix.length && lowerBase.startsWith(prefix) && lowerBase.endsWith(suffix)
  );
}

function matchesAny(lowerPath: string, patterns: readonly string[]): boolean {
  const lowerBase = basenameOf(lowerPath);
  return patterns.some((pattern) => matchesPattern(lowerPath, lowerBase, pattern));
}

// How many directories deep a path sits (0 == a root-level file).
function pathDepth(path: string): number {
  return path.split("/").length - 1;
}

function signalTier(path: string): number {
  const lower = path.toLowerCase();
  if (pathDepth(path) === 0) return ROOT_TIER;
  if (matchesAny(lower, CI_PATTERNS)) return CI_TIER;
  if (matchesAny(lower, MANIFEST_PATTERNS)) return NESTED_MANIFEST_TIER;
  return NESTED_DOC_TIER;
}

// The final tiebreak. Compares by CODE UNIT rather than `localeCompare` so the
// ordering is identical on every host — a locale-sensitive collation would make
// the selection depend on the machine recon happens to run on.
function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The signal paths in the order recon should spend its content budget on them:
 * tier first, then shallower before deeper (a workspace nearer the root
 * describes more of the repo), then the path itself so a given tree always
 * yields the SAME selection no matter what order the trees API returned it in.
 */
export function rankSignalPaths(paths: readonly string[]): string[] {
  return [...paths]
    .filter((path) => matchesAny(path.toLowerCase(), SIGNAL_PATTERNS))
    .sort(
      (left, right) =>
        signalTier(left) - signalTier(right) || pathDepth(left) - pathDepth(right) || comparePaths(left, right),
    );
}
