#!/usr/bin/env node

import { CliLoginIncomplete, deleteAuth, login, readAuth, writeAuth } from "./auth/index.js";
import { findProductHandler, listProductCommands } from "./commands/dispatch.js";
import { jsonRequest, orchestratorUrl, request } from "./httpClient.js";
import { parseJsonObject } from "./json.js";

export { jsonRequest, request };

const dashboardUrl = process.env["TANREN_DASHBOARD_URL"] ?? "http://localhost:3000";

export async function authLoginCommand(argv: string[]) {
  const args = parseArgs(argv);
  const token = optional(args, "token");
  try {
    const result = await login({
      orchestratorUrl,
      token,
      name: optional(args, "name"),
      onAuthorizeUrl: (url) => console.log(`Open this URL in your browser to sign in:\n  ${url}`),
    });
    console.log(JSON.stringify({ ok: true, orchestratorUrl: result.auth.orchestratorUrl }, null, 2));
  } catch (error) {
    if (error instanceof CliLoginIncomplete) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }
}

export async function authStatusCommand() {
  const auth = await readAuth();
  if (auth === undefined) {
    console.log(JSON.stringify({ ok: false, reason: "no_auth_file" }, null, 2));
    return;
  }
  const tokenPrefix = auth.token.slice(0, 8);
  console.log(
    JSON.stringify({ ok: true, orchestratorUrl: auth.orchestratorUrl, tokenPrefix, name: auth.name ?? null }, null, 2),
  );
}

export async function authLogoutCommand() {
  await deleteAuth();
  console.log(JSON.stringify({ ok: true }, null, 2));
}

export async function authPersistTokenCommand(argv: string[]) {
  const args = parseArgs(argv);
  const token = required(args, "token");
  await writeAuth({
    orchestratorUrl,
    token,
    name: optional(args, "name") ?? "cli",
    createdAt: new Date().toISOString(),
  });
  console.log(JSON.stringify({ ok: true }, null, 2));
}

export async function doctor() {
  const health = await request("/healthz");
  console.log(JSON.stringify(health, null, 2));
}

export async function status(runId: string | undefined) {
  if (!runId) {
    throw new Error("usage: tanren status <run_id>");
  }
  const run = await request(`/runs/${runId}`);
  console.log(JSON.stringify(run, null, 2));
}

export async function createProjectCommand(argv: string[]) {
  const args = parseArgs(argv);
  const configJson = optional(args, "config-json");
  const project = await jsonRequest("/projects", {
    name: required(args, "name"),
    repoUrl: required(args, "repo-url"),
    defaultBranch: optional(args, "default-branch"),
    runnerImage: optional(args, "runner-image"),
    allocator: optional(args, "allocator"),
    config: configJson === undefined ? undefined : parseJsonObject(configJson, "config-json"),
  });
  console.log(JSON.stringify(project, null, 2));
}

export async function createSpecCommand(argv: string[]) {
  const args = parseArgs(argv);
  const spec = await jsonRequest("/specs", {
    projectId: required(args, "project-id"),
    title: required(args, "title"),
    description: required(args, "description"),
    acceptanceCriteria: requiredMany(args, "acceptance"),
    dependsOn: optionalMany(args, "depends-on"),
  });
  console.log(JSON.stringify(spec, null, 2));
}

export async function runSpecCommand(argv: string[]) {
  const args = parseArgs(argv);
  const specId = optional(args, "spec-id") ?? args._[0];
  if (specId === undefined) {
    throw new Error("usage: tanren spec run --spec-id <spec_id>");
  }
  const run = await jsonRequest(`/specs/${specId}/runs`, {
    trigger: optional(args, "trigger") ?? "cli",
    branch: optional(args, "branch"),
  });
  console.log(JSON.stringify(run, null, 2));
}

export async function createDraftPrCommand(argv: string[]) {
  const args = parseArgs(argv);
  const runId = optional(args, "run-id") ?? args._[0];
  if (runId === undefined) {
    throw new Error("usage: tanren run draft-pr --run-id <run_id>");
  }
  const draftPr = await jsonRequest(`/runs/${runId}/github/draft-pr`, {
    githubCredentialRef: optional(args, "github-credential-ref"),
    workspacePath: optional(args, "workspace-path"),
    title: optional(args, "title"),
    body: optional(args, "body"),
  });
  console.log(JSON.stringify(draftPr, null, 2));
}

