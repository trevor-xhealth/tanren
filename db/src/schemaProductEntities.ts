// P2A-0018 product entities: `personas` and `behaviors`. A PURE MOVE out of
// `db/src/schema.ts` (same table/column/constraint names, same DDL) so that
// `db/src/schemaCatalog.ts` can take a composite same-org foreign key onto
// `personas` without closing an import cycle through `schema.ts` — ESM hoists
// `export … from`, so a `schema.ts → schemaCatalog.ts → schema.ts` cycle would
// evaluate the catalog module before `personas` is initialized.
//
// The ONE substantive addition is `personas_org_id_unique`: `personas` has a
// single-column primary key, so before this there was no `(org_id, id)` unique
// for a same-org foreign key to reference. The catalog tables require it —
// a single-column FK to `personas(id)` would let a row in org A point at a
// persona in org B, which is exactly the tenancy hole composite same-org FKs
// exist to close.

import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";

export const personas = pgTable(
  "personas",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").references(() => projects.projectId),
    name: text("name").notNull(),
    description: text("description").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("personas_scope_check", sql`${table.scope} IN ('org','project')`),
    check(
      "personas_scope_project_check",
      sql`(${table.scope} = 'org' AND ${table.projectId} IS NULL) OR (${table.scope} = 'project' AND ${table.projectId} IS NOT NULL)`,
    ),
    index("personas_org_id").on(table.orgId),
    index("personas_project_id").on(table.projectId),
    // The same-org FK target for `catalog_personas` (and any future tenant child).
    uniqueIndex("personas_org_id_unique").on(table.orgId, table.id),
  ],
);

export const behaviors = pgTable(
  "behaviors",
  {
    id: text("id").primaryKey(),
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id),
    title: text("title").notNull(),
    given: text("given").notNull(),
    when: text("when").notNull(),
    // eslint-disable-next-line unicorn/no-thenable
    then: text("then").notNull(),
    description: text("description"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("behaviors_persona_id").on(table.personaId)],
);
