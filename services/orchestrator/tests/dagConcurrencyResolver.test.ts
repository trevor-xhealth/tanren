// The production per-project concurrency-ceiling resolver: it reads the PERSISTED
// `projects.config` / `organizations.config` rows and applies project-over-org-over-default.
// Driven through a fake pool that answers the two real SELECTs (the same in-memory-seam
// style as `walkerConfigCorruption.test.ts`), so the SQL shape + the layering are both
// pinned without a live database.
//
// Every configured ceiling asserted here differs from the schema default (3), so a
// resolver that ignored the persisted rows would fail these cases rather than pass them.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { buildConcurrencyResolver } from "../src/engine/dag/walkerConfigResolvers.js";

const PROJECT = "project_1";
const ORG = "org_1";

/** The schema default — what the old empty-object parse always returned. */
const SCHEMA_DEFAULT_CONCURRENCY = 3;

interface Rows {
  /** The `projects` row; `null` means no such project. */
  project: { orgId: string | null; config: unknown } | null;
  /** The `organizations` row config; `undefined` means no such org row. */
  org?: unknown;
}

// Mirrors the `runWithSystemScope` no-system-pool fallback (BEGIN/COMMIT are no-ops) and
// answers the resolver's two reads from the configured rows.
function fakePool(rows: Rows): pg.Pool {
  const query = async (sql: string) => {
    const trimmed = sql.trim().toUpperCase();
    if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith("SELECT ORG_ID, CONFIG FROM PROJECTS")) {
      return rows.project === null
        ? { rows: [], rowCount: 0 }
        : { rows: [{ org_id: rows.project.orgId, config: rows.project.config }], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT CONFIG FROM ORGANIZATIONS")) {
      return rows.org === undefined ? { rows: [], rowCount: 0 } : { rows: [{ config: rows.org }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => {} } as unknown as pg.PoolClient;
  return { connect: async () => client, query } as unknown as pg.Pool;
}

describe("buildConcurrencyResolver — the persisted allocator.concurrency, project over org", () => {
  it("returns the PROJECT's persisted ceiling when it sets one", async () => {
    const resolve = buildConcurrencyResolver(
      fakePool({
        project: { orgId: ORG, config: { version: 1, allocator: { concurrency: 7 } } },
        org: { version: 1, allocator: { concurrency: 5 } },
      }),
    );

    expect(await resolve(PROJECT)).toBe(7);
  });

  it("inherits the ORG's persisted ceiling when the project sets none", async () => {
    const resolve = buildConcurrencyResolver(
      fakePool({
        project: { orgId: ORG, config: { version: 1 } },
        org: { version: 1, allocator: { concurrency: 5 } },
      }),
    );

    expect(await resolve(PROJECT)).toBe(5);
  });

  it("uses the schema default when neither layer configures one", async () => {
    const resolve = buildConcurrencyResolver(
      fakePool({ project: { orgId: ORG, config: { version: 1 } }, org: { version: 1 } }),
    );

    expect(await resolve(PROJECT)).toBe(SCHEMA_DEFAULT_CONCURRENCY);
  });

  it("a fresh project with an ABSENT config still inherits its org's ceiling", async () => {
    const resolve = buildConcurrencyResolver(
      fakePool({ project: { orgId: ORG, config: {} }, org: { version: 1, allocator: { concurrency: 6 } } }),
    );

    expect(await resolve(PROJECT)).toBe(6);
  });

  it("a CORRUPT project config falls through to the org layer rather than wedging the walk", async () => {
    const resolve = buildConcurrencyResolver(
      fakePool({
        // version 99 is unsupported — migrateProjectConfig throws.
        project: { orgId: ORG, config: { version: 99, allocator: { concurrency: 9 } } },
        org: { version: 1, allocator: { concurrency: 5 } },
      }),
    );

    expect(await resolve(PROJECT)).toBe(5);
  });

  it("a CORRUPT org config falls through to the schema default", async () => {
    const resolve = buildConcurrencyResolver(
      fakePool({ project: { orgId: ORG, config: { version: 1 } }, org: { version: 99 } }),
    );

    expect(await resolve(PROJECT)).toBe(SCHEMA_DEFAULT_CONCURRENCY);
  });

  it("an unowned project (null org_id) still honors its OWN persisted ceiling", async () => {
    const resolve = buildConcurrencyResolver(
      fakePool({ project: { orgId: null, config: { version: 1, allocator: { concurrency: 4 } } } }),
    );

    expect(await resolve(PROJECT)).toBe(4);
  });

  it("a missing project row resolves the schema default (nothing persisted to honor)", async () => {
    const resolve = buildConcurrencyResolver(fakePool({ project: null }));

    expect(await resolve(PROJECT)).toBe(SCHEMA_DEFAULT_CONCURRENCY);
  });
});
