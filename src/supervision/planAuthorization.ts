/**
 * THE RESOURCE AUTHORISED MUST BE THE RESOURCE THAT CAN ACTUALLY EXECUTE.
 *
 * TASK-014 round-2 review, finding 2 (CRITICAL), second half. The supervisor
 * routes a roadmap item to ONE provider/model/effort, probes it, puts that exact
 * resource through the financial gate, and records it as provenance. A PLAN
 * carries its OWN persisted execution configuration — a planner, an implementer
 * and a reviewer, each with its own tool and model — and the engineering loop
 * launches those, not the supervisor's choice.
 *
 * Nothing reconciled the two. So a supervisor could authorise `claude-code/opus`
 * against a policy that permits it, drive a plan whose implementer is
 * `codex-cli/gpt-5.6-luna`, and record `claude-code/opus` as what ran. The gate
 * would have decided about a resource that never executed, and the audit trail
 * would name a resource that never executed. A gate that authorises X while Y
 * runs is worse than no gate, because it produces evidence that the wrong thing
 * was checked.
 *
 * THIS MODULE DOES NOT REPAIR THE MISMATCH — it REFUSES it. Substituting a
 * provider, rewriting the plan's configuration, or re-routing to whatever the
 * plan declares would all be this layer granting authority it does not have.
 * The only safe answer to "these disagree" is "do not launch, and say exactly
 * how they disagree".
 *
 * WHAT THIS COSTS, stated plainly because it is a real limitation and not a
 * detail (docs/KNOWN-LIMITATIONS.md L-12): the supervisor authorises ONE
 * resource per action, and a plan declares up to three. A plan whose implementer
 * and reviewer are different models — the normal shape, and the one C4 requires
 * for critical work — therefore cannot be driven by this supervisor at all. It
 * reports a refusal naming both sides. Closing that needs the supervisor's gate
 * to authorise a SET of resources, which is TASK-006's design and not something
 * this task may quietly change.
 */

import type { Plan, PlannerConfig } from "../planning/planTypes.js";
import type { AiRunConfigRecord } from "./modelEnforcement.js";
import type { AuthorizedResource } from "./supervisorPorts.js";

/** One AI resource a plan can launch, named by the role that launches it. */
export interface DeclaredPlanResource {
  readonly role: "planner" | "implementer" | "reviewer";
  readonly tool: string;
  readonly model: string;
  readonly effort?: string;
}

export type PlanAuthorizationVerdict =
  | { readonly ok: true; readonly resources: readonly DeclaredPlanResource[] }
  | { readonly ok: false; readonly reason: string };

function describe(role: DeclaredPlanResource["role"], config: PlannerConfig): DeclaredPlanResource {
  return {
    role,
    tool: config.tool,
    model: config.model,
    ...(config.effort === undefined ? {} : { effort: config.effort }),
  };
}

/**
 * Every AI resource driving this plan can launch.
 *
 * THE PLANNER IS INCLUDED, and that is deliberate rather than careless.
 * `PlanningService.resume()` calls `drive()`, which LOOPS over `stepFor(plan)`
 * for whatever phase each step produces, and the CLI that runs it constructs the
 * planner worker from `plan.planner` before any of that starts. Arguing that no
 * transition out of APPROVED/MATERIALIZING/EXECUTING can reach `stepPlanner` is
 * an argument about reachability — and a fail-closed gate must not rest on an
 * argument when it can rest on the configuration itself. If the planner is
 * constructed, it counts.
 */
export function declaredPlanResources(plan: Plan): readonly DeclaredPlanResource[] {
  return [
    describe("planner", plan.planner),
    describe("implementer", plan.execution.implementer),
    describe("reviewer", plan.execution.reviewer),
  ];
}

function format(resource: DeclaredPlanResource): string {
  return `${resource.tool}/${resource.model}${resource.effort === undefined ? "" : ` (effort ${resource.effort})`}`;
}

function formatAuthorization(config: AiRunConfigRecord): string {
  return `${config.effectiveProvider}/${config.effectiveModel}${
    config.effectiveEffort === undefined ? "" : ` (effort ${config.effectiveEffort})`
  }`;
}

/**
 * How a declared resource differs from the authorised one, or `undefined` when
 * it does not.
 *
 * EFFORT is compared as strictly as provider and model, with one documented
 * equivalence: when NEITHER side names an effort, both take the provider CLI's
 * own default — and since the provider and model already match, that default is
 * the same one. Two absent values are therefore genuinely equal here, rather
 * than two unknowns being waved through. Every other combination — one side
 * naming an effort the other does not, or two different efforts — is a
 * difference, because the run would use a setting the gate never saw.
 */
