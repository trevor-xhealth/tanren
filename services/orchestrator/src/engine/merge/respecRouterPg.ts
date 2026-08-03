// mq-10 — the production AutonomousRepairRouter. Loads a member's prior repair-attempt
// history from `merge_repair_routes`, runs the PURE `decideRepairRoute` (fixed-point via the
// convergence detector), durably records the routing decision (idempotent), emits the typed
// `merge.repair.routed` (+ `merge.member.respec_routed` for a respec), and — for a respec —
// re-drives spec authoring by materializing a replacement spec through the SAME
// `createSpecOnClient` triage-provenance seam the autonomous loop already uses.
//
// The replacement INHERITS the stuck parent's `SpecMode`, read on the same client (so inside
// the same transaction) — see `materializeReplacementSpec` for why that is every arm and not
// just the brownfield one, and `loadSpecMode` for why an unreadable mode fails loud.

import { createHash } from "node:crypto";
import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { AttemptSignature } from "../workflow/convergenceDetector.js";
import { createSpecOnClient } from "../workflow/projectSpec.js";
import { SpecMode } from "../state/spec.js";
import { PgEventStore, type EventStore } from "../eventStore.js";
import { respecPacketHash, type RespecPacketV1 } from "../contracts/respecPacket.js";
import { decideRepairRoute, type RepairRoute, type RepairRouteContext } from "./repairRouteDecision.js";
import type {
  AutonomousRepairRouter,
  RouteMemberFailureInput,
  RouteMemberFailureOutcome,
} from "./autonomousRepairRouter.js";

/** The default routes: the in-place writer that keeps failing, and the DIFFERENT respec agent. */
const DEFAULT_PRIOR_AGENT_ROUTE = "writer.in_place";
const DEFAULT_NEXT_AGENT_ROUTE = "answerer.respec";

export interface PgAutonomousRepairRouterDeps {
  readonly pool: pg.Pool;
  /** The event store (defaults to a pool-backed `PgEventStore`; a test may inject a fake). */
  readonly events?: EventStore;
  /** Override the prior/next agent routes (default in-place writer → answerer respec). */
  readonly priorAgentRoute?: string;
  readonly nextAgentRoute?: string;
}

interface PriorAttemptRow {
  readonly failure_signature: string;
  readonly magnitude: number;
  readonly disposition: string;
}

export class PgAutonomousRepairRouter implements AutonomousRepairRouter {
  private readonly priorAgentRoute: string;
  private readonly nextAgentRoute: string;
  private readonly events: EventStore;

  public constructor(private readonly deps: PgAutonomousRepairRouterDeps) {
    this.priorAgentRoute = deps.priorAgentRoute ?? DEFAULT_PRIOR_AGENT_ROUTE;
    this.nextAgentRoute = deps.nextAgentRoute ?? DEFAULT_NEXT_AGENT_ROUTE;
    this.events = deps.events ?? new PgEventStore(deps.pool);
  }

  public async routeMemberFailure(input: RouteMemberFailureInput): Promise<RouteMemberFailureOutcome> {
    const orgId = await this.resolveOrgId(input.projectId);
    const actor = respecRouterActor(orgId);
    return runWithOrgScope(this.deps.pool, orgId, async (client) => {
      const prior = await loadPriorAttempts(client, orgId, input);
      const priorAttempts: ReadonlyArray<AttemptSignature> = prior.map((row) => ({
        failureSignature: row.failure_signature,
        magnitude: row.magnitude,
      }));
      const respecGeneration = prior.filter((row) => row.disposition === "respec").length + 1;

      const ctx: RepairRouteContext = {
        orgId,
        projectId: input.projectId,
        sourceSpecId: input.sourceSpecId,
        runId: input.runId,
        groupId: input.groupId,
        evaluationId: input.evaluationId,
        classification: input.classification,
        findingIds: input.findingIds,
        reasonCodes: input.reasonCodes,
        priorAgentRoute: this.priorAgentRoute,
      };
      const decision = decideRepairRoute({
        ctx,
        priorAttempts,
        respecGeneration,
        nextAgentRoute: this.nextAgentRoute,
      });

      let replacement: ReplacementSpec | undefined;
      let replacementSpecIds: ReadonlyArray<string> = [];
      let packetHash: string | undefined;
      if (decision.kind === "respec") {
        packetHash = respecPacketHash(decision.packet);
        replacement = await materializeReplacementSpec(client, decision.packet, input.runId, actor);
        replacementSpecIds = replacement.specIds;
      }

      const magnitude =
        decision.kind === "respec" ? decision.packet.fixedPoint.magnitude : magnitudeOf(decision, input);
      const newlyInserted = await insertRouteRow(client, orgId, input, decision, {
        respecGeneration,
        priorAgentRoute: this.priorAgentRoute,
        nextAgentRoute: this.nextAgentRoute,
        packetHash,
        replacementSpecIds,
        magnitude,
      });

      if (newlyInserted) {
        await this.emitRepairRouted(orgId, input, decision, magnitude);
        if (decision.kind === "respec" && packetHash !== undefined && replacement !== undefined) {
          await this.emitRespecRouted(orgId, input, decision.packet, packetHash, replacement);
        }
      }

      if (decision.kind === "respec") {
        return { kind: "respec", replacementSpecIds, packetHash: packetHash ?? "" };
      }
      if (decision.kind === "blocked_needs_attention") {
        return { kind: "blocked_needs_attention", reason: decision.reason };
      }
      return { kind: "repair_in_place" };
    });
  }

