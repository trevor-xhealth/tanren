// Brownfield recon's ECOSYSTEM CATALOGUE: turning the indexed PATHS of a
// repository into the named languages, runtimes, build tooling and
// infrastructure that describe it.
//
// PURE — no I/O, no network, no judgement about what matters. Given a list of
// paths it returns what those paths mechanically prove is present, with the
// specific paths that prove it.
//
// WHY THIS EXISTS. The entry-point rollup already showed the model an extension
// histogram — literally `.py 2244`, `.tf 60` — and a real recon over a real
// polyglot monorepo read Python route files as evidence, cited them, and never
// once named Python, Terraform or the backend as an architectural layer. That is
// not carelessness; it is CORRECT behaviour for a model that refuses to state
// what its evidence does not say. `.tf 60` is a file-extension count.
// "Terraform" is a claim about the repository. A calibrated model will not make
// the leap, and a prompt that merely LEANS on it harder buys recall with exactly
// the fabrication this loop currently avoids.
//
// So the leap is made HERE, mechanically, where it is checkable: an extension
// and a manifest filename are facts about the tree, the mapping from them to a
// name is a fixed catalogue, and every sighting carries the paths it was derived
// from. The model is then REPORTING evidence rather than inferring from a
// histogram, and an ecosystem absent from the tree can never be named — there is
// no path to derive it from.
//
// DELIBERATELY GENERIC. Nothing here names a customer's directory, service or
// framework. A row earns its place by being recognizable from a file EXTENSION
// or a STANDARD FILENAME that the tool itself defines — never from a
// project-specific convention.
//
// AND DELIBERATELY SHALLOW. What a repository DEPENDS on lives inside a manifest
// (a web framework, an ORM, a migration tool, a cloud SDK), and recon may not
// have read that manifest yet — asserting it from a path would be the invention
// this module exists to prevent. Naming the ecosystem and pointing at its
// manifest is what lets the model go and READ it, which is the whole point.

import { signalPathMatcher } from "./reconSignalFiles.js";

/** One catalogue row: a name, the extensions that imply it, its own filenames. */
interface EcosystemEntry {
  readonly name: string;
  /** Lower-case file extensions, leading dot included. */
  readonly extensions: readonly string[];
  /** Signal-file patterns (see `reconSignalFiles.ts` for the matching forms). */
  readonly manifests: readonly string[];
}

// Languages and runtimes first, then the layers that describe how the thing is
// assembled, tested, shipped and deployed. Order is the rendering tiebreak.
const CATALOGUE: readonly EcosystemEntry[] = [
  { name: "TypeScript", extensions: [".ts", ".tsx", ".mts", ".cts"], manifests: ["tsconfig*.json"] },
  { name: "JavaScript", extensions: [".js", ".jsx", ".mjs", ".cjs"], manifests: ["package.json"] },
  {
    name: "Python",
    extensions: [".py", ".pyi"],
    manifests: ["pyproject.toml", "setup.py", "setup.cfg", "requirements*.txt", "pipfile"],
  },
  { name: "Go", extensions: [".go"], manifests: ["go.mod", "go.work"] },
  { name: "Rust", extensions: [".rs"], manifests: ["cargo.toml"] },
  { name: "Ruby", extensions: [".rb"], manifests: ["gemfile", "*.gemspec"] },
  { name: "Java", extensions: [".java"], manifests: ["pom.xml", "build.gradle*"] },
  { name: "Kotlin", extensions: [".kt", ".kts"], manifests: [] },
  { name: "Scala", extensions: [".scala"], manifests: ["build.sbt"] },
  { name: "CSharp", extensions: [".cs"], manifests: ["*.csproj", "*.sln"] },
  { name: "PHP", extensions: [".php"], manifests: ["composer.json"] },
  { name: "Swift", extensions: [".swift"], manifests: ["package.swift"] },
  { name: "Elixir", extensions: [".ex", ".exs"], manifests: ["mix.exs"] },
  { name: "C and C++", extensions: [".c", ".h", ".cc", ".cpp", ".hpp"], manifests: ["cmakelists.txt"] },
  { name: "Shell", extensions: [".sh", ".bash", ".zsh"], manifests: [] },
  { name: "SQL", extensions: [".sql"], manifests: [] },
  // Infrastructure, packaging and deployment.
  { name: "Terraform", extensions: [".tf", ".tfvars"], manifests: [] },
  { name: "Docker", extensions: [], manifests: ["dockerfile*", "docker-compose*.yml", "compose.yml", "compose.yaml"] },
  { name: "Kubernetes", extensions: [], manifests: ["chart.yaml", "kustomization.yaml"] },
  // Build, workspace and task tooling — the honest statement of a repo's workflow.
  { name: "pnpm workspaces", extensions: [], manifests: ["pnpm-workspace.yaml"] },
  { name: "Turborepo", extensions: [], manifests: ["turbo.json"] },
  { name: "Nx", extensions: [], manifests: ["nx.json"] },
  { name: "Lerna", extensions: [], manifests: ["lerna.json"] },
  { name: "Vite", extensions: [], manifests: ["vite.config.*"] },
  { name: "Next.js", extensions: [], manifests: ["next.config.*"] },
  { name: "Make", extensions: [], manifests: ["makefile"] },
  { name: "just", extensions: [], manifests: ["justfile"] },
  { name: "Task", extensions: [], manifests: ["taskfile*"] },
  // Test runners, schema and migration tooling — path-visible, contents unread.
  { name: "Vitest", extensions: [], manifests: ["vitest.config.*", "vitest.workspace.*"] },
  { name: "Jest", extensions: [], manifests: ["jest.config.*"] },
  { name: "pytest", extensions: [], manifests: ["pytest.ini", "conftest.py", "tox.ini"] },
  { name: "Alembic", extensions: [], manifests: ["alembic.ini"] },
  { name: "Prisma", extensions: [".prisma"], manifests: [] },
  { name: "GitHub Actions", extensions: [], manifests: [".github/workflows/"] },
  { name: "GitLab CI", extensions: [], manifests: [".gitlab-ci.yml"] },
];

