/**
 * WorkflowService behaviour: every declared, unguarded transition works, every
 * undeclared one fails deterministically with a typed error, and the BLOCKED
 * resume-to-origin rule is enforced regardless of what the table allows.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InvalidTransitionError, PreconditionNotMetError } from "../src/domain/errors.js";
import { WORK_ITEM_STATUSES, isTerminal, type WorkItemStatus } from "../src/domain/status.js";
import { createFixedClock } from "../src/ports/clock.js";
import { TRANSITION_RULES, findRule } from "../src/workflow/transitions.js";
import { WorkflowService, type WorkflowContext } from "../src/workflow/workflowService.js";
import { createLocalHumanIdentityGate } from "../src/adapters/security/localHumanIdentityGate.js";
import { AGENT, FIXTURE_START, HUMAN, SYSTEM, TEST_CREDENTIAL, workItemAt } from "./support/factoryFixtures.js";

const identityClock = createFixedClock(FIXTURE_START);
const identityGate = createLocalHumanIdentityGate({ credential: TEST_CREDENTIAL, clock: identityClock });

/** A valid token for HUMAN, so human-authorized rows can be exercised. */
const humanAuth = () => identityGate.authorize(HUMAN, TEST_CREDENTIAL);

/** Context that reports "nothing recorded" for every read — approvals, runs, reviews, criteria, verifications. */
const emptyContext: WorkflowContext = {
  approvals: { listBySubject: async () => [] },
  runs: { listByWorkItem: async () => [] },
  reviews: { listByWorkItem: async () => [] },
  criteria: { listByWorkItem: async () => [] },
  verifications: { listByWorkItem: async () => [] },
  identityGate,
};

function newService(context: WorkflowContext = emptyContext): WorkflowService {
  return new WorkflowService(context, createFixedClock(FIXTURE_START));
}

describe("WorkflowService — allowed transitions", () => {
  const unguarded = TRANSITION_RULES.filter((rule) => rule.requiredGate === undefined && rule.precondition === undefined);

  for (const rule of unguarded) {
    const humanRow = rule.requiresHumanAuthorization === true;
    const actor = humanRow ? HUMAN : AGENT;
    it(`allows ${rule.from} -> ${rule.to}`, async () => {
      // BLOCKED -> X rows require item.blockedFrom === X; stamp it so this
      // pure per-row sweep exercises the row on its own terms.
      const overrides = rule.from === "BLOCKED" ? { blockedFrom: rule.to } : {};
      const options = humanRow ? { authorization: humanAuth() } : {};
      const next = await newService().transition(workItemAt(rule.from, "wi-test", overrides), rule.to, actor, options);
      assert.equal(next.status, rule.to);
    });
  }

  it("appends to history without mutating the original item, and always bumps version", async () => {
    const item = workItemAt("READY");
    const next = await newService().transition(item, "IMPLEMENTING", AGENT, { reason: "picked up" });

    assert.equal(item.status, "READY", "original item must not be mutated");
    assert.equal(item.history.length, 0);
    assert.equal(next.history.length, 1);
    assert.deepEqual(
      { from: next.history[0]?.from, to: next.history[0]?.to, actorId: next.history[0]?.actorId },
      { from: "READY", to: "IMPLEMENTING", actorId: AGENT.id },
    );
    assert.equal(next.history[0]?.reason, "picked up");
    // READY -> IMPLEMENTING is forward progress, not a rework edge: revision
    // is unchanged, but version (the CAS token) always advances.
    assert.equal(next.specRevision, item.specRevision);
    assert.equal(next.version, item.version + 1);
  });

  it("bumps specRevision only on the plan-rework edge", async () => {
    const service = newService();

    // The plan itself was rejected: any PLAN_APPROVAL for it is now stale.
    const planRework = workItemAt("PLAN_REVIEW");
    const reworked = await service.transition(planRework, "ANALYSIS", AGENT);
    assert.equal(reworked.specRevision, planRework.specRevision + 1);

    // Implementation rework does NOT touch specRevision: the plan is
    // unchanged. Staleness of implementation artifacts is decided by the
    // release snapshot instead — see releaseSnapshotResolver.
    const implementationRework: [WorkItemStatus, WorkItemStatus][] = [
      ["VERIFYING", "IMPLEMENTING"],
      ["REVIEW", "IMPLEMENTING"],
      ["WAITING_FOR_HUMAN", "IMPLEMENTING"],
    ];
    for (const [from, to] of implementationRework) {
      const item = workItemAt(from);
      const next = await service.transition(item, to, AGENT);
      assert.equal(next.specRevision, item.specRevision, `${from} -> ${to} must not change the plan identity`);
    }

    const forwardEdges: [WorkItemStatus, WorkItemStatus][] = [
      ["IDEA", "ANALYSIS"],
      ["ANALYSIS", "PLAN_REVIEW"],
      ["READY", "IMPLEMENTING"],
    ];
    for (const [from, to] of forwardEdges) {
      const item = workItemAt(from);
      const next = await service.transition(item, to, AGENT);
      assert.equal(next.specRevision, item.specRevision, `${from} -> ${to} must NOT bump specRevision`);
    }
  });

  it("advances updatedAt", async () => {
    const item = workItemAt("IDEA");
    const next = await newService().transition(item, "ANALYSIS", AGENT);
    assert.ok(next.updatedAt >= item.updatedAt);
  });

  it("returns a deep-frozen result", async () => {
    const next = await newService().transition(workItemAt("IDEA"), "ANALYSIS", AGENT);
    assert.ok(Object.isFrozen(next));
    assert.ok(Object.isFrozen(next.history));
    assert.throws(() => {
      (next.history as unknown as { push(entry: unknown): void }).push({});
    }, TypeError);
  });
});

