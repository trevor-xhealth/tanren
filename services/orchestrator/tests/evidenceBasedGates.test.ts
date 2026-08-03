// EVIDENCE-BASED GATES (apex v57 task #64) — the runtime side of the negative-control
// doctrine. exit-0 alone no longer proves contract fulfillment: every gate step that
// declares an `evidence` contract (or whose legacy `junitReport` promotes to one) is
// judged on POSITIVE PROOF post-execution. This suite covers the full v57 fix:
//   - schema-level: a pre_audit/pre_merge tier MUST declare evidence (fail-closed);
//     a per_iteration-only tier may omit it; the legacy `junitReport` promotes
//   - harvester unit: each evidence kind + each insufficiency reason
//   - runGateTier integration: exit-0 + insufficient ⇒ fail with `failedReason:
//     "evidence_insufficient"`; exit-0 + sufficient ⇒ pass; exit-nonzero ⇒ fail
//     with `failedReason: "exit_code"` (back-compat)
//   - default ci.yml: the built-in slow/merge tiers declare junit evidence
//   - writer-rework directive: the evidence-insufficient class name lands in the
//     directive text so the spec-level convergence detector dedupes off it
import { describe, expect, it } from "vitest";
import {
  CiConfigValidationError,
  DEFAULT_CI_CONFIG,
  evidenceForStep,
  resolveCiConfig,
} from "../src/engine/ci/index.js";
import type { CiStep } from "../src/engine/ci/index.js";
import { harvestStepEvidence } from "../src/engine/workflow/gate/harvestStepEvidence.js";
import { runGateTier } from "../src/engine/workflow/gate/runGateTier.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "h",
  port: 22,
  username: "u",
  hostKeyFingerprint: "fp",
  identitySecretRef: "i",
};

const JUNIT_OK_ONE =
  '<?xml version="1.0"?><testsuites><testsuite name="t"><testcase name="ok"/></testsuite></testsuites>';
const JUNIT_OK_THREE =
  '<?xml version="1.0"?><testsuites><testsuite name="t"><testcase name="a"/><testcase name="b"/><testcase name="c"/></testsuite></testsuites>';

class ScriptedSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  constructor(private readonly script: (cmd: string) => Partial<CommandResult>) {}
  async run(_t: RunnerHandle, c: RunnerCommand): Promise<CommandResult> {
    this.commands.push(c);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...this.script(c.command) };
  }
}

function recordingEvents() {
  const events: { eventType: EventName; payload: unknown }[] = [];
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>) => {
    events.push({ eventType, payload });
  };
  return { events, appendEvent };
}

// ---- SCHEMA (task #64 §1, §2, §7) -----------------------------------------

