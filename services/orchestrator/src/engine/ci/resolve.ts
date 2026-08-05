import type { z } from "zod";
import { CiConfigV1, SUPPORTED_CI_CONFIG_VERSIONS } from "./schema.js";
import type { CiStep, CiWhen } from "./schema.js";
import { CiYamlParseError, parseYaml } from "./yaml.js";

// Loader + resolver for `tanren-ci.yml`. Turns raw YAML text into a validated,
// typed config — or yields the documented default when the file is absent.
// Invalid input ALWAYS throws (never silently degrades to the default) so a
// misconfigured repo fails the gate loudly instead of running an empty tier
// set. This module performs no execution.

// Thrown when YAML parsed cleanly but did not satisfy the schema (e.g. a tier
// with no steps, an unknown `when` value, an unmapped tier). Distinct from
// CiYamlParseError (syntax) so callers can report the two classes separately.
export class CiConfigValidationError extends Error {
  readonly issues: ReadonlyArray<z.core.$ZodIssue>;
  constructor(issues: ReadonlyArray<z.core.$ZodIssue>) {
    const summary = issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    super(`invalid tanren-ci.yml: ${summary}`);
    this.name = "CiConfigValidationError";
    this.issues = issues;
  }
}

export { CiYamlParseError };

// The conventional workspace path a test tier writes its JUnit report to. The
// native gate's per-test ingest (`ingestGateJunit`) reads back EXACTLY this path
// over SSH to feed CI-intelligence (flaky detection + quarantine). A project whose
// `just tier-2` runs tests MUST emit to this path or there is no per-test grain;
// keep this the single source of truth so the writer side and the read side agree.
// The COMMAND that writes it is the project's (inside `just tier-2`) — Tanren names
// no test runner; only the OUTPUT path convention is fixed.
export const JUNIT_REPORT_PATH = "reports/junit.xml";

// The built-in 3-tier default used when a repo ships no `.tanren/ci.yml`. STACK-
// AGNOSTIC: every step defers to `just <target>`, so Tanren names NO tech stack —
// the stack commands live in the project's `justfile` (the project CONTRACT; see
// engine/forge/scaffold/skeleton.ts). The three tiers map 1:1 to the spec-loop's
// lifecycle points:
//   - fast   (per_iteration) — `just tier-1`: the cheap per-iteration gate (e.g.
//     lint + typecheck). NO tests here — tests arrive with features, so a scaffold
//     pass is never blocked by a test tier.
//   - slow   (pre_audit)     — `just tier-2`: build + tests, the tier that DECLARES its
//     JUnit report + a POSITIVE EVIDENCE contract (`evidence: { kind: "junit", ... }`,
//     `minTests: 1`) for the v57 task #64 green-by-accident class — exit-0 with zero
//     tests run no longer passes the gate; the harvester demands at least one test in
//     the parsed report. `junitReport` stays declared for the per-test ingest contract
//     (CI-intelligence reads back EXACTLY that path).
//   - merge  (pre_merge)     — `just tier-3`: the heaviest thorough gate, the
//     merge-queue authority. ALSO declares JUnit evidence with `minTests: 1` so the
//     merge gate cannot ship green-by-accident (the v57 merge-gate-not-full-bar class).
// `bootstrap.run` is `just bootstrap`. This default mirrors the skeleton's ci.yml
// (engine/forge/scaffold/skeleton.ts) — both are the same lifecycle map.
// `upgrade.run` is `just upgrade` (environment-management.md §4.5/§7 P1): the
// dependency-bump verb a version-change DAG node runs. Like every other verb it
// defers to `just <target>`; the actual bump command lives in the project's justfile.
// `deploy.run` is `just deploy`: the project's deploy COMMAND (the ci.yml home for the
// lifecycle deploy point). Stack/target-agnostic — defers to `just deploy`; the deploy
// provider/target is a separate org-integration concern (deployTargetResolution.ts).
export const DEFAULT_CI_CONFIG: CiConfigV1 = Object.freeze(
  CiConfigV1.parse({
    version: 1,
    bootstrap: { run: "just bootstrap" },
    upgrade: { run: "just upgrade" },
    deploy: { run: "just deploy" },
    tiers: {
      fast: [{ name: "tier-1", run: "just tier-1" }],
      slow: [
        {
          name: "tier-2",
          run: "just tier-2",
          junitReport: JUNIT_REPORT_PATH,
          evidence: { kind: "junit", reportPath: JUNIT_REPORT_PATH, minTests: 1 },
        },
      ],
      merge: [
        {
          name: "tier-3",
          run: "just tier-3",
          junitReport: JUNIT_REPORT_PATH,
          evidence: { kind: "junit", reportPath: JUNIT_REPORT_PATH, minTests: 1 },
        },
      ],
    },
    when: {
      fast: ["per_iteration"],
      slow: ["pre_audit"],
      merge: ["pre_merge"],
    },
  }),
);

