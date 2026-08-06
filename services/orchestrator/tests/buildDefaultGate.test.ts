// buildDefaultGate: the production gate callback's greenfield bootstrap-ensure +
// lenient-posture wiring. Drives buildDefaultGate against an interpreting SSH fake (a
// virtual workspace whose project-CONTRACT presence + prepared/tool availability
// change over the run) so we exercise the REAL ensure-before-tier ordering, the
// idempotent re-bootstrap EVERY gate (the P0 fix — no install latch), and the lenient
// advisory semantics end-to-end — without a live runner. STACK-AGNOSTIC: the gate
// steps defer to `just tier-N`; Tanren names no stack. No DB: a FakeEventStore
// captures the emitted gate.* / gate.advisory_failed events.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { GovernancePosture } from "../src/engine/config/shared.js";
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

const workspacePath = "/workspace/runs/run_greenfield/repo";

function context(opts?: { governancePosture?: GovernancePosture; greenfield?: boolean }): PlannerRunContext {
  return {
    runId: "run_greenfield",
    specId: "spec_greenfield",
    projectId: "project_greenfield",
    orgId: "org_greenfield",
    repoUrl: "https://github.com/cat-cave/greenfield",
    targetBranch: "main",
    runBranch: "tanren/greenfield",
    specTitle: "monorepo scaffold",
    specDescription: "stand up the toolchain",
    acceptanceCriteria: ["the pipeline is green"],
    runnerImage: "ghcr.io/cat-cave/tanren-runner:test",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "credential/github/dev",
    ...(opts?.governancePosture === undefined ? {} : { governancePosture: opts.governancePosture }),
    ...(opts?.greenfield === undefined ? {} : { greenfield: opts.greenfield }),
  };
}

// A virtual workspace the SSH fake interprets. STACK-AGNOSTIC: `contract` models
// whether the project's `justfile`/`.tanren/ci.yml` is present (the bootstrap-guard
// trigger); `prepared` is false until `just bootstrap` runs (so a `just tier-1`
// against an unprepared tree fails like the real `tool: not found`).
interface WorkspaceState {
  contract: boolean;
  prepared: boolean;
  // When the bootstrap runs (contract present), the gate's tier-1 step would
  // otherwise fail until the tree is prepared; once prepared, the tier-1 outcome is
  // governed by `tier1Exit`.
  tier1Exit: number;
  // How many times the bootstrap actually ran (contract present). The P0 fix
  // re-runs the bootstrap every gate, so this counts each gate's ensure.
  installRuns: number;
  // The workspace HEAD sha `git rev-parse HEAD` returns — the verdict anchor the
  // gate uses ABSENT a headShaOverride. Absent ⇒ "" ⇒ no verdict event (the existing
  // tests don't assert on the verdict; only the commit-binding test sets it).
  workspaceHead?: string;
  // When set, junit-evidence reads return this XML; absent ⇒ the file is ABSENT (the
  // original behavior). Tests that want pre_audit/pre_merge to PASS the new evidence
  // gate (task #64) set this to a minimal valid JUnit document with ≥ 1 test.
  junitReportXml?: string;
}