describe("schema — evidence-gated tiers (task #64)", () => {
  it("REJECTS a pre_merge tier whose every step is judged on exit code alone", () => {
    const noEvidence = `version: 1
tiers:
  fast:
    - name: lint
      run: pnpm lint
  slow:
    - name: build
      run: pnpm build
when:
  fast:
    - per_iteration
  slow:
    - pre_merge
`;
    expect(() => resolveCiConfig(noEvidence)).toThrow(CiConfigValidationError);
  });

  it("REJECTS a pre_audit tier whose every step is judged on exit code alone", () => {
    const noEvidence = `version: 1
tiers:
  fast:
    - name: lint
      run: pnpm lint
  slow:
    - name: build
      run: pnpm build
  merge:
    - name: tier-3
      run: just tier-3
      junitReport: reports/junit.xml
when:
  fast:
    - per_iteration
  slow:
    - pre_audit
  merge:
    - pre_merge
`;
    expect(() => resolveCiConfig(noEvidence)).toThrow(CiConfigValidationError);
  });

  it("ACCEPTS a per_iteration-only tier without evidence (the cheap fast tier — lint/typecheck)", () => {
    // The fast tier maps only to per_iteration; the slow tier carries the evidence to
    // satisfy pre_merge. The fast tier itself need NOT declare evidence.
    const valid = `version: 1
tiers:
  fast:
    - name: lint
      run: pnpm lint
  slow:
    - name: build
      run: pnpm build
      junitReport: reports/junit.xml
when:
  fast:
    - per_iteration
  slow:
    - pre_merge
`;
    expect(() => resolveCiConfig(valid)).not.toThrow();
  });

  it("PROMOTES legacy `junitReport: X` to `{ kind: 'junit', reportPath: X, minTests: 1 }` (back-compat)", () => {
    const step: CiStep = { name: "test", run: "just test", junitReport: "out/results.xml" };
    expect(evidenceForStep(step)).toEqual({ kind: "junit", reportPath: "out/results.xml", minTests: 1 });
  });

  it("an explicit `evidence` block WINS over the legacy `junitReport` (no double-promotion)", () => {
    const step: CiStep = {
      name: "test",
      run: "just test",
      junitReport: "out/results.xml",
      evidence: { kind: "junit", reportPath: "other/path.xml", minTests: 5 },
    };
    expect(evidenceForStep(step)).toEqual({ kind: "junit", reportPath: "other/path.xml", minTests: 5 });
  });

  it("REJECTS a junit evidence with minTests: 0 (no vacuous thresholds)", () => {
    const cfg = `version: 1
tiers:
  fast:
    - name: lint
      run: pnpm lint
  slow:
    - name: build
      run: pnpm build
      evidence:
        kind: junit
        reportPath: reports/junit.xml
        minTests: 0
when:
  fast:
    - per_iteration
  slow:
    - pre_merge
`;
    expect(() => resolveCiConfig(cfg)).toThrow(CiConfigValidationError);
  });

  it("REJECTS a stdout-count evidence with min: 0 (no vacuous thresholds)", () => {
    const cfg = `version: 1
tiers:
  fast:
    - name: lint
      run: pnpm lint
  slow:
    - name: build
      run: pnpm build
      evidence:
        kind: stdout-count
        pattern: "ok"
        min: 0
when:
  fast:
    - per_iteration
  slow:
    - pre_merge
`;
    expect(() => resolveCiConfig(cfg)).toThrow(CiConfigValidationError);
  });
});

// ---- DEFAULT ci.yml (task #64 §7) -----------------------------------------

describe("DEFAULT_CI_CONFIG — tier-2/tier-3 declare junit evidence (task #64)", () => {
  it("the slow (pre_audit) tier declares junit evidence with minTests >= 1", () => {
    const step = DEFAULT_CI_CONFIG.tiers.slow[0]!;
    expect(step.evidence).toEqual({ kind: "junit", reportPath: "reports/junit.xml", minTests: 1 });
  });

  it("the merge (pre_merge) tier declares junit evidence with minTests >= 1 (the merge authority cannot be vacuous)", () => {
    const step = DEFAULT_CI_CONFIG.tiers.merge?.[0];
    expect(step?.evidence).toEqual({ kind: "junit", reportPath: "reports/junit.xml", minTests: 1 });
  });
});

// ---- HARVESTER (task #64 §3) ----------------------------------------------

