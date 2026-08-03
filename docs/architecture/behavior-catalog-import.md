# Behavior Catalog Import (`tanren.behavior.v0` / `tanren.persona.v0`)

Tanren models a behavior as a BDD triple (`given` / `when` / `then`) owned by one
persona. A large class of real product catalogs is written in a different but
related shape — one Markdown file per behavior, with a stable id, an initiative,
an ordered persona list, provenance, authorship, cross-references, an `Intent`
paragraph and an `Observable outcomes` list. Those catalogs already declare
tanren's own schema namespace (`schema: tanren.behavior.v0`).

This document records the four modelling decisions behind importing such a
catalog **natively**, rather than asking authors to hand-rewrite every file
into Given/When/Then.

## The format

```markdown
---
schema: tanren.behavior.v0
id: B-0206
initiative: <free-form programme name>
title: <short first-person title>
personas: [<slug>, ...] # main beneficiary first
provenance: [...]
authors: [...]
related: [B-0249, B-0391]
---

## Intent

<one paragraph>

## Observable outcomes

- <outcome>

## Related

- B-0249
- B-0391
```

Frontmatter keys and body sections must appear in exactly that order; the `related`
frontmatter must equal the body list exactly; the id is `B-` plus four digits, is
immutable and sparse, and the filename begins with it. A sibling
`tanren.persona.v0` catalog keys personas by slug.

`tanren.behavior.v0` also has a written rule that **implementation status never
appears** in a behavior file. The importer enforces that structurally: the body's
`##` headings must equal `[Intent, Observable outcomes, Related]`, so an
`## Implementation status` section is rejected as a malformed document.

Two things the importer deliberately does **not** constrain: `initiative` and
`world`. A specific catalog may enumerate its own values in its own SCHEMA.md,
but baking one product's vocabulary into tanren would make the importer serve
exactly one catalog. The shape is fixed; the vocabulary is the catalog's.

An empty list section is written `- (none)` — a section may not be blank, because a
reviewer could not tell an empty list from an unfinished one. The parser
recognizes that placeholder explicitly rather than filtering it out silently, and
rejects it when it is mixed with real items.

## Decision 1 — Intent and Observable outcomes onto the BDD triple

| source                   | destination                         |
| ------------------------ | ----------------------------------- |
| `## Observable outcomes` | `behaviors."then"` (newline-joined) |
| `## Intent`              | `behaviors.description`             |
| `given`                  | `""` — **honest absence**           |
| `when`                   | `""` — **honest absence**           |

An "observable outcome" is defined in the format as _a result the persona can see,
do, or rely on_. That is what `then` means, so the mapping is real, not a
convenience.

`given` and `when` have **no honest source**. The format has no notion of a
precondition or a trigger. Writing "Given the persona is signed in, When they open
the dashboard" would put a sentence into a verification surface that no author
wrote and no reviewer approved — and behaviors are the unit Check and Audit
answerers report verdicts against, so a fabricated precondition becomes a
fabricated acceptance criterion. The codebase's stated posture on an absent design
contract is the same: the writer _"simply gets no design block — NEVER a fabricated
default"_ (`subtaskWriterPrompt.ts`). So the two columns are left empty.

**Rejected alternative: extend the BDD model to make `given`/`when` nullable.**
`behaviors.given`/`when` are `NOT NULL` and are read by the writer, the answerers,
the coverage surfaces and the revision substrate. Making them nullable would push a
new tri-state (`present` / `empty` / `null`) into every one of those readers to
carry information that is already carried, unambiguously, one join away: a row
whose `catalog_behaviors.schema_version` is `tanren.behavior.v0` came from a schema
that _has no given/when_. That is a stronger and cheaper signal than a NULL,
because it says **why** the value is absent.

The projection is explicitly **one-way and lossy**. `catalog_behaviors` — not the
BDD triple — is the authority for an imported behavior.

## Decision 2 — `tanren.behavior.v0` is a first-class stored shape

A behavior document carries a stable sparse identity (`B-0206`), an `initiative`,
provenance, authors, an **ordered** persona list and an **ordered** cross-reference
list. `behaviors` has room for a title, three BDD strings, a description and
exactly **one** `persona_id`.

Projecting on the way in would therefore:

- drop the catalog's identity, leaving nothing stable to key a re-import on;
- keep only the first of `personas: [member, org-pcp]`;
- orphan `related`, the catalog's own cross-reference graph;
- lose `initiative`, `provenance` and `authors` outright;
- make round-tripping back to Markdown impossible.

So the documents are stored whole, in four org-scoped tables
(`db/src/schemaCatalog.ts`, migration `0113_behavior_catalog_import`):

