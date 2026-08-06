/**
 * writerCommitGate — the seam that turns the PROJECT's commit gate from a
 * run-killing exception into writer steering.
 *
 * WHY THIS EXISTS
 *
 * The CLI writer adapters edit the workspace in place; Tanren commits afterwards
 * (`writerGit.captureGitStateAfterWriter` / `codexGit.captureGitStateAfterCodex`).
 * That commit deliberately leaves the repository's hook path LIVE, because it
 * carries the writer's content into the PR — so the project's `pre-commit` hook
 * (lint, format, spell-check, typecheck, whatever the project declares) gets a
 * vote on Tanren's output. Keeping that vote is the whole point; #1407 already
 * argued that silencing it would make Tanren's output the only content in the
 * repo the project's gate never saw.
 *
 * But a NO vote used to be fatal. `runWorkspaceSshCommand` throws on any nonzero
 * exit, nothing on the path from the commit up to `plannerRun` catches it, and
 * `runStageBodyWithFinalizeGuard` re-throws after marking the row failed. So a
 * hook rejection escaped the subtask loop entirely: the run died as
 * `run.failed { failureCode: "workspace" }`, every passed subtask and all
 * convergence state was discarded, and run-end accounting never ran. The writer
 * never learned that anything was wrong — the one agent that could have fixed it
 * in a single edit was already gone.
 *
 * That is backwards. A commit rejected by the project's own quality gate is the
 * MOST actionable failure a writer can receive: deterministic, local, reproducible,
 * and self-describing — it names the files, the lines, and the rule. It is the same
 * class of signal as a failed gate tier, which the subtask loop already feeds back
 * to the writer as steering (`subtaskInnerLoop.gateReason`). This module classifies
 * the commit's failure so the adapters can report it as `exitReason:
 * "commit_rejected"` and the loop can re-drive the writer with the hook's own
 * output, under the SAME convergence budget that governs a failed gate tier.
 *
 * WHAT IS AND IS NOT A VERDICT
 *
 * Only a genuine NONZERO EXIT is the hook's verdict. `runWorkspaceSshCommand` also
 * throws when the substrate itself failed (`result.failure`) or when the activity
 * watchdog saw no sign of life (`result.stalled`). Those are INFRASTRUCTURE faults
 * — the hook never rendered a judgment — and laundering them into "the writer's
 * work is bad" would send the writer chasing a defect that is not in its diff,
 * burning iterations against an unfixable condition. They keep propagating as
 * fatal, exactly as before. This distinction is the sharpest edge in the module.
 *
 * Nonzero is necessary but NOT sufficient, and that took two passes to get right.
 * A nonzero exit can also come from the step BEFORE the hook (staging — split into
 * its own command, see `stageWorkspaceChanges`) or from GIT ITSELF failing to
 * perform the commit at all (`GIT_FATAL_EXIT`, see `classifyCommitRejection`).
 * Neither is the project judging the work, and both used to be told to the writer
 * as though it were.
 */
import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandResult, CommandSubstrate } from "../contracts/commandSubstrate.js";
import { runWorkspaceSshCommand } from "../workspace/index.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import type { CommitRejection } from "./types.js";
import { WorkspaceCommandError } from "../workspace/index.js";

/**
 * The bound on the hook report handed back to the writer. Generous next to the
 * 2KB stderr tail on the error message, because this text is the writer's ONLY
 * view of the rejection and a monorepo lint/spell-check run legitimately lists
 * many files. Still bounded: the steering rides in the writer's prompt and in a
 * durable event payload, so an unbounded pathological hook must not balloon
 * either. The TAIL is kept — tooling prints its summary and its verdict last.
 */
export const COMMIT_REJECTION_OUTPUT_LIMIT = 8_000;

/**
 * Combine the rejected commit's stdout and stderr into the report the writer sees.
 *
 * BOTH streams, deliberately. Lint, formatter and spell-check tooling routinely
 * writes its FINDINGS to stdout and only a terse epilogue ("hook failed") to
 * stderr — the live rejection that motivated this module put the
 * `Unknown word (TREATMENTX)` lines, the ones naming the exact fix, on one stream
 * and `husky - pre-commit script failed (code 1)` on the other. A stderr-only
 * capture (what the thrown error's message carries) would feed the writer the
 * epilogue and drop the actionable part.
 */
export function commitRejectionOutput(result: CommandResult): string {
  const combined = [result.stdout, result.stderr]
    .map((stream) => stream.trim())
    .filter((stream) => stream !== "")
    .join("\n");
  // Unconditional tail slice rather than a length test + branch: for anything at or under
  // the limit the slice is the identity, so the branch was not just redundant but
  // untestable (either arm produced byte-identical output — a pair of equivalent mutants).
  return combined.slice(Math.max(0, combined.length - COMMIT_REJECTION_OUTPUT_LIMIT));
}

/**
 * Git's own fatal-error exit code. Every `die()` path in git exits 128: no resolvable
 * author/committer identity, an `index.lock` it could not take, a signing key it could
 * not use, a repository it could not read. See `classifyCommitRejection` for why that
 * one number is enough to separate git failing from the project's gate voting.
 */
const GIT_FATAL_EXIT = 128;

