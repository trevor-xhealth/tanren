// Clone-auth coverage: the run's workspace clone must be able to authenticate a
// PRIVATE target repo, mirroring the push path. The token is fed to the clone
// over SSH stdin via the shared git credential helper — it must NEVER appear in
// the command string (process args / event log) or in the SSH stdin echoed into
// any event. Without a token the clone stays the plain public-repo path.
import { describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import type { OrgGithubAppInstallation } from "../src/engine/config/orgConfig.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { prepareRunWorkspace } from "../src/engine/workflow/plannerRunWorkspace.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import * as vcsCredentials from "../src/engine/credentials/vcsCredentials.js";
import type { ResolvedVcsToken, VcsCredentialContext } from "../src/engine/contracts/codeHostTypes.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

// Captures every command (and its stdin) so the test can assert the token is
// only ever delivered over stdin. The clone's trailing `git rev-parse HEAD`
// must return a sha, so the recorder yields a fixed clone HEAD.
// The `.tanren/ci.yml` READ specifically — `if [ -f <p> ]; then cat <p>; fi`. Matched on
// the `then cat` shape rather than the path, because the contract MATERIALIZATION command
// names the same path and must NOT be answered as a config read.
function isCiConfigRead(command: RunnerCommand): boolean {
  return command.command.includes("; then cat ") && command.command.includes(".tanren/ci.yml");
}

class RecordingSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];

  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target: sshTarget, command });
    // The `.tanren/ci.yml` read is a `cat`-if-present: a repo that ships no config
    // emits NOTHING on stdout and exits 0. Answering it with the clone sha (as a
    // catch-all would) is not a shape any runner produces, and would feed a 40-hex
    // string to the YAML parser.
    if (isCiConfigRead(command)) {
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    }
    return { exitCode: 0, stdout: CLONE_HEAD, stderr: "", timedOut: false };
  }
}

const CLONE_HEAD = "a".repeat(40);
const TOKEN = "ghp_secretClONEToken";
const APP_TOKEN = "ghs_appInstallationToken";

// A GitHub HTTP client for the clone-auth path. The only legitimate GitHub call
// the AUTHENTICATED clone makes is MERGE-SAFETY's `resolveActorIdentity` static
// `GET /user` (so the runner's git author attributes to a real login) — served
// here with a fixed Tanren login/id. Every OTHER path must stay off HTTP (the
// token resolution reads the secret store), so anything else throws loudly.
const CLONE_ACTOR_LOGIN = "tanren-clone-bot";
const CLONE_ACTOR_ID = 700700;
function unusedHttp(): GitHubHttpClient {
  return {
    request: async (req: GitHubHttpRequest): Promise<GitHubHttpResponse> => {
      if (req.method === "GET" && (req.path === "/user" || req.path.startsWith("/user?"))) {
        return { status: 200, body: { login: CLONE_ACTOR_LOGIN, id: CLONE_ACTOR_ID } };
      }
      throw new Error(`clone-auth must not issue GitHub HTTP: ${req.method} ${req.path}`);
    },
  };
}

const installation: OrgGithubAppInstallation = {
  appId: "12345",
  installationId: "67890",
  credentialRef: "credential/github_app/org/org_clone/test",
  installedAt: "2026-01-01T00:00:00Z",
};

/**
 * §5a: credential resolution now runs through the standalone `resolveVcsToken(http, creds)`
 * helper, not a removed `VcsProvider.resolveToken`. This spies on that helper to RECORD the
 * credential context each call receives and, when an App installation is present, short-circuits
 * to a fixed installation token (so the App-first path is observable without standing up a real
 * App-token minter). The `githubHttp` is the scripted transport (its `GET /user` serves the
 * static-path identity read). Returns a `restore()` the test calls to undo the spy. This proves
 * the clone routes credential resolution App-first.
 */
