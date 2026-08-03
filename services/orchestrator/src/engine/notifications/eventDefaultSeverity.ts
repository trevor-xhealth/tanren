import { listEventNames, type EventName } from "../events/index.js";
import type { Severity } from "./schemas.js";
import { missionCompleteSeverityOverrides } from "./eventDefaultSeverity.missionComplete.js";

// Map every event name in the registry to a default severity. The matrix UI
// consumes this map to render the event row's default level; the dispatcher
// consults it at fire time to decide whether a route's minSeverity floor is met.
//
// Severity taxonomy:
//   ok    - happy-path completion that an operator wants to celebrate
//           (run.completed, github.pr.merged, review.approved).
//   info  - normal-flight progress that some operators want, most don't
//           (lifecycle started/queued, subtask progress, the per-tier native
//           gate results gate.passed/gate.failed, redaction audit).
//   warn  - degraded but recoverable (task.failed, checker rejection, github
//           failures, planner re-request) — usually surfaces in dashboards
//           regardless of opt-in.
//   fail  - run-halting / lost-work signals (run.failed, cost.unattributed,
//           task.failed). The persisted run status may be `halted` while the
//           terminal event is `run.failed`; reachable on every pager channel.
//
// A few events are not operator-actionable (allocator internals,
// notification.* meta-events) and stay at `info` so the matrix UI defaults
// the rows off without forcing the operator to discover them.