  private async resolveOrgId(projectId: string): Promise<string> {
    const orgId = await runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<{ org_id: string }>("SELECT org_id FROM projects WHERE project_id = $1", [
        projectId,
      ]);
      return result.rows[0]?.org_id;
    });
    if (orgId === undefined) throw new Error(`mq-10 repair router: unknown project ${projectId}`);
    return orgId;
  }

  private async emitRepairRouted(
    orgId: string,
    input: RouteMemberFailureInput,
    decision: RepairRoute,
    magnitude: number,
  ): Promise<void> {
    await this.events.append({
      eventType: "merge.repair.routed",
      orgId,
      projectId: input.projectId,
      ...(input.runId !== undefined && { runId: input.runId }),
      specId: input.sourceSpecId,
      payload: {
        projectId: input.projectId,
        sourceSpecId: input.sourceSpecId,
        groupId: input.groupId,
        evaluationId: input.evaluationId,
        disposition: decision.kind,
        failureClass: input.classification,
        failureSignature: decision.failureSignature,
        magnitude,
        ...(decision.kind === "blocked_needs_attention" && { blockedReason: decision.reason }),
      },
    });
  }

  private async emitRespecRouted(
    orgId: string,
    input: RouteMemberFailureInput,
    packet: RespecPacketV1,
    packetHash: string,
    replacement: ReplacementSpec,
  ): Promise<void> {
    await this.events.append({
      eventType: "merge.member.respec_routed",
      orgId,
      projectId: input.projectId,
      ...(input.runId !== undefined && { runId: input.runId }),
      specId: input.sourceSpecId,
      payload: {
        projectId: input.projectId,
        sourceSpecId: input.sourceSpecId,
        groupId: input.groupId,
        evaluationId: input.evaluationId,
        packetHash,
        priorAgentRoute: packet.priorAgentRoute,
        nextAgentRoute: packet.nextAgentRoute,
        generation: packet.generation,
        replacementSpecIds: [...replacement.specIds],
        // The AUTHORING MODE the replacement actually carries (inherited from the stuck
        // parent). On the wire because its INVISIBILITY was half the original defect: a
        // re-spec used to flip a brownfield spec back to `from_scratch` with nothing
        // surfacing the change, so the first symptom an operator saw was an enormous
        // scope-violating diff hours later, with no way to attribute it.
        specMode: replacement.mode,
      },
    });
  }
}

/** The magnitude a non-respec row records (respec uses the packet's fixed-point magnitude). */
function magnitudeOf(decision: RepairRoute, input: RouteMemberFailureInput): number {
  if (decision.kind === "repair_in_place") return decision.magnitude;
  return input.findingIds.length;
}

function respecRouterActor(orgId: string): ActorContext {
  return { userId: "mq-10-respec-router", orgId, projectId: null, scopes: ["platform:admin"], source: "local_dev" };
}

