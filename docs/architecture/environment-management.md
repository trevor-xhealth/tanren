# Environment management — toolchains as project-declared, never platform-baked

> **Status: BUILT — the phased plan (§7 P0–P6) is landed on `main`.** This doc was
> the design that gated the build; the build is now done and the model below is the
> as-built record. Verified on `main`: the neutral runner + `mise` (P0 —
> `runner/Dockerfile` bakes NO project toolchain, only the harness; node 24 LTS for
> the harness itself); the `upgrade` verb + version-change-as-DAG-node generator (P1
> — `engine/ci/schema.ts` `upgrade.run`, `engine/forge/upgrade/generator.ts`, the
> `handleProjectUpgrade` route); the golden-image content-digest `base_digest` +
> `env_key` (P2/P3 — `engine/environments/goldenBase.ts` + `envKey.ts`,
> `scripts/dev/build-golden-image.sh`); the `environments` registry table/store +
> per-project resolution (P3 — `db/src/schemaEnvironments.ts`,
> `engine/environments/resolveProjectEnv.ts`); JIT environment creation + validation
> with positive + negative controls (P4 — `engine/environments/creation/**`); the
> Nix escape-hatch references (P5); and the code-template ↔ environment pairing (P6).
> The remaining open item is the same as the rest of the engine: the live paths are
> not yet exercised end-to-end by an apex run that reaches a deploy. The §8
> "decisions to confirm" are resolved as built (mise primary + Nix escape hatch;
> `upgrade` required; self-hosted registry; per-project binding).

This doc defines how Tanren provisions the **toolchain/runtime environment** a
project builds in. It is the environment-layer counterpart to the command-layer
stack-agnosticism Tanren already has, and it closed the gap apex-v33 surfaced.

## 1. The gap (why this exists)

Tanren's CI contract is **already stack-agnostic at the _command_ level**:
`CiConfigV1` (`.tanren/ci.yml`) carries an opaque `bootstrap.run`, opaque tier steps,
and a project-declared test-report path — "Tanren names no tech stack itself"
(`engine/ci/schema.ts`). The `justfile` is filled from the architecture step's
`CaptureLifecycle` (bootstrap/tier1-3/build/deploy command strings + a free-form
`stack` _label_). Tanren never parses those commands; a Rust project's `cargo clippy`
and a TS project's `pnpm lint` are identical from the engine's view.

The gap this doc closed: the **runner _image_ used to be stack-_specific_**.
`runner/Dockerfile` baked one project toolchain — `nodejs` + `npm install -g
pnpm@10` + `corepack` — alongside Tanren's own harness (jj, just, codex), and the
`projects.runner_image` per-project override existed but nothing populated it. So
the contract invited any stack while the runner could only satisfy node/pnpm. That
is fixed (see the status header): the runner now bakes only the harness + `mise`,
and the project provisions its own declared toolchain at runtime.

apex-v33 hit this concretely: a ts/pnpm scaffold's `just bootstrap`
(`corepack enable pnpm && pnpm install`) failed because `corepack enable` can't write
root-owned `/usr/bin` as the non-root `tanren` SSH user, and corepack then auto-fetched
a pnpm version broken against the baked node. **The reflex fix — pin node/pnpm versions
into the image — is the disease, not the cure.** It hardcodes one stack into core and
makes "build anything" (TS on alpha tooling; Python; Fortran with decades-old deps;
even non-code work) impossible.

**The miss:** toolchain _provisioning_ was never made a project-declared,
runtime-provisioned concern the way _commands_ were. It was implicitly assumed to live
in the baked image.

## 2. Doctrine

1. **Tanren core hardcodes zero toolchains, runtimes, or versions.** The project
   declares _what_ (which tools at which versions — its choice: latest, alpha, or
   ancient) and _how_ (the bootstrap shell). Tanren owns only language-agnostic
   machinery: caching, content-keying, validation, and upgrade _policy_.
2. **No from-scratch environment** — symmetric with the no-from-scratch-project
   doctrine (`docs/roadmap/templating-system.md`). Every workspace seeds from a
   **validated Environment image**; a no-match triggers **just-in-time environment
   creation** (research → author → build → validate-with-negative-controls → publish)
   or halts loud. The build-it-from-scratch flow survives only as the BUILD step of
   environment creation.