// Interprets the small command vocabulary buildDefaultGate issues over SSH:
//   - the `.tanren/ci.yml` config read (no file ⇒ stack-agnostic default config)
//   - the bootstrap guard (run WHENEVER the project contract exists)
//   - the gate steps `just tier-1` / `just tier-2` / `just tier-3`
class InterpretingSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  // When set, the `.tanren/ci.yml` read returns this YAML (a repo-authored config);
  // when unset, the read is empty ⇒ the resolver yields the stack-agnostic default.
  constructor(
    private readonly state: WorkspaceState,
    private readonly ciConfigYaml?: string,
  ) {}
  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const cmd = command.command;
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    // .tanren/ci.yml read (`if [ -f .../.tanren/ci.yml ]; then cat ...; fi`): return the
    // injected repo config, else empty ⇒ the resolver yields the stack-agnostic default.
    if (cmd.includes(".tanren/ci.yml") && cmd.includes("cat ")) {
      return this.ciConfigYaml === undefined ? ok : { ...ok, stdout: this.ciConfigYaml };
    }
    // The native JUnit ingest + evidence-harvester read (`if [ -f .../reports/junit.xml ];
    // then cat ...; else echo __TANREN_FILE_ABSENT__; fi`) — keyed on the absent-marker so
    // a gate STEP whose `run` references reports/junit.xml is NOT mistaken for the read.
    // After task #64 the marker is the shared `__TANREN_FILE_ABSENT__` (the harvester +
    // ingest share one file-read primitive). When the workspace declares a virtual report
    // (`junitReportXml`), return it; absent ⇒ the file is ABSENT (the LOUD missing case).
    if (cmd.includes("__TANREN_FILE_ABSENT__")) {
      return this.state.junitReportXml === undefined
        ? { ...ok, stdout: "__TANREN_FILE_ABSENT__\n" }
        : { ...ok, stdout: this.state.junitReportXml };
    }
    // The verdict-anchor read: the workspace HEAD the gate binds gate.verdict to
    // when no headShaOverride is given. A configured `workspaceHead` lets the
    // commit-binding test prove the override is preferred over THIS sha.
    if (cmd === "git rev-parse HEAD") return { ...ok, stdout: `${this.state.workspaceHead ?? ""}\n` };
    // The bootstrap guard, recognized by its sentinel marker. The guard runs the
    // bootstrap WHENEVER the project contract exists (it no longer probes a manifest /
    // prepared state), so it runs even when the tree is already prepared — every gate.
    if (cmd.includes("deps-ensure")) {
      if (this.state.contract) {
        this.state.installRuns += 1;
        // The bootstrap (re-)prepares the tree; counted so a later gate's re-run is observable.
        this.state.prepared = true;
        return { ...ok, stdout: "tanren: deps-ensure installing\nPackages: +120" };
      }
      return { ...ok, stdout: "tanren: deps-ensure no-op" };
    }
    // Gate steps. Without a prepared tree, every `just tier-*` "tool not found"
    // (exit 127). With a prepared tree, tier-1's outcome is governed by tier1Exit;
    // tier-2/tier-3 pass.
    if (cmd.includes("just tier-")) {
      if (!this.state.prepared) {
        return { exitCode: 127, stdout: "", stderr: "sh: 1: tool: not found", timedOut: false };
      }
      if (cmd.endsWith("just tier-1")) {
        return this.state.tier1Exit === 0 ? ok : { ...ok, exitCode: this.state.tier1Exit, stderr: "tier-1 error" };
      }
      return ok;
    }
    return ok;
  }
}

function gateInput(ssh: CommandSubstrate, ctx: PlannerRunContext): RunPlannerLoopInput {
  // buildDefaultGate only reads ssh / context / timeoutMs / bootstrapCommand /
  // appEnv off the input; the rest of RunPlannerLoopInput is irrelevant here.
  return { ssh, context: ctx, timeoutMs: 100 } as unknown as RunPlannerLoopInput;
}

// The verbatim bootstrap guard command the gate issued (it embeds the resolved
// bootstrap command), so bootstrap-mode tests can assert on its contents.
function depsEnsureCommand(ssh: InterpretingSsh): string {
  const cmd = ssh.commands.find((c) => c.command.includes("deps-ensure"));
  expect(cmd).toBeDefined();
  return cmd!.command;
}

