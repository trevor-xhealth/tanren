// REAL-GIT negative control for the polyglot workspace exclude.
//
// The sibling scripted-SSH test (workspaceBootstrapArtifacts.test.ts) can only assert
// the command STRING seedWorkspaceLocalIgnore emits. It cannot prove what `git add -A`
// actually stages, which is the only thing that matters: the writer's diff is what the
// checker prompt is built from, and a `terraform init` / `uv sync` / `cargo build` left
// in the tree by a gate is what blew that prompt past the model's input limit.
//
// So this drives the REAL staging path — seedWorkspaceLocalIgnore -> commitBootstrapState
// -> captureGitStateAfterCodex (`git add -A` + commit + `git diff <base>`) — against a
// REAL git repo via LocalCommandSubstrate, over a fixture that is deliberately adversarial
// in BOTH directions:
//
//   (a) build/dependency/cache output from Node, Python, Terraform, Rust, Go, Gradle and
//       Turborepo, at the repo root AND nested per-package, must be ABSENT from the diff;
//   (b) genuine SOURCE at paths that LOOK like that output — a non-root `src/build/`, a
//       non-root `packages/parser/target/`, a tracked root-level `build/tool.sh`, a
//       `scripts/dist-notes.md`, and a root `deps/` the repo's own `.gitignore` explicitly
//       re-includes — must still be PRESENT.
//
// (b) is the half that matters most: an over-broad ignore list would sail through a naive
// "is node_modules gone?" assertion while silently deleting source files from every writer
// diff. The assertion is therefore an EXACT set equality on the diff's changed paths, so
// neither an extra artifact nor a missing source file can pass.
//
// Doctrine (tanren-owns-the-engine.md): jj-only on Tanren's local WorkspaceVcsCore; the
// RUNNER-side workspace exercised here is a git checkout because the PR branch is pushed
// to the git-based forge.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureGitStateAfterCodex } from "../src/engine/providers/codexGit.js";
import { commitBootstrapState, seedWorkspaceLocalIgnore } from "../src/engine/workspace/bootstrap.js";
import { assertGitDirUnder, fixtureGitEnv } from "./conformance/fakes/fixtureGitEnv.js";
import { LOCAL_HANDLE, LocalCommandSubstrate } from "./conformance/fakes/localCommandSubstrate.js";

// Deterministic Fixture author + git repo-selecting vars SCRUBBED, so a leaked
// GIT_DIR/GIT_WORK_TREE cannot redirect a `cwd`-scoped git op onto the host worktree.
function gitEnv(): NodeJS.ProcessEnv {
  return fixtureGitEnv(process.env);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "inherit"] })
    .toString()
    .trim();
}

function writeFileAt(cwd: string, relPath: string, content: string): void {
  mkdirSync(dirname(join(cwd, relPath)), { recursive: true });
  writeFileSync(join(cwd, relPath), content);
}

// LocalCommandSubstrate spawns `/bin/sh` with the ambient env, so the engine's
// `git commit` needs a committer identity from repo CONFIG (not env). Written into the
// fixture repo only.
function initFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "tanren-ignore-"));
  const repoPath = join(root, "repo");
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "--quiet", "--initial-branch=main"]);
  assertGitDirUnder(repoPath, root, gitEnv());
  git(repoPath, ["config", "user.name", "Fixture"]);
  git(repoPath, ["config", "user.email", "fixture@local"]);
  return repoPath;
}

// The changed paths in a `git diff` — the exact set the checker prompt would carry.
function changedPaths(diff: string): string[] {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("diff --git "))
    .map((line) => line.slice(line.lastIndexOf(" b/") + 3))
    .sort();
}