describe("harvestStepEvidence — every evidence kind + every insufficiency reason (task #64)", () => {
  const deps = (script: (cmd: string) => Partial<CommandResult>) => ({
    ssh: new ScriptedSsh(script),
    target,
    workspacePath: "/ws",
  });

  // ---- junit ----
  it("junit — present + total >= minTests ⇒ sufficient (carries observed total/failures)", async () => {
    const harvest = await harvestStepEvidence(
      deps((cmd) => (cmd.includes("__TANREN_FILE_ABSENT__") ? { stdout: JUNIT_OK_THREE } : {})),
      { kind: "junit", reportPath: "reports/junit.xml", minTests: 1 },
      "",
    );
    expect(harvest.verdict.sufficient).toBe(true);
    if (!harvest.verdict.sufficient) return;
    expect(harvest.verdict.observed).toEqual({ total: 3, failures: 0 });
    // The parsed report is exposed as a side channel for the per-test ingest to reuse.
    expect(harvest.parsedJunitReport?.total).toBe(3);
  });

  it("junit — absent file ⇒ junit_missing (carries reportPath + readReason)", async () => {
    const harvest = await harvestStepEvidence(
      deps((cmd) => (cmd.includes("__TANREN_FILE_ABSENT__") ? { stdout: "__TANREN_FILE_ABSENT__\n" } : {})),
      { kind: "junit", reportPath: "reports/junit.xml", minTests: 1 },
      "",
    );
    expect(harvest.verdict.sufficient).toBe(false);
    if (harvest.verdict.sufficient) return;
    expect(harvest.verdict.reason).toBe("junit_missing");
    expect(harvest.verdict.observed["readReason"]).toBe("absent");
  });

  it("junit — parsed report with zero tests ⇒ junit_zero_tests (the v29 lesson — exit-0 over empty files)", async () => {
    const emptyReport = '<?xml version="1.0"?><testsuites/>';
    const harvest = await harvestStepEvidence(
      deps((cmd) => (cmd.includes("__TANREN_FILE_ABSENT__") ? { stdout: emptyReport } : {})),
      { kind: "junit", reportPath: "reports/junit.xml", minTests: 1 },
      "",
    );
    expect(harvest.verdict.sufficient).toBe(false);
    if (harvest.verdict.sufficient) return;
    expect(harvest.verdict.reason).toBe("junit_zero_tests");
  });

  it("junit — parsed report below minTests ⇒ junit_below_threshold", async () => {
    const harvest = await harvestStepEvidence(
      deps((cmd) => (cmd.includes("__TANREN_FILE_ABSENT__") ? { stdout: JUNIT_OK_ONE } : {})),
      { kind: "junit", reportPath: "reports/junit.xml", minTests: 5 },
      "",
    );
    expect(harvest.verdict.sufficient).toBe(false);
    if (harvest.verdict.sufficient) return;
    expect(harvest.verdict.reason).toBe("junit_below_threshold");
    expect(harvest.verdict.observed).toEqual({ total: 1 });
  });

  // ---- artifact (the stat probe emits a byte count, or the artifact-absent marker) ----
  it("artifact — present file ⇒ sufficient (no minBytes ⇒ any size passes)", async () => {
    const harvest = await harvestStepEvidence(
      deps((cmd) => (cmd.includes("__TANREN_ARTIFACT_ABSENT__") ? { stdout: "5\n" } : {})),
      { kind: "artifact", path: "dist/app.tar.gz" },
      "",
    );
    expect(harvest.verdict.sufficient).toBe(true);
  });

  it("artifact — absent path ⇒ artifact_absent (carries path + readReason)", async () => {
    const harvest = await harvestStepEvidence(
      deps((cmd) => (cmd.includes("__TANREN_ARTIFACT_ABSENT__") ? { stdout: "__TANREN_ARTIFACT_ABSENT__\n" } : {})),
      { kind: "artifact", path: "dist/app.tar.gz" },
      "",
    );
    expect(harvest.verdict.sufficient).toBe(false);
    if (harvest.verdict.sufficient) return;
    expect(harvest.verdict.reason).toBe("artifact_absent");
    expect(harvest.verdict.observed["readReason"]).toBe("absent");
  });

  it("artifact — zero bytes (empty file / empty dir) ⇒ artifact_absent readReason empty (a build that emitted nothing)", async () => {
    const harvest = await harvestStepEvidence(
      deps((cmd) => (cmd.includes("__TANREN_ARTIFACT_ABSENT__") ? { stdout: "0\n" } : {})),
      { kind: "artifact", path: "dist" },
      "",
    );
    expect(harvest.verdict.sufficient).toBe(false);
    if (harvest.verdict.sufficient) return;
    expect(harvest.verdict.reason).toBe("artifact_absent");
    expect(harvest.verdict.observed["readReason"]).toBe("empty");
  });

  it("artifact — present but smaller than minBytes ⇒ artifact_too_small", async () => {
    const harvest = await harvestStepEvidence(
      deps((cmd) => (cmd.includes("__TANREN_ARTIFACT_ABSENT__") ? { stdout: "4\n" } : {})),
      { kind: "artifact", path: "dist/app.tar.gz", minBytes: 1024 },
      "",
    );
    expect(harvest.verdict.sufficient).toBe(false);
    if (harvest.verdict.sufficient) return;
    expect(harvest.verdict.reason).toBe("artifact_too_small");
    expect(harvest.verdict.observed).toEqual({ bytes: 4 });
  });

  // ---- stdout-count ----
  it("stdout-count — pattern matches >= min ⇒ sufficient", async () => {
    const harvest = await harvestStepEvidence(
      deps(() => ({})),
      { kind: "stdout-count", pattern: "PASS", min: 2 },
      "PASS\nFAIL\nPASS\n",
    );
    expect(harvest.verdict.sufficient).toBe(true);
  });

  it("stdout-count — pattern matches below min ⇒ stdout_count_below_threshold", async () => {
    const harvest = await harvestStepEvidence(
      deps(() => ({})),
      { kind: "stdout-count", pattern: "PASS", min: 5 },
      "PASS\nFAIL\n",
    );
    expect(harvest.verdict.sufficient).toBe(false);
    if (harvest.verdict.sufficient) return;
    expect(harvest.verdict.reason).toBe("stdout_count_below_threshold");
    expect(harvest.verdict.observed).toEqual({ matches: 1, pattern: "PASS" });
  });
});