3. **Environments are first-class, templated, layered, living artifacts** — paired
   with code templates, not welded to them.
4. **Version changes are DAG nodes — never a side stream; main never breaks.** Tanren
   is _not_ opinionated on version choice (latest / nightly / legacy are all enabled —
   the project declares). Tanren _is_ opinionated that it must **work** and that **main
   never breaks**. So every version change — an upgrade, a pin, _or_ a downgrade — is a
   **first-class unit of work in the DAG**, gated by the same never-break-main
   `MergeAuthority` path as any code change. A version bump is NEVER applied through a
   side pipeline that bypasses the gate. See §4.5.

## 3. The model — four layers

### Layer 1 — Declaration (project-owned, like `ci.yml`)

The project ships its toolchain declaration in its repo, version-controlled:

- **Default tier — `mise.toml` + `mise.lock`.** The project declares
  `[tools] node = "22"`, `python = "3.13"`, `rust = "nightly"`, etc.; `mise.lock`
  pins exact versions + checksums + URLs (the determinism + cache-key anchor).
- **Escape-hatch tier — `flake.nix`.** For the genuine long tail (decades-old C/Fortran,
  exotic system-lib pinning, byte-reproducible nightly) the project ships a Nix flake.
- **Brownfield tier — the repo's existing declaration files.** Most repositories in the
  world declare their toolchain without ever mentioning mise:
  `package.json#packageManager`, `.nvmrc`/`.node-version`, `.python-version`,
  `.ruby-version`, `.tool-versions`, `go.mod`, `rust-toolchain.toml`, or simply a
  lockfile (`pnpm-lock.yaml`, `uv.lock`, …). Tanren reads these too and provisions
  through the same Layer-2 mise provisioner.

The **writer authors** this file as part of the scaffold; the **architecture step seeds**
the initial versions. Versions are always the project's choice — never Tanren's. To
support this, `CaptureLifecycle` (today: `stack` label + command strings) gains an
optional **toolchain declaration** (the resolved tool set), and the scaffold skeleton
materializes the `mise.toml`/`flake.nix` the same deterministic way it already
materializes `justfile` + `.tanren/ci.yml`.

**Selection rule Tanren applies:** `flake.nix` present → Nix tier; a repo `mise.toml`
present → mise tier, read verbatim; else → mise tier, driven by the standard declaration
files above. Tanren detects the file; it never picks the versions.

A LOCKFILE declares the TOOL; a version file/field declares the VERSION. A tool declared
by a lockfile alone is provisioned unconstrained and _reported as such_ — Tanren never
silently pins a version the project did not choose. A declaration Tanren reads but cannot
turn into a tool it can provision (`lts/iron`, `channel = "stable"`, an unknown package
manager) is announced in the provisioning log, never dropped.

**Provisioning is verified, and a toolchain that cannot be provisioned halts.** After installing,
Tanren asserts each declared binary resolves on `PATH` and fails with the tool, version
and declaring file if it does not. And when a project's bootstrap calls a toolchain
binary nothing declares, the failure is classified as an _infrastructure_ fault and the
run halts — it is never routed to a remediation writer, because no source edit installs a
binary. (Both behaviors replace the earlier failure mode, where a repo without a
`mise.toml` was read as "declared no toolchain", provisioning was silently skipped, and
the run died three layers downstream on an opaque `pnpm: command not found`.)

### Layer 2 — Provisioning (the neutral, capable runner)

The runner becomes a **neutral sandbox**: base OS + `build-essential` (a C toolchain to
_compile_ things) + git + SSH + network + writable `$HOME`, plus Tanren's _own_ harness
(jj, just, codex/codexbar/ccusage — isolated from the project toolchain) and **one
general provisioner: `mise`**. The `bootstrap` shell stays opaque and omnipotent — it
can `mise install`, `nix develop`, `apt`, `curl|sh`, anything. The runner bakes **no
project toolchain**.

**Provisioner decision — `mise` primary, Nix escape hatch.**

