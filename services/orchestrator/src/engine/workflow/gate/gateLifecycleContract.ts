// The repo's declared PREPARATION commands, resolved once per run and classified the same
// way the gate-config read is.
//
// WHY THIS IS ITS OWN MODULE. `.tanren/ci.yml` is read TWICE per gate — once as the gate
// CONFIG (tiers/when) and once for the preparation verbs (`bootstrap.run`, `setup.run`) —
// as two separate SSH `cat`s with an `await` between them, against a workspace the run is
// actively writing. The first read has always been wrapped in a classifier that turns an
// invalid contract into a fail-closed P0 gate finding; the second had none, so a parse or
// validation error there escaped `buildDefaultGate` and TERMINATED the run instead.
//
// "The first parsed, so the second must too" holds only if both reads see the same BYTES,
// which two reads of a live file do not guarantee: a gate racing the `cat >` that
// materializes the file gets a truncated document the first read never saw.
//
// The classification lives HERE rather than inline in the gate closure so the two reads
// share one control-flow shape, and so the branches do not inflate a closure already at
// the repo's cyclomatic ratchet.
import type { CiConfigValidationError, CiYamlParseError } from "../../ci/index.js";
import {
  resolveWorkspaceLifecycleCommands,
  type ResolveGateConfigInput,
  type WorkspaceLifecycleCommands,
} from "./resolveGateConfig.js";
import { isInvalidCiConfigError } from "./gateConfigFailure.js";

/** Either the repo's preparation commands, or the invalid-contract error to fail closed on. */
export type LifecycleContract =
  | { ok: WorkspaceLifecycleCommands }
  | { invalid: CiConfigValidationError | CiYamlParseError };

/**
 * Read `bootstrap.run` + `setup.run`, classifying an invalid contract instead of rejecting.
 *
 * A SUBSTRATE failure still rejects: an unreadable runner is not a repo defect, and recasting
 * it as one would let a transient hiccup be reported as the repository's fault. Deliberately
 * NOT a fallback to an empty lifecycle either — the caller's config branch has already
 * ACCEPTED the first read, so gating with no bootstrap and no setup would be a pass against a
 * contract nobody validated.
 */
export function resolveLifecycleContract(input: ResolveGateConfigInput): Promise<LifecycleContract> {
  return resolveWorkspaceLifecycleCommands(input)
    .then((ok) => ({ ok }) as LifecycleContract)
    .catch((error: unknown) => {
      if (isInvalidCiConfigError(error)) {
        return { invalid: error } as LifecycleContract;
      }
      throw error;
    });
}