const SEVERITY_OVERRIDES: Partial<Record<EventName, Severity>> = {
  ...missionCompleteSeverityOverrides,
  "delivery.degraded": "warn",
  "delivery.completed": "info",
  "delivery.demo_stimulus_started": "info",
  // Run lifecycle
  "run.queued": "info",
  "run.started": "info",
  "run.completed": "ok",
  "run.failed": "fail",

  // Task lifecycle
  "task.queued": "info",
  "task.started": "info",
  "task.completed": "info",
  "task.failed": "warn",

  // Planner
  "planner.started": "info",
  "planner.completed": "info",
  "planner.failed": "warn",
  "planner.subtasks.emitted": "info",

  // Writer
  "writer.started": "info",
  "writer.completed": "info",
  "writer.failed": "warn",
  "writer.subtask.started": "info",
  "writer.subtask.completed": "info",
  "writer.subtask.failed": "warn",

  // Checker
  "checker.started": "info",
  "checker.completed": "info",
  "checker.failed": "warn",
  // dispatcher promotes to warn when passed=false
  "checker.verdict": "info",

  // Auditor
  "auditor.started": "info",
  "auditor.completed": "info",
  "auditor.failed": "warn",
  // dispatcher promotes to warn when passed=false
  "auditor.verdict": "info",

  // Native gate (in-loop, per-tier, exit-code driven). These fire on EVERY tier
  // evaluation of EVERY writer iteration — routine trajectory noise, NOT per-event
  // operator signals — so they stay at `info` (the matrix row defaults off; an
  // operator debugging a run can opt in). The operator-actionable failure signals
  // surface elsewhere at their own severity: `task.failed`/`*.failed` (warn),
  // `run.failed` (fail), `dag.spec.needs_attention` (fail). `gate.verdict` is the
  // informational per-run pass/fail roll-up — there is NO dispatcher promotion for
  // any gate event (see effectiveSeverityFor); the terminal `run.*` carries the loud
  // signal. Listed explicitly (rather than left to the `?? "info"` fallback) so the
  // intent is visible and the matrix UI is honest.
  "gate.started": "info",
  "gate.passed": "info",
  "gate.failed": "info",
  "gate.advisory_failed": "info",
  "gate.quarantine_excluded": "info",
  "gate.publish_failed": "info",
  "gate.verdict": "info",

  // Runner / allocator
  "runner.allocated": "info",
  "runner.released": "info",
  // A swept runner is a LEAK the normal release path missed (a crashed run, a
  // past-TTL runner, a wedged allocation) — operator-actionable, so warn.
  "runner.swept": "warn",
  // Security-baseline cleanup-proof: a release normally cleans up (info). The
  // dispatcher promotes to warn when `cleanedUp=false` (residual resources to
  // reconcile) — a leaked runner is operator-actionable.
  "release.finalized": "info",
  "runner.failed": "warn",
  "allocator.requested": "info",
  "allocator.allocated": "info",
  "allocator.failed": "warn",

  // Workspace
  "workspace.prepared": "info",
  "workspace.git_captured": "info",
  "workspace.failed": "warn",
  // apex v35: prep deps-install failed but was deferred to the gate self-heal (not a
  // strand). Warn — loud enough to surface on the timeline, not a terminal failure.
  "workspace.bootstrap_deferred": "warn",

  // Credentials
  "credential.requested": "info",
  "credential.loaded": "info",
  "credential.failed": "warn",

  // Cost
  "cost.resolved": "info",
  "cost.failed": "warn",
  // An unrecognized credential ref priced a real call as $0 — a budget-defeating
  // misconfig the operator must fix; surfaced as fail.
  "cost.unattributed": "fail",
  // A configured dollar ceiling can never fire against this credential — the run
  // fails closed; a setup-time misconfig the operator must fix; fail.
  "cost.ceiling_unreachable": "fail",
  // Symmetric to the above: the ceiling fires PERMANENTLY and unclearably over this
  // route (per_token + no real-spend capture), so the run is refused at setup rather
  // than deadlocking mid-flight — a setup-time misconfig the operator must fix; fail.
  "cost.ceiling_unenforceable": "fail",
  // The route can produce no per-call real-spend fact (every cost_usd will be NULL).
  // NOT a failure — the run proceeds and token/notional accounting still work — but a
  // standing limitation the operator must see; warn. Same for a route judged METERABLE
  // whose harness then surfaced no generation id (drift reverting spend to NULL); warn.
  "cost.route_unmeterable": "warn",
  "cost.generation_id_missing": "warn",
  // silent-fallback hardening. A managed OpenRouter per-call real-cost capture
  // failed — authoritative platform spend that would otherwise silently vanish;
  // fail. A run-end reconcile resolved a positive real total that landed on no
  // row — observed real spend lost; fail. A model is unpriced in the notional
  // source — list-value tracking silently drops; operator-actionable drift; warn.
  "cost.provider_capture_failed": "fail",
  "cost.reconcile_failed": "fail",
  "cost.notional_unpriced": "warn",

  // Usage probe reads (silent-fallback hardening). A read FAILED (timeout / SSH /
  // nonzero-exit / malformed) — it erases usage/window-pressure/reconcile, so it
  // is `fail` (NEVER a silent no-data run). A real CLI call missing token telemetry
  // is mandatory-accounting drift the operator must fix; warn.
  "usage.read_failed": "fail",
  "usage.token_accounting_failed": "warn",
  // Codex critic #18: the RUN-END mandatory accounting seam THREW — a hard
  // mandatory-accounting invariant violation the operator MUST see; `fail` so it
  // clears the default-route floor and reaches the org's channels even without a
  // per-event route (the terminal-outcome demotion pairs with the fail-tier event).
  "usage.accounting_failed": "fail",

  // GitHub integration
  "github.branch.pushed": "info",
  "github.pr.created": "ok",
  "github.pr.ready": "ok",
  "github.pr.merged": "ok",
  "github.failed": "warn",

  // Post-merge auto-issue creation (tempering.md dim A): a post-merge regression
  // on default_branch is a real change-failure (fail); auto-opening its tracking
  // issue is an operator-actionable signal (warn).
  "merge.post_merge_failed": "fail",
  "issue.opened": "warn",

  // DAG escalation: a spec parked at the terminal `needs_attention` status — the
  // strand reconciler exhausted its bounded re-enqueue budget, OR the
  // intent-preserving conflict resolver judged the conflict genuinely
  // irreconcilable. This is a RARE, GENUINE "a human must look" signal (the
  // human-escalation-discipline contract), so it is `fail`: it must clear the
  // matrix's warn floor AND the code-level default route so the escalation
  // actually reaches a person rather than silently parking.
  "dag.spec.needs_attention": "fail",

  // Operator cancel-spec/cancel-run: a DELIBERATE human action (the operator chose to
  // cancel), not a failure — `info` so the matrix rows default off but the records stay
  // auditable. Mirrors the operator-initiated recovery lineage above. (The dependents a
  // cancel parks each emit their OWN `dag.spec.needs_attention` at `fail`, so the human
  // decision the cascade-block raises still reaches the operator.)
  "spec.cancelled": "info",
  "run.cancelled": "info",

  // A corrupt persisted project config the walker read while resolving a NON-merge
  // eagerness knob (it proceeded at the safe default, but the corruption is real and
  // operator-fixable) → `warn`: surfaced rather than silently parked at `info`.
  "dag.config.corrupt": "warn",

  // The GENUINE dollar-budget pause: cumulative spend reached the configured
  // ceiling and the DagWalker stopped enqueuing. This is operator-ACTIONABLE — the
  // run halted and the operator must decide (raise the ceiling, or accept the
  // stop) — so it is `warn`: it clears the matrix warn floor AND the code-level
  // default route, reaching the operator rather than silently parking at `info`.
  "dag.budget.paused": "warn",

  // A budget FRACTION milestone (50% / 80% of the ceiling crossed BEFORE the terminal
  // pause): the "approaching your money ceiling" heads-up a human wants DURING an
  // autonomous run. It is a milestone the human ACTS on (decide whether to raise the
  // ceiling before the run pauses), so it is `warn`: it clears the default route and
  // reaches the org's channels WITHOUT per-event route config — the milestone-
  // notifications chain. Emitted once per band per budget window (no re-walk spam).
  "dag.budget.milestone": "warn",

  // A deploy that triggered but could NOT be proven live after the bounded verify
  // retry. Operator-actionable (the product never came up) → `warn` so the failure
  // reaches the operator rather than a silent triggered-but-unverified stall.
  "deploy.failed": "warn",

  // A single-instance app's stale-machine reap did not fully converge (a list/delete
  // blip left prior machines behind → accumulation risk → the apex-v96 file-store
  // fragmentation class). Operator-actionable (an INFRA blip, not product code) →
  // `warn` so it reaches the operator + is attributable to infra. The deploy itself
  // still succeeded; the durable reconciler sweep retries next pass.
  "deploy.reap_failed": "warn",

  // A deploy that was EXPECTED could not even be RESOLVED on merge (incomplete deploy
  // config / a missing mergeSha) — a PRE-resolution skip that previously was console-only.
  // Operator-actionable (the merge produced no deploy) → `warn` so it reaches the operator.
  "deploy.skipped": "warn",

  // deploy.verified ("a live working URL is up"): the single highest-signal SUCCESS
  // milestone of an autonomous run — the product is provably reachable. This is the
  // milestone a human most wants pushed DURING a run, so it routes BY DEFAULT (`warn`,
  // not the routine `info`): it clears the default-route floor and reaches the org's
  // channels without per-event route config — the milestone-notifications chain.
  // (deploy.triggered stays `info`: routine lifecycle, not the proven-live milestone.)
  "deploy.verified": "warn",

  // deploy.pending_manual ("please confirm the deploy"): the OPERATOR is the required
  // next actor — a manual_external deploy is stuck without them. Operator-actionable →
  // `warn` so the wake reaches the operator's default route rather than a silent info
  // lifecycle entry.
  "deploy.pending_manual": "warn",
  // deploy.manual_confirmed: audit-trail lifecycle entry (the operator acted); the
  // downstream verify emits `deploy.verified` (`warn`) as the proven-live milestone.
  "deploy.manual_confirmed": "info",

  // demo.evidence.recorded ("a behavior was exercised on the live surface"): routine
  // per-behavior verdict lifecycle — the summary (demo.completed) carries the pass/fail
  // tally the operator acts on, so keep the per-behavior grain at `info` (no matrix spam).
  "demo.evidence.recorded": "info",
  // demo.completed ("the demo finished"): routine `info` summary when every behavior
  // passed. The dispatcher promotes to `warn` when `failed > 0` (the "deploy verified
  // but a planted issue makes behaviors fail" signal) so the fail-tier summary reaches
  // the operator via the default route, even without a per-event route configured.
  "demo.completed": "info",
  // demo.failed ("the demo could NOT record its evidence"): the operator-actionable
  // signal that a verified deploy could not be demoed (grant lost mid-flight, an
  // unsupported surface kind, a provider read failure). Mirrors `deploy.failed` at
  // `warn` so it clears the default-route floor and reaches the operator rather than
  // a subscriber-swallowed `log.error`.
  "demo.failed": "warn",

  // Review
  "review.requested": "info",
  "review.approved": "ok",
  "review.auto_approved": "ok",
  "review.changes_requested": "warn",

  // Mission-complete W0 event vocabulary. These are routine durable facts except
  // for a member-local policy block, which is operator-actionable.
  "integration.requirement.validated": "info",
  "behavior.coverage.selection_analyzed": "info",
  "governance.audit_posture.updated": "info",
  "review.simulated_intent": "info",
  "merge.signal.classified": "info",
  "merge.member.policy_blocked": "warn",

  // Mission-complete W1-A integration.author.* (IN-7 lifecycle facts). Same
  // ok/info/ok/fail pattern as fragment.authoring.* but a different namespace
  // and payload — never an alias. Explicit overrides: default fallback is info.
  "integration.author.started": "ok",
  "integration.author.attempt": "info",
  "integration.author.succeeded": "ok",
  "integration.author.failed": "fail",

  // Wave-3 barrier vocabulary. `fail` is Tanren's terminal error severity.
  "symptom.contract.authored": "info",
  "symptom.contract.validated": "info",
  "symptom.contract.superseded": "info",
  "symptom.contract.authoring_failed": "fail",
  "merge.member.isolated": "warn",
  "merge.partition.leased": "info",
  "merge.partition.released": "info",
  "merge.repair.routed": "warn",
  "merge.member.respec_routed": "warn",

  // Notification meta — opted off by default; severity floor will mask them
  // even on routes that accidentally enable them, since the dispatcher does
  // not re-emit notification.* into its own pipeline.
  "notification.enqueued": "info",
  "notification.sent": "info",
  "notification.failed": "warn",

  // Hello
  "hello.started": "info",
  "hello.ssh_started": "info",
  "hello.ssh_completed": "info",
  "hello.completed": "ok",

  // Redaction audit — info, never raised, but auditable surface.
  "redaction.raw_access": "info",

  // recovery lineage — operator-initiated recovery progress; info so
  // the matrix rows default off but the records stay auditable.
  "recovery.revise_routed": "info",
  "recovery.replan_queued": "info",
  "recovery.rollback_queued": "info",
  "recovery.inspection_opened": "info",

  // Tanren-method benchmark accept tier — passing the hidden oracle is a happy
  // path (ok); failing it is a real post-merge change-failure that an operator
  // running an experiment wants surfaced (warn).
  "benchmark.accept.passed": "ok",
  "benchmark.accept.failed": "warn",

  // Per-fragment authoring (F2 — docs/roadmap/templating-system.md). started +
  // succeeded are routine `ok`; a failed authoring run is a LOUD terminal signal
  // (the derive halts) → `fail`, so it clears the matrix warn floor and the
  // code-level default route, reaching the operator. attempt is per-iteration
  // trajectory noise (writer body + rejection + decision) — `info` so the matrix
  // row defaults off, but an operator debugging a stuck writer can opt in.
  "fragment.authoring.started": "ok",
  "fragment.authoring.attempt": "info",
  "fragment.authoring.succeeded": "ok",
  "fragment.authoring.failed": "fail",

  // Mission-complete WAVE-1 integration lifecycle vocabulary (in-3). Routine
  // durable lifecycle facts are `info`; the operator-actionable arms — a
  // converged-but-unresolved reconcile, a provider/DB state divergence, a
  // detected drift, a consent request awaiting a human, a revocation affecting
  // dependents, a failed A3 validation, and a failed destructive teardown — are
  // `warn` so they clear the matrix floor and reach the operator.
  "integration.requirement.derived": "info",
  "integration.requirement.superseded": "info",
  "integration.reconcile.started": "info",
  "integration.reconcile.retry_scheduled": "info",
  "integration.reconcile.fixed_point": "warn",
  "integration.reconcile.state_unknown": "warn",
  "integration.resource.discovered": "info",
  "integration.resource.selected": "info",
  "integration.resource.provisioned": "info",
  "integration.resource.adopted": "info",
  "integration.binding.committed": "info",
  "integration.binding.materialized": "info",
  "integration.binding.drifted": "warn",
  "integration.grant.requested": "warn",
  "integration.grant.linked": "info",
  "integration.grant.validated": "info",
  "integration.grant.rotated": "info",
  "integration.grant.revoked": "warn",
  "integration.runtime.attached": "info",
  "integration.validation.started": "info",
  "integration.stimulus.emitted": "info",
  "integration.effect.observed": "info",
  "integration.validation.passed": "info",
  "integration.validation.failed": "warn",
  "integration.recovery.enqueued": "info",
  "integration.teardown.completed": "info",
  "integration.teardown.failed": "warn",

  // Mission-complete WAVE-1 runtime behavior-proof vocabulary (rv-25). Routine
  // compilation / verification / capture lifecycle is `info`; the arms a human
  // acts on — a rejected (needs-respec) contract, a batch behavior failure and
  // its identified culprit set, an intent respec request, a failed production
  // re-proof, and a rollback — are `warn`.
  "behavior.contract.compilation_started": "info",
  "behavior.contract.compiled": "info",
  "behavior.contract.rejected": "warn",
  "behavior.fragment.missing": "info",
  "behavior.fragment.authoring_started": "info",
  "behavior.fragment.validated": "info",
  "behavior.verification.started": "info",
  "behavior.shard.started": "info",
  "behavior.attempt.started": "info",
  "behavior.action.observed": "info",
  "behavior.assertion.observed": "info",
  "behavior.effect.observed": "info",
  "design.render.captured": "info",
  "design.render.verdict_recorded": "info",
  "behavior.verdict.recorded": "info",
  "behavior.verification.completed": "info",
  "gate.behavior_proof.bound": "info",
  "integration.proof.recorded": "info",
  "merge.batch.behavior_failed": "warn",
  "merge.batch.culprit_set_identified": "warn",
  "behavior.respec.requested": "warn",
  "post_merge.behavior.verified": "info",
  "post_merge.behavior.failed": "warn",
  "deployment.promoted": "info",
  "deployment.rolled_back": "warn",

  // Mission-complete WAVE-4 shared vocabulary (bh-5/bh-7/mq-5/gv-8).
  "symptom.baseline.started": "info",
  "symptom.baseline.observed": "info",
  "symptom.assertion.recorded": "info",
  "source.finding.recorded": "info",
  "source.sync.pending": "info",
  "source.sync.verified": "info",
  "source.sync.externally_closed_unverified": "warn",
  "merge.group.formed": "info",
  "merge.land_group.completed": "info",
  "merge.land_group.delivery.completed": "ok",
  "merge.land_group.delivery.failed": "warn",
  "merge.train.artifact.sealed": "ok",
  "governance.tier.created": "info",
  "governance.tier.activated": "info",

  // Mission-complete WAVE-5 shared vocabulary (mq-11/gv-9/ds-2/in-4).
  "governance.binding.activated": "info",
  "governance.effective_policy.recorded": "info",
  "governance.binding.superseded": "info",
  "integration.node.materialized": "info",
  "integration.node.materialization_failed": "warn",
  "design.artifact.published": "info",
  "design.catalog.built": "info",
  "design.export.produced": "info",

  // Mission-complete WAVE-6 shared vocabulary (mq-6/rv-7/rv-8/gv-11).
  "fixture.lease.acquired": "info",
  "fixture.lease.released": "info",
  "fixture.lease.expired": "warn",
  "fixture.lease.cleanup_failed": "warn",
  "behavior.effect.missing": "warn",
  "behavior.effect.duplicate": "warn",
  "observer.watermark.advanced": "info",
  "observer.inconclusive_external": "warn",
  "integration.proof_unit.recorded": "info",
  "integration.proof_unit.reused": "info",
  "integration.proof_root.composed": "info",
  "repository.visibility.observed": "info",
  "repository.visibility.mismatch": "warn",
  "governance.visibility.enforced": "info",

  // Back-half self-healing cluster shared vocabulary (bh-6a/8/10/6b/11/12/13/14).
  "issue_loop.opened": "info",
  "issue_loop.source_revision_observed": "info",
  "issue_loop.reopened": "warn",
  "issue_loop.verified": "info",
  "triage.started": "info",
  "triage.completed": "info",
  "spec.origin.linked": "info",
  "remediation.attempt.started": "info",
  "remediation.repair_routed": "warn",
  "deployment.artifact.bound": "info",
  "symptom.verification.started": "info",
  "symptom.verification.passed": "info",
  "symptom.verification.failed": "warn",
  "symptom.verification.inconclusive": "warn",
  "symptom.soak.completed": "info",
  "resolution.authorized": "info",
  "resolution.blocked": "warn",
  "resolution.needs_attention": "warn",
  "resolution.waived": "warn",
  "source_issue.sync.enqueued": "info",
  "source_issue.sync.succeeded": "info",
  "source_issue.sync.failed": "warn",
  "source_issue.sync.drifted": "warn",
  "resolution.proof.sealed": "info",

  // ds-0 design-system vocabulary (§7). Trajectory/progress + digests are `info`;
  // the loud operator-actionable failures are `warn` (F2D authoring failure and a
  // queue regression bisected to a culprit release).
  "designSystem.curation.started": "info",
  "designSystem.base.composed": "info",
  "designSystem.fragment.missing": "info",
  "designFragment.authoring.started": "info",
  "designFragment.authoring.attempt": "info",
  "designFragment.authoring.succeeded": "info",
  "designFragment.authoring.failed": "warn",
  "designSystem.candidate.composed": "info",
  "designSystem.artifact.validated": "info",
  "designRender.scenario.recorded": "info",
  "designSystem.release.published": "info",
  "designSystem.proof.reused": "info",
  "designSystem.regression.bisected": "warn",
  "designSystem.binding.updated": "info",
  "project.activation.readiness_blocked": "warn",
};

// Sealed: every EventName must have a default severity. Missing keys would
// be a silent `info` fallback — the test suite forbids that to keep the
// matrix UI honest.
export const eventDefaultSeverity: Record<EventName, Severity> = freezeDefaults();

function freezeDefaults(): Record<EventName, Severity> {
  const result = {} as Record<EventName, Severity>;
  for (const name of listEventNames()) {
    const override = SEVERITY_OVERRIDES[name];
    result[name] = override ?? "info";
  }
  return result;
}

export function defaultSeverityFor(eventName: EventName): Severity {
  return eventDefaultSeverity[eventName];
}
