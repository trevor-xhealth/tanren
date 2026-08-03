// LAYER-1 DETECTION (environment-management.md §3 Layer 1): read the toolchain a
// repository ACTUALLY DECLARES out of the declaration files it already ships.
//
// THE DEFECT THIS CLOSES. Layer 1's doctrine is "Tanren DETECTS the file; it never
// picks the versions." The implementation recognized exactly ONE file — `mise.toml` —
// so a repository that declares its toolchain the way most repositories do
// (`package.json#packageManager`, `.nvmrc`, `.python-version`, a lockfile) was read as
// "declared no toolchain". Provisioning was skipped, the project's own bootstrap then
// called a bare `pnpm`/`uv`, and the run died three layers away with an opaque
// `pnpm: not found` / exit 127. Detection was too narrow; the doctrine was not.
//
// THIS MODULE IS PURE. Files in, requirements out — no I/O, no execution, no network.
// The runner-side read + provision live in ./toolchainProvision.ts. Keeping the parse
// pure is what makes the whole behaviour unit-testable from a fixture of file contents.
//
// IT NEVER INVENTS A VERSION. Every version returned is a byte the repository itself
// committed. The one thing a declaration can leave open is the version: a LOCKFILE
// declares WHICH tool the project uses but not which version of it (`uv.lock` names no
// uv version). Those are returned with `versionDeclared: false` and the spec `latest`,
// and the provisioner SAYS SO in its log — an unconstrained tool is reported, never
// silently pinned to a version Tanren chose.
//
// THE RULE, stated once: a LOCKFILE declares the TOOL; a version file/field declares
// the VERSION. `pnpm-lock.yaml` says "this project drives pnpm"; `packageManager:
// "pnpm@11.19.0"` says "…at 11.19.0". Both are literal reads of committed bytes.
//
// STACK-AGNOSTIC. The table below names ecosystems, not projects: it is the published
// convention set (npm/corepack, nvm, pyenv, rbenv, asdf, go, rustup), and every entry
// is a file whose meaning is defined by that ecosystem's own tooling — not by any
// repository Tanren happens to gate.

// The repo's OWN mise config path — imported rather than restated so the "defer to the
// repo's explicit declaration" short-circuit here and the activation guard in
// ssh/miseActivate.ts can never drift apart. This is the module's only import; the
// parsing below is otherwise pure and dependency-free.
import { MISE_CONFIG_REL_PATH } from "../ssh/miseActivate.js";

export { MISE_CONFIG_REL_PATH };

// The mise tool name -> the BINARY the project's own shell will call. This is what the
// post-provision verification probes: provisioning that "succeeded" while leaving the
// binary unresolvable is exactly the silent-skip failure this whole module exists to
// kill, so the tool is never considered provisioned until its binary resolves.
const TOOL_BINARIES: Readonly<Record<string, string>> = {
  node: "node",
  pnpm: "pnpm",
  yarn: "yarn",
  npm: "npm",
  bun: "bun",
  deno: "deno",
  python: "python3",
  uv: "uv",
  poetry: "poetry",
  go: "go",
  ruby: "ruby",
  // The rust toolchain's user-facing entry point is cargo (rustc is a build detail).
  rust: "cargo",
};

/** The binary a provisioned tool must expose, or `undefined` for a tool Tanren has no
 * binary mapping for (it is then reported, never silently assumed to be fine). */
export function toolBinary(tool: string): string | undefined {
  return TOOL_BINARIES[tool];
}

/** Every binary Tanren can put on a runner's PATH by provisioning a declared tool. The
 * infrastructure-fault classifier (./toolchainProvision.ts) uses this to tell "your
 * bootstrap needs a toolchain binary nobody declared" (infra — halt) apart from "your
 * bootstrap needs a program your own dependencies should have installed" (a scaffold
 * defect — the writer's to fix). */
export function provisionableBinaries(): string[] {
  return Object.values(TOOL_BINARIES);
}

// Declaration files read for their CONTENTS (they carry a version).
export const TOOLCHAIN_CONTENT_DECLARATION_PATHS: readonly string[] = [
  "package.json",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".ruby-version",
  ".tool-versions",
  "go.mod",
  "rust-toolchain.toml",
  "rust-toolchain",
];

