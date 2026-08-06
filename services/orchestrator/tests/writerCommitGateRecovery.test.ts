// THE PROJECT'S COMMIT GATE IS FEEDBACK, NOT A RUN-KILLER.
//
// The writer adapters edit the workspace in place and Tanren commits afterwards, with the
// repository's hook path deliberately LIVE (#1407/#1408) so the project's own pre-commit
// gate votes on Tanren's output. Before this change a NO vote was fatal:
// `runWorkspaceSshCommand` throws on a nonzero exit, NOTHING on the writer path catches it,
// the stage finalize guard mislabels it `crashed` and re-throws, and the run dies as
// `run.failed { failureCode: "workspace" }` — discarding every already-passed subtask and
// all convergence state, and skipping run-end accounting. The writer, the one agent that
// could have fixed it, had already exited and never learned anything was wrong.
//
// Observed live on a real-monorepo bench run against a hard spec: the writer authored a real
// test file, cspell rejected the commit over ONE new domain term, and the run halted. The
// human who solved the same spec hit the identical gate and fixed it with a two-line
// dictionary edit. Everything needed to fix it was in the error text.
//
// A commit rejected by the project's own quality gate is the MOST actionable failure a
// writer can receive — deterministic, local, reproducible, self-describing. So it is now
// classified (`exitReason: "commit_rejected"`) and routed through the SAME feedback path a
// failed gate tier uses: re-drive the writer with the hook's own output as steering, under
// the SAME convergence budget, converging to the usual loud P0 fixed point if it cannot be
// satisfied. No new retry budget, no commit retry, no weakening of the hook.
import { describe, expect, it } from "vitest";
import type { CommitRejection } from "../src/engine/providers/types.js";
import { captureGitStateAfterCodex } from "../src/engine/providers/codexGit.js";
import { captureGitStateAfterWriter } from "../src/engine/providers/writerGit.js";
import { COMMIT_REJECTION_OUTPUT_LIMIT, commitRejectionOutput } from "../src/engine/providers/writerCommitGate.js";
import { commitRejectionReason } from "../src/engine/workflow/commitGateSteering.js";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import {
  buildPlan,
  cleanAudit,
  completeCheck,
  convergenceStalled,
  defaultLoopInput,
  makeAuditor,
  makeChecker,
  makeConvergence,
  makePlanner,
  makeTriage,
  triageAllTasks,
} from "./helpers/plannerLoopHelpers.js";
import {
  BASELINE_SHA,
  CSPELL_STDOUT,
  HUSKY_STDERR,
  HookRejectsSsh,
  WORKSPACE,
  WRITER_DIFF,
  makeCommitGateWriter,
  target,
} from "./helpers/commitGateFixtures.js";

