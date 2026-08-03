#!/usr/bin/env node
// Guards the seam that `check:event-drift` does NOT cover.
//
// `check:event-drift` proves db/src/eventTypesSeed.ts mirrors the code
// vocabulary. Nothing proved that a MIGRATION actually inserts those rows, so a
// name could be declared in code, mirrored into the seed file, pass every gate —
// and still be absent from the `event_types` table. The `events.event_type` FK
// (events_event_type_event_types_name_fk) then rejects the first emit with a
// 500 from /internal/append-event and the run HALTS. That is exactly how
// cost.route_unmeterable / cost.ceiling_unenforceable / cost.generation_id_missing
// shipped: 359 declared, 356 migrated, gate green, every affected run halting.
//
// This is the STATIC half of the guard: it parses db/migrations/**.sql for the
// names those migrations insert and diffs them against the code vocabulary. It
// is offline and fast, so it runs in `just fast-check`. The LIVE half —
// `just smoke-event-type-catalog` — applies the migrations to a real Postgres
// and compares the actual table, which is immune to any parsing quirk here and
// cross-checks this parser.
//
// The parser deliberately REFUSES to guess. `event_types` is append-only by
// convention (every insert is `ON CONFLICT ("name") DO NOTHING`), which is what
// makes a static model of the final table state sound. If a migration ever uses
// a shape that breaks that model (DELETE, UPDATE, DO UPDATE, INSERT ... SELECT),
// this script fails loudly and names the statement rather than reporting a
// confident wrong answer.
//
// Usage:
//   node scripts/check-event-type-migrations.mjs           # exit 1 on drift
//   node scripts/check-event-type-migrations.mjs --list     # print migrated names

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const migrationsDir = resolve(repoRoot, "db/migrations");
const vocabularyFile = resolve(repoRoot, "services/orchestrator/src/engine/notifications/eventVocabulary.ts");

const TABLE = "event_types";

