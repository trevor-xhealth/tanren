import type { LinearIntakeAuthority } from "../../src/engine/forge/inbox/linearConnector.js";
import { testOrgGrant } from "./orgGrant.js";

/** Authentic exact Linear intake authority for connector tests. */
export function testLinearIntakeAuthority(credentialRef: string): LinearIntakeAuthority {
  return ({ orgId, projectId, resourceId }) =>
    testOrgGrant({
      orgId,
      projectId,
      providerKind: "linear",
      credentialRef,
      capability: "issues",
      operation: "intake",
      target: { resourceId },
    });
}