describe("buildDefaultGate — greenfield deps-ensure", () => {
  it("bootstraps before the tier so the first post-writer gate passes (not tool-not-found)", async () => {
    // Greenfield: the writer has authored the project contract, but the tree was never
    // prepared (the cold bootstrap was a no-op on the contract-less clone HEAD).
    const state: WorkspaceState = { contract: true, prepared: false, tier1Exit: 0, installRuns: 0 };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context({ greenfield: true })), target, workspacePath, events);

    const outcome = await gate({ when: "per_iteration", taskId: "task_w" });

    expect(outcome.passed).toBe(true);
    // The bootstrap guard ran BEFORE the first `just tier-1` (ordering is load-bearing).
    const ensureIdx = ssh.commands.findIndex((c) => c.command.includes("deps-ensure"));
    const tier1Idx = ssh.commands.findIndex((c) => c.command.endsWith("just tier-1"));
    expect(ensureIdx).toBeGreaterThanOrEqual(0);
    expect(tier1Idx).toBeGreaterThan(ensureIdx);
    // No gate.failed: the tree is prepared, so tier-1 exits 0.
    expect(events.events.some((e) => e.eventType === "gate.failed")).toBe(false);
    expect(events.events.some((e) => e.eventType === "gate.passed")).toBe(true);
  });

  // P0 FIX: the install latch is gone — the ensure re-runs before EVERY gate, so a
  // writer-added devDep authored after an earlier install still gets installed. The
  // old "cache the installed flag" behavior would have skipped the second gate's
  // install (and the run would die on `vitest: not found`).
  it("re-runs the deps install before a later gate (pre_audit), not just the first", async () => {
    const state: WorkspaceState = { contract: true, prepared: false, tier1Exit: 0, installRuns: 0 };
    const ssh = new InterpretingSsh(state);
    const gate = buildDefaultGate(
      gateInput(ssh, context({ greenfield: true })),
      target,
      workspacePath,
      new FakeEventStore(),
    );

    await gate({ when: "per_iteration" });
    const ensureCallsAfterFirst = ssh.commands.filter((c) => c.command.includes("deps-ensure")).length;
    await gate({ when: "pre_audit" });
    const ensureCallsAfterSecond = ssh.commands.filter((c) => c.command.includes("deps-ensure")).length;

    // The ensure guard ran on BOTH gates (no latch) — and both actually installed
    // (manifest present), so the install ran twice, not once.
    expect(ensureCallsAfterFirst).toBe(1);
    expect(ensureCallsAfterSecond).toBe(2);
    expect(state.installRuns).toBe(2);
  });
});

// STACK-AGNOSTIC BOOTSTRAP MODE: with no explicit bootstrap command and no
// `.tanren/ci.yml` `bootstrap.run`, buildDefaultGate passes the stack-agnostic
// DEFAULT_BOOTSTRAP_COMMAND LOUD-fallback (`just bootstrap` if a justfile is present,
// else a loud failure) — NO greenfield-vs-frozen branch, NO baked-in stack command.
// The greenfield-vs-frozen concern lives inside the project's `just bootstrap`. The
// bootstrap guard embeds the chosen command verbatim, so we assert on its contents.
describe("buildDefaultGate — stack-agnostic bootstrap mode", () => {
  for (const greenfield of [true, false]) {
    it(`uses the stack-agnostic \`just bootstrap\` fallback (no explicit command, greenfield=${greenfield})`, async () => {
      const state: WorkspaceState = { contract: true, prepared: false, tier1Exit: 0, installRuns: 0 };
      const ssh = new InterpretingSsh(state);
      const gate = buildDefaultGate(
        gateInput(ssh, context({ greenfield })),
        target,
        workspacePath,
        new FakeEventStore(),
      );

      await gate({ when: "per_iteration" });

      const cmd = depsEnsureCommand(ssh);
      // The default fallback defers to `just bootstrap`; Tanren names NO stack.
      expect(cmd).toContain("just bootstrap");
      expect(cmd).not.toMatch(/pnpm|npm|corepack|--frozen-lockfile/u);
    });
  }

  it("an explicit input.bootstrapCommand wins verbatim in BOTH greenfield and brownfield", async () => {
    for (const greenfield of [true, false]) {
      const state: WorkspaceState = { contract: true, prepared: false, tier1Exit: 0, installRuns: 0 };
      const ssh = new InterpretingSsh(state);
      const input = {
        ssh,
        context: context({ greenfield }),
        timeoutMs: 100,
        bootstrapCommand: "just bootstrap --offline",
      } as unknown as RunPlannerLoopInput;
      const gate = buildDefaultGate(input, target, workspacePath, new FakeEventStore());

      await gate({ when: "per_iteration" });

      const cmd = depsEnsureCommand(ssh);
      expect(cmd).toContain("just bootstrap --offline");
    }
  });
});

