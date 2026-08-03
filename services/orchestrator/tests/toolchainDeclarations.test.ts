// LAYER-1 DETECTION — the toolchain a repository ACTUALLY declares.
//
// THE NEGATIVE CONTROL THIS FILE EXISTS FOR. Driven against a real 12k-file monorepo,
// Tanren's gate died at its first step with `tanren: no mise.toml - skipping mise
// install (project declared no toolchain)` followed by `pnpm: command not found`, exit
// 127. The repository declared its toolchain the way most repositories do —
// `package.json#packageManager` plus `uv.lock` — and Tanren recognized exactly one file:
// `mise.toml`. These tests pin the widened detection and, just as importantly, pin what
// it must REFUSE to guess.

import { describe, expect, it } from "vitest";
import {
  detectToolchainRequirements,
  provisionableBinaries,
  type ToolchainDeclarationFile,
} from "../src/engine/workspace/toolchainDeclarations.js";

const file = (path: string, contents = ""): ToolchainDeclarationFile => ({ path, contents });

describe("detectToolchainRequirements · the mainstream polyglot repo (the live failure)", () => {
  // Byte-for-byte the declaration shape of the repository the live run could not gate:
  // a corepack `packageManager` field and a uv lockfile, and NO mise.toml anywhere.
  const mainstream = [
    file("package.json", '{ "name": "app", "private": true, "packageManager": "pnpm@11.19.0" }'),
    file("pnpm-lock.yaml"),
    file("uv.lock"),
    file(".python-version", "3.14\n"),
  ];

  it("detects pnpm AND uv from standard declarations with no mise.toml present", () => {
    const detection = detectToolchainRequirements(mainstream);
    expect(detection.deferToMiseConfig).toBe(false);
    const byTool = Object.fromEntries(detection.requirements.map((r) => [r.tool, r]));
    // pnpm: the version comes VERBATIM from packageManager — Tanren picked nothing.
    expect(byTool["pnpm"]).toMatchObject({
      spec: "11.19.0",
      bin: "pnpm",
      declaredIn: "package.json",
      versionDeclared: true,
    });
    // uv: the lockfile declares the TOOL but no version, and that is reported as such
    // rather than silently pinned to a version Tanren chose.
    expect(byTool["uv"]).toMatchObject({ spec: "latest", bin: "uv", declaredIn: "uv.lock", versionDeclared: false });
    expect(byTool["python"]).toMatchObject({ spec: "3.14", declaredIn: ".python-version" });
    // Both binaries of the observed failure are now accounted for.
    expect(detection.requirements.map((r) => r.bin)).toEqual(expect.arrayContaining(["pnpm", "uv"]));
  });

  it("a pinned declaration outranks a lockfile's unconstrained one for the same tool", () => {
    // pnpm-lock.yaml alone would say "pnpm@latest"; packageManager pins it. The pinned
    // reading must win regardless of which file was listed first — and THAT is the half
    // this test used to leave unproven. The candidate list was built content-paths-then-
    // presence-paths, so the pinned reading always arrived first and the "first wins" path
    // answered every case; the branch that was supposed to express the precedence never ran.
    const detection = detectToolchainRequirements(mainstream);
    expect(detection.requirements.filter((r) => r.tool === "pnpm")).toHaveLength(1);
    expect(detection.requirements.find((r) => r.tool === "pnpm")?.spec).toBe("11.19.0");

    // The same set, listed the other way round. Nothing about the RULE depends on the order
    // the caller happens to hand the files over in.
    const reversed = detectToolchainRequirements(mainstream.toReversed());
    expect(reversed.requirements.filter((r) => r.tool === "pnpm")).toHaveLength(1);
    expect(reversed.requirements.find((r) => r.tool === "pnpm")?.spec).toBe("11.19.0");

    // …and it does not depend on the two path CATALOGUES staying in their current order
    // either: an unconstrained declaration read before a pinned one still loses.
    const lockfileFirst = detectToolchainRequirements([
      file("pnpm-lock.yaml"),
      file("package.json", '{ "packageManager": "pnpm@11.19.0" }'),
    ]);
    expect(lockfileFirst.requirements).toEqual([
      { tool: "pnpm", spec: "11.19.0", bin: "pnpm", declaredIn: "package.json", versionDeclared: true },
    ]);
  });

  it("a lockfile alone still declares its tool (unconstrained)", () => {
    const detection = detectToolchainRequirements([file("package.json", "{}"), file("yarn.lock")]);
    expect(detection.requirements).toEqual([
      { tool: "yarn", spec: "latest", bin: "yarn", declaredIn: "yarn.lock", versionDeclared: false },
    ]);
  });
});

