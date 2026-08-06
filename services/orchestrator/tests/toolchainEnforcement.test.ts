// TOOLCHAIN ENFORCEMENT — the two halves of "Tanren must not run a version the repo did
// not declare", split out from the provisioning suite because they are a POLICY, not a
// command builder:
//
//   (1) `classifyUnhonoredDeclarations` — WHICH unhonored declarations halt a run. A
//       version Tanren cannot translate for a tool it CAN provision halts; a declaration
//       it could not resolve to any tool at all stays a notice. That asymmetry is the
//       whole tolerance, and these pin both sides of it.
//   (2) the resolution frame — the version that was actually IN EFFECT, carried out of
//       the provision as a value rather than a console line that scrolls past.

import { describe, expect, it } from "vitest";
import { detectToolchainRequirements } from "../src/engine/workspace/toolchainDeclarations.js";
import {
  classifyUnhonoredDeclarations,
  describeToolchainInEffect,
  parseToolchainResolutions,
  WorkspaceToolchainUnhonoredError,
} from "../src/engine/workspace/toolchainEnforcement.js";
import { WorkspaceDepsInstallError } from "../src/engine/workspace/bootstrap.js";

const workspacePath = "/ws/run/repo";

// A repo declaring its toolchain the ordinary way: a corepack `packageManager` field and
// a lockfile, with no mise.toml anywhere.
const MAINSTREAM_DECLARATIONS = [
  { path: "package.json", contents: '{"packageManager":"pnpm@11.19.0"}' },
  { path: "uv.lock", contents: "" },
];

describe("classifyUnhonoredDeclarations · an unhonored VERSION halts; an unreadable file does not", () => {
  it("HALTS on a version alias for a tool Tanren could otherwise have provisioned", () => {
    const detection = detectToolchainRequirements([{ path: ".nvmrc", contents: "lts/iron\n" }]);
    const error = classifyUnhonoredDeclarations(workspacePath, detection);
    expect(error).toBeInstanceOf(WorkspaceToolchainUnhonoredError);
    // What the operator is told: the file, the reason, the consequence, and the fix.
    expect(error?.message).toContain(".nvmrc");
    expect(error?.message).toContain("will not proceed on an undeclared version");
    expect(error?.message).toContain("whatever version of that tool the runner image happens to carry");
    expect(error?.message).toContain("mise.toml");
    // NOT a deps-install error: the writer-routing boundary keys on THAT class, and
    // routing this there would ask an LLM writer to rewrite the operator's own toolchain
    // pin. `WorkspaceMiseProvisionError` was the wrong guard — it is a SIBLING that also
    // extends `Error` directly, so the assertion could never fail and never touched the
    // boundary it named. `WorkspaceDepsInstallError` is the class the gate actually
    // branches on (workflow/gate/bootstrapFailure.ts).
    expect(error).not.toBeInstanceOf(WorkspaceDepsInstallError);
  });

  it("does NOT halt a repo whose declaration it simply could not read", () => {
    // A typo'd package.json mid-run is writer-fixable; halting on it would strand runs.
    for (const contents of ["{ not json", '{"packageManager":"pnpm"}', '{"packageManager":"frobpm@3.2.1"}']) {
      const detection = detectToolchainRequirements([{ path: "package.json", contents }]);
      expect(detection.unresolved.length).toBeGreaterThan(0);
      expect(classifyUnhonoredDeclarations(workspacePath, detection)).toBeUndefined();
    }
  });

  it("does NOT halt an ordinary repo, or one that declares nothing", () => {
    expect(classifyUnhonoredDeclarations(workspacePath, detectToolchainRequirements([]))).toBeUndefined();
    expect(
      classifyUnhonoredDeclarations(workspacePath, detectToolchainRequirements(MAINSTREAM_DECLARATIONS)),
    ).toBeUndefined();
    expect(
      classifyUnhonoredDeclarations(
        workspacePath,
        detectToolchainRequirements([{ path: "mise.toml", contents: '[tools]\nnode="lts/iron"\n' }]),
      ),
    ).toBeUndefined();
  });
});

describe("toolchain resolutions · which version actually ran, as a value", () => {
  it("round-trips the frame the verification emits", () => {
    const stdout = [
      "some unrelated build output",
      "===TANREN-TOOLCHAIN-IN-EFFECT:node|24|24.18.1|.nvmrc|pinned===",
      "===TANREN-TOOLCHAIN-IN-EFFECT:uv|latest|0.9.2|uv.lock|unconstrained===",
    ].join("\n");
    expect(parseToolchainResolutions(stdout)).toEqual([
      { tool: "node", declared: "24", resolved: "24.18.1", declaredIn: ".nvmrc", versionDeclared: true },
      { tool: "uv", declared: "latest", resolved: "0.9.2", declaredIn: "uv.lock", versionDeclared: false },
    ]);
    expect(parseToolchainResolutions("nothing framed here")).toEqual([]);
  });

  it("renders declared-vs-actual for a human", () => {
    expect(
      describeToolchainInEffect(
        parseToolchainResolutions("===TANREN-TOOLCHAIN-IN-EFFECT:node|24|24.18.1|.nvmrc|pinned==="),
      ),
    ).toBe('node 24.18.1 (declared "24" in .nvmrc)');
    expect(describeToolchainInEffect([])).toBe("nothing was provisioned");
  });
});
