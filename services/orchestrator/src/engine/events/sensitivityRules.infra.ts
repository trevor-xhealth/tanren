import type { SensitivityRule } from "./sensitivity.js";
import { costSensitivityRules } from "./sensitivityRules.cost.js";
import { auditBaselineSensitivityRules, auditEnvelopeRulesFor } from "./sensitivityRules.audit.js";
import { infraTerminalSensitivityRules } from "./sensitivityRules.infraTerminal.js";

const reviewTerminalRules: ReadonlyArray<[string, SensitivityRule["tag"]]> = [
  ["prUrl", "public"],
  ["prNumber", "public"],
  ["reviewer", "public"],
  ["reviewerPrincipal.kind", "public"],
  ["reviewerPrincipal.name", "public"],
  ["forgeReviewId", "public"],
  ["forgeReviewState", "public"],
  ["forgeReviewUrl", "public"],
  ["headSha", "public"],
];

export const infraSensitivityRules: SensitivityRule[] = [
  // runner allocation
  ...rulesFor("allocator.requested", [
    ["allocator", "public"],
    ["runnerImage", "public"],
    ["identitySecretRef", "redacted"],
  ]),
  ...rulesFor("allocator.allocated", [
    ["runnerId", "public"],
    ["imageSha", "public"],
    ["target.host", "redacted"],
    ["target.port", "redacted"],
    ["target.username", "public"],
    ["target.hostKeyFingerprint", "redacted"],
  ]),
  ...rulesFor("allocator.failed", [["message", "public"]]),
  ...rulesFor("runner.allocated", [
    ["runnerId", "public"],
    ["imageSha", "public"],
    ["target.host", "redacted"],
    ["target.port", "redacted"],
    ["target.username", "public"],
    ["target.hostKeyFingerprint", "redacted"],
  ]),
  ...rulesFor("runner.released", [["runnerId", "public"]]),
  // Sweeper reclaim proof: runner id + (nullable) run id + reason are NON-SECRET handles / a fixed enum.
  ...rulesFor("runner.swept", [
    ["runnerId", "public"],
    ["runId", "public"],
    ["reason", "public"],
  ]),
  // Security-baseline cleanup-proof + deploy.triggered artifact ref (audit-baseline rules), all public.
  ...auditBaselineSensitivityRules,
  ...rulesFor("runner.failed", [
    ["runnerId", "public"],
    ["command", "redacted"],
    ["result.exitCode", "public"],
    ["result.stdout", "secret"],
    ["result.stderr", "secret"],
    ["result.timedOut", "public"],
    ["result.signal", "public"],
    ["result.failure", "redacted"],
    ["result.failure.reason", "redacted"],
    ["result.failure.message", "redacted"],
  ]),
  // workspace (workspace.failed.message → see audit in sensitivityRules.ts)
  ...rulesFor("workspace.prepared", [
    ["runnerId", "public"],
    ["workspacePath", "public"],
    ["repoUrl", "public"],
    ["targetBranch", "public"],
    // A tool name, a version and the repo-relative file that declared it. All committed,
    // non-secret bytes — and the whole point of recording them is that an operator (and
    // an auditor) can read them.
    ["toolchain[].tool", "public"],
    ["toolchain[].declared", "public"],
    ["toolchain[].resolved", "public"],
    ["toolchain[].declaredIn", "public"],
    ["toolchain[].versionDeclared", "public"],
  ]),
  ...rulesFor("workspace.git_captured", [
    ["workspacePath", "public"],
    ["commits[].sha", "public"],
    ["commits[].message", "public"],
    ["diffBytes", "public"],
  ]),
  ...rulesFor("workspace.failed", [
    ["runnerId", "public"],
    ["workspacePath", "public"],
    ["message", "public"],
  ]),
  // apex v35: prep `just bootstrap` deps-install deferred to the gate self-heal (outputTail secret).
  ...rulesFor("workspace.bootstrap_deferred", [
    ["runnerId", "public"],
    ["workspacePath", "public"],
    ["command", "public"],
    ["exitCode", "public"],
    ["timedOut", "public"],
    ["outputTail", "secret"],
  ]),
  // credentials — refs are redacted; raw value never appears in payloads
  ...rulesFor("credential.requested", [
    ["credentialKind", "public"],
    ["ref", "redacted"],
    ["redacted", "public"],
  ]),
  ...rulesFor("credential.loaded", [
    ["credentialKind", "public"],
    ["ref", "redacted"],
    ["redacted", "public"],
  ]),
  ...rulesFor("credential.failed", [
    ["ref", "redacted"],
    ["message", "public"],
  ]),
  ...rulesFor("credential.configured", [
    ["provider", "public"],
    ["credentialKind", "public"],
    ["ref", "redacted"],
    ["redacted", "public"],
  ]),
  ...rulesFor("credential.github.configured", [
    ["mode", "public"],
    ["credentialKind", "public"],
    ["ref", "redacted"],
    ["redacted", "public"],
  ]),
  // per-run scoped Vault token mint: ref paths embed the tenant (redacted); policy name + bounds public; the token value is NEVER in the payload.
  ...rulesFor("credential.scoped_token_minted", [
    ["policyName", "public"],
    ["refPaths[]", "redacted"],
    ["writableRefPaths[]", "redacted"],
    ["ttlSeconds", "public"],
    ["numUses", "public"],
  ]),
  // cost / cost-safety — extracted to ./sensitivityRules.cost.ts (500-line cap).
  ...costSensitivityRules,

  // usage monitoring — telemetry (window %, token counts) + silent-fallback-hardening loud-failure events; all fields public (no secret values).
  ...rulesFor("usage.window.observed", [
    ["provider", "public"],
    ["windows[].slot", "public"],
    ["windows[].usedPercent", "public"],
    ["windows[].resetsAt", "public"],
    ["windows[].windowMinutes", "public"],
    ["windows[].resetDescription", "public"],
    ["creditsRemaining", "public"],
    ["source", "public"],
    ["capturedAt", "public"],
  ]),
  ...rulesFor("usage.window.pressure", [
    ["provider", "public"],
    ["slot", "public"],
    ["usedPercent", "public"],
    ["resetsAt", "public"],
  ]),
  ...rulesFor("usage.accounting.observed", [
    ["cli", "public"],
    ["totals.inputTokens", "public"],
    ["totals.cachedInputTokens", "public"],
    ["totals.cacheCreationTokens", "public"],
    ["totals.outputTokens", "public"],
    ["totals.reasoningOutputTokens", "public"],
    ["totals.totalTokens", "public"],
    ["costUsd", "public"],
    ["capturedAt", "public"],
  ]),
  ...rulesFor("usage.read_failed", [
    ["tool", "public"],
    ["target", "public"],
    ["reason", "public"],
    ["exitCode", "public"],
    ["detail", "public"],
    ["reasonText", "public"],
  ]),
  ...rulesFor("usage.token_accounting_failed", [
    ["role", "public"],
    ["cli", "public"],
    ["model", "public"],
    ["reason", "public"],
  ]),
  // github
  ...rulesFor("github.branch.pushed", [
    ["repoUrl", "public"],
    ["branch", "public"],
    ["credentialRef", "redacted"],
    ["redacted", "public"],
  ]),
  ...rulesFor("github.pr.created", [
    ["repoUrl", "public"],
    ["branch", "public"],
    ["targetBranch", "public"],
    ["prUrl", "public"],
    ["prNumber", "public"],
  ]),
  ...rulesFor("github.pr.ready", [
    ["prUrl", "public"],
    ["prNumber", "public"],
  ]),
  ...rulesFor("github.pr.merged", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["mergeSha", "public"],
  ]),
  ...rulesFor("github.failed", [
    ["operation", "public"],
    ["branch", "public"],
    ["message", "public"],
  ]),
  ...rulesFor("github.pr.no_commits", [
    ["branch", "public"],
    ["targetBranch", "public"],
    ["disposition", "public"],
  ]),

  // Flaky detection + quarantine rules live in sensitivityRules.ciIntel.ts (500-line cap). reviews:
  ...rulesFor("review.requested", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["reviewers", "public"],
    ["reviewers[]", "public"],
  ]),
  ...rulesFor("review.approved", reviewTerminalRules),
  ...rulesFor("review.auto_approved", [
    ["prUrl", "public"],
    ["prNumber", "public"],
  ]),
  ...rulesFor("review.changes_requested", [...reviewTerminalRules, ["message", "public"]]),
  // merge stage — PR identifiers + integration mode + prose, all public. `merge.scheduled` (v67/v69) shares the merge.queued shape.
  ...["merge.scheduled", "merge.queued"].flatMap((n) =>
    rulesFor(n, [
      ["prUrl", "public"],
      ["prNumber", "public"],
      ["integration", "public"],
    ]),
  ),
  ...rulesFor("merge.completed", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["mergeSha", "public"],
  ]),
  // AUDIT ENVELOPE on the terminal merge: policy version + initiating + approving actor, all public.
  ...auditEnvelopeRulesFor("merge.completed"),
  // (§2d) native merge queue — PR identifiers + spec id + queue stats + prose, all public.
  ...rulesFor("merge.queue.advanced", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["specId", "public"],
    ["queueDepth", "public"],
  ]),
  ...rulesFor("merge.dequeued", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["specId", "public"],
    ["reason", "public"],
    ["message", "public"],
  ]),
  // GitHub-5xx resilience (GAP #2d): the per-PR coordinator's loud infra-halt — PR identity + halt kind + attempts + message, all public.
  ...rulesFor("merge.queue.infra_blocked", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["specId", "public"],
    ["kind", "public"],
    ["attempts", "public"],
    ["message", "public"],
  ]),
  // (§2d) speculative batch-check + bisect — batch composition + cap/ceiling stats + ref + prose, all public.
  ...rulesFor("merge.batch.checking", [
    ["integration", "public"],
    ["members[].specId", "public"],
    ["members[].prNumber", "public"],
    ["eligibleCount", "public"],
    ["capped", "public"],
    ["maxBatchSize", "public"],
  ]),
  ...rulesFor("merge.batch.passed", [
    ["integration", "public"],
    ["members[].specId", "public"],
    ["members[].prNumber", "public"],
    ["integrationBranch", "public"],
  ]),
  ...rulesFor("merge.batch.bisecting", [
    ["integration", "public"],
    ["members[].specId", "public"],
    ["members[].prNumber", "public"],
    ["message", "public"],
  ]),
  ...rulesFor("merge.batch.gate_rework_routed", [
    ["integration", "public"],
    ["specId", "public"],
    ["runId", "public"],
    ["prNumber", "public"],
    ["disposition", "public"],
    ["gateError", "public"],
    ["priorReworks", "public"],
  ]),
  ...rulesFor("merge.regate.gate_rework_routed", [
    ["integration", "public"],
    ["specId", "public"],
    ["runId", "public"],
    ["prNumber", "public"],
    ["disposition", "public"],
    ["gateError", "public"],
    ["priorReworks", "public"],
  ]),
  ...rulesFor("merge.batch.infra_blocked", [
    ["integration", "public"],
    ["members[].specId", "public"],
    ["members[].prNumber", "public"],
    ["message", "public"],
    ["attempts", "public"],
    ["terminal", "public"],
    ["consecutiveHolds", "public"],
    ["kind", "public"],
  ]),
  ...rulesFor("merge.failed", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["message", "public"],
  ]),
  ...rulesFor("merge.conflict", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["baseBranch", "public"],
    ["headBranch", "public"],
    ["message", "public"],
  ]),
  // up-to-date enforcement (behind / rebased / not-yet-terminal re-gate) — PR ids + refs + signal, public.
  ...rulesFor("merge.behind", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["baseBranch", "public"],
    ["headBranch", "public"],
    ["mergeableState", "public"],
  ]),
  ...rulesFor("merge.rebased", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["baseBranch", "public"],
    ["headBranch", "public"],
    ["reGatedCi", "public"],
  ]),
  ...rulesFor("merge.regate_pending", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["message", "public"],
  ]),
  ...rulesFor("merge.speculative_held", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["speculativeBase", "public"],
    ["unmergedAncestors[]", "public"],
  ]),
  ...rulesFor("merge.retargeted", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["fromBase", "public"],
    ["toBase", "public"],
  ]),
  ...rulesFor("merge.conflict.resolving", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["baseBranch", "public"],
    ["mergingSpecId", "public"],
    ["conflictingSpecId", "public"],
    ["dagEdge", "public"],
    ["conflictedFiles", "public"],
    ["conflictedFiles[]", "public"],
  ]),
  ...rulesFor("merge.conflict.resolved", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["baseBranch", "public"],
    ["mergingSpecId", "public"],
    ["conflictingSpecId", "public"],
    ["resolvedFiles", "public"],
    ["resolvedFiles[]", "public"],
    ["reGated", "public"],
  ]),
  ...rulesFor("merge.conflict.entity_merged", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["baseBranch", "public"],
    ["mergingSpecId", "public"],
    ["resolvedFiles", "public"],
    ["resolvedFiles[]", "public"],
    ["entityIds", "public"],
    ["entityIds[]", "public"],
    ["reGated", "public"],
  ]),
  ...rulesFor("merge.conflict.irreconcilable", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["baseBranch", "public"],
    ["mergingSpecId", "public"],
    ["conflictingSpecId", "public"],
    ["replanned", "public"],
    ["replannedSpecId", "public"],
    ["reason", "public"],
    ["fromFailedReGate", "public"],
  ]),
  ...rulesFor("merge.conflict.replan_routed", [
    ["specId", "public"],
    ["otherSpecId", "public"],
    ["newContext", "public"],
    ["replanStatus", "public"],
    ["conflictSignature", "public"],
  ]),
  ...rulesFor("merge.blocked", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["posture", "public"],
    ["mode", "public"],
    ["externalLogins", "public"],
    ["externalLogins[]", "public"],
    ["reason", "public"],
  ]),
  ...infraTerminalSensitivityRules,
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
