import { z } from "zod";

// Versioned Zod schema for `tanren-ci.yml` — the repo-sourced tiered CI
// contract. Tanren's native in-loop gate is the sole CI authority (Action-less
// delivery): it reads this contract and runs the declared shell steps over SSH.
// This module is the contract + parser ONLY — it never executes a step (the gate
// stage that runs the steps lives under workflow/gate/).

// ---- Lifecycle points -----------------------------------------------------

// The points in a run's lifecycle at which a tier may be invoked. A tier is
// mapped to one or more of these via the `when` policy below. Declarative so
// the in-loop gate can ask "which tiers run at this point?" without
// hard-coding tier names.
export const CiWhen = z.enum(["per_iteration", "pre_audit", "pre_merge"]);
export type CiWhen = z.infer<typeof CiWhen>;

// ---- Steps -----------------------------------------------------------------

// EVIDENCE CONTRACT (apex v57 task #64) — the POSITIVE PROOF a step must produce to
// be judged successful. The runtime gate (workflow/gate/runGateTier) checks for this
// evidence AFTER the step exits; a step that exits 0 with insufficient evidence FAILS
// the tier with `failedReason: "evidence_insufficient"`. This eradicates the v57
// green-by-accident class: `tsc --noEmit` over an empty `files` array passes while
// checking zero files; `vitest run` with no test files passes while running zero
// tests; `playwright test` with no browsers installed passes while running nothing.
// The negative-control doctrine (templates/negativeControls.ts §v29) is now ALSO
// enforced at every runtime gate, not just template-validation. Discriminated:
//   - `kind: "junit"`         — the step writes a JUnit report at `reportPath`; the
//                               gate parses it and asserts `total >= minTests`.
//                               `minTests` MUST be ≥ 1 (a 0 threshold is vacuous).
//                               `reportPath` MUST be a non-empty workspace path.
//   - `kind: "artifact"`      — the step writes an artifact at `path`; the gate stats
//                               it and asserts presence (+ `minBytes` when given).
//   - `kind: "stdout-count"`  — the step's stdout must contain `pattern` (a regex
//                               source) at least `min` times. `min` MUST be ≥ 1.
export const CiStepEvidence = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("junit"),
      reportPath: z.string().min(1),
      minTests: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("artifact"),
      path: z.string().min(1),
      minBytes: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("stdout-count"),
      pattern: z.string().min(1),
      min: z.number().int().min(1),
    })
    .strict(),
]);
export type CiStepEvidence = z.infer<typeof CiStepEvidence>;

// A single named shell command within a tier. `run` is an opaque shell string
// executed verbatim by the consumer; this module does not parse or validate
// shell syntax.
//
// `junitReport` is the LEGACY explicit CI-config contract for the CI-intelligence
// per-test grain: a step that runs tests DECLARES the workspace-relative path it
// writes its JUnit report to (e.g. `reports/junit.xml`). Tanren's native gate reads
// back EXACTLY that declared path after the step runs and ingests the per-test rows
// (flaky→quarantine→root-cause). This is a DECLARED field, never a command-string
// sniff: a step is "junit-producing" iff it sets `junitReport`, so the writer's
// actual test command (`just tier-2`, which does NOT mention the path) is recognized.
// STACK-AGNOSTIC: the path is the project's declaration — Tanren names no test runner,
// only honors the path the project says it emits. Absent ⇒ the step produces no grain
// (the clean no-op skip); present-but-absent-after-run ⇒ a LOUD `ci.junit_missing`.
//
// EVIDENCE BACK-COMPAT: a step that sets `junitReport: X` and OMITS `evidence` is
// promoted to `evidence: { kind: "junit", reportPath: X, minTests: 1 }` at the
// runtime gate (see {@link evidenceForStep} below). A step MAY also declare an
// explicit `evidence` block (e.g. a higher `minTests`); the explicit declaration
// always wins. A `junitReport` PLUS a non-junit `evidence` declaration is permitted
// (artifact + junit), but the junit promotion only applies when no `evidence` is set.
export const CiStep = z
  .object({
    name: z.string().min(1),
    run: z.string().min(1),
    junitReport: z.string().min(1).optional(),
    evidence: CiStepEvidence.optional(),
  })
  .strict();