function recordingResolver(): {
  githubHttp: GitHubHttpClient;
  calls: VcsCredentialContext[];
  restore: () => void;
} {
  const githubHttp = unusedHttp();
  const calls: VcsCredentialContext[] = [];
  // Capture the REAL resolver before spying so the static path delegates to it (reads the
  // secret + serves the `GET /user` identity) without recursing into the spy.
  const realResolveVcsToken = vcsCredentials.resolveVcsToken;
  const spy = vi
    .spyOn(vcsCredentials, "resolveVcsToken")
    .mockImplementation(async (http, creds: VcsCredentialContext): Promise<ResolvedVcsToken> => {
      calls.push(creds);
      if (creds.installation !== undefined) {
        // MERGE-SAFETY: the App-first short-circuit also carries an identity supplier (the
        // App bot login) so resolveVcsActorIdentity resolves the git author without standing
        // up a real App-token minter.
        return {
          token: APP_TOKEN,
          source: "github_app" as const,
          refresh: async () => APP_TOKEN,
          identity: async () => ({
            login: "tanren-app[bot]",
            id: "12345",
            noreplyEmail: "12345+tanren-app[bot]@users.noreply.github.com",
          }),
        };
      }
      // The static path delegates to the REAL resolver (reads the secret + serves identity).
      return realResolveVcsToken(http, creds);
    });
  return { githubHttp, calls, restore: () => spy.mockRestore() };
}

function makeContext(overrides: Partial<PlannerRunContext> = {}): PlannerRunContext {
  return {
    runId: "run_clone",
    specId: "spec_clone",
    projectId: "project_clone",
    orgId: "org_clone",
    repoUrl: "https://github.com/cat-cave/private-fixture",
    targetBranch: "main",
    runBranch: "tanren/run_clone",
    specTitle: "t",
    specDescription: "d",
    acceptanceCriteria: [],
    runnerImage: "image",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "credential/github/org/org_clone/dev",
    ...overrides,
  };
}

// A minimal prepareRunWorkspace input: the bootstrap/commit steps are injected
// no-ops so the unit run never touches a real git tree, and an explicit
// bootstrapCommand skips the SSH config read.
function makeInput(
  ssh: CommandSubstrate,
  context: PlannerRunContext,
  opts: {
    githubToken?: string;
    secrets?: FakeSecretStore;
    githubHttp?: GitHubHttpClient;
  } = {},
): RunPlannerLoopInput {
  return {
    ssh,
    secrets: opts.secrets ?? new FakeSecretStore(),
    githubHttp: opts.githubHttp ?? unusedHttp(),
    context,
    timeoutMs: 500,
    bootstrapCommand: "true",
    runBootstrap: async () => {},
    commitBootstrap: async () => "",
    ...(opts.githubToken === undefined ? {} : { githubToken: opts.githubToken }),
  } as unknown as RunPlannerLoopInput;
}

