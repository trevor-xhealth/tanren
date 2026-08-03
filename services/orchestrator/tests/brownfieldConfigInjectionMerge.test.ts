// Config-injection MERGE SAFETY — the "never clobber a file the repository already
// owns" contract, driven through the REAL adapter (`FetchConfigInjectionGitHub`) over an
// injected `GitHubHttpClient` that models a target repo's blob store. No network, no
// `vi.mock` — the fake IS the repo, so an assertion about "the original content survived"
// is an assertion about the bytes the adapter left behind.
//
// These are NEGATIVE CONTROLS for two data-loss defects:
//   F-1 · the writer's blind `PUT` carried the prior blob sha, REPLACING `.gitignore`,
//         `CODEOWNERS` and `.github/PULL_REQUEST_TEMPLATE.md` with tanren stubs. A wiped
//         `.gitignore` is silent repository data loss: tanren's writer runs `git add -A`,
//         so the next iteration commits `node_modules/`, `.venv/`, `dist/`, …
//   F-2 · the documented `repoHasJustfile` guard was wired to nothing, so every target
//         repo got the LOUD-STUB justfile (`… && exit 1`) on top of its own lifecycle.
//
// Both are expressed through ONE mechanism: the per-file merge strategy that rides on the
// proposal (`ProposedFile.merge`) and is enforced at the write seam.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import {
  FetchConfigInjectionGitHub,
  mergeFileContent,
  openConfigInjectionPr,
  proposeConfigFiles,
  type ReconIndex,
  type ReconReport,
} from "../src/engine/forge/brownfield/index.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createBrownfieldFullTrackRoutes } from "../src/routes/brownfield/fullTrack.js";
import { RoutesPool } from "./helpers/routesPool.js";

const REPO_URL = "https://github.com/acme/payments";

// A REAL-LOOKING `.gitignore`: the rules that keep an install tree, a venv, build output
// and IDE noise out of the index. If injection replaces this file, the very next
// `git add -A` commits all of it.
const EXISTING_GITIGNORE = `node_modules/
.venv/
__pycache__/
dist/
build/
.terraform/
*.log
.env
.env.local
.idea/
.DS_Store
coverage/
`;

// Per-directory ownership — the thing a blanket `* @org/tanren-operators` destroys.
const EXISTING_CODEOWNERS = `# ownership by service
/services/payments/   @acme/payments-team
/services/ledger/     @acme/ledger-team
/infra/               @acme/platform-sre
/docs/                @acme/docs
*.tf                  @acme/platform-sre @acme/security
`;

const EXISTING_PR_TEMPLATE = `## What changed

## Risk assessment (required for PCI scope)

- [ ] Touches cardholder data
- [ ] Requires a change-advisory ticket

## Rollback plan
`;

// The repo's OWN lifecycle contract — real targets that already work.
const EXISTING_JUSTFILE = `default:
\t@just --list

bootstrap:
\tuv sync --frozen

tier-1:
\truff check . && mypy .

tier-2:
\tpytest -q --junitxml=reports/junit.xml
`;

// The loud stub the skeleton justfile ships — it is an instant gate failure if it lands
// on top of a repo that already has real targets.
const STUB_MARKER = "for this project's stack (edit the justfile)";

/**
 * A fake GitHub whose `/contents/` surface is a real blob store, so the adapter's
 * read-then-write path operates on actual bytes. Records every PUT so a test can assert a
 * write NEVER happened (not just that the content matched).
 */
class FakeRepoGitHub implements GitHubHttpClient {
  readonly blobs: Map<string, string>;
  readonly puts: string[] = [];

  constructor(initial: Record<string, string>) {
    this.blobs = new Map(Object.entries(initial));
  }