describe("WorkflowService — refused transitions", () => {
  it("refuses every pair that is not in the transition table", async () => {
    const service = newService();
    let refusedCount = 0;

    for (const from of WORK_ITEM_STATUSES) {
      for (const to of WORK_ITEM_STATUSES) {
        if (from === to || findRule(from, to) !== undefined) {
          continue;
        }
        refusedCount += 1;
        await assert.rejects(
          service.transition(workItemAt(from), to, HUMAN, { authorization: humanAuth() }),
          InvalidTransitionError,
          `${from} -> ${to} should be refused`,
        );
      }
    }

    // Sanity: the exhaustive sweep actually exercised something.
    assert.ok(refusedCount > 50, `expected many refusals, got ${refusedCount}`);
  });

  it("refuses IMPLEMENTING -> DONE specifically", async () => {
    await assert.rejects(newService().transition(workItemAt("IMPLEMENTING"), "DONE", AGENT), (error: unknown) => {
      assert.ok(error instanceof InvalidTransitionError);
      assert.equal(error.code, "INVALID_TRANSITION");
      assert.equal(error.from, "IMPLEMENTING");
      assert.equal(error.to, "DONE");
      return true;
    });
  });

  it("refuses transitions out of terminal statuses", async () => {
    const service = newService();
    for (const terminal of WORK_ITEM_STATUSES.filter(isTerminal)) {
      for (const to of WORK_ITEM_STATUSES) {
        if (to === terminal) {
          continue;
        }
        await assert.rejects(
          service.transition(workItemAt(terminal), to, HUMAN, { authorization: humanAuth() }),
          InvalidTransitionError,
        );
      }
    }
  });

  it("refuses a transition to the same status", async () => {
    for (const status of WORK_ITEM_STATUSES) {
      await assert.rejects(
        newService().transition(workItemAt(status), status, HUMAN, { authorization: humanAuth() }),
        InvalidTransitionError,
      );
    }
  });

  it("refuses cancellation without trusted human authorization but allows it with a valid token", async () => {
    const service = newService();
    for (const actor of [AGENT, SYSTEM]) {
      await assert.rejects(
        service.transition(workItemAt("IMPLEMENTING"), "CANCELLED", actor, { authorization: humanAuth() }),
        { code: "HUMAN_IDENTITY" },
      );
    }
    // A HUMAN actor with no token at all is equally refused.
    await assert.rejects(service.transition(workItemAt("IMPLEMENTING"), "CANCELLED", HUMAN), {
      code: "HUMAN_IDENTITY",
    });
    const cancelled = await service.transition(workItemAt("IMPLEMENTING"), "CANCELLED", HUMAN, {
      authorization: humanAuth(),
    });
    assert.equal(cancelled.status, "CANCELLED");
  });

  it("refuses gated transitions when no approval exists", async () => {
    const service = newService();
    await assert.rejects(service.transition(workItemAt("PLAN_REVIEW"), "READY", AGENT), {
      code: "APPROVAL_REQUIRED",
    });
  });

  it("refuses precondition-guarded transitions when no evidence exists", async () => {
    const service = newService();
    await assert.rejects(service.transition(workItemAt("IMPLEMENTING"), "VERIFYING", AGENT), PreconditionNotMetError);
    await assert.rejects(service.transition(workItemAt("VERIFYING"), "REVIEW", AGENT), PreconditionNotMetError);
    await assert.rejects(service.transition(workItemAt("REVIEW"), "WAITING_FOR_HUMAN", AGENT), PreconditionNotMetError);
    await assert.rejects(service.transition(workItemAt("WAITING_FOR_HUMAN"), "DONE", AGENT), PreconditionNotMetError);
  });
});

