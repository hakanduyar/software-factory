/**
 * Applies status transitions to work items.
 *
 * This service is the only component allowed to change a WorkItem status. It
 * takes no worker output as input: a worker result can never be an argument
 * to a transition, which is how "protected gates cannot be bypassed by a
 * worker result" is enforced structurally rather than by convention.
 *
 * Every transition is checked in a fixed order: (1) the transition table
 * itself, (2) trusted human authorization where the rule demands it, (3) the
 * BLOCKED resume-to-origin rule, (4) the protected gate, bound to the current
 * plan identity or release snapshot, (5) the real-evidence precondition. Any
 * failure returns/throws before the work item is touched, so `transition`
 * never returns a partially applied item.
 */

import type { Actor } from "../domain/actor.js";
import { workItemSubject } from "../domain/approval.js";
import { deepFreeze } from "../domain/freeze.js";
import { HumanIdentityError, InvalidTransitionError, PreconditionNotMetError } from "../domain/errors.js";
import type { TrustedHumanToken } from "../domain/humanIdentity.js";
import { isTerminal, type WorkItemStatus } from "../domain/status.js";
import type { StatusChange, WorkItem } from "../domain/workItem.js";
import type { Clock } from "../ports/clock.js";
import type { HumanIdentityGate } from "../ports/humanIdentityGate.js";
import { evaluateGate, requireGate, type ApprovalReader, type GateBinding } from "./gateGuard.js";
import { allowedTargets, findRule, type TransitionRule } from "./transitions.js";
import { resolveReleaseSnapshot, type WorkflowReadContext } from "./releaseSnapshotResolver.js";

export interface WorkflowContext extends WorkflowReadContext {
  readonly approvals: ApprovalReader;
  readonly identityGate: HumanIdentityGate;
}

export interface TransitionCheck {
  readonly allowed: boolean;
  readonly reason: string;
  readonly rule?: TransitionRule;
}

export interface TransitionOptions {
  readonly reason?: string;
  /** Required for any rule with `requiresHumanAuthorization`. */
  readonly authorization?: TrustedHumanToken;
}

export class WorkflowService {
  private readonly context: WorkflowContext;
  private readonly clock: Clock;

  constructor(context: WorkflowContext, clock: Clock) {
    this.context = context;
    this.clock = clock;
  }

  /**
   * What the gate on this rule must currently match. For a release, that is
   * the content hash of the live release candidate — so an approval for any
   * other candidate simply will not match.
   */
  private async gateBindingFor(rule: TransitionRule, item: WorkItem): Promise<GateBinding> {
    if (rule.requiredGate === "RELEASE_APPROVAL") {
      const snapshot = await resolveReleaseSnapshot(item, this.context);
      return snapshot.ok ? { snapshotId: snapshot.value.id } : { snapshotId: "<no releasable snapshot>" };
    }
    return { specRevision: item.specRevision };
  }

  private verifyHumanAuthorization(actor: Actor, options: TransitionOptions): string | undefined {
    if (actor.kind !== "HUMAN") {
      return `requires a trusted HUMAN decision, got actor kind ${actor.kind}`;
    }
    if (options.authorization === undefined) {
      return "requires a TrustedHumanToken; a caller-supplied HUMAN actor is not sufficient";
    }
    if (!this.context.identityGate.verify(options.authorization, actor)) {
      return `authorization token is invalid, expired, or was not issued to actor ${actor.id}`;
    }
    return undefined;
  }