// Declaration files read for their PRESENCE only (they name a tool, not a version).
// Read as presence rather than contents so a large or binary lockfile is never piped
// back over the substrate.
export const TOOLCHAIN_PRESENCE_DECLARATION_PATHS: readonly string[] = [
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "uv.lock",
  "poetry.lock",
  "deno.lock",
];

// Presence path -> the tool it declares.
const PRESENCE_TOOLS: Readonly<Record<string, string>> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "uv.lock": "uv",
  "poetry.lock": "poetry",
  "deno.lock": "deno",
};

// `.tool-versions` (asdf) and `packageManager` use ecosystem names that differ from
// mise's tool names. A literal rename, not a guess.
const TOOL_ALIASES: Readonly<Record<string, string>> = { nodejs: "node", golang: "go" };

export interface ToolchainDeclarationFile {
  /** Workspace-relative path, one of the two exported path lists. */
  readonly path: string;
  /** File contents for a content path; `""` for a presence path. */
  readonly contents: string;
}

export interface ToolchainRequirement {
  /** The mise tool name. */
  readonly tool: string;
  /** The version spec handed to mise — verbatim from the repo, or `latest` when the
   * declaration named the tool without constraining it. */
  readonly spec: string;
  /** The binary that must resolve once the tool is provisioned. */
  readonly bin: string;
  /** The declaration file that asked for it — quoted in every loud failure so the
   * operator is told WHICH of their files Tanren read. */
  readonly declaredIn: string;
  /** False when the declaration named the tool but not a version (a lockfile). */
  readonly versionDeclared: boolean;
}

export interface ToolchainDetection {
  /** True when the repo ships its own `mise.toml`: Tanren defers to mise entirely
   * (`mise trust && mise install`) and detects nothing else — the repo's explicit,
   * first-class declaration always outranks Tanren's reading of its conventions. */
  readonly deferToMiseConfig: boolean;
  readonly requirements: readonly ToolchainRequirement[];
  /** Declarations Tanren READ but could not turn into a provisionable tool (an alias
   * like `lts/iron`, an unparseable manifest, a tool with no binary mapping). Reported
   * loudly by the provisioner — a declaration Tanren cannot honor is never silent. */
  readonly unresolved: readonly UnresolvedDeclaration[];
}

/**
 * WHY A KIND, AND WHY EXACTLY TWO. "Tanren read this and could not honor it" covers two
 * materially different situations, and collapsing them is what let an unhonored VERSION
 * proceed silently:
 *
 *   - `untranslatable-version` — Tanren KNOWS the tool and CAN provision it, but the
 *     version the repo wrote is an alias it must not translate (`lts/iron`,
 *     `channel = "stable"`, `pnpm@`). The repo pinned a version FOR A REASON and Tanren
 *     cannot deliver it; the runner almost certainly has SOME copy of that tool, so
 *     proceeding means gating against a version nobody asked for. This is the case the
 *     enforcement halts on (./toolchainEnforcement.ts).
 *   - `unresolvable-declaration` — Tanren could not get as far as a provisionable tool at
 *     all: an unparseable manifest, a malformed field, a tool name with no binary mapping
 *     (`frobpm`). There is no version to be wrong ABOUT — Tanren cannot claim the run is
 *     on the wrong version of something it never identified — and these are ordinarily
 *     WRITER-fixable (a typo'd `package.json` mid-run). They stay a loud notice, and if
 *     the bootstrap actually needed that tool the missing-binary classifier still halts.
 *
 * That asymmetry is the whole tolerance, stated once and kept narrow.
 */
export type UnresolvedDeclarationKind = "untranslatable-version" | "unresolvable-declaration";

export interface UnresolvedDeclaration {
  readonly path: string;
  readonly reason: string;
  readonly kind: UnresolvedDeclarationKind;
  /** The tool the declaration named, when Tanren got far enough to know it. The
   * infra-fault classifier matches a missing binary against this, so a tool the repo
   * DID declare and Tanren could NOT honor halts as infrastructure rather than being
   * handed to a writer who has no way to install it. */
  readonly tool?: string;
}

/** The kind for a declaration whose VERSION could not be translated: an untranslatable
 * version iff Tanren could otherwise have provisioned that tool (it has a binary), else
 * an unresolvable declaration — Tanren never claims a version is wrong for a tool it
 * could not have put on PATH in the first place. */
