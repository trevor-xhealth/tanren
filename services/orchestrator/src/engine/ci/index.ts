// Single import surface for the repo-sourced tiered CI config. Tanren's native
// in-loop gate reads this one contract and runs the declared steps over SSH —
// it is the sole CI authority (Action-less delivery). Contract + parser only —
// no execution lives here.
export {
  CiBootstrap,
  CiConfigV1,
  CiDeploy,
  CiSetup,
  CiStep,
  CiStepEvidence,
  CiTiers,
  CiUpgrade,
  CiWhen,
  CiWhenPolicy,
  SUPPORTED_CI_CONFIG_VERSIONS,
  evidenceForStep,
} from "./schema.js";

export {
  CiConfigValidationError,
  CiYamlParseError,
  DEFAULT_CI_CONFIG,
  JUNIT_REPORT_PATH,
  bootstrapCommand,
  deployCommand,
  junitReportFor,
  resolveCiConfig,
  setupCommand,
  stepsFor,
  tiersFor,
  upgradeCommand,
} from "./resolve.js";

export { parseYaml } from "./yaml.js";
export type { YamlValue } from "./yaml.js";
