// The `issues` source-kind dispatcher.
//
// The connector map is keyed by `SourceKind`, and `inbox_sources.kind` is
// CHECK-constrained, so every issue-tracker provider shares the one `issues`
// slot. This dispatcher resolves the provider through `resolveIssuesProvider` —
// the SAME fail-closed resolver the route boundary and each connector use, so
// there is one authority on "which provider is this", not three — and delegates.
//
// An unsupported provider throws out of the resolver before either connector is
// touched, so widening the kind to Linear does not widen it to anything else.

import { resolveIssuesProvider } from "./connectorErrors.js";
import type { IngestedItem, InboxSource, SourceConnector } from "./types.js";

export interface IssuesDispatcherDeps {
  github: SourceConnector;
  linear: SourceConnector;
}

export function createIssuesDispatcher(deps: IssuesDispatcherDeps): SourceConnector {
  return {
    kind: "issues",
    async fetch(source: InboxSource): Promise<IngestedItem[]> {
      const provider = resolveIssuesProvider(source.config);
      return provider === "linear" ? deps.linear.fetch(source) : deps.github.fetch(source);
    },
  };
}