describe("buildDefaultGate — lenient posture", () => {
  it("a failing tier-1 (advisory) → the gate PASSES with a gate.advisory_failed warning", async () => {
    // The tree is prepared, but tier-1 genuinely fails. Under lenient, tier-1 is advisory.
    const state: WorkspaceState = { contract: true, prepared: false, tier1Exit: 2, installRuns: 0 };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(
      gateInput(ssh, context({ governancePosture: "lenient" })),
      target,
      workspacePath,
      events,
    );

    const outcome = await gate({ when: "per_iteration" });

    expect(outcome.passed).toBe(true);
    const advisory = events.events.find((e) => e.eventType === "gate.advisory_failed");
    expect(advisory).toBeDefined();
    // The cheap per-iteration `tier-1` step is advisory under lenient.
    expect((advisory!.payload as { advisoryStep: string }).advisoryStep).toBe("tier-1");
    expect(events.events.some((e) => e.eventType === "gate.failed")).toBe(false);
    // The fast tier's tier-1 step ran (the advisory did not crash the gate).
    expect(ssh.commands.some((c) => c.command.endsWith("just tier-1"))).toBe(true);
  });

  it("under the strict default the same failing tier-1 FAILS the gate", async () => {
    const state: WorkspaceState = { contract: true, prepared: false, tier1Exit: 2, installRuns: 0 };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    // No governancePosture ⇒ strict default ⇒ every step blocks.
    const gate = buildDefaultGate(gateInput(ssh, context()), target, workspacePath, events);

    const outcome = await gate({ when: "per_iteration" });

    expect(outcome.passed).toBe(false);
    expect(events.events.some((e) => e.eventType === "gate.failed")).toBe(true);
    expect(events.events.some((e) => e.eventType === "gate.advisory_failed")).toBe(false);
  });
});

