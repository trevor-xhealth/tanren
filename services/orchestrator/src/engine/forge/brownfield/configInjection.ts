// The config-injection PR. From a confirmed recon report + the chosen governance
// posture, propose the integration files, let the operator EXCLUDE any, then open
// ONE PR in the target repo that adds the kept files. "No runs until merged" —
// opening the PR performs the only writes brownfield onboarding ever makes, and the
// run loop stays gated on the merge. Tanren's native merge queue drives the merge
// directly. The injected gate is `.tanren/ci.yml` — the NATIVE gate definition
// (CiConfigV1) Tanren runs itself over SSH, NOT a GitHub Actions workflow — alongside
// CODEOWNERS and the project snapshot. No forge-CI config is injected (no-Actions
// delivery model): the native gate is the merge authority.
//
// The GitHub side is an injectable `ConfigInjectionGitHub` port (same shape as
// the `ConfigGateGitHub`): production wires the App-token-backed adapter
// (`githubConfigInjection.ts`), tests inject a fake that records the committed
// files + returns a synthetic PR. No new entity, no migration — the files land
// in the target repo via a PR, not in our database.

import type { GovernancePosture } from "../../config/shared.js";
import {
  SKELETON_CI_CONFIG,
  SKELETON_CI_CONFIG_PATH,
  SKELETON_JUSTFILE,
  SKELETON_JUSTFILE_PATH,
} from "../scaffold/index.js";
import type { ReconReport } from "./types.js";

/**
 * How the write seam reconciles a proposed file with one the target repository ALREADY
 * owns. Config injection writes into somebody else's repo, so "what happens when the file
 * is already there" is a property of the PROPOSAL — declared next to the content, visible
 * in review, and testable without a forge — never a special case buried in the writer.
 *
 * - `replace`          — tanren owns the file outright; overwrite whatever is there.
 * - `append_if_absent` — additive: keep the repository's content, append only the lines
 *                        it does not already have (`.gitignore`).
 * - `skip_if_present`  — the repository owns it; write ONLY when it does not exist.
 *
 * `skip_if_present` is the conservative default for anything a real repo plausibly has:
 * replacing such a file is silent data loss (a wiped `.gitignore` makes the writer's
 * `git add -A` commit the whole install tree on the next iteration).
 */
export type FileMergeStrategy = "replace" | "append_if_absent" | "skip_if_present";

// The six files the config-injection PR proposes. `path` is the repo path;
// `merge` is how the writer reconciles it with an existing file at that path.
export interface ProposedFile {
  path: string;
  content: string;
  addedLines: number;
  /** How to reconcile with a file the repository already has at `path`. */
  merge: FileMergeStrategy;
  /** The `.tanren/PROJECT.md` one-time snapshot (don't-edit-by-hand). */
  snapshot?: boolean;
}

/**
 * The bytes to write for `file` given what the repository currently holds at its path
 * (`existing`; `undefined` when the repo has no such file). Returning `undefined` means
 * WRITE NOTHING — the repository's copy stands untouched. Pure, so the write seam calls
 * it with the bytes it read and tests call it directly.
 */
export function mergeFileContent(
  file: { content: string; merge: FileMergeStrategy },
  existing: string | undefined,
): string | undefined {
  if (existing === undefined || file.merge === "replace") return file.content;
  if (file.merge === "skip_if_present") return undefined;
  return appendMissingLines(existing, file.content);
}

/**
 * `existing` plus every non-blank line of `addition` it does not already carry, appended
 * verbatim. `undefined` when the addition is fully present (nothing to write). Line
 * membership is compared trimmed so indentation/CRLF noise never duplicates a rule.
 */
