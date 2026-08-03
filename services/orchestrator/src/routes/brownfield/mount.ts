// mount both brownfield route groups in one call so `main.ts` stays a
// thin wiring file (under the 500-line cap):
//   - the minimal link endpoint (`createBrownfieldRoutes`), and
//   - the full track (recon → config-injection PR → DAG seed →
//     governance) (`createBrownfieldFullTrackRoutes`).
// Both share the same pool/secrets/github plumbing; every GitHub/Answerer seam
// inside is injectable, and neither adds a migration.

import type { Hono } from "hono";
import type pg from "pg";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { ReconTurnAnswerer } from "../../engine/forge/brownfield/index.js";
import type { ForgeAnswererTarget } from "../../engine/forge/providerFactory.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { createBrownfieldRoutes } from "./index.js";
import { createBrownfieldFullTrackRoutes } from "./fullTrack.js";

export interface MountBrownfieldOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  // The recon answerer factory (real provider answerer in prod; fake in tests).
  // Threaded into the full-track recon route; the minimal link route ignores it.
  reconAnswererFactory: (target: ForgeAnswererTarget) => ReconTurnAnswerer;
}

export function mountBrownfieldRoutes(app: Hono<ActorContextEnv>, options: MountBrownfieldOptions): void {
  app.route("/orgs", createBrownfieldRoutes(options));
  app.route("/orgs", createBrownfieldFullTrackRoutes(options));
}
