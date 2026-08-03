// observability: timing decorator for the Answerer provider boundary.
// Implements AnswererAdapter and delegates to a real adapter, emitting one
// structured timing record per runAnswerer call. The provider's core logic is
// NOT rewritten — this only measures latency at the call boundary.
//
// Kept in its own file (separate from the Writer wrapper) so neither file
// mixes the writer and answerer execution paths, honoring the
// writer-answerer-separation architecture rule.
import type { AnswererAdapter, AnswererRunOptions } from "../providers/types.js";
import { consoleTimingSink, timed, type TimingSink } from "./timing.js";

export function timedAnswererAdapter<TOutput>(
  inner: AnswererAdapter<TOutput>,
  role: string,
  sink: TimingSink = consoleTimingSink,
): AnswererAdapter<TOutput> {
  return {
    kind: inner.kind,
    cli: inner.cli,
    authRef: inner.authRef,
    // Forward the wrapped adapter's REAL model id — see timedWriterAdapter: this
    // decorator is the instance the loop holds, so it is what the cost recorder
    // reads `model` off for `cost_records.model`. Absent when the inner adapter
    // declares none (a fake fixture).
    ...(inner.model !== undefined && { model: inner.model }),
    // Forward the wrapped adapter's per-call token telemetry so the cost path can
    // read it through this timing decorator (the decorator is the instance the loop
    // holds). Absent when the inner adapter exposes none (e.g. a fake fixture).
    ...(inner.lastTokenUsage !== undefined && { lastTokenUsage: () => inner.lastTokenUsage?.() }),
    runAnswerer: (opts: AnswererRunOptions<TOutput>) =>
      timed<TOutput>(
        {
          boundary: "provider",
          operation: "provider.answer",
          sink,
          attributes: { cli: inner.cli, role },
        },
        () => inner.runAnswerer(opts),
      ),
  };
}
