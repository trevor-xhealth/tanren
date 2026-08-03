// plannerRunWorkspace — the run's workspace-prep + bootstrap stage, extracted
// from plannerRun.ts to keep it under the 500-line architecture cap.
//
// It clones the target branch (capturing the clone HEAD), installs deps
// (bootstrap), and commits the bootstrap-generated tree as ONE synthetic
// commit. The bootstrap commit's sha becomes the writer's diff base, so the
// checker/auditor and the captured diff see only the writer's real changes —
// the install artifacts (lockfiles, node_modules) sit below the base. The
// `cloneHeadSha` is threaded onward so the PR-branch cleanup can replay the
// writer commits onto it (dropping the bootstrap commit) before the push.
import type { RunnerHandle } from "../contracts/allocator.js";
import type { ActorIdentity } from "../contracts/codeHostTypes.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { githubHttpsRemote, parseGitHubRepository } from "../providers/github.js";
import { quoteSshShellArg } from "../ssh/command.js";
import {
  bootstrapWorkspace,
  commitBootstrapState,
  materializeContractFilesInWorkspace,
  provisionMiseToolchain,
  runWorkspaceSshCommand,
  seedWorkspaceLocalIgnore,
  WorkspaceBootstrapError,
  type ProvisionMiseToolchainInput,
} from "../workspace/index.js";
import { gitAuthedCommand, gitTokenAuthPrelude } from "../workspace/githubPush.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { resolveVcsActorIdentity, resolveVcsToken } from "../credentials/vcsCredentials.js";
import { resolveBootstrapCommand } from "./gate/index.js";
import type { RunPlannerLoopInput } from "./plannerRun.js";
import { resolveAncestorStack } from "../dag/ancestorStack.js";
import { bootstrapDependentWorkspace, type ClonedWorkspace } from "./plannerRunJjLocalBootstrap.js";

// The workspace-prep step inputs (the run's bootstrap-install + commit-bootstrap-state
// seams). Co-located here with the workspace-prep stage that consumes them; `plannerRun.ts`
// re-imports them for the `RunPlannerLoopInput` test seams (a type-only import — no cycle).
export interface BootstrapStepInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  command?: string;
  // Plane B: the project's dev+test app env, injected at the SSH substrate boundary
  // (never folded into `command`, so a bootstrap failure can't leak it into the
  // error message / events). See bootstrap.ts. Undefined ⇒ no app env.
  appEnv?: Record<string, string>;
}

export interface CommitBootstrapStepInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
}

export interface PreparedRunWorkspace {
  // The clone HEAD (base-branch tip). The writer commits replay onto this before
  // the PR is pushed, so the PR carries only the writer's source changes.
  cloneHeadSha: string;
  // The synthetic post-bootstrap commit (or "" on a fake SSH). The PR-branch
  // cleanup drops this commit (`bootstrapSha..HEAD` rebased onto the clone HEAD),
  // so EVERYTHING above it — the deterministic contract-files commit + the writer
  // commits — replays into the PR. This is the PUSH drop boundary, NOT the answerer base.
  bootstrapSha: string;
  // The ANSWERER review base: the writer's reviewed diff is `baseSha..HEAD`. It sits
  // ABOVE the Tanren-materialized contract-files commit (the contract-commit sha) when
  // one was made, ELSE the bootstrap commit, ELSE the clone HEAD (fake-SSH unit paths).
  // Anchoring it above the contract commit keeps the Tanren-owned `.tanren/ci.yml` +
  // `justfile` OUT of the writer's reviewed diff — so the checker/auditor/convergence
  // see ONLY the writer's code and never misread the contract files as writer-authored
  // (apex v28: the auditor flagged `contract-files-authored`). The files still ride into
  // the PR — only the answerer REVIEW base excludes them; the human/merge still sees them.
  baseSha: string;
  // WS-A PR-4 (walker-jj-local-integration-design.md §4): the merge-time rebase base when
  // the run's base was jj-ASSEMBLED locally from the ancestor stack (non-empty stack) —
  // the LOCAL assembly bookmark name the bootstrap materialized.
  // It REPLACES `${targetBranch}@origin` as the conflict-resolver's `baseRevision` (the PR
  // head rebases onto the re-assembled stack head, not a synthesized host ref). Absent on
  // the legacy single-ref clone path (empty stack) ⇒ the conflict resolver keeps
  // `${targetBranch}@origin` exactly as today.
  bootstrappedBaseRevision?: string;
  // MERGE-SAFETY (self-identity): the run's RESOLVED GitHub pushing identity (the SAME
  // one that authenticated the clone AND set the workspace git author). Threaded to the
  // clean-PR prep so the COMPOSED PR-head commit is authored as this login too — GitHub
  // attributes the PR head to the bot login the external-change gate treats as Tanren's
  // own (never `<unknown>`, which blocks auto-merge). Absent on the unauthenticated
  // public-repo clone (no identity resolved) — that path never pushes as Tanren.
  pushIdentity?: ActorIdentity;
  // SELF-HEAL (apex v35): set when the workspace-PREP `just bootstrap` (deps install) failed
  // and was DEFERRED to the gate's self-healing path instead of terminally stranding the
  // spec — see the prep-bootstrap block + the `workspace.bootstrap_deferred` schema. Absent
  // ⇒ the prep bootstrap succeeded (or no-op). The caller emits the deferral event from this.
  prepBootstrapDeferred?: { command: string; exitCode: number | null; timedOut: boolean; outputTail: string };
}