  /** The repo's content for `path`, or `undefined` when the repo has no such file. */
  read(path: string): string | undefined {
    return this.blobs.get(path);
  }

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    const pathname = input.path.split("?")[0] ?? "";
    if (input.method === "GET" && pathname.includes("/git/ref/heads/")) {
      return { status: 200, body: { object: { sha: "base0000" } } };
    }
    if (input.method === "POST" && pathname.endsWith("/git/refs")) {
      return { status: 201, body: {} };
    }
    if (input.method === "GET" && pathname.includes("/pulls")) {
      return { status: 200, body: [] };
    }
    if (input.method === "POST" && pathname.endsWith("/pulls")) {
      return { status: 201, body: { number: 12, html_url: `${REPO_URL}/pull/12`, draft: true } };
    }
    const contentsAt = pathname.indexOf("/contents/");
    if (contentsAt >= 0) {
      return this.contents(input, decodeRepoPath(pathname.slice(contentsAt + "/contents/".length)));
    }
    return { status: 404, body: undefined };
  }

  private contents(input: GitHubHttpRequest, path: string): GitHubHttpResponse {
    if (input.method === "GET") {
      const existing = this.blobs.get(path);
      if (existing === undefined) return { status: 404, body: undefined };
      return {
        status: 200,
        body: { sha: `blob-${path}`, encoding: "base64", content: Buffer.from(existing, "utf8").toString("base64") },
      };
    }
    if (input.method === "PUT") {
      const body = input.body as { content?: unknown };
      const encoded = typeof body.content === "string" ? body.content : "";
      this.blobs.set(path, Buffer.from(encoded, "base64").toString("utf8"));
      this.puts.push(path);
      return { status: 200, body: {} };
    }
    return { status: 404, body: undefined };
  }
}

function decodeRepoPath(encoded: string): string {
  return encoded
    .split("/")
    .map((piece) => decodeURIComponent(piece))
    .join("/");
}

const SAMPLE_REPORT: ReconReport = {
  identity: { slug: "payments", purpose: "card payments service", inferredFrom: "README.md" },
  personas: [{ name: "operator", description: "runs the service", inferredFrom: "code" }],
  behaviors: [{ persona: "operator", title: "take a payment", inferredFrom: "code" }],
  architecture: [{ layer: "api", detail: "python service" }],
  risks: [],
  gaps: [],
};

const PROPOSE_INPUT = {
  repoSlug: "payments",
  orgLogin: "acme",
  repoUrl: REPO_URL,
  report: SAMPLE_REPORT,
  posture: "strict" as const,
  generatedAt: "2026-08-02T00:00:00.000Z",
};

async function injectInto(http: FakeRepoGitHub): Promise<void> {
  await openConfigInjectionPr({
    github: new FetchConfigInjectionGitHub({ http, token: "gh_test" }),
    repoUrl: REPO_URL,
    baseBranch: "main",
    files: proposeConfigFiles(PROPOSE_INPUT),
  });
}

function brownfieldRepo(): FakeRepoGitHub {
  return new FakeRepoGitHub({
    "README.md": "# payments\n",
    ".gitignore": EXISTING_GITIGNORE,
    CODEOWNERS: EXISTING_CODEOWNERS,
    ".github/PULL_REQUEST_TEMPLATE.md": EXISTING_PR_TEMPLATE,
    justfile: EXISTING_JUSTFILE,
  });
}

describe("F-1 · config-injection never destroys a file the repository already owns", () => {
  it("keeps every existing rule in .gitignore and ADDS tanren's entry (additive, not replace)", async () => {
    const http = brownfieldRepo();
    await injectInto(http);

    const after = http.read(".gitignore") ?? "";
    // Every original rule survives — this is the data-loss assertion, not "no PUT".
    for (const rule of [
      "node_modules/",
      ".venv/",
      "__pycache__/",
      "dist/",
      "build/",
      ".terraform/",
      "*.log",
      ".env",
      ".env.local",
      ".idea/",
      ".DS_Store",
      "coverage/",
    ]) {
      expect(after).toContain(rule);
    }
    // …and tanren's entry was appended rather than swapped in.
    expect(after).toContain(".tanren/cache/");
    expect(after.startsWith("node_modules/")).toBe(true);
  });

  it("leaves CODEOWNERS and the PR template BYTE-IDENTICAL and never writes them at all", async () => {
    const http = brownfieldRepo();
    await injectInto(http);

    expect(http.read("CODEOWNERS")).toBe(EXISTING_CODEOWNERS);
    expect(http.read(".github/PULL_REQUEST_TEMPLATE.md")).toBe(EXISTING_PR_TEMPLATE);
    // Per-directory ownership is intact; the blanket sweep never landed.
    expect(http.read("CODEOWNERS")).toContain("@acme/payments-team");
    expect(http.read("CODEOWNERS")).not.toContain("tanren-operators");
    expect(http.puts).not.toContain("CODEOWNERS");
    expect(http.puts).not.toContain(".github/PULL_REQUEST_TEMPLATE.md");
    // The tanren-owned snapshot IS still written — the guard is conservative, not inert.
    expect(http.puts).toContain(".tanren/PROJECT.md");
  });

  it("still writes every proposed file into a repo that owns none of them", async () => {
    const http = new FakeRepoGitHub({ "README.md": "# greenfield-ish\n" });
    await injectInto(http);

    for (const path of [".tanren/PROJECT.md", ".tanren/ci.yml", "justfile", "CODEOWNERS", ".gitignore"]) {
      expect(http.puts).toContain(path);
    }
    expect(http.read(".gitignore")).toContain(".tanren/cache/");
    expect(http.read("justfile")).toContain(STUB_MARKER);
  });
});