export type CiStep = z.infer<typeof CiStep>;

/**
 * Resolve the EFFECTIVE evidence contract for a step — the runtime gate's positive-
 * proof requirement. An explicit `evidence` declaration always wins. Otherwise, a
 * legacy `junitReport: X` promotes to `{ kind: "junit", reportPath: X, minTests: 1 }`
 * so the back-compat path enforces "at least one test must run" without ceremony.
 * Returns `undefined` when the step declares neither — the step is judged on exit
 * code alone (the per-iteration cheap tiers: lint, typecheck).
 */
export function evidenceForStep(step: CiStep): CiStepEvidence | undefined {
  if (step.evidence !== undefined) return step.evidence;
  if (step.junitReport !== undefined) {
    return { kind: "junit", reportPath: step.junitReport, minTests: 1 };
  }
  return undefined;
}

// ---- Bootstrap -------------------------------------------------------------

// Optional install/bootstrap command run before any tier. workspace
// bootstrap reads this to provision dependencies (conventionally `just bootstrap`,
// deferring to the project's stack — Tanren names no tech stack itself).
export const CiBootstrap = z
  .object({
    run: z.string().min(1),
  })
  .strict();
export type CiBootstrap = z.infer<typeof CiBootstrap>;

// ---- Setup -----------------------------------------------------------------

// Optional `setup` verb — the project-declared command that prepares this WORKSPACE
// ONCE, before anything else runs in it.
//
// WHY IT IS NOT `bootstrap`. `bootstrap.run` is UNLATCHED by design: it runs before
// EVERY gate, because a writer that adds a dependency mid-run must get it installed
// before the next one, and the project's own recipe is the idempotency authority. That
// makes `bootstrap` the right home for "ensure this tree's dependencies are current" and
// the WRONG home for "install the native binaries this environment needs" — a
// multi-megabyte download per gate. A repository facing that choice does not fail loudly;
// it QUIETLY DECLARES LESS. Measured, in a real target repo's own contract:
//
//   # Deliberately not scripts/bootstrap.sh, which wants sudo, network and a
//   # terraform/tflint/gitleaks install on every gate.
//   bootstrap:
//     run: pnpm install --frozen-lockfile && uv sync --group dev
//
// The repository was right about the cost and correct to refuse it — and the consequence
// was that its own `.husky/pre-commit` then blocked every Tanren commit on
// `error: gitleaks is not installed or not on PATH`. Tanren had one preparation verb
// priced for one lifecycle phase, so the other phase went undeclared. This verb is that
// second phase, and having it is what makes the first one honest.
//
// SEMANTICS. At most once per workspace, latched on success (workspace/setup.ts). Runs
// AFTER the declared toolchain is provisioned (so it may use node/python/…) and BEFORE
// the project's `bootstrap`, so bootstrap may use whatever it installed. Same opaque
// `{ run }` shape as `bootstrap`/`upgrade`/`deploy`; Tanren never parses the shell.
//
// ABSENCE IS SEMANTIC — and there is deliberately NO default and NO convention-based
// detection of `scripts/bootstrap.sh` / `script/bootstrap` / `bin/setup` / `make setup`.
// A guess cannot read intent: against the repository above, detection would have executed
// the exact script that repository's contract states must not run. A declaration is
// intent. See workspace/setup.ts for the trust argument.
export const CiSetup = z
  .object({
    run: z.string().min(1),
  })
  .strict();
export type CiSetup = z.infer<typeof CiSetup>;

// ---- Upgrade ---------------------------------------------------------------

