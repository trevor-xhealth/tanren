// P1c: the bundle of production Forge answerer factories the route mount wires.
//
// `mountFeatureRoutes` assembles one `ForgeAnswererInfra` (allocator + SSH +
// identity ref) and needs a per-surface answerer factory for each Forge route.
// Bundling them here keeps the mount table's import surface to a single entry
// (and under the module dependency cap) while each factory stays independently
// testable in providerFactory.ts.

import {
  buildForgeAuditAnswererFactory,
  buildForgeConversationAnswererFactory,
  buildForgeDiscoveryAnswererFactory,
  buildForgeInterviewAnswererFactory,
  buildForgeReconAnswererFactory,
  buildForgeTriageAnswererFactory,
  type ForgeAnswererInfra,
  type ForgeAnswererTarget,
} from "./providerFactory.js";
import type { Hono } from "hono";
import { buildForgeDesignAgentFactory } from "./designAgentFactory.js";
import { buildForgeDesignSystemComposerFactory } from "./designSystemComposerFactory.js";
import { buildForgeFragmentAuthorerFactory } from "./fragmentAuthorerFactory.js";
import { buildForgeIntegrationFragmentAuthorerFactory } from "./integrationFragmentAuthorerFactory.js";
import type { ComposeDesignSystemCallback } from "./interview/index.js";
import type { DesignAgent } from "../design/designAgent.js";
import type { InterviewAnswerer } from "./interview/index.js";
import type { DiscoveryAnswerer } from "./discovery/index.js";
import type { TriageAnswerer } from "./inbox/index.js";
import type { ReconTurnAnswerer } from "./brownfield/index.js";
import { createAnswererPassRunner, type AuditAnswerer, type AuditPassRunner } from "./audits/index.js";
import type { ForgeConversationAnswerer } from "./conversation/index.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { FragmentAuthorer } from "../templates/index.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { mountGovernanceRoutes } from "../../routes/governance/mount.js";

export interface ForgeRouteAnswererFactories {
  interview: (target: ForgeAnswererTarget) => InterviewAnswerer;
  // WS-D3: the design AGENT factory — the derive's design phase elaborates the
  // captured intent into the designed HEAD `DesignContract` (org-scoped, greenfield).
  designAgent: (target: ForgeAnswererTarget) => DesignAgent;
  discovery: (target: ForgeAnswererTarget) => DiscoveryAnswerer;
  triage: (target: ForgeAnswererTarget) => TriageAnswerer;
  recon: (target: ForgeAnswererTarget) => ReconTurnAnswerer;
  audit: (target: ForgeAnswererTarget) => AuditAnswerer;
  conversation: (target: ForgeAnswererTarget) => ForgeConversationAnswerer;
  /** F2 — per-fragment authoring (docs/roadmap/templating-system.md): a real
   * LLM-backed authorer that produces a Fragment body for a missing slot. */
  fragmentAuthorer: (target: ForgeAnswererTarget) => FragmentAuthorer;
  /** in-7 — the F2 authorer for MISSING provider integration definition fragments
   * (the integration derivation seam authors them writer→validate, convergent). */
  integrationFragmentAuthorer: ReturnType<typeof buildForgeIntegrationFragmentAuthorerFactory>;
  /** ds-composer — the DESIGN-SYSTEM COMPOSITION seam: compose+publish the project's
   * web design system during derive (authoring the missing ds-3 fragments via F2D). */
  designSystemComposer: () => ComposeDesignSystemCallback;
  /**
   * Build the REAL scheduled-audit pass runner (the audit route's production
   * runner: it indexes the project's repo READ-ONLY and has the audit answerer
   * surface findings). Takes the repo-read GitHub infra (the answerer infra alone
   * has no GitHub client). Colocated here so the route mount adds NO new import.
   */
  auditPassRunnerFor: (github: {
    githubHttp: GitHubHttpClient;
    githubAppMinter?: GithubAppTokenMinter;
  }) => AuditPassRunner;
  mountGovernanceRoutes: (app: Hono<ActorContextEnv>) => void;
}

/** Build every per-surface Forge answerer factory from the shared infra. */
export function buildForgeRouteAnswererFactories(infra: ForgeAnswererInfra): ForgeRouteAnswererFactories {
  const audit = buildForgeAuditAnswererFactory(infra);
  return {
    interview: buildForgeInterviewAnswererFactory(infra),
    designAgent: buildForgeDesignAgentFactory(infra),
    discovery: buildForgeDiscoveryAnswererFactory(infra),
    triage: buildForgeTriageAnswererFactory(infra),
    recon: buildForgeReconAnswererFactory(infra),
    audit,
    conversation: buildForgeConversationAnswererFactory(infra),
    fragmentAuthorer: buildForgeFragmentAuthorerFactory(infra),
    integrationFragmentAuthorer: buildForgeIntegrationFragmentAuthorerFactory(infra),
    designSystemComposer: buildForgeDesignSystemComposerFactory(infra),
    mountGovernanceRoutes: (app) => mountGovernanceRoutes(app, infra),
    auditPassRunnerFor: (github) =>
      createAnswererPassRunner({
        pool: infra.pool,
        secrets: infra.secrets,
        githubHttp: github.githubHttp,
        ...(github.githubAppMinter === undefined ? {} : { githubAppMinter: github.githubAppMinter }),
        answererFactory: audit,
      }),
  };
}