// Clones the target branch + installs deps + commits the bootstrap state, and
// returns the run's clone-HEAD / bootstrap / base shas.
export async function prepareRunWorkspace(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
): Promise<PreparedRunWorkspace> {
  // Resolve the run's clone token + MERGE-SAFETY pushing identity ONCE (fail-closed:
  // an authenticated run with an unresolvable identity throws here, before any clone,
  // rather than committing as an unattributable author). The SAME resolved value
  // authenticates the clone AND sets the workspace git author below.
  const resolved = await resolveCloneCredential(input);
  const cloned = await cloneWorkspace(input, target, workspacePath, resolved);
  const cloneHeadSha = cloned.cloneHeadSha;

  // MERGE-SAFETY (self-identity): set the workspace git author IMMEDIATELY after the
  // clone and BEFORE any commit (the bootstrap commit and every writer/rebase commit
  // that inherits this repo-local config). git auto-detects `<unix-user>@<host>.(none)`
  // — an unattributable author GitHub maps to a `null` login → the external-change gate
  // keys it `<unknown>` and BLOCKS Tanren's own PR. An explicit, separately-failing step
  // (not the clone command's tail) guarantees the author is configured before the commit.
  await configureWorkspaceGitIdentity(input, target, workspacePath, resolved.identity);

  // Durable node_modules guard: seed the checkout's LOCAL git ignore
  // (`.git/info/exclude`) right after clone, BEFORE any install/commit, so no
  // later `git add -A` (the bootstrap commit or any writer commit) can sweep a
  // node_modules/dist tree into the repo — which previously ballooned the writer
  // diff (and the checker/auditor prompt) past the model's input limit.
  await seedWorkspaceLocalIgnore({ ssh: input.ssh, target, workspacePath });

  // Command precedence: an explicit input.bootstrapCommand override wins;
  // otherwise resolve the repo's .tanren/ci.yml `bootstrap.run` (conventionally
  // `just bootstrap`); when the repo ships no .tanren/ci.yml the resolver yields
  // undefined and the bootstrap step falls back to the stack-agnostic
  // DEFAULT_BOOTSTRAP_COMMAND LOUD-fallback (just bootstrap, else a loud failure).
  const resolvedBootstrapCommand =
    input.bootstrapCommand ?? (await resolveBootstrapCommand({ ssh: input.ssh, target, workspacePath }));
  // TOOLCHAIN PROVISION (environment-management.md §3 Layer 2): BEFORE the project's
  // `just bootstrap`, provision the toolchain the repo DECLARES. Detection reads the
  // repo's own `mise.toml` when it ships one and otherwise the standard declaration
  // files it does ship (`package.json#packageManager`, `.nvmrc`, `.python-version`,
  // lockfiles, …) — the widening that lets a mainstream polyglot repo be gated at all;
  // provisioning is mise either way, and every declared binary is VERIFIED on PATH
  // before this returns. Genuinely nothing to provision (a greenfield scaffold's first
  // bootstrap is an empty repo) stays a stated no-op; a failed provision or an
  // unverifiable binary HALTS the run LOUDLY (WorkspaceMiseProvisionError) — never a
  // silent skip. This is the PROJECT path; codex/answerers keep the runner's isolated
  // harness node (mise stays un-globally-activated). Test seam: an injected
  // `provisionMise` overrides it.
  const provisionMise =
    input.provisionMise ?? ((stepInput: ProvisionMiseToolchainInput) => provisionMiseToolchain(stepInput));
  await provisionMise({ ssh: input.ssh, target, workspacePath });
  const runBootstrap =
    input.runBootstrap ?? ((stepInput: BootstrapStepInput) => bootstrapWorkspace(stepInput).then(() => {}));
  // Plane B: the building agent runs install/build under the
  // project's dev+test app env. The app env is passed SEPARATELY (NOT folded into
  // the command string): `bootstrapWorkspace` builds the `export …;` prelude at
  // the SSH substrate boundary and prepends it to the EXECUTED command only, so the
  // ORIGINAL command — the value that flows into WorkspaceBootstrapError and the
  // `workspace.bootstrap_deferred` payload — never carries an app-secret value.
  //
  // SELF-HEAL (apex v35): a prep `just bootstrap` (deps install) failure is almost always a
  // WRITER-OWN-scaffold defect — the per-gate `ensureWorkspaceDepsInstalled` failure #562 made
  // self-heal, REDUNDANT with it (same `just bootstrap`). So a writer-fixable
  // `WorkspaceBootstrapError` is caught + DEFERRED to the gate's self-healing path (prep
  // continues, the writer loop runs, the gate re-runs + routes — bounded by convergence) not
  // stranded. ANY OTHER throw — a substrate fault, OR the mise PROVISION (threw ABOVE) — propagates.
  let prepBootstrapDeferred: PreparedRunWorkspace["prepBootstrapDeferred"];
  try {
    await runBootstrap({
      ssh: input.ssh,
      target,
      workspacePath,
      command: resolvedBootstrapCommand,
      ...(input.appEnv === undefined ? {} : { appEnv: input.appEnv }),
    });
  } catch (error: unknown) {
    if (!(error instanceof WorkspaceBootstrapError)) throw error;
    const { command, exitCode, stalled, outputTail } = error;
    // The deferred-bootstrap event's `timedOut` field records "did not complete";
    // the progress-based no-life flag (`stalled`) feeds it.
    prepBootstrapDeferred = { command, exitCode, timedOut: stalled, outputTail };
  }

  // Commit the bootstrap-generated tree as ONE synthetic commit on top of the
  // clone HEAD; its sha is the writer's diff base. When bootstrap produced
  // nothing the commit is empty (sha != cloneHeadSha); on a fake SSH the step
  // yields "" and baseSha falls back to cloneHeadSha.
  const commitBootstrap =
    input.commitBootstrap ?? ((stepInput: CommitBootstrapStepInput) => commitBootstrapState(stepInput));
  const bootstrapSha = await commitBootstrap({ ssh: input.ssh, target, workspacePath });
  const bootstrapBase = bootstrapSha === "" ? cloneHeadSha : bootstrapSha;

  // DETERMINISTIC CONTRACT FILES (v27 fix): materialize the `.tanren/ci.yml` +
  // `justfile` from the project's captured lifecycle and commit them as a REAL
  // commit ON TOP of the bootstrap base — so they ride into the writer's PR diff
  // (the bootstrap commit below the base is DROPPED on push; a contract commit ABOVE
  // it is replayed onto the PR branch). This takes contract-file authoring out of
  // the LLM writer's hands (it mangled the ci.yml YAML shape on apex v27). Write-iff-
  // absent (never-clobber): on the greenfield path the composed VFS push (PR-G —
  // derive's `materializeTemplate` step) ALREADY landed these files on the repo's
  // default branch as part of the project's initial content, so this materialization
  // is a no-op and NO commit is made (sha "").
  const contractSha = await materializeContractFilesCommit(input, target, workspacePath);

  // ANSWERER REVIEW BASE: anchor the writer's reviewed diff ABOVE the Tanren-owned
  // commits — the contract-files commit when one was made (apex v28 fix), ELSE the
  // bootstrap base — so the Tanren-owned `.tanren/ci.yml` + `justfile` are NOT in
  // the writer's reviewed diff and the checker/auditor/convergence never misread
  // them as writer-authored. The composed template's files (PR-G — derive's
  // `materializeTemplate` step) sit BELOW the clone head (they ARE the initial
  // content of the default branch), so they are not in the writer's diff either.
  // The contract commit above the base, when made, still RIDES INTO THE PR — the
  // push drops only `bootstrapSha` (below it), so it is replayed onto the PR branch.
  const baseSha = contractSha === "" ? bootstrapBase : contractSha;

  return {
    cloneHeadSha,
    bootstrapSha,
    baseSha,
    // WS-A PR-4: surface the locally-assembled base revision ONLY when the bootstrap path
    // ran (non-empty stack); absent ⇒ the conflict resolver keeps the legacy
    // `${targetBranch}@origin` base.
    ...(cloned.bootstrappedBaseRevision !== undefined && {
      bootstrappedBaseRevision: cloned.bootstrappedBaseRevision,
    }),
    // apex v35: surface a deferred prep-bootstrap failure so the caller emits the event.
    ...(prepBootstrapDeferred !== undefined && { prepBootstrapDeferred }),
    // MERGE-SAFETY (self-identity): surface the resolved pushing identity so the clean-PR
    // prep authors the composed PR-head commit as the bot login (attributable ⇒ not
    // flagged `<unknown>` external). Absent on the unauthenticated clone (never pushes).
    ...(resolved.identity !== undefined && { pushIdentity: resolved.identity }),
  };
}

