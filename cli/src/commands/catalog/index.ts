// `tanren catalog ...` — import and read a `tanren.behavior.v0` /
// `tanren.persona.v0` catalog.
//
// The CLI reads the files and posts them verbatim; the orchestrator owns the one
// parser. Ergonomics that matter for a 700-file catalog:
//   * `--dir` is repeatable, so behaviors and personas go up in ONE atomic import
//     (a behavior whose persona lives in the other directory would otherwise fail);
//   * `--dry-run` parses and validates server-side and rolls the transaction back,
//     so you can see the summary before writing anything;
//   * files WITHOUT frontmatter (a directory's README.md / SCHEMA.md) are skipped
//     and NAMED in the output — never silently dropped. A file that declares an
//     unrecognized `schema:` is a loud server-side error, not a skip.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { jsonRequest, request } from "../../httpClient.js";
import { jsonOutput, optional, parseArgs, type ParsedArgs, required } from "../args.js";

interface CatalogDocument {
  path: string;
  text: string;
}

function directories(args: ParsedArgs): string[] {
  const value = args["dir"];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  throw new TypeError("missing --dir (repeat it to import several directories in one transaction)");
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

async function collectDocuments(dirs: readonly string[]): Promise<{ documents: CatalogDocument[]; skipped: string[] }> {
  const documents: CatalogDocument[] = [];
  const skipped: string[] = [];
  for (const directory of dirs) {
    for (const file of await markdownFiles(directory)) {
      const text = await readFile(file, "utf8");
      if (text.startsWith("---\n")) {
        documents.push({ path: file, text });
      } else {
        skipped.push(file);
      }
    }
  }
  return { documents, skipped };
}

export async function catalogImport(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const dryRun = optional(args, "dry-run") === "true";
  const { documents, skipped } = await collectDocuments(directories(args));
  if (documents.length === 0) {
    throw new Error("no catalog documents found (a catalog document starts with a `---` frontmatter block)");
  }
  const summary = await jsonRequest(
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/catalog/import`,
    { documents, dryRun },
  );
  jsonOutput(args, { summary, documentCount: documents.length, skipped });
}

export async function catalogList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  jsonOutput(
    args,
    await request(`/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/catalog/behaviors`),
  );
}

export async function catalogGet(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const catalogId = required(args, "catalog-id");
  jsonOutput(
    args,
    await request(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/catalog/behaviors/${encodeURIComponent(catalogId)}`,
    ),
  );
}
