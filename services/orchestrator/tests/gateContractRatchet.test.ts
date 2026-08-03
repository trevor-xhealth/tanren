// GATE-CONTRACT RATCHET — the writer must not be able to weaken the gate that judges it.
//
// `.tanren/ci.yml` is repo-sourced and therefore writer-writable, and under sole merge
// authority (tanren's native gate is the only required check, no human approval) a writer that
// lowers `junit.minTests` or drops the `pre_merge` mapping lowers its own bar. The prompt-level
// `IMMUTABLE_CONTRACT_FILES` rule is an instruction; this suite drives the ENFORCEMENT through
// the real production gate callback (`buildDefaultGate`) against a recording SSH fake, and
// asserts the OBSERVABLE outcome — the gate does not pass and no tier command was ever issued —
// rather than that some helper returned false.
//
// The suite is deliberately symmetric. Blocking everything would satisfy the two weakening
// cases while making tanren unable to ever improve its own CI, so the same harness also proves
// that a diff which STRENGTHENS the contract, and an ordinary diff that never touches it, both
// still reach and run the declared tiers.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { detectGateWeakening, resolveCiConfig } from "../src/engine/ci/index.js";
import { CI_CONFIG_GATE_TIER } from "../src/engine/workflow/gate/index.js";
import { gateFindings } from "../src/engine/workflow/loopFindings.js";
import { buildDefaultGate } from "../src/engine/workflow/plannerRunAdapters.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};
const workspacePath = "/workspace/runs/run_ratchet/repo";
const BASE_SHA = "1".repeat(40);

// An OPERATOR-AUTHORED contract, of the shape a real monorepo produces: a cheap
// per-iteration tier, an audit tier, and a heavier pre-merge tier whose junit evidence is what
// makes a green step mean something. The two `minTests` numbers are what is under attack.
// Nothing here is project-specific — every step defers to a `just` target the project owns.
function operatorContract(minTests: number, mergeMinTests = minTests): string {
  return [
    "version: 1",
    "bootstrap:",
    "  run: just bootstrap",
    "tiers:",
    "  fast:",
    "    - name: tier-1",
    "      run: just tier-1",
    "  slow:",
    "    - name: tier-2",
    "      run: just tier-2",
    "      junitReport: reports/junit.xml",
    "      evidence:",
    "        kind: junit",
    "        reportPath: reports/junit.xml",
    `        minTests: ${String(minTests)}`,
    "  merge:",
    "    - name: tier-3",
    "      run: just tier-3",
    "      junitReport: reports/junit.xml",
    "      evidence:",
    "        kind: junit",
    "        reportPath: reports/junit.xml",
    `        minTests: ${String(mergeMinTests)}`,
    "when:",
    "  fast:",
    "    - per_iteration",
    "  slow:",
    "    - pre_audit",
    "  merge:",
    "    - pre_merge",
  ].join("\n");
}

// The operator's real contract: the audit tier demands 500 tests, the MERGE tier — the one
// that carries merge authority — demands 11000.
const OPERATOR_CONTRACT = operatorContract(500, 11_000);

// The SAME contract with the heavy tier no longer mapped to `pre_merge` — the second way to
// hollow the gate out: every tier and every step survives untouched, they are just re-pointed
// so the merge point is served by the cheap one. `pre_merge` still HAS coverage and still has
// evidence, so the schema's own fail-closed checks are satisfied — which is exactly why the
// ratchet has to measure the DEMAND rather than the presence.
const PRE_MERGE_MAPPING_DROPPED = OPERATOR_CONTRACT.replace(
  "  slow:\n    - pre_audit\n  merge:\n    - pre_merge",
  "  slow:\n    - pre_audit\n    - pre_merge\n  merge:\n    - pre_audit",
);

