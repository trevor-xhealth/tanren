// The catalog tables are tenant tables: RLS must be enabled in the drizzle
// model (the migration additionally FORCEs it), the org isolation policy must
// carry BOTH `using` and `withCheck`, and every relationship crossing a
// tenant-owned table must use a COMPOSITE same-org foreign key.
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  catalogBehaviorPersonas,
  catalogBehaviorRelations,
  catalogBehaviors,
  catalogPersonas,
} from "../src/schemaCatalog.js";
import { personas } from "../src/schemaProductEntities.js";

function named(table: (typeof TABLES)[number][1], constraint: string) {
  return getTableConfig(table).foreignKeys.find((key) => key.getName() === constraint);
}

const TABLES = [
  ["catalog_personas", catalogPersonas],
  ["catalog_behaviors", catalogBehaviors],
  ["catalog_behavior_personas", catalogBehaviorPersonas],
  ["catalog_behavior_relations", catalogBehaviorRelations],
] as const;

describe("catalog table tenancy", () => {
  it.each(TABLES)("%s enables RLS with a using + withCheck org policy", (name, table) => {
    const config = getTableConfig(table);
    expect(config.name).toBe(name);
    expect(config.enableRLS).toBe(true);
    const policy = config.policies.find((candidate) => candidate.name === "rls_org_isolation");
    expect(policy).toBeDefined();
    expect(policy?.for).toBe("all");
    expect(policy?.using).toBeDefined();
    expect(policy?.withCheck).toBeDefined();
  });

  it("keys every catalog table by org_id first", () => {
    for (const [, table] of TABLES) {
      const config = getTableConfig(table);
      expect(config.primaryKeys[0]?.columns[0]?.name).toBe("org_id");
    }
  });

  it("uses composite same-org foreign keys for every tenant-owned parent", () => {
    for (const [name, columns] of [
      ["catalog_personas_project_fk", ["org_id", "project_id"]],
      ["catalog_personas_persona_fk", ["org_id", "persona_id"]],
    ] as const) {
      expect(
        named(catalogPersonas, name)
          ?.reference()
          .columns.map((column) => column.name),
      ).toEqual([...columns]);
    }
    expect(
      named(catalogBehaviors, "catalog_behaviors_project_fk")
        ?.reference()
        .columns.map((c) => c.name),
    ).toEqual(["org_id", "project_id"]);
    for (const [table, name] of [
      [catalogBehaviorPersonas, "catalog_behavior_personas_behavior_fk"],
      [catalogBehaviorPersonas, "catalog_behavior_personas_persona_fk"],
      [catalogBehaviorRelations, "catalog_behavior_relations_source_fk"],
      [catalogBehaviorRelations, "catalog_behavior_relations_target_fk"],
    ] as const) {
      expect(named(table, name)?.reference().columns[0]?.name).toBe("org_id");
    }
  });

  it("gives personas the (org_id, id) unique the same-org foreign key needs", () => {
    const unique = getTableConfig(personas).indexes.find((index) => index.config.name === "personas_org_id_unique");
    expect(unique?.config.unique).toBe(true);
    expect(unique?.config.columns.map((column) => ("name" in column ? column.name : ""))).toEqual(["org_id", "id"]);
  });
});
