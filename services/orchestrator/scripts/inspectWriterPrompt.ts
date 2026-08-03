#!/usr/bin/env tsx
// Assemble and print the REAL writer prompt for a UI subtask on a live project.
//
// This is prompt INSPECTION, not model interrogation. It calls the two production
// functions that decide what a writer sees, in the same order the run worker calls
// them (`runExecutionContext.ts` → `subtaskWriterPrompt.ts`):
//
//   1. `loadDesignContextBlock` — reads the project's HEAD `design_contracts` row
//      under org scope, resolves its persona/behavior refs against the entity graph,
//      and renders the design block. Returns `undefined` when there is no contract.
//   2. `writerPromptFor` — assembles the full writer prompt, slotting the design
//      block in if and only if it is defined.
//
// Run it before and after an import and diff the two outputs: the difference IS the
// design system's effect on the writer, with nothing inferred.
//
// Usage:
//   tsx services/orchestrator/scripts/inspectWriterPrompt.ts \
//     --org <org_id> --project <project_id> [--out <file>]

import { writeFile } from "node:fs/promises";
import { argv, env, exit } from "node:process";
import { Pool } from "pg";
import { loadDesignContextBlock } from "../src/engine/design/designWriterContext.js";
import { writerPromptFor } from "../src/engine/workflow/subtaskWriterPrompt.js";

// A representative UI subtask — the case the whole design import is meant to serve.
const SUBTASK = {
  index: 1,
  title: "Add a member medication-adherence summary card to the dashboard",
  intent:
    "Build a card that shows a member's medication adherence rate for the current month, with a trend indicator and a link to the full medication list.",
  behaviorIds: [] as string[],
};

const SPEC_TITLE = "Medication adherence summary card";
const SPEC_DESCRIPTION =
  "Members and their care team need an at-a-glance read of medication adherence on the dashboard. Add a card presenting the current-month adherence percentage, a trend against last month, and a link through to the medication list.";
const ACCEPTANCE_CRITERIA = [
  "The card renders the current-month adherence percentage.",
  "The card shows a trend indicator comparing against the previous month.",
  "The card links to the full medication list.",
  "The card is keyboard reachable and screen-reader labelled.",
];

function arg(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const orgId = arg("--org");
  const projectId = arg("--project");
  const out = arg("--out");
  if (orgId === undefined || projectId === undefined) {
    throw new Error("usage: --org <org_id> --project <project_id> [--out <file>]");
  }
  const connectionString = env["TANREN_IMPORT_DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    throw new Error("TANREN_IMPORT_DATABASE_URL must be set");
  }

  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    let designContextBlock: string | undefined;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL app.current_org_id = '${orgId.replaceAll("'", "''")}'`);
      // The exact production call, with the run's org-scoped client.
      designContextBlock = await loadDesignContextBlock({
        client,
        orgScope: { kind: "org", orgId },
        projectId,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const context = {
      runId: "run_inspect",
      specId: "spec_inspect",
      projectId,
      orgId,
      workspacePath: "/workspace",
      specTitle: SPEC_TITLE,
      specDescription: SPEC_DESCRIPTION,
      acceptanceCriteria: ACCEPTANCE_CRITERIA,
      // The fixture is a pre-existing repository, so its specs run in this mode.
      specMode: "modify_existing",
      ...(designContextBlock !== undefined && { designContextBlock }),
    };

    const prompt = writerPromptFor(
      { context } as unknown as Parameters<typeof writerPromptFor>[0],
      SUBTASK as unknown as Parameters<typeof writerPromptFor>[1],
      0,
      "",
    );

    const banner =
      `=== design block: ${designContextBlock === undefined ? "ABSENT" : `PRESENT (${designContextBlock.length} chars)`} ===\n` +
      `=== prompt length: ${prompt.length} chars ===\n`;
    if (out === undefined) {
      console.log(banner + prompt);
    } else {
      await writeFile(out, prompt, "utf8");
      console.log(banner + `written to ${out}`);
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