/** A JUnit report with `count` passing cases — real positive proof for the evidence contract. */
function junitXml(count: number): string {
  const cases = Array.from(
    { length: count },
    (_unused, index) => `<testcase classname="suite" name="case_${String(index)}"/>`,
  ).join("");
  return `<testsuites><testsuite name="suite" tests="${String(count)}">${cases}</testsuite></testsuites>`;
}

/**
 * Interprets the small SSH vocabulary the gate issues. `baseline` is the contract as of the
 * run's base commit (what the ratchet probe reads out of git history); `head` is the contract
 * in the working tree (what the writer left behind). Every command is recorded, so a test can
 * prove a tier step was — or was never — issued.
 */
class ContractSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  constructor(
    private readonly head: string,
    private readonly baseline: string | null,
    private readonly junitCases = 0,
  ) {}

  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    // The ratchet's baseline probe — matched FIRST, since it also mentions the config path.
    if (command.command.includes("tanren-baseline:present")) {
      if (this.baseline === null) return { ...ok, stdout: "tanren-baseline:absent\n" };
      return { ...ok, stdout: `tanren-baseline:present\n${this.baseline}` };
    }
    if (command.command.includes(".tanren/ci.yml")) return { ...ok, stdout: this.head };
    if (command.command.includes("reports/junit.xml")) return { ...ok, stdout: junitXml(this.junitCases) };
    if (command.command.includes("git rev-parse HEAD")) return { ...ok, stdout: "" };
    return ok;
  }
}

function context(): PlannerRunContext {
  return {
    runId: "run_ratchet",
    specId: "spec_ratchet",
    projectId: "project_ratchet",
    orgId: "org_ratchet",
    repoUrl: "https://github.com/cat-cave/monorepo",
    targetBranch: "main",
    runBranch: "tanren/ratchet",
    specTitle: "a spec",
    specDescription: "any change at all",
    acceptanceCriteria: ["it works"],
    runnerImage: "ghcr.io/cat-cave/tanren-runner:test",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "credential/github/dev",
    greenfield: false,
  };
}

function gateInput(ssh: CommandSubstrate): RunPlannerLoopInput {
  return { ssh, context: context(), timeoutMs: 100 } as unknown as RunPlannerLoopInput;
}

function gateFor(ssh: CommandSubstrate, events: FakeEventStore) {
  return buildDefaultGate(gateInput(ssh), target, workspacePath, events, BASE_SHA);
}

/** Did the gate actually get as far as issuing the contract's declared tier commands? */
function ranTiers(ssh: ContractSsh): boolean {
  return ssh.commands.some((c) => c.command.includes("just tier-"));
}

