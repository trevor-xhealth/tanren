#!/usr/bin/env tsx
// Empirically test whether the ds-4 pixel render path can run on Docker.
//
// Two separate questions, deliberately asked separately, because the answer
// differs and the difference is the whole finding:
//   1. Does `probeRenderWorkerAvailable()` — the gate that decides whether the
//      pixel pass runs at all — return true?
//   2. Does `buildPodmanScreenshotRunner().screenshot()` — the thing that
//      actually captures — produce a real PNG?
//
// Both are pointed at the SAME binary via TANREN_PODMAN_BIN so the only variable
// is which subcommand the code issues.

import { argv } from "node:process";
import { buildPodmanScreenshotRunner, probeRenderWorkerAvailable } from "../src/engine/design/render/podmanScreenshotRunner.js";

const bin = argv[2] ?? "docker";

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --color-action-surface-primary: #105546; --color-text-on-primary: #fcfcfc; }
body { margin:0; font-family: sans-serif; background:#fcfcfc; }
.card { margin:24px; padding:20px; border-radius:10px;
        background: var(--color-action-surface-primary); color: var(--color-text-on-primary); }
</style></head><body><div class="card"><h1>Adherence 82%</h1><p>up 4 pts vs last month</p></div></body></html>`;

async function main(): Promise<void> {
  console.log(`TANREN_PODMAN_BIN = ${bin}`);

  console.log("\n[1] probeRenderWorkerAvailable() — the gate");
  const available = await probeRenderWorkerAvailable({ podmanBin: bin });
  console.log(`    -> ${available}`);

  console.log("\n[2] buildPodmanScreenshotRunner().screenshot() — the capture");
  const runner = buildPodmanScreenshotRunner({ podmanBin: bin });
  const result = await runner.screenshot({ documentHtml: HTML, viewport: { width: 800, height: 400 } });
  if (result.ok) {
    const png = result.png;
    const isPng = png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
    console.log(`    -> ok, ${png.length} bytes, PNG magic=${isPng}`);
  } else {
    console.log(`    -> FAILED: ${result.reason}`);
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.stack : String(error));
}