// COMMIT-BINDING (the gate↔land TOCTOU guard, tanren-owns-the-engine.md §5): the
// `pre_merge` merge gate runs on the live workspace whose HEAD is left at the WRITER
// TIP (bootstrap commit and all), but the PR was pushed from the CLEANED ref (bootstrap
// dropped) — a DIFFERENT sha. The merge authority resolves the landing head from the
// forge PR head, so the `gate.verdict` MUST be anchored on the PUSHED PR head, not the
// workspace HEAD, or `gatedHeadSha != landing head` blocks the merge forever. The gate
// honors a `headShaOverride` for exactly this — these tests prove it is preferred over
// (and the workspace-HEAD read is the absent-override default of) the verdict anchor.
describe("buildDefaultGate — gate.verdict commit-binding (headShaOverride)", () => {
  // WORKSPACE_HEAD = the writer tip (with the bootstrap commit); PR_HEAD = the cleaned
  // ref the PR was pushed from (bootstrap dropped) — the commit the authority lands.
  const WORKSPACE_HEAD = "a".repeat(40);
  const PR_HEAD = "b".repeat(40);

  it("anchors the pre_merge gate.verdict on the PUSHED PR head when a headShaOverride is given (not the workspace HEAD)", async () => {
    const state: WorkspaceState = {
      contract: true,
      prepared: false,
      tier1Exit: 0,
      installRuns: 0,
      workspaceHead: WORKSPACE_HEAD,
      // Task #64: the default merge tier declares junit evidence (minTests: 1) — the
      // virtual workspace must produce a valid JUnit report or the gate fails.
      junitReportXml:
        '<?xml version="1.0"?><testsuites><testsuite name="t"><testcase name="ok"/></testsuite></testsuites>',
    };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context({ greenfield: true })), target, workspacePath, events);

    // The merge authority calls the closure with the PUSHED PR head (the cleaned ref).
    const outcome = await gate({ when: "pre_merge", headShaOverride: PR_HEAD });

    expect(outcome.passed).toBe(true);
    const verdict = events.events.find((e) => e.eventType === "gate.verdict");
    expect(verdict).toBeDefined();
    // The verdict is bound to the PR head (what the authority lands), NOT the writer tip.
    expect((verdict!.payload as { headSha: string }).headSha).toBe(PR_HEAD);
    expect((verdict!.payload as { headSha: string }).headSha).not.toBe(WORKSPACE_HEAD);
  });

  it("falls back to the workspace HEAD as the verdict anchor when no override is given (per_iteration / pre_audit)", async () => {
    const state: WorkspaceState = {
      contract: true,
      prepared: false,
      tier1Exit: 0,
      installRuns: 0,
      workspaceHead: WORKSPACE_HEAD,
    };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context({ greenfield: true })), target, workspacePath, events);

    // The writer-loop gates (no override) bind the verdict to the live workspace HEAD.
    await gate({ when: "per_iteration" });

    const verdict = events.events.find((e) => e.eventType === "gate.verdict");
    expect(verdict).toBeDefined();
    expect((verdict!.payload as { headSha: string }).headSha).toBe(WORKSPACE_HEAD);
  });

  // RESIDUAL #3 — FAIL-CLOSED at the gate boundary (no-silent-fallback doctrine). The
  // pre_merge gate EXPECTS a pushed PR-head override. An empty/absent override there
  // would silently fall back to the workspace HEAD (the writer tip) — the exact
  // wrong-commit binding the fix prevents. So pre_merge + (absent/empty/invalid
  // override) is a LOUD throw the moment the workspace HEAD is a real sha, never a
  // silent fallback.
  it("THROWS on a pre_merge gate with an EMPTY override (no silent workspace-HEAD fallback)", async () => {
    const state: WorkspaceState = {
      contract: true,
      prepared: false,
      tier1Exit: 0,
      installRuns: 0,
      workspaceHead: WORKSPACE_HEAD,
    };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context({ greenfield: true })), target, workspacePath, events);

    // pre_merge with an empty override + a REAL workspace HEAD: must fail closed.
    await expect(gate({ when: "pre_merge", headShaOverride: "" })).rejects.toThrow(/pushed PR-head sha override/u);
    // No verdict was bound to the wrong (workspace HEAD) commit.
    expect(events.events.some((e) => e.eventType === "gate.verdict")).toBe(false);
  });

  it("THROWS on a pre_merge gate with NO override at all (absent ⇒ same fail-closed as empty)", async () => {
    const state: WorkspaceState = {
      contract: true,
      prepared: false,
      tier1Exit: 0,
      installRuns: 0,
      workspaceHead: WORKSPACE_HEAD,
    };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context({ greenfield: true })), target, workspacePath, events);

    await expect(gate({ when: "pre_merge" })).rejects.toThrow(/pushed PR-head sha override/u);
    expect(events.events.some((e) => e.eventType === "gate.verdict")).toBe(false);
  });

  it("THROWS on a NON-40-hex override (corrupt read) at ANY when — never anchors on a bogus commit", async () => {
    const state: WorkspaceState = {
      contract: true,
      prepared: false,
      tier1Exit: 0,
      installRuns: 0,
      workspaceHead: WORKSPACE_HEAD,
    };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context({ greenfield: true })), target, workspacePath, events);

    // A truncated/garbage override is corrupt — reject it (here on the pre_merge path).
    await expect(gate({ when: "pre_merge", headShaOverride: "not-a-sha" })).rejects.toThrow(/not a 40-hex sha/u);
    expect(events.events.some((e) => e.eventType === "gate.verdict")).toBe(false);
  });

  it("the fake-SSH unit path (workspace HEAD resolves to '') is tolerated on pre_merge — no throw, no verdict", async () => {
    // workspaceHead omitted ⇒ `git rev-parse HEAD` yields "" (the fake-SSH unit path).
    // pre_merge + empty override + empty workspace HEAD is the ONLY tolerated no-override
    // case: there is no real commit to bind, so the gate emits no verdict (not a throw).
    const state: WorkspaceState = {
      contract: true,
      prepared: false,
      tier1Exit: 0,
      installRuns: 0,
      // Task #64: provide a valid junit report so the merge tier's evidence assertion passes.
      junitReportXml:
        '<?xml version="1.0"?><testsuites><testsuite name="t"><testcase name="ok"/></testsuite></testsuites>',
    };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context({ greenfield: true })), target, workspacePath, events);

    const outcome = await gate({ when: "pre_merge", headShaOverride: "" });

    expect(outcome.passed).toBe(true);
    expect(events.events.some((e) => e.eventType === "gate.verdict")).toBe(false);
  });
});