| table                        | holds                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `catalog_personas`           | one `tanren.persona.v0` document; PK `(org_id, project_id, slug)`; `persona_id` links the projected `personas` row          |
| `catalog_behaviors`          | one `tanren.behavior.v0` document; PK `(org_id, project_id, catalog_id)`; `behavior_id` links the projected `behaviors` row |
| `catalog_behavior_personas`  | the ordered persona list (`ordinal` 0 is the declared main beneficiary)                                                     |
| `catalog_behavior_relations` | the ordered `related` edges, as real rows                                                                                   |

`related` is rows rather than a jsonb blob so the cross-references keep referential
integrity (a dangling `B-####` is rejected by a foreign key) and are queryable in
both directions — "what links _to_ B-0249?" is a normal index scan. `ordinal`
preserves the declared order, which the format requires to equal the body list.

Every table enables **and forces** RLS with an `org_id = current_setting('app.current_org_id', true)`
policy carrying both `USING` and `WITH CHECK`, and every relationship crossing a
tenant-owned table uses a composite same-org foreign key. `personas` had a
single-column primary key and therefore no `(org_id, id)` unique for such a key to
reference; the migration adds `personas_org_id_unique` before creating it. A
single-column FK to `personas(id)` would have let an org-A catalog row point at
an org-B persona.

## Decision 3 — persona resolution is explicit and fails loudly

Behaviors reference personas by **slug**; tanren keys by `persona_id`. The mapping
is derived from data, not hand-maintained: importing the sibling
`tanren.persona.v0` catalog creates (or reuses) a tanren persona per slug and
records the pairing in `catalog_personas`. A behavior-only import resolves against
slugs already stored for that project.

An unresolvable slug is a **loud, coded failure** (`catalog_unknown_persona`) that
aborts the whole import; the behavior is never dropped and never imported with its
persona list quietly thinned. Two independent layers enforce it:

1. the importer refuses before writing anything, naming the behavior and the slug;
2. `catalog_behavior_personas_persona_fk` — a composite same-org foreign key onto
   `catalog_personas(org_id, project_id, slug)` — rejects the row at the database
   even if application code ever let one through.

`personas[0]` is the declared main beneficiary, so it owns the projected
`behaviors.persona_id`. The full ordered list survives in
`catalog_behavior_personas`.

## Decision 4 — idempotency is keyed on the stable `B-####`

The catalog's own id **is** the primary key, so a re-import is an upsert and a
duplicate id cannot become two rows. Each row also stores a `source_digest`
(sha256 of the document text), which lets a re-import report
`created` / `updated` / `unchanged` and skip untouched documents entirely.

A duplicate `B-####` _within one payload_ is a separate, loud failure
(`catalog_duplicate_id`) rather than a silent last-write-wins collapse — without
that check the upsert would happily merge two different files claiming one id.

The import is **one transaction**. A single unresolvable slug, dangling
cross-reference or duplicate id rolls the whole thing back: a partly applied
catalog is worse than no catalog.

Deletion is _not_ inferred. A behavior that disappears from the source is left in
place (the never-discard posture) — removing it is a deliberate act, not a side
effect of a smaller payload.

## Surfaces

```
POST /orgs/:orgId/projects/:projectId/catalog/import
     { documents: [{ path, text }], dryRun?: boolean }
GET  /orgs/:orgId/projects/:projectId/catalog/behaviors
GET  /orgs/:orgId/projects/:projectId/catalog/behaviors/:catalogId
```

The client posts the documents verbatim; the server owns the one parser, so no
client has to reimplement the format. `dryRun` parses, validates and resolves
everything, then rolls the transaction back — the summary tells you what _would_
happen before anything is written.

```sh
tanren catalog import --org-id <o> --project-id <p> --dir <d> [--dir <d2>] [--dry-run]
tanren catalog list   --org-id <o> --project-id <p>
tanren catalog get    --org-id <o> --project-id <p> --catalog-id B-0206
```

`--dir` is repeatable so behaviors and personas go up in **one** atomic import —
otherwise a behavior whose persona lives in the sibling directory would fail
resolution. Files with no frontmatter (a directory's `README.md` / `SCHEMA.md`) are
skipped **and named in the output**; a file that declares an unrecognized `schema:`
is a loud error, not a skip.

## Residual gaps

- `catalog_behaviors.behavior_id` uses a single-column foreign key to
  `behaviors(id)`. `behaviors` has no `org_id` of its own — it is tenanted through
  its persona — so there is no same-org composite to take. The importer always
  creates that row itself, inside the same org-scoped transaction, so it cannot
  produce a cross-org link; giving `behaviors` its own `org_id` is a larger,
  separate change.
- The import does **not** mint `behavior_revisions`. Those are append-only and
  belong to the runtime-verification substrate; `source_digest` is the natural hook
  for a future path that mints a revision only when a document actually changes.
- Round-tripping catalog rows _back_ to Markdown is not implemented. Everything
  needed for it is stored (ordered lists, section bodies, digests), but no writer
  exists and no test asserts byte-equality of a regenerated file.
