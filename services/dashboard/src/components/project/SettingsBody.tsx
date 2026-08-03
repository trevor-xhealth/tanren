/**
 * Routing settings. Renders the 6-role fallback-chain editor, the Vault per-cred
 * policy panel (read-only), the credentials binding, and the conditional
 * audit-gate caption — all generated from the routing schema (`RoutingTable`). v0
 * ships only functional Codex bindings, but the editor handles 1..N-entry chains
 * for every role and any provider the schema accepts.
 *
 * Mutations are server-side form POSTs to this spec's own settings routes
 * (add / remove / reorder a chain entry). Each POST loads the merged config,
 * applies the edit, and PATCHes it back via the product API. No PR is opened —
 * the audit-gate caption defaults to the "edits land in the dashboard" state.
 *
 * The escape-hatches editor is GONE (apex v35): there are no hardcoded attempt
 * caps to tune — convergence is intelligent non-convergence detection (the shared
 * `convergenceDetector`), not an operator-set count.
 */

import {
  ROLE_IDS,
  type CredentialRecord,
  type ProjectSummary,
  type RoleId,
  type RoutingTable,
} from "../../api/types.js";
import { CsrfField } from "../shell/CsrfField.js";
import { ScreenStyles } from "./screenStyles.js";
import { PageHead } from "./shared.js";

/** Responsibility text per role, surfaced in each role header (hi-fi copy). */
export const ROLE_DESCRIPTIONS: Record<RoleId, string> = {
  plan: "spec → ordered subtasks · runs once per loop",
  write: "writer subtasks · heaviest spend · longest fallback ok",
  check: "verify per-subtask · cheap model preferred",
  audit: "spec-level verdict · strongest reasoning model · no dev bundles",
  demo: "spec-completion narration for review · cheap, optional",
  forge: "read-only narration with operator write-buttons · config edits land via this surface",
};

interface VaultEntry {
  label: string;
  path: string;
  policy: string;
  detail: string;
}

/**
 * Vault per-cred policy display. v0 surfaces the Codex session-cookie
 * entry as the wired credential; other rows describe their rotation policy.
 * Read-only — no values rendered (only paths + policy). A later surface reads these
 * from the live Vault policy API.
 */
const VAULT_ENTRIES: VaultEntry[] = [
  {
    label: "codex chatgpt bundle",
    path: "vault://dev/codex/chatgpt",
    policy: "auto-refresh on use",
    detail: "session cookie refreshes on each runner launch · no manual rotation needed",
  },
  {
    label: "github app",
    path: "vault://org/github/app",
    policy: "auto · jwt + installation token",
    detail: "short-lived tokens minted per call · jwt rotates yearly",
  },
];

export interface SettingsBodyProps {
  project: ProjectSummary;
  routing: RoutingTable;
  orgId: string;
  /** Org audit-gate flag. On → Bucket-B writes route through a PR. */
  auditGate: boolean;
  /** The configured tanren-config repo (`owner/name`), when the gate is set. */
  auditGateRepo?: string;
  /** True after a successful save; renders the saved banner. */
  saved?: boolean;
  /** Org-scoped credential refs, used to populate the binding dropdowns. */
  orgCredentials?: CredentialRecord[];
  /** The project's currently-bound credentials (default LLM entry + github ref). */
  boundCredentials?: {
    defaultLlm?: { cli: string; model?: string; authRef: string };
    githubCredentialRef?: string;
  };
  /** Session CSRF for pure HTML form posts (cookie-authenticated writes). */
  csrfToken?: string;
}

export function SettingsBody(props: SettingsBodyProps) {
  return (
    <div class="p2b">
      <ScreenStyles />
      <PageHead
        eyebrow="▮ settings · routing & limits"
        title={
          <>
            routing, <em>fallbacks</em>
          </>
        }
        sub={
          props.auditGate ? (
            <>config committed via pr · forge can edit</>
          ) : (
            <>{props.project.name} · routing · stored in dashboard</>
          )
        }
      />
      <div class="page-body">
        {props.saved === true && <div class="form-ok">configuration saved · applies to the next live run</div>}
        <div class="settings-grid">
          <div>
            <RoutingPanel {...props} />
          </div>
          <div>
            <VaultPanel />
          </div>
        </div>
        <CredentialsPanel {...props} />
        <AuditGatePanel {...props} />
      </div>
    </div>
  );
}