- **`mise` (jdx/mise)** is the per-project, user-space provisioner for the ~95% case:
  rootless (installs under `~/.local/share/mise`, fits the non-root CI user), Rust-fast
  (~5ms vs asdf ~120ms shim overhead — matters because the gate shells in repeatedly),
  ~947 tools across secure backends (`aqua`/`github`/`cargo`/`npm`/`pipx`/`go`/`http`),
  a real lockfile (`mise.lock`), and nightly/alpha selectors. It reads `.tool-versions`
  too (asdf superset), so asdf is strictly dominated — no reason to choose it.
- **Nix flakes + a self-hosted binary cache (attic)** is the opt-in tier for what mise
  can't: reproducibly rebuilding decades-old toolchains (research rebuilt 99.94% of a
  6-year-old nixpkgs; 15-year-old apps build by pinning a historical commit). It is
  heavy (nix store, flake authoring), so it is **strictly flake-present-only**, backed
  by attic so cold builds become warm pulls.

Known tradeoff to accept: **mise nightly is not byte-reproducible** (no exact-date lock);
a project needing pinned nightly pins a dated channel (`nightly-2025-03-28`) or drops to
the Nix tier.

### Layer 3 — Layering: baseline (golden image) vs. delta (workspace-prep)

This is the **"what the image ships with" vs. "add/alter"** distinction as first-class
layers — and the **speed mechanism** (workspaces must boot fast).

- **Baseline = the golden image.** A pre-built, **trimmed** OCI image (BuildKit) per
  environment lineage, carrying the neutral sandbox + the harness + `mise` + a **warm
  `mise` cache of the empirically-common baseline** (recent Node/Python/Go LTS, etc.).
  Trim policy follows the GitHub `runner-images` discipline: **bake what's slow-to-install
  and common; omit the rare.** **Refreshed on every `main` update** via a scheduled
  BuildKit build, tagged by content digest.
- **Delta = workspace-prep.** The project's specific adds/version-changes layered on at
  prep time by `mise install` from its `mise.lock`, in user space. Tools already warm in
  the baseline are no-ops (instant); only the genuine diff downloads. The prepared layer
  is content-keyed and cached (below), so a second runner pulls rather than re-resolves.

### Layer 4 — Lifecycle: JIT creation, validation, refresh, forced upgrade

**JIT environment-image creation** (mirrors code-template creation):

- The environment's identity is its content hash:
  `env_key = sha256(base_digest ‖ mise.lock ‖ flake.lock?)`.
- **Match check = a registry HEAD** on `env:<env_key>` in a self-hosted OCI registry.
  **Hit → seed instantly. Miss → JIT build** (BuildKit for mise-tier; **nix2container +
  attic** for Nix-tier — ~1.8s rebuild/push, JIT-grade). Always base a JIT build on the
  current golden base, never scratch; feed BuildKit `--cache-from` the base + sibling
  envs (zstd, `mode=max`).
- **Validate before publish — positive smoke + negative controls** (the same oracle
  shape as code-template validation, `templates/validationProof.ts`):
  - _Positive:_ run the project's `bootstrap` + a toolchain-check (every declared tool
    resolves to its **locked** version, exit 0). The toolchain must actually _work_.
  - _Negative:_ an **undeclared** tool is **absent** (a Python-only env must fail to find
    a stray global Node) and a **wrong/forbidden version** is **not** resolvable. This
    proves isolation and catches golden-base leakage. **Non-optional** — without it,
    "isolated" envs silently aren't.
  - Only on green: `push` to `env:<env_key>`, mark **validated**, record provenance +
    proof. A failed validation never publishes.

**Continuous refresh + trim:** golden bases rebuild as `main`/env-specs change; the trim
pass keeps them lean (bake slow+common, delta the rest).