describe("gate-contract ratchet — NEGATIVE CONTROL: a run that lowers its own bar cannot land", () => {
  it("a diff that lowers junit.minTests from 11000 to 1 fails the gate and runs NO tier", async () => {
    // The writer's diff: same contract, `minTests: 11000` -> `minTests: 1`. Everything else
    // — tiers, steps, when-policy, report paths — is byte-identical, and the result still
    // satisfies `CiConfigV1`, so nothing before the ratchet objects to it.
    const ssh = new ContractSsh(operatorContract(1), operatorContract(11_000));
    const events = new FakeEventStore();

    const outcome = await gateFor(ssh, events)({ when: "pre_audit", taskId: "task_w" });

    // OBSERVABLE OUTCOME: the gate did not pass, so the run cannot reach the merge queue.
    expect(outcome.passed).toBe(false);
    expect(outcome).toMatchObject({ failure: { tier: CI_CONFIG_GATE_TIER } });
    if (outcome.passed) throw new Error("unreachable");
    expect(outcome.failure.steps[0]?.outputTail).toContain("WEAKENS the gate that judges it");
    // The measured delta is reported, not just the fact of a violation.
    expect(outcome.failure.steps[0]?.outputTail).toContain("junitMinTests: 11000 -> 1");
    // It short-circuited: no tier ever ran, and no verdict was published for this head.
    expect(ranTiers(ssh)).toBe(false);
    expect(events.events.some((e) => e.eventType === "gate.verdict")).toBe(false);
    expect(events.events.some((e) => e.eventType === "gate.failed")).toBe(true);
  });

  it("a diff that drops the pre_merge mapping fails the gate at the merge point", async () => {
    const ssh = new ContractSsh(PRE_MERGE_MAPPING_DROPPED, OPERATOR_CONTRACT);

    const outcome = await gateFor(ssh, new FakeEventStore())({ when: "pre_merge", headShaOverride: "a".repeat(40) });

    expect(outcome.passed).toBe(false);
    expect(outcome).toMatchObject({ failure: { tier: CI_CONFIG_GATE_TIER } });
    if (outcome.passed) throw new Error("unreachable");
    // pre_merge lost the 11000-test tier and kept only the 500-test one; the demand fell.
    expect(outcome.failure.steps[0]?.outputTail).toContain("pre_merge.junitMinTests: 11000 -> 500");
    expect(ranTiers(ssh)).toBe(false);
  });

  it("the block is re-measured EVERY gate, so a weakening authored after the first gate is caught", async () => {
    // The config is memoized for the run, but the workspace is not: this substrate serves the
    // honest contract to the first read and the weakened one afterwards — the shape of a
    // writer that only reaches for the contract file once an iteration has already failed.
    class TamperLaterSsh extends ContractSsh {
      private baselineReads = 0;
      constructor() {
        super(operatorContract(11_000), operatorContract(11_000), 11_000);
      }
      override async run(t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
        if (command.command.includes("tanren-baseline:present")) {
          this.baselineReads += 1;
        }
        const result = await super.run(t, command);
        return result;
      }
      get reads(): number {
        return this.baselineReads;
      }
    }
    const ssh = new TamperLaterSsh();
    const gate = gateFor(ssh, new FakeEventStore());

    await gate({ when: "per_iteration" });
    await gate({ when: "per_iteration" });

    // Two gate calls, two independent baseline measurements — never a once-per-run latch.
    expect(ssh.reads).toBe(2);
  });

  it("the failure is a P0 finding naming .tanren/ci.yml, so the writer is steered to revert it", async () => {
    const ssh = new ContractSsh(operatorContract(1), operatorContract(11_000));

    const outcome = await gateFor(ssh, new FakeEventStore())({ when: "pre_audit" });
    if (outcome.passed) throw new Error("expected a failed gate");

    const finding = gateFindings(outcome);
    expect(finding.severity).toBe("P0");
    expect(finding.title).toContain(".tanren/ci.yml");
    expect(finding.body).toContain("WEAKENS the gate that judges it");
  });

  it("an explicitly-named baseline that cannot be read fails CLOSED (never a free pass)", async () => {
    // A writer that could make the floor unreadable would otherwise have a trivial bypass.
    class NoAnchorSsh extends ContractSsh {
      constructor() {
        super(operatorContract(1), null);
      }
      override async run(t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
        if (command.command.includes("tanren-baseline:present")) {
          return { exitCode: 0, stdout: "tanren-baseline:no-anchor\n", stderr: "", timedOut: false };
        }
        return super.run(t, command);
      }
    }
    const ssh = new NoAnchorSsh();

    const outcome = await gateFor(ssh, new FakeEventStore())({ when: "pre_audit" });

    expect(outcome.passed).toBe(false);
    expect(outcome).toMatchObject({ failure: { tier: CI_CONFIG_GATE_TIER } });
    expect(ranTiers(ssh)).toBe(false);
  });
});