// Optional `upgrade` verb (environment-management.md §4.5 + §7 P1) — the
// project-declared command that BUMPS this project's dependencies to latest and
// regenerates its lockfile (conventionally `just upgrade`, deferring to the
// project's stack — Tanren names NO dependency-manager: `pnpm update --latest`,
// `cargo update`, `uv lock --upgrade`, `go get -u ./...`, …). Same opaque `{ run }`
// shape as `bootstrap`; Tanren never parses the shell.
//
// This verb only PRODUCES the new declaration/lockfile. What makes a version change
// SAFE is that it runs as a first-class DAG node through the same never-break-main
// gate as any code change (§4.5) — the upgrade-spec generator
// (engine/forge/upgrade/generator.ts) inserts it via the existing spec-creation path,
// NEVER as a side stream that mutates dependencies and merges un-gated. Optional: a
// project that declares no `upgrade` verb has no Tanren-driven forced-upgrade lever
// (the design's Renovate escape hatch is FUTURE work, not this verb).
export const CiUpgrade = z
  .object({
    run: z.string().min(1),
  })
  .strict();
export type CiUpgrade = z.infer<typeof CiUpgrade>;

// ---- Deploy ----------------------------------------------------------------

// Optional `deploy` verb — the project-declared command that releases the built
// artifact to its target (conventionally `just deploy`, deferring to the project's
// stack — Tanren names NO deploy tool). It is the ci.yml HOME for the lifecycle's
// `deploy` command (engine/forge/interview/types.ts; the lifecycle's first-class
// `deploy` point); a template-build's `deploy` spec projects its lifecycle deploy
// command HERE, so the strict `CiConfigV1` accepts a `.tanren/ci.yml` that carries
// it. Same opaque `{ run }` shape as `bootstrap`/`upgrade`; Tanren never parses the
// shell.
//
// STACK-AGNOSTIC + TARGET-AGNOSTIC: `run` holds ONLY the project's own deploy
// COMMAND — never a stack-specific (vercel/fly/…) branch. The deploy PROVIDER/TARGET
// (the app to release onto + its credentials) is a separate concern, resolved from
// the org's integration grants (engine/postMerge/deployTargetResolution.ts), not
// from this verb. Optional: a project that declares no `deploy` verb has no
// Tanren-runnable deploy COMMAND (absence is semantic — no silent fallback).
export const CiDeploy = z
  .object({
    run: z.string().min(1),
  })
  .strict();
export type CiDeploy = z.infer<typeof CiDeploy>;

// ---- Tiers -----------------------------------------------------------------

// The set of named tiers. `fast` and `slow` are REQUIRED so the in-loop gate
// always has a cheap per-iteration tier and an expensive pre-merge tier;
// additional named tiers are permitted for projects that want finer control.
export const CiTiers = z
  .object({
    fast: z.array(CiStep).min(1),
    slow: z.array(CiStep).min(1),
  })
  .catchall(z.array(CiStep).min(1));
export type CiTiers = z.infer<typeof CiTiers>;

// ---- When policy -----------------------------------------------------------

// Declarative mapping from tier name -> the lifecycle points at which it runs.
// Validated against the declared tiers (see CiConfigV1's superRefine) so a
// policy can never reference a tier that does not exist, and so every required
// tier participates in the lifecycle.
export const CiWhenPolicy = z.record(z.string().min(1), z.array(CiWhen).min(1));
export type CiWhenPolicy = z.infer<typeof CiWhenPolicy>;

// ---- Top-level config ------------------------------------------------------

