// BUDGET-SAFETY: the run-setup budget preflight. A configured DOLLAR ceiling is
// only meaningful over a route that can produce — and be judged against — real
// dollars. There are TWO ways that fails, and they are symmetric opposites:
//
//   (M6) UNREACHABLE — a subscription (codex/ChatGPT) or self-hosted credential has
//        NO per-call dollar basis and accrues cost_usd only when a usage probe wires
//        the ccusage/credit-drawdown reconcile at run end
//        (subtaskAccounting.observeRunAccounting). With NO probe the run accrues zero
//        dollars, the budget sum stays $0, and the gate NEVER fires — silent
//        UNDER-enforcement.
//
//   (NEW) UNENFORCEABLE — a per_token credential on a route with NO real-spend
//        capture path. Every call records cost_usd = NULL with billing_mode
//        'per_token', which is exactly what `dag/budgetGate.ts` counts as `unpriced`
//        and fails CLOSED on (BUDGET-SAFETY C1b). Because the offending rows are the
//        RUN'S OWN, the pause is UNCLEARABLE — raising the ceiling changes nothing.
//        The run spends real, uncounted money and THEN parks forever.
//
// The prior version of this file handled only the first, and its comment asserted
// that "a per_token credential prices every call from the provider table
// (reachable)". That is STALE: the static rate table is gone (REAL SPEND IS A FACT,
// costs/sources.ts), so a per_token credential prices NOTHING without a captured
// fact. That stale assumption is the second failure mode above.
//
// Both now fail CLOSED at SETUP — before a runner is burned and before a single
// uncounted dollar is spent — with a loud, secret-free event and an error that
// names the remedy. See docs/_design/openrouter-cost-attribution.md.
import type { BudgetGate } from "../contracts/dagWalker.js";
import { classifyAuthRef, refKindOf } from "../costs/sources.js";
import { isCeilingEnforceable, resolveRouteMetering, type RouteMetering } from "../costs/meterability.js";
import type { AppendEvent } from "./subtaskLoop.js";

/**
 * Raised when a run is set up with a configured dollar ceiling the run's route
 * cannot honour. Two shapes, distinguished by `kind`:
 *
 *   - `unreachable`   — the ceiling can never FIRE (subscription/self-hosted, no
 *                       probe): silent under-enforcement.
 *   - `unenforceable` — the ceiling fires PERMANENTLY and unclearably (a per_token
 *                       route with no real-spend capture): a self-inflicted deadlock.
 *
 * Carries the secret-free ref KIND only, never the credential value.
 */
export class UnenforceableBudgetCeilingError extends Error {
  readonly refKind: string;
  readonly billingMode: string;
  readonly kind: "unreachable" | "unenforceable";
  constructor(input: { refKind: string; billingMode: string; kind: "unreachable" | "unenforceable"; message: string }) {
    super(input.message);
    this.name = "UnenforceableBudgetCeilingError";
    this.refKind = input.refKind;
    this.billingMode = input.billingMode;
    this.kind = input.kind;
  }
}

/**
 * The original M6 error name, retained so existing catchers/tests keep working. It
 * is the `unreachable` shape of {@link UnenforceableBudgetCeilingError}.
 */
export class UnreachableBudgetCeilingError extends UnenforceableBudgetCeilingError {
  constructor(refKind: string, billingMode: string) {
    super({
      refKind,
      billingMode,
      kind: "unreachable",
      message:
        `configured dollar ceiling is unreachable for credential kind '${refKind}' (billing_mode=${billingMode}): ` +
        `a subscription/self-hosted credential accrues no per-call dollars and no usage probe is wired to reconcile ` +
        `real cost, so the ceiling can never fire — wire a usage probe or remove the dollar ceiling`,
    });
    this.name = "UnreachableBudgetCeilingError";
  }
}

export interface BudgetPreflightInput {
  /** The configured dollar ceiling, or undefined when no budget is set (unlimited). */
  ceilingUsd: number | undefined;
  /** The harness that will make the spend-bearing calls (the writer's cli). */
  cli: string;
  /** The run's PRIMARY credential ref (the writer's authRef). */
  authRef: string;
  /** Whether a usage probe is wired for this run (reconciles real subscription cost). */
  hasUsageProbe: boolean;
}

/**
 * Narrate the run's metering posture, ceiling or no ceiling. An operator on an
 * UNBUDGETED project gets no signal today that `cost_usd` will be NULL for the
 * entire run — they find out when a spend report reads $0. This says it once, up
 * front, in the run's own timeline. A meterable route emits nothing (the working
 * path stays quiet).
 */
export async function narrateRouteMetering(
  input: Pick<BudgetPreflightInput, "cli" | "authRef" | "hasUsageProbe">,
  appendEvent: AppendEvent,
): Promise<RouteMetering> {
  const metering = resolveRouteMetering(input);
  if (metering.kind === "unmeterable") {
    await appendEvent("cost.route_unmeterable", {
      cli: input.cli,
      refKind: refKindOf(input.authRef),
      reason: metering.reason,
      detail: metering.detail,
    });
  }
  return metering;
}