// A contract that PARSES, and the same document cut mid-value — what a reader gets when it
// races the `cat >` that materializes the file.
const VALID_CI_YAML = [
  "version: 1",
  "bootstrap:",
  "  run: just bootstrap",
  "tiers:",
  "  fast:",
  "    - name: lint",
  "      run: just tier-1",
  "  slow:",
  "    - name: test",
  "      run: just tier-2",
  "      junitReport: reports/junit.xml",
  "  merge:",
  "    - name: merge-test",
  "      run: just tier-3",
  "      junitReport: reports/junit.xml",
  "when:",
  "  fast:",
  "    - per_iteration",
  "  slow:",
  "    - pre_audit",
  "  merge:",
  "    - pre_merge",
  "",
].join("\n");
const TRUNCATED_CI_YAML = ["version: 1", "bootstrap:", "  run: just bootstrap", "tiers: [", ""].join("\n");

describe("buildDefaultGate — the SECOND `.tanren/ci.yml` read fails CLOSED, not fatally", () => {
  // TWO READS, ONE FILE, A LIVE WORKSPACE. `resolveGateConfig` and
  // `resolveWorkspaceLifecycleCommands` are separate SSH `cat`s of `.tanren/ci.yml` with an
  // `await` between them. The first is wrapped in a classifier that turns an invalid config
  // into a fail-closed P0 gate outcome; the second had no handler at all, so a
  // `CiYamlParseError` there escaped `buildDefaultGate` and TERMINATED the run — the exact
  // outcome the first read's classifier exists to prevent.
  //
  // "The first parsed, so the second must too" only holds if the two reads see the same
  // BYTES. This substrate is the counter-example: valid on the first `cat`, truncated on the
  // second — the shape a gate gets when it races the `cat >` that materializes the file.
  class DriftingCiConfigSsh implements CommandSubstrate {
    readonly commands: RunnerCommand[] = [];
    reads = 0;
    async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
      this.commands.push(command);
      const ok = { exitCode: 0, stdout: "", stderr: "" };
      if (command.command.includes(".tanren/ci.yml") && command.command.includes("cat ")) {
        this.reads += 1;
        return this.reads === 1 ? { ...ok, stdout: VALID_CI_YAML } : { ...ok, stdout: TRUNCATED_CI_YAML };
      }
      if (command.command === "git rev-parse HEAD") return { ...ok, stdout: `${"d".repeat(40)}\n` };
      return ok;
    }
  }

  it("returns a fail-closed gate outcome instead of throwing out of the gate", async () => {
    const ssh = new DriftingCiConfigSsh();
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context()), target, workspacePath, events);

    const outcome = await gate({ when: "pre_merge" });

    // NOT a throw, and NOT a pass: the repo's contract could not be read as valid, so the
    // gate reports that as a finding the loop can act on.
    expect(outcome.passed).toBe(false);
    expect(ssh.reads).toBe(2);
    // …and it never reached the project's own commands with an unvalidated contract.
    expect(ssh.commands.some((c) => c.command.includes("just tier-"))).toBe(false);
  });
});