/** The code vocabulary — the same single source `codegen:events` renders the seed from. */
function dumpVocabulary() {
  const dumper = `
import { eventTypeVocabulary } from ${JSON.stringify(vocabularyFile)};
process.stdout.write(JSON.stringify(eventTypeVocabulary()));
`;
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

/**
 * Strip `--` line comments and block comments, but never inside a string
 * literal (a comment marker inside `'...'` is data, not a comment).
 */
function stripComments(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      out += sql[i];
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "''";
          i += 2;
          continue;
        }
        out += sql[i];
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** Read forward from `start` to the statement-terminating `;` (ignoring literals). */
function statementBody(sql, start) {
  let i = start;
  let body = "";
  while (i < sql.length) {
    if (sql[i] === "'") {
      body += sql[i];
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          body += "''";
          i += 2;
          continue;
        }
        body += sql[i];
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (sql[i] === ";") break;
    body += sql[i];
    i += 1;
  }
  return body;
}

function unquote(token) {
  const t = token.trim();
  if (!t.startsWith("'")) return null;
  return t.slice(1, -1).replaceAll("''", "'");
}

/** Split a tuple body on commas that are not inside a string literal. */
function splitTuple(body) {
  const parts = [];
  let cur = "";
  let i = 0;
  while (i < body.length) {
    if (body[i] === "'") {
      cur += body[i];
      i += 1;
      while (i < body.length) {
        if (body[i] === "'" && body[i + 1] === "'") {
          cur += "''";
          i += 2;
          continue;
        }
        cur += body[i];
        if (body[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (body[i] === ",") {
      parts.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    cur += body[i];
    i += 1;
  }
  parts.push(cur);
  return parts;
}

/**
 * Any statement that mutates `event_types` in a way the append-only model cannot
 * represent. Finding one means this static check can no longer be trusted, so it
 * is a hard failure, not a warning.
 */
const unsupportedShapes = [
  [/\bDELETE\s+FROM\s+"?event_types"?/iu, "DELETE FROM event_types"],
  [/\bUPDATE\s+"?event_types"?\s+SET\b/iu, "UPDATE event_types ... SET"],
  [/\bTRUNCATE\s+(?:TABLE\s+)?"?event_types"?/iu, "TRUNCATE event_types"],
  [
    /\bINSERT\s+INTO\s+"?event_types"?[^;]*?\bON\s+CONFLICT\b[^;]*?\bDO\s+UPDATE\b/iu,
    "INSERT ... ON CONFLICT DO UPDATE",
  ],
];

function collectMigrated() {
  const migrated = new Map();
  const problems = [];
  let tupleCount = 0;

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = stripComments(readFileSync(resolve(migrationsDir, file), "utf8"));

    for (const [pattern, label] of unsupportedShapes) {
      if (pattern.test(sql)) {
        problems.push(`${file}: unsupported \`${label}\` — the append-only model this check relies on no longer holds`);
      }
    }

    // `INSERT INTO [schema.]event_types (cols) VALUES` — the only shape in use.
    const insertRe = /INSERT\s+INTO\s+(?:"?public"?\.)?"?event_types"?\s*(\(([^)]*)\))?\s*(VALUES|SELECT)/giu;
    let match;
    while ((match = insertRe.exec(sql)) !== null) {
      if (match[3].toUpperCase() === "SELECT") {
        problems.push(`${file}: \`INSERT INTO ${TABLE} ... SELECT\` cannot be resolved statically`);
        continue;
      }
      if (!match[1]) {
        problems.push(`${file}: \`INSERT INTO ${TABLE}\` without an explicit column list`);
        continue;
      }
      const cols = match[2].split(",").map((c) => c.trim().replaceAll(/^"|"$/gu, ""));
      const nameIdx = cols.indexOf("name");
      const sevIdx = cols.indexOf("default_severity");
      if (nameIdx === -1) {
        problems.push(`${file}: \`INSERT INTO ${TABLE}\` column list has no "name" column`);
        continue;
      }

      const body = statementBody(sql, insertRe.lastIndex);
      const conflictAt = body.search(/\bON\s+CONFLICT\b/iu);
      const valuesText = conflictAt === -1 ? body : body.slice(0, conflictAt);

      const tupleRe = /\(((?:'(?:[^']|'')*'|[^()])*)\)/gu;
      let tuple;
      while ((tuple = tupleRe.exec(valuesText)) !== null) {
        const parts = splitTuple(tuple[1]);
        const name = unquote(parts[nameIdx] ?? "");
        if (name === null) {
          problems.push(`${file}: non-literal "name" in a ${TABLE} VALUES tuple: (${tuple[1].trim()})`);
          continue;
        }
        tupleCount += 1;
        const severity = sevIdx === -1 ? null : unquote(parts[sevIdx] ?? "");
        // ON CONFLICT DO NOTHING ⇒ the FIRST insert of a name is the row that survives.
        if (!migrated.has(name)) migrated.set(name, { severity, file });
      }
    }
  }

  return { migrated, problems, tupleCount };
}

function formatSeedSql(rows) {
  const values = rows
    .map((r) => `  ('${r.name.replaceAll("'", "''")}', '${r.defaultSeverity.replaceAll("'", "''")}')`)
    .join(",\n");
  return `INSERT INTO "${TABLE}" ("name", "default_severity") VALUES\n${values}\nON CONFLICT ("name") DO NOTHING;`;
}

function main() {
  const args = new Set(argv.slice(2));
  const { migrated, problems, tupleCount } = collectMigrated();

  if (args.has("--list")) {
    for (const name of [...migrated.keys()].sort()) process.stdout.write(`${name}\n`);
    return;
  }

  if (problems.length > 0) {
    process.stderr.write(`unparseable ${TABLE} migration statement(s):\n`);
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.stderr.write(
      `\nThis static check models \`${TABLE}\` as append-only. Teach it the new shape, or\n` +
        `rely on \`just smoke-event-type-catalog\` (the live check against a migrated DB).\n`,
    );
    exit(1);
  }

  const declared = dumpVocabulary();
  const declaredByName = new Map(declared.map((r) => [r.name, r.defaultSeverity]));

  const missing = declared.filter((r) => !migrated.has(r.name));
  const orphaned = [...migrated.keys()].filter((n) => !declaredByName.has(n)).sort();
  const severityDrift = declared
    .filter((r) => migrated.has(r.name) && migrated.get(r.name).severity !== r.defaultSeverity)
    .map((r) => ({ name: r.name, declared: r.defaultSeverity, ...migrated.get(r.name) }));

  if (missing.length === 0 && orphaned.length === 0 && severityDrift.length === 0) {
    process.stdout.write(
      `event type migrations up to date: ${declared.length} declared, ${migrated.size} migrated ` +
        `(${tupleCount} insert tuples across db/migrations)\n`,
    );
    return;
  }

  if (missing.length > 0) {
    process.stderr.write(
      `event type migration drift: ${missing.length} of ${declared.length} declared event type(s) ` +
        `are NOT inserted by any migration.\n\n` +
        `The events.event_type foreign key rejects these names, so the FIRST run that emits\n` +
        `one gets a 500 from /internal/append-event and HALTS:\n\n`,
    );
    for (const row of missing) process.stderr.write(`  - ${row.name} (default_severity: ${row.defaultSeverity})\n`);
    process.stderr.write(`\nAdd a migration that inserts exactly these rows:\n\n${formatSeedSql(missing)}\n`);
  }

  if (orphaned.length > 0) {
    process.stderr.write(
      `\n${orphaned.length} event type(s) are inserted by a migration but NOT declared in the\n` +
        `code vocabulary (add to RETAINED_HISTORICAL_EVENTS if deliberately retired):\n\n`,
    );
    for (const name of orphaned) process.stderr.write(`  + ${name} (${migrated.get(name).file})\n`);
  }

  if (severityDrift.length > 0) {
    process.stderr.write(`\n${severityDrift.length} event type(s) have a migrated default_severity that disagrees\n`);
    process.stderr.write(`with the code vocabulary:\n\n`);
    for (const d of severityDrift) {
      process.stderr.write(`  ! ${d.name}: declared=${d.declared} migrated=${d.severity} (${d.file})\n`);
    }
  }

  exit(1);
}

main();
