# Product Entities

Tanren's product information model is the persistent shape behind the hi-fi
vision. The DAG canvas, the spec-creation forms, and the Forge interview all
read these tables; they do not migrate them.

## Vocabulary

The hierarchy is **Persona → Behavior → Spec**, with Specs grouped by
**Milestone** and connected by directed **Spec Dependency** edges.

- **Persona** — a role on a project (or shared across projects in an org).
  Examples: "Sales Manager", "Line Worker". Authoring lives in the
  spec-creation forms and the Forge interview.
- **Behavior** — owned by a persona. A BDD `Given / When / Then` scenario
  plus a free-form description. The unit of verification: Check and Audit
  Answerers reference behavior ids when reporting a verdict.
- **Milestone** — project-scoped, ordered, with optional ETA. The hi-fi's
  velocity card cites ETA against milestones.
- **Spec ↔ Behavior** — many-to-many. A spec demonstrates one or more
  behaviors.
- **Spec ↔ Milestone** — many-to-one. A spec belongs to a single
  milestone. The schema stores the link as a join table to keep the door
  open for future many-to-many evolution, but a unique index on `spec_id`
  enforces the current product rule.
- **Spec Dependency** — directed edge `from -> to`. `from` depends on
  `to`; `to` must complete first. Edges form a DAG; cycles are rejected
  at insert time.

## Tables

All ids are `text` for parity with the existing `projects` and `specs`
schema. New ids minted by the stores are prefixed (`persona_<uuid>`,
`behavior_<uuid>`, `milestone_<uuid>`), but inbound ids only need to be
stable opaque strings.

| Table               | Purpose                                            | Key constraints                                                                                                         |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------- | ---- | ---------- |
| `personas`          | org- or project-scoped role                        | `personas_scope_check`, `personas_scope_project_check` (scope=`org` → `project_id IS NULL`; scope=`project` → not null) |
| `behaviors`         | BDD scenario owned by persona                      | FK to `personas`; indexed on `persona_id`                                                                               |
| `milestones`        | project-scoped, ordered, optional ETA, status enum | `UNIQUE (project_id, label)`, `UNIQUE (project_id, order_index)`, status `planned                                       | in_flight | done | abandoned` |
| `spec_behaviors`    | spec ↔ behavior join                               | composite PK; indexed on `behavior_id`                                                                                  |
| `spec_milestones`   | spec → milestone join                              | composite PK plus `UNIQUE (spec_id)` enforcing one-milestone-per-spec                                                   |
| `spec_dependencies` | directed edges with no self-loop                   | composite PK, `from <> to` CHECK; cycle detection in application code                                                   |

## Imported catalogs — `tanren.behavior.v0` / `tanren.persona.v0`

A behavior catalog authored as Markdown (stable `B-####` ids, an initiative, an
ordered persona list, provenance, authors, cross-references, `Intent` and
`Observable outcomes`) is stored **whole** in four org-scoped tables rather than
projected onto the BDD triple: `catalog_personas`, `catalog_behaviors`,
`catalog_behavior_personas` and `catalog_behavior_relations`
(`db/src/schemaCatalog.ts`).

The `personas` / `behaviors` rows above remain the graph the rest of the engine
reads; for an imported behavior they are a declared, **one-way** projection —
observable outcomes become `then`, intent becomes `description`, and `given`/`when`
stay empty because the source schema has no such concept. `catalog_behaviors` is
the authority. Full reasoning: `docs/architecture/behavior-catalog-import.md`.

## Design Contract — the design-intent layer over the graph

The **`DesignContract`** (`design_contracts` table, `db/src/schemaDesign.ts`;
schema `services/orchestrator/src/engine/design/designContract.ts`) is the
first-class, **versioned**, org-scoped, project-anchored design-intent entity that
sits over the Persona → Behavior graph. It is the durable design artifact the build
loop authors, injects into the writer, and verifies with a design oracle (the
no-handoff moat — see `autonomy-engine.md` §1e). It supersedes the decorative
80-char `designDna` interview hint, which never reached the writer.