function RoutingPanel(props: SettingsBodyProps) {
  return (
    <div class="panel">
      <div class="panel-head">
        <h3>
          routing · <em>role → fallback chain</em>
        </h3>
        <span class="meta">(cli · model · auth) tuples · reorder &amp; add fallbacks</span>
      </div>
      <div class="panel-body">
        {ROLE_IDS.map((role) => (
          <RoleRow
            role={role}
            chain={props.routing[role]?.chain ?? []}
            orgId={props.orgId}
            projectId={props.project.projectId}
            csrfToken={props.csrfToken}
          />
        ))}
        <div class="audit-caption" style="margin-top:8px">
          ↑ auth refs point at vault entries from org setup · only codex bindings function in v0
        </div>
      </div>
    </div>
  );
}

function RoleRow(props: {
  role: RoleId;
  chain: { cli: string; model?: string; authRef: string; healthHint?: string }[];
  orgId: string;
  projectId: string;
  csrfToken?: string;
}) {
  const base = `/settings/routing/${props.projectId}`;
  return (
    <div class="routing-role">
      <div class="role-head">
        <span class="role">▸ {props.role}</span>
        <span class="desc">{ROLE_DESCRIPTIONS[props.role]}</span>
      </div>
      {props.chain.length === 0 ? (
        <div class="empty-note">no entries · falls back to org default · add a codex binding below</div>
      ) : (
        props.chain.map((entry, index) => (
          <div class={`routing-row${index === 0 ? " first" : ""}`}>
            <span class="rank">{index === 0 ? "preferred" : `↓ ${index + 1}`}</span>
            <span class="cli">{entry.cli}</span>
            {/* An absent model is the routing schema's "use this provider's pinned
                default" — rendered as such, never as a placeholder model id. */}
            <span class="model">{entry.model ?? "provider default"}</span>
            <span class="auth">{entry.authRef}</span>
            <span class={`health ${entry.healthHint ?? "ok"}`}>
              {entry.healthHint === "rate_limited" ? "rate-limited" : (entry.healthHint ?? "ok")}
            </span>
            <span class="acts">
              {index > 0 && (
                <form method="post" action={`${base}/reorder`}>
                  <CsrfField token={props.csrfToken} />
                  <input type="hidden" name="orgId" value={props.orgId} />
                  <input type="hidden" name="role" value={props.role} />
                  <input type="hidden" name="index" value={String(index)} />
                  <input type="hidden" name="direction" value="up" />
                  <button type="submit" title="move up">
                    ↑
                  </button>
                </form>
              )}
              {index < props.chain.length - 1 && (
                <form method="post" action={`${base}/reorder`}>
                  <CsrfField token={props.csrfToken} />
                  <input type="hidden" name="orgId" value={props.orgId} />
                  <input type="hidden" name="role" value={props.role} />
                  <input type="hidden" name="index" value={String(index)} />
                  <input type="hidden" name="direction" value="down" />
                  <button type="submit" title="move down">
                    ↓
                  </button>
                </form>
              )}
              <form method="post" action={`${base}/remove`}>
                <CsrfField token={props.csrfToken} />
                <input type="hidden" name="orgId" value={props.orgId} />
                <input type="hidden" name="role" value={props.role} />
                <input type="hidden" name="index" value={String(index)} />
                <button type="submit" title="remove">
                  ×
                </button>
              </form>
            </span>
          </div>
        ))
      )}
      <form class="add-fallback" method="post" action={`${base}/add`}>
        <CsrfField token={props.csrfToken} />
        <input type="hidden" name="orgId" value={props.orgId} />
        <input type="hidden" name="role" value={props.role} />
        <input type="text" name="cli" placeholder="cli (e.g. codex)" required />
        {/* NOT `required`: leaving the model blank stores an entry with no `model`,
            which the routing schema reads as "use this provider's pinned default". */}
        <input type="text" name="model" placeholder="model (blank = provider default)" />
        <input type="text" name="authRef" placeholder="auth ref (vault://…)" required />
        <button type="submit">+ add fallback</button>
      </form>
    </div>
  );
}