// Materialize the deterministic contract files into the workspace + commit them as a
// dedicated commit above the bootstrap base, so they become part of the writer's PR
// diff. Returns the new contract-commit sha (the answerer review base anchors ABOVE it,
// so the Tanren-owned files are kept out of the writer's reviewed diff — apex v28 fix),
// or "" when no commit was made: the run carries no contract manifest (the project
// captured no lifecycle), a fake SSH yields no sha, OR the files were already present
// (a brownfield re-clone — write-iff-absent left nothing newly written). On a "" the
// caller keeps the bootstrap base, so the answerers diff from the same place as before.
async function materializeContractFilesCommit(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
): Promise<string> {
  const files = input.context.contractFiles;
  if (files === undefined || files.length === 0) return "";
  const result = await materializeContractFilesInWorkspace({
    ssh: input.ssh,
    target,
    files,
    workspacePath,
  });
  // Nothing newly written (every file already present) ⇒ no commit, no base shift.
  if (result.written.length === 0) return "";
  const committed = await runWorkspaceSshCommand(input.ssh, target, {
    label: "commit deterministic contract files",
    cwd: workspacePath,
    watchdog: buildActivityWatchdog({ substrate: input.ssh, target, cls: "vcs", workspace: workspacePath }),
    command: [
      "set -eu",
      // Stage ONLY the contract files (not -A) so this commit carries the contract
      // and nothing else — the bootstrap commit already absorbed install artifacts.
      `git add ${result.written.map((p) => quoteSshShellArg(p)).join(" ")}`,
      "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' " +
        `git commit -q -m ${quoteSshShellArg("tanren: project contract files (.tanren/ci.yml + justfile)")}`,
      // Echo the contract-commit sha LAST so it is the command's stdout — it becomes
      // the answerer review base. A fake SSH yields ""; the real runner a 40-hex sha.
      "git rev-parse HEAD",
    ].join(" && "),
  });
  return committed.stdout.trim();
}