export async function pollCiCommand(argv: string[]) {
  const args = parseArgs(argv);
  const runId = optional(args, "run-id") ?? args._[0];
  if (runId === undefined) {
    throw new Error("usage: tanren run poll-ci --run-id <run_id>");
  }
  const ci = await jsonRequest(`/runs/${runId}/ci/poll`, {
    githubCredentialRef: optional(args, "github-credential-ref"),
  });
  console.log(JSON.stringify(ci, null, 2));
}

export function usage() {
  console.log(`tanren <command>

Commands:
  auth login         Start CLI sign-in (use --token <raw> after browser flow)
  auth status        Print stored auth metadata (never the token)
  auth logout        Remove stored CLI auth
  doctor             Check orchestrator, Postgres, and Vault connectivity
  project create     Create a persisted project contract
  run draft-pr       Push a runner workspace branch and open/reuse a draft PR
  run poll-ci        Poll and persist pull request CI status for a run
  spec create        Create a persisted spec contract
  spec run           Create a queued run from a persisted spec
  status <run_id>    Print persisted run state
  catalog import     Import a tanren.behavior.v0 / tanren.persona.v0 catalogue
  dashboard          Print the dashboard URL
  version            Print CLI version

P2A-0013 product API (see docs/operator-guide/cli.md):
${listProductCommands()
  .map((line) => `  tanren ${line}`)
  .join("\n")}
`);
}

export async function main(argv: string[]) {
  const [command, subcommand, ...rest] = argv;
  // product API commands (orgs/projects/specs/personas/behaviors/milestones/credentials)
  if (command !== undefined) {
    const handler = findProductHandler(command, subcommand);
    if (handler !== undefined) {
      await handler(rest);
      return;
    }
  }
  switch (command) {
    case "auth":
      if (subcommand === "login") {
        await authLoginCommand(rest);
        break;
      }
      if (subcommand === "status") {
        await authStatusCommand();
        break;
      }
      if (subcommand === "logout") {
        await authLogoutCommand();
        break;
      }
      if (subcommand === "set-token") {
        await authPersistTokenCommand(rest);
        break;
      }
      throw new Error("usage: tanren auth <login|status|logout|set-token>");
    case "doctor":
      await doctor();
      break;
    case "project":
      if (subcommand !== "create") {
        throw new Error("usage: tanren project create --name <name> --repo-url <url>");
      }
      await createProjectCommand(rest);
      break;
    case "spec":
      if (subcommand === "create") {
        await createSpecCommand(rest);
        break;
      }
      if (subcommand === "run") {
        await runSpecCommand(rest);
        break;
      }
      throw new Error("usage: tanren spec <create|run>");
    case "run":
      if (subcommand === "draft-pr") {
        await createDraftPrCommand(rest);
        break;
      }
      if (subcommand === "poll-ci") {
        await pollCiCommand(rest);
        break;
      }
      throw new Error("usage: tanren run <draft-pr|poll-ci> --run-id <run_id>");
    case "status":
      await status(subcommand);
      break;
    case "dashboard":
      console.log(dashboardUrl);
      break;
    case "version":
      console.log("0.0.0");
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

type ParsedArgs = Record<string, string | string[] | undefined> & { _: string[] };

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    addArg(args, key, value);
    index += 1;
  }
  return args;
}

function addArg(args: ParsedArgs, key: string, value: string): void {
  const existing = args[key];
  if (existing === undefined) {
    args[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    args[key] = [existing, value];
  }
}

function required(args: ParsedArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new TypeError(`missing --${key}`);
  }
  return value;
}

function optional(args: ParsedArgs, key: string): string | undefined {
  const value = args[key];
  if (Array.isArray(value)) {
    throw new TypeError(`--${key} can only be provided once`);
  }
  return value;
}

function requiredMany(args: ParsedArgs, key: string): string[] {
  const values = optionalMany(args, key);
  if (values.length === 0) {
    throw new Error(`missing --${key}`);
  }
  return values;
}

function optionalMany(args: ParsedArgs, key: string): string[] {
  const value = args[key];
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
