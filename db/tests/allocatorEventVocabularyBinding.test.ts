// The allocator's event names must be a SUBSET of the shared event vocabulary.
//
// `events.event_type` has a foreign key onto `event_types`. A name declared in
// code that no migration inserts makes the first emit fail that FK, which
// returns 500 from `/internal/append-event` and HALTS the run. The orchestrator
// vocabulary is protected by `check:event-drift` (seed mirrors code) plus the
// event-type migration guard (every vocabulary name is inserted). The allocator
// declared its names in a SEPARATE registry that neither of those reads.
//
// `AllocatorEventRegistry` is now typed `satisfies Partial<Record<
// EventTypeSeedName, ...>>`, so an out-of-vocabulary key is a compile error.
// These assertions are the runtime backstop for that binding: they fail if the
// `satisfies` clause is ever dropped and a stray name added, and — the other
// direction — they fail if the binding is tightened until it rejects the two
// names the allocator legitimately owns. "Rejects everything" must not be able
// to pass as a fix.

import { describe, expect, it } from "vitest";
import { AllocatorEventRegistry } from "../src/allocatorEventStore.js";
import { eventTypesSeed } from "../src/eventTypesSeed.js";

const vocabulary = new Set<string>(eventTypesSeed.map((row) => row.name));
const declared = Object.keys(AllocatorEventRegistry).sort();

describe("allocator event vocabulary binding", () => {
  it("declares no event name the shared vocabulary is missing", () => {
    expect(declared.filter((name) => !vocabulary.has(name))).toEqual([]);
  });

  it("still declares both allocator-owned names", () => {
    expect(declared).toEqual(["allocator.allocated", "runner.swept"]);
  });

  it("keeps a payload schema for every declared name", () => {
    for (const name of declared) {
      expect(typeof AllocatorEventRegistry[name as keyof typeof AllocatorEventRegistry].parse).toBe("function");
    }
  });
});
