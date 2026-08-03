// cspell:ignore mqeval mqgrp
// A RE-SPEC INHERITS ITS PARENT SPEC'S AUTHORING MODE.
//
// `PgAutonomousRepairRouter` materializes a REPLACEMENT spec when in-place repair reaches a
// proven fixed point. That replacement used to be created with a HARDCODED
// `mode: "from_scratch"`, whatever the parent was. For a brownfield (`modify_existing`)
// parent that is the failure `modify_existing` exists to prevent, arriving exactly when the
// system is already struggling: the replacement's standing writer instruction flips back to
// "Build everything ELSE — the manifest/lockfile, sources, configs, tests, fixtures" against
// a real, pre-existing repository. Nothing surfaced the change, so an operator would see a
// re-spec produce an enormous scope-violating diff with no indication why.
//
// These cases pin the fix MECHANICALLY, for ALL THREE `SpecMode` arms, by asserting the
// PERSISTED mode — the value bound into `INSERT INTO specs` — not a function's return value,
// because the defect was in what got written. The live-Postgres counterpart (the real merge
// transaction, real RLS, read back with SELECT) is
// `mergeRepairRoutes.rls.integration.test.ts`; this file is the gate-runnable seam so the
// decision cannot silently regress in the default suite.
//
// NOT a mock: `RouterPool` is a hand-written in-memory Postgres stand-in (the same
// `CapturingPool` idiom `createSpecModePersistence.test.ts` uses); the REAL
// `PgAutonomousRepairRouter`, the REAL `decideRepairRoute`, and the REAL `createSpecOnClient`
// INSERT path all execute.

import { describe, expect, it } from "vitest";
import { PgEventStore, type AppendEventInput, type EventStore } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import { MergeMemberRespecRoutedPayload } from "../src/engine/events/schemas/mergeQueue.js";
import { canonicalFailureSignature } from "../src/engine/merge/repairRouteDecision.js";
import { PgAutonomousRepairRouter } from "../src/engine/merge/respecRouterPg.js";
import { SpecMode } from "../src/engine/state/spec.js";

const ORG = "org_respec_mode";
const PROJECT = "project_respec_mode";
const PARENT = "spec_respec_mode_parent";
const SIGNATURE = canonicalFailureSignature(["audit_policy"], ["f1"]);

/** A valid `merge.member.respec_routed` payload apart from its `specMode` (varied per case). */
const RESPEC_PAYLOAD = {
  projectId: PROJECT,
  sourceSpecId: PARENT,
  groupId: "mqgrp_respec_mode",
  evaluationId: "mqeval_respec_mode",
  packetHash: `sha256:${"a".repeat(64)}`,
  priorAgentRoute: "writer.in_place",
  nextAgentRoute: "answerer.respec",
  generation: 1,
  replacementSpecIds: ["spec_replacement"],
} as const;

interface SpecRow {
  readonly specId: string;
  readonly mode: string;
  readonly parentSpecId: string | null;
}

/**
 * An in-memory stand-in for the org-scoped pool the router runs on. It answers only the
 * statements the respec path actually issues and RECORDS every `INSERT INTO specs` param
 * vector, so a case can assert the mode that was PERSISTED for the replacement spec.
 */
class RouterPool {
  readonly specs = new Map<string, SpecRow>();
  readonly specInserts: Array<unknown[]> = [];
  /** Prior identical-signature attempts: two of them prove the fixed point → respec. */
  priorAttempts = 2;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const text = sql.trim();
    if (text.startsWith("SELECT org_id FROM projects")) {
      return { rows: [{ org_id: ORG }], rowCount: 1 };
    }
    if (text.startsWith("SELECT project_id FROM projects")) {
      return { rows: [{ project_id: PROJECT }], rowCount: 1 };
    }
    if (text.startsWith("SELECT failure_signature")) {
      const rows = Array.from({ length: this.priorAttempts }, () => ({
        failure_signature: SIGNATURE,
        magnitude: 1,
        disposition: "repair_in_place",
      }));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT mode FROM specs")) {
      const row = this.specs.get(String(params[1]));
      return { rows: row === undefined ? [] : [{ mode: row.mode }], rowCount: row === undefined ? 0 : 1 };
    }
    if (text.startsWith("SELECT spec_id FROM specs WHERE project_id = $1 AND parent_spec_id")) {
      const found = [...this.specs.values()].find((row) => row.parentSpecId === String(params[1]));
      return { rows: found === undefined ? [] : [{ spec_id: found.specId }], rowCount: found === undefined ? 0 : 1 };
    }
    if (text.startsWith("SELECT spec_id FROM specs WHERE project_id = $1 AND spec_id = ANY")) {
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith("INSERT INTO specs")) {
      this.specInserts.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO merge_repair_routes")) {
      return { rows: [{ route_id: "mrr_test" }], rowCount: 1 };
    }
    // BEGIN / COMMIT / ROLLBACK / SET LOCAL / NOTIFY: no-op.
    return { rows: [], rowCount: 0 };
  }

  async connect() {
    return this;
  }
  release() {}
  asPgPool() {
    return this as never;
  }
}

/** Records the typed events the router appends (never a `vi.mock` — a real object). */
class RecordingEvents implements EventStore {
  readonly appended: Array<AppendEventInput> = [];
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appended.push(input as AppendEventInput);
  }
}

/** A router fixture; omitting `parentMode` leaves the parent spec row UNREADABLE. */
function routerFor(parentMode?: string): { pool: RouterPool; events: RecordingEvents } {
  const pool = new RouterPool();
  if (parentMode !== undefined) {
    pool.specs.set(PARENT, { specId: PARENT, mode: parentMode, parentSpecId: null });
  }
  return { pool, events: new RecordingEvents() };
}