// `mergeFileContent` is the pure decision BOTH data-loss defects above turn on, and its
// own docstring says "tests call it directly" — but nothing did. Reached only through the
// adapter, its edge cases are unreachable: the adapter never presents an existing file
// with no trailing newline, nor an addition already fully present. Those are exactly the
// cases where a wrong answer is silent byte corruption rather than a visible clobber.
describe("mergeFileContent — the pure merge decision, directly", () => {
  // "the repository has no file at this path" is a VALUE under test here, not an omitted
  // argument — named so `unicorn/no-useless-undefined` does not read it as the latter.
  const ABSENT: string | undefined = undefined;

  it("`replace` overwrites, and an ABSENT file always takes the proposal verbatim", () => {
    expect(mergeFileContent({ content: "new", merge: "replace" }, "old")).toBe("new");
    for (const merge of ["replace", "append_if_absent", "skip_if_present"] as const) {
      expect(mergeFileContent({ content: "new", merge }, ABSENT)).toBe("new");
    }
  });

  it("`skip_if_present` writes NOTHING when the repo owns the path (CODEOWNERS, justfile)", () => {
    // `undefined` means "write nothing" — distinct from `""`, which would TRUNCATE the
    // repository's file. The write seam branches on exactly this.
    expect(mergeFileContent({ content: "stub", merge: "skip_if_present" }, "theirs")).toBeUndefined();
    expect(mergeFileContent({ content: "stub", merge: "skip_if_present" }, "")).toBeUndefined();
  });

  it("`append_if_absent` keeps every existing byte and adds only the missing lines", () => {
    const merged = mergeFileContent(
      { content: "node_modules/\n.tanren/cache/\n", merge: "append_if_absent" },
      "dist/\nnode_modules/\n",
    );
    expect(merged).toContain("dist/");
    expect(merged).toContain("node_modules/");
    expect(merged).toContain(".tanren/cache/");
    // The already-present rule is added ONCE, not duplicated.
    expect(merged?.split("\n").filter((l) => l.trim() === "node_modules/")).toHaveLength(1);
  });

  it("`append_if_absent` writes NOTHING when the addition is already fully present (trim-insensitive)", () => {
    // Indentation / CRLF noise must not re-append a rule the repo already has, or every
    // onboarding run would grow the file by a duplicate block.
    expect(
      mergeFileContent({ content: "  .tanren/cache/  \n\n", merge: "append_if_absent" }, ".tanren/cache/\n"),
    ).toBeUndefined();
  });

  it("`append_if_absent` never JOINS its addition onto an unterminated last line", () => {
    // A repo whose .gitignore lacks a trailing newline is common. Concatenating would
    // silently produce `dist/.tanren/cache/` — one corrupt rule, and the real `dist/`
    // rule gone. Byte-exact, because "contains both strings" would pass on the bug.
    expect(mergeFileContent({ content: ".tanren/cache/\n", merge: "append_if_absent" }, "dist/")).toBe(
      "dist/\n\n.tanren/cache/\n",
    );
  });
});

