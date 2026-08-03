// Parser for `tanren.behavior.v0` / `tanren.persona.v0` catalog documents.
//
// The format is a STRICT, constrained subset of Markdown: frontmatter keys in a
// fixed order, inline `[a, b]` arrays only, body `##` sections exactly equal to
// the schema's section list, and a `related` frontmatter list that must equal the
// body's `## Related` list. This parser enforces all of it and REFUSES anything it
// cannot represent losslessly — a line inside a list section that is not a list
// item is an error, not something to drop quietly, because the import is meant to
// round-trip back to Markdown.
//
// DOMAIN-FREE BY CONSTRUCTION. The schema's *shape* is fixed; its *vocabularies*
// are not. `initiative` and `world` are free-form strings here even though a given
// catalog may enumerate them in its own SCHEMA.md — baking one product's values
// into tanren would make the importer serve exactly one catalog.

import { createHash } from "node:crypto";

export const CATALOG_BEHAVIOR_SCHEMA = "tanren.behavior.v0";
export const CATALOG_PERSONA_SCHEMA = "tanren.persona.v0";

const BEHAVIOR_KEYS = ["schema", "id", "initiative", "title", "personas", "provenance", "authors", "related"] as const;
const BEHAVIOR_SECTIONS = ["Intent", "Observable outcomes", "Related"] as const;
const PERSONA_KEYS = ["schema", "slug", "name", "world", "aliases"] as const;
const PERSONA_SECTIONS = [
  "Core job",
  "Motivations",
  "Concerns",
  "Trust requirements",
  "Authority and influence",
  "Distinct from",
  "Language they use",
  "Notes",
] as const;

const CATALOG_ID = /^B-\d{4}$/u;
const PERSONA_SLUG = /^[a-z][a-z0-9-]*$/u;

/** A loud, coded failure. Every rejection path in the importer raises this. */
export class CatalogImportError extends Error {
  readonly code: string;
  readonly sourcePath: string | undefined;

  constructor(code: string, message: string, sourcePath?: string) {
    super(sourcePath === undefined ? message : `${sourcePath}: ${message}`);
    this.name = "CatalogImportError";
    this.code = code;
    this.sourcePath = sourcePath;
  }
}

export interface CatalogSourceDocument {
  readonly path: string;
  readonly text: string;
}

export interface CatalogSection {
  readonly heading: string;
  readonly body: string;
}

export interface CatalogBehaviorDocument {
  readonly schemaVersion: typeof CATALOG_BEHAVIOR_SCHEMA;
  readonly catalogId: string;
  readonly initiative: string;
  readonly title: string;
  readonly personaSlugs: readonly string[];
  readonly provenance: readonly string[];
  readonly authors: readonly string[];
  readonly related: readonly string[];
  readonly intent: string;
  readonly outcomes: readonly string[];
  readonly sourcePath: string;
  readonly sourceDigest: string;
}

export interface CatalogPersonaDocument {
  readonly schemaVersion: typeof CATALOG_PERSONA_SCHEMA;
  readonly slug: string;
  readonly name: string;
  readonly world: string;
  readonly aliases: readonly string[];
  readonly sections: readonly CatalogSection[];
  readonly sourcePath: string;
  readonly sourceDigest: string;
}

export interface CatalogDocumentSet {
  readonly behaviors: readonly CatalogBehaviorDocument[];
  readonly personas: readonly CatalogPersonaDocument[];
}

export function catalogDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

interface ParsedMarkdown {
  readonly keyOrder: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly sections: readonly CatalogSection[];
}

function parseMarkdown(document: CatalogSourceDocument): ParsedMarkdown {
  const match = /^---\n(?<front>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/u.exec(document.text);
  if (match?.groups === undefined) {
    throw new CatalogImportError("catalog_malformed_document", "missing frontmatter", document.path);
  }
  const keyOrder: string[] = [];
  const values: Record<string, string> = {};
  for (const line of match.groups["front"]?.split("\n") ?? []) {
    const field = /^(?<key>[a-z_]+):\s*(?<value>.*)$/u.exec(line);
    if (field?.groups === undefined) {
      throw new CatalogImportError("catalog_malformed_document", `invalid frontmatter line: ${line}`, document.path);
    }
    const key = field.groups["key"] ?? "";
    keyOrder.push(key);
    values[key] = field.groups["value"] ?? "";
  }
  return { keyOrder, values, sections: splitSections(match.groups["body"] ?? "") };
}

function splitSections(body: string): CatalogSection[] {
  const sections: CatalogSection[] = [];
  let heading: string | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (heading !== undefined) sections.push({ heading, body: lines.join("\n").trim() });
  };
  for (const line of body.split("\n")) {
    const found = /^##\s+(?<heading>.+?)\s*$/u.exec(line);
    if (found?.groups === undefined) {
      lines.push(line);
      continue;
    }
    flush();
    heading = found.groups["heading"] ?? "";
    lines = [];
  }
  flush();
  return sections;
}

