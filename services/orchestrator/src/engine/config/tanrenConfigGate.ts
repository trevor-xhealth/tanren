// the tanren-config audit-gate write flow.
//
// An optional org toggle (`organizations.config.auditGateEnabled`) that routes
// Bucket-B config writes (routing chains + escape-hatch limits) through a PR in
// a separate `tanren-config` repo before they apply to the DB. The DB stays the
// source of truth; the PR is a *write gate*:
//
//   gate OFF  → the write applies directly to the DB (today's behavior).
//   gate ON   → the write does NOT apply. Instead the change is rendered as a
//               `tanren.yaml` diff and opened as a PR in the configured repo
//               (via an injectable GitHub client). The change applies to the DB
//               only when that PR merges (apply-on-merge), driven by
//               `applyOnMerge`.
//
// Everything here is pure / injectable so the GitHub calls are mockable in
// tests (no network, no live repo). The gate target + toggle live in
// `organizations.config` JSONB (see `OrgAuditGateTarget`) — NO DB migration.

import type { OrgConfigV1, OrgAuditGateTarget } from "./orgConfig.js";
import { RoleId, type RoutingTable } from "./shared.js";

// --------------------------------------------------------------------------
// Bucket-B detection
// --------------------------------------------------------------------------

// Bucket-B = the config a routing change touches: per-role fallback chains. A
// write that only flips the gate toggle / repo target / notification refs is NOT
// Bucket-B and is never gated (otherwise you could never turn the gate off
// without a PR). (The escape-hatch limits that once also lived here are gone —
// apex v35: there are no hardcoded attempt caps to configure.)
export function isBucketBChange(prev: OrgConfigV1, next: OrgConfigV1): boolean {
  return JSON.stringify(next.routing) !== JSON.stringify(prev.routing);
}

// --------------------------------------------------------------------------
// tanren.yaml rendering + diff
// --------------------------------------------------------------------------

/** A single rendered diff line, matching the hi-fi `CONFIG_PR.diff` shape. */
export interface ConfigYamlDiffLine {
  /** add = `+`, rem = `−`, ctx = unchanged, comment = a `#` header line. */
  t: "add" | "rem" | "ctx" | "comment";
  /** The line text (without the gutter glyph). */
  s: string;
}

function routingLines(routing: RoutingTable): string[] {
  const lines: string[] = ["[providers]"];
  for (const role of RoleId.options) {
    const chain = routing[role].chain;
    if (chain.length === 0) continue;
    // An entry with NO `model` is the routing schema's "use this provider's pinned
    // default" — render the bare cli rather than interpolating `undefined` into the
    // committed `tanren.yaml`.
    const rendered = chain.map((e) => (e.model === undefined ? e.cli : `${e.cli}/${e.model}`));
    lines.push(`  ${role}.primary = "${rendered[0]}"`);
    if (rendered.length > 1) {
      lines.push(
        `  ${role}.fallback = [${rendered
          .slice(1)
          .map((r) => `"${r}"`)
          .join(", ")}]`,
      );
    }
  }
  return lines;
}

/** Render a config as the canonical `tanren.yaml` text the PR commits. */
export function renderTanrenYaml(config: OrgConfigV1): string {
  return [
    "# tanren.yaml · org config (managed by tanren-config audit gate)",
    "",
    ...routingLines(config.routing),
    "",
  ].join("\n");
}

/**
 * Render the change `prev → next` as a line-oriented `tanren.yaml` diff. Lines
 * present in both are `ctx`; lines only in `next` are `add`; only in `prev` are
 * `rem`. Comment (`#`) lines render as `comment`. The ordering follows `next`,
 * with removed lines interleaved at the first divergence per section — enough
 * for the review surface without a full Myers diff.
 */
export function renderTanrenYamlDiff(prev: OrgConfigV1, next: OrgConfigV1): ConfigYamlDiffLine[] {
  const prevLines = renderTanrenYaml(prev).split("\n");
  const nextLines = renderTanrenYaml(next).split("\n");
  const prevSet = new Set(prevLines);
  const nextSet = new Set(nextLines);
  const out: ConfigYamlDiffLine[] = [];
  const emittedRem = new Set<string>();

  for (const line of nextLines) {
    // Emit any prev-only lines that share this line's leading key, just before
    // the added line, so a changed value shows as rem-then-add.
    const key = leadingKey(line);
    if (key !== undefined) {
      for (const p of prevLines) {
        if (!nextSet.has(p) && !emittedRem.has(p) && leadingKey(p) === key) {
          emittedRem.add(p);
          out.push({ t: "rem", s: p });
        }
      }
    }
    if (line.startsWith("#")) {
      out.push({ t: "comment", s: line });
    } else if (prevSet.has(line)) {
      out.push({ t: "ctx", s: line });
    } else {
      out.push({ t: "add", s: line });
    }
  }
  // Trailing prev-only lines with no matching key in next (pure removals).
  for (const p of prevLines) {
    if (!nextSet.has(p) && !emittedRem.has(p) && p.trim() !== "" && !p.startsWith("#")) {
      out.push({ t: "rem", s: p });
    }
  }
  return out;
}

