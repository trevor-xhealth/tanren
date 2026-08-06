// WHERE THE COMMIT GATE'S RECOVERY STOPS — the boundaries that keep it honest.
//
// `writerCommitGateRecovery.test.ts` proves a hook NO vote reaches the writer instead of
// killing the run. This file proves the three things that must NOT happen as a result:
//
//   1. Only a HOOK VERDICT is recoverable. `runWorkspaceSshCommand` throws for three
//      different reasons and only one of them is the project rendering a judgment; a
//      substrate fault, a watchdog stall, or a failure of the STAGING step means the hook
//      never ran at all. Nor did it run when GIT ITSELF could not perform the commit — no
//      author identity, a held index.lock, a signing key it could not use — which git
//      reports with its own fatal exit 128 while normalizing every hook rejection to 1.
//      Re-telling any of those as "your work is bad" would send the writer chasing a defect
//      that is not in its diff, burning iterations against a condition it cannot fix.
//   2. A rejection rides only the arm it describes — never a timeout/crash/window_exhausted.
//   3. Tanren's own hard-coded commit messages are preflighted under live hooks BEFORE any
//      writer runs, so a repo that refuses them halts as configuration, not as writer rework.
import { describe, expect, it } from "vitest";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { captureGitStateAfterCodex } from "../src/engine/providers/codexGit.js";
import { captureGitStateAfterWriter } from "../src/engine/providers/writerGit.js";
import { classifyCommitRejection, writerExitReasonFor } from "../src/engine/providers/writerCommitGate.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { createPiWriter } from "../src/engine/providers/pi.js";
import { commitBootstrapState } from "../src/engine/workspace/bootstrap.js";
import { WorkspaceCommandError } from "../src/engine/workspace/index.js";
import {
  BASELINE_SHA,
  CSPELL_STDOUT,
  HUSKY_STDERR,
  HookRejectsSsh,
  WORKSPACE,
  WRITER_DIFF,
  isCommit,
  target,
} from "./helpers/commitGateFixtures.js";

const result = (over: Partial<CommandResult>): CommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr: "",
  ...over,
});

