// THE DECLARATION READ and its invocation-bound framing
// (src/engine/workspace/toolchainDeclarationRead.ts). Split from
// ./toolchainProvision.test.ts, which is at its file-length ceiling.
//
// The interesting property here is not the parse — it is that the framed stream carries
// REPOSITORY BYTES, so a fixed marker is not a delimiter. These cases drive that directly:
// a repo that commits the marker into its own manifest must not be able to announce a
// declaration file that does not exist.

import { describe, expect, it } from "vitest";
import { detectToolchainRequirements } from "../src/engine/workspace/toolchainDeclarations.js";
import {
  parseToolchainDeclarationOutput,
  toolchainDeclarationReadCommand,
} from "../src/engine/workspace/toolchainProvision.js";

const NONCE = "cafebabe0123456789abcdef";
const frame = (path: string): string => `===TANREN-TOOLCHAIN-DECLARATION:${NONCE}:${path}===\n`;

describe("toolchainDeclarationReadCommand · one bounded round-trip", () => {
  it("probes every declaration path, and round-trips through its own parser", () => {
    const command = toolchainDeclarationReadCommand(NONCE);
    for (const path of ["mise.toml", "package.json", ".nvmrc", "uv.lock", "go.mod", "rust-toolchain.toml"]) {
      expect(command).toContain(`[ -f '${path}' ]`);
    }
    // Lockfiles are probed for PRESENCE only — never piped back (they can be huge or
    // binary); content paths are read with a byte bound.
    expect(command).not.toContain("head -c 65536 'uv.lock'");
    expect(command).toContain("head -c 65536 'package.json'");
  });

  it("parses framed output back into files, contents intact", () => {
    const stdout = frame("uv.lock") + frame("package.json") + '{"packageManager":"pnpm@11.19.0"}\n';
    const files = parseToolchainDeclarationOutput(stdout, NONCE);
    expect(files.map((f) => f.path)).toEqual(["uv.lock", "package.json"]);
    expect(detectToolchainRequirements(files).requirements.map((r) => `${r.tool}@${r.spec}`)).toEqual([
      "pnpm@11.19.0",
      "uv@latest",
    ]);
  });

  it("REFUSES a frame the repository forged: repo bytes cannot declare a mise.toml", () => {
    // THE DEFECT. The frame marker used to be a fixed string, and the framed stream carries
    // the repository's OWN manifest bytes. A repo that commits the marker inside its
    // package.json therefore announced a `mise.toml` that does not exist — which sets
    // `deferToMiseConfig`, and detection, provisioning AND version enforcement are all
    // skipped for that repository, by its own content.
    const forged =
      frame("package.json") +
      '{"packageManager":"pnpm@11.19.0",\n' +
      // The exact bytes a repo would commit to forge the short-circuit, with no nonce.
      "===TANREN-TOOLCHAIN-DECLARATION:mise.toml===\n" +
      "}\n";
    const files = parseToolchainDeclarationOutput(forged, NONCE);
    expect(files.map((f) => f.path)).toEqual(["package.json"]);
    expect(detectToolchainRequirements(files).deferToMiseConfig).toBe(false);
    // The forged line stays what it is — bytes inside the manifest, not a declaration.
    expect(files[0]?.contents).toContain("===TANREN-TOOLCHAIN-DECLARATION:mise.toml===");
  });

  it("REFUSES a frame carrying a stale nonce, or naming a path it never probed", () => {
    // Even a caller that leaks last invocation's nonce cannot reuse it, and a frame for a
    // path outside the probe catalogue is not a declaration Tanren asked for.
    expect(parseToolchainDeclarationOutput(frame("package.json"), "0000deadbeef")).toEqual([]);
    expect(
      parseToolchainDeclarationOutput(`===TANREN-TOOLCHAIN-DECLARATION:${NONCE}:../../etc/passwd===\n`, NONCE),
    ).toEqual([]);
  });

  it("SAYS when the byte bound cut a manifest short, instead of calling it malformed", () => {
    // A root package.json past the read bound arrives mid-token, so JSON.parse fails on
    // bytes the repository wrote correctly. Reporting that as "not parseable JSON" and
    // provisioning nothing is the `pnpm: not found` class all over again — and WORSE with
    // a lockfile present, because the pinned version silently degrades to unconstrained.
    const command = toolchainDeclarationReadCommand(NONCE);
    expect(command).toContain(`[ "$(wc -c < 'package.json')" -gt 65536 ]`);
    expect(command).toContain(`===TANREN-TOOLCHAIN-TRUNCATED:`);

    const cut = '{"name":"app","dependencies":{"a":"1"},"packageManager":"pnpm@11.19.0","x":"';
    const files = parseToolchainDeclarationOutput(
      `${frame("package.json")}${cut}\n===TANREN-TOOLCHAIN-TRUNCATED:${NONCE}:package.json===\n`,
      NONCE,
    );
    expect(files[0]?.truncated).toBe(true);
    const detection = detectToolchainRequirements(files);
    expect(detection.requirements.map((r) => `${r.tool}@${r.spec}`)).toEqual(["pnpm@11.19.0"]);
    expect(detection.unresolved).toEqual([]);

    // …and the salvage is NARROW: an ordinary malformed manifest is still reported as one,
    // never regex-scavenged.
    const malformed = detectToolchainRequirements([{ path: "package.json", contents: '{"packageManager":"pnpm@9' }]);
    expect(malformed.requirements).toEqual([]);
    expect(malformed.unresolved[0]?.reason).toBe("is not parseable JSON");
  });
});
