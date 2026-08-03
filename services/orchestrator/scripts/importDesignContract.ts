#!/usr/bin/env tsx
// Import a BROWNFIELD design contract into a live project.
//
// WHY THIS EXISTS. Tanren can only ever ACQUIRE a `DesignContract` by AUTHORING
// one: `deriveDesignContract.ts` (the forge interview) and `designPhase.ts` (the
// design agent) are the only two writers of the `design_contracts` table, and
// neither is reachable without running a full greenfield derive. There is no HTTP
// route, no CLI, and no store method that takes an already-existing design system
// and records it. That is a real gap for the brownfield case: a repository that
// ALREADY has a design system (2,000 hand-maintained tokens, 100+ components, a
// frozen token file with no generator) has nothing to derive — its design contract
// is a description of an artifact that exists, not an invention.
//
// This script is that missing surface: a one-way INGEST of a hand-authored,
// schema-valid contract into a project's `design_contracts` HEAD.
//
// PERSISTS V2, NOT V1. `DesignContractStore.create` routes the contract through
// `designContractToJson` (a V1 normalize), which STRIPS every V2-only field —
// `targetProfiles`, `desiredSurfaces`, `exportRequirements`, `acceptanceIntent`
// and the `visualVerification` knob would all be silently dropped. The store's own
// `mapRow` explicitly supports the other shape ("a full-V2 capture persists V2
// natively"), downgrading to a V1 view for the writer while `rawContract` keeps the
// V2 fields for `composeProjectTargetDesignSystems`. So this script writes the V2
// blob directly and proves BOTH reads before committing:
//   · `parseDesignContractV2` — the V2 readers' parse;
//   · the V1 downgrade `mapRow` performs — the WRITER's parse.
// A blob that fails either one never reaches the table.
//
// NO SILENT DEFAULTS, matching the schema's own posture: every failure here is a
// loud throw. A half-landed design import is the specific hazard this guards —
// `subtaskWriterPrompt.ts` gives a writer NO design block when the contract is
// absent and never a fabricated default, so a partial import degrades the writer
// silently and invisibly.
//
// Usage:
//   tsx services/orchestrator/scripts/importDesignContract.ts \
//     --contract <path/to/design-contract.json> \
//     --org <org_id> --project <project_id> [--dry-run]

import { readFile } from "node:fs/promises";
import { argv, env, exit } from "node:process";
import { Pool } from "pg";
import {
  DesignContractV1 as DesignContractV1Schema,
  normalizeDesignContract,
} from "../src/engine/design/designContract.js";
import {
  designContractV2Digest,
  parseDesignContractV2,
  type DesignContractV2,
} from "../src/engine/design/system/designContractV2.js";

interface Args {
  readonly contractPath: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly dryRun: boolean;
}

function parseArgs(raw: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = raw.indexOf(flag);
    return index === -1 ? undefined : raw[index + 1];
  };
  const contractPath = get("--contract");
  const orgId = get("--org");
  const projectId = get("--project");
  if (contractPath === undefined || orgId === undefined || projectId === undefined) {
    throw new Error("usage: --contract <path> --org <org_id> --project <project_id> [--dry-run]");
  }
  return { contractPath, orgId, projectId, dryRun: raw.includes("--dry-run") };
}

/**
 * Re-run the EXACT downgrade `designContracts.ts#mapRow` performs on read, so a
 * contract that the writer path could not parse is rejected here rather than
 * discovered later as a `corrupt` lookup that throws mid-run.
 */
function assertWriterViewParses(contract: DesignContractV2): void {
  const v1View = {
    version: 1 as const,
    domain: contract.domain,
    identity: contract.identity,
    intent: contract.intent,
    principles: contract.principles,
    constraints: contract.constraints,
    personaRefs: contract.personaRefs,
    behaviorRefs: contract.behaviorRefs,
    dimensions: contract.dimensions,
    accessibilityPosture: contract.accessibilityPosture,
  };
  const parsed = DesignContractV1Schema.safeParse(v1View);
  if (!parsed.success) {
    throw new Error(
      `contract does not downgrade to a readable V1 writer view: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  normalizeDesignContract(parsed.data);
}

async function main(): Promise<void> {
  const args = parseArgs(argv.slice(2));
  const raw: unknown = JSON.parse(await readFile(args.contractPath, "utf8"));

  // Loud parse #1 — the V2 readers' view (composeProjectTargetDesignSystems).
  const contract = parseDesignContractV2(raw);
  // Loud parse #2 — the V1 downgrade the WRITER actually renders from.
  assertWriterViewParses(contract);

  const digest = designContractV2Digest(contract);
  console.log(`contract parsed: domain=${contract.domain} dimensions=${contract.dimensions.length}`);
  console.log(`  principles=${contract.principles.length} constraints=${contract.constraints.length}`);
  console.log(`  personaRefs=${contract.personaRefs.length} behaviorRefs=${contract.behaviorRefs.length}`);
  console.log(`  a11y=${contract.accessibilityPosture.standard} visualVerification=${contract.visualVerification.enabled}`);
  console.log(`  digest=${digest}`);
  if (args.dryRun) {
    console.log("dry run — nothing written");
    return;
  }

  const connectionString = env["TANREN_IMPORT_DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    throw new Error("TANREN_IMPORT_DATABASE_URL must be set (the RLS-scoped app role, not the migration role)");
  }
  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Org scope so the INSERT is subject to the SAME RLS policy every runtime
      // read is (`rls_org_isolation` USING/WITH CHECK on org_id). A mis-scoped
      // import is rejected by the policy rather than landing an unreadable row.
      await client.query(`SET LOCAL app.current_org_id = '${args.orgId.replaceAll("'", "''")}'`);
      const result = await client.query<{ id: string; version: number }>(
        `INSERT INTO design_contracts (id, org_id, project_id, version, domain, contract, updated_at)
         VALUES (
           $1, $2, $3,
           COALESCE((SELECT MAX(version) FROM design_contracts WHERE project_id = $3), 0) + 1,
           $4, $5::jsonb, now()
         )
         RETURNING id, version`,
        [
          `design_${crypto.randomUUID()}`,
          args.orgId,
          args.projectId,
          contract.domain,
          JSON.stringify(contract),
        ],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (row === undefined) throw new Error("insert returned no row");
      console.log(`imported: id=${row.id} version=${row.version} project=${args.projectId}`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
}
