// P1c: the provider-backed recon answerer (the real LLM seam).
//
// Adapts an `AnswererAdapter` (Claude/Codex, resolved via adapterSelector) into
// the `ReconTurnAnswerer` seam. Each `turn` is still exactly ONE structured
// provider call — the exploration loop that drives many of them lives in
// `reconExploration.ts`, the way the writer's inner loop lives in the workflow
// engine rather than inside a writer adapter. Production wires this through the
// route's `reconAnswererFactory`; tests use a fake answerer so no test hits a
// provider.
//
// TWO SCHEMAS, ONE SEAM. An exploring turn may ask for more or report; a
// FINALIZE turn is rendered against a NARROWED schema that admits only a report.
// That narrowing is what makes the loop's termination structural rather than
// hoped-for: at convergence the model is not asked nicely to stop, it is handed
// an output shape in which "keep going" is unrepresentable.

import { z } from "zod";
import { renderAnswererJsonSchema } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { buildReconTurnPrompt } from "./explorationPrompt.js";
import { ReconReport, ReconTurn, type ReconTurnAnswerer, type ReconTurnInput } from "./types.js";

const SCHEMA_NAME = "tanren.brownfield_recon.v1";
const FINAL_SCHEMA_NAME = "tanren.brownfield_recon_final.v1";

/** The finalize turn's output: a report, and nothing that could ask for more. */
const ReconFinalTurn = z
  .object({
    notes: z.string().max(4000).default(""),
    report: ReconReport,
  })
  .strict();

// No bounding option remains: each provider answerer call is governed by the agent
// ActivityWatchdog (output-driven, never a wall-clock kill) the adapter constructs.
export type WrapProviderReconAnswererOptions = Record<never, never>;

export function wrapProviderReconAnswerer(
  adapter: AnswererAdapter<ReconTurn>,
  _options: WrapProviderReconAnswererOptions = {},
): ReconTurnAnswerer {
  const turnSchema = renderAnswererJsonSchema(ReconTurn);
  const finalSchema = renderAnswererJsonSchema(ReconFinalTurn);
  return {
    async turn(input: ReconTurnInput): Promise<ReconTurn> {
      const prompt = buildReconTurnPrompt(input);
      if (!input.finalize) {
        return adapter.runAnswerer({
          prompt,
          outputSchema: { name: SCHEMA_NAME, jsonSchema: turnSchema, parse: (value) => ReconTurn.parse(value) },
        });
      }
      return adapter.runAnswerer({
        prompt,
        outputSchema: {
          name: FINAL_SCHEMA_NAME,
          jsonSchema: finalSchema,
          parse: (value) => {
            const final = ReconFinalTurn.parse(value);
            return { status: "report", notes: final.notes, requests: [], report: final.report };
          },
        },
      });
    },
  };
}
