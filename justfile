set shell := ["bash", "-euo", "pipefail", "-c"]

# The allocator API token is required (fail-loud, no silent "dev" default) by
# buildAllocator + the standalone allocator. Provide a dev default here so every
# recipe — incl. the RLS smoke tests that construct the real app — inherits it;
# real deploys set it via compose/env.
export TANREN_ALLOCATOR_TOKEN := env_var_or_default("TANREN_ALLOCATOR_TOKEN", "dev")

# Persistent host location for dev RUNTIME artifacts that must survive the whole
# lifetime of a (multi-hour) run: the runner identity key (+ .pub + known_hosts)
# and the mTLS material. These used to live in /tmp, which systemd-tmpfiles cleans
# out from under a long run — deleting /tmp/tanren_runner_key mid-run so the worker
# container can no longer restart (`crun: cannot stat '/tmp/tanren_runner_key'`).
# Default to a 0700 user dir; override with TANREN_RUNTIME_DIR. Exported so every
# recipe (and the compose invocations they launch) sees the resolved absolute path.
export TANREN_RUNTIME_DIR := env_var_or_default("TANREN_RUNTIME_DIR", env_var("HOME") / ".config/tanren/runtime")

default:
  just --list

format-check:
  corepack pnpm run format:check

# Auto-format with oxfmt (the oxc formatter, config in .oxfmtrc.json). `format-check`
# is the gate; this writes the fixes for the file types oxfmt owns.
format:
  corepack pnpm run format

lint:
  corepack pnpm run lint

# Type-aware lint pass (oxlint --type-aware / oxlint-tsgolint). Slower than
# AST-only oxlint because it loads type info; scoped to shipped src. Catches
# floating/misused promises and awaited non-thenables that oxlint (AST-only)
# cannot.
types-lint:
  corepack pnpm run check:types-lint

architecture:
  corepack pnpm run check:architecture

schema-drift:
  corepack pnpm run check:schema-drift

state-drift:
  corepack pnpm run check:state-drift

event-drift:
  corepack pnpm run check:event-drift

answerer-schema-drift:
  corepack pnpm run check:answerer-schema-drift

contract-schema-drift:
  corepack pnpm run check:contract-schema-drift

# Drift gate for the dashboard's client-side run-detail HTTP types: regenerates
# services/dashboard/src/api/http.gen.ts from contracts/json/http/** and fails
# if the committed file diverges. Same mechanism as contract-schema-drift; this
# is the durable guarantee the BFF↔orchestrator contract can't silently drift.
dashboard-types-drift:
  corepack pnpm run check:dashboard-types-drift

# in-21 drift gate for the dashboard's bundled in-20 JSON-Schema catalog
# (services/dashboard/src/api/integrationReadSchemaCatalog.gen.ts): regenerates
# the bundle from contracts/json/integrations/*.json and fails if the committed
# TS module diverges. Mirrors dashboard-types-drift exactly; the source JSON is
# itself drift-gated by contract-schema-drift, so this gate pins the dashboard's
# bundled copy to that source.
integration-schema-bundle-drift:
  corepack pnpm run check:integration-schema-bundle-drift

# rv-22 read-compat guard for the runtime-verification HTTP read surface. UNLIKE
# the byte-drift guards above (which fail on any change), this is SEMANTIC: it
# pins the exposed response shape against the committed floor
# (contracts/rv-read-compat/v1.json) and fails ONLY on a backward-INCOMPATIBLE
# change (a removed/renamed/retyped field, a removed enum member) — an additive
# change (a new field/enum member/schema) passes. Keeps dashboard rv-23 + external
# readers from silently breaking. Regen the floor with `codegen:rv-read-compat`.
rv-read-compat:
  corepack pnpm run check:rv-read-compat

# in-20 read-compat guard for the integration HTTP read surface. Same SEMANTIC
# shape as rv-read-compat: pins the exposed response shape against the committed
# floor (contracts/integration-read-compat/v1.json) and fails ONLY on a backward-
# INCOMPATIBLE change — an additive change passes. Keeps the in-21 Control Center
# UI + external readers from silently breaking. Regen with
# `codegen:integration-read-compat`. Shares the same pure classifier as rv-22.
integration-read-compat:
  corepack pnpm run check:integration-read-compat

# Trust-at-boundary lint (audit RC-6): rejects re-introduced `as Date` (and
# `.parse(...) as <ClosedEnum>`) casts in the run-detail read seam
# (services/orchestrator/src/routes/runs/**), so a reverted Zod-decode fix fails
# the build. Widen the scope to the rest of routes/** + the forge decode sites in
# a follow-up (see scripts/lint/no-pg-as-date.mjs header).
no-pg-as-date:
  corepack pnpm run check:no-pg-as-date

knip:
  corepack pnpm run check:knip

# Re-fetch LiteLLM's maintained model-price source and re-vendor the snapshot at
# services/orchestrator/src/engine/costs/pricing/model_prices.json. Run on a
# schedule so the snapshot stays current with upstream (providers add/adjust
# models). SCHEDULING NOTE: wire this into the existing scheduled-CI lane (the same
# lane the scheduled mutation-CI runs on) as a follow-up — this PR adds only the
# recipe, not a CI cron trigger. Use `--check` in CI to fail on a stale snapshot.
refresh-model-prices:
  node scripts/refresh-model-prices.mjs

# Reap agent worktrees (.claude/worktrees/agent-*) whose branch already merged to
# main. Subagent worktrees each carry their own node_modules + build output and
# linger after merge; left unattended they accumulate into gigabytes (they once
# filled the disk). Safe + idempotent — never removes a branch with unmerged
# commits. Run after merging a subagent PR, or periodically. `--dry-run` reports.
prune-worktrees *ARGS:
  scripts/prune-merged-worktrees.sh {{ARGS}}

spelling:
  corepack pnpm run check:spelling

# Whole-repo typecheck via Turborepo (cached per package; FULL TURBO on a no-op
# re-run). `just ci`/`fast-check` use this; the cache lives in .turbo/ (gitignored).
typecheck:
  corepack pnpm run typecheck

fast-check: format-check lint types-lint architecture no-pg-as-date schema-drift state-drift event-drift answerer-schema-drift contract-schema-drift dashboard-types-drift integration-schema-bundle-drift rv-read-compat integration-read-compat knip spelling typecheck test compose-config

test:
  corepack pnpm run test

# AFFECTED-ONLY inner loop (NOT the gate — the gate runs the full suite). Typecheck/
# build only the packages whose sources (or whose dependencies' sources) changed vs a
# base ref, via Turborepo's `...[ref]` filter; default base `origin/main`. Use while
# iterating to skip unaffected packages. Example: `just affected-typecheck HEAD~1`.
affected-typecheck base="origin/main":
  corepack pnpm exec turbo run typecheck --filter="...[{{base}}]"

affected-build base="origin/main":
  corepack pnpm exec turbo run build --filter="...[{{base}}]"

# Run only the tests related to files changed vs a base ref (Vitest `--changed`).
# Fast feedback while editing; `just test` (full + coverage) remains the gate.
affected-test base="origin/main":
  corepack pnpm exec vitest run --changed {{base}}

# Stryker mutation testing — Track C §5 of
# docs/architecture/portability-and-longevity.md. Turns test-strength into a
# number on the workflow-critical + seam modules (planner/checker/auditor,
# engine/credentials/**, and the Allocator/JobQueue/SecretStore seams). SLOW:
# deliberately NOT part of `just ci` / `just fast-check`. Run on demand or
# nightly. Scope + thresholds live in stryker.config.mjs.
mutation:
  corepack pnpm run check:mutation

# WHOLE-REPO mutation (services/orchestrator/src/**) via stryker.full.mjs.
# EXPENSIVE — NOT for per-PR CI. Driven on demand and by the WEEKLY scheduled
# job (.github/workflows/mutation-weekly.yml). Per-cluster `break` floors gate
# regressions; this run tracks the global trend. See
# docs/contracts/mutation-testing.md.
mutation-full:
  corepack pnpm exec stryker run stryker.full.mjs

# Run one named mutation cluster, e.g. `just mutation-cluster repos` →
# stryker.repos.mjs. Clusters: runloop alloc wf forge notify secrets inbox
# auth costs repos worker dal. Each carries its own ratcheted `break` floor.
mutation-cluster cluster:
  corepack pnpm exec stryker run stryker.{{cluster}}.mjs

build:
  corepack pnpm run build

compose-config:
  corepack pnpm run compose:config

ci: format-check lint types-lint architecture no-pg-as-date schema-drift state-drift event-drift answerer-schema-drift contract-schema-drift dashboard-types-drift integration-schema-bundle-drift rv-read-compat integration-read-compat knip spelling typecheck test build compose-config

compose-build:
  docker compose -f compose.dev.yml build orchestrator worker allocator dashboard runner

# Golden-image build (environment-management.md §3 Layer 3 + §7 P2): build the runner
# image (the GOLDEN BASE — neutral sandbox + harness + `mise` + the WARM mise BASELINE)
# via BuildKit, content-digest-tagged, with registry-backed `mode=max` cache. Local by
# default (loads into the docker store); set PUSH=1 to push to the dev registry
# (`registry:2` on :5000 from `just up-dev`). The refresh-on-`main` workflow
# (.github/workflows/golden-image.yml) runs the SAME script. Pass-through env:
# REGISTRY / IMAGE_NAME / PUSH / PLATFORMS / EXTRA_TAGS.
build-golden-image:
  ./scripts/dev/build-golden-image.sh