describe("detectToolchainRequirements · the published convention set", () => {
  it.each([
    [".nvmrc", "v24.16.0\n", "node", "24.16.0"],
    [".node-version", "22.11.0", "node", "22.11.0"],
    [".python-version", "3.12.4\n", "python", "3.12.4"],
    [".ruby-version", "3.4.1\n", "ruby", "3.4.1"],
    ["go.mod", "module example.com/x\n\ngo 1.23.4\n", "go", "1.23.4"],
    ["rust-toolchain.toml", '[toolchain]\nchannel = "1.80.0"\n', "rust", "1.80.0"],
    ["rust-toolchain", "1.79.0\n", "rust", "1.79.0"],
  ])("%s declares %s", (path, contents, tool, spec) => {
    const detection = detectToolchainRequirements([file(path, contents)]);
    expect(detection.requirements).toHaveLength(1);
    expect(detection.requirements[0]).toMatchObject({ tool, spec, declaredIn: path, versionDeclared: true });
  });

  it("go.mod's `toolchain` directive outranks its `go` language directive", () => {
    const detection = detectToolchainRequirements([
      file("go.mod", "module example.com/x\n\ngo 1.22.0\n\ntoolchain go1.23.4\n"),
    ]);
    expect(detection.requirements[0]).toMatchObject({ tool: "go", spec: "1.23.4" });
  });

  it("reads asdf's .tool-versions, renaming its tool names to mise's", () => {
    const detection = detectToolchainRequirements([
      file(".tool-versions", "nodejs 24.1.0\ngolang 1.23.0\n# a comment\n"),
    ]);
    expect(detection.requirements.map((r) => `${r.tool}@${r.spec}`)).toEqual(["node@24.1.0", "go@1.23.0"]);
  });

  it("strips corepack's integrity suffix from packageManager", () => {
    const detection = detectToolchainRequirements([
      file("package.json", '{"packageManager":"yarn@4.5.0+sha224.abcdef0123456789"}'),
    ]);
    expect(detection.requirements[0]).toMatchObject({ tool: "yarn", spec: "4.5.0" });
  });
});