async function loadPriorAttempts(
  client: pg.PoolClient,
  orgId: string,
  input: RouteMemberFailureInput,
): Promise<ReadonlyArray<PriorAttemptRow>> {
  // Exclude THIS evaluation's own row so a re-invocation for the same failing head loads the
  // identical prior history (idempotent decision). Distinct re-authored heads carry distinct
  // evaluation ids, so genuine re-attempts still grow the history the fixed-point read scans.
  const result = await client.query<PriorAttemptRow>(
    `SELECT failure_signature, magnitude, disposition
       FROM merge_repair_routes
      WHERE org_id = $1 AND project_id = $2 AND source_spec_id = $3 AND evaluation_id <> $4
      ORDER BY created_at, route_id`,
    [orgId, input.projectId, input.sourceSpecId, input.evaluationId],
  );
  return result.rows;
}

interface RouteRowExtras {
  readonly respecGeneration: number;
  readonly priorAgentRoute: string;
  readonly nextAgentRoute: string;
  readonly packetHash: string | undefined;
  readonly replacementSpecIds: ReadonlyArray<string>;
  readonly magnitude: number;
}

async function insertRouteRow(
  client: pg.PoolClient,
  orgId: string,
  input: RouteMemberFailureInput,
  decision: RepairRoute,
  extras: RouteRowExtras,
): Promise<boolean> {
  // Deterministic id: one attempt row per (evaluation, spec) — ON CONFLICT makes a re-invocation
  // for the same head a no-op so events fire at most once.
  const routeId = `mrr_${createHash("sha256").update(`${input.evaluationId}\0${input.sourceSpecId}`).digest("hex")}`;
  const isRespec = decision.kind === "respec";
  const result = await client.query(
    `INSERT INTO merge_repair_routes
       (org_id, route_id, project_id, source_spec_id, group_id, evaluation_id, disposition, failure_class,
        failure_signature, magnitude, finding_ids, reason_codes, respec_generation,
        prior_agent_route, next_agent_route, packet_hash, replacement_spec_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::text[],$13,$14,$15,$16,$17::text[])
     ON CONFLICT (org_id, route_id) DO NOTHING
     RETURNING route_id`,
    [
      orgId,
      routeId,
      input.projectId,
      input.sourceSpecId,
      input.groupId,
      input.evaluationId,
      decision.kind,
      input.classification,
      decision.failureSignature,
      extras.magnitude,
      [...new Set(input.findingIds)].sort(),
      [...new Set(input.reasonCodes)].sort(),
      isRespec ? extras.respecGeneration : 0,
      isRespec ? extras.priorAgentRoute : null,
      isRespec ? extras.nextAgentRoute : null,
      isRespec ? (extras.packetHash ?? null) : null,
      isRespec ? [...extras.replacementSpecIds] : [],
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/** A materialized replacement spec + the authoring mode it actually carries. */
interface ReplacementSpec {
  readonly specIds: ReadonlyArray<string>;
  readonly mode: SpecMode;
}

/**
 * Read a spec's AUTHORING MODE (`SpecMode`) on the CALLER'S client — i.e. inside the caller's
 * open transaction, alongside the routing decision and the route-row insert, so the mode can
 * never be a torn read against a separate connection.
 *
 * FAILS LOUD on both unreadable cases. A missing row (the org-scoped read cannot see it) and
 * an unrecognized literal (an enum widened in one place and not another) are both "we do not
 * know what workspace this writer will open". Defaulting there is precisely the defect being
 * fixed — and precisely the shape of `driveConflictResolve`'s two-literal compare, which
 * silently degraded a third mode to `from_scratch` and mis-graded a scoped amendment with the
 * greenfield bar. Throwing rolls back the whole routing transaction: no route row, no
 * half-authored replacement, and an operator gets a diagnosable error instead of a rebuild.
 */
async function loadSpecMode(client: pg.PoolClient, projectId: string, specId: string): Promise<SpecMode> {
  const result = await client.query<{ mode: string }>("SELECT mode FROM specs WHERE project_id = $1 AND spec_id = $2", [
    projectId,
    specId,
  ]);
  const raw = result.rows[0]?.mode;
  if (raw === undefined) {
    throw new Error(
      `mq-10 respec: cannot read the authoring mode of spec ${specId} in project ${projectId} ` +
        "(no visible row) — refusing to author a replacement under a guessed mode",
    );
  }
  const parsed = SpecMode.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `mq-10 respec: spec ${specId} carries an unrecognized authoring mode ${JSON.stringify(raw)} ` +
        "— refusing to author a replacement under a guessed mode",
    );
  }
  return parsed.data;
}

/**
 * Re-drive spec authoring for a respec: materialize a replacement spec via the SAME
 * `createSpecOnClient` triage-provenance seam the autonomous loop uses (which stamps
 * `parent_spec_id`/`source_finding_ids` and wakes the DagWalker). Idempotent: a replacement for
 * the same (parent spec, finding set) is reused, never duplicated (the provenance unique index).
 *
 * AUTHORING MODE — INHERITED FROM THE PARENT, in EVERY arm. This used to be a hardcoded
 * `from_scratch`, which assumed every re-spec is greenfield. `SpecMode` does not describe the
 * spec's text, it describes THE WORKSPACE THE WRITER WILL OPEN — a blank repo
 * (`from_scratch`), a repo whose initial commit IS the composed seed (`specialize_seed`), or a
 * pre-existing authoritative repository (`modify_existing`). A re-spec targets the SAME
 * project, so it faces the SAME workspace; and `RespecPacketV1.allowedRevisions` is a closed
 * set (clarify acceptance criteria · split the spec · revise DAG dependencies) with
 * `policyWaiverForbidden`, so there is no revision a re-spec is even authorized to make that
 * could change what the workspace IS. Inheriting is therefore not a policy choice, it is
 * carrying forward a fact that did not change; hardcoding a mode was asserting a fact about
 * the tree that the router never checked.
 *
 * BLANKET, not conditional. Inheriting only `modify_existing` would have been narrower, but it
 * would encode "a greenfield re-spec is `from_scratch`" as a special case — and for a
 * `specialize_seed` parent that is the v64 root cause verbatim. That parent reached a fixed
 * point, so its specialization never merged: the composed seed is still exactly what the
 * replacement's writer opens, and `from_scratch`'s standing instruction ("Build everything
 * ELSE — the manifest/lockfile, sources, configs, tests, fixtures") is the same contradiction
 * that burned 61 non-converging writer iterations. Handing a fresh agent the instruction that
 * caused the previous non-convergence is the worst available default at exactly the worst
 * moment. If an inherited mode's scope boundary genuinely blocks the fix, the ALREADY-CORRECT
 * escape is the next fixed point routing to `blocked_needs_attention`, which reaches a human —
 * not the router autonomously widening a writer's license to rebuild the repository.
 */
async function materializeReplacementSpec(
  client: pg.PoolClient,
  packet: RespecPacketV1,
  runId: string,
  actor: ActorContext,
): Promise<ReplacementSpec> {
  const canonicalFindingIds = [...new Set(packet.fixedPoint.findingIds)].sort();
  const existing = await client.query<{ spec_id: string }>(
    `SELECT spec_id FROM specs WHERE project_id = $1 AND parent_spec_id = $2 AND source_finding_ids = $3::text[] LIMIT 1`,
    [packet.projectId, packet.sourceSpecId, canonicalFindingIds],
  );
  const existingId = existing.rows[0]?.spec_id;
  // Idempotent reuse: report the EXISTING replacement's own persisted mode, not the parent's.
  // They agree for anything this code path wrote, but a row authored before this fix (or by
  // hand) would differ, and the event must describe what a writer will actually be given.
  if (existingId !== undefined) {
    return { specIds: [existingId], mode: await loadSpecMode(client, packet.projectId, existingId) };
  }

  const inheritedMode = await loadSpecMode(client, packet.projectId, packet.sourceSpecId);
  const criteria = [
    `Resolve the fixed point: ${packet.counterexample}`,
    `Allowed revisions (policy CANNOT be waived): ${packet.allowedRevisions.join(", ")}.`,
  ];
  const spec = await createSpecOnClient(
    client,
    {
      projectId: packet.projectId,
      title: `Re-spec ${packet.sourceSpecId} (generation ${packet.generation})`,
      description:
        `Autonomous re-spec of ${packet.sourceSpecId} after in-place repair reached a fixed point ` +
        `(${packet.fixedPoint.failureSignature}). ${packet.counterexample}`,
      acceptanceCriteria: criteria,
      mode: inheritedMode,
      triageProvenance: {
        parentSpecId: packet.sourceSpecId,
        sourceFindingIds: canonicalFindingIds,
        originTriageTaskId: `respec:${packet.evaluationId}`,
        originRunId: runId,
      },
    },
    actor,
  );
  return { specIds: [spec.specId], mode: inheritedMode };
}
