// FIRST-CLASS storage for `tanren.behavior.v0` / `tanren.persona.v0` catalog
// documents (docs/architecture/behavior-catalog-import.md).
//
// WHY A STORED SHAPE, NOT A PROJECTION. A `tanren.behavior.v0` document carries
// a stable sparse identity (`B-####`), an `initiative`, a provenance trail, an
// author list, an ORDERED persona list, and an ORDERED cross-reference list.
// `behaviors` (the BDD triple) has room for exactly one persona and none of the
// rest, so projecting on the way in would drop the catalog's identity and
// orphan its own cross-references — round-tripping back to Markdown would be
// impossible and re-import could not be keyed on anything stable. These tables
// are the AUTHORITY for an imported catalog; the `behaviors`/`personas` rows
// are a declared, one-way PROJECTION of it (`catalog_behaviors.behavior_id`).
//
// TENANCY. Every table is org-keyed, RLS-enabled and FORCEd (the FORCE is
// hand-appended in the migration — drizzle emits no such API), with the org
// isolation policy carrying both USING and WITH CHECK, and every relationship
// crossing a tenant-owned table uses a COMPOSITE same-org foreign key.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { projects } from "./schemaCore.js";
import { behaviors, personas } from "./schemaProductEntities.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");
const catalogIdPattern = sql.raw("'^B-[0-9]{4}$'");

/** Deny-by-default tenant policy shared by every catalog table. */
function catalogOrgIsolationPolicy(orgId: AnyPgColumn) {
  const predicate = sql`${orgId} = current_setting('app.current_org_id', true)`;
  return pgPolicy("rls_org_isolation", { for: "all", using: predicate, withCheck: predicate });
}