async function routeRespec(pool: RouterPool, events: RecordingEvents) {
  const router = new PgAutonomousRepairRouter({ pool: pool.asPgPool(), events });
  return router.routeMemberFailure({
    projectId: PROJECT,
    groupId: "mqgrp_respec_mode",
    evaluationId: "mqeval_respec_mode",
    sourceSpecId: PARENT,
    runId: "run_respec_mode",
    classification: "deterministic_policy",
    findingIds: ["f1"],
    reasonCodes: ["audit_policy"],
  });
}

/** The mode bound into `INSERT INTO specs` — positional $10 ⇒ params index 9. */
function persistedMode(pool: RouterPool): unknown {
  expect(pool.specInserts).toHaveLength(1);
  return pool.specInserts[0]![9];
}

describe("respec — the replacement spec INHERITS the parent's authoring mode", () => {
  // THE NEGATIVE CONTROL. Against the unfixed router (`mode: "from_scratch"` hardcoded at
  // respecRouterPg.ts) this FAILS with `expected 'from_scratch' to be 'modify_existing'` —
  // a brownfield spec silently reverting to rebuild-the-world mode on its first re-spec.
  it("a modify_existing parent PERSISTS modify_existing on the replacement spec", async () => {
    const { pool, events } = routerFor("modify_existing");
    const outcome = await routeRespec(pool, events);
    expect(outcome.kind).toBe("respec");
    expect(persistedMode(pool)).toBe("modify_existing");
  });

  // BLANKET inheritance, arm 2. `specialize_seed` inherits too: the parent failed to
  // converge, so its specialization never landed and the composed seed is STILL what the
  // replacement's writer opens. Handing that writer `from_scratch`'s "build everything ELSE"
  // is the v64 contradiction verbatim — the very shape of non-convergence that triggered the
  // re-spec in the first place.
  it("a specialize_seed parent PERSISTS specialize_seed on the replacement spec", async () => {
    const { pool, events } = routerFor("specialize_seed");
    await routeRespec(pool, events);
    expect(persistedMode(pool)).toBe("specialize_seed");
  });

  // Arm 3 — the no-op case, pinned so "inherit" is proven to be inheritance and not a
  // hardcode that happens to agree. A greenfield parent still yields `from_scratch`.
  it("a from_scratch parent PERSISTS from_scratch on the replacement spec", async () => {
    const { pool, events } = routerFor("from_scratch");
    await routeRespec(pool, events);
    expect(persistedMode(pool)).toBe("from_scratch");
  });

  // LOUD, never silent. A parent row the org-scoped read cannot see is not a license to
  // guess an authoring mode — guessing is precisely the defect. The whole transaction rolls
  // back, so no route row and no half-authored replacement survive.
  it("throws when the parent spec row is unreadable — never falls back to a default", async () => {
    const { pool, events } = routerFor();
    await expect(routeRespec(pool, events)).rejects.toThrow(/authoring mode/u);
    expect(pool.specInserts).toHaveLength(0);
  });

  // LOUD, never silent (corrupt value). The DB CHECK makes this unreachable today, so it is
  // defense against a widened/skewed enum: an unrecognized literal must not degrade to
  // `from_scratch`, which is exactly how `driveConflictResolve` silently mis-graded a third
  // mode before it was fixed.
  it("throws when the parent's mode is not a known SpecMode literal", async () => {
    const { pool, events } = routerFor("rebuild_everything");
    await expect(routeRespec(pool, events)).rejects.toThrow(/authoring mode/u);
    expect(pool.specInserts).toHaveLength(0);
  });

  // OBSERVABILITY — the other half of the defect. The mode a re-spec hands its replacement
  // is now on the wire: `merge.member.respec_routed` carries `specMode`, so an operator
  // watching a brownfield project can see WHICH authoring mode the replacement got, at the
  // moment it got it, instead of inferring it from an enormous diff hours later.
  it("reports the replacement's mode on merge.member.respec_routed", async () => {
    const { pool, events } = routerFor("modify_existing");
    await routeRespec(pool, events);
    const respecEvent = events.appended.find((e) => e.eventType === "merge.member.respec_routed");
    expect(respecEvent).toBeDefined();
    const payload = respecEvent?.payload as { specMode?: SpecMode } | undefined;
    expect(payload?.specMode).toBe("modify_existing");
  });

  // The event's payload is `.strict()`-validated by the real vocabulary, so the added field
  // has to be a DECLARED part of the contract rather than an extra key. Drive the real
  // `PgEventStore` validation over the payload the router emits.
  it("the emitted respec payload validates against the real event vocabulary", async () => {
    const { pool, events } = routerFor("modify_existing");
    await routeRespec(pool, events);
    const respecEvent = events.appended.find((e) => e.eventType === "merge.member.respec_routed");
    const store = new PgEventStore(new RouterPool().asPgPool());
    await expect(store.append(respecEvent!)).resolves.not.toThrow();
  });

  // The event contract restates the SpecMode literals (the event schemas are a self-contained
  // contract layer that imports nothing from engine state). Pin the two sets to each other so
  // a FOURTH mode cannot be added to `SpecMode` and silently fail to reach the wire — an
  // unrepresentable mode would make `emitRespecRouted` throw at the `.strict()` parse, taking
  // down a routing transaction, which is the same class of one-place-widened,
  // other-place-stale enum bug this change exists to remove.
  it("the event contract accepts every SpecMode literal and nothing else", () => {
    const accepted = [...SpecMode.options, "rebuild_everything"].filter(
      (mode) => MergeMemberRespecRoutedPayload.safeParse({ ...RESPEC_PAYLOAD, specMode: mode }).success,
    );
    expect(accepted).toEqual([...SpecMode.options]);
  });
});