describe("the project's commit gate reaches the writer instead of killing the run", () => {
  it("codexGit: a rejected commit comes back as a VALUE carrying the hook output, not a throw", async () => {
    const ssh = new HookRejectsSsh();

    const state = await captureGitStateAfterCodex(ssh, target, WORKSPACE, BASELINE_SHA);

    expect(state.commitRejection).toBeDefined();
    expect(state.commitRejection?.label).toBe("commit codex workspace changes");
    expect(state.commitRejection?.exitCode).toBe(1);
    // No commit landed, but the WORK SURVIVED in the tree — the diff is what the loop
    // uses as the convergence work signature, so losing it would blind the detector.
    expect(state.commits).toEqual([]);
    expect(state.diff).toBe(WRITER_DIFF);
  });

  it("writerGit: the shared CLI-adapter path behaves identically", async () => {
    const ssh = new HookRejectsSsh();

    const state = await captureGitStateAfterWriter(ssh, target, WORKSPACE, BASELINE_SHA, "claude writer");

    expect(state.commitRejection?.label).toBe("commit writer workspace changes");
    expect(state.commits).toEqual([]);
    expect(state.diff).toBe(WRITER_DIFF);
  });

  it("captures BOTH streams — the actionable findings are on stdout, not stderr", async () => {
    // The sharpest content bug available here. The thrown error's message carries a
    // stderr tail ONLY; had the rejection reused it, the writer would receive
    // "Lint-staged failed. Please fix the issues above." and NOT the lines naming the
    // files, the line numbers and the unknown word — i.e. everything needed to fix it.
    const ssh = new HookRejectsSsh();

    const state = await captureGitStateAfterCodex(ssh, target, WORKSPACE, BASELINE_SHA);
    const output = state.commitRejection?.output ?? "";

    expect(output).toContain("Unknown word (TREATMENTX)");
    expect(output).toContain("test_treatmentx_isolation.py:37:36");
    expect(output).toContain("husky - pre-commit script failed");
  });

  it("bounds the hook output it carries, keeping the TAIL", () => {
    // Rides in a writer prompt; a pathological hook must not balloon it. The tail is
    // kept because tooling prints its summary and verdict last.
    const huge = `${"x".repeat(50_000)}\nFINAL VERDICT LINE`;
    const output = commitRejectionOutput({ exitCode: 1, stdout: huge, stderr: "" });

    expect(output.length).toBeLessThanOrEqual(COMMIT_REJECTION_OUTPUT_LIMIT);
    expect(output).toContain("FINAL VERDICT LINE");
  });

  it("keeps output that is EXACTLY at the limit whole", () => {
    // The boundary itself: `<=` must not be `<`. One char over is truncated to exactly
    // the limit and loses its head; exactly at the limit is passed through untouched.
    const exact = "y".repeat(COMMIT_REJECTION_OUTPUT_LIMIT);
    expect(commitRejectionOutput({ exitCode: 1, stdout: exact, stderr: "" })).toBe(exact);

    const oneOver = `Z${"y".repeat(COMMIT_REJECTION_OUTPUT_LIMIT)}`;
    const truncated = commitRejectionOutput({ exitCode: 1, stdout: oneOver, stderr: "" });
    expect(truncated).toHaveLength(COMMIT_REJECTION_OUTPUT_LIMIT);
    expect(truncated.startsWith("Z")).toBe(false);
  });

  it("joins the two streams exactly, dropping an empty one rather than leaving a blank line", () => {
    // Exact equality, not `toContain`: a stray separator when one stream is empty would
    // put a leading/trailing blank line in front of the writer's only view of the failure.
    expect(commitRejectionOutput({ exitCode: 1, stdout: "findings", stderr: "epilogue" })).toBe("findings\nepilogue");
    expect(commitRejectionOutput({ exitCode: 1, stdout: "", stderr: "epilogue" })).toBe("epilogue");
    expect(commitRejectionOutput({ exitCode: 1, stdout: "findings", stderr: "   \n  " })).toBe("findings");
    expect(commitRejectionOutput({ exitCode: 1, stdout: "", stderr: "" })).toBe("");
  });
});