function appendMissingLines(existing: string, addition: string): string | undefined {
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = addition.split("\n").filter((line) => line.trim() !== "" && !present.has(line.trim()));
  if (missing.length === 0) return undefined;
  const base = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${base}\n${missing.join("\n")}\n`;
}

export interface ProposeFilesInput {
  repoSlug: string;
  orgLogin: string;
  repoUrl: string;
  report: ReconReport;
  posture: GovernancePosture;
  generatedAt: string;
  /** The owner team for CODEOWNERS scaffolding (defaults from the org login). */
  operatorsTeam?: string;
  /**
   * Injectable paths the repository ALREADY has — `ownedInjectionPaths` applied to the
   * recon index's tree. Every `skip_if_present` proposal at one of these paths is dropped,
   * so the operator's preview shows what will actually land: no stub justfile on top of a
   * repo that already declares its lifecycle, no blanket CODEOWNERS over per-directory
   * ownership. Defaults to empty (nothing known ⇒ propose everything); the write seam
   * still enforces the same strategy against the file that actually exists, so an empty
   * or stale list can never turn into a clobber.
   */
  existingPaths?: ReadonlyArray<string>;
}

/**
 * Every repo path config injection may write, by role. The SINGLE source of the path set:
 * the proposals below are keyed off it, and `ownedInjectionPaths` reads it to decide which
 * tree entries recon must remember.
 */
export const CONFIG_INJECTION_PATHS = Object.freeze({
  snapshot: ".tanren/PROJECT.md",
  gate: SKELETON_CI_CONFIG_PATH,
  justfile: SKELETON_JUSTFILE_PATH,
  codeowners: "CODEOWNERS",
  gitignore: ".gitignore",
  pullRequestTemplate: ".github/PULL_REQUEST_TEMPLATE.md",
} as const);

/**
 * The injectable paths present in a repository tree. Recon calls this on the index it
 * already reads, and the bounded (≤6-entry) result rides on the signed onboarding state
 * to the config-injection step — which is what makes the "repo owns this file" guard a
 * real value rather than a documented default nobody passes.
 */
export function ownedInjectionPaths(repoPaths: ReadonlyArray<string>): string[] {
  const injectable = new Set<string>(Object.values(CONFIG_INJECTION_PATHS));
  return [...new Set(repoPaths)].filter((path) => injectable.has(path));
}

function postureLine(posture: GovernancePosture): string {
  if (posture === "open") return "open — humans + tanren both push · external pushes tracked, not blocked";
  if (posture === "audit_only") return "audit-only — tanren observes · opens no PRs · operator promotes findings";
  return "strict — every change goes through a spec · external pushes warned + auto-spec'd";
}

function projectSnapshot(input: ProposeFilesInput): string {
  const personas =
    input.report.personas.map((p) => `- **${p.name}** — ${p.description}`).join("\n") || "- (none inferred)";
  const behaviors = input.report.behaviors.map((b) => `- ${b.persona} · ${b.title}`).join("\n") || "- (none inferred)";
  const architecture =
    input.report.architecture.map((a) => `- **${a.layer}** · ${a.detail}`).join("\n") || "- (unknown)";
  return `# ${input.repoSlug}

> Generated by tanren at onboarding · ${input.generatedAt}
> Source of truth: orchestrator dashboard · /projects/${input.repoSlug}
> Don't edit by hand — regenerated only via the audit gate.

## identity

- **org** · ${input.orgLogin}
- **repo** · ${input.repoUrl}
- **purpose** · ${input.report.identity.purpose}

## personas

${personas}

## behaviors

${behaviors}

## architecture

${architecture}

## merge posture

- ${postureLine(input.posture)}
- codeowner review required
`;
}

// The native gate DEFINITION (`.tanren/ci.yml` — a CiConfigV1, NOT a GitHub Actions
// workflow). This is the SAME file Tanren's in-loop native gate consumes via
// `resolveGateConfig`. It is STACK-AGNOSTIC: the injected config is the canonical
// skeleton (engine/forge/scaffold/skeleton.ts), which maps the three lifecycle tiers
// to `just <target>`. Tanren names NO tech stack — the stack lives in the project's
// `justfile`, which config-injection ALSO seeds (below) when the brownfield repo
// ships none. There is NO Actions job, no HMAC secret — Tanren runs these steps
// itself over SSH (the no-Actions delivery model). A repo can edit either file to
// change what the gate runs.
const TANREN_CI_CONFIG = SKELETON_CI_CONFIG;

function codeowners(team: string): string {
  return `# CODEOWNERS — scaffolded by tanren config-injection
* @${team}
.tanren/** @${team}
.github/** @${team}
`;
}

// tanren's `.gitignore` contribution. Leads with a blank line so it reads correctly when
// appended to a repo's existing rules (the only file injection extends rather than owns).
const TANREN_GITIGNORE = "\n# tanren\n.tanren/cache/\n";

function countLines(content: string): number {
  return content.split("\n").length;
}

/**
 * Build the proposed integration files from the recon report + posture. The
 * order matches the hi-fi file column. `excludePaths` removes any the operator
 * unchecked before the PR is opened, and `input.existingPaths` (what recon saw in the
 * repo tree) removes every `skip_if_present` file the repository already owns — the
 * generalization of the old justfile-only guard.
 *
 * STACK-AGNOSTIC: the injected `.tanren/ci.yml` defers to `just <target>`, so we
 * ALSO seed the skeleton `justfile` (the project's lifecycle contract) when the repo
 * ships none — otherwise the injected gate's `just bootstrap`/`just tier-1` steps
 * have nothing to defer to. A repo that already declares its lifecycle keeps it.
 */
export function proposeConfigFiles(input: ProposeFilesInput, excludePaths: ReadonlyArray<string> = []): ProposedFile[] {
  const team = input.operatorsTeam ?? `${input.orgLogin}/tanren-operators`;
  const snapshot = projectSnapshot(input);
  const all: ProposedFile[] = [
    {
      path: CONFIG_INJECTION_PATHS.snapshot,
      content: snapshot,
      addedLines: countLines(snapshot),
      // tanren's own namespace + explicitly "don't edit by hand, regenerated via the
      // audit gate" — the ONE file config injection owns outright.
      merge: "replace",
      snapshot: true,
    },
    {
      path: CONFIG_INJECTION_PATHS.gate,
      content: TANREN_CI_CONFIG,
      addedLines: countLines(TANREN_CI_CONFIG),
      // A repo can EDIT this file to change what the gate runs (see the header), so a
      // re-injection must never silently revert the operator's gate definition.
      merge: "skip_if_present",
    },
    {
      // The stack-agnostic justfile skeleton. `skip_if_present`: the repo's own lifecycle
      // is authoritative — the LOUD-STUB targets would fail every tier if they landed on
      // top of it. When the repo ships none this seeds something for the injected
      // ci.yml's `just <target>` steps to defer to (the operator fills in the stubs).
      path: CONFIG_INJECTION_PATHS.justfile,
      content: SKELETON_JUSTFILE,
      addedLines: countLines(SKELETON_JUSTFILE),
      merge: "skip_if_present",
    },
    {
      path: CONFIG_INJECTION_PATHS.codeowners,
      content: codeowners(team),
      addedLines: countLines(codeowners(team)),
      // A blanket `* @org/tanren-operators` would erase per-directory ownership — the
      // repo's review routing. Only scaffold it when the repo has none.
      merge: "skip_if_present",
    },
    {
      path: CONFIG_INJECTION_PATHS.gitignore,
      content: TANREN_GITIGNORE,
      addedLines: countLines(TANREN_GITIGNORE),
      // ADDITIVE — the one file we extend rather than own. Replacing it would drop the
      // rules keeping node_modules/, .venv/, dist/, … out of the index, and tanren's
      // writer runs `git add -A`: the next iteration would commit the whole install tree.
      merge: "append_if_absent",
    },
    {
      path: CONFIG_INJECTION_PATHS.pullRequestTemplate,
      content: "## summary\n\n## spec\n\n<!-- tanren spec link -->\n",
      addedLines: 4,
      // A repo's PR template often carries compliance checklists. Never overwrite it.
      merge: "skip_if_present",
    },
  ];
  const excluded = new Set(excludePaths);
  const owned = new Set(input.existingPaths ?? []);
  return all.filter((file) => !excluded.has(file.path) && !(file.merge === "skip_if_present" && owned.has(file.path)));
}

// ── The injectable GitHub side (open-the-PR) ───────────────────────────────

export interface InjectedConfigPullRequest {
  number: number;
  url: string;
  branch: string;
  /** The files the PR actually WROTE — never the proposal list. */
  filesCommitted: ReadonlyArray<string>;
  /** Proposed files the repository already owned, so the writer stood down. */
  filesSkipped?: ReadonlyArray<string>;
}

// Port the engine opens the PR through. Production wires the App-backed adapter;
// tests inject a fake. Mirrors the `ConfigGateGitHub` seam.
export interface ConfigInjectionGitHub {
  openConfigInjectionPr(input: {
    repoUrl: string;
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
    // `merge` rides along so the write seam can honor the proposal's strategy — it is
    // the only place that knows what the target repo currently holds at each path.
    files: ReadonlyArray<{ path: string; content: string; merge: FileMergeStrategy }>;
  }): Promise<InjectedConfigPullRequest>;
}

export interface OpenConfigInjectionInput {
  github: ConfigInjectionGitHub;
  repoUrl: string;
  baseBranch: string;
  files: ProposedFile[];
  /** Override the head branch (default `tanren/integrate`). */
  headBranch?: string;
}

const DEFAULT_HEAD_BRANCH = "tanren/integrate";

/**
 * Open the config-injection PR with the KEPT files. The body states the
 * "no runs until merged" contract so the operator (and any reviewer) sees it.
 */
export async function openConfigInjectionPr(input: OpenConfigInjectionInput): Promise<InjectedConfigPullRequest> {
  if (input.files.length === 0) {
    throw new Error("config-injection PR needs at least one file (all were excluded)");
  }
  const headBranch = input.headBranch ?? DEFAULT_HEAD_BRANCH;
  const fileList = input.files.map((f) => `- \`${f.path}\` · ${f.merge}`).join("\n");
  const body = [
    "Tanren integration files, proposed from the read-only recon pass.",
    "",
    "**No runs happen until this PR is merged.** Comment, edit, or close like any other PR.",
    "",
    "A file this repo already owns is never overwritten: `skip_if_present` files are left",
    "alone, `append_if_absent` files only gain the lines they are missing.",
    "",
    "Files:",
    fileList,
  ].join("\n");
  return input.github.openConfigInjectionPr({
    repoUrl: input.repoUrl,
    baseBranch: input.baseBranch,
    headBranch,
    title: "tanren · integration config",
    body,
    files: input.files.map((f) => ({ path: f.path, content: f.content, merge: f.merge })),
  });
}