function difference(resource: DeclaredPlanResource, config: AiRunConfigRecord): string | undefined {
  if (resource.tool !== config.effectiveProvider) {
    return `provider ${resource.tool} was not authorized (${config.effectiveProvider} was)`;
  }
  if (resource.model !== config.effectiveModel) {
    return `model ${resource.model} was not authorized (${config.effectiveModel} was)`;
  }
  if (resource.effort !== config.effectiveEffort) {
    return `effort ${resource.effort ?? "(provider default)"} was not authorized (${
      config.effectiveEffort ?? "(provider default)"
    } was)`;
  }
  return undefined;
}

/**
 * May this plan be launched under this authorization?
 *
 * Called IMMEDIATELY BEFORE the launch rather than anywhere earlier. A guard
 * placed at the moment of the action cannot be skipped by a caller that reaches
 * the action along some other path — the same reasoning that puts the
 * supervisor's billing-mode probe immediately before its financial gate instead
 * of at the top of the tick.
 */
/**
 * Does the AUTHORISED SET cover this resource? (TASK-015 AC-6)
 *
 * Membership is exact: same provider, same model, same effort. There is no
 * "same provider, therefore allowed" — a provider is not a resource, and a gate
 * that cleared `claude-code/opus` says nothing about `claude-code/sonnet`.
 */
function coveredBy(resource: DeclaredPlanResource, authorized: readonly AuthorizedResource[]): boolean {
  return authorized.some(
    (entry) =>
      entry.provider === resource.tool && entry.model === resource.model && entry.effort === resource.effort,
  );
}

export function checkPlanAuthorization(
  plan: Plan,
  config: AiRunConfigRecord | undefined,
  authorized?: readonly AuthorizedResource[],
): PlanAuthorizationVerdict {
  const resources = declaredPlanResources(plan);

  /**
   * THE SET IS THE AUTHORITY WHEN THERE IS ONE (TASK-015).
   *
   * Round-2 built this gate against a SINGLE authorised record. That was
   * correct, and round-3 review then showed it unusable: a supervisor
   * authorising one resource can never drive a plan whose reviewer differs from
   * its implementer, which is the shape C4 REQUIRES for critical work.
   *
   * With a set, every declared role must be a MEMBER. Nothing is looser — a
   * resource absent from the set is refused exactly as it was when the set had
   * one element — and the set exists only because each member went through the
   * supervisor's probe and financial gate individually.
   *
   * A SUPPLIED set is the authority even when it is EMPTY (round-13
   * finding 4). `[]` used to fall through to the legacy singleton, so a
   * caller that explicitly authorized NOTHING had its plan driven on the
   * routed record anyway. An empty set is a statement — this action may
   * launch no resources — and every declared role must therefore refuse.
   * Only an ABSENT set means the caller predates sets and falls back to the
   * single-record check below.
   */
  if (authorized !== undefined) {
    for (const resource of resources) {
      if (!coveredBy(resource, authorized)) {
        return {
          ok: false,
          reason:
            `plan ${plan.id} would run its ${resource.role} on ${format(resource)}, which is not in the set this ` +
            `action authorized (${authorized.length === 0 ? "an explicitly empty set" : authorized.map((entry) => `${entry.provider}/${entry.model}`).join(", ")}). ` +
            `Refusing to launch: every resource that can actually execute must have been probed and gated, and ` +
            `this one was not`,
        };
      }
    }
    return { ok: true, resources };
  }

  if (config === undefined) {
    /**
     * NO AI RESOURCE WAS AUTHORISED AT ALL.
     *
     * `WorkExecutionInput.config` is absent for DETERMINISTIC work, which needs
     * no provider — so nothing was routed, nothing was probed for its billing
     * mode, and nothing went through the financial gate. Driving a plan launches
     * real AI workers regardless, which is exactly the launch
     * `AUTONOMOUS_SPEND_LIMIT = 0` depends on never happening unexamined.
     */
    return {
      ok: false,
      reason:
        `plan ${plan.id} would launch ${resources.map(format).join(", ")}, but this action authorized no AI resource ` +
        `(it was routed as work that needs none), so no financial gate has decided about any of them`,
    };
  }

  if (config.verification === "MISMATCH") {
    return {
      ok: false,
      reason: `the authorization for plan ${plan.id} is recorded MISMATCH (${config.note}), so it states nothing about what may run`,
    };
  }

  for (const resource of resources) {
    const problem = difference(resource, config);
    if (problem !== undefined) {
      return {
        ok: false,
        reason:
          `plan ${plan.id} would run its ${resource.role} on ${format(resource)}, but this action authorized ` +
          `${formatAuthorization(config)}: ${problem}. Refusing to launch: the resource a financial gate ` +
          `authorized must be the resource that can actually execute, and substituting either side would make ` +
          `the provenance record describe a run that did not happen`,
      };
    }
  }

  return { ok: true, resources };
}