// THE SHARP EDGE of the whole change. `runWorkspaceSshCommand` throws for three different
// reasons and only ONE of them is the project rendering a judgment. A substrate fault or a
// watchdog stall means the hook never ran at all; re-telling either as "your work is bad"
// would send the writer chasing a defect that is not in its diff, burning iterations
describe("the steering handed to the writer", () => {
  it("carries the hook's own output so the writer fixes the named violation", () => {
    const reason = commitRejectionReason({
      label: "commit codex workspace changes",
      exitCode: 1,
      output: `${CSPELL_STDOUT}\n${HUSKY_STDERR}`,
    });

    expect(reason).toContain("Unknown word (TREATMENTX)");
    expect(reason).toContain("test_treatmentx_isolation.py:37:36");
  });

  it("forbids evading the gate, and says so in the specific ways a model would try", () => {
    // A pre-commit hook is trivially defeatable. A writer told only "make the commit
    // succeed" may reach for --no-verify or gut the rule — which would hand back a PR
    // whose green gate proves nothing. The directive names the evasions explicitly.
    const reason = commitRejectionReason({ label: "commit codex workspace changes", exitCode: 1, output: "nope" });

    expect(reason).toContain("--no-verify");
    expect(reason).toContain("core.hooksPath");
    expect(reason.toLowerCase()).toContain("never");
  });

  it("names the exit code, and omits the output section when there is nothing to show", () => {
    // Two degenerate shapes that must still produce usable steering rather than a
    // dangling "Commit gate output:" header with nothing under it.
    const withExit = commitRejectionReason({ label: "l", exitCode: 3, output: "" });
    expect(withExit).toContain("(exit 3)");
    expect(withExit).not.toContain("Commit gate output follows.");
    expect(withExit).not.toContain("BEGIN COMMIT GATE OUTPUT");

    // A rejection the caller could not supply — the steering must still stand alone.
    const absent: CommitRejection | undefined = undefined;
    const noRejection = commitRejectionReason(absent);
    // The header LINE, not `not.toContain("exit")`: the point is that the header claims no
    // exit code it does not have, and a substring ban would also fire on any future wording
    // that merely contains those four letters ("existing", "exit criteria").
    expect(noRejection.split("\n")[0]).toBe("the project's own pre-commit gate REJECTED your work");
    expect(noRejection).not.toContain("Commit gate output follows.");
  });

  it("tells the writer what the gate IS and where to fix it", () => {
    // The instructional half of the directive. Each clause is asserted because each is a
    // separate decision about how the writer should read the failure: what the gate
    // represents, that the hook's own output is the source of truth, and that the repair
    // belongs at the source rather than anywhere the error happens to point.
    const reason = commitRejectionReason({ label: "l", exitCode: 1, output: "nope" });

    expect(reason).toContain("declared quality bar for every commit");
    expect(reason).toContain("whatever it enforces");
    expect(reason).toContain("Read the hook output below");
    expect(reason).toContain("fix them at the source");
    expect(reason).toContain("genuinely correct and new");
    expect(reason).toContain("a new domain term the project's dictionary has not seen");
    expect(reason).toContain("updating the project's OWN declared configuration to register it");
  });

  it("separates header, directive and hook output onto their own lines", () => {
    // The writer reads this inline in its prompt; a collapsed join would run the exit
    // code, the instructions and the hook's file:line list together into one blob.
    const lines = commitRejectionReason({ label: "l", exitCode: 1, output: "one\ntwo" }).split("\n");

    expect(lines[0]).toBe("the project's own pre-commit gate REJECTED your work (exit 1)");
    expect(lines[1]?.startsWith("This is the project's declared quality bar")).toBe(true);
    // The hook's output is FENCED as untrusted data (see writerCommitGateInjection.test.ts):
    // an untrusted-data warning, then a BEGIN marker, the output verbatim, an END marker.
    expect(lines[2]?.startsWith("Commit gate output follows.")).toBe(true);
    expect(lines[3]?.startsWith("--- BEGIN COMMIT GATE OUTPUT ")).toBe(true);
    expect(lines.slice(4, 6)).toEqual(["one", "two"]);
    expect(lines[6]?.startsWith("--- END COMMIT GATE OUTPUT ")).toBe(true);
    expect(lines).toHaveLength(7);
  });

  it("keeps the anti-evasion clauses that make a green gate mean something", () => {
    // These specific sentences are load-bearing: they are what stops the writer from
    // "fixing" the rejection by removing the check that produced it.
    const reason = commitRejectionReason({ label: "l", exitCode: 1, output: "nope" });

    expect(reason).toContain("never remove or disable a hook");
    expect(reason).toContain("never weaken a rule merely to silence");
    expect(reason).toContain("A hook that ran and passed is evidence; a hook that was skipped is not.");
    expect(reason).toContain("\nnope\n");
  });

  it("still permits the fix a human maintainer would actually make", () => {
    // The counterweight: the reference human fix for the bench failure was to register
    // the new domain term in the project's own dictionary. The steering must not read as
    // "never touch project configuration", or it forecloses the correct repair.
    const reason = commitRejectionReason({ label: "commit codex workspace changes", exitCode: 1, output: "nope" });

    expect(reason).toMatch(/dictionary|declared configuration/iu);
  });
});