// ---- runGateTier INTEGRATION (task #64 §4, §5) ----------------------------

describe("runGateTier — exit-0 with insufficient evidence FAILS the tier (task #64)", () => {
  it("exit-0 + sufficient junit evidence ⇒ passed: true (the happy path)", async () => {
    const ssh = new ScriptedSsh((cmd) => (cmd.includes("__TANREN_FILE_ABSENT__") ? { stdout: JUNIT_OK_ONE } : {}));
    const { events, appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "slow",
      when: "pre_audit",
      steps: [
        { name: "test", run: "just test", evidence: { kind: "junit", reportPath: "reports/junit.xml", minTests: 1 } },
      ],
      appendEvent,
    });
    expect(result.passed).toBe(true);
    expect(events.map((e) => e.eventType)).toEqual(["gate.started", "gate.passed"]);
  });

  it("exit-0 + zero tests in junit ⇒ passed: false, failedReason: 'evidence_insufficient' (the v57 fix)", async () => {
    const emptyReport = '<?xml version="1.0"?><testsuites/>';
    const ssh = new ScriptedSsh((cmd) => (cmd.includes("__TANREN_FILE_ABSENT__") ? { stdout: emptyReport } : {}));
    const { events, appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "slow",
      when: "pre_audit",
      steps: [
        { name: "test", run: "just test", evidence: { kind: "junit", reportPath: "reports/junit.xml", minTests: 1 } },
      ],
      appendEvent,
    });
    expect(result.passed).toBe(false);
    if (result.passed) return;
    expect(result.failedReason).toBe("evidence_insufficient");
    expect(result.evidence?.kind).toBe("junit");
    if (result.evidence?.sufficient !== false) return;
    expect(result.evidence.reason).toBe("junit_zero_tests");
    // The gate.failed event payload carries the same diagnosis so the writer rework
    // directive consumes it on iteration 1.
    const failed = events.find((e) => e.eventType === "gate.failed")!;
    expect((failed.payload as { failedReason?: string }).failedReason).toBe("evidence_insufficient");
    expect((failed.payload as { evidence?: { reason: string } }).evidence?.reason).toBe("junit_zero_tests");
  });

  it("exit-0 + missing junit ⇒ passed: false, failedReason: 'evidence_insufficient' (no silent green)", async () => {
    const ssh = new ScriptedSsh((cmd) =>
      cmd.includes("__TANREN_FILE_ABSENT__") ? { stdout: "__TANREN_FILE_ABSENT__\n" } : {},
    );
    const { appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "slow",
      when: "pre_audit",
      steps: [
        { name: "test", run: "just test", evidence: { kind: "junit", reportPath: "reports/junit.xml", minTests: 1 } },
      ],
      appendEvent,
    });
    expect(result.passed).toBe(false);
    if (result.passed) return;
    expect(result.failedReason).toBe("evidence_insufficient");
    if (result.evidence?.sufficient !== false) return;
    expect(result.evidence.reason).toBe("junit_missing");
  });

  it("exit-non-0 ⇒ passed: false, failedReason: 'exit_code' (back-compat — the historical class)", async () => {
    const ssh = new ScriptedSsh((cmd) => (cmd.includes("just test") ? { exitCode: 2, stderr: "boom" } : {}));
    const { appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "slow",
      when: "pre_audit",
      steps: [
        { name: "test", run: "just test", evidence: { kind: "junit", reportPath: "reports/junit.xml", minTests: 1 } },
      ],
      appendEvent,
    });
    expect(result.passed).toBe(false);
    if (result.passed) return;
    expect(result.failedReason).toBe("exit_code");
    expect(result.exitCode).toBe(2);
    // Evidence is NOT harvested on a nonzero exit — the failure is already the failure.
    expect(result.evidence).toBeUndefined();
  });

  it("exit-0 + no evidence declared ⇒ passed: true (the cheap per-iteration tier — judged on exit alone)", async () => {
    const ssh = new ScriptedSsh(() => ({}));
    const { appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "fast",
      when: "per_iteration",
      steps: [{ name: "lint", run: "pnpm lint" }],
      appendEvent,
    });
    expect(result.passed).toBe(true);
  });

  it("F-9 retention carve-out: ONLY a stdout-count step keeps full stdout; every other step is bounded", async () => {
    // A gate step is the largest stream in the system, so steps take head+tail
    // ("bounded") retention — a 4 000-char tail is all `tailOf(combinedOutput(…))`
    // ever reads. EXCEPT a `stdout-count` contract, which counts regex matches across
    // the WHOLE stdout: an elided middle would UNDERCOUNT and fail a PASSING step as
    // `evidence_insufficient`. That carve-out was documented in a comment and asserted
    // nowhere, so flipping it would have been a silent false-failure regression.
    const ssh = new ScriptedSsh((cmd) =>
      cmd.includes("__TANREN_FILE_ABSENT__") ? { stdout: JUNIT_OK_ONE } : { stdout: "PASS\nPASS\n" },
    );
    const { appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "slow",
      when: "pre_audit",
      steps: [
        { name: "count", run: "just count", evidence: { kind: "stdout-count", pattern: "PASS", min: 2 } },
        {
          name: "report",
          run: "just report",
          evidence: { kind: "junit", reportPath: "reports/junit.xml", minTests: 1 },
        },
        { name: "plain", run: "just plain" },
      ],
      appendEvent,
    });
    expect(result.passed).toBe(true);
    const retentionOf = (run: string) => ssh.commands.find((c) => c.command.includes(run))?.outputRetention;
    expect(retentionOf("just count")).toBe("full");
    // junit/artifact evidence is harvested by a SEPARATE `cat` over SSH, so the step's
    // OWN stream reads nothing but the tail and stays bounded.
    expect(retentionOf("just report")).toBe("bounded");
    expect(retentionOf("just plain")).toBe("bounded");
  });

  it("the parsed JUnit report is exposed on the tier result for downstream per-test ingest reuse (no double-read)", async () => {
    const ssh = new ScriptedSsh((cmd) => (cmd.includes("__TANREN_FILE_ABSENT__") ? { stdout: JUNIT_OK_THREE } : {}));
    const { appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "slow",
      when: "pre_audit",
      steps: [
        { name: "test", run: "just test", evidence: { kind: "junit", reportPath: "reports/junit.xml", minTests: 1 } },
      ],
      appendEvent,
    });
    expect(result.parsedJunitReports?.get("test")?.total).toBe(3);
  });
});

// ---- WRITER DIRECTIVE (task #64 §8) ---------------------------------------
