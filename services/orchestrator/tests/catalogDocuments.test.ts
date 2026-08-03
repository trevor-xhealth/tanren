// The `tanren.behavior.v0` / `tanren.persona.v0` parser, driven directly. Every
// rejection here is a case where a lossy or ambiguous import would otherwise
// have gone through quietly.
import { describe, expect, it } from "vitest";
import { CatalogImportError, catalogDigest, parseCatalogDocuments } from "../src/engine/catalog/documents.js";

function behavior(overrides: { frontmatter?: string; body?: string; path?: string } = {}) {
  const frontmatter =
    overrides.frontmatter ??
    `schema: tanren.behavior.v0
id: B-0042
initiative: steady-state
title: I see the current queue depth
personas: [operator, auditor]
provenance: [SRC-0007]
authors: [Ada]
related: [B-0043]`;
  const body =
    overrides.body ??
    `## Intent

I need to see the queue depth so the shift ends without a surprise.

## Observable outcomes

- I see the queue depth as of a stated instant.
- I can tell whether the figure is stale.

## Related

- B-0043`;
  return {
    path: overrides.path ?? "docs/behaviors/B-0042-i-see-the-current-queue-depth.md",
    text: `---\n${frontmatter}\n---\n\n${body}\n`,
  };
}

const PERSONA_BODY = [
  "Core job",
  "Motivations",
  "Concerns",
  "Trust requirements",
  "Authority and influence",
  "Distinct from",
  "Language they use",
  "Notes",
]
  .map((heading) => `## ${heading}\n\n- ${heading} content.`)
  .join("\n\n");

function persona(overrides: { frontmatter?: string; path?: string } = {}) {
  const frontmatter =
    overrides.frontmatter ??
    `schema: tanren.persona.v0
slug: operator
name: "Line operator"
world: floor
aliases: [line-op]`;
  return { path: overrides.path ?? "docs/personas/operator.md", text: `---\n${frontmatter}\n---\n\n${PERSONA_BODY}\n` };
}

describe("tanren.behavior.v0 / tanren.persona.v0 document parsing", () => {
  it("keeps every field, in order, and digests the source", () => {
    const parsed = parseCatalogDocuments([behavior(), persona()]);
    expect(parsed.behaviors).toHaveLength(1);
    expect(parsed.behaviors[0]).toMatchObject({
      catalogId: "B-0042",
      initiative: "steady-state",
      title: "I see the current queue depth",
      personaSlugs: ["operator", "auditor"],
      provenance: ["SRC-0007"],
      authors: ["Ada"],
      related: ["B-0043"],
      outcomes: ["I see the queue depth as of a stated instant.", "I can tell whether the figure is stale."],
    });
    expect(parsed.behaviors[0]?.intent).toContain("without a surprise");
    expect(parsed.behaviors[0]?.sourceDigest).toBe(catalogDigest(behavior().text));
    expect(parsed.personas[0]).toMatchObject({
      slug: "operator",
      name: "Line operator",
      world: "floor",
      aliases: ["line-op"],
    });
    expect(parsed.personas[0]?.sections.map((section) => section.heading)).toEqual([
      "Core job",
      "Motivations",
      "Concerns",
      "Trust requirements",
      "Authority and influence",
      "Distinct from",
      "Language they use",
      "Notes",
    ]);
  });

  it("accepts the `- (none)` empty-list placeholder for an empty related list", () => {
    const parsed = parseCatalogDocuments([
      behavior({
        frontmatter: `schema: tanren.behavior.v0
id: B-0042
initiative: steady-state
title: I see the current queue depth
personas: [operator]
provenance: []
authors: []
related: []`,
        body: `## Intent

Intent.

## Observable outcomes

- An outcome.

## Related

- (none)`,
      }),
    ]);
    expect(parsed.behaviors[0]?.related).toEqual([]);
  });

  it("rejects a frontmatter key order that does not match the schema", () => {
    expect(() =>
      parseCatalogDocuments([
        behavior({
          frontmatter: `schema: tanren.behavior.v0
initiative: steady-state
id: B-0042
title: t
personas: [operator]
provenance: []
authors: []
related: []`,
          body: "## Intent\n\ni\n\n## Observable outcomes\n\n- o\n\n## Related\n\n- (none)",
        }),
      ]),
    ).toThrow(/frontmatter keys must be/u);
  });

  it("rejects a filename that disagrees with the immutable id", () => {
    expect(() => parseCatalogDocuments([behavior({ path: "docs/behaviors/B-0099-wrong.md" })])).toThrow(
      /filename must begin with B-0042-/u,
    );
  });

  it("rejects a related list whose body does not match the frontmatter", () => {
    expect(() =>
      parseCatalogDocuments([
        behavior({
          body: `## Intent

i

## Observable outcomes

- o

## Related

- B-0044`,
        }),
      ]),
    ).toThrow(/does not match body/u);
  });

  it("rejects an implementation-status section (any section the schema does not declare)", () => {
    expect(() =>
      parseCatalogDocuments([
        behavior({
          body: `## Intent

i

## Observable outcomes

- o

## Related

- B-0043

## Implementation status

- shipped`,
        }),
      ]),
    ).toThrow(/body sections must be exactly/u);
  });

  it("rejects prose smuggled into a list section rather than dropping it", () => {
    expect(() =>
      parseCatalogDocuments([
        behavior({
          body: `## Intent

i

## Observable outcomes

- o
and a trailing sentence nobody would notice

## Related

- B-0043`,
        }),
      ]),
    ).toThrow(/must contain only "- " list items/u);
  });

  it("rejects an unrecognized schema instead of skipping the document", () => {
    const bad = { path: "docs/behaviors/B-0042-x.md", text: "---\nschema: tanren.behavior.v1\n---\n\n## Intent\n" };
    expect(() => parseCatalogDocuments([bad])).toThrow(CatalogImportError);
    expect(() => parseCatalogDocuments([bad])).toThrow(/unrecognized schema tanren.behavior.v1/u);
  });

  it("rejects a persona whose filename disagrees with its slug", () => {
    expect(() => parseCatalogDocuments([persona({ path: "docs/personas/line-operator.md" })])).toThrow(
      /filename must be operator.md/u,
    );
  });

  it("does not constrain the catalog's own initiative or world vocabulary", () => {
    const parsed = parseCatalogDocuments([
      behavior({
        frontmatter: `schema: tanren.behavior.v0
id: B-0042
initiative: some-other-programme
title: t
personas: [operator]
provenance: []
authors: []
related: []`,
        body: "## Intent\n\ni\n\n## Observable outcomes\n\n- o\n\n## Related\n\n- (none)",
      }),
      persona({
        frontmatter: `schema: tanren.persona.v0
slug: operator
name: "Line operator"
world: an-entirely-different-world
aliases: []`,
      }),
    ]);
    expect(parsed.behaviors[0]?.initiative).toBe("some-other-programme");
    expect(parsed.personas[0]?.world).toBe("an-entirely-different-world");
  });
});
