/**
 * Fixtures shared by the commit-gate suites (`writerCommitGateRecovery.test.ts`,
 * `writerCommitGateBoundaries.test.ts`). Extracted so each suite stays under the 500-line
 * architecture cap while both drive the SAME rejection — the verbatim one from the bench run.
 */
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../../src/engine/contracts/commandSubstrate.js";
import { type RunnerHandle, sshRunnerHandle } from "../../src/engine/contracts/allocator.js";
import type { CommitRejection, WriterAdapter, WriterResult } from "../../src/engine/providers/types.js";

// Built through the SSH constructor rather than annotated `RunnerHandle`. `RunnerHandle`
// declares ONLY `backend` — the reach fields are `SshRunnerHandle`'s — so a bare literal is an
// excess-property error that nothing catches, because this repo does not typecheck its tests
// (`tsconfig` `include` is `src/**/*.ts`). `sshRunnerHandle` is the single place that stamps
// the tag, so the fixture is checked against the real shape.
export const target = sshRunnerHandle({
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
});

export const WORKSPACE = "/workspace/runs/run_gate/repo";
export const BASELINE_SHA = "b".repeat(40);
export const WRITER_DIFF = "diff --git a/x b/x\n";

// The rejection VERBATIM from the bench run, split across the two streams the way the real
// tooling splits it: cspell writes its findings (the actionable part — the files, the lines,
// the unknown word) to STDOUT, and husky writes only its epilogue to STDERR.
export const CSPELL_STDOUT = [
  "backend/tests/unit/events/test_treatmentx_isolation.py:37:36 - Unknown word (TREATMENTX)",
  "backend/tests/unit/events/test_event_enums.py:164:25 - Unknown word (TREATMENTX)",
  "CSpell: Files checked: 4, Issues found: 23 in 4 files.",
].join("\n");
export const HUSKY_STDERR = [
  "Lint-staged failed. Please fix the issues above.",
  "husky - pre-commit script failed (code 1)",
].join("\n");

export function isCommit(command: string): boolean {
  return /git (?:-c [^ ]+ )?commit /u.test(command);
}

/**
 * A scripted writer that can report a commit the project's hook rejected. Shared here
 * rather than added to `makeScriptedWriter`: that helper sits exactly at the 500-line
 * architecture cap, and this fixture is only meaningful for the commit-gate path. Used by
 * `writerCommitGateRecovery.test.ts` and `writerCommitGateInjection.test.ts`, which need the
 * SAME loop harness to compare a benign rejection against a poisoned one.
 *
 * A rejected commit lands NO commit — `git add -A` succeeded and only `git commit` was
 * refused — but the work stays in the tree, so the diff is non-empty while `commits` is
 * empty. The loop keys its convergence work signature off that diff.
 */
export function makeCommitGateWriter(
  script: ReadonlyArray<{ diff: string; exitReason: WriterResult["exitReason"]; rejection?: CommitRejection }>,
): WriterAdapter & { calls: Array<{ prompt: string }> } {
  let index = 0;
  const calls: Array<{ prompt: string }> = [];
  return {
    kind: "writer",
    cli: "fake",
    authRef: "managed:codex:default",
    calls,
    async runWriter(opts): Promise<WriterResult> {
      calls.push({ prompt: opts.prompt });
      const entry = script[index] ?? script.at(-1) ?? { diff: "", exitReason: "completed" as const };
      index += 1;
      return {
        diff: entry.diff,
        commits:
          entry.diff === "" || entry.exitReason === "commit_rejected"
            ? []
            : [{ sha: `sha_${index}`, message: `subtask ${index}` }],
        exitReason: entry.exitReason,
        ...(entry.rejection === undefined ? {} : { commitRejection: entry.rejection }),
        telemetry: { rawEventCount: 1 },
      };
    },
  };
}

/** A substrate whose project pre-commit hook rejects the writer's commit, cspell-style. */
export class HookRejectsSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];

  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (isCommit(command.command)) {
      return { exitCode: 1, stdout: CSPELL_STDOUT, stderr: HUSKY_STDERR, timedOut: false };
    }
    // No commit landed, so the baseline..HEAD log is empty.
    if (command.command.includes("git log")) return ok;
    if (command.command.includes("git diff --no-color")) return { ...ok, stdout: WRITER_DIFF };
    if (command.command.includes("git rev-parse HEAD")) return { ...ok, stdout: `${BASELINE_SHA}\n` };
    return ok;
  }
}