It is **domain-general by construction** — Tanren builds anything, so the contract
shape adapts to the project domain rather than encoding a web design system:

- a universal **core** every domain shares: `identity` (the one-line design
  identity), `intent` (the north-star vision the writer builds toward and the oracle
  verifies against), `principles`, and `constraints`;
- a descriptive **`domain`** label ("saas-web", "mobile-game", "novel-translation")
  Tanren never branches on (the same posture as the lifecycle's `stack` label),
  mirrored into its own column for filtering without parsing the jsonb;
- a domain-declared **`dimensions`** set whose membership the project/domain chooses
  (a SaaS app's `tokens/components/layout`; a game's `art-direction/ui/game-feel`; a
  novel's `typography/voice/cover`) — each dimension carries its own `intent` and
  optional persona scoping; and
- **the moat — first-class links into this entity graph**: `personaRefs` and
  `behaviorRefs` bind the contract to the project's _actual_ `personas` and
  `behaviors` rows. Design is resolved **per-persona** (no "assume default admin"),
  and the bound behaviors are **design acceptance criteria** the design agent must
  cover and the oracle verifies coverage of — one entity graph, no
  designer↔implementor disconnect.

| Table              | Purpose                                     | Key constraints                                                                                     |
| ------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `design_contracts` | versioned, org-scoped project design intent | `UNIQUE (project_id, version)`, `version >= 1` CHECK; `contract` jsonb NOT NULL with **no default** |

A design change **mints the next version** (the store computes `max+1`; never
overwrites — the never-discard posture), and the build reads `getLatest`. The
`contract` column is NOT-NULL with **no default**: a `DesignContractV1` has no
empty-but-valid shape (`version` / `domain` / `identity` / `intent` are required),
so a `{}`-defaulted insert would poison reads with a loud parse throw. Every row is
re-parsed through `DesignContractV1` on read — a malformed/legacy-shaped contract
fails loudly (no silent degrade), exactly like the template-manifest parser.

## Visibility rules

- **Persona reads.** Org-scoped personas are visible to any actor with
  `org:member` or `org:admin` for that org, and to any project actor in
  any of the org's projects. Project-scoped personas are visible to org
  members and to actors of the owning project.
- **Behavior reads** authorize via the parent persona.
- **Milestone reads** require either org membership or project membership
  on the owning project.
- `platform:admin` bypasses these checks.

The `PersonaStore`, `BehaviorStore`, `MilestoneStore`, and
`SpecDependencyStore` accept an `ActorContext` from
`services/orchestrator/src/auth/schemas.ts` and enforce the
rules above on every read and write.

## Cycle detection

`assertNoCycle(client, fromSpecId, toSpecId)` runs before every
`SpecDependencyStore.insert`. The algorithm is a forward DFS from
`toSpecId` along existing `from -> to` edges. If the DFS reaches
`fromSpecId`, the new edge `fromSpecId -> toSpecId` would close a cycle;
the store throws `CyclicSpecDependencyError` with the full path so the
operator can see which existing edges to remove. Self-loops throw
`SelfSpecDependencyError`. SQL also enforces the no-self-loop CHECK as a
backstop.

## Seeding

These tables were originally bootstrapped by a one-shot default-seed
`DO $$ ... $$` block (a per-project default milestone/persona/behavior for any
spec missing the links). That migration was folded into the collapsed baseline
(`db/migrations/0000_collapsed_baseline.sql`) and is no longer a separate
numbered migration; new projects populate these tables through the
spec-creation forms and the Forge interview, and `org_id` is `NOT NULL` on the
core tables (no sentinel-org backfill remains).

## Consumers

- HTTP routes and CLI commands for persona / behavior / milestone / dependency
  CRUD consume these stores.
- The spec-creation forms select a milestone and tag one or more behaviors.
- The DAG canvas authoring and the Forge interview populate these tables
  interactively. They read this model; they do not migrate it.
