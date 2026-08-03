// The LIVE half of the event-type migration guard (the static half is
// `scripts/check-event-type-migrations.mjs`, run by `just event-migration-drift`).
//
// `check:event-drift` proves db/src/eventTypesSeed.ts mirrors the code vocabulary.
// It does NOT prove a migration inserts those rows. When it doesn't, the
// `events.event_type` FK rejects the first emit, /internal/append-event returns
// 500 and the run HALTS — which is how cost.route_unmeterable,
// cost.ceiling_unenforceable and cost.generation_id_missing shipped green.
//
// This test applies the real migrations to a THROWAWAY database and compares the
// resulting `event_types` table against the code vocabulary. Unlike the static
// check it cannot be fooled by an INSERT shape the parser does not understand —
// so it is also the cross-check that keeps that parser honest (case 4).
//
// The throwaway DB is the whole point: the shared dev database is mutable by
// anything with a connection string, and on at least one developer box its
// `event_types` already contained rows that NO committed migration inserts
// (someone patched the FK failure by hand). Asserting against that database
// would have reported green while the migrations were still broken. A database
// created and migrated by this test measures db/migrations and nothing else.

import { migrate } from "@tanren/db";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventTypeVocabulary } from "../src/engine/notifications/eventVocabulary.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const SCRATCH_DB = `tanren_event_type_catalog_${process.pid}`;

interface CatalogRow {
  readonly name: string;
  readonly defaultSeverity: string;
}

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

describeDb("event_types catalog is fully migrated", () => {
  let adminPool: Pool;
  let pool: Pool;
  let migrated: Map<string, string>;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB}"`);

    pool = new Pool({ connectionString: scratchUrl() });
    // The ONLY thing that ever touches this database: db/migrations.
    await migrate(pool);
    const result = await pool.query<{ name: string; default_severity: string }>(
      `SELECT "name", "default_severity" FROM "event_types"`,
    );
    migrated = new Map(result.rows.map((r) => [r.name, r.default_severity]));
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    await adminPool?.end();
  }, 60_000);

  it("inserts a row for EVERY event type declared in the code vocabulary", () => {
    const declared: CatalogRow[] = eventTypeVocabulary();
    // Each entry NAMES the offending type: the operator's next action is to add
    // exactly these rows, so a bare count would be useless.
    const missing = declared
      .filter((row) => !migrated.has(row.name))
      .map(
        (row) =>
          `no migration inserts declared event type "${row.name}" (default_severity: ${row.defaultSeverity}) — ` +
          `any run emitting it HALTS on the events.event_type foreign key`,
      );

    expect(missing).toEqual([]);
    expect(migrated.size).toBeGreaterThanOrEqual(declared.length);
  });

  it("has no migrated event type that the code vocabulary does not declare", () => {
    const declared = new Set(eventTypeVocabulary().map((row) => row.name));
    const orphaned = [...migrated.keys()]
      .filter((name) => !declared.has(name))
      .sort()
      .map((name) => `migrated event type "${name}" is not declared in code (retire via RETAINED_HISTORICAL_EVENTS)`);

    expect(orphaned).toEqual([]);
  });

  it("agrees with the code vocabulary on default_severity", () => {
    const drift = eventTypeVocabulary()
      .filter((row) => migrated.has(row.name) && migrated.get(row.name) !== row.defaultSeverity)
      .map(
        (row) =>
          `"${row.name}" default_severity drift: declared=${row.defaultSeverity} ` +
          `migrated=${String(migrated.get(row.name))}`,
      );

    expect(drift).toEqual([]);
  });

  it("matches what the static migration parser reads, so that parser cannot be silently wrong", () => {
    const result = spawnSync("node", ["scripts/check-event-type-migrations.mjs", "--list"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`scripts/check-event-type-migrations.mjs --list failed:\n${result.stderr}`);
    }

    const parsed = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const disagreements = [
      ...parsed
        .filter((name) => !migrated.has(name))
        .map((name) => `static parser read an insert of "${name}" that the migrated table does not contain`),
      ...[...migrated.keys()]
        .filter((name) => !parsed.includes(name))
        .sort()
        .map((name) => `migrated table contains "${name}" but the static parser found no migration inserting it`),
    ];

    expect(disagreements).toEqual([]);
  });
});
