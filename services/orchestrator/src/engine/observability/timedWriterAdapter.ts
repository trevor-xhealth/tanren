// observability: timing decorator for the Writer provider boundary.
// Implements WriterAdapter and delegates to a real adapter, emitting one
// structured timing record per runWriter call. The provider's core logic is
// NOT rewritten — this only measures latency at the call boundary.
//
// Kept in its own file (separate from the Answerer wrapper) so neither file
// mixes the writer and answerer execution paths, honoring the
// writer-answerer-separation architecture rule.
import type { WriterAdapter, WriterResult } from "../providers/types.js";
import { consoleTimingSink, timed, type TimingSink } from "./timing.js";

export function timedWriterAdapter(inner: WriterAdapter, sink: TimingSink = consoleTimingSink): WriterAdapter {
  return {
    kind: inner.kind,
    cli: inner.cli,
    authRef: inner.authRef,
    // Forward the wrapped adapter's REAL model id. THIS decorator is the instance
    // `buildWriterAdapter` hands the loop, so it is the object the cost recorder
    // reads `model` off (`args.adapter.model ?? ""` → `cost_records.model`).
    // Dropping it here silently blanked the recorded model for every production
    // writer call — and a blank model is exactly what makes the notional price
    // lookup unresolvable. Spread conditionally so an adapter that legitimately
    // declares none (a fake fixture) stays absent rather than becoming `undefined`.
    ...(inner.model !== undefined && { model: inner.model }),
    runWriter: (opts) =>
      timed<WriterResult>(
        {
          boundary: "provider",
          operation: "provider.write",
          sink,
          attributes: { cli: inner.cli, role: "writer" },
        },
        () => inner.runWriter(opts),
      ),
  };
}