function leadingKey(line: string): string | undefined {
  const match = /^\s*([A-Za-z0-9_.]+)\s*=/u.exec(line);
  return match?.[1];
}

// --------------------------------------------------------------------------
// GitHub seam (injectable / mockable)
// --------------------------------------------------------------------------

export interface GateConfigPullRequest {
  number: number;
  url: string;
  branch: string;
}

/**
 * The minimal GitHub surface the gate needs, expressed as one injectable port
 * so tests pass a fake (no network). A real adapter wraps the App
 * client + `GitHubPullRequestService` / `GitHubReviewMergeService`.
 */
export interface ConfigGateGitHub {
  /**
   * Commit `yaml` to `configFile` on a fresh `<branchPrefix>/<slug>` branch off
   * `baseBranch`, then open (or reuse) a PR titled `title`. Returns the PR ref.
   */
  openConfigPr(input: {
    repo: string;
    baseBranch: string;
    headBranch: string;
    configFile: string;
    yaml: string;
    title: string;
    body: string;
  }): Promise<GateConfigPullRequest>;
}

export function buildConfigPrTitle(_prev: OrgConfigV1, _next: OrgConfigV1): string {
  // Routing is the only Bucket-B (gated) config now that the escape-hatch limits are gone.
  return "config: update role routing";
}

/** Slugify a head-branch suffix from the change (stable, lowercase, ascii). */
function changeSlug(_prev: OrgConfigV1, _next: OrgConfigV1): string {
  return `route-${Date.now().toString(36)}`;
}

// --------------------------------------------------------------------------
// Gated write
// --------------------------------------------------------------------------

export interface GatedConfigWriteInput {
  /** Current persisted org config. */
  prev: OrgConfigV1;
  /** The requested next config (the Bucket-B write). */
  next: OrgConfigV1;
  /** The gate target; required when the gate is ON. */
  target?: OrgAuditGateTarget;
  /** Injectable GitHub port; required when the gate is ON. */
  github?: ConfigGateGitHub;
}

export type GatedConfigWriteResult =
  | {
      /** Gate OFF or a non-Bucket-B write: caller applies `next` to the DB now. */
      kind: "apply-directly";
      config: OrgConfigV1;
    }
  | {
      /** Gate ON + Bucket-B write: a PR was opened; the DB is NOT mutated yet. */
      kind: "gated";
      pr: GateConfigPullRequest;
      diff: ConfigYamlDiffLine[];
    };

/**
 * The single decision point the org-config PATCH route calls. When the gate is
 * OFF (or the write is not Bucket-B), it returns `apply-directly` and the caller
 * persists `next`. When the gate is ON and the write IS Bucket-B, it renders the
 * `tanren.yaml` diff and opens a PR via the injected GitHub port, returning
 * `gated` WITHOUT touching the DB (apply-on-merge takes over later).
 */
export async function gatedConfigWrite(input: GatedConfigWriteInput): Promise<GatedConfigWriteResult> {
  const gateOn = input.next.auditGateEnabled;
  if (!gateOn || !isBucketBChange(input.prev, input.next)) {
    return { kind: "apply-directly", config: input.next };
  }
  if (input.target === undefined || input.github === undefined) {
    throw new Error("audit gate is enabled but no tanren-config target/client is configured");
  }
  const diff = renderTanrenYamlDiff(input.prev, input.next);
  const headBranch = `${input.target.branchPrefix}/${changeSlug(input.prev, input.next)}`;
  const pr = await input.github.openConfigPr({
    repo: input.target.repo,
    baseBranch: input.target.baseBranch,
    headBranch,
    configFile: input.target.configFile,
    yaml: renderTanrenYaml(input.next),
    title: buildConfigPrTitle(input.prev, input.next),
    body: configPrBody(diff),
  });
  return { kind: "gated", pr, diff };
}

function configPrBody(diff: ConfigYamlDiffLine[]): string {
  const added = diff.filter((l) => l.t === "add").length;
  const removed = diff.filter((l) => l.t === "rem").length;
  return [
    "Proposed by tanren · forge (audit gate).",
    "",
    `${added} added · ${removed} removed.`,
    "",
    "Merging applies the routing change to every new run.",
  ].join("\n");
}

// --------------------------------------------------------------------------
// Apply-on-merge
// --------------------------------------------------------------------------

/**
 * Apply a merged config PR's content to the DB. The orchestrator's
 * config-PR-merge webhook handler resolves the org's staged `next` config (the
 * one the PR proposed) and calls this to persist it as the new source of truth.
 * Returns `false` (no-op) when the gate is OFF for the org, so a stray merge
 * never silently rewrites config the operator chose to manage in-dashboard.
 */
export async function applyOnMerge(input: {
  current: OrgConfigV1;
  merged: OrgConfigV1;
  persist: (config: OrgConfigV1) => Promise<void>;
}): Promise<boolean> {
  if (!input.current.auditGateEnabled) {
    return false;
  }
  await input.persist(input.merged);
  return true;
}