describe("F-2 · a repo that already ships a justfile keeps it (the guard is wired)", () => {
  it("never overwrites the repo's own lifecycle with the failing skeleton stub", async () => {
    const http = brownfieldRepo();
    await injectInto(http);

    expect(http.read("justfile")).toBe(EXISTING_JUSTFILE);
    expect(http.read("justfile")).not.toContain(STUB_MARKER);
    expect(http.read("justfile")).not.toContain("exit 1");
    expect(http.puts).not.toContain("justfile");
    // The gate DEFINITION is what makes onboarding work; it must still land.
    expect(http.puts).toContain(".tanren/ci.yml");
  });

  it("threads the recon index through the routes so the stub is never even proposed", async () => {
    const committed: string[] = [];
    const app = await buildFullTrackHarness(committed, [
      "README.md",
      "pyproject.toml",
      "justfile",
      "CODEOWNERS",
      ".gitignore",
    ]);

    const recon = await app.request("/orgs/org_acme/projects/project_1/recon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: REPO_URL }),
    });
    expect(recon.status).toBe(200);
    const { state } = (await recon.json()) as { state: string };

    const injected = await app.request("/orgs/org_acme/projects/project_1/config-injection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, posture: "strict", excludePaths: [] }),
    });
    expect(injected.status).toBe(201);
    const body = (await injected.json()) as { files: Array<{ path: string }> };
    const proposed = body.files.map((f) => f.path);

    // The repo owns its lifecycle + review routing — neither is proposed or committed.
    expect(proposed).not.toContain("justfile");
    expect(committed).not.toContain("justfile");
    expect(proposed).not.toContain("CODEOWNERS");
    expect(committed).not.toContain("CODEOWNERS");
    // The tanren-owned files still are; `.gitignore` too (it is appended, not replaced).
    expect(proposed).toContain(".tanren/ci.yml");
    expect(proposed).toContain(".tanren/PROJECT.md");
    expect(proposed).toContain(".gitignore");
  });
});

const actor: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin", "platform:admin"],
  source: "session",
};

/** The full-track routes over an in-memory pool, a fake repo reader + a recording forge. */
async function buildFullTrackHarness(committed: string[], repoPaths: string[]): Promise<Hono<ActorContextEnv>> {
  const pool = new RoutesPool();
  pool.seedOrg({
    id: "org_acme",
    config: { version: 1, defaultCredentials: { github_token: "credential/github/org/org_acme/default" } },
  });
  pool.seedProject({ project_id: "project_1", org_id: "org_acme", repo_url: REPO_URL, default_branch: "main" });
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: "credential/github/org/org_acme/default", value: "ghp_test" });

  const index: ReconIndex = {
    repoUrl: REPO_URL,
    filesIndexed: repoPaths.length,
    files: repoPaths.map((path) => ({ path, size: 10, preview: "" })),
  };

  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actor;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  app.route(
    "/orgs",
    createBrownfieldFullTrackRoutes({
      pool: pool.asPgPool(),
      secrets,
      githubHttp: {
        async request() {
          return { status: 404, body: undefined };
        },
      },
      // Recon is SCAFFOLDING for these tests: it reports on its first turn so the
      // route reaches config-injection, which is what F-1/F-2 actually assert.
      // Shape mirrors `fakeExplorer`/the answerer fake in brownfieldOnboarding.test.ts.
      reconAnswererFactory: () => ({
        async turn() {
          return { status: "report", notes: "", requests: [], report: SAMPLE_REPORT };
        },
      }),
      repoReaderFor: () => ({
        async index() {
          return index;
        },
        async explore(_repoUrl, request) {
          return { request, outcome: "not_found", body: "", total: 0, covered: 0 };
        },
      }),
      configInjectionGithubFor: () => ({
        async openConfigInjectionPr(input) {
          committed.push(...input.files.map((f) => f.path));
          return {
            number: 12,
            url: `${REPO_URL}/pull/12`,
            branch: input.headBranch,
            filesCommitted: input.files.map((f) => f.path),
          };
        },
      }),
    }),
  );
  return app;
}