// Parse + validate raw YAML text into a typed config. `undefined` (no file in
// the repo) resolves to DEFAULT_CI_CONFIG. Throws CiYamlParseError on syntax
// errors and CiConfigValidationError on schema violations.
export function resolveCiConfig(yamlText: string | undefined): CiConfigV1 {
  if (yamlText === undefined) {
    return DEFAULT_CI_CONFIG;
  }
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    if (error instanceof CiYamlParseError) {
      throw error;
    }
    throw new CiYamlParseError(error instanceof Error ? error.message : String(error), 0);
  }
  const result = CiConfigV1.safeParse(raw);
  if (!result.success) {
    throw new CiConfigValidationError(result.error.issues);
  }
  return result.data;
}

// ---- Consumer surface ------------------------------------------------------
// Small helpers the in-loop gate and CI poller call. They operate on a
// resolved config so callers never re-derive policy from raw shapes.

// All tier names whose `when` policy includes the given lifecycle point, in a
// stable order (fast, slow, then any extra tiers alphabetically). The gate
// runs these tiers' steps at that point.
export function tiersFor(config: CiConfigV1, when: CiWhen): string[] {
  return orderedTierNames(config).filter((name) => (config.when[name] ?? []).includes(when));
}

// The ordered list of named steps to run at a lifecycle point: every step of
// every tier mapped to `when`, in tier order then step order.
export function stepsFor(config: CiConfigV1, when: CiWhen): CiStep[] {
  return tiersFor(config, when).flatMap((name) => config.tiers[name] ?? []);
}

// The bootstrap/install command, or undefined when the repo declares none.
export function bootstrapCommand(config: CiConfigV1): string | undefined {
  return config.bootstrap?.run;
}

// The ONCE-PER-WORKSPACE environment-preparation command (see `CiSetup`), or undefined
// when the repo declares no `setup` verb.
//
// ABSENCE IS SEMANTIC, and note what DEFAULT_CI_CONFIG does NOT contain: unlike
// `bootstrap`/`upgrade`/`deploy`, there is no `setup: { run: "just setup" }` default. A
// default would make every repository that ships no `.tanren/ci.yml` — every greenfield
// scaffold, on its very first prep — run a `just setup` recipe that does not exist, and
// halt. The other verbs can afford a `just <verb>` default because they are invoked at
// points where a justfile is already the contract; workspace setup runs before anything,
// on a tree that may still be empty. So: declared or absent, nothing in between.
export function setupCommand(config: CiConfigV1): string | undefined {
  return config.setup?.run;
}

// The dependency-bump command a version-change DAG node runs (environment-
// management.md §4.5/§7 P1), or undefined when the repo declares no `upgrade` verb.
// The COMMAND is the project's own (conventionally `just upgrade`, deferring to its
// stack's `pnpm update --latest` / `cargo update` / …) — Tanren names no dependency
// manager. Absence is semantic: a project with no `upgrade` verb has no Tanren-driven
// forced-upgrade lever (and the generator refuses to emit a no-op upgrade spec for it).
export function upgradeCommand(config: CiConfigV1): string | undefined {
  return config.upgrade?.run;
}

// The project's deploy command (the ci.yml home for the lifecycle deploy point), or
// undefined when the repo declares no `deploy` verb. The COMMAND is the project's own
// (conventionally `just deploy`, deferring to its stack's release command) — Tanren
// names no deploy tool. STACK/TARGET-AGNOSTIC: this is ONLY the command; the deploy
// provider/target (the app + credentials to release onto) is a separate org-integration
// concern (engine/postMerge/deployTargetResolution.ts), never derived here. Absence is
// semantic: a project with no `deploy` verb has no Tanren-runnable deploy command.
export function deployCommand(config: CiConfigV1): string | undefined {
  return config.deploy?.run;
}

// The DECLARED JUnit report among the tiers mapped to a lifecycle point — the
// EXPLICIT CI-config contract that replaces the old command-string sniff. A step is
// junit-producing iff it sets `junitReport`; the first such step (in tier then step
// order) names the tier + the workspace-relative path the native gate reads back to
// ingest the per-test grain. `undefined` ⇒ no tier at this point declares a report,
// so the ingest is a clean QUIET skip (not an error). When a step DOES declare one but
// the runner produces no report, that is a LOUD `ci.junit_missing` (the gate caller).
// STACK-AGNOSTIC: the path is the project's own declaration; Tanren names no runner.
export function junitReportFor(config: CiConfigV1, when: CiWhen): { tier: string; path: string } | undefined {
  for (const tierName of tiersFor(config, when)) {
    for (const step of config.tiers[tierName] ?? []) {
      if (step.junitReport !== undefined) {
        return { tier: tierName, path: step.junitReport };
      }
    }
  }
  return undefined;
}

function orderedTierNames(config: CiConfigV1): string[] {
  const extras = Object.keys(config.tiers)
    .filter((name) => name !== "fast" && name !== "slow")
    .sort((a, b) => a.localeCompare(b));
  return ["fast", "slow", ...extras];
}

export { SUPPORTED_CI_CONFIG_VERSIONS };