describe("only a HOOK VERDICT is recoverable — infrastructure faults stay fatal", () => {
  it("a plain nonzero exit IS the hook's verdict", () => {
    const rejection = classifyCommitRejection(
      new WorkspaceCommandError("boom", "commit codex workspace changes", result({ stdout: CSPELL_STDOUT })),
    );

    expect(rejection?.exitCode).toBe(1);
    expect(rejection?.output).toContain("TREATMENTX");
  });

  it("a SUBSTRATE FAILURE is not a verdict — it must keep propagating", () => {
    const rejection = classifyCommitRejection(
      new WorkspaceCommandError("boom", "commit codex workspace changes", result({ failure: { reason: "ssh_error" } })),
    );

    expect(rejection).toBeUndefined();
  });

  it("a WATCHDOG STALL is not a verdict — it must keep propagating", () => {
    const rejection = classifyCommitRejection(
      new WorkspaceCommandError("boom", "commit codex workspace changes", result({ stalled: true })),
    );

    expect(rejection).toBeUndefined();
  });

  it("a non-WorkspaceCommandError throw is never reinterpreted", () => {
    expect(classifyCommitRejection(new Error("something else"))).toBeUndefined();
  });

  it("a zero or absent exit code is not a verdict either", () => {
    // Defense in depth. `runWorkspaceSshCommand` cannot produce these once the failure
    // and stalled arms are excluded, so reaching here means the error did not come from
    // the hook — and inventing a rejection from it would fabricate a verdict the project
    // never rendered, then steer the writer with an empty complaint.
    const label = "commit codex workspace changes";
    expect(classifyCommitRejection(new WorkspaceCommandError("x", label, result({ exitCode: 0 })))).toBeUndefined();
    expect(classifyCommitRejection(new WorkspaceCommandError("x", label, result({ exitCode: null })))).toBeUndefined();
  });

  it("a STAGING failure is not a verdict — `git add -A` runs as its own command", async () => {
    // #1420 review (CodeRabbit + codex, same defect from two directions). `git add -A` and
    // `git commit` used to share one `set -eu` script, so an index.lock conflict, a
    // permission error or an unreadable path exited nonzero with no `failure` and no
    // `stalled` — indistinguishable from a hook NO vote. The writer was then handed "the
    // project's own pre-commit gate REJECTED your work" for a fault that is not in its diff
    // and could not be fixed by editing files, and the loop burned iterations against it.
    //
    // The fix is structural, not a sentinel exit code (a hook may exit 3 as freely as git):
    // staging is its own command, so only the COMMIT's exit is ever offered to the
    // classifier. This test drives the fault a shared script would have laundered.
    class StagingFailsSsh implements CommandSubstrate {
      readonly commands: RunnerCommand[] = [];
      async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
        this.commands.push(command);
        if (command.command.includes("git add -A")) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "fatal: Unable to create '/workspace/.git/index.lock': File exists.",
            timedOut: false,
          };
        }
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
    }

    const ssh = new StagingFailsSsh();
    await expect(captureGitStateAfterCodex(ssh, target, WORKSPACE, BASELINE_SHA)).rejects.toThrow(
      "stage codex workspace changes failed",
    );

    // And it never reached the commit: the run stops at the substrate fault rather than
    // committing a partially staged tree and reading the hook's opinion of it.
    expect(ssh.commands.some((c) => isCommit(c.command))).toBe(false);
    // Pre-fix this same substrate returned a `CommitRejection` instead of throwing, because
    // the one combined command carried BOTH steps. Pin the split itself so a future "tidy
    // this back into one script" restores the defect loudly.
    const staging = ssh.commands.filter((c) => c.command.includes("git add -A"));
    expect(staging).toHaveLength(1);
    expect(staging[0]?.command).toBe("git add -A");
  });

  it("the writerGit twin splits staging the same way", async () => {
    class StagingFailsSsh implements CommandSubstrate {
      async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
        if (command.command.includes("git add -A")) {
          return { exitCode: 128, stdout: "", stderr: "error: insufficient permission", timedOut: false };
        }
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
    }

    await expect(
      captureGitStateAfterWriter(new StagingFailsSsh(), target, WORKSPACE, BASELINE_SHA, "claude writer"),
    ).rejects.toThrow("stage writer workspace changes failed");
  });

  it("the gated commit command carries the commit ALONE — nothing else can be read as the verdict", async () => {
    // The other half of the split, from the success side. Whatever the gated command
    // contains is what `classifyCommitRejection` is allowed to interpret, so the guarantee
    // is a property of that command's TEXT: it must not carry a second fallible step.
    const ssh = new HookRejectsSsh();
    await captureGitStateAfterCodex(ssh, target, WORKSPACE, BASELINE_SHA);

    const gated = ssh.commands.find((c) => isCommit(c.command));
    expect(gated?.command).not.toContain("git add");
    expect(gated?.command).toContain("git diff --cached --quiet --exit-code");
  });

  it("GIT'S OWN failure at the commit is not a verdict — exit 128 stays fatal", () => {
    // #1420 review, the residual the staging split did not reach. Splitting `git add -A` out
    // guaranteed only the COMMIT's exit reaches the classifier — necessary, but `git commit`
    // itself fails for reasons no hook is involved in, and those arrived wearing the identical
    // shape (`failure === undefined`, not stalled, nonzero exit). The writer was told "the
    // project's own pre-commit gate REJECTED your work" for a missing `user.email` and burned
    // iterations against a condition no edit to its diff can reach.
    //
    // The discriminator is git's OWN exit code, and it exists because git NORMALIZES a hook
    // rejection. Measured on git 2.50.1: a pre-commit hook and a commit-msg hook exiting
    // 1/2/3/42/128/255 all produce `git commit` exit 1 — git reports its own code, never the
    // hook's. Git's operational failures all `die()` with 128. Each stderr below is the
    // verbatim first line git emitted in that measurement.
    for (const stderr of [
      "fatal: empty ident name (for <>) not allowed",
      "fatal: Unable to create '/workspace/.git/index.lock': File exists.",
      "error: gpg failed to sign the data:",
      "fatal: not a git repository (or any of the parent directories): .git",
    ]) {
      const error = new WorkspaceCommandError(
        "boom",
        "commit codex workspace changes",
        result({ exitCode: 128, stderr }),
      );
      expect(classifyCommitRejection(error)).toBeUndefined();
    }
  });

  it("but an unrecognized nonzero exit still reaches the writer — the rule is ONE-SIDED", () => {
    // Deliberate asymmetry, and the reason the guard excludes 128 rather than requiring 1.
    // Being wrong in the excluding direction re-throws and kills the run — reinstating the
    // exact run-killer this module removes — so anything not positively identified as git
    // failing keeps its benefit of the doubt and is fed back as steering.
    const label = "commit codex workspace changes";
    for (const exitCode of [1, 2, 3, 42, 127, 255]) {
      const rejection = classifyCommitRejection(
        new WorkspaceCommandError("boom", label, result({ exitCode, stdout: CSPELL_STDOUT })),
      );
      expect(rejection?.exitCode).toBe(exitCode);
    }
  });

  it("end to end: a commit git itself could not perform THROWS rather than steering the writer", async () => {
    // The whole point, from the caller's side. Pre-fix this returned a `CommitRejection` and
    // `captureGitStateAfterCodex` resolved, so the loop steered the writer to fix its diff
    // over an unset `user.email`. It must surface as the workspace fault it is.
    class NoIdentitySsh implements CommandSubstrate {
      async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
        if (isCommit(command.command)) {
          return {
            exitCode: 128,
            stdout: "",
            stderr: "fatal: empty ident name (for <>) not allowed",
            timedOut: false,
          };
        }
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
    }

    await expect(captureGitStateAfterCodex(new NoIdentitySsh(), target, WORKSPACE, BASELINE_SHA)).rejects.toThrow(
      "commit codex workspace changes failed",
    );
    await expect(
      captureGitStateAfterWriter(new NoIdentitySsh(), target, WORKSPACE, BASELINE_SHA, "claude writer"),
    ).rejects.toThrow("commit writer workspace changes failed");
  });

  it("classifies the writer's exitReason from the presence of a rejection", () => {
    // The seam all six adapters share (writerExitReasonFor). A writer whose commit landed
    // is `completed`; one whose commit the hook refused is `commit_rejected` — inverting
    // this would either lose the recovery entirely or mark clean work as rejected.
    expect(writerExitReasonFor({})).toBe("completed");
    expect(writerExitReasonFor({ commitRejection: undefined })).toBe("completed");
    expect(writerExitReasonFor({ commitRejection: { label: "l", exitCode: 1, output: "o" } })).toBe("commit_rejected");
  });

  it("captureGitStateAfterCodex still THROWS when the substrate itself failed at the commit", async () => {
    // End-to-end negative control: the recovery path must not have made every failed
    // commit survivable, only the ones the project actually judged.
    class SubstrateFailsSsh implements CommandSubstrate {
      async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
        if (isCommit(command.command)) {
          return { exitCode: null, stdout: "", stderr: "", failure: { reason: "ssh_error" } };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    }

    await expect(captureGitStateAfterCodex(new SubstrateFailsSsh(), target, WORKSPACE, BASELINE_SHA)).rejects.toThrow(
      "commit codex workspace changes failed",
    );
  });
});
describe("a rejection rides ONLY the arm it describes", () => {
  // #1420 review. The adapters capture git state — and therefore the rejection — BEFORE
  // they branch on stalled / usage-limit / nonzero-exit, so a writer that stalled mid-edit
  // and left a tree the hook then ALSO refused has both facts at once. `failedResult` used
  // to build its result with `...gitState`, which carried the rejection onto a `timeout`.
  //
  // The type says "set iff `exitReason === "commit_rejected"`", and this is the case where
  // that stops being free. The leak is invisible to the compiler — the wider captured object
  // is structurally assignable to the narrower `Pick<WriterResult, "diff" | "commits">`
  // parameter — so nothing but a test can hold the invariant.
  //
  // It matters beyond tidiness: `commitRejection` is the writer's steering payload and the
  // hook's output is the TARGET repository's source text. A consumer that reads the field
  // rather than the discriminant would render a rejected commit's file list under a
  // "the writer timed out" heading and steer the writer to fix a violation in a diff the
  // stall means it never finished writing.
  class StalledWriterHookRejectsSsh implements CommandSubstrate {
    async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
      const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      if (command.command.includes("git rev-parse HEAD")) return { ...ok, stdout: `${BASELINE_SHA}\n` };
      if (isCommit(command.command))
        return { exitCode: 1, stdout: CSPELL_STDOUT, stderr: HUSKY_STDERR, timedOut: false };
      if (command.command.includes("git diff --no-color")) return { ...ok, stdout: WRITER_DIFF };
      if (command.command.startsWith("git ")) return ok;
      // Everything else is the CLI itself, and it went silent — the watchdog's
      // no-sign-of-life stall. (Matched last: the commit message is "pi writer".)
      return { ...ok, stalled: true };
    }
  }

  it("a stalled writer whose commit was ALSO refused reports timeout, and carries no rejection", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/pi/dev", value: "sk-pi-test-key" });
    const writer = createPiWriter({
      secrets,
      ssh: new StalledWriterHookRejectsSsh(),
      target,
      credentialRef: "credential/pi/dev",
      runId: "run_pi_invariant",
    });

    const piResult = await writer.runWriter({ prompt: "make an edit", workspace: WORKSPACE });

    // The stall WINS — a writer killed mid-edit leaves a tree the hook will obviously
    // refuse, so the stall EXPLAINS the rejection rather than the other way round.
    expect(piResult.exitReason).toBe("timeout");
    // …and the rejection does not tag along. Pre-fix this was the full CommitRejection.
    expect(piResult.commitRejection).toBeUndefined();
    expect(Object.hasOwn(piResult, "commitRejection")).toBe(false);
    // The partial work is still reported — that is the timeout arm's own progress signal.
    expect(piResult.diff).toBe(WRITER_DIFF);
  });
});