describe("prepareRunWorkspace clone authentication", () => {
  it("authenticates the clone via the stdin-fed credential helper (token not on the command line)", async () => {
    const ssh = new RecordingSsh();
    await prepareRunWorkspace(
      makeInput(ssh, makeContext(), { githubToken: TOKEN }),
      target,
      "/workspace/runs/run_clone/repo",
    );

    const clone = ssh.commands[0]?.command;
    expect(clone).toBeDefined();
    // The token is delivered ONLY over stdin.
    expect(clone?.stdin).toBe(TOKEN);
    // The credential helper is wired (GIT_ASKPASS + the x-access-token username).
    expect(clone?.command).toContain("GIT_ASKPASS");
    expect(clone?.command).toContain("x-access-token");
    // The token never appears in the command string (process args / event log),
    // raw or base64-encoded.
    expect(clone?.command).not.toContain(TOKEN);
    expect(clone?.command).not.toContain(Buffer.from(TOKEN, "utf8").toString("base64"));
    // It is a clone of the HTTPS remote on the requested branch.
    expect(clone?.command).toContain("git clone --depth 1 --branch 'main'");
    expect(clone?.command).toContain("https://github.com/cat-cave/private-fixture.git");
  });

  it("clones a private-style repo URL with auth and captures the clone HEAD", async () => {
    const ssh = new RecordingSsh();
    const prepared = await prepareRunWorkspace(
      makeInput(ssh, makeContext({ repoUrl: "https://github.com/acme/closed-source" }), { githubToken: TOKEN }),
      target,
      "/workspace/runs/run_clone/repo",
    );
    expect(prepared.cloneHeadSha).toBe(CLONE_HEAD);
    expect(ssh.commands[0]?.command.command).toContain("https://github.com/acme/closed-source.git");
    expect(ssh.commands[0]?.command.stdin).toBe(TOKEN);
  });

  it("leaves the public/no-credential path unauthenticated (no credential helper, no stdin)", async () => {
    const ssh = new RecordingSsh();
    // No injected token AND no configured credential ref → unauthenticated clone.
    await prepareRunWorkspace(
      makeInput(ssh, makeContext({ githubCredentialRef: "" })),
      target,
      "/workspace/runs/run_clone/repo",
    );

    const clone = ssh.commands[0]?.command;
    // No token threaded → plain clone of the repo URL as configured, no helper.
    expect(clone?.stdin).toBeUndefined();
    expect(clone?.command).not.toContain("GIT_ASKPASS");
    expect(clone?.command).not.toContain("x-access-token");
    expect(clone?.command).toContain(
      "git clone --depth 1 --branch 'main' 'https://github.com/cat-cave/private-fixture'",
    );
  });

  it("resolves the token from secrets + the run's credential ref (production path) and keeps it off the command line", async () => {
    const ssh = new RecordingSsh();
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: "credential/github/org/org_clone/dev", token: TOKEN });

    // No injected token: prepareRunWorkspace must resolve it from the secret
    // store at context.githubCredentialRef — the SAME seam push uses.
    await prepareRunWorkspace(makeInput(ssh, makeContext(), { secrets }), target, "/workspace/runs/run_clone/repo");

    const clone = ssh.commands[0]?.command;
    expect(clone?.stdin).toBe(TOKEN);
    expect(clone?.command).toContain("GIT_ASKPASS");
    expect(clone?.command).not.toContain(TOKEN);
    // MERGE-SAFETY (self-identity) end-to-end: the RESOLVED identity (from the clone
    // token's GET /user) lands in the workspace git config via the DEDICATED
    // configure-identity step (right after the clone, before any commit), so every
    // writer/rebase/bootstrap commit is attributable to the real login — NOT
    // `planner@tanren.invalid`. It is its OWN SSH command, run in the workspace dir.
    const setIdentity = ssh.commands[1]?.command;
    expect(setIdentity?.cwd).toBe("/workspace/runs/run_clone/repo");
    expect(setIdentity?.command).toContain(`git config user.name '${CLONE_ACTOR_LOGIN}'`);
    expect(setIdentity?.command).toContain(
      `git config user.email '${CLONE_ACTOR_ID}+${CLONE_ACTOR_LOGIN}@users.noreply.github.com'`,
    );
    expect(setIdentity?.command).not.toContain("planner@tanren.invalid");
    // The identity step runs BEFORE the bootstrap commit (no commit precedes it).
    expect(clone?.command).not.toContain("git config user.name");
  });

  it("P2a Part 2: clone resolves APP-FIRST through the credential resolver when an App is installed", async () => {
    const ssh = new RecordingSsh();
    const { githubHttp, calls, restore } = recordingResolver();
    try {
      // Both an App installation AND a static ref are present: App-first wins.
      await prepareRunWorkspace(
        makeInput(ssh, makeContext({ installation }), { githubHttp }),
        target,
        "/workspace/runs/run_clone/repo",
      );

      // The clone resolved credentials carrying the installation (App-first), and used the
      // minted installation token over stdin — not the static ref.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.installation).toEqual(installation);
      const clone = ssh.commands[0]?.command;
      expect(clone?.stdin).toBe(APP_TOKEN);
      expect(clone?.command).toContain("GIT_ASKPASS");
      expect(clone?.command).not.toContain(APP_TOKEN);
    } finally {
      restore();
    }
  });

  it("MERGE-SAFETY: an authenticated run THROWS (no silent .invalid fallback) when identity resolution fails", async () => {
    const ssh = new RecordingSsh();
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: "credential/github/org/org_clone/dev", token: TOKEN });
    // A real provider whose token resolves (the secret is present) but whose actor-identity
    // read FAILS — the transport returns 503 on `GET /user`, so the standalone
    // `resolveVcsActorIdentity` (invoking the token's lazy identity supplier) throws. The
    // run is authenticated (a static credential ref is present), so this MUST be a loud
    // throw — never a degrade to the unattributable `planner@tanren.invalid` author.
    const identityFailingHttp: GitHubHttpClient = {
      request: async (req: GitHubHttpRequest): Promise<GitHubHttpResponse> => {
        if (req.method === "GET" && (req.path === "/user" || req.path.startsWith("/user?"))) {
          return { status: 503, body: {} };
        }
        throw new Error(`clone-auth must not issue GitHub HTTP: ${req.method} ${req.path}`);
      },
    };

    await expect(
      prepareRunWorkspace(
        makeInput(ssh, makeContext(), { secrets, githubHttp: identityFailingHttp }),
        target,
        "/workspace/runs/run_clone/repo",
      ),
    ).rejects.toThrow(/identity read/u);
    // The clone never ran — the run aborts before pushing as an unattributable author.
    expect(ssh.commands).toHaveLength(0);
  });

  it("sets the bot git identity in a DEDICATED step right after the clone, BEFORE the bootstrap commit", async () => {
    const ssh = new RecordingSsh();
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: "credential/github/org/org_clone/dev", token: TOKEN });
    // Drive the real commitBootstrap over SSH (not the injected no-op) so the
    // bootstrap commit shows up in the recorded command stream and we can assert
    // the identity step precedes it.
    const { commitBootstrap: _omitCommitSeam, ...input } = makeInput(ssh, makeContext(), { secrets });
    await prepareRunWorkspace(input as unknown as RunPlannerLoopInput, target, "/workspace/runs/run_clone/repo");

    const idx = (predicate: (c: string) => boolean): number =>
      ssh.commands.findIndex((entry) => predicate(entry.command.command));
    const cloneIdx = idx((c) => c.includes("git clone"));
    const identityIdx = idx((c) => c.includes("git config user.name"));
    const commitIdx = idx((c) => c.includes("git commit"));
    // The dedicated identity step exists, runs AFTER the clone, and BEFORE the
    // bootstrap commit — so the commit has a configured author (never the
    // auto-detected `<unix-user>@<host>.(none)` that GitHub maps to `<unknown>`).
    expect(cloneIdx).toBeGreaterThanOrEqual(0);
    expect(identityIdx).toBeGreaterThan(cloneIdx);
    expect(commitIdx).toBeGreaterThan(identityIdx);
    // It is its own workspace-scoped command, attributing to the resolved bot login.
    expect(ssh.commands[identityIdx]?.command.cwd).toBe("/workspace/runs/run_clone/repo");
    expect(ssh.commands[identityIdx]?.command.command).toContain(
      `git config user.email '${CLONE_ACTOR_ID}+${CLONE_ACTOR_LOGIN}@users.noreply.github.com'`,
    );
  });

  it("the genuinely unauthenticated public clone keeps a non-attributable placeholder identity (git still needs an author)", async () => {
    const ssh = new RecordingSsh();
    // No token AND no credential ref → unauthenticated public-repo path: no Tanren
    // identity, but git refuses to commit without SOME author, so the placeholder is set.
    await prepareRunWorkspace(
      makeInput(ssh, makeContext({ githubCredentialRef: "" })),
      target,
      "/workspace/runs/run_clone/repo",
    );
    const setIdentity = ssh.commands[1]?.command;
    expect(setIdentity?.command).toContain("git config user.name 'Tanren Planner'");
    expect(setIdentity?.command).toContain("git config user.email 'planner@tanren.invalid'");
  });

  it("P2a Part 2: clone routes credential resolution (no installation) carrying the static ref only", async () => {
    const ssh = new RecordingSsh();
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: "credential/github/org/org_clone/dev", token: TOKEN });
    const { githubHttp, calls, restore } = recordingResolver();

    try {
      await prepareRunWorkspace(
        makeInput(ssh, makeContext(), { secrets, githubHttp }),
        target,
        "/workspace/runs/run_clone/repo",
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.installation).toBeUndefined();
      expect(calls[0]?.staticRef).toBe("credential/github/org/org_clone/dev");
      expect(ssh.commands[0]?.command.stdin).toBe(TOKEN);
    } finally {
      restore();
    }
  });
});
