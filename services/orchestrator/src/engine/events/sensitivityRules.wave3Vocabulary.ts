import type { SensitivityRule } from "./sensitivity.js";

function publicRules(eventName: string, paths: readonly string[]): SensitivityRule[] {
  return paths.map((path) => ({ eventName, path, tag: "public" }));
}

export const wave3VocabularySensitivityRules: SensitivityRule[] = [
  ...publicRules("symptom.contract.authored", [
    "projectId",
    "issueLoopId",
    "contractId",
    "schemaVersion",
    "canonicalHash",
    "sourceRevision",
    "authorTaskId",
    "baselineRequired",
  ]),
  ...publicRules("symptom.contract.validated", [
    "projectId",
    "issueLoopId",
    "contractId",
    "canonicalHash",
    "validationTaskId",
  ]),
  ...publicRules("symptom.contract.superseded", ["projectId", "issueLoopId", "contractId", "supersededByContractId"]),
  ...publicRules("symptom.contract.authoring_failed", ["projectId", "issueLoopId", "authorTaskId", "failureCode"]),
  ...publicRules("merge.member.isolated", [
    "projectId",
    "partitionId",
    "groupId",
    "memberId",
    "reason",
    "findingIds",
    "findingIds[]",
  ]),
  ...publicRules("merge.partition.leased", [
    "projectId",
    "partitionId",
    "leaseOwner",
    "leaseHeartbeatAt",
    "generation",
    "scopeFingerprint",
  ]),
  ...publicRules("merge.partition.released", ["projectId", "partitionId", "leaseOwner", "generation"]),
  ...publicRules("merge.repair.routed", [
    "projectId",
    "sourceSpecId",
    "groupId",
    "evaluationId",
    "disposition",
    "failureClass",
    "failureSignature",
    "magnitude",
    "blockedReason",
  ]),
  ...publicRules("merge.member.respec_routed", [
    "projectId",
    "sourceSpecId",
    "groupId",
    "evaluationId",
    "packetHash",
    "priorAgentRoute",
    "nextAgentRoute",
    "generation",
    "replacementSpecIds",
    "replacementSpecIds[]",
    "specMode",
  ]),
];