/**
 * Classify a throw from the commit command.
 *
 * Returns a `CommitRejection` iff the throw was the project's hook voting NO — a
 * `WorkspaceCommandError` whose result is a plain nonzero exit. Returns
 * `undefined` for everything else (substrate failure, watchdog stall, git's own
 * fatal exit, or any non-`WorkspaceCommandError` throw), which the caller MUST
 * re-throw: those are infrastructure faults, not judgments about the writer's work.
 *
 * SPLITTING STAGING OUT WAS NOT THE WHOLE FIX (#1420 review). It guaranteed that only
 * the COMMIT's exit reaches here, which is necessary — but `git commit` itself fails
 * for reasons that have nothing to do with any hook, and those arrived wearing the
 * identical shape: `failure === undefined`, `stalled !== true`, nonzero exit. The
 * writer was then told "the project's own pre-commit gate REJECTED your work" for a
 * missing `user.email`, and burned iterations against a condition no edit to its diff
 * can reach — the same laundering the staging split removed, one layer further in.
 *
 * THE DISCRIMINATOR IS GIT'S OWN EXIT CODE, and it is available because git normalizes
 * a hook rejection. Measured on git 2.50.1, `git commit` exits **1** when a hook votes
 * NO — for a pre-commit hook and a commit-msg hook alike, and for EVERY hook exit code
 * tested (1, 2, 3, 42, 128, 255): git reports its own 1, never the hook's number. Git's
 * own operational failures exit **128**: no identity (`fatal: empty ident name`), a held
 * `index.lock`, a signing failure (`error: gpg failed to sign the data`), an unreadable
 * repository. So a 128 out of `git commit` is git failing, and cannot be the gate voting.
 *
 * This is NOT the sentinel-exit-code guard the module's header rejects, and the
 * difference is worth stating because that reasoning is what made this look
 * already-handled. "A hook is free to exit 3 too" is true of the HOOK — and irrelevant,
 * because the classifier never sees the hook's exit code. It sees git's, and git owns
 * that number.
 *
 * The rule is also deliberately ONE-SIDED: it excludes 128 rather than requiring 1.
 * Being wrong in the excluding direction re-throws and kills the run — exactly the
 * run-killer this module exists to remove — so an unrecognized nonzero exit keeps its
 * benefit of the doubt and is still fed back as steering.
 */
export function classifyCommitRejection(error: unknown): CommitRejection | undefined {
  if (!(error instanceof WorkspaceCommandError)) return undefined;
  const { result } = error;
  // Infrastructure, not a verdict — the hook never got to render one.
  if (result.failure !== undefined || result.stalled === true) return undefined;
  // Defensive: `runWorkspaceSshCommand` only throws on a nonzero exit once the
  // two arms above are excluded, but a `null`/0 exit here would mean the error
  // did not come from the hook, so it is not ours to reinterpret.
  if (result.exitCode === null || result.exitCode === 0) return undefined;
  // Git itself failed. Not a verdict on the writer's work — keep it fatal.
  if (result.exitCode === GIT_FATAL_EXIT) return undefined;
  return {
    label: error.label,
    exitCode: result.exitCode,
    output: commitRejectionOutput(result),
  };
}

/**
 * The terminal `exitReason` for a writer that did not stall, exhaust its window or crash.
 *
 * The project's commit gate votes LAST, and that ordering is the point: a stall, a spent
 * window or a crash EXPLAIN a rejected commit rather than being explained by it (a writer
 * killed mid-edit leaves a half-written tree the hook will obviously refuse), so each of
 * those classifications wins ahead of this one. Only a writer that otherwise finished
 * cleanly can be `commit_rejected` — which is exactly the case where the hook's verdict is
 * about the WORK and is worth handing back to the writer as steering.
 *
 * Shared by all six writer adapters so the ordering rule is written down once.
 */
export function writerExitReasonFor(gitState: { commitRejection?: CommitRejection }): "completed" | "commit_rejected" {
  return gitState.commitRejection === undefined ? "completed" : "commit_rejected";
}

/**
 * Stage the writer's edits as a command of its OWN, before the gated commit.
 *
 * WHY IT IS SEPARATE. `git add -A` and `git commit` used to share one `set -eu` script.
 * `runWorkspaceSshCommand` reports the script's exit, so a staging fault — an
 * `index.lock` left by a crashed git, a permission error, an unreadable path — arrived at
 * `classifyCommitRejection` looking exactly like a hook NO vote: a `WorkspaceCommandError`
 * with no `failure`, no `stalled`, and a nonzero exit. The writer was then told "the
 * project's own pre-commit gate REJECTED your work" for a fault that is not in its diff,
 * and the loop burned iterations against it until the fixed point.
 *
 * The guard for that is not a sentinel exit code (a hook is free to exit 3 too) — it is
 * making sure only the COMMIT's exit is ever offered to the classifier. Staging throws,
 * like every other workspace command, and never reaches the gate seam at all.
 *
 * Read that sentence narrowly: it is about the HOOK's exit code, which nothing here ever
 * observes. `classifyCommitRejection` does read GIT's exit code, which git owns and
 * normalizes, and that is a sound discriminator rather than a sentinel — see the note
 * there. Taking the sentence broadly is what left git's own commit failures misclassified
 * after this split landed.
 */
export async function stageWorkspaceChanges(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
  label: string,
): Promise<void> {
  await runWorkspaceSshCommand(ssh, target, {
    label,
    cwd: workspace,
    command: "git add -A",
    watchdog: buildActivityWatchdog({ substrate: ssh, target, cls: "vcs", workspace }),
  });
}

/**
 * Run a workspace commit, converting a hook rejection into a returned value.
 *
 * `commit` is the caller's already-built commit invocation. Any hook NO vote comes
 * back as a `CommitRejection`; anything else re-throws unchanged, so the existing
 * fatal paths (and their error messages) are untouched.
 */
export async function runCommitThroughProjectGate(
  commit: () => Promise<unknown>,
): Promise<CommitRejection | undefined> {
  try {
    await commit();
    return undefined;
  } catch (error) {
    const rejection = classifyCommitRejection(error);
    if (rejection === undefined) throw error;
    return rejection;
  }
}