function versionKind(tool: string): UnresolvedDeclarationKind {
  return toolBinary(tool) === undefined ? "unresolvable-declaration" : "untranslatable-version";
}

interface Candidate {
  readonly tool: string;
  readonly spec: string;
  readonly declaredIn: string;
  readonly versionDeclared: boolean;
}

/**
 * Detect the toolchain a repository declares from the declaration files it ships.
 *
 * Precedence, applied per tool: a repo `mise.toml` short-circuits everything; then the
 * FIRST version-carrying declaration in path order wins; a lockfile's unconstrained
 * declaration only survives when nothing pinned that tool. Deterministic — the same
 * files always yield the same requirements in the same order.
 */
export function detectToolchainRequirements(files: readonly ToolchainDeclarationFile[]): ToolchainDetection {
  if (files.some((f) => f.path === MISE_CONFIG_REL_PATH)) {
    return { deferToMiseConfig: true, requirements: [], unresolved: [] };
  }
  const unresolved: UnresolvedDeclaration[] = [];
  const candidates: Candidate[] = [];
  for (const path of [...TOOLCHAIN_CONTENT_DECLARATION_PATHS, ...TOOLCHAIN_PRESENCE_DECLARATION_PATHS]) {
    const file = files.find((f) => f.path === path);
    if (file === undefined) continue;
    candidates.push(...readDeclaration(file, unresolved));
  }
  const requirements: ToolchainRequirement[] = [];
  for (const candidate of candidates) {
    const existing = requirements.findIndex((r) => r.tool === candidate.tool);
    // A pinned declaration upgrades an already-recorded unconstrained one; otherwise
    // the first declaration in path order stands.
    if (existing !== -1) {
      const held = requirements[existing];
      if (held !== undefined && (held.versionDeclared || !candidate.versionDeclared)) continue;
      requirements.splice(existing, 1);
    }
    const bin = toolBinary(candidate.tool);
    if (bin === undefined) {
      unresolved.push({
        path: candidate.declaredIn,
        reason: `declares tool "${candidate.tool}", which Tanren has no binary mapping for`,
        kind: "unresolvable-declaration",
        tool: candidate.tool,
      });
      continue;
    }
    requirements.push({ ...candidate, bin });
  }
  return { deferToMiseConfig: false, requirements, unresolved };
}

function readDeclaration(file: ToolchainDeclarationFile, unresolved: UnresolvedDeclaration[]): Candidate[] {
  const presenceTool = PRESENCE_TOOLS[file.path];
  if (presenceTool !== undefined) {
    return [{ tool: presenceTool, spec: "latest", declaredIn: file.path, versionDeclared: false }];
  }
  switch (file.path) {
    case "package.json":
      return readPackageManager(file, unresolved);
    case ".nvmrc":
    case ".node-version":
      return pinned("node", file, unresolved);
    case ".python-version":
      return pinned("python", file, unresolved);
    case ".ruby-version":
      return pinned("ruby", file, unresolved);
    case ".tool-versions":
      return readToolVersions(file, unresolved);
    case "go.mod":
      return readGoMod(file);
    case "rust-toolchain.toml":
      return readRustToolchainToml(file, unresolved);
    case "rust-toolchain":
      return pinned("rust", file, unresolved);
    default:
      return [];
  }
}

// `packageManager: "pnpm@11.19.0+sha512.…"` — the corepack convention. The optional
// `+<integrity>` suffix is corepack's, not a version, and is dropped.
function readPackageManager(file: ToolchainDeclarationFile, unresolved: UnresolvedDeclaration[]): Candidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.contents);
  } catch {
    unresolved.push({ path: file.path, reason: "is not parseable JSON", kind: "unresolvable-declaration" });
    return [];
  }
  const field =
    typeof parsed === "object" && parsed !== null && "packageManager" in parsed
      ? (parsed as { packageManager?: unknown }).packageManager
      : undefined;
  if (typeof field !== "string" || field.trim() === "") return [];
  const at = field.lastIndexOf("@");
  if (at <= 0) {
    unresolved.push({
      path: file.path,
      reason: `packageManager "${field}" is not "<name>@<version>"`,
      kind: "unresolvable-declaration",
    });
    return [];
  }
  const tool = resolveAlias(field.slice(0, at).trim());
  const spec = normalizeSpec(field.slice(at + 1).split("+")[0] ?? "");
  if (spec === undefined) {
    unresolved.push({
      path: file.path,
      reason: `packageManager "${field}" carries no usable version`,
      kind: versionKind(tool),
      tool,
    });
    return [];
  }
  return [{ tool, spec, declaredIn: file.path, versionDeclared: true }];
}

