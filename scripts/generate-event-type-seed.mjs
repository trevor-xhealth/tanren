#!/usr/bin/env node
// Regenerates db/src/eventTypesSeed.ts (the committed mirror of the platform-
// global `event_types` catalog) from the SINGLE event vocabulary source in
// services/orchestrator/src/engine/notifications/eventVocabulary.ts — the union
// of the Zod EventRegistry (names) + eventDefaultSeverity (severities) +
// RETAINED_HISTORICAL_EVENTS. The `event_types` table (migration 0040) is
// seeded from this catalog BEFORE the events.event_type / notification_routes.
// event_name foreign keys are added; the Zod schemas remain the single source
// of truth for payload shape (no SQL payload schema, and — since SP-8 — no SQL
// CHECK constraint on the name: the FK to event_types is the sole enforcement).
//
// Usage:
//   node scripts/generate-event-type-seed.mjs                 # write if drifted
//   node scripts/generate-event-type-seed.mjs --check         # exit 1 on drift
//   node scripts/generate-event-type-seed.mjs --emit-seed-sql # print INSERT SQL

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { exit, argv } from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const seedFile = resolve(repoRoot, "db/src/eventTypesSeed.ts");
const vocabularyFile = resolve(repoRoot, "services/orchestrator/src/engine/notifications/eventVocabulary.ts");

const dumper = `
import { eventTypeVocabulary } from ${JSON.stringify(vocabularyFile)};
process.stdout.write(JSON.stringify(eventTypeVocabulary()));
`;

function dumpVocabularyViaTsx() {
  const result = spawnSync("corepack", ["pnpm", "exec", "tsx", "--eval", dumper], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "tsx eval failed\n");
    exit(1);
  }
  return JSON.parse(result.stdout);
}

function renderSeedTs(rows) {
  const lines = [
    "// GENERATED FILE — do not edit by hand.",
    "// Regenerate via `corepack pnpm run codegen:events` (or `node scripts/generate-event-type-seed.mjs`).",
    "// Source of truth: services/orchestrator/src/engine/notifications/eventVocabulary.ts",
    "// (EventRegistry names + eventDefaultSeverity + RETAINED_HISTORICAL_EVENTS).",
    "",
    // `@public`: this generated const is the canonical event-vocabulary catalog —
    // the mirror of the `event_types` seed. It is a deliberate public contract
    // surface (drift-gated by `check:event-drift`) even when this monorepo has no
    // internal importer; the tag tells knip it is not dead code.
    "/** @public */",
    "export const eventTypesSeed = [",
  ];
  // Always emit a trailing comma (including on the last element) so the
  // generated output is byte-identical to oxfmt's multiline-array style —
  // otherwise `check:format` (adds the comma) and `check:event-drift`
  // (regenerates without it) deadlock against each other.
  rows.forEach((row) => {
    lines.push(`  { name: ${JSON.stringify(row.name)}, defaultSeverity: ${JSON.stringify(row.defaultSeverity)} },`);
  });
  lines.push(
    "] as const;",
    "",
    "/** @public */",
    "export type EventTypeSeedRow = (typeof eventTypesSeed)[number];",
    "",
    // The vocabulary as a TYPE. Any module that declares event names of its own
    // (the allocator registry, and anything like it added later) constrains its
    // keys to this union, so a name the `event_types` seed does not carry is a
    // compile error instead of a runtime foreign-key failure on first emit.
    "/** @public */",
    'export type EventTypeSeedName = EventTypeSeedRow["name"];',
    "",
  );
  return lines.join("\n");
}

function renderSeedSql(rows) {
  const values = rows
    .map((row) => `  ('${row.name.replaceAll("'", "''")}', '${row.defaultSeverity.replaceAll("'", "''")}')`)
    .join(",\n");
  return `INSERT INTO "event_types" ("name", "default_severity") VALUES\n${values};`;
}

function main() {
  const args = new Set(argv.slice(2));
  const rows = dumpVocabularyViaTsx();
  const expected = renderSeedTs(rows);
  const current = (() => {
    try {
      return readFileSync(seedFile, "utf8");
    } catch {
      return "";
    }
  })();

  if (args.has("--emit-seed-sql")) {
    process.stdout.write(renderSeedSql(rows));
    process.stdout.write("\n");
    return;
  }

  if (args.has("--check")) {
    if (current.trimEnd() !== expected.trimEnd()) {
      process.stderr.write(
        "event type seed mirror drift detected. Regenerate with `corepack pnpm run codegen:events`.\n",
      );
      exit(1);
    }
    return;
  }

  if (current.trimEnd() === expected.trimEnd()) {
    process.stdout.write("event type seed mirror up to date\n");
  } else {
    writeFileSync(seedFile, expected);
    process.stdout.write(`updated ${seedFile}\n`);
  }
}

main();
