// `tanren catalog ...` driven end-to-end against a real local stub orchestrator
// and a real temporary catalog on disk. Asserts the OBSERVABLE outcome (what
// the command prints) AND pins the request contract by value.

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as CatalogNs from "../src/commands/catalog/index.js";
import { findProductHandler } from "../src/commands/dispatch.js";
import { captureStdout } from "./helpers/captureOutput.js";
import { startStubServer, type StubServer } from "./helpers/stubServer.js";

let server: StubServer;

const SUMMARY = {
  personas: { created: 1, updated: 0, unchanged: 0 },
  behaviors: { created: 1, updated: 0, unchanged: 0 },
  dryRun: false,
};

async function withStub(responseBody: unknown): Promise<typeof CatalogNs> {
  server = await startStubServer(responseBody);
  process.env.TANREN_PUBLIC_BASE_URL = server.url;
  process.env.TANREN_AUTH_FILE = "/nonexistent/tanren-catalog-cli-auth.json";
  vi.resetModules();
  return (await import("../src/commands/catalog/index.js")) as typeof CatalogNs;
}

async function writeCatalog(): Promise<{ behaviors: string; personas: string }> {
  const root = await mkdtemp(join(tmpdir(), "tanren-catalog-"));
  const behaviors = join(root, "behaviors");
  const personas = join(root, "personas");
  await mkdir(behaviors);
  await mkdir(personas);
  await writeFile(
    join(behaviors, "B-0001-i-see-the-queue-depth.md"),
    `---
schema: tanren.behavior.v0
id: B-0001
initiative: steady-state
title: I see the queue depth
personas: [operator]
provenance: []
authors: []
related: []
---

## Intent

Intent.

## Observable outcomes

- An outcome.

## Related

- (none)
`,
  );
  await writeFile(join(behaviors, "README.md"), "# Behaviors\n\nProse, not a catalog document.\n");
  await writeFile(
    join(personas, "operator.md"),
    `---
schema: tanren.persona.v0
slug: operator
name: "Line operator"
world: floor
aliases: []
---

## Core job

Core job.
`,
  );
  return { behaviors, personas };
}

afterEach(async () => {
  await server?.close();
  delete process.env.TANREN_PUBLIC_BASE_URL;
  delete process.env.TANREN_AUTH_FILE;
});

describe("tanren catalog CLI", () => {
  it("dispatches the catalog subcommands by `<command> <subcommand>` pair", () => {
    expect(findProductHandler("catalog", "import")).toBeDefined();
    expect(findProductHandler("catalog", "list")).toBeDefined();
    expect(findProductHandler("catalog", "get")).toBeDefined();
    expect(findProductHandler("catalog", "unknown")).toBeUndefined();
  });

  it("posts every document from repeated --dir in ONE request and names what it skipped", async () => {
    const catalog = await withStub(SUMMARY);
    const dirs = await writeCatalog();
    const out = await captureStdout(() =>
      catalog.catalogImport([
        "--org-id",
        "org_acme",
        "--project-id",
        "project_1",
        "--dir",
        dirs.behaviors,
        "--dir",
        dirs.personas,
      ]),
    );
    const printed = out.json();
    expect(printed).toMatchObject({ summary: SUMMARY, documentCount: 2 });
    expect(JSON.stringify(printed)).toContain("README.md");

    const sent = server.lastRequest();
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/orgs/org_acme/projects/project_1/catalog/import");
    expect(sent.json).toMatchObject({ dryRun: false });
    const body = sent.json as { documents: { path: string }[] };
    expect(body.documents).toHaveLength(2);
    expect(body.documents.map((document) => document.path.split("/").at(-1)).sort()).toEqual([
      "B-0001-i-see-the-queue-depth.md",
      "operator.md",
    ]);
    expect(server.requests).toHaveLength(1);
  });

  it("passes --dry-run through so nothing is committed", async () => {
    const catalog = await withStub({ ...SUMMARY, dryRun: true });
    const dirs = await writeCatalog();
    await captureStdout(() =>
      catalog.catalogImport([
        "--org-id",
        "org_acme",
        "--project-id",
        "project_1",
        "--dir",
        dirs.behaviors,
        "--dry-run",
      ]),
    );
    expect(server.lastRequest().json).toMatchObject({ dryRun: true });
  });

  it("fails at the gate before any orchestrator call when --dir is missing", async () => {
    const catalog = await withStub(SUMMARY);
    await expect(catalog.catalogImport(["--org-id", "org_acme", "--project-id", "project_1"])).rejects.toThrow(
      /missing --dir/u,
    );
    expect(() => server.lastRequest()).toThrow(/no requests/u);
  });

  it("reads one behavior back by its catalog id", async () => {
    const catalog = await withStub({ catalogId: "B-0001" });
    const out = await captureStdout(() =>
      catalog.catalogGet(["--org-id", "org_acme", "--project-id", "project_1", "--catalog-id", "B-0001"]),
    );
    expect(out.json()).toEqual({ catalogId: "B-0001" });
    expect(server.lastRequest().path).toBe("/orgs/org_acme/projects/project_1/catalog/behaviors/B-0001");
  });
});