/**
 * Run the ceiling preflight. Emits a loud, secret-free event (naming the ref KIND
 * only) and throws so the run fails CLOSED at setup when either failure mode
 * applies. Every other combination (no ceiling, or a route that can both accrue and
 * be judged in dollars) is a no-op — the run proceeds normally.
 */
export async function assertBudgetCeilingEnforceable(
  input: BudgetPreflightInput,
  appendEvent: AppendEvent,
): Promise<void> {
  // No ceiling configured ⇒ nothing to enforce (unlimited, today's behavior).
  if (input.ceilingUsd === undefined) {
    return;
  }
  const refKind = refKindOf(input.authRef);
  const metering = resolveRouteMetering(input);
  // `isCeilingEnforceable` is the SEMANTIC gate (one place decides what makes a
  // ceiling enforceable); the `kind` check is the type narrowing that gives us
  // `reason`/`detail`. Keeping both means a future third enforceability rule changes
  // only meterability.ts.
  if (!isCeilingEnforceable(metering) && metering.kind === "unmeterable") {
    // The DEADLOCK case. Refusing here is strictly better than the alternative:
    // no runner is burned and no uncounted money is spent, and the operator is
    // told the one remedy that actually works.
    const remedy =
      metering.reason === "harness_discards_generation_id"
        ? "set the spend limit on the OpenRouter API key itself (OpenRouter enforces it at the biller), or remove the tanren dollar ceiling for this project"
        : "remove the tanren dollar ceiling for this project and cap spend at the provider, whose invoice is the only place this credential's real cost appears";
    await appendEvent("cost.ceiling_unenforceable", {
      refKind,
      cli: input.cli,
      billingMode: "per_token",
      ceilingUsd: input.ceilingUsd,
      reason: metering.reason,
      detail: metering.detail,
      remedy,
    });
    throw new UnenforceableBudgetCeilingError({
      refKind,
      billingMode: "per_token",
      kind: "unenforceable",
      message:
        `configured dollar ceiling ($${input.ceilingUsd}) cannot be ENFORCED over the ${input.cli} × '${refKind}' ` +
        `route: ${metering.detail}. Every call therefore records cost_usd = NULL with billing_mode='per_token', ` +
        `which the budget gate counts as unpriced spend and fails CLOSED on — and because those rows are the run's ` +
        `OWN, RAISING THE CEILING WILL NOT CLEAR THE PAUSE. Refusing at setup rather than spending uncounted money ` +
        `and then deadlocking. Remedy: ${remedy}`,
    });
  }
  // A usage probe reconciles ccusage/credit-drawdown dollars at run end, so a
  // subscription credential CAN accrue cost — the ceiling is reachable.
  if (input.hasUsageProbe) {
    return;
  }
  const classification = classifyAuthRef(input.authRef);
  // Only subscription / self-hosted credentials have NO per-call dollar basis and
  // no probe to reconcile one. (An unrecognized ref is handled separately — C1:
  // cost.unattributed + the fail-closed gate.)
  if (classification.billingMode !== "subscription" && classification.billingMode !== "self_hosted") {
    return;
  }
  await appendEvent("cost.ceiling_unreachable", {
    refKind,
    billingMode: classification.billingMode,
    ceilingUsd: input.ceilingUsd,
    reason:
      "a configured dollar ceiling cannot fire against a subscription/self-hosted credential with no usage probe (no per-call dollar basis)",
  });
  throw new UnreachableBudgetCeilingError(refKind, classification.billingMode);
}

/**
 * The production wiring the run-setup path calls: resolve the project's configured
 * ceiling (via the org-scoped {@link BudgetGate} seam), narrate the route's metering
 * posture unconditionally, then run the enforceability assert against the run's
 * primary credential + whether a usage probe is wired. Throws
 * {@link UnenforceableBudgetCeilingError} (after a loud event) when the ceiling is
 * structurally unreachable OR unenforceable; a no-op otherwise. Kept here so
 * plannerRun.ts threads it in one call.
 */
export async function runBudgetCeilingPreflight(
  budgetGate: BudgetGate,
  projectId: string,
  cli: string,
  authRef: string,
  hasUsageProbe: boolean,
  appendEvent: AppendEvent,
): Promise<void> {
  const budget = await budgetGate.resolveBudget(projectId);
  // Narrate FIRST and unconditionally — an unbudgeted run's NULL-cost posture is
  // just as invisible to an operator as a budgeted one's, and it does not throw.
  await narrateRouteMetering({ cli, authRef, hasUsageProbe }, appendEvent);
  await assertBudgetCeilingEnforceable({ ceilingUsd: budget.ceilingUsd, cli, authRef, hasUsageProbe }, appendEvent);
}
