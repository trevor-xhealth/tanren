// The governed worker-concurrency ceiling is resolved from the PERSISTED config
// surface — the project's `allocator.concurrency` over the org's over the schema
// default (project-over-org, exactly how `resolveEffectiveBudget` /
// `resolveCreditUsdRate` layer) — and that resolved value must actually REACH the
// consumer that spends it (the DagWalker's tick planner).
//
// Negative control: every ceiling asserted here is DIFFERENT from the schema
// default (3), and the walk case asserts an OBSERVABLE outcome (exactly which specs
// were enqueued), so a resolver that ignored the persisted config and returned the
// schema default would fail this suite rather than pass it vacuously.

import { describe, expect, it } from "vitest";
import { migrateOrgConfig, migrateProjectConfig, resolveWorkerConcurrency } from "../src/engine/config/index.js";
import { EventEmittingDagWalker } from "../src/engine/dag/walker.js";
import type { DagAncestorStackResolver, DagEventEmitter } from "../src/engine/dag/walkerPg.js";
import type {
  BudgetGate,
  DagEnqueuer,
  DagReadModel,
  DagSnapshot,
  DagSpecNode,
  ProjectBudgetState,
} from "../src/engine/contracts/dagWalker.js";
import type { DagLifecycleReadModel, DagLifecycleSnapshot } from "../src/engine/contracts/dagLifecycle.js";

const PROJECT = "project_concurrency";

/** The schema default the buggy `AllocatorConfig.parse({})` resolution always returned. */
const SCHEMA_DEFAULT_CONCURRENCY = 3;

/** A persisted project config row that sets (or omits) the allocator concurrency. */
function projectRow(concurrency?: number): unknown {
  return { version: 1, ...(concurrency === undefined ? {} : { allocator: { concurrency } }) };
}

/** A persisted org config row that sets (or omits) the allocator concurrency. */
function orgRow(concurrency?: number): unknown {
  return { version: 1, ...(concurrency === undefined ? {} : { allocator: { concurrency } }) };
}

/** Resolve through the REAL persisted-config parsers, exactly as the pg resolver does. */
function resolveFromRows(projectRaw: unknown, orgRaw: unknown): number {
  return resolveWorkerConcurrency({
    project: migrateProjectConfig(projectRaw).allocator.concurrency,
    org: migrateOrgConfig(orgRaw).allocator.concurrency,
  });
}

describe("resolveWorkerConcurrency — project over org over the schema default", () => {
  it("honors the PROJECT's persisted allocator.concurrency over the org's", () => {
    expect(resolveFromRows(projectRow(7), orgRow(5))).toBe(7);
  });

  it("falls back to the ORG's persisted allocator.concurrency when the project sets none", () => {
    expect(resolveFromRows(projectRow(), orgRow(5))).toBe(5);
  });

  it("uses the schema default only when NEITHER layer configures one", () => {
    expect(resolveFromRows(projectRow(), orgRow())).toBe(SCHEMA_DEFAULT_CONCURRENCY);
  });

  it("keeps the no-layers call (the process-wide worker boot) on the schema default", () => {
    expect(resolveWorkerConcurrency()).toBe(SCHEMA_DEFAULT_CONCURRENCY);
  });
});

// ---- The resolved ceiling reaches the consumer ----------------------------

function node(specId: string, orderKey: number): DagSpecNode {
  return { specId, phase: "pending", dependsOn: [], priority: "tbd", orderKey };
}

class FixedReadModel implements DagReadModel {
  constructor(private readonly nodes: DagSpecNode[]) {}
  async loadSnapshot(projectId: string): Promise<DagSnapshot> {
    return { projectId, nodes: this.nodes.map((item) => ({ ...item })), projectLifecycle: "active" };
  }
}

class EmptyLifecycle implements DagLifecycleReadModel {
  async loadLifecycle(projectId: string): Promise<DagLifecycleSnapshot> {
    return { projectId, bySpecId: new Map() };
  }
}

class RecordingEnqueuer implements DagEnqueuer {
  readonly specIds: string[] = [];
  async enqueueSpecRun(input: { specId: string }): Promise<{ runId: string }> {
    this.specIds.push(input.specId);
    return { runId: `run_${input.specId}` };
  }
}