  /** Non-throwing inspection, used by the CLI and by callers that want to look before they leap. */
  async check(
    item: WorkItem,
    to: WorkItemStatus,
    actor: Actor,
    options: TransitionOptions = {},
  ): Promise<TransitionCheck> {
    if (isTerminal(item.status)) {
      return { allowed: false, reason: `${item.status} is terminal` };
    }
    if (item.status === to) {
      return { allowed: false, reason: `already in ${to}` };
    }

    const rule = findRule(item.status, to);
    if (rule === undefined) {
      const targets = allowedTargets(item.status);
      const allowed = targets.length > 0 ? targets.join(", ") : "none";
      return { allowed: false, reason: `not a declared transition (allowed from ${item.status}: ${allowed})` };
    }

    if (rule.requiresHumanAuthorization === true) {
      const problem = this.verifyHumanAuthorization(actor, options);
      if (problem !== undefined) {
        return { allowed: false, reason: problem, rule };
      }
    }

    if (item.status === "BLOCKED" && item.blockedFrom !== undefined && to !== item.blockedFrom && to !== "CANCELLED") {
      return {
        allowed: false,
        reason: `must resume to ${item.blockedFrom}, the status this item was blocked from`,
        rule,
      };
    }

    if (rule.requiredGate !== undefined) {
      const binding = await this.gateBindingFor(rule, item);
      const gate = await evaluateGate(this.context.approvals, rule.requiredGate, workItemSubject(item.id), binding);
      if (!gate.satisfied) {
        return { allowed: false, reason: `gate ${rule.requiredGate} not satisfied: ${gate.reason}`, rule };
      }
    }

    if (rule.precondition !== undefined) {
      const result = await rule.precondition(item, this.context);
      if (!result.satisfied) {
        return { allowed: false, reason: result.reason, rule };
      }
    }

    return { allowed: true, reason: rule.description, rule };
  }

  /**
   * Returns a new, frozen WorkItem with the transition applied and appended
   * to history. Throws InvalidTransitionError, HumanIdentityError,
   * ApprovalRequiredError or PreconditionNotMetError; never returns a
   * partially applied item.
   */
  async transition(
    item: WorkItem,
    to: WorkItemStatus,
    actor: Actor,
    options: TransitionOptions = {},
  ): Promise<WorkItem> {
    const rule = findRule(item.status, to);

    if (isTerminal(item.status)) {
      throw new InvalidTransitionError(item.status, to, `${item.status} is terminal`);
    }
    if (rule === undefined) {
      const targets = allowedTargets(item.status);
      const allowed = targets.length > 0 ? targets.join(", ") : "none";
      throw new InvalidTransitionError(
        item.status,
        to,
        `not a declared transition (allowed from ${item.status}: ${allowed})`,
      );
    }
    if (rule.requiresHumanAuthorization === true) {
      const problem = this.verifyHumanAuthorization(actor, options);
      if (problem !== undefined) {
        throw new HumanIdentityError(`refusing ${item.status} -> ${to}: ${problem}`);
      }
    }
    if (item.status === "BLOCKED" && item.blockedFrom !== undefined && to !== item.blockedFrom && to !== "CANCELLED") {
      throw new InvalidTransitionError(
        item.status,
        to,
        `must resume to ${item.blockedFrom}, the status this item was blocked from`,
      );
    }
    if (rule.precondition !== undefined) {
      // Checked before the gate so a missing release candidate is reported as
      // "nothing to release" rather than as an unhelpful snapshot mismatch.
      const result = await rule.precondition(item, this.context);
      if (!result.satisfied) {
        throw new PreconditionNotMetError(item.status, to, result.reason);
      }
    }
    if (rule.requiredGate !== undefined) {
      const binding = await this.gateBindingFor(rule, item);
      // Throws ApprovalRequiredError when no granted, non-stale human approval exists.
      await requireGate(this.context.approvals, rule.requiredGate, workItemSubject(item.id), binding);
    }

    const at = this.clock.now();
    const change: StatusChange = {
      from: item.status,
      to,
      actorId: actor.id,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      at,
    };

    // Rebuild without a stale blockedFrom rather than spreading it in and
    // trying to delete it afterwards (exactOptionalPropertyTypes forbids
    // assigning `undefined` to an optional property).
    const { blockedFrom: previousBlockedFrom, ...rest } = item;
    void previousBlockedFrom;
    const nextBlockedFrom = to === "BLOCKED" ? item.status : undefined;

    const next: WorkItem = {
      ...rest,
      status: to,
      specRevision: rule.resetsSpecRevision === true ? item.specRevision + 1 : item.specRevision,
      version: item.version + 1,
      ...(nextBlockedFrom === undefined ? {} : { blockedFrom: nextBlockedFrom }),
      updatedAt: at,
      history: [...item.history, change],
    };

    return deepFreeze(next);
  }
}