export const CiConfigV1 = z
  .object({
    version: z.literal(1),
    // The project's ONCE-PER-WORKSPACE environment preparation (see `CiSetup`). Optional
    // + opaque; no default and no detection — a repository that declares none gets none.
    setup: CiSetup.optional(),
    bootstrap: CiBootstrap.optional(),
    // The project's dependency-bump command (environment-management.md §4.5/§7 P1).
    // Optional + opaque — see `CiUpgrade`. Tanren runs it inside a gated upgrade DAG
    // node, never a side stream.
    upgrade: CiUpgrade.optional(),
    // The project's deploy command (engine/forge/interview lifecycle `deploy`). Optional
    // + opaque — see `CiDeploy`. The ci.yml HOME for the lifecycle deploy command, so a
    // template-build's `deploy` spec can author a ci.yml that carries it (the strict
    // schema rejected it before this verb existed). Stack/target-agnostic: just the
    // project's COMMAND; the deploy provider/target is a separate org-integration concern.
    deploy: CiDeploy.optional(),
    tiers: CiTiers,
    when: CiWhenPolicy,
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const tierNames = new Set(Object.keys(cfg.tiers));
    // Every `when` key must name a declared tier.
    for (const tierName of Object.keys(cfg.when)) {
      if (!tierNames.has(tierName)) {
        ctx.addIssue({
          code: "custom",
          path: ["when", tierName],
          message: `when policy references unknown tier "${tierName}"`,
        });
      }
    }
    // Every declared tier must have a `when` mapping; an unmapped tier would
    // silently never run, which violates "fail loudly, never silently skip".
    for (const tierName of tierNames) {
      if (cfg.when[tierName] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["when", tierName],
          message: `tier "${tierName}" has no when policy entry`,
        });
      }
    }
    // §3.12 FAIL-CLOSED PRE_MERGE COVERAGE: at least one tier MUST map to `pre_merge`. The
    // `pre_merge` gate is the MERGE AUTHORITY — `runGateForWhen` returns a PASSING empty
    // verdict when no tier maps to it (an empty tier set is a vacuous pass), so a config that
    // leaves `pre_merge` uncovered makes `tanren/gate: success` a VACUOUS pass that lands
    // anything. A repo-sourced (writer-editable) ci.yml that drops pre_merge coverage must
    // FAIL the config (loud), never silently authorize an un-gated merge.
    const coversPreMerge = Object.values(cfg.when).some((points) => points.includes("pre_merge"));
    if (!coversPreMerge) {
      ctx.addIssue({
        code: "custom",
        path: ["when"],
        message:
          "no tier maps to `pre_merge` — the pre_merge gate is the merge authority; an uncovered pre_merge is a vacuous pass (fail-closed)",
      });
    }
    // EVIDENCE-GATED TIERS (apex v57 task #64): every tier mapped to `pre_audit` or
    // `pre_merge` MUST declare at least one step that produces POSITIVE evidence (either
    // an explicit `evidence` block or the legacy `junitReport`, which promotes). A
    // pre-merge tier that is only lint/typecheck cannot be the merge authority — it
    // exits 0 even when no real verification ran (the v57 green-by-accident class).
    // Fail-closed at config-resolve time so a writer-authored ci.yml that ships a
    // vacuous merge gate dies loud, not silently authorizing un-tested merges.
    for (const [tierName, points] of Object.entries(cfg.when)) {
      const evidenceGatedPoint = points.find((p) => p === "pre_audit" || p === "pre_merge");
      if (evidenceGatedPoint === undefined) continue;
      const steps = cfg.tiers[tierName] ?? [];
      const hasEvidence = steps.some((step) => step.evidence !== undefined || step.junitReport !== undefined);
      if (!hasEvidence) {
        ctx.addIssue({
          code: "custom",
          path: ["tiers", tierName],
          message:
            `tier "${tierName}" maps to "${evidenceGatedPoint}" but declares no step with positive evidence ` +
            "(every step is judged on exit code alone — the green-by-accident class). " +
            "Declare an `evidence` block (junit / artifact / stdout-count) on at least one step, " +
            "or set `junitReport` on the test step (back-compat: promotes to junit evidence with minTests: 1).",
        });
      }
    }
  });
export type CiConfigV1 = z.infer<typeof CiConfigV1>;

export const SUPPORTED_CI_CONFIG_VERSIONS: ReadonlyArray<number> = [1];