describe("detectToolchainRequirements · what it REFUSES to guess", () => {
  it("defers wholesale to a repo's own mise.toml and detects nothing else", () => {
    // The repo's explicit declaration outranks Tanren's reading of its conventions —
    // there is exactly one source of truth, and it is the repo's.
    const detection = detectToolchainRequirements([
      file("mise.toml", '[tools]\nnode = "22"\n'),
      file("package.json", '{"packageManager":"pnpm@11.19.0"}'),
    ]);
    expect(detection.deferToMiseConfig).toBe(true);
    expect(detection.requirements).toEqual([]);
  });

  it("reports an alias it cannot translate instead of inventing a version", () => {
    // `lts/iron` is nvm's alias vocabulary, not a version. Translating it would mean
    // Tanren picking a version for the project, which the doctrine forbids.
    const detection = detectToolchainRequirements([file(".nvmrc", "lts/iron\n")]);
    expect(detection.requirements).toEqual([]);
    expect(detection.unresolved).toEqual([
      {
        path: ".nvmrc",
        reason: '"lts/iron" is not a version mise can provision',
        // The KIND is what makes this fatal downstream: node is a tool Tanren CAN
        // provision, so "could not honor the version" means the run would otherwise
        // proceed on whatever node the image carries.
        kind: "untranslatable-version",
        tool: "node",
      },
    ]);
  });

  it("separates a version it cannot translate from a declaration it cannot read at all", () => {
    // A tool Tanren has no binary for is NOT an untranslatable VERSION: Tanren never
    // identified anything it could have put on PATH, so it can make no claim about which
    // version is in effect. Keeping these apart is the whole of the enforcement's
    // tolerance — see toolchainEnforcement.ts.
    const exotic = detectToolchainRequirements([file("package.json", '{"packageManager":"frobpm@3.2.1"}')]);
    expect(exotic.unresolved[0]?.kind).toBe("unresolvable-declaration");
    const alias = detectToolchainRequirements([file(".tool-versions", "nodejs lts/iron\n")]);
    expect(alias.unresolved[0]?.kind).toBe("untranslatable-version");
    const malformed = detectToolchainRequirements([file("package.json", '{"packageManager":"pnpm"}')]);
    expect(malformed.unresolved[0]?.kind).toBe("unresolvable-declaration");
  });

  it("reports an unparseable package.json rather than reading it as no-toolchain", () => {
    const detection = detectToolchainRequirements([file("package.json", "{ this is not json")]);
    expect(detection.requirements).toEqual([]);
    expect(detection.unresolved).toEqual([
      { path: "package.json", reason: "is not parseable JSON", kind: "unresolvable-declaration" },
    ]);
  });

  it("a rust `stable` channel is reported, never mapped to some concrete release", () => {
    const detection = detectToolchainRequirements([file("rust-toolchain.toml", '[toolchain]\nchannel = "stable"\n')]);
    expect(detection.requirements).toEqual([]);
    expect(detection.unresolved[0]?.reason).toContain('channel "stable"');
    expect(detection.unresolved[0]?.kind).toBe("untranslatable-version");
  });

  it("a repo with no declaration at all yields nothing — and says nothing false", () => {
    const detection = detectToolchainRequirements([]);
    expect(detection).toEqual({ deferToMiseConfig: false, requirements: [], unresolved: [] });
  });

  it("package.json without a packageManager field declares no package manager", () => {
    const detection = detectToolchainRequirements([file("package.json", '{"name":"x","dependencies":{}}')]);
    expect(detection.requirements).toEqual([]);
    expect(detection.unresolved).toEqual([]);
  });
});

describe("provisionableBinaries · the boundary of the infra-fault claim", () => {
  it("covers the binaries a declaration can put on PATH", () => {
    expect(provisionableBinaries()).toEqual(expect.arrayContaining(["pnpm", "uv", "node", "go", "cargo"]));
  });

  it("does NOT cover project programs a dependency install provides", () => {
    // These are scaffold defects the writer CAN fix by declaring a dependency, so the
    // infra classifier must never claim them away from the writer loop.
    for (const bin of ["vitest", "tsc", "eslint", "pytest"]) {
      expect(provisionableBinaries()).not.toContain(bin);
    }
  });
});

describe("detectToolchainRequirements · repository bytes are KEYS, and keys are not trusted", () => {
  // The tool name, the alias and the presence-path lookups are all indexed by bytes the
  // gated repository committed. A plain object literal inherits `Object.prototype`, so
  // `TABLE["constructor"]` returns a FUNCTION rather than `undefined`, the `=== undefined`
  // guards downstream pass it through, and a repo's own `.tool-versions` turns a legible
  // "Tanren has no binary mapping for this" report into an orchestrator-side TypeError.
  it("reports an inherited-property tool name as unmappable, and never crashes on it", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      const detection = detectToolchainRequirements([file(".tool-versions", `${name} 1.2.3\n`)]);
      expect(detection.requirements).toEqual([]);
      expect(detection.unresolved).toHaveLength(1);
      // The report names the tool as a STRING — the repo's own bytes, echoed back.
      expect(detection.unresolved[0]?.reason).toContain(`declares tool "${name}"`);
      expect(typeof detection.unresolved[0]?.tool).toBe("string");
    }
  });

  it("does not let an inherited-property lockfile path or packageManager name through", () => {
    expect(detectToolchainRequirements([file("constructor")]).requirements).toEqual([]);
    const pm = detectToolchainRequirements([file("package.json", '{ "packageManager": "constructor@1.0.0" }')]);
    expect(pm.requirements).toEqual([]);
    expect(pm.unresolved[0]?.tool).toBe("constructor");
  });
});
