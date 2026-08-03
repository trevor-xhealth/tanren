// dispatch handlers for the new product-API CLI verbs. Keeps the
// growing surface out of `cli/src/main.ts` so that file stays under the
// 500-line architecture cap.

import { behaviorsCreate, behaviorsGet, behaviorsList } from "./behaviors/index.js";
import { catalogGet, catalogImport, catalogList } from "./catalog/index.js";
import { credentialsCreate, credentialsDelete, credentialsGet, credentialsList } from "./credentials/index.js";
import {
  cellsCreate,
  cellsList,
  experimentsCompare,
  experimentsCreate,
  experimentsGet,
  experimentsList,
  experimentsReport,
  experimentsRun,
} from "./experiments/index.js";
import {
  integrationsBindings,
  integrationsCapabilityNodes,
  integrationsDelivery,
  integrationsLifecycle,
  integrationsRequirements,
  integrationsVerifyEvidence,
} from "./integrations/index.js";
import { milestonesCreate, milestonesGet, milestonesList } from "./milestones/index.js";
import { orgsConfigSet, orgsGet, orgsList } from "./orgs/index.js";
import { personasCreate, personasGet, personasList } from "./personas/index.js";
import { proofVerify } from "./proof/index.js";
import { projectsCreate, projectsGet, projectsLink, projectsList } from "./projects/index.js";
import { specsCreate, specsGet, specsList, specsRun } from "./specs/index.js";

const HANDLERS: Record<string, (rest: string[]) => Promise<void>> = {
  "orgs list": orgsList,
  "orgs get": orgsGet,
  "orgs config-set": orgsConfigSet,
  "projects list": projectsList,
  "projects create": projectsCreate,
  "projects get": projectsGet,
  "projects link": projectsLink,
  "specs list": specsList,
  "specs create": specsCreate,
  "specs get": specsGet,
  "specs run": specsRun,
  "personas list": personasList,
  "personas create": personasCreate,
  "personas get": personasGet,
  "behaviors list": behaviorsList,
  "behaviors create": behaviorsCreate,
  "behaviors get": behaviorsGet,
  "catalog import": catalogImport,
  "catalog list": catalogList,
  "catalog get": catalogGet,
  "milestones list": milestonesList,
  "milestones create": milestonesCreate,
  "milestones get": milestonesGet,
  "credentials list": credentialsList,
  "credentials create": credentialsCreate,
  "credentials get": credentialsGet,
  "credentials delete": credentialsDelete,
  "experiments create": experimentsCreate,
  "experiments list": experimentsList,
  "experiments get": experimentsGet,
  "experiments run": experimentsRun,
  "experiments report": experimentsReport,
  "experiments compare": experimentsCompare,
  "cells create": cellsCreate,
  "cells list": cellsList,
  "integrations lifecycle": integrationsLifecycle,
  "integrations requirements": integrationsRequirements,
  "integrations capability-nodes": integrationsCapabilityNodes,
  "integrations bindings": integrationsBindings,
  "integrations delivery": integrationsDelivery,
  "integrations verify-evidence": integrationsVerifyEvidence,
  "proof verify": proofVerify,
};

export function findProductHandler(
  command: string,
  subcommand: string | undefined,
): ((rest: string[]) => Promise<void>) | undefined {
  if (subcommand === undefined) return undefined;
  return HANDLERS[`${command} ${subcommand}`];
}

export function listProductCommands(): string[] {
  return Object.keys(HANDLERS).sort();
}