function assertKeyOrder(parsed: ParsedMarkdown, expected: readonly string[], path: string): void {
  if (parsed.keyOrder.join(",") !== expected.join(",")) {
    throw new CatalogImportError(
      "catalog_malformed_document",
      `frontmatter keys must be [${expected.join(", ")}]; got [${parsed.keyOrder.join(", ")}]`,
      path,
    );
  }
}

function assertSections(parsed: ParsedMarkdown, expected: readonly string[], path: string): void {
  const actual = parsed.sections.map((section) => section.heading);
  if (actual.join("|") !== expected.join("|")) {
    throw new CatalogImportError(
      "catalog_malformed_document",
      `body sections must be exactly [${expected.join(", ")}]; got [${actual.join(", ")}]`,
      path,
    );
  }
}

function inlineArray(raw: string, key: string, path: string): string[] {
  if (!raw.startsWith("[") || !raw.endsWith("]")) {
    throw new CatalogImportError("catalog_malformed_document", `${key} must be an inline array`, path);
  }
  return raw
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim().replaceAll(/^["']|["']$/gu, ""))
    .filter((item) => item.length > 0);
}

// The catalog convention for "this list is deliberately empty". A section may
// not be blank (a reviewer could not tell an empty list from an unfinished one),
// so an empty list is written as a single `- (none)` item. It is recognized HERE
// rather than filtered out silently, and a writer regenerates it from an empty
// list — so the round trip is exact.
const EMPTY_LIST_PLACEHOLDER = "(none)";

/** Every non-blank line of a list section must be a `- ` item — nothing is dropped. */
function listItems(section: CatalogSection, path: string): string[] {
  const items: string[] = [];
  for (const line of section.body.split("\n")) {
    if (line.trim().length === 0) continue;
    if (!line.startsWith("- ")) {
      throw new CatalogImportError(
        "catalog_malformed_document",
        `## ${section.heading} must contain only "- " list items; found: ${line.trim()}`,
        path,
      );
    }
    items.push(line.slice(2).trim());
  }
  if (items.length === 1 && items[0] === EMPTY_LIST_PLACEHOLDER) return [];
  if (items.includes(EMPTY_LIST_PLACEHOLDER)) {
    throw new CatalogImportError(
      "catalog_malformed_document",
      `## ${section.heading} mixes the ${EMPTY_LIST_PLACEHOLDER} empty-list placeholder with real items`,
      path,
    );
  }
  return items;
}

function sectionAt(parsed: ParsedMarkdown, index: number): CatalogSection {
  return parsed.sections[index] ?? { heading: "", body: "" };
}

function unquote(raw: string): string {
  return raw.replaceAll(/^["']|["']$/gu, "");
}

export function parseBehaviorDocument(document: CatalogSourceDocument): CatalogBehaviorDocument {
  const parsed = parseMarkdown(document);
  assertKeyOrder(parsed, BEHAVIOR_KEYS, document.path);
  assertSections(parsed, BEHAVIOR_SECTIONS, document.path);
  const catalogId = parsed.values["id"] ?? "";
  if (!CATALOG_ID.test(catalogId)) {
    throw new CatalogImportError("catalog_malformed_document", `invalid behavior id ${catalogId}`, document.path);
  }
  const fileName = document.path.split("/").at(-1) ?? "";
  if (!fileName.startsWith(`${catalogId}-`)) {
    throw new CatalogImportError("catalog_malformed_document", `filename must begin with ${catalogId}-`, document.path);
  }
  const related = inlineArray(parsed.values["related"] ?? "", "related", document.path);
  const bodyRelated = listItems(sectionAt(parsed, 2), document.path);
  if (related.join(",") !== bodyRelated.join(",")) {
    throw new CatalogImportError(
      "catalog_malformed_document",
      `related frontmatter [${related.join(", ")}] does not match body [${bodyRelated.join(", ")}]`,
      document.path,
    );
  }
  const personaSlugs = inlineArray(parsed.values["personas"] ?? "", "personas", document.path);
  if (personaSlugs.length === 0) {
    throw new CatalogImportError("catalog_malformed_document", "personas must be a non-empty array", document.path);
  }
  const outcomes = listItems(sectionAt(parsed, 1), document.path);
  if (outcomes.length === 0) {
    throw new CatalogImportError("catalog_malformed_document", "## Observable outcomes is empty", document.path);
  }
  return {
    schemaVersion: requireSchema(parsed, CATALOG_BEHAVIOR_SCHEMA, document.path),
    catalogId,
    initiative: requireValue(parsed, "initiative", document.path),
    title: requireValue(parsed, "title", document.path),
    personaSlugs,
    provenance: inlineArray(parsed.values["provenance"] ?? "", "provenance", document.path),
    authors: inlineArray(parsed.values["authors"] ?? "", "authors", document.path),
    related,
    intent: sectionAt(parsed, 0).body,
    outcomes,
    sourcePath: document.path,
    sourceDigest: catalogDigest(document.text),
  };
}

export function parsePersonaDocument(document: CatalogSourceDocument): CatalogPersonaDocument {
  const parsed = parseMarkdown(document);
  assertKeyOrder(parsed, PERSONA_KEYS, document.path);
  assertSections(parsed, PERSONA_SECTIONS, document.path);
  const slug = parsed.values["slug"] ?? "";
  if (!PERSONA_SLUG.test(slug)) {
    throw new CatalogImportError("catalog_malformed_document", `invalid persona slug ${slug}`, document.path);
  }
  const fileName = (document.path.split("/").at(-1) ?? "").replace(/\.md$/u, "");
  if (fileName !== slug) {
    throw new CatalogImportError("catalog_malformed_document", `filename must be ${slug}.md`, document.path);
  }
  return {
    schemaVersion: requireSchema(parsed, CATALOG_PERSONA_SCHEMA, document.path),
    slug,
    name: unquote(requireValue(parsed, "name", document.path)),
    world: requireValue(parsed, "world", document.path),
    aliases: inlineArray(parsed.values["aliases"] ?? "", "aliases", document.path),
    sections: parsed.sections,
    sourcePath: document.path,
    sourceDigest: catalogDigest(document.text),
  };
}

function requireValue(parsed: ParsedMarkdown, key: string, path: string): string {
  const value = (parsed.values[key] ?? "").trim();
  if (value.length === 0) {
    throw new CatalogImportError("catalog_malformed_document", `${key} must not be blank`, path);
  }
  return value;
}

function requireSchema<T extends string>(parsed: ParsedMarkdown, expected: T, path: string): T {
  if ((parsed.values["schema"] ?? "").trim() !== expected) {
    throw new CatalogImportError("catalog_unknown_schema", `schema must be ${expected}`, path);
  }
  return expected;
}

/**
 * Split a mixed document set by its declared `schema`, then parse each half.
 * A document declaring neither known schema is REJECTED — never skipped, so a
 * typo in `schema:` can't silently shrink an import.
 */
export function parseCatalogDocuments(documents: readonly CatalogSourceDocument[]): CatalogDocumentSet {
  const behaviors: CatalogBehaviorDocument[] = [];
  const personas: CatalogPersonaDocument[] = [];
  for (const document of documents) {
    const declared = /^---\n(?:.*\n)*?schema:\s*(?<schema>\S+)\s*$/mu.exec(document.text)?.groups?.["schema"];
    if (declared === CATALOG_BEHAVIOR_SCHEMA) {
      behaviors.push(parseBehaviorDocument(document));
    } else if (declared === CATALOG_PERSONA_SCHEMA) {
      personas.push(parsePersonaDocument(document));
    } else {
      throw new CatalogImportError(
        "catalog_unknown_schema",
        `unrecognized schema ${declared ?? "(absent)"}; expected ${CATALOG_BEHAVIOR_SCHEMA} or ${CATALOG_PERSONA_SCHEMA}`,
        document.path,
      );
    }
  }
  return { behaviors, personas };
}