**Required `upgrade` verb — the command a version-change node runs.** `CiConfigV1` gains
an `upgrade` lifecycle verb alongside bootstrap/tiers (and the `justfile` gains the target),
**required** so every project declares how to bump to latest. **The verb must cover BOTH
the toolchain AND the dependencies** — a deps-only `pnpm update --latest` leaves the
`mise.toml` runtime/package-manager pins stale, so the authored command bumps the toolchain
pins too (e.g. `mise upgrade --bump && mise install && pnpm update --latest`;
`… && cargo update`; `… && uv lock --upgrade`). Tanren owns the **policy**, not the
command (Renovate-style, language-agnostic): a `keep-current` posture, a
`minimum_release_age` cooldown (dodge just-published supply-chain'd versions), and
group/one-PR knobs. The verb only _produces_ the new declaration/lockfile; what makes it
safe is that the resulting version change runs through the DAG gate (§4.5), not a side
pipeline. This is the _structural_ fix for agents picking multi-year-old versions, beyond
prompting. Escape hatch for a project that declares no `upgrade` verb: Tanren runs Renovate
(self-hosted) to compute the changeset, then routes it through the same DAG gate.

**Optional `deploy` verb — the ci.yml home for the lifecycle deploy command.** `CiConfigV1`
also carries a `deploy` lifecycle verb alongside `bootstrap`/`upgrade`/tiers — the same
opaque `{ run }` shape (conventionally `just deploy`, the actual release command living in
the justfile; Tanren names no deploy tool). The lifecycle already treats `deploy` as a
first-class point (`engine/forge/interview/types.ts`; the template-creation research
lifecycle), so a template-build's `deploy` spec **projects its lifecycle deploy command
into the authored `.tanren/ci.yml` as `deploy.run`** — the same way `build`/`upgrade`/tier
verbs project (every verb defers to `just <target>`, filled from the captured lifecycle).
Before this verb existed, the strict `CiConfigV1` **rejected** any ci.yml that declared
`deploy:` (`Unrecognized key: "deploy"`), infinite-looping the deploy spec — it had nowhere
to land the command. It is **optional** (like `upgrade`): a project with no `deploy` verb has
no Tanren-runnable deploy command (absence is semantic, no silent fallback). It is **stack-
AND target-agnostic** — `run` holds ONLY the project's own deploy COMMAND, never a
provider-specific (vercel/fly/…) branch; the deploy **provider/target** (the app to release
onto + its credentials) is a separate org-integration concern
(`engine/postMerge/deployTargetResolution.ts`), not this verb. (Wiring the post-merge
deploy-on-merge watcher — which today triggers a provider-API release, not a shell command —
to read `deployCommand(config)` is a follow-on, not part of this schema fix.)

**Fresh templates start at the latest versions (the two-lever anti-stale fix).** An agent
authoring a template-from-scratch pins versions from its **training cutoff** — already
stale (an apex run pinned node 24 + pnpm 10 when pnpm 11 was current, and mise then
installed pnpm 11.6 anyway, a silent mismatch). Two **generic, stack-agnostic** levers fix
this so a freshly-created template is born current — neither bakes any pnpm/cargo/… branch
into Tanren core:

1. **Prompt latest-by-default.** The fragment-authoring research/author prompt
   instructs the model to choose the **LATEST stable** release for the toolchain
   (language/runtime/package-manager versions) AND for every dependency, and to
   **NOT pin to the training cutoff** (assume newer versions exist). The non-opinionated
   doctrine holds: a deliberately-pinned legacy/specific/nightly version is allowed
   **when the brief explicitly requires it** (§4.5 motivation 1/4). Missing fragments
   enter the F2 authoring loop; operators inspect `fragment.authoring.{started,attempt,succeeded,failed}`.

## 4. How it composes (one paragraph)

A project ships a **declaration** (`mise.toml`/`mise.lock`, or `flake.nix` for the long
tail) and a `.tanren/ci.yml` lifecycle (bootstrap/tier/build/deploy/**upgrade**). Tanren
keeps a **trimmed golden base image** (BuildKit, refreshed on `main`, warm mise baseline).
At workspace-prep it computes `env_key = hash(base_digest ‖ lockfiles)` and checks the
**OCI registry**; on hit it seeds instantly, on miss it **JIT-builds**, **validates with
positive smoke + negative controls**, and publishes the validated env image. The
**`upgrade` verb** (project command + Tanren policy) forces deps to latest, regenerates
lockfiles, recomputes `env_key`, and rebuilds+revalidates through the same gate. **Tanren
core hardcodes no toolchain or version anywhere.**

## 4.5. Version changes are DAG nodes — never break main

Tanren is deliberately **un-opinionated on version choice** and deliberately
**opinionated that it works**. Those cut both ways for legacy _and_ latest, and they
reconcile through one rule: **a version change is a first-class unit of work in the DAG,
gated like any other — never applied through a side stream.**

The four motivations and how they land:

1. **Legacy/nightly/latest all enabled.** The project declares its versions (§3 Layer 1);
   Tanren never forces a channel. A project pinning a decade-old toolchain is as valid as
   one on nightly.
2. **Upgrades made seamless (CVEs, freshness).** Tanren can _generate_ version-change work
   — a CVE advisory, a scheduled freshness pass, the `upgrade` verb's forced-latest — as
   units of work, so staying current is cheap, not a chore.
3. **No human-in-the-loop per package.** Those generated changes flow through the SAME
   autonomous loop Tanren already runs for any work: triage → spec → **DAG-insert** →
   execute → gate → merge. The autonomy engine drives dependency maintenance; a human is
   pulled in only on a genuine break or a real product/architecture decision
   (`needs_attention` discipline), never for routine bumps.
4. **Purposeful pins are not overridden.** The generated-upgrade flow is intent-preserving:
   it proposes within the project's declared constraints and never silently rewrites a
   deliberate pin. Intent is data the flow respects, not noise it steamrolls.

**The opinionated core — never break main.** Because every version change (upgrade, pin,
_or_ downgrade) is a DAG node, it runs the project's full gate — the new toolchain installs

- validates (§4 env-image positive/negative controls) AND the project still builds/tests
  green under it:

* **Green → it merges.** Main moves forward, now on the new version, still working.
* **Red → it is LOUDLY REJECTED**, with the precise reason (this version breaks _these_
  gate steps) and what adoption would require. The human learns exactly why, and **main
  stays green.** A "random pydantic v2 → v1 downgrade" cannot silently land and brick main:
  routed through the DAG, it fails the gate and is rejected with a legible diagnosis, the
  same `MergeAuthority` fail-closed path that guards every other change.

This is not a new subsystem — it is dependency/version management expressed as Tanren's
_existing_ general model (the DAG drives gated work; `MergeAuthority` never breaks main;
the issue→triage→fix loop ingests generated work). The env-image rebuild+validate (§4) is a
_step inside_ a version-change node's gate, never a bypass of it. **The `upgrade` verb and
the autonomous upgrade flows are how the work is _generated_; the DAG + `MergeAuthority` are
what make it _safe_.**

## 5. Coupling to code templates — paired, not welded

A code template **references** an Environment (a validated code template implies a
validated, fast-booting environment), but environments are **independently** created,
validated, versioned (`lts`/`nightly` channels, mirroring `TemplateStore`), and refreshed.
Re-point a code template at a newer environment; share one environment across many code
templates. The environment registry is a **parallel table to `templates`**, same
capability-keyed selection + negative-control publish gate.

## 6. Integration seams (grounded in current code)

| Concern                      | Today                                                                                                                      | Change                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Runner image                 | one hardcoded `tanren-runner:v0` default (`projectSpec.ts:23`, `shared.ts:94`); per-project `projects.runner_image` unused | resolve `env_key` → golden base image; runner stripped of project toolchain, gains `mise`                                        |
| Image selection              | per-project, resolved once; allocator blind to content (`AllocationRequest.runnerImage`)                                   | per-project env binding → image; add the env-resolve step before allocate                                                        |
| Env registry                 | none                                                                                                                       | new `environments` table + store, parallel to `TemplateStore`/`manifest.ts` (capabilities, channel, provenance, validationProof) |
| Toolchain declaration        | `CaptureLifecycle.stack` is a label only (`forge/interview/types.ts`)                                                      | add optional toolchain declaration; scaffold materializes `mise.toml`/`flake.nix` (skeleton path, like `contractFiles.ts`)       |
| `upgrade` verb               | absent from `CiConfigV1` (`ci/schema.ts`) + skeleton                                                                       | add `upgrade` to schema + `SKELETON_CI_CONFIG` + `justfile` targets                                                              |
| `deploy` verb                | `CiConfigV1` had no `deploy` key, so the strict schema rejected an authored ci.yml's lifecycle `deploy:` (infinite-loop)   | add a `CiDeploy` `{ run }` verb to schema + `SKELETON_CI_CONFIG` (`deploy.run: just deploy`) + a `deployCommand` resolver        |
| Workspace-prep delta         | clone → materialize contract files → jj init → bootstrap (`plannerRunWorkspace.ts`)                                        | insert env-resolve + `mise install` delta before bootstrap                                                                       |
| Validation negative controls | typecheck/lint/test/mutation (`validationProof.ts`)                                                                        | add a `toolchain`/isolation negative control for env images                                                                      |
| Golden-image build/cache     | none                                                                                                                       | BuildKit golden-base build (refresh-on-`main`) + OCI registry + `mode=max` cache; attic for Nix tier                             |
| Version-change flow          | none (no dep/version maintenance path)                                                                                     | generate upgrade/CVE/freshness work as DAG nodes via the existing triage→spec→DAG-insert loop; gated by `MergeAuthority` (§4.5)  |

Constraint preserved: `.tanren/ci.yml` stays a **deterministic skeleton** (never
LLM-authored); only the `justfile` + the new `mise.toml`/`flake.nix` are lifecycle-filled.

## 7. Phased build plan (multi-PR) — as built

All phases below **landed** (see the status header for the per-phase code anchors);
the plan is retained as the as-built sequence and rationale.

- **P0 — Neutral runner + mise (general project execution; apex v33 exposed the gap).** Strip the project toolchain from
  `runner/Dockerfile`; add `mise` + a warm common baseline; keep the harness. Scaffold
  materializes a `mise.toml` from the lifecycle; bootstrap becomes `mise install &&
<project install>` in user space (kills the corepack/`/usr/bin` EACCES). _This alone
  lets any project with a detected toolchain proceed through the normal flow._
- **P1 — `upgrade` verb + version-change-as-DAG-node (§4.5).** `CiConfigV1` + skeleton +
  `justfile` `upgrade` target + the forced-upgrade policy; the autonomous generator that
  turns a CVE/freshness/forced-upgrade into a DAG node routed through the existing
  triage→spec→DAG-insert→gate→merge loop (intent-preserving; never overrides a pin; a
  breaking change is gate-rejected loudly, never breaks main); **creation-time upgrade so a
  freshly-created template is born at latest** (the prompt latest-default + the once-at-birth
  gated `just upgrade` node — both stack-agnostic, no version baked into core).
- **P2 — Golden-image build + refresh-on-`main` + trim.** BuildKit pipeline, OCI
  registry, `mode=max` cache, content-digest tagging.
- **P3 — Environment registry + `env_key` resolution + per-project binding.** The
  `environments` table/store, the workspace-prep env-resolve + delta step.
- **P4 — JIT environment creation + validation.** research→author→build→validate
  (positive + negative controls)→publish, mirroring code-template creation; the no-match
  seam; the registry HEAD match.
- **P5 — Nix escape-hatch tier.** flake detection → nix2container + attic; the long tail.
- **P6 — Code-template ↔ environment reference.** Wire the pairing; channels.

P0 is the general toolchain unblock first exposed by apex v33 and is independently
shippable; P1–P6 deepen toward the full model.

## 8. Decisions to confirm before building

1. **mise primary + Nix escape hatch** (vs. Nix-first everywhere). Recommendation: mise
   primary — lighter, faster boot, pairs with the golden-image delta; Nix opt-in for the
   long tail. Net: two builders (BuildKit + nix2container) as deliberate surface area.
2. **`upgrade` verb required** (vs. optional). Recommendation: required — it's the
   structural anti-stale-version lever; a project with literally nothing to upgrade
   declares a no-op.
3. **Self-hosted OCI registry + attic** as the env-image + cache + NAR backend (vs. a
   hosted service). Recommendation: self-hosted (cost-conscious, no new external trust).
4. **Per-project env binding** (vs. per-run). Recommendation: per-project — matches
   today's image-selection grain; a re-bind is an explicit project change.