/** Records the saturation event so the held-back specs are observable, not inferred. */
class RecordingEmitter implements DagEventEmitter {
  readonly saturated: Array<{ readyHeldBack: number; concurrencyCeiling: number }> = [];
  async emitSpecEnqueued(): Promise<void> {}
  async emitSpecSpeculative(): Promise<void> {}
  async emitSpeculationHeld(): Promise<void> {}
  async emitAncestorNotReady(): Promise<void> {}
  async emitDrained(): Promise<void> {}
  async emitBudgetPaused(): Promise<void> {}
  async emitBudgetMilestone(): Promise<boolean> {
    return true;
  }
  async emitConcurrencySaturated(input: {
    plan: { readyHeldBack: number; concurrencyCeiling: number };
  }): Promise<void> {
    this.saturated.push({
      readyHeldBack: input.plan.readyHeldBack,
      concurrencyCeiling: input.plan.concurrencyCeiling,
    });
  }
  async emitConfigCorrupt(): Promise<void> {}
}

const unlimitedBudgetGate: BudgetGate = {
  async resolveBudget(): Promise<ProjectBudgetState> {
    return { ceilingUsd: undefined, period: "monthly", spentUsd: 0, notionalUsd: 0 };
  },
};

const noStackResolver: DagAncestorStackResolver = {
  async resolveStack() {
    return [];
  },
};

describe("the persisted ceiling reaches the DagWalker's tick planner", () => {
  it("a project configured with concurrency 1 enqueues ONE ready root, not the schema default's 3", async () => {
    // Four ready roots, none in flight: the ceiling is the ONLY thing that decides
    // how many start. The persisted project config says 1.
    const askedFor: string[] = [];
    const enqueuer = new RecordingEnqueuer();
    const events = new RecordingEmitter();
    const walker = new EventEmittingDagWalker({
      readModel: new FixedReadModel([node("spec_a", 0), node("spec_b", 1), node("spec_c", 2), node("spec_d", 3)]),
      lifecycleReadModel: new EmptyLifecycle(),
      enqueuer,
      events,
      ancestorStackResolver: noStackResolver,
      speculationConfig: async () => ({ threshold: "conservative", depthCap: 2 }),
      budgetGate: unlimitedBudgetGate,
      // The production resolver shape: the ceiling is resolved FOR A PROJECT from
      // that project's persisted config layers.
      concurrency: (projectId: string) => {
        askedFor.push(projectId);
        return resolveFromRows(projectRow(1), orgRow(5));
      },
    });

    const result = await walker.walk(PROJECT);

    // The ceiling was resolved for THIS project (not process-globally).
    expect(askedFor).toEqual([PROJECT]);
    // Outcome: exactly one run started, and it is the first in deterministic order.
    expect(result.enqueuedSpecIds).toEqual(["spec_a"]);
    expect(enqueuer.specIds).toEqual(["spec_a"]);
  });

  it("a project configured with concurrency 5 starts all five, above the schema default", async () => {
    const enqueuer = new RecordingEnqueuer();
    const events = new RecordingEmitter();
    const walker = new EventEmittingDagWalker({
      readModel: new FixedReadModel([
        node("spec_a", 0),
        node("spec_b", 1),
        node("spec_c", 2),
        node("spec_d", 3),
        node("spec_e", 4),
      ]),
      lifecycleReadModel: new EmptyLifecycle(),
      enqueuer,
      events,
      ancestorStackResolver: noStackResolver,
      speculationConfig: async () => ({ threshold: "conservative", depthCap: 2 }),
      budgetGate: unlimitedBudgetGate,
      concurrency: () => resolveFromRows(projectRow(5), orgRow()),
    });

    const result = await walker.walk(PROJECT);

    expect(result.enqueuedSpecIds).toEqual(["spec_a", "spec_b", "spec_c", "spec_d", "spec_e"]);
    expect(enqueuer.specIds).toHaveLength(5);
    // Nothing was held back, so the saturation event never fired.
    expect(events.saturated).toEqual([]);
  });
});