// Build/dependency/cache output a polyglot gate leaves in the tree. Root-level AND
// nested per-package, because a monorepo produces both.
const GATE_OUTPUT_FILES = [
  "node_modules/left-pad/index.js",
  "dist/bundle.js",
  ".turbo/cache/6f2a.tar.zst",
  "apps/web/.next/server/pages/index.js",
  ".venv/lib/python3.12/site-packages/requests/__init__.py",
  "__pycache__/app.cpython-312.pyc",
  "services/api/__pycache__/routes.cpython-312.pyc",
  ".pytest_cache/v/cache/lastfailed",
  ".mypy_cache/3.12/app.meta.json",
  ".ruff_cache/content/9d2c",
  "myapp.egg-info/PKG-INFO",
  ".terraform/providers/registry.terraform.io/hashicorp/aws/5.0.0/terraform-provider-aws",
  "infra/prod/.terraform/providers/registry.terraform.io/hashicorp/null/3.2.0/terraform-provider-null",
  ".gradle/8.5/checksums/checksums.lock",
  "coverage/lcov.info",
  "target/debug/app",
  "vendor/github.com/pkg/errors/errors.go",
] as const;

// Source the writer legitimately authors, at paths that LOOK like gate output.
const WRITER_SOURCE_FILES = [
  "src/app.py",
  "src/build/emit.ts",
  "packages/parser/target/parser.rs",
  "deps/0001-upstream.patch",
] as const;

describe("workspace local ignore — polyglot gate output never reaches the writer diff", () => {
  it("excludes Node/Python/Terraform/Rust/Go/Gradle output while keeping look-alike source", async () => {
    const repoPath = initFixtureRepo();

    // Base tree, TRACKED before the exclude is seeded. `build/tool.sh` is a root-level
    // `build/` the repo legitimately commits — the root-anchored `/build/` entry must not
    // be able to drop it (ignores never apply to tracked files). `.gitignore` re-includes
    // a root `deps/` the repo owns, proving the repo's own file OUTRANKS info/exclude.
    writeFileAt(repoPath, "README.md", "# polyglot\n");
    writeFileAt(repoPath, "build/tool.sh", "#!/bin/sh\necho build\n");
    writeFileAt(repoPath, "src/build/generate.ts", "export const generate = () => 1;\n");
    writeFileAt(repoPath, "packages/parser/target/lexer.rs", "pub fn lex() {}\n");
    writeFileAt(repoPath, "scripts/dist-notes.md", "# release notes\n");
    writeFileAt(repoPath, "docs/coverage.md", "# coverage policy\n");
    writeFileAt(repoPath, ".gitignore", "!/deps/\n");
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "--quiet", "-m", "base"]);

    const ssh = new LocalCommandSubstrate();
    await seedWorkspaceLocalIgnore({ ssh, target: LOCAL_HANDLE, workspacePath: repoPath });
    const baseSha = await commitBootstrapState({ ssh, target: LOCAL_HANDLE, workspacePath: repoPath });
    expect(baseSha).toMatch(/^[0-9a-f]{40}$/u);

    for (const path of GATE_OUTPUT_FILES) {
      writeFileAt(repoPath, path, "GATE OUTPUT — must never reach the writer diff\n");
    }
    for (const path of WRITER_SOURCE_FILES) {
      writeFileAt(repoPath, path, "writer-authored source\n");
    }
    // Modifications to TRACKED files whose paths look like gate output.
    writeFileAt(repoPath, "build/tool.sh", "#!/bin/sh\necho build v2\n");
    writeFileAt(repoPath, "scripts/dist-notes.md", "# release notes v2\n");

    const state = await captureGitStateAfterCodex(ssh, LOCAL_HANDLE, repoPath, baseSha);

    // EXACT set equality: an over-broad list (missing source) and an under-broad list
    // (leaked artifacts) both fail here.
    expect(changedPaths(state.diff)).toEqual(["build/tool.sh", "scripts/dist-notes.md", ...WRITER_SOURCE_FILES].sort());

    // Spelled out per artifact so a failure names the ecosystem that leaked.
    for (const path of GATE_OUTPUT_FILES) {
      expect(changedPaths(state.diff)).not.toContain(path);
    }
    // The artifacts are still on DISK — they were excluded from staging, not deleted.
    expect(git(repoPath, ["status", "--porcelain", "--ignored", "--", "target"])).toContain("target/");
  });
});