/** What the catalogue found, and the paths it was found from. */
interface EcosystemSighting {
  readonly name: string;
  /** Files whose extension belongs to this ecosystem. */
  readonly files: number;
  /** Indexed files bearing one of its own filenames — how it is declared. */
  readonly declarations: number;
  /** The extensions actually seen, most frequent first. */
  readonly extensions: readonly string[];
  /** Indexed paths proving it, manifests first then shallowest — what to open. */
  readonly evidence: readonly string[];
}

/** Evidence paths named per sighting: enough to reach each area, few enough to read. */
const EVIDENCE_ROWS = 3;

function extensionOf(path: string): string {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? "" : basename.slice(dot).toLowerCase();
}

function pathDepth(path: string): number {
  return path.split("/").length - 1;
}

/** Shallowest first, then by code unit — a stable, host-independent order. */
function byDepthThenPath(left: string, right: string): number {
  return pathDepth(left) - pathDepth(right) || (left < right ? -1 : left > right ? 1 : 0);
}

/** Manifests lead (they describe the layer); extension carriers fill the rest. */
function evidenceFor(manifests: readonly string[], carriers: readonly string[]): string[] {
  const chosen: string[] = [];
  for (const path of [...manifests].sort(byDepthThenPath)) {
    if (chosen.length >= EVIDENCE_ROWS) return chosen;
    chosen.push(path);
  }
  for (const path of [...carriers].sort(byDepthThenPath)) {
    if (chosen.length >= EVIDENCE_ROWS) return chosen;
    if (!chosen.includes(path)) chosen.push(path);
  }
  return chosen;
}

/**
 * Every ecosystem the indexed paths PROVE is present, largest first.
 *
 * A sighting requires either files carrying one of its extensions or at least
 * one of its own filenames in the tree — both facts about paths that were
 * actually indexed, so nothing absent from the repository can be named.
 */
function detectEcosystems(paths: readonly string[]): EcosystemSighting[] {
  // ONE pass over the tree feeds both axes — the extension histogram, and per
  // catalogue row the manifests that declare it. The tree is walked once and
  // each path normalized once; see `signalPathMatcher` for why that matters at
  // twelve thousand paths × thirty-odd rows × every turn of an exploration.
  const byExtension = new Map<string, string[]>();
  const manifestsPerEntry = CATALOGUE.map((): string[] => []);
  for (const path of paths) {
    const extension = extensionOf(path);
    if (extension !== "") {
      const bucket = byExtension.get(extension);
      if (bucket === undefined) byExtension.set(extension, [path]);
      else bucket.push(path);
    }
    const matches = signalPathMatcher(path);
    for (const [position, entry] of CATALOGUE.entries()) {
      if (entry.manifests.length > 0 && matches(entry.manifests)) manifestsPerEntry[position]?.push(path);
    }
  }
  const sightings: EcosystemSighting[] = [];
  for (const [position, entry] of CATALOGUE.entries()) {
    const seen = entry.extensions
      .map((extension) => [extension, byExtension.get(extension) ?? []] as const)
      .filter(([, carriers]) => carriers.length > 0)
      .sort((left, right) => right[1].length - left[1].length);
    const files = seen.reduce((total, [, carriers]) => total + carriers.length, 0);
    const manifests = manifestsPerEntry[position] ?? [];
    if (files === 0 && manifests.length === 0) continue;
    sightings.push({
      name: entry.name,
      files,
      declarations: manifests.length,
      extensions: seen.map(([extension]) => extension),
      evidence: evidenceFor(
        manifests,
        seen.flatMap(([, carriers]) => carriers),
      ),
    });
  }
  return sightings.sort((left, right) => right.files - left.files);
}

/**
 * One line per sighting: the NAME beside the counts and the specific paths it
 * was derived from, so every line is checkable against the tree and any chapter
 * resting on it can cite something concrete.
 */
export function renderEcosystems(paths: readonly string[]): string[] {
  const sightings = detectEcosystems(paths);
  if (sightings.length === 0) return [];
  const lines = [
    "## Ecosystems present in the indexed paths",
    "Derived MECHANICALLY from file extensions and standard filenames across the WHOLE",
    "tree, so this list is complete and checkable: everything named here is present,",
    "and an ecosystem not named here left no path evidence. The CONTENTS behind these",
    "paths have not necessarily been read — open one before describing how it works.",
  ];
  for (const sighting of sightings) {
    const declared = `declared by ${sighting.declarations} ${sighting.declarations === 1 ? "file" : "files"}`;
    const shape =
      sighting.files === 0
        ? declared
        : `${sighting.files} ${sighting.files === 1 ? "file" : "files"} (${sighting.extensions.join(", ")})`;
    const where = sighting.evidence.length === 0 ? "" : `; e.g. ${sighting.evidence.join(", ")}`;
    lines.push(`- ${sighting.name} — ${shape}${where}`);
  }
  return lines;
}