describe("the inner loop RECOVERS — the live bench failure, end to end", () => {
  const plan = buildPlan([{ title: "T1", intent: "add the isolation test", behaviorIds: ["B1"] }]);
  const rejection = {
    label: "commit codex workspace changes",
    exitCode: 1,
    output: `${CSPELL_STDOUT}\n${HUSKY_STDERR}`,
  };

  it("re-drives the writer with the hook output and COMPLETES the spec", async () => {
    // THE REGRESSION. Attempt 1 authors the test file and the project's cspell hook
    // rejects the commit; attempt 2 also registers the new term and the commit lands.
    // Before this change attempt 1 THREW and there was no attempt 2 — the run died.
    const writer = makeCommitGateWriter([
      { diff: WRITER_DIFF, exitReason: "commit_rejected", rejection },
      { diff: `${WRITER_DIFF}+TREATMENTX\n`, exitReason: "completed" },
    ]);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([plan]),
        writer,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
    });

    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    expect(writer.calls.length).toBe(2);
  });

  it("the SECOND prompt contains the hook's own output — the writer is told what to fix", async () => {
    // Recovery is only real if the feedback actually reaches the model. Assert on the
    // prompt text, not merely on the fact that a second call happened.
    const writer = makeCommitGateWriter([
      { diff: WRITER_DIFF, exitReason: "commit_rejected", rejection },
      { diff: `${WRITER_DIFF}+TREATMENTX\n`, exitReason: "completed" },
    ]);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([plan]),
        writer,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
    });

    await runSubtaskLoop(input);

    const second = writer.calls[1]?.prompt ?? "";
    expect(second).toContain("Unknown word (TREATMENTX)");
    expect(second).toContain("test_treatmentx_isolation.py:37:36");
    expect(second).toContain("--no-verify");
    // And the FIRST prompt did not — the steering is a consequence of the rejection.
    expect(writer.calls[0]?.prompt ?? "").not.toContain("TREATMENTX");
  });

  it("a writer that can NEVER satisfy the hook converges LOUDLY — bounded, not infinite", async () => {
    // THE BUDGET GUARANTEE, and the reason this is not a "retry the commit" loop.
    //
    // Recovery reuses the loop's EXISTING bound and adds no new one. Tanren's doctrine is
    // that no loop is capped by a count (config/shared.ts — the v35 removal of
    // `maxWriterIterPerSubtask`): a loop runs while it CONVERGES and stops at an
    // intelligently-detected fixed point. So an identical hook complaint over an identical
    // diff terminates the inner loop as a residual P0, and the spec-level convergence
    // judgment then halts the run — the exact shape a permanently-failing GATE tier
    // produces (cf. bootstrapFailureRouting.test.ts), because it is the same machinery.
    const writer = makeCommitGateWriter([{ diff: WRITER_DIFF, exitReason: "commit_rejected", rejection }]);
    const { input } = defaultLoopInput({
      convergencePolicy: {
        maxConsecutiveStalls: 1,
        demoRunEnabled: false,
        velocityDeferEnabled: false,
        velocityDeferMaxSeverity: "P3",
        velocityDeferAfterStalls: 0,
      },
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([plan]),
        writer,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
        triage: makeTriage([triageAllTasks]),
        // The hook rejects unchanged every round ⇒ the convergence answerer stalls.
        convergence: makeConvergence([convergenceStalled]),
      },
    });

    const outcome = await runSubtaskLoop(input);

    // It HALTED LOUDLY — it neither looped forever nor laundered the rejection into a pass.
    expect(outcome.kind).toBe("convergence_stalled");
    // EXACTLY two. The scripted writer returns a byte-identical diff and a byte-identical
    // rejection every round, so the fixed-point detector has a determinate answer: attempt 1
    // establishes the signature, attempt 2 repeats it and IS the fixed point. A bound like
    // `toBeLessThan(20)` proves only termination — it would sit green through a regression
    // that made the detector need six rounds to notice a repeat it can see in one.
    expect(writer.calls.length).toBe(2);
  });
});
