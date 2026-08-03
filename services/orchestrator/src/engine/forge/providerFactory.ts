// P1c: the production Forge answerer factory — the seam that makes every Forge
// ideation surface (interview / discovery / triage / brownfield recon / the ⌘K
// conversation) reason with a REAL model instead of a deterministic template.
//
// The provider answerers (`wrapProvider*Answerer`) all adapt an `AnswererAdapter`
// — the same Claude/Codex structured-output adapter the run loop resolves from
// the project's role-routing config (`adapterSelector.buildAnswererAdapter`).
// But the run loop builds that adapter against an ALREADY-allocated runner
// (an SSH target acquired for the run's lifetime). A Forge surface has no run,
// so each Forge model call must allocate its own short-lived runner, build the
// adapter against it, make the one structured call, then release.
//
// `forgeAllocatingAnswererAdapter` is that adapter: a thin `AnswererAdapter`
// whose `runAnswerer` resolves the project's credentials + `forge` routing chain
// head (default Codex — the same data-default the loop uses), allocates a runner,
// builds the real provider adapter, runs the one call, and ALWAYS releases. The
// per-surface factories below wrap it with the existing `wrapProvider*` adapters,
// so the route layer constructs a real provider answerer with zero new transport.
//
// There is no deterministic fallback here. If the project has no resolvable LLM
// credential, the allocate/resolve step throws — production hard-fails rather
// than silently degrading to a template (the §8a invariant). The deterministic
// answerers are test fixtures only (tests/fixtures/forgeAnswerers.ts).

import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { buildAnswererAdapter } from "../providers/adapterSelector.js";
import type { AnswererAdapter, AnswererRunOptions } from "../providers/types.js";
import type { RoutingChainEntry } from "../config/shared.js";
import { loadOrgRunnerContext, loadProjectRunnerContext } from "./runnerContext.js";
import { wrapProviderInterviewAnswerer, type InterviewAnswerer } from "./interview/index.js";
import { wrapProviderDiscoveryAnswerer, type DiscoveryAnswerer, type DiscoveryResult } from "./discovery/index.js";
import { wrapProviderTriageAnswerer, type TriageAnswerer, type CandidateTriage } from "./inbox/index.js";
import { wrapProviderReconAnswerer, type ReconTurn, type ReconTurnAnswerer } from "./brownfield/index.js";
import { wrapProviderSpecQualityAnswerer, type SpecQualityAnswerer } from "./specQuality/index.js";
import type { SpecQualityAnswer, SpecRevisionAnswer } from "../answerers/schemas/specQuality.js";
import { wrapProviderAuditAnswerer, type AuditAnswerer, type AuditPassReport } from "./audits/index.js";
import {
  wrapProviderAnswerer,
  type ForgeConversationAnswerer,
  type ForgeAnswererStepOutput,
} from "./conversation/index.js";
import type { InterviewRoundOutput } from "./interview/types.js";

/**
 * Everything a Forge answerer factory needs to allocate a runner and resolve a
 * provider adapter per call. Assembled once at app boot (the same allocator /
 * SSH substrate / identity ref the run worker uses) and shared across surfaces.
 */
export interface ForgeAnswererInfra {
  pool: pg.Pool;
  secrets: SecretStore;
  allocator: Allocator;
  ssh: CommandSubstrate;
  /** The runner identity key ref (same value `main.ts` seeds for the server). */
  identitySecretRef: string;
}

/**
 * The context a Forge model call resolves its credentials against. `projectId`
 * is present for project-scoped surfaces (discovery / triage / ⌘K / recon) and
 * absent for the GREENFIELD interview, which runs before a project exists and
 * resolves credentials from the org defaults.
 */
export interface ForgeAnswererTarget {
  orgId: string;
  projectId?: string;
}

/**
 * Build the chain entry the Forge adapter runs: the project's pinned `forge`
 * entry when present, else the resolved DEFAULT LLM entry (managed or BYOK,
 * provider-agnostic). Mirrors `buildEffectiveRouting`'s per-role default so the
 * Forge default is a DATA fact, not a hardcode.
 */
function forgeChainEntry(ctx: {
  routingForge: RoutingChainEntry | undefined;
  defaultLlm: RoutingChainEntry;
}): RoutingChainEntry {
  return ctx.routingForge ?? ctx.defaultLlm;
}

/**
 * The allocating Forge `AnswererAdapter`. Each `runAnswerer` is one model call:
 * resolve the project's credentials + forge routing, allocate a runner, build the
 * real provider adapter against it, run the call, and release in a `finally`.
 *
 * `runId` is a Forge-scoped synthetic id (`forge_<projectId>_<nonce>`) — a stable
 * NAMING handle for the runner / container / volume / CODEX_HOME path. It is NOT a
 * row in `runs`, so the allocation is marked `runless`: the persisted `runners`
 * row's run_id column is NULL and its project_id is the REAL project (project
 * surfaces) or NULL (the greenfield interview), avoiding the run_id→runs /
 * project_id→projects FK violations the synthetic handle would otherwise cause.
 */