describe("WorkflowService — BLOCKED resume-to-origin", () => {
  it("refuses resuming to any status other than blockedFrom, even though the table declares the row", async () => {
    const service = newService();
    const blockedFromAnalysis = workItemAt("BLOCKED", "wi-test", { blockedFrom: "ANALYSIS" });

    // BLOCKED -> READY is a declared row (READY is itself a blockable
    // origin), but this item was blocked from ANALYSIS, not READY.
    await assert.rejects(service.transition(blockedFromAnalysis, "READY", AGENT), (error: unknown) => {
      assert.ok(error instanceof InvalidTransitionError);
      assert.match(error.message, /must resume to ANALYSIS/);
      return true;
    });
  });

  it("allows resuming to the exact status it was blocked from", async () => {
    const service = newService();
    const blockedFromAnalysis = workItemAt("BLOCKED", "wi-test", { blockedFrom: "ANALYSIS" });
    const next = await service.transition(blockedFromAnalysis, "ANALYSIS", AGENT);
    assert.equal(next.status, "ANALYSIS");
  });

  it("clears blockedFrom once resumed, so a second block records the new origin", async () => {
    const service = newService();
    const readyItem = workItemAt("READY");
    const blocked = await service.transition(readyItem, "BLOCKED", AGENT);
    assert.equal(blocked.blockedFrom, "READY");

    const resumed = await service.transition(blocked, "READY", AGENT);
    assert.equal(resumed.blockedFrom, undefined);

    const implementing = await service.transition(resumed, "IMPLEMENTING", AGENT);
    const blockedAgain = await service.transition(implementing, "BLOCKED", AGENT);
    assert.equal(blockedAgain.blockedFrom, "IMPLEMENTING");
  });

  it("prevents ANALYSIS -> BLOCKED -> READY from skipping PLAN_REVIEW and PLAN_APPROVAL", async () => {
    const service = newService();
    const analysisItem = workItemAt("ANALYSIS");
    const blocked = await service.transition(analysisItem, "BLOCKED", AGENT);
    assert.equal(blocked.blockedFrom, "ANALYSIS");

    await assert.rejects(service.transition(blocked, "READY", AGENT), InvalidTransitionError);
    const resumed = await service.transition(blocked, "ANALYSIS", AGENT);
    assert.equal(resumed.status, "ANALYSIS");
  });

  it("still allows cancelling a blocked item by an authorized human", async () => {
    const service = newService();
    const blocked = workItemAt("BLOCKED", "wi-test", { blockedFrom: "REVIEW" });
    const next = await service.transition(blocked, "CANCELLED", HUMAN, { authorization: humanAuth() });
    assert.equal(next.status, "CANCELLED");
  });

  it("supports blocking and resuming from every blockable origin", async () => {
    const service = newService();
    const origins: readonly WorkItemStatus[] = ["ANALYSIS", "PLAN_REVIEW", "READY", "IMPLEMENTING", "VERIFYING", "REVIEW"];
    for (const origin of origins) {
      const item = workItemAt(origin);
      const blocked = await service.transition(item, "BLOCKED", AGENT);
      assert.equal(blocked.status, "BLOCKED");
      assert.equal(blocked.blockedFrom, origin);
      const resumed = await service.transition(blocked, origin, AGENT);
      assert.equal(resumed.status, origin);
      assert.equal(resumed.blockedFrom, undefined);
    }
  });
});

describe("WorkflowService.check", () => {
  it("reports the same verdicts as transition without throwing", async () => {
    const service = newService();

    const ok = await service.check(workItemAt("READY"), "IMPLEMENTING", AGENT);
    assert.equal(ok.allowed, true);

    const bad = await service.check(workItemAt("IMPLEMENTING"), "DONE", AGENT);
    assert.equal(bad.allowed, false);
    assert.match(bad.reason, /not a declared transition/);

    const gated = await service.check(workItemAt("PLAN_REVIEW"), "READY", AGENT);
    assert.equal(gated.allowed, false);
    assert.match(gated.reason, /PLAN_APPROVAL/);

    const terminal = await service.check(workItemAt("DONE"), "IMPLEMENTING", AGENT);
    assert.equal(terminal.allowed, false);
    assert.match(terminal.reason, /terminal/);

    const bypass = await service.check(workItemAt("BLOCKED", "wi-test", { blockedFrom: "ANALYSIS" }), "READY", AGENT);
    assert.equal(bypass.allowed, false);
    assert.match(bypass.reason, /must resume to ANALYSIS/);
  });
});