// A `tanren.persona.v0` document, stored whole. `slug` is the catalog's own
// natural key and the foreign key behaviors reference; `persona_id` is the
// resolved tanren persona this document projects onto.
export const catalogPersonas = pgTable(
  "catalog_personas",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    slug: text("slug").notNull(),
    schemaVersion: text("schema_version").notNull(),
    name: text("name").notNull(),
    // Free-form in tanren ON PURPOSE: the catalog that owns the documents
    // owns its own `world` vocabulary. A CHECK here would bake one product's
    // taxonomy into the platform.
    world: text("world").notNull(),
    aliases: jsonb("aliases")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // The body sections, in document order: [{heading, body}, …]. Ordered so the
    // document round-trips to Markdown byte-for-byte modulo trailing whitespace.
    sections: jsonb("sections")
      .notNull()
      .default(sql`'[]'::jsonb`),
    personaId: text("persona_id").notNull(),
    sourcePath: text("source_path").notNull(),
    sourceDigest: text("source_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The catalog's natural key IS the primary key — that is what makes a
    // re-import an upsert rather than a duplicate row.
    primaryKey({ columns: [table.orgId, table.projectId, table.slug] }),
    index("catalog_personas_org_id").on(table.orgId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "catalog_personas_project_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.personaId],
      foreignColumns: [personas.orgId, personas.id],
      name: "catalog_personas_persona_fk",
    }),
    check("catalog_personas_schema_check", sql`${table.schemaVersion} = 'tanren.persona.v0'`),
    check("catalog_personas_slug_check", sql`${table.slug} ~ '^[a-z][a-z0-9-]*$'`),
    check("catalog_personas_source_digest_check", sql`${table.sourceDigest} ~ ${digestPattern}`),
    catalogOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

// A `tanren.behavior.v0` document, stored whole. `catalog_id` is the immutable
// `B-####` the catalog assigns; it is the natural key for re-import.
export const catalogBehaviors = pgTable(
  "catalog_behaviors",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    catalogId: text("catalog_id").notNull(),
    schemaVersion: text("schema_version").notNull(),
    // Free-form for the same reason as `world` above.
    initiative: text("initiative").notNull(),
    title: text("title").notNull(),
    // The `## Intent` paragraph.
    intent: text("intent").notNull(),
    // The `## Observable outcomes` list, in document order.
    outcomes: jsonb("outcomes")
      .notNull()
      .default(sql`'[]'::jsonb`),
    provenance: jsonb("provenance")
      .notNull()
      .default(sql`'[]'::jsonb`),
    authors: jsonb("authors")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // The projected BDD row. Single-column FK because `behaviors` has no org_id
    // of its own (it is tenanted through its persona), so there is no same-org
    // composite to take — see the design note's "residual gaps".
    behaviorId: text("behavior_id").notNull(),
    sourcePath: text("source_path").notNull(),
    sourceDigest: text("source_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The immutable `B-####` IS the primary key: re-import is an upsert, and a
    // duplicate id can never become two rows.
    primaryKey({ columns: [table.orgId, table.projectId, table.catalogId] }),
    index("catalog_behaviors_org_id").on(table.orgId),
    index("catalog_behaviors_org_project").on(table.orgId, table.projectId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "catalog_behaviors_project_fk",
    }),
    foreignKey({
      columns: [table.behaviorId],
      foreignColumns: [behaviors.id],
      name: "catalog_behaviors_behavior_fk",
    }),
    check("catalog_behaviors_schema_check", sql`${table.schemaVersion} = 'tanren.behavior.v0'`),
    check("catalog_behaviors_catalog_id_check", sql`${table.catalogId} ~ ${catalogIdPattern}`),
    check("catalog_behaviors_source_digest_check", sql`${table.sourceDigest} ~ ${digestPattern}`),
    catalogOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

// The behavior's ORDERED persona list. `ordinal` 0 is the declared main
// beneficiary — the slug the BDD projection binds `behaviors.persona_id` to.
// The composite FK onto `catalog_personas` is what makes an unresolvable slug
// fail at the DATABASE, not merely in application code.
export const catalogBehaviorPersonas = pgTable(
  "catalog_behavior_personas",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    catalogId: text("catalog_id").notNull(),
    personaSlug: text("persona_slug").notNull(),
    ordinal: integer("ordinal").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.projectId, table.catalogId, table.personaSlug] }),
    index("catalog_behavior_personas_org_id").on(table.orgId),
    index("catalog_behavior_personas_slug").on(table.orgId, table.projectId, table.personaSlug),
    foreignKey({
      columns: [table.orgId, table.projectId, table.catalogId],
      foreignColumns: [catalogBehaviors.orgId, catalogBehaviors.projectId, catalogBehaviors.catalogId],
      name: "catalog_behavior_personas_behavior_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.personaSlug],
      foreignColumns: [catalogPersonas.orgId, catalogPersonas.projectId, catalogPersonas.slug],
      name: "catalog_behavior_personas_persona_fk",
    }),
    check("catalog_behavior_personas_ordinal_check", sql`${table.ordinal} >= 0`),
    catalogOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();

// The behavior's ORDERED `related` list, as real edges. Stored as rows rather
// than a jsonb blob so the catalog's own cross-references keep referential
// integrity (a dangling `B-####` is rejected by the FK) and are queryable in
// both directions; `ordinal` preserves the declared order, which the source
// format requires to match the body list exactly.
export const catalogBehaviorRelations = pgTable(
  "catalog_behavior_relations",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    catalogId: text("catalog_id").notNull(),
    relatedCatalogId: text("related_catalog_id").notNull(),
    ordinal: integer("ordinal").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.projectId, table.catalogId, table.ordinal] }),
    index("catalog_behavior_relations_org_id").on(table.orgId),
    index("catalog_behavior_relations_target").on(table.orgId, table.projectId, table.relatedCatalogId),
    foreignKey({
      columns: [table.orgId, table.projectId, table.catalogId],
      foreignColumns: [catalogBehaviors.orgId, catalogBehaviors.projectId, catalogBehaviors.catalogId],
      name: "catalog_behavior_relations_source_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.projectId, table.relatedCatalogId],
      foreignColumns: [catalogBehaviors.orgId, catalogBehaviors.projectId, catalogBehaviors.catalogId],
      name: "catalog_behavior_relations_target_fk",
    }),
    check("catalog_behavior_relations_ordinal_check", sql`${table.ordinal} >= 0`),
    check("catalog_behavior_relations_no_self_check", sql`${table.catalogId} <> ${table.relatedCatalogId}`),
    catalogOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