function VaultPanel() {
  return (
    <div class="panel">
      <div class="panel-head">
        <h3>
          vault · <em>per-cred policy</em>
        </h3>
        <span class="meta">rotation is contextual · no values rendered</span>
      </div>
      <div class="panel-body">
        {VAULT_ENTRIES.map((entry) => (
          <div class="vault-card">
            <div class="top">
              <span class="label">{entry.label}</span>
              <span class="state">ok</span>
            </div>
            <div class="path">{entry.path}</div>
            <div class="policy">↻ {entry.policy}</div>
            <div class="detail">{entry.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Credentials binding. Two dropdowns — Codex + GitHub — populated
 * from the org's credential REFERENCES (never values), persisting the chosen
 * refs into project config via the settings PATCH path. An empty selection
 * clears the binding so the run falls back to the org default. No secret value
 * is ever rendered — only the ref string + kind.
 */
function CredentialsPanel(props: SettingsBodyProps) {
  const records = props.orgCredentials ?? [];
  const codexOptions = records.filter((r) => r.kind === "codex_chatgpt_auth");
  const githubOptions = records.filter((r) => r.kind === "github_token");
  return (
    <div class="panel" style="margin-top:14px">
      <div class="panel-head">
        <h3>
          credentials · <em>codex + github binding</em>
        </h3>
        <span class="meta">refs only · no values · empty = inherit org default</span>
      </div>
      <div class="panel-body">
        <div class="audit-caption" style="margin-bottom:8px">
          bind the run's codex bundle + github token · import new ones under{" "}
          <a href="/onboarding/credentials">credentials ↗</a>
        </div>
        <form method="post" action={`/settings/routing/${props.project.projectId}/credentials`}>
          <CsrfField token={props.csrfToken} />
          <input type="hidden" name="orgId" value={props.orgId} />
          <div class="settings-grid">
            <CredentialSelect
              name="codexCredentialRef"
              label="codex bundle"
              options={codexOptions}
              selected={props.boundCredentials?.defaultLlm?.authRef}
              emptyNote="no codex bundles in this org yet"
            />
            <CredentialSelect
              name="githubCredentialRef"
              label="github token"
              options={githubOptions}
              selected={props.boundCredentials?.githubCredentialRef}
              emptyNote="no github tokens in this org yet"
            />
          </div>
          <div class="head-actions" style="margin-top:12px">
            <button class="btn primary" type="submit">
              save credentials
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CredentialSelect(props: {
  name: string;
  label: string;
  options: CredentialRecord[];
  selected?: string;
  emptyNote: string;
}) {
  return (
    <div class="field">
      <label for={props.name}>{props.label}</label>
      <select id={props.name} name={props.name}>
        <option value="" selected={props.selected === undefined || props.selected === ""}>
          — inherit org default —
        </option>
        {props.options.map((record) => (
          <option value={record.ref} selected={record.ref === props.selected}>
            {record.ref}
          </option>
        ))}
      </select>
      {props.options.length === 0 ? <div class="audit-caption">{props.emptyNote}</div> : null}
    </div>
  );
}

/**
 * The "tell forge to change config" panel. The caption is conditional on the
 * org audit-gate flag: on → "edits land as a pr in <org>/tanren-config"; off
 * (the v0 default) → "edits land in the dashboard · no PR required". The
 * audit-gate toggle itself is hidden in v0. The natural-language input is a
 * stub (full Forge config-edit PRs are a later surface).
 */
function AuditGatePanel(props: SettingsBodyProps) {
  return (
    <div class="forge-card" style="margin-top:14px">
      <div class="forge-input" style="border-top:none">
        <span class="stamp">鍛</span>
        <input placeholder={`"swap audit primary to a different cli" · "add a claude fallback to write"`} disabled />
        <span class="kbd">↵</span>
      </div>
      <div class="panel-body" style="padding-top:0">
        {props.auditGate ? (
          <div class="audit-caption">
            edits land as a pr in <code>{props.auditGateRepo ?? "your tanren-config repo"}</code> · review before merge
            · <a href="/settings/config">view config gate ↗</a>
          </div>
        ) : (
          <div class="audit-caption">edits land in the dashboard · no pr required (audit gate off)</div>
        )}
        <form
          method="post"
          action="/settings/config/toggle"
          class="audit-toggle"
          style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"
        >
          <CsrfField token={props.csrfToken} />
          <input type="hidden" name="enable" value={props.auditGate ? "0" : "1"} />
          {!props.auditGate && (
            <input
              name="repo"
              placeholder="owner/tanren-config"
              value={props.auditGateRepo ?? ""}
              style="font-family:var(--font-mono);font-size:12px;padding:5px 8px;border:1px solid var(--line-2);border-radius:6px;background:transparent;color:var(--fg-1)"
            />
          )}
          <button class="btn primary notched" type="submit">
            {props.auditGate ? "disable audit gate" : "enable audit gate ↗"}
          </button>
        </form>
      </div>
    </div>
  );
}