// Clones the target branch and returns the clone HEAD. `git rev-parse HEAD` runs
// LAST in the chain and is the only stdout-producing step, so the returned
// stdout is the clone HEAD sha. Returns "" only on a fake SSH that yields no
// output; the real runner always returns a 40-hex sha.
//
// When a GitHub token is threaded (`resolved.token`) the clone authenticates over
// HTTPS as `x-access-token:<token>` so a PRIVATE target repo can be cloned. The
// token is fed to the command over SSH stdin via the shared git credential helper
// (the same mechanism `githubPush.ts` uses) — it never appears in the command
// string, the process args, or any emitted `workspace.*` event. Without a token
// the clone runs unauthenticated against the repo URL as-is (public-repo path),
// unchanged. The git AUTHOR is configured by a separate step (configureWorkspace
// GitIdentity) right after this clone, BEFORE the first commit.
//
// When this is a DEPENDENT speculative run (a non-empty ancestor stack), it routes to the
// jj-LOCAL base bootstrap (`bootstrapDependentWorkspace`, plannerRunJjLocalBootstrap.ts); a
// non-speculative run (empty stack) takes the plain `default_branch` single-ref clone below.
async function cloneWorkspace(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
  resolved: ResolvedCloneCredential,
): Promise<ClonedWorkspace> {
  // walker-jj-local-integration-design.md §2.1: a DEPENDENT speculative run (a non-empty
  // ancestor stack) jj-ASSEMBLES its base LOCALLY from the real ancestor PR-head refs on the
  // run's OWN runner (`bootstrapDependentBase`) — there is NO orchestrator-synthesized
  // `tanren/integ/<dep>` host ref. A non-speculative run (empty stack) takes the plain
  // `default_branch` single-ref clone below.
  const stack = resolveAncestorStack({ ancestorStack: input.context.ancestorStack });
  if (stack.length > 0) {
    return bootstrapDependentWorkspace(input, target, workspacePath, resolved, stack);
  }
  const result = await runWorkspaceSshCommand(input.ssh, target, {
    label: "prepare planner-loop workspace",
    // VCS op (a clone): output-driven + workspace liveness probe; never a wall-clock kill.
    watchdog: buildActivityWatchdog({ substrate: input.ssh, target, cls: "vcs", workspace: workspacePath }),
    command: buildCloneCommand(input.context.repoUrl, input.context.targetBranch, resolved, workspacePath),
    ...(resolved.token === undefined ? {} : { stdin: resolved.token }),
  });
  return { cloneHeadSha: result.stdout.trim() };
}