describe("Tanren's own commit messages are preflighted before the writer ever runs", () => {
  // The mechanism behind declining the `commit-msg` half of the codex finding on #1420.
  //
  // The concern: a project running commitlint would refuse Tanren's hard-coded writer
  // message ("codex writer", "claude writer"), the writer would be steered to fix files,
  // and no file edit can ever make a fixed message pass — so the run would burn iterations
  // and stall as writer rework instead of surfacing an orchestrator/config problem.
  //
  // Why it cannot happen: `commitBootstrapState` already commits with a hard-coded Tanren
  // message, under the project's LIVE hook path, during workspace preparation — strictly
  // before any writer runs. A repo whose `commit-msg` hook rejects Tanren's messages
  // therefore halts there, as a loud fatal workspace error, which is exactly the
  // classification the finding asks for. The writer commit is only ever reached in a repo
  // that has already accepted one.
  //
  // That argument is only true while the bootstrap commit keeps its hooks live, so pin it:
  // adding `--no-verify` or a `core.hooksPath` redirect here to "make bootstrap robust"
  // would silently make the declined scenario reachable.
  it("the bootstrap commit runs the project's hooks — it does not bypass them", async () => {
    const commands: RunnerCommand[] = [];
    const ssh: CommandSubstrate = {
      async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
        commands.push(command);
        return { exitCode: 0, stdout: `${"c".repeat(40)}\n`, stderr: "", timedOut: false };
      },
    };

    await commitBootstrapState({ ssh, target, workspacePath: WORKSPACE });

    const bootstrap = commands[0]?.command ?? "";
    expect(bootstrap).toContain("git commit");
    expect(bootstrap).not.toContain("--no-verify");
    expect(bootstrap).not.toContain("hooksPath");
  });
});