# Secrets layout for fresh worktrees. Apex playbook §1 says "operate from a fresh
# detached worktree" — but `.env` / `.env.validation.local` /
# `connections.manifest.local.yaml` are gitignored and don't follow a worktree
# checkout, so a fresh worktree's `just up-dev` boots infra-only (orchestrator
# never starts). Canonical home is `${TANREN_SECRETS_DIR:-~/.config/tanren/secrets}`
# (XDG-compliant). Operator places the three files there ONCE (`just
# secrets-migrate` migrates an existing inline setup); this recipe symlinks them
# into cwd. Idempotent. Fail-loud on missing `.env` (the BLOCKER); optional files
# skip silently with a notice. Folded into `up-dev` so a fresh worktree boots cleanly.
secrets-link:
  #!/usr/bin/env bash
  set -euo pipefail
  mode="${TANREN_SECRETS_MODE:-canonical}"
  src="${TANREN_SECRETS_DIR:-$HOME/.config/tanren/secrets}"
  # Explicit secrets mode — no silent fallbacks. The operator (or CI) must
  # declare which mode applies; the default is the strict path so a fresh
  # apex run fails closed on a missing canonical .env rather than silently
  # using dev defaults.
  case "$mode" in
    canonical)
      # The real path: canonical .env at $src is the only valid source. Used by
      # apex and any real-validation run.
      if [ ! -d "$src" ]; then
        echo "secrets-link: canonical secrets dir not found: $src" >&2
        echo "  Either: (1) run 'just secrets-migrate' from your main checkout to" >&2
        echo "  move existing .env/.env.validation.local/connections.manifest.local.yaml" >&2
        echo "  into the canonical location, OR (2) for CI / smoke runs that don't" >&2
        echo "  need real apex secrets, export TANREN_SECRETS_MODE=dev-defaults to" >&2
        echo "  declare the dev-defaults intent explicitly." >&2
        exit 1
      fi
      if [ ! -f "$src/.env" ]; then
        echo "secrets-link: required file missing: $src/.env" >&2
        echo "  .env holds infra bootstrap (DATABASE_URL, VAULT_TOKEN, TANREN_SECRET_STORE)." >&2
        echo "  Run 'just secrets-migrate' (from your main checkout, with secrets inline)" >&2
        echo "  OR for CI/smoke runs, export TANREN_SECRETS_MODE=dev-defaults explicitly." >&2
        exit 1
      fi
      ;;
    dev-defaults)
      # The explicit dev-defaults path: link `.env -> .env.example` so the
      # infra stack boots with compose-friendly defaults. NOT a real apex
      # path — there are no Hetzner/Slack/GitHub-App credentials. The
      # operator (or CI) must have set TANREN_SECRETS_MODE=dev-defaults
      # deliberately; this branch never auto-engages.
      if [ ! -f "./.env.example" ]; then
        echo "secrets-link: TANREN_SECRETS_MODE=dev-defaults but ./.env.example is absent." >&2
        echo "  This mode requires a checked-in .env.example template." >&2
        exit 1
      fi
      example_abs="$(pwd)/.env.example"
      # Idempotent re-run.
      if [ -L "./.env" ] && [ "$(readlink "./.env")" = "$example_abs" ]; then
        echo "secrets-link: mode=dev-defaults — .env already linked to .env.example."
        exit 0
      fi
      if [ -L "./.env" ]; then
        rm "./.env"  # stale symlink — safe to replace
      elif [ -e "./.env" ]; then
        echo "secrets-link: mode=dev-defaults but ./.env exists as a real file." >&2
        echo "  Refusing to clobber. Remove ./.env or run 'just secrets-migrate' first." >&2
        exit 1
      fi
      ln -s "$example_abs" "./.env"
      echo "secrets-link: mode=dev-defaults — .env linked to .env.example (compose-friendly dev defaults)."
      echo "  This is NOT a real apex secret set (no Hetzner/Slack/GitHub-App creds)."
      echo "  Use only for CI/smoke; apex runs unset TANREN_SECRETS_MODE and require real secrets."
      exit 0
      ;;
    *)
      echo "secrets-link: invalid TANREN_SECRETS_MODE=$mode (valid: canonical, dev-defaults)" >&2
      exit 1
      ;;
  esac
  linked=()
  for name in .env .env.validation.local connections.manifest.local.yaml; do
    s="$src/$name"
    t="./$name"
    if [ ! -e "$s" ] && [ ! -L "$s" ]; then
      continue  # optional file absent at source — skip silently
    fi
    if [ -L "$t" ]; then
      cur="$(readlink "$t")"
      if [ "$cur" = "$s" ]; then
        continue  # already linked correctly
      fi
      rm "$t"  # stale symlink — safe to replace
    elif [ -e "$t" ]; then
      echo "secrets-link: $t exists as a real file (not a symlink)." >&2
      echo "  Refusing to overwrite. Run 'just secrets-migrate' to move it to $src." >&2
      exit 1
    fi
    ln -s "$s" "$t"
    linked+=("$name")
  done
  if [ ${#linked[@]} -eq 0 ]; then
    echo "secrets-link: all files already linked from $src"
  else
    echo "secrets-link: linked from $src:"
    for n in "${linked[@]}"; do echo "  $n"; done
  fi

# One-time migration: move existing inline `.env` / `.env.validation.local` /
# `connections.manifest.local.yaml` from cwd to the canonical secrets dir, then
# symlink them back. Idempotent — files already symlinked are skipped; missing
# files are skipped. Creates the canonical dir at 0700 with each file at 0600.
# Run ONCE from your main checkout if you currently keep secrets inline there;
# subsequent worktrees only need 'just secrets-link' (which up-dev calls).
secrets-migrate:
  #!/usr/bin/env bash
  set -euo pipefail
  dst="${TANREN_SECRETS_DIR:-$HOME/.config/tanren/secrets}"
  mkdir -p "$dst"
  chmod 700 "$dst"
  echo "secrets-migrate: canonical dir = $dst"
  moved=()
  skipped=()
  for name in .env .env.validation.local connections.manifest.local.yaml; do
    s="./$name"
    d="$dst/$name"
    if [ -L "$s" ]; then
      skipped+=("$name (already a symlink)")
      continue
    fi
    if [ ! -f "$s" ]; then
      skipped+=("$name (not present in cwd)")
      continue
    fi
    if [ -e "$d" ]; then
      echo "secrets-migrate: $d already exists at canonical location." >&2
      echo "  Refusing to overwrite. Remove the older copy or pick a side, then re-run." >&2
      echo "  (Diff first: diff $s $d)" >&2
      exit 1
    fi
    mv "$s" "$d"
    chmod 600 "$d"
    ln -s "$d" "$s"
    moved+=("$name")
  done
  if [ ${#moved[@]} -gt 0 ]; then
    echo "secrets-migrate: moved to $dst and symlinked back:"
    for n in "${moved[@]}"; do echo "  $n"; done
  fi
  if [ ${#skipped[@]} -gt 0 ]; then
    echo "secrets-migrate: skipped:"
    for n in "${skipped[@]}"; do echo "  $n"; done
  fi
  echo ""
  echo "Done. Other worktrees can now run 'just secrets-link' (or just 'just up-dev')."

runner-key:
  mkdir -p -m 0700 "$TANREN_RUNTIME_DIR"
  test -f "$TANREN_RUNTIME_DIR/tanren_runner_key" || ssh-keygen -t ed25519 -N "" -f "$TANREN_RUNTIME_DIR/tanren_runner_key"

# Plane-split P2: generate the dev control↔data-plane mTLS material (CA + server
# + worker certs) into $TANREN_RUNTIME_DIR/mtls, bind-mounted into the orchestrator
# + worker by compose.dev.yml. Idempotent. Prod supplies real certs via the same env.
gen-mtls-certs:
  ./scripts/dev/gen-mtls-certs.sh

# Host-side sanity-check for the usage tools (codexbar live windows + ccusage
# token accounting) against a real CODEX_HOME. In a real run these execute
# runner-side over SSH; this recipe just lets an operator eyeball the tools.
usage provider="codex" cli="codex" codex_home="":
  scripts/usage/print-usage.sh {{provider}} {{cli}} {{codex_home}}

# Dev profile: developer ergonomics. Static Vault root token, exposed
# Postgres/runner SSH/orchestrator/dashboard/ntfy host ports, no required env.
#
# The runner identity PRIVATE key is delivered as a MOUNTED compose SECRET FILE
# (the `tanren_runner_identity_key` secret in compose.dev.yml reads
# $TANREN_RUNTIME_DIR/tanren_runner_key, generated by `runner-key`), never a
# plaintext env value. Only the PUBLIC authorized_keys line is passed via env.
#
# Port flexibility: each of the 9 host-published ports has a per-port env
# override (TANREN_<X>_HOST_PORT), AND a bulk-shift TANREN_PORT_OFFSET that adds
# N to every default at once. Per-port overrides win over the offset, so
# multiple apex trials can coexist on one box (e.g. `TANREN_PORT_OFFSET=100`
# for the second stack). The effective port set is echoed before bring-up.
#
# Secrets: `secrets-link` (first dep) symlinks the operator-local secret files
# into cwd from ${TANREN_SECRETS_DIR:-~/.config/tanren/secrets}/, so a fresh
# worktree boots cleanly without copying secrets into it.
up-dev: secrets-link runner-key gen-mtls-certs
  # Compute effective host ports: per-port env override wins; otherwise
  # default + TANREN_PORT_OFFSET. `:=` only assigns when the var is unset/empty,
  # so an operator-exported per-port var passes through untouched. Posix-sh
  # arithmetic; no bash-isms.
  offset="${TANREN_PORT_OFFSET:-0}"; \
  : "${TANREN_ORCHESTRATOR_HOST_PORT:=$((3100 + offset))}"; \
  : "${TANREN_INTERNAL_MTLS_HOST_PORT:=$((3110 + offset))}"; \
  : "${TANREN_ALLOCATOR_HOST_PORT:=$((3200 + offset))}"; \
  : "${TANREN_POSTGRES_HOST_PORT:=$((5432 + offset))}"; \
  : "${TANREN_RUNNER_SSH_HOST_PORT:=$((2222 + offset))}"; \
  : "${TANREN_VAULT_HOST_PORT:=$((18200 + offset))}"; \
  : "${DASHBOARD_HOST_PORT:=$((3000 + offset))}"; \
  : "${TANREN_NTFY_HOST_PORT:=$((18080 + offset))}"; \
  : "${TANREN_REGISTRY_HOST_PORT:=$((5000 + offset))}"; \
  : "${TANREN_PUBLIC_BASE_URL:=http://localhost:${TANREN_ORCHESTRATOR_HOST_PORT}}"; \
  if [ -z "${TANREN_DOCKER_SOCK:-}" ]; then \
    if [ -S /var/run/docker.sock ]; then \
      TANREN_DOCKER_SOCK=/var/run/docker.sock; \
    elif [ -S "/run/user/$(id -u)/podman/podman.sock" ]; then \
      TANREN_DOCKER_SOCK="/run/user/$(id -u)/podman/podman.sock"; \
    else \
      echo "up-dev: no container-runtime socket found at /var/run/docker.sock or /run/user/$(id -u)/podman/podman.sock — export TANREN_DOCKER_SOCK explicitly" >&2; \
      exit 1; \
    fi; \
  fi; \
  export TANREN_ORCHESTRATOR_HOST_PORT TANREN_INTERNAL_MTLS_HOST_PORT TANREN_ALLOCATOR_HOST_PORT TANREN_POSTGRES_HOST_PORT TANREN_RUNNER_SSH_HOST_PORT TANREN_VAULT_HOST_PORT DASHBOARD_HOST_PORT TANREN_NTFY_HOST_PORT TANREN_REGISTRY_HOST_PORT TANREN_PUBLIC_BASE_URL TANREN_DOCKER_SOCK; \
  echo "up-dev: host ports — orchestrator=$TANREN_ORCHESTRATOR_HOST_PORT internal-mtls=$TANREN_INTERNAL_MTLS_HOST_PORT allocator=$TANREN_ALLOCATOR_HOST_PORT postgres=$TANREN_POSTGRES_HOST_PORT runner-ssh=$TANREN_RUNNER_SSH_HOST_PORT vault=$TANREN_VAULT_HOST_PORT dashboard=$DASHBOARD_HOST_PORT ntfy=$TANREN_NTFY_HOST_PORT registry=$TANREN_REGISTRY_HOST_PORT (override per-port via TANREN_<X>_HOST_PORT or bulk-shift via TANREN_PORT_OFFSET)"; \
  echo "up-dev: TANREN_PUBLIC_BASE_URL=$TANREN_PUBLIC_BASE_URL (used by OAuth callbacks + webhook URLs; tracks the orchestrator host port automatically)"; \
  echo "up-dev: TANREN_DOCKER_SOCK=$TANREN_DOCKER_SOCK (allocator runtime socket; auto-detected — docker first, then rootless podman)"; \
  TANREN_RUNNER_AUTHORIZED_KEY="$(cat "$TANREN_RUNTIME_DIR/tanren_runner_key.pub")" docker compose -f compose.dev.yml up -d postgres vault orchestrator worker allocator dashboard runner ntfy registry
  # Seed PLATFORM-scoped secret-store refs (managed-LLM router key) so a fresh
  # stack can resolve `providerMode: managed`. The seed SCRIPT resolves the key
  # via the portable precedence (exported env > TANREN_SECRET_ENV_FILE >
  # .env.validation.local). Here we replicate that precedence ONLY to decide
  # whether the key is obtainable at all — a BYOK-only dev stack (no key from any
  # source) still comes up cleanly by skipping the seed with a notice. When a key
  # IS present the seed runs and fails loud on any real error.
  key=""; \
  if [ -n "${TANREN_E2E_MANAGED_ROUTER_KEY:-}" ]; then \
    key="present-exported"; \
  elif [ -n "${TANREN_SECRET_ENV_FILE:-}" ] && [ -n "$(node scripts/dev/dotenv-extract.mjs "$TANREN_SECRET_ENV_FILE" TANREN_E2E_MANAGED_ROUTER_KEY 2>/dev/null)" ]; then \
    key="present-env-file"; \
  elif [ -n "$(node scripts/dev/dotenv-extract.mjs .env.validation.local TANREN_E2E_MANAGED_ROUTER_KEY 2>/dev/null)" ]; then \
    key="present-local"; \
  fi; \
  if [ -n "$key" ]; then \
    just seed-platform-creds; \
  else \
    echo "up-dev: TANREN_E2E_MANAGED_ROUTER_KEY not found in any source (exported env / TANREN_SECRET_ENV_FILE / .env.validation.local) — skipping platform-cred seed (managed mode unavailable until you run 'just seed-platform-creds')"; \
  fi

# Print the effective host-port set without bringing the stack up (the same
# computation as `up-dev` — per-port env override wins; otherwise default +
# TANREN_PORT_OFFSET). Useful when an operator wants to know which ports to
# curl against before kicking off a run.
ports:
  offset="${TANREN_PORT_OFFSET:-0}"; \
  : "${TANREN_ORCHESTRATOR_HOST_PORT:=$((3100 + offset))}"; \
  : "${TANREN_INTERNAL_MTLS_HOST_PORT:=$((3110 + offset))}"; \
  : "${TANREN_ALLOCATOR_HOST_PORT:=$((3200 + offset))}"; \
  : "${TANREN_POSTGRES_HOST_PORT:=$((5432 + offset))}"; \
  : "${TANREN_RUNNER_SSH_HOST_PORT:=$((2222 + offset))}"; \
  : "${TANREN_VAULT_HOST_PORT:=$((18200 + offset))}"; \
  : "${DASHBOARD_HOST_PORT:=$((3000 + offset))}"; \
  : "${TANREN_NTFY_HOST_PORT:=$((18080 + offset))}"; \
  : "${TANREN_REGISTRY_HOST_PORT:=$((5000 + offset))}"; \
  : "${TANREN_PUBLIC_BASE_URL:=http://localhost:${TANREN_ORCHESTRATOR_HOST_PORT}}"; \
  echo "orchestrator=$TANREN_ORCHESTRATOR_HOST_PORT internal-mtls=$TANREN_INTERNAL_MTLS_HOST_PORT allocator=$TANREN_ALLOCATOR_HOST_PORT postgres=$TANREN_POSTGRES_HOST_PORT runner-ssh=$TANREN_RUNNER_SSH_HOST_PORT vault=$TANREN_VAULT_HOST_PORT dashboard=$DASHBOARD_HOST_PORT ntfy=$TANREN_NTFY_HOST_PORT registry=$TANREN_REGISTRY_HOST_PORT public_base_url=$TANREN_PUBLIC_BASE_URL"

down-dev:
  docker compose -f compose.dev.yml down -v

# Tear down the dev stack and wipe its named volumes (postgres data, registry data,
# anonymous compose volumes). The complement to `just up-dev` — use when the schema /
# baseline migration is out of sync, when you need a fresh state for an e2e or apex
# run, or when an aborted `up-dev` left a stale container set. Safe to run when the
# stack is already down: we probe for containers in the compose project first and
# skip the `down -v` when there's nothing to remove (podman-compose otherwise emits
# ~5 "no container/no pod" stderr lines that look like failures but aren't).
#
# NOTE on `ps -q` (not `-aq`): podman-compose 1.5.0 rejects the `-a` flag on `ps`
# (Docker syntax; podman-compose ps lists running containers by default). `-q`
# alone returns running-container IDs — sufficient for "is anything live to tear
# down." If only stopped containers remain (rare; usually the prior `down` already
# cleaned them), the next `up-dev` will recreate over them.
stack-reset:
  if [ -n "$(docker compose -f compose.dev.yml ps -q 2>/dev/null)" ]; then \
    docker compose -f compose.dev.yml down -v --remove-orphans; \
  else \
    echo "stack-reset: no containers for this compose project — nothing to remove."; \
  fi

# Hosting/boot seeder for PLATFORM-scoped secret-store refs (deploy-layer config,
# NOT a tenant/userland credential route). Seeds the managed-LLM router key at
# `credential/openrouter/platform/default` so `providerMode: managed` runs can
# resolve it; a fresh `down-dev -v` wipes the dev Vault, leaving that ref unseeded
# and managed mode hard-failing (correctly, no silent fallback). Idempotent and
# fail-LOUD (`MissingSeedSecretError`) if NO source yields the key.
#
# PORTABLE key resolution (implemented in scripts/dev/seed-platform-creds.ts, so
# `just seed-platform-creds` and `just up-dev` behave identically):
#   1. an already-exported `TANREN_E2E_MANAGED_ROUTER_KEY` env var (highest);
#   2. else `TANREN_SECRET_ENV_FILE=<path>` — a secure env-file rendered by ANY
#      secret manager (sops / 1Password / Vault-agent / …). Only a fixed
#      allowlist of known keys is read from it — never arbitrary vars. Pass the
#      path as the recipe ARGUMENT: `just seed-platform-creds /path/to.env`;
#   3. else the plaintext-local `.env.validation.local` fallback (0600, symlinked
#      into cwd by `secrets-link`).
# Tanren is AGNOSTIC to who produces the env-file — no Nix/sops dependency here.
#
# Vault targeting: the seeder runs HOST-side, so it talks to the host-exposed dev
# Vault (default `http://127.0.0.1:18200`, `dev-root-token`). The manifest's own
# `VAULT_ADDR`/`VAULT_TOKEN` are the CONTAINER-internal view (`vault:8200`/
# `127.0.0.1:8200`) and must NOT leak into this host-side run — so the recipe
# hard-overrides Vault targeting via `TANREN_SEED_VAULT_ADDR`/`TANREN_SEED_VAULT_TOKEN`
# (override to point at a different Vault). Folded into `up-dev`; also runnable on
# demand after a rebuild.
#
# `env_file` (optional arg) sets TANREN_SECRET_ENV_FILE for this run; if already
# exported in the shell env it passes through unchanged when the arg is empty.
seed-platform-creds env_file="":
  TANREN_SECRET_ENV_FILE="{{ if env_file != "" { env_file } else { env_var_or_default("TANREN_SECRET_ENV_FILE", "") } }}" \
    TANREN_SECRET_STORE=vault \
    VAULT_ADDR="${TANREN_SEED_VAULT_ADDR:-http://127.0.0.1:18200}" \
    VAULT_TOKEN="${TANREN_SEED_VAULT_TOKEN:-dev-root-token}" \
    corepack pnpm exec tsx scripts/dev/seed-platform-creds.ts

# Preflight for an apex (or any dev-stack) run from this cwd. Verifies the
# canonical secrets layout is intact, required keys are present in `.env`,
# `.env.validation.local` exists if any TANREN_*_LIVE / TANREN_E2E_* flag is set
# in the current shell env, and the BYOK Codex `~/.codex/auth.json` is in place.
# Returns a clean go/no-go summary — fail-loud on any missing piece so an
# operator never starts an apex trial that will only halt mid-run for a
# missing secret. Read-only: doesn't mutate anything.
doctor:
  #!/usr/bin/env bash
  set -euo pipefail
  src="${TANREN_SECRETS_DIR:-$HOME/.config/tanren/secrets}"
  fail=0
  ok()  { echo "  ok   $1"; }
  bad() { echo "  FAIL $1" >&2; fail=1; }
  echo "doctor: canonical secrets dir = $src"
  if [ ! -d "$src" ]; then
    bad "secrets dir does not exist: $src (run 'just secrets-migrate' or create it)"
  else
    ok "secrets dir exists"
    perm="$(stat -c '%a' "$src")"
    if [ "$perm" != "700" ]; then
      bad "secrets dir perms are $perm; should be 700 (chmod 700 $src)"
    else
      ok "secrets dir perms 700"
    fi
  fi
  if [ ! -f "$src/.env" ]; then
    bad ".env missing at $src/.env"
  else
    ok ".env present"
    for k in DATABASE_URL VAULT_TOKEN TANREN_SECRET_STORE; do
      if ! grep -qE "^${k}=" "$src/.env"; then
        bad ".env missing required key: $k"
      else
        ok ".env has $k"
      fi
    done
    perm="$(stat -c '%a' "$src/.env")"
    if [ "$perm" != "600" ]; then
      bad ".env perms are $perm; should be 600 (chmod 600 $src/.env)"
    else
      ok ".env perms 600"
    fi
  fi
  if [ ! -L "./.env" ]; then
    if [ -f "./.env" ]; then
      bad "./.env is a real file, not a symlink — run 'just secrets-migrate' (from main checkout) then 'just secrets-link' here"
    else
      bad "./.env missing in cwd — run 'just secrets-link'"
    fi
  else
    ok "cwd ./.env is a symlink"
  fi
  needs_validation=0
  while IFS= read -r v; do
    case "$v" in
      TANREN_E2E_*|TANREN_*_LIVE|TANREN_CODEX_AUTH_JSON_FILE|TANREN_GITHUB_TOKEN_FILE)
        needs_validation=1; break;;
    esac
  done < <(env | cut -d= -f1)
  if [ "$needs_validation" -eq 1 ]; then
    if [ ! -f "$src/.env.validation.local" ]; then
      bad ".env.validation.local missing at $src (live/E2E flag set in shell env)"
    else
      ok ".env.validation.local present"
    fi
  else
    echo "  skip .env.validation.local (no TANREN_E2E_* / TANREN_*_LIVE in env)"
  fi
  if [ -f "$src/connections.manifest.local.yaml" ]; then
    ok "connections.manifest.local.yaml present"
  else
    echo "  note connections.manifest.local.yaml not in $src (needed for apex §4)"
  fi
  if [ -f "$HOME/.codex/auth.json" ]; then
    ok "~/.codex/auth.json present (BYOK Codex)"
  else
    echo "  note ~/.codex/auth.json missing (apex §3 BYOK will fail until you run 'codex login')"
  fi
  if [ "$fail" -ne 0 ]; then
    echo "" >&2
    echo "doctor: $fail check(s) FAILED. Fix and re-run." >&2
    exit 1
  fi
  echo ""
  echo "doctor: all checks passed."

# Prod profile: fails fast if required env is missing. Operator must run
# `just vault-init-prod` once before `just up-prod`. See
# docs/operator-guide/deploy.md.
up-prod:
  docker compose -f compose.prod.yml up -d postgres vault orchestrator worker dashboard ntfy

down-prod:
  docker compose -f compose.prod.yml down

# Operator-run once per fresh Vault: writes the GitHub OAuth client secret to
# the Vault path the orchestrator reads, and ensures per-service AppRoles
# exist. Idempotent.
vault-init-prod:
  ./scripts/vault-init/run.sh prod

# Backward-compat aliases for the Phase 1 recipe names.
compose-up: up-dev

compose-down: down-dev

wait-for-stack:
  orchestrator_port="${TANREN_ORCHESTRATOR_HOST_PORT:-$((3100 + ${TANREN_PORT_OFFSET:-0}))}"; ./scripts/wait-for-url.sh "http://localhost:${orchestrator_port}/healthz"
  dashboard_port="$(docker compose -f compose.dev.yml port dashboard 3000)"; \
    dashboard_port="${dashboard_port##*:}"; \
    ./scripts/wait-for-url.sh "http://localhost:${dashboard_port}/healthz"

# Stack connectivity smoke: the orchestrator's `/healthz` (DB + Vault) via the
# CLI `doctor`, plus raw SSH reachability of the runner container. This replaces
# the old `smoke-hello`, which drove a SYNTHETIC fake-adapter workflow that no
# longer exists in runtime source. The COMMAND SUBSTRATE path (the orchestrator's
# real SshCommandSubstrate) is proven separately by `smoke-ssh-integration`.
smoke-connectivity:
  TANREN_PUBLIC_BASE_URL="${TANREN_PUBLIC_BASE_URL:-http://localhost:${TANREN_ORCHESTRATOR_HOST_PORT:-$((3100 + ${TANREN_PORT_OFFSET:-0}))}}" corepack pnpm --filter @tanren/cli tanren doctor
  runner_port="${TANREN_RUNNER_SSH_HOST_PORT:-$((2222 + ${TANREN_PORT_OFFSET:-0}))}"; ssh -i "$TANREN_RUNTIME_DIR/tanren_runner_key" -p "$runner_port" -o StrictHostKeyChecking=no -o UserKnownHostsFile="$TANREN_RUNTIME_DIR/tanren_runner_known_hosts" tanren@localhost 'echo tanren-runner-ok'

smoke-ssh-integration:
  runner_port="${TANREN_RUNNER_SSH_HOST_PORT:-$((2222 + ${TANREN_PORT_OFFSET:-0}))}"; fingerprint="$(ssh-keyscan -p "$runner_port" -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; TANREN_SSH_INTEGRATION=1 TANREN_SSH_KEY_PATH="$TANREN_RUNTIME_DIR/tanren_runner_key" TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT="$runner_port" TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/ssh.integration.test.ts

# TOOLCHAIN ENFORCEMENT container proof (environment-management.md §3 Layer 1/2). The
# unit suite pins the provision command STRINGS; this is the only place their EFFECT on a
# real runner is proven — which is where the defect lived: the strings were right, the
# exit code was 0, and the repo got gated on a version it never declared. It drives the
# REAL SshCommandSubstrate against the SAME `runner` container `smoke-ssh-integration`
# uses (already built + healthy by then), so it costs one SSH session and NO image build.
#
# NOT OPT-IN, and deliberately so: this test's header used to claim "the container run is
# the proof" while nothing ran it, which is exactly the rot this recipe exists to stop.
smoke-toolchain-container:
  runner_port="${TANREN_RUNNER_SSH_HOST_PORT:-$((2222 + ${TANREN_PORT_OFFSET:-0}))}"; fingerprint="$(ssh-keyscan -p "$runner_port" -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; TANREN_TOOLCHAIN_CONTAINER=1 TANREN_SSH_KEY_PATH="$TANREN_RUNTIME_DIR/tanren_runner_key" TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT="$runner_port" TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/toolchainContainer.integration.test.ts services/orchestrator/tests/workspaceSetupContainer.integration.test.ts

# WRITER-COMMIT TOOLCHAIN container proof. The unit suite pins the command STRINGS; this
# is the only place their EFFECT on a real runner is proven — and the effect is the whole
# defect. Every string was already correct, `mise install` had already succeeded, and the
# writer's commit still died on `pnpm not found`, because the provisioned toolchain was
# never on PATH for the commit's subprocess. A string test cannot see PATH.
#
# It drives the REAL SshCommandSubstrate against the SAME `runner` container
# `smoke-ssh-integration` uses (already built + healthy by then), so it costs one SSH
# session and NO image build.
#
# NOT OPT-IN: a container proof nothing runs is a claim, not a proof.
smoke-writer-commit-hooks:
  runner_port="${TANREN_RUNNER_SSH_HOST_PORT:-$((2222 + ${TANREN_PORT_OFFSET:-0}))}"; fingerprint="$(ssh-keyscan -p "$runner_port" -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; TANREN_WRITER_COMMIT_CONTAINER=1 TANREN_SSH_KEY_PATH="$TANREN_RUNTIME_DIR/tanren_runner_key" TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT="$runner_port" TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/writerCommitToolchain.integration.test.ts

live-codex-writer:
  test -n "${TANREN_CODEX_AUTH_JSON_FILE:-}"
  fingerprint="$(ssh-keyscan -p 2222 -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; TANREN_CODEX_LIVE=1 TANREN_CODEX_AUTH_JSON_FILE="${TANREN_CODEX_AUTH_JSON_FILE}" TANREN_SSH_KEY_PATH="$TANREN_RUNTIME_DIR/tanren_runner_key" TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT=2222 TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/codexWriter.live.test.ts

live-codex-answerer:
  test -n "${TANREN_CODEX_AUTH_JSON_FILE:-}"
  fingerprint="$(ssh-keyscan -p 2222 -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; TANREN_CODEX_ANSWERER_LIVE=1 TANREN_CODEX_AUTH_JSON_FILE="${TANREN_CODEX_AUTH_JSON_FILE}" TANREN_SSH_KEY_PATH="$TANREN_RUNTIME_DIR/tanren_runner_key" TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT=2222 TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/codexAnswerer.live.test.ts

live-github-draft-pr:
  test -n "${TANREN_GITHUB_TOKEN_FILE:-}"
  test -n "${TANREN_GITHUB_REPO_URL:-}"
  fingerprint="$(ssh-keyscan -p 2222 -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; TANREN_GITHUB_LIVE=1 TANREN_GITHUB_TOKEN_FILE="${TANREN_GITHUB_TOKEN_FILE}" TANREN_GITHUB_REPO_URL="${TANREN_GITHUB_REPO_URL}" TANREN_GITHUB_BASE_BRANCH="${TANREN_GITHUB_BASE_BRANCH:-main}" TANREN_SSH_KEY_PATH="$TANREN_RUNTIME_DIR/tanren_runner_key" TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT=2222 TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/githubDraftPr.live.test.ts

live-ci-poll:
  test -n "${TANREN_GITHUB_TOKEN_FILE:-}"
  TANREN_GITHUB_TOKEN_FILE="${TANREN_GITHUB_TOKEN_FILE}" corepack pnpm exec vitest run services/orchestrator/tests/ciPolling.test.ts -t "live CI polling fixture"

live-phase1-fixture:
  test -n "${TANREN_CODEX_AUTH_JSON_FILE:-}"
  test -n "${TANREN_GITHUB_TOKEN_FILE:-}"
  test -n "${TANREN_GITHUB_REPO_URL:-}"
  fingerprint="$(ssh-keyscan -p 2222 -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_PHASE1_FIXTURE_LIVE=1 TANREN_CODEX_AUTH_JSON_FILE="${TANREN_CODEX_AUTH_JSON_FILE}" TANREN_GITHUB_TOKEN_FILE="${TANREN_GITHUB_TOKEN_FILE}" TANREN_GITHUB_REPO_URL="${TANREN_GITHUB_REPO_URL}" TANREN_GITHUB_BASE_BRANCH="${TANREN_GITHUB_BASE_BRANCH:-main}" TANREN_SSH_KEY_PATH="$TANREN_RUNTIME_DIR/tanren_runner_key" TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT=2222 TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/phase1Fixture.live.test.ts

# RLS wave R1 behavior proof against the real Postgres the smoke stack runs.
# Provisions an ephemeral DB on the server, migrates it as owner, then connects
# as the restricted `tanren_app` role to prove the org session context + that
# the role can do every existing operation while no policies are present.
# DATABASE_URL is the OWNER/superuser connection (the migration role).
smoke-rls-r1:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR1SessionContext.integration.test.ts

# RLS wave R2 cohort-1 behavior proof: the runs + events read/write loaders run
# through the org-scoped client (inert — no policies), identical to the pool.
# Same ephemeral-DB + restricted-role harness as R1.
smoke-rls-r2:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR2DalRunsEvents.integration.test.ts

# RLS wave R2 cohort-2 behavior proof: the tasks + cost_records read/write sites
# run through the org-scoped client (inert — no policies), identical to the pool.
# Same ephemeral-DB + restricted-role harness as R1 / cohort-1.
smoke-rls-r2-cohort2:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR2DalTasksCosts.integration.test.ts

# RLS wave R2 cohort-3 behavior proof: the specs + runners read/write sites + the
# worker failure-path finalize UPDATE run through the org-scoped client (inert —
# no policies), identical to the pool. Same ephemeral-DB + restricted-role
# harness as R1 / cohort-1 / cohort-2.
smoke-rls-r2-cohort3:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR2DalSpecsRunnersFinalizers.integration.test.ts

# RLS wave R2 cohort-4 (FINAL) behavior proof: the forge stores —
# forge_threads / forge_turns / forge_action_proposals reads + writes — run
# through the org-scoped client (inert — no policies), identical to the pool.
# Same ephemeral-DB + restricted-role harness as R1 / cohort-1/2/3. After this
# all conversion cohorts are complete; only R3 (policies + role flip) remains.
smoke-rls-r2-cohort4:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR2DalForge.integration.test.ts

# RLS wave R3a behavior proof: the residual cohort-4-flagged tenant-table sites
# — the forge read/write tool dispatchers + `engine/recovery`'s
# openInspectionThread + the narration insights-cache read — now run through the
# org-scoped client (inert — no policies), identical to the pool, and
# openInspectionThread stamps forge_threads.org_id. Same ephemeral-DB +
# restricted-role harness as R1 / R2 cohorts. After this every REQUEST-reachable
# tenant query carries context; the worker per-job WORKFLOW execution is the one
# remaining surface to scope before R3b (see ROADMAP.md).
smoke-rls-r3a:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR3aResidualSites.integration.test.ts

# RLS wave R3a-worker behavior proof: the per-job WORKFLOW execution carries org
# context on EVERY tenant-table op (tasks / events / cost_records). Installs a
# temporary GUC-keyed policy on the restricted `tanren_app` role and proves the
# worker's actual store helpers, run under `runWithJobOrgId` + `orgScopingPool`,
# write rows the policy admits (every op set the GUC), while the bare-pool
# no-job-org fallback is rejected (empty GUC). Final conversion gating R3b. Same
# ephemeral-DB + restricted-role harness as R1 / R2 cohorts / R3a.
smoke-rls-r3a-worker:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR3aWorkerScoping.integration.test.ts

# RLS wave R3b ENFORCEMENT proof: runs the REAL migration (which enables RLS +
# policies on every tenant table and creates the tanren_app / tanren_system
# roles), then connects as the restricted `tanren_app` role and proves DB-level
# two-org isolation — org A sees zero of org B's rows, an unset GUC returns zero
# (deny-by-default), a WITH CHECK write for the wrong org is rejected, a
# correctly-scoped read/write is unchanged, and the BYPASSRLS `tanren_system`
# role reads across orgs (the documented carve-out). Same ephemeral-DB harness
# as R1 / R2 / R3a. DATABASE_URL is the OWNER/superuser connection.
smoke-rls-r3b:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR3bEnforcement.integration.test.ts

# RLS early-failure finalize proof: a run that throws BEFORE the per-job org
# scope is established (a credential-free run → MissingCredential during context
# hydration) must still reach a terminal FINALIZED state, not get stuck `queued`.
# Runs the REAL migration (RLS enabled), drives the worker's real claim→execute
# path on the restricted `tanren_app` pool, and asserts the run lands `halted` —
# the early-failure finalize now org-scopes from the CLAIMED org so the policy
# admits its UPDATE. Same ephemeral-DB + restricted-role harness as the R-wave
# cohorts. Regression lock for fix/rls-early-failure-finalize-scope.
smoke-rls-early-finalize:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsEarlyFailureFinalize.integration.test.ts

# RLS org-creation bootstrap proof: org creation is a tenant BOOTSTRAP that
# precedes any org scope — signup / dev-login / onboarding call
# IdentityStore.upsertIdentity (→ upsertOrg + ensureOrgMembership) with no
# `app.current_org_id`, so under enforced RLS the deny-by-default policy rejected
# the `organizations` / `org_members` INSERT with 42501 (signup 500'd). Runs the
# REAL migration (RLS enabled), then under the restricted `tanren_app` role
# proves: an org-creating signup on the bare app pool is REJECTED (42501), the
# SAME signup SUCCEEDS via the BYPASSRLS `tanren_system` pool (the bootstrap
# routes through runWithSystemScope), and READS stay under RLS — the new org is
# visible only in its own org scope, not on the unset-GUC pool nor another org's
# scope. Same ephemeral-DB + restricted-role harness as the R-wave cohorts.
# Regression lock for fix/rls-org-creation-bootstrap-scope.
smoke-rls-org-bootstrap:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsOrgCreationBootstrap.integration.test.ts

# RLS operator/control-plane flow (real PG, enforced `tanren_app` role): drives
# the LITERAL operator walk live validation found broken — dev-login bootstrap →
# list MY orgs (user-scoped `runWithSystemScope` read) → read org config → pass
# the org-access gate (proves `resolveActorContext` saw the membership) → create
# + list a project (org-scoped CRUD via the per-request scope + `orgScopingPool`)
# → create + list a spec. Every step must succeed under enforcement; pre-fix the
# actor resolved with no org scope and the `/orgs/:orgId/*` routes 403'd / read
# empty. Regression lock for fix/rls-operator-routes-scope.
smoke-rls-operator-flow:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsOperatorFlow.integration.test.ts

# RLS HTTP-route scoping (real PG, enforced `tanren_app` role): drives the FULL
# operator→run flow live validation walked, across ALL route shapes — including
# the RESOURCE-keyed root routes #181 left unscoped. bootstrap (multi-org) →
# list orgs → import + LIST credentials (non-empty) → create project → create
# spec → trigger run via `POST /specs/:specId/runs` (the live `spec_not_found`
# 404; MUST 201) → read run status `GET /runs/:runId` → read events → recovery
# surface. The user is MULTI-org so the sole-org fallback cannot fire — the
# resource→org middleware arm is what scopes the resource routes. Pre-fix the
# resource-keyed steps 404 under enforcement. Regression lock for
# fix/rls-http-route-scoping-complete.
smoke-rls-http-route-scoping:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsHttpRouteScoping.integration.test.ts

# Production org-cost HTTP route proof (real PG, enforced `tanren_app` role):
# full auth middleware + production repositories, exact dual int64 cursor,
# repeatable-read/read-only snapshot, cost truth, and rollback-on-decode failure.
smoke-rls-org-costs:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/orgCosts.rls.integration.test.ts

# RLS full-run-lifecycle scoping proof: a REAL org-scoped run drives the REAL
# allocator + runner allocation + the whole plan→write→check→audit→PR→CI→review→
# merge→finalize loop on the enforced `tanren_app` role, with a DETERMINISTIC fake
# harness + stubbed SSH/GitHub transports. Asserts EVERY tenant write (runners,
# tasks, events, cost_records, specs, runs) is admitted by RLS — the coverage gap
# the system/bypass hello smoke never hit, where the runner-allocation INSERT (run
# OUTSIDE an open connection scope) was RLS-denied in live validation. Runs the
# REAL migration (RLS enabled). Regression lock for fix/rls-run-lifecycle-scoping.
smoke-rls-run-lifecycle:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsRunLifecycleScoping.integration.test.ts

# Workstream D de-priv proof: the STANDALONE allocator service's PgRunnerStore
# writes the tenant `runners` row INSIDE the run's org scope (restricted app-role
# pool via `runWithOrgScope`) — visible under that org, zero under another, and a
# wrong-org write RLS-denied — while the cross-org sweeper/release path stays on
# the BYPASSRLS system pool. Runs the REAL migration (RLS enabled).
smoke-rls-allocator:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/allocator/tests/pgRunnerStore.rls.integration.test.ts

# Event-integrity regression: the standalone allocator writes its validated
# allocator.allocated event with an explicit org_id, and PgEventStore prior
# events stamp their supplied org directly so a foreign org reads zero rows.
smoke-rls-event-integrity:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/allocator/tests/pgRunnerStore.rls.integration.test.ts services/orchestrator/tests/eventStorePriorEvents.rls.integration.test.ts

# Environment management (env P3): the `environments` registry DAL (migration
# 0001_environments_registry, RLS) — `env_key` content-key resolution + capability
# query under org scope, the cross-org `official` read tier, and the org-scoped WITH
# CHECK on writes. Same TANREN_RLS_DB_TEST gate.
smoke-rls-environments:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/environmentRegistry.integration.test.ts

# Native design subsystem (WS-D1, native-design-subsystem.md): the `design_contracts`
# DAL (migration 0010_design_contracts, RLS) — the versioned, org-scoped `DesignContract`
# entity. create/get/getLatest/listVersions round-trip + versioning (max+1) under org
# scope, deny-by-default isolation (org A never sees org B; unscoped sees ZERO), and the
# org-scoped WITH CHECK on writes. Same TANREN_RLS_DB_TEST gate as the other RLS smokes.
smoke-rls-design-contracts:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/designContractRegistry.integration.test.ts

# DS-0: design-system foundation live RLS proof — design_systems + release/artifact
# tables org-scoped (create/get/version round-trip, cross-org isolation, unscoped sees
# ZERO), asserted as the runtime `tanren_app` role. Same TANREN_RLS_DB_TEST gate.
smoke-rls-design-foundation:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/designSystemStore.rls.integration.test.ts

# bh-1 back-half foundation (migration 0049_issue_loop, RLS + append-only trigger) — the
# durable IssueLoop aggregate + immutable source_findings. Proves create+append+read-back
# under org scope, cross-org isolation (org B sees ZERO of org A; unscoped sees ZERO), the
# org-scoped WITH CHECK on writes, and the append-only trigger that refuses UPDATE/DELETE of
# an existing finding. Same TANREN_RLS_DB_TEST gate as the other RLS smokes.
smoke-rls-issue-loop:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/issueLoopStore.rls.integration.test.ts

# bh-2 — normalized spec-origin provenance plus the real issue-loop-bound triage
# task and cost row, asserted as the restricted tanren_app role on a fresh DB.
smoke-rls-spec-origins:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/specOrigins.rls.integration.test.ts

# P8b: the e2e gate's ARTIFACT-READ teeth against a real Postgres. The `just e2e`
# harness reads the real persisted run / cost_records / DORA rows via
# `readRunArtifacts`; this proves that SQL actually returns a seeded merged run
# (not just asserts verdict logic over hand-built evidence). Provisions an
# ephemeral DB, migrates it, seeds a minimal `done` run (outcome + pr_url) + a
# cost_records row, and asserts `readRunArtifacts` returns it. Gated behind the
# same TANREN_RLS_DB_TEST switch as the RLS integration smokes; the credentialed
# CASES themselves run only under `just e2e`.
smoke-e2e-artifacts:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run tests/e2e/lib/readRunArtifacts.db.test.ts

# §6.2 (apex pre-run audit): the production `PgBudgetGate.resolveBudget` SQL against
# a real Postgres — the $50-ceiling enforcement's OBSERVATION surface (the org-scoped
# cost-sum + project-over-org ceiling + the fail-closed unpriced/unparseable paths).
# The budget PREDICATES + the resume are unit/route-pinned over a fake gate; this
# proves the real gate reads the right state from seeded rows. Gated like the RLS smokes.
smoke-budget-gate:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/pgBudgetGate.integration.test.ts

# §5 cutover gate (tanren-owns-the-engine §5): the frozen MergeAuthority fail-closed
# truth table driven against the REAL writer-backed LandFinalizer over a real Postgres
# — a clean land flows authorize → CodeHost.landAuthorizedRef (the ff-only CAS) →
# durable finalize (merge.completed + spec `merged` in ONE transaction). Includes the
# THREE audit-7 P0 regression locks (unknown-mergeability blocks; a post-land finalize
# failure reconciles to merge_state_unknown; a changes_requested review → needs_attention).
# Provisions an ephemeral DB + migrates it; gated behind the same TANREN_RLS_DB_TEST switch.
smoke-merge-authority:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/mergeAuthority.writerBacked.integration.test.ts services/orchestrator/tests/mergeAuthorityLandFinalizer.test.ts

# P1 #1021: the merge-authority bundle's run/project bootstrap executes through
# the BYPASSRLS system pool when the worker itself is the NOBYPASSRLS app role.
smoke-rls-merge-bundle-scope:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/mergeAuthorityBundleBuild.rls.integration.test.ts

# Plane-split P1 cross-process proof: the run-executor worker is a STANDALONE
# deployable. Seeds a queued plan job against the shared Postgres (the same
# job_queue insert the control-plane API does), then waits for the SEPARATE
# `worker` compose container to claim + execute + finalize it across the
# API↔worker process boundary — read back under the RLS-enforced `tanren_app`
# runtime role. No worker runs in-process here; if the `worker` service were
# down the job would stay queued and this smoke would time out. Credential-free,
# so the worker lands the run in a recoverable `halted` state — the proof is the
# boundary crossing + the worker-written terminal state, not a green run. See
# ROADMAP.md.
smoke-plane-split-worker:
  internal_mtls_port="${TANREN_INTERNAL_MTLS_HOST_PORT:-$((3110 + ${TANREN_PORT_OFFSET:-0}))}"; postgres_port="${TANREN_POSTGRES_HOST_PORT:-$((5432 + ${TANREN_PORT_OFFSET:-0}))}"; TANREN_CLAIM_ENDPOINT_SMOKE_URL="https://localhost:${internal_mtls_port}" TANREN_APP_DATABASE_URL="${TANREN_APP_DATABASE_URL:-postgres://tanren_app:tanren_app@localhost:${postgres_port}/tanren}" DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:${postgres_port}/tanren}" corepack pnpm exec tsx scripts/smoke/plane-split-worker.ts

# Plane-split P3 (real PG, enforced RLS): the control-plane run-state WRITE
# endpoints + the writers. Proves authn-reject, that append-event / record-cost /
# finalize-run persist the SAME rows server-side under the run's org scope, that
# finalize is exactly-once (a retried finalize is a no-op), and that the DEFAULT
# DirectRunStateWriter persists byte-identical rows in-process. Same ephemeral-DB
# + restricted-role harness as the R-wave cohorts. DATABASE_URL is the owner.
smoke-plane-split-p3:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/planeSplitP3RemoteWrites.integration.test.ts

# Plane-split P3b (real PG): the DE-PRIVILEGE proof. Migrates a fresh DB (creates
# the `tanren_dataplane` role + drops event/cost WRITE grants), then proves under
# that role: direct INSERT INTO events / cost_records is REJECTED for the privilege
# (42501), org-scoped event/cost READS are kept, and the control-plane
# `tanren_app` role can still insert the same event (contrast). The serialized
# recovery suites additionally prove exact atomic park and tenant-bound successor
# evidence. DATABASE_URL is the owner.
smoke-plane-split-p3b:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --maxWorkers=1 services/orchestrator/tests/planeSplitP3bDeprivilege.integration.test.ts services/orchestrator/tests/recoveryParkAtomic.rls.integration.test.ts services/orchestrator/tests/recoveryEvidencePg.rls.integration.test.ts services/orchestrator/tests/recoveryPreparationAtomic.rls.integration.test.ts services/orchestrator/tests/terminalInfrastructureRecovery.rls.integration.test.ts

# Plane-split P3c (real PG): the run/spec/task LIFECYCLE de-privilege proof.
# Migrates a fresh DB (0035 drops the data plane's runs/specs/tasks WRITE grants),
# then proves under `tanren_dataplane`: a direct UPDATE runs / UPDATE specs /
# INSERT|UPDATE tasks is REJECTED for the privilege (42501), the SELECT on all
# three is kept, and the control-plane `tanren_app` role CAN run the same writes
# (so the lifecycle still works through the control plane). DATABASE_URL is owner.
smoke-plane-split-p3c:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/planeSplitP3cDeprivilege.integration.test.ts

# Plane-split P3b cross-process CUTOVER proof. The compose `worker` now DEFAULTS
# to the de-privileged `tanren_dataplane` role + remote-writes ON, so the regular
# `smoke-plane-split-worker` already runs the cutover topology; this recipe makes
# it explicit + adds the LIVE negative test: connect to the running stack as
# `tanren_dataplane` and confirm a direct tenant-table write (events) is denied by
# Postgres. Recreates the worker (idempotent, same defaults) so the stack is
# restored.
smoke-plane-split-worker-remote-writes: runner-key gen-mtls-certs
  # PRIVATE key via the mounted compose secret file (see up-dev); only the PUBLIC
  # authorized_keys line is env.
  TANREN_RUNNER_AUTHORIZED_KEY="$(cat "$TANREN_RUNTIME_DIR/tanren_runner_key.pub")" docker compose -f compose.dev.yml up -d --no-deps --force-recreate worker
  internal_mtls_port="${TANREN_INTERNAL_MTLS_HOST_PORT:-$((3110 + ${TANREN_PORT_OFFSET:-0}))}"; postgres_port="${TANREN_POSTGRES_HOST_PORT:-$((5432 + ${TANREN_PORT_OFFSET:-0}))}"; TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE=1 TANREN_CLAIM_ENDPOINT_SMOKE_URL="https://localhost:${internal_mtls_port}" TANREN_APP_DATABASE_URL="${TANREN_APP_DATABASE_URL:-postgres://tanren_app:tanren_app@localhost:${postgres_port}/tanren}" DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:${postgres_port}/tanren}" corepack pnpm exec tsx scripts/smoke/plane-split-worker.ts

# IN-1: fresh ephemeral database proof for all lifecycle RLS/FK boundaries and
# for migration-chain ordering. The RLS file proves tenant isolation under the
# restricted `tanren_app` role; the migration-order file proves chain 0000->0043
# applies cleanly on an empty PostgreSQL database and that the composite
# org-qualified FKs/unique keys materialize and reject wrong-org/cross-binding
# rows. Both files share the same owner/superuser DATABASE_URL +
# TANREN_RLS_DB_TEST=1 harness; the migration-order test manages its own
# ephemeral database + cleanup (same pattern as the lifecycle RLS proof).
smoke-rls-integration-lifecycle:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/integrationLifecycleRls.integration.test.ts services/orchestrator/tests/integrationLifecycleMigrationOrder.integration.test.ts services/orchestrator/tests/integrationLifecycleLineageFk.integration.test.ts services/orchestrator/tests/integrationConnectionSaga.integration.test.ts services/orchestrator/tests/integrationConnectionSagaFailures.integration.test.ts services/orchestrator/tests/integrationOperationDurability.integration.test.ts services/orchestrator/tests/integrationStateWriter.rls.integration.test.ts

# IN-14: BindingMaterializer live proofs — a resolved binding materializes an
# immutable generation + integration_binding_env shape + provisioned
# project_app_env with a project-scoped, least-privilege Vault ref per secret;
# identical content is idempotent (same generation), changed content mints the
# next; a missing secret fails closed with no partial write; rows are org-scoped
# (cross-org zero); and the live deploy-path reconcile re-materializes ready
# bindings idempotently and fails closed on a revoked secret.
smoke-rls-binding-materializer:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/bindingMaterializer.rls.integration.test.ts

# RV-4: behavior-coverage affected-selection live proofs — the 0044 composite
# (org_id, project_id) project-lineage FK rejection + the production
# HTTP -> PgCasByteStore -> PgEventStore -> replay path against real Postgres.
smoke-rls-behavior-coverage:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/behaviorCoverageRls.integration.test.ts services/orchestrator/tests/behaviorCoverageProduction.integration.test.ts

# MQ-1/MQ-2: merge-queue authority live RLS proofs — org-scoped signal
# classification (mq-1) + multi-member evaluation list/detail + cross-org 404
# parity (mq-2) against real Postgres.
smoke-rls-merge-queue-authority:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/mergeQueueAuthoritySignals.rls.integration.test.ts services/orchestrator/tests/mergeQueueAuthorityEvaluations.rls.integration.test.ts services/orchestrator/tests/integrationNodeMaterializer.rls.integration.test.ts

# IN-1: real Vault 1.18 KV v2 CAS=0 wire proof. The compose dev Vault exposes
# its dev listener on TANREN_VAULT_HOST_PORT (default 18200).
smoke-integration-vault-cas:
  TANREN_VAULT_TEST=1 VAULT_ADDR="http://127.0.0.1:${TANREN_VAULT_HOST_PORT:-18200}" VAULT_TOKEN="${VAULT_TOKEN:-dev-root-token}" corepack pnpm exec vitest run services/orchestrator/tests/integrationVaultCas.integration.test.ts

# GV-7: governance policy revision store live RLS + append-only proof — org-scoped
# INSERT-only writes under FORCE RLS (0047), cross-org reads see zero rows, and the
# BEFORE UPDATE/DELETE trigger rejects mutation of a persisted revision.
smoke-rls-governance-policy:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_GV7_PG_TEST=1 corepack pnpm exec vitest run services/orchestrator/src/engine/governance/policyRevisionStore.rls.test.ts

# IN-3: integration-events read surface live RLS proof — the GET …/integration-events
# route returns only the caller org/project's events; a foreign org sees zero rows.
smoke-rls-integration-events:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/integrationEventsRead.rls.integration.test.ts

# IN-7: integration fragment F2 authoring live RLS proof — the POST …/integrations/derive
# seam authors a MISSING provider integration definition via the shared kernel, then a
# foreign org + unscoped read see zero rows and the durable integration.author.* events land.
smoke-rls-integration-fragments:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/integrationFragmentsRls.integration.test.ts



# bh-4: immutable SymptomContractV1 store proof — deterministic canonical hash,
# append-only state snapshots, fragment binding, frozen transition events, and
# org isolation under the restricted tanren_app role.
smoke-rls-symptom-contracts:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/symptomContractStore.rls.integration.test.ts

# bh-10: the production replay's false-green catch binds one live production
# release URL/digest pair and proves generic green checks cannot mask a broken
# symptom assertion. Runs under the restricted app role on a fresh database.
smoke-rls-production-verification:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/productionSymptomStage.rls.integration.test.ts

# BH-3: webhook intake hardening live RLS proof — idempotent redelivery no-op +
# claim-lease + expired-claim reclaim + cross-org isolation.
smoke-rls-webhook-intake:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/webhookIntakeHardening.rls.integration.test.ts

# MQ-4: live restricted-role proof for scoped leases and poison-member isolation.
smoke-rls-merge-partitions:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/mergeQueuePartitions.rls.integration.test.ts

# WAVE-4 barrier claims these RLS smoke recipe names before their owning lanes
# supply the tests. Each lane replaces only its PLACEHOLDER path.
smoke-rls-symptom-evidence:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/symptomProbe.rls.integration.test.ts

# bh-8: baseline reproduction finalization accepts only its baseline row and
# matching resolution-job lineage under the restricted application role.
smoke-rls-baseline-reproduction:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/baselineReproduction.rls.integration.test.ts

# bh-9: release_instances isolation is asserted against the real enforced policy
# as the restricted tanren_app role. Org A's raw scoped read sees only its row;
# cross-org and unscoped reads see ZERO rows.
smoke-rls-release-instances:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/releaseInstances.rls.integration.test.ts

smoke-rls-issue-source:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/issueSourceSync.rls.integration.test.ts

smoke-rls-source-sync-worker:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/sourceSyncWorker.rls.integration.test.ts

smoke-rls-land-groups:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/landGroups.rls.integration.test.ts

smoke-rls-governance-tiers:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/governanceTiers.rls.integration.test.ts

# WAVE-5 barrier claims gv-9's RLS smoke name before its lane wires the real
# effective_policy_snapshots cross-org isolation test.
smoke-rls-governance-bindings:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/governanceBindings.rls.integration.test.ts

# WAVE-6 barrier claims the four lane-owned RLS smoke recipe names. Each owning
# lane replaces only its no-op body once its live conformance proof lands.
smoke-rls-fixture-leases:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/fixtureLeases.rls.integration.test.ts

smoke-rls-effect-observations:
  TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/effectObserver.rls.integration.test.ts

# rv-substrate hardening (#1043 + #1065): false-green pass gate + append-only
# verdict/run/assertion ledger, proven as the non-superuser tanren_app role.
smoke-rls-verdict-substrate:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/behaviorVerdictSubstrate.rls.integration.test.ts

# rv-1 immutable behavior revisions + spec binding: drives the real spec-freeze
# entry point (deriveBehaviorSpec) as tanren_app, proving the content-addressed
# mint→bind, idempotent re-mint, supersede-on-change, the 0090 content-immutability
# trigger (raw UPDATE/DELETE rejected), fail-closed binding, and org isolation.
smoke-rls-behavior-revision-mint:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/behaviorRevisionMint.rls.integration.test.ts

# rv-11 A1 executable-acceptance orchestrator: drives the real orchestrator +
# store + fixture-lease + conformance driver end-to-end as tanren_app, proving the
# false-green pass gate, the append-only verdict ledger, and org isolation.
smoke-rls-acceptance-orchestrator:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/acceptanceOrchestrator.rls.integration.test.ts

# rv-12 A3 causal-correlation: drives the real orchestrator + real correlation +
# the real rv-8 immutable effect evidence + PgCausalEffectReader as tanren_app,
# proving a correlated set records a passed verdict, a different-cause effect is
# never counted, and cross-org effect isolation.
smoke-rls-causal-correlation:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/acceptanceCausalCorrelation.rls.integration.test.ts
# rv-19 post-merge production re-proof + rollback: proves a FAILED re-proof reverts
# the live release_instances pointer to the prior known-good release (never leaves the
# broken release live), a PASSED re-proof promotes, inconclusive holds fail-closed,
# and the decision is idempotent + org-isolated — all as the restricted tanren_app role.
smoke-rls-post-merge-reproof:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/postMergeReproof.rls.integration.test.ts services/orchestrator/tests/postMergeReproofWalker.rls.integration.test.ts

# rv-16a persisted post-merge PRODUCTION behavior verdict: the LIVE resolution-walker path drives
# the run's declared behaviors' rv-11 acceptance (DEFAULT real HTTP driver + real Pg resolver +
# real loader) over the live release as tanren_app, PERSISTING a real behavior_verdict (purpose
# post_merge_production) FK'd to the deploy-created env — a 200-but-broken behavior persists
# failed_product, and a prior passed + post-merge failed_product forms the passed→failed signal.
smoke-rls-post-merge-behavior-verdict:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/postMergeBehaviorAcceptance.rls.integration.test.ts

# rv-6 A2 acceptance plan loader: compiles the stored behavior_revisions.acceptance
# spec into the executable plan under org scope as tanren_app, proving faithful
# compilation and that a cross-org load sees ZERO rows (fails loud, no fabricated plan).
smoke-rls-acceptance-plan-loader:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/acceptancePlanLoader.rls.integration.test.ts

# rv-3: verification-fragment registry + F2 authoring — the plan loader F2-authors a
# cited-but-missing capability, atomically registers + versions it, binds it into the
# plan (behavior_verification_plans + verification_plan_fragments), all as tanren_app;
# a resolve/load under another org sees zero rows.
smoke-rls-verification-fragment-registry:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/verificationFragmentRegistry.rls.integration.test.ts

# rv-6 A2 end-to-end: the prod execute-behaviors route drives the DEFAULT real HTTP
# driver + real Pg release resolver + real loader against a live server as tanren_app,
# proving a correct product passes and a broken expectation fails_product (no fabrication).
smoke-rls-acceptance-execute-behaviors:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/acceptanceExecuteBehaviors.rls.integration.test.ts

# rv-18 A2 proof-backed demo: drives the real ProofBackedWebDemo (DEFAULT real HTTP driver
# + real Pg release resolver + real loader) over the run's real release_instances row
# against a live server as tanren_app, proving the demo verdict IS the real per-behavior
# verdict (a 200 product with a broken behavior → failed_product, never a reachability
# green) and that a cross-org demo sees ZERO of the run's release + behaviors.
smoke-rls-proof-backed-demo:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/proofBackedWebDemo.rls.integration.test.ts

smoke-rls-integration-proof-units:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/integrationProofUnits.rls.integration.test.ts

smoke-rls-repo-visibility:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/repositoryVisibilityObservations.rls.integration.test.ts

# Back-half self-healing cluster barrier claims the serialized node-owned RLS
# smoke names. Each owner replaces only its no-op body when its live proof lands.
smoke-rls-resolution-jobs:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/resolutionJobs.rls.integration.test.ts

smoke-rls-resolution-walker:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/resolutionDagWalker.rls.integration.test.ts

smoke-rls-resolution-decisions:
  just smoke-rls-resolution-authority

smoke-rls-resolution-authority:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/resolutionAuthority.rls.integration.test.ts

smoke-rls-remediation-attempts:
  just smoke-rls-repair-routing

# bh-13: actual tanren_app RLS proof for blocked-decision P0 successor routing.
smoke-rls-repair-routing:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/repairRouting.rls.integration.test.ts

# bh-14a: live proof-seal path — blocked + verified_closed terminals seal a
# tamper-evident hash-chain; badges stay separate; append-only + cross-org isolated.
smoke-rls-resolution-proof:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/resolutionProof.rls.integration.test.ts

smoke-rls-self-healing-funnel:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/selfHealingFunnel.rls.integration.test.ts

# rv-env: the deploy path is the producer of `verification_environments`. Proves a
# release going live find-or-creates the ready env, a post-deploy acceptance run
# persists a REAL immutable behavior verdict against it, re-deploy is idempotent,
# a passed verdict still needs full coverage, and envs are org-isolated.
smoke-rls-deploy-verification-environment:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/deployVerificationEnvironment.rls.integration.test.ts

smoke-rls-proof-bundle:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/proofBundleExport.rls.integration.test.ts

smoke: compose-build compose-up wait-for-stack smoke-connectivity smoke-ssh-integration smoke-toolchain-container smoke-writer-commit-hooks smoke-plane-split-worker smoke-plane-split-worker-remote-writes smoke-plane-split-p3 smoke-plane-split-p3b smoke-plane-split-p3c smoke-rls-r1 smoke-rls-r2 smoke-rls-r2-cohort2 smoke-rls-r2-cohort3 smoke-rls-r2-cohort4 smoke-rls-r3a smoke-rls-r3a-worker smoke-rls-r3b smoke-rls-early-finalize smoke-rls-org-bootstrap smoke-rls-operator-flow smoke-rls-http-route-scoping smoke-rls-org-costs smoke-rls-run-lifecycle smoke-rls-issue-loop smoke-rls-spec-origins smoke-rls-integration-lifecycle smoke-rls-binding-materializer smoke-rls-integration-fragments smoke-rls-behavior-coverage smoke-rls-merge-queue-authority smoke-integration-vault-cas smoke-rls-allocator smoke-rls-event-integrity smoke-rls-environments smoke-rls-design-contracts smoke-rls-governance-policy smoke-rls-design-foundation smoke-rls-integration-events smoke-rls-webhook-intake smoke-rls-merge-partitions smoke-rls-governance-bindings smoke-e2e-artifacts smoke-budget-gate smoke-merge-authority smoke-rls-merge-bundle-scope smoke-rls-symptom-contracts smoke-rls-production-verification smoke-rls-symptom-evidence smoke-rls-baseline-reproduction smoke-rls-issue-source smoke-rls-source-sync-worker smoke-rls-land-groups smoke-rls-governance-tiers smoke-rls-fixture-leases smoke-rls-effect-observations smoke-rls-integration-proof-units smoke-rls-repo-visibility smoke-rls-resolution-jobs smoke-rls-resolution-decisions smoke-rls-resolution-authority smoke-rls-remediation-attempts smoke-rls-release-instances smoke-rls-resolution-walker smoke-rls-resolution-proof smoke-rls-self-healing-funnel smoke-rls-verdict-substrate smoke-rls-behavior-revision-mint smoke-rls-acceptance-orchestrator smoke-rls-causal-correlation smoke-rls-post-merge-reproof smoke-rls-acceptance-plan-loader smoke-rls-verification-fragment-registry smoke-rls-acceptance-execute-behaviors smoke-rls-proof-backed-demo smoke-rls-deploy-verification-environment smoke-rls-proof-bundle # rv-24: exportable proof bundle — org-scoped export assembles a tamper-evident bundle # from the real persisted acceptance rows; a failed verdict stays failed; cross-org sees zero. smoke-rls-proof-bundle: DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/proofBundleExport.rls.integration.test.ts smoke-rls-post-merge-behavior-verdict smoke-rls-verification-reads smoke-rls-proof-dashboard
# rv-24: exportable proof bundle — org-scoped export assembles a tamper-evident bundle
# from the real persisted acceptance rows; a failed verdict stays failed; cross-org sees zero.
# rv-22: runtime-verification HTTP read surface — real Hono route → real DB → real
# response, a failed verdict stays failed, cross-org reads see zero rows.
smoke-rls-verification-reads:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/verificationReads.rls.integration.test.ts

# rv-23: runtime-verification DASHBOARD read surface — real Hono route → real DB →
# real response for the Behavior Proof Matrix + the effect-causality, design-render,
# regression-bisection and flake-quarantine surfaces; a failed/quarantined state
# stays as-is (never laundered green); cross-org reads see zero rows on every surface.
smoke-rls-proof-dashboard:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run --no-file-parallelism services/orchestrator/tests/proofDashboardReads.rls.integration.test.ts


# P3-0001: the Phase 2A direct-execution acceptance gate (`just acceptance`,
# scripts/acceptance/easy.ts + medium.ts) was removed once the run executor
# landed. The system is now only ever exercised through the real
# dequeue→execute path (the standalone background run worker service). The
# per-tier persisted-state ASSERTIONS still ship as CI dry-run smokes
# (services/orchestrator/tests/phase2Acceptance{Easy,Medium}.test.ts) which
# import scripts/acceptance/common.ts. Component-level live smokes
# (live-codex-*, live-github-*, live-ci-poll, live-phase1-fixture) remain.

# P3-0026: the final v0 acceptance HARD tier. Runs the DETERMINISTIC hard-tier
# test — the real runPlannerLoopWorkflow through the worker's claim→execute seam
# (executeNextPlanJob) with adapters/gate/review/merge probes scripted to force
# a planner re-plan, an auditor rejection loop, and a conflict-resolution merge.
# No live Codex/SSH/GitHub. The live fixture-hard scenario (triggered through the
# dashboard/API while the standalone worker service is running) is documented in
# docs/operator-guide/acceptance.md.
acceptance-hard:
  corepack pnpm exec vitest run services/orchestrator/tests/acceptanceHardTier.test.ts

# P8b: the real-resource, real-CREDENTIAL e2e gate (autonomy-engine §8b). OPT-IN /
# nightly / pre-release — NOT on the per-PR fast path: it runs the REAL stack
# (`just up-dev`) with REAL provider + GitHub credentials, spends real credits +
# wall-clock, and drives the REAL operator flow over the REAL external surfaces
# only (HTTP API + dashboard). It FORBIDS test fixtures / mock adapters entirely —
# the `e2e-no-mock-imports` arch check (in `just architecture`, on the fast path)
# fails any tests/e2e/** file that imports a fixture/mock or a non-public internal
# seam. Each case asserts on REAL persisted artifacts (a merged PR on GitHub, the
# implemented file on the base branch, cost_records rows with a real basis, the
# DORA projection) — never on a mocked return; its result (run IDs + PR URLs) is
# the release evidence. NEVER runs in public PR CI (no secrets there — same
# discipline as `just acceptance`). Credentials live in tanren.acceptance.json +
# TANREN_E2E_API_TOKEN; the stack must be up first (`just up-dev`). The harness's
# own unit tests run on the fast path via `just test` (tests/e2e/lib/**). See
# docs/operator-guide/e2e.md.
e2e:
  test -f tanren.acceptance.json || test -n "${TANREN_ACCEPTANCE_CONFIG:-}"
  test -n "${TANREN_E2E_API_TOKEN:-}"
  corepack pnpm exec vitest run --config vitest.e2e.config.ts