// MERGE-SAFETY (self-identity): configure the workspace's repo-local git author so
// every commit it makes (the bootstrap commit + every writer/rebase commit, which
// inherit `.git/config`) is ATTRIBUTABLE. Runs as its OWN SSH step after the clone
// and before any commit — distinct from the clone command so the author is set even
// if the clone path changes, and so a failure to set it surfaces on its own label.
//
// AUTHENTICATED runs set the RESOLVED bot login + its canonical
// `<id>+<login>@users.noreply.github.com` noreply email, so GitHub maps the commit
// email back to the bot login, the PR-commits author is populated, and the
// external-change gate sees TANREN's login (not `<unknown>`). A run with an
// unresolvable identity already threw in resolveCloneCredential (fail-closed) — it
// never reaches here. The genuinely UNAUTHENTICATED public-repo clone (no identity)
// keeps a non-attributable placeholder: it never pushes as Tanren, but git still
// refuses to commit without SOME configured author, so the bootstrap commit needs one.
export async function configureWorkspaceGitIdentity(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
  identity: ActorIdentity | undefined,
): Promise<void> {
  await runWorkspaceSshCommand(input.ssh, target, {
    label: "configure workspace git identity",
    cwd: workspacePath,
    // VCS op (git config): output-driven + workspace liveness probe; no kill.
    watchdog: buildActivityWatchdog({ substrate: input.ssh, target, cls: "vcs", workspace: workspacePath }),
    command: ["set -eu", ...gitIdentityConfig(identity)].join(" && "),
  });
}

/**
 * The resolved clone credential: the push token (fed to the clone over stdin) +
 * MERGE-SAFETY the resolved actor identity Tanren commits as. Both derive from the
 * SAME `resolveToken`, so the runner's git author (here) and the merge stage's
 * Tanren-identity set (mergeDispatch) attribute to the SAME login. A genuinely
 * unauthenticated public-repo clone has neither (it never pushes as Tanren).
 */
export interface ResolvedCloneCredential {
  token: string | undefined;
  identity: ActorIdentity | undefined;
}