// asdf's `.tool-versions`: `<name> <version>` per line, `#` comments. mise reads this
// format natively; parsing it here keeps the requirement list (and therefore the
// verification) uniform across every declaration form.
function readToolVersions(file: ToolchainDeclarationFile, unresolved: UnresolvedDeclaration[]): Candidate[] {
  const out: Candidate[] = [];
  for (const line of significantLines(file.contents)) {
    const [rawTool, rawSpec] = line.split(/\s+/u);
    if (rawTool === undefined || rawSpec === undefined) continue;
    const spec = normalizeSpec(rawSpec);
    if (spec === undefined) {
      unresolved.push({
        path: file.path,
        reason: `version "${rawSpec}" for "${rawTool}" is not a plain version`,
        kind: versionKind(resolveAlias(rawTool)),
        tool: resolveAlias(rawTool),
      });
      continue;
    }
    out.push({ tool: resolveAlias(rawTool), spec, declaredIn: file.path, versionDeclared: true });
  }
  return out;
}

// `toolchain go1.23.4` is the effective toolchain when present; otherwise the `go`
// directive is the declared language version.
function readGoMod(file: ToolchainDeclarationFile): Candidate[] {
  const lines = significantLines(file.contents);
  const toolchain = lines.find((l) => /^toolchain\s+go\S+$/u.test(l));
  const directive = lines.find((l) => /^go\s+\S+$/u.test(l));
  const raw = toolchain?.replace(/^toolchain\s+go/u, "") ?? directive?.replace(/^go\s+/u, "");
  const spec = raw === undefined ? undefined : normalizeSpec(raw);
  if (spec === undefined) return [];
  return [{ tool: "go", spec, declaredIn: file.path, versionDeclared: true }];
}

// `rust-toolchain.toml`'s `[toolchain] channel = "…"`. Read as a literal line rather
// than through a TOML parser: this is the one field that matters and the repo has no
// TOML dependency. A `channel` Tanren cannot use is reported, never guessed at.
function readRustToolchainToml(file: ToolchainDeclarationFile, unresolved: UnresolvedDeclaration[]): Candidate[] {
  const line = significantLines(file.contents).find((l) => /^channel\s*=/u.test(l));
  if (line === undefined) return [];
  const raw = line.replace(/^channel\s*=\s*/u, "").replaceAll(/^["']|["']$/gu, "");
  const spec = normalizeSpec(raw);
  if (spec === undefined) {
    unresolved.push({
      path: file.path,
      reason: `channel "${raw}" is not a version mise can provision`,
      kind: versionKind("rust"),
      tool: "rust",
    });
    return [];
  }
  return [{ tool: "rust", spec, declaredIn: file.path, versionDeclared: true }];
}

// A single-value version file (`.nvmrc`, `.python-version`, …): the first significant
// line is the version.
function pinned(tool: string, file: ToolchainDeclarationFile, unresolved: UnresolvedDeclaration[]): Candidate[] {
  const raw = significantLines(file.contents)[0];
  if (raw === undefined) return [];
  const spec = normalizeSpec(raw);
  if (spec === undefined) {
    unresolved.push({
      path: file.path,
      reason: `"${raw}" is not a version mise can provision`,
      kind: versionKind(tool),
      tool,
    });
    return [];
  }
  return [{ tool, spec, declaredIn: file.path, versionDeclared: true }];
}

function significantLines(contents: string): string[] {
  return contents
    .split("\n")
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter((line) => line !== "");
}

// Accepts what a version FILE legitimately holds: an optional `v` prefix and a
// dot-separated version, optionally with a pre-release/build tail (`3.13.0rc1`,
// `1.80.0-beta`). Rejects the alias forms Tanren must NOT translate — `lts/iron`,
// `stable`, `system`, `ref:…`, `path:…` — which are reported instead of guessed.
function normalizeSpec(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^v/u, "");
  return /^\d+(\.\d+)*[A-Za-z0-9.+-]*$/u.test(trimmed) ? trimmed : undefined;
}

function resolveAlias(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}