export function forgeAllocatingAnswererAdapter<TOutput>(
  infra: ForgeAnswererInfra,
  target: ForgeAnswererTarget,
): AnswererAdapter<TOutput> {
  return {
    kind: "answerer",
    cli: "codex",
    authRef: "forge/allocating",
    async runAnswerer(opts: AnswererRunOptions<TOutput>): Promise<TOutput> {
      const ctx =
        target.projectId === undefined
          ? await loadOrgRunnerContext(infra.pool, target.orgId)
          : await loadProjectRunnerContext(infra.pool, target.projectId);
      const entry = forgeChainEntry(ctx);
      const scope = target.projectId ?? target.orgId;
      const runId = `forge_${scope}_${Math.random().toString(36).slice(2, 10)}`;
      const allocation = await infra.allocator.allocate({
        // `runId` / `projectId` are the NAMING handle (runner/container/volume).
        // A greenfield interview has no project, so the projectId carries an
        // org-scoped synthetic id for naming only.
        runId,
        projectId: target.projectId ?? `org:${target.orgId}`,
        runnerImage: ctx.runnerImage,
        identitySecretRef: infra.identitySecretRef,
        orgId: ctx.orgId,
        // A Forge ideation call has NO run — mark the allocation runless so the
        // persisted runners row writes run_id = NULL (no `runs` row) and
        // project_id = the REAL project (project surfaces) or NULL (greenfield
        // interview). Without this the synthetic handle violates the
        // run_id→runs / project_id→projects FKs.
        runless: true,
        persistedRunId: null,
        persistedProjectId: target.projectId ?? null,
      });
      try {
        const adapter = buildAnswererAdapter<TOutput>(
          {
            secrets: infra.secrets,
            ssh: infra.ssh,
            target: allocation.target,
            runId,
            ...(ctx.endpointBaseUrl === undefined ? {} : { endpointBaseUrl: ctx.endpointBaseUrl }),
          },
          entry,
          "forge",
        );
        return await adapter.runAnswerer(opts);
      } finally {
        await infra.allocator.release(allocation.runnerId, "completed");
      }
    },
  };
}

// ── Per-surface production factories ───────────────────────────────────────
//
// Each takes the boot-time `infra` and returns a per-request factory the route
// calls with its `(orgId, projectId)` target. The returned answerer is a real
// provider answerer (the `wrapProvider*` wrappers over the allocating adapter),
// so the route's production default reasons with a model — there is no
// deterministic fallback in any of these paths (§8a).

/** Build a production interview answerer factory (greenfield — org-scoped). */
export function buildForgeInterviewAnswererFactory(
  infra: ForgeAnswererInfra,
): (target: ForgeAnswererTarget) => InterviewAnswerer {
  return (target) => wrapProviderInterviewAnswerer(forgeAllocatingAnswererAdapter<InterviewRoundOutput>(infra, target));
}

/** Build a production discovery answerer factory (project-scoped). */
export function buildForgeDiscoveryAnswererFactory(
  infra: ForgeAnswererInfra,
): (target: ForgeAnswererTarget) => DiscoveryAnswerer {
  return (target) => wrapProviderDiscoveryAnswerer(forgeAllocatingAnswererAdapter<DiscoveryResult>(infra, target));
}

/** Build a production triage answerer factory (project-scoped via the source). */
export function buildForgeTriageAnswererFactory(
  infra: ForgeAnswererInfra,
): (target: ForgeAnswererTarget) => TriageAnswerer {
  return (target) => wrapProviderTriageAnswerer(forgeAllocatingAnswererAdapter<CandidateTriage>(infra, target));
}

/**
 * Build a production spec-quality VALIDATOR factory (project-scoped). The read-only
 * gate that judges every emitted spec against the four-part spec-quality contract
 * (workstream 1) before it lands in the DAG. Spec-emitting paths resolve a validator
 * from this and run it on their candidate specs.
 */
export function buildForgeSpecQualityAnswererFactory(
  infra: ForgeAnswererInfra,
): (target: ForgeAnswererTarget) => SpecQualityAnswerer {
  return (target) =>
    wrapProviderSpecQualityAnswerer(
      forgeAllocatingAnswererAdapter<SpecQualityAnswer>(infra, target),
      // The built-in re-author runs over the SAME forge routing (a second per-call
      // allocation) so the gate genuinely re-authors a failing spec from its guidance
      // before any escalation — never a give-up "after 0 revision(s)".
      forgeAllocatingAnswererAdapter<SpecRevisionAnswer>(infra, target),
    );
}

/** Build a production brownfield-recon answerer factory (project/org-scoped). */
export function buildForgeReconAnswererFactory(
  infra: ForgeAnswererInfra,
): (target: ForgeAnswererTarget) => ReconTurnAnswerer {
  return (target) => wrapProviderReconAnswerer(forgeAllocatingAnswererAdapter<ReconTurn>(infra, target));
}

/** Build a production scheduled-audit answerer factory (project-scoped). */
export function buildForgeAuditAnswererFactory(
  infra: ForgeAnswererInfra,
): (target: ForgeAnswererTarget) => AuditAnswerer {
  return (target) => wrapProviderAuditAnswerer(forgeAllocatingAnswererAdapter<AuditPassReport>(infra, target));
}

/** Build a production ⌘K conversation answerer factory (project-scoped). */
export function buildForgeConversationAnswererFactory(
  infra: ForgeAnswererInfra,
): (target: ForgeAnswererTarget) => ForgeConversationAnswerer {
  return (target) => wrapProviderAnswerer(forgeAllocatingAnswererAdapter<ForgeAnswererStepOutput>(infra, target));
}