// Resolves the run's GitHub token for the clone through the SAME standalone
// credential resolver the rest of the run path uses (`resolveVcsToken`), so the
// clone is APP-FIRST: a caller-injected `githubToken` (test seam) wins; otherwise the
// resolver mints an auto-rotating App installation token when the org installed
// the App (`context.installation`), else reads the static `github_token` at the
// run's resolved credential ref. This is a deliberate behavior change from the
// prior static-ref-only clone — clone now prefers the App token when an App is
// present, matching the CI-poll / merge stages (no more asymmetry).
//
// MERGE-SAFETY (self-identity): from the SAME resolved credential we ALSO resolve
// Tanren's pushing identity (`resolveActorIdentity`) and set it as the runner's
// git author below — so Tanren's own commits attribute to a REAL GitHub login
// (not the old `.invalid` email that GitHub reports as a `null` author, which the
// external-change gate keys `<unknown>` → external → blocked). The merge stage
// derives its Tanren-identity set from the same credential, so they agree.
//
// When NEITHER an App nor a static credential ref is configured the clone must
// still run for the public-repo path, so we return undefined token + identity
// (unauthenticated clone) instead of throwing; that path does not push as Tanren.
// A missing secret at a CONFIGURED ref still propagates so a misconfigured private
// run fails loudly. LOUD-FAILURE: when the run IS authenticated, identity
// resolution failing is a hard throw — never a silent `.invalid` fallback.
async function resolveCloneCredential(input: RunPlannerLoopInput): Promise<ResolvedCloneCredential> {
  // Test seam: a pre-resolved raw clone token bypasses the provider's credential
  // resolution entirely (it is not a resolvable App/static credential), so there is
  // no genuine identity to resolve — keep the non-attributable placeholder. Production
  // omits `githubToken` and takes the real resolution path below.
  if (input.githubToken !== undefined) {
    return { token: input.githubToken, identity: undefined };
  }
  const staticRef = input.context.githubCredentialRef;
  // No App installation AND no static ref → unauthenticated public-repo clone: no
  // token, no Tanren identity (it never pushes as Tanren).
  if (input.context.installation === undefined && staticRef.trim() === "") {
    return { token: undefined, identity: undefined };
  }
  // §5a: token + identity resolution is credential PLUMBING — resolve via the standalone
  // helpers over the shared GitHub client, never a forge op on a host seam.
  const http = input.githubHttp;
  const resolved = await resolveVcsToken(http, {
    secrets: input.secrets,
    orgId: input.context.orgId,
    ...(input.context.installation !== undefined && { installation: input.context.installation }),
    ...(staticRef.trim() !== "" && { staticRef }),
    ...(input.githubAppMinter !== undefined && { minter: input.githubAppMinter }),
  });
  // LOUD FAILURE: an authenticated run MUST resolve a real pushing identity so its
  // commits are attributable — a throw here, never a degrade to `planner@tanren.invalid`.
  const identity = await resolveVcsActorIdentity(resolved);
  return { token: resolved.token, identity };
}

function buildCloneCommand(
  repoUrl: string,
  targetBranch: string,
  resolved: ResolvedCloneCredential,
  workspacePath: string,
): string {
  const branch = quoteSshShellArg(targetBranch);
  const dest = quoteSshShellArg(workspacePath);
  // The git AUTHOR is configured by configureWorkspaceGitIdentity (its own step)
  // right after this clone — NOT in the clone command's tail. So the clone only
  // verifies the checkout (`git rev-parse HEAD`) and the author is set separately,
  // guaranteed before the first commit and failing on its own label if it can't.
  const post = [`cd ${dest}`, "git rev-parse HEAD"];
  const token = resolved.token;

  // No token → plain unauthenticated clone of the repo URL as configured.
  if (token === undefined) {
    return [
      "set -eu",
      `rm -rf ${dest}`,
      `git clone --depth 1 --branch ${branch} ${quoteSshShellArg(repoUrl)} ${dest}`,
      ...post,
    ].join(" && ");
  }

  // Token present → authenticate over HTTPS via the stdin-fed credential helper
  // (token never on the command line). Normalize the repo URL to the HTTPS
  // remote the helper authenticates against.
  const remote = quoteSshShellArg(githubHttpsRemote(parseGitHubRepository(repoUrl)));
  return [
    "set -eu",
    ...gitTokenAuthPrelude(),
    `rm -rf ${dest}`,
    gitAuthedCommand(["clone", "--depth", "1", "--branch", branch, remote, dest]),
    ...post,
  ].join(" && ");
}

/**
 * MERGE-SAFETY (self-identity): the `git config user.name/user.email` lines for
 * the run's commits. AUTHENTICATED runs set the RESOLVED login + its canonical
 * `<id>+<login>@users.noreply.github.com` noreply email, so every writer/rebase
 * commit (which inherits this config) is ATTRIBUTABLE — GitHub maps the email back
 * to the login, the PR-commits author is populated, and the external-change gate
 * sees Tanren's login (not `<unknown>`). The genuinely UNAUTHENTICATED public-repo
 * clone (no identity) keeps a non-attributable placeholder — it never pushes as
 * Tanren, so attribution is moot, but git still needs a configured author.
 */
function gitIdentityConfig(identity: ActorIdentity | undefined): string[] {
  if (identity === undefined) {
    return ["git config user.name 'Tanren Planner'", "git config user.email 'planner@tanren.invalid'"];
  }
  return [
    `git config user.name ${quoteSshShellArg(identity.login)}`,
    `git config user.email ${quoteSshShellArg(identity.noreplyEmail)}`,
  ];
}