describe("gate-contract ratchet — the OPPOSITE failure: legitimate work must still proceed", () => {
  it("a diff that STRENGTHENS the gate proceeds, and is graded by its own raised bar", async () => {
    // The gate-improvement spec: `minTests` 200 -> 500. The head contract is used verbatim,
    // so the run must now actually produce 500 tests — and it does.
    const ssh = new ContractSsh(operatorContract(500), operatorContract(200), 500);

    const outcome = await gateFor(ssh, new FakeEventStore())({ when: "pre_audit" });

    expect(outcome.passed).toBe(true);
    expect(ranTiers(ssh)).toBe(true);
  });

  it("the raised bar is REAL: the same strengthened contract reds a run that produces the old count", async () => {
    // Non-vacuous proof that "proceeds" is not "is ignored": with only the pre-improvement
    // 200 tests, the strengthened contract fails the run on its evidence, not on the ratchet.
    const ssh = new ContractSsh(operatorContract(500), operatorContract(200), 200);

    const outcome = await gateFor(ssh, new FakeEventStore())({ when: "pre_audit" });

    expect(outcome.passed).toBe(false);
    if (outcome.passed) throw new Error("unreachable");
    expect(outcome.failure.tier).not.toBe(CI_CONFIG_GATE_TIER);
    expect(ranTiers(ssh)).toBe(true);
  });

  it("an ordinary diff that never touches the contract proceeds untouched", async () => {
    const ssh = new ContractSsh(operatorContract(200), operatorContract(200), 200);

    const outcome = await gateFor(ssh, new FakeEventStore())({ when: "pre_audit" });

    expect(outcome.passed).toBe(true);
    expect(ranTiers(ssh)).toBe(true);
  });

  it("a repo introducing its FIRST contract is a strengthening, not a weakening", async () => {
    // Baseline absent (greenfield / brownfield adoption) resolves to the documented default,
    // whose floor is `minTests: 1` — so authoring a real contract is always permitted.
    const ssh = new ContractSsh(operatorContract(200), null, 200);

    const outcome = await gateFor(ssh, new FakeEventStore())({ when: "pre_audit" });

    expect(outcome.passed).toBe(true);
    expect(ranTiers(ssh)).toBe(true);
  });
});

describe("gate-contract ratchet — what 'weaker' means", () => {
  it("counts demand, not identity: renaming and splitting steps is neutral", async () => {
    const before = resolveCiConfig(operatorContract(200));
    const after = resolveCiConfig(
      operatorContract(200)
        .replace("    - name: tier-2\n      run: just tier-2", "    - name: verify\n      run: just verify")
        .replace(
          "    - name: tier-3\n      run: just tier-3",
          "    - name: merge-verify\n      run: just merge-verify",
        ),
    );

    expect(detectGateWeakening(before, after)).toEqual([]);
  });

  it("deleting an evidence block is a weakening even when the step survives", async () => {
    const before = resolveCiConfig(operatorContract(200));
    const stripped = operatorContract(200).replace(
      "      evidence:\n        kind: junit\n        reportPath: reports/junit.xml\n        minTests: 200\n  merge:",
      "  merge:",
    );

    const findings = detectGateWeakening(before, resolveCiConfig(stripped));

    // The step keeps its legacy `junitReport:`, which promotes to `minTests: 1` — so the
    // step is still evidence-bearing, but the threshold it demanded is gone.
    expect(findings.map((f) => `${f.when}.${f.dimension}`)).toContain("pre_audit.junitMinTests");
  });

  it("per_iteration is deliberately NOT ratcheted (relaxing it cannot land anything)", async () => {
    // The baseline runs TWO per-iteration steps; the head deletes one. That is a real
    // relaxation of the writer loop — and deliberately not a ratchet violation, because a
    // per_iteration tier carries no merge authority and ratcheting it would reject ordinary
    // lifecycle edits for no security gain.
    const twoFastSteps = operatorContract(200).replace(
      "  fast:\n    - name: tier-1\n      run: just tier-1",
      "  fast:\n    - name: tier-1\n      run: just tier-1\n    - name: tier-1b\n      run: just tier-1b",
    );

    expect(detectGateWeakening(resolveCiConfig(twoFastSteps), resolveCiConfig(operatorContract(200)))).toEqual([]);
  });
});
