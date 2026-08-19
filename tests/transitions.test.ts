/**
 * The transition table itself: structural invariants that must hold before any
 * service behaviour is worth testing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PROTECTED_GATES } from "../src/domain/approval.js";
import { WORK_ITEM_STATUSES, isTerminal } from "../src/domain/status.js";
import {
  BLOCKABLE_STATUSES,
  TRANSITION_RULES,
  allowedTargets,
  findRule,
  gatedTransitions,
} from "../src/workflow/transitions.js";

describe("transition table", () => {
  it("declares only known statuses", () => {
    for (const rule of TRANSITION_RULES) {
      assert.ok(WORK_ITEM_STATUSES.includes(rule.from), `unknown from: ${rule.from}`);
      assert.ok(WORK_ITEM_STATUSES.includes(rule.to), `unknown to: ${rule.to}`);
    }
  });

  it("contains no duplicate rows", () => {
    const seen = new Set<string>();
    for (const rule of TRANSITION_RULES) {
      const key = `${rule.from}->${rule.to}`;
      assert.ok(!seen.has(key), `duplicate rule ${key}`);
      seen.add(key);
    }
  });

  it("has no self-transitions", () => {
    for (const rule of TRANSITION_RULES) {
      assert.notEqual(rule.from, rule.to);
    }
  });

  it("does NOT allow IMPLEMENTING -> DONE (required design constraint)", () => {
    assert.equal(findRule("IMPLEMENTING", "DONE"), undefined);
  });

  it("only reaches DONE from WAITING_FOR_HUMAN", () => {
    const intoDone = TRANSITION_RULES.filter((rule) => rule.to === "DONE");
    assert.deepEqual(
      intoDone.map((rule) => rule.from),
      ["WAITING_FOR_HUMAN"],
    );
  });

  it("guards every route into DONE with RELEASE_APPROVAL and an evidence precondition", () => {
    for (const rule of TRANSITION_RULES.filter((candidate) => candidate.to === "DONE")) {
      assert.equal(rule.requiredGate, "RELEASE_APPROVAL");
      assert.ok(rule.precondition !== undefined, "DONE must also require real evidence, not just an approval");
    }
  });

  it("guards PLAN_REVIEW -> READY with PLAN_APPROVAL", () => {
    assert.equal(findRule("PLAN_REVIEW", "READY")?.requiredGate, "PLAN_APPROVAL");
  });

  it("has exactly two gated transitions, both with known gates", () => {
    const gated = gatedTransitions();
    assert.equal(gated.length, 2);
    for (const rule of gated) {
      assert.ok(PROTECTED_GATES.includes(rule.requiredGate!));
    }
  });

  it("guards the run/review/verification edges with a precondition", () => {
    const guarded: [string, string][] = [
      ["IMPLEMENTING", "VERIFYING"],
      ["VERIFYING", "REVIEW"],
      ["REVIEW", "WAITING_FOR_HUMAN"],
      ["WAITING_FOR_HUMAN", "DONE"],
    ];
    for (const [from, to] of guarded) {
      const rule = findRule(from as never, to as never);
      assert.ok(rule?.precondition !== undefined, `${from} -> ${to} must carry a precondition`);
    }
  });

  it("leaves terminal statuses with no outgoing transitions", () => {
    for (const status of WORK_ITEM_STATUSES.filter(isTerminal)) {
      assert.deepEqual(allowedTargets(status), []);
    }
  });

  it("makes every non-terminal status reachable and escapable", () => {
    for (const status of WORK_ITEM_STATUSES) {
      if (isTerminal(status)) {
        continue;
      }
      assert.ok(allowedTargets(status).length > 0, `${status} is a dead end`);
    }
    for (const status of WORK_ITEM_STATUSES) {
      if (status === "IDEA") {
        continue;
      }
      const inbound = TRANSITION_RULES.filter((rule) => rule.to === status);
      assert.ok(inbound.length > 0, `${status} is unreachable`);
    }
  });

  it("restricts CANCELLED to trusted human authorization", () => {
    for (const rule of TRANSITION_RULES.filter((candidate) => candidate.to === "CANCELLED")) {
      assert.equal(rule.requiresHumanAuthorization, true, `${rule.from} -> CANCELLED must require trusted human authorization`);
    }
  });

  it("exposes the expected targets from IMPLEMENTING", () => {
    assert.deepEqual([...allowedTargets("IMPLEMENTING")].sort(), [
      "BLOCKED",
      "CANCELLED",
      "VERIFYING",
    ]);
  });

  describe("BLOCKED", () => {
    it("is reachable from, and only resumable to, each blockable status", () => {
      for (const status of BLOCKABLE_STATUSES) {
        assert.ok(findRule(status, "BLOCKED") !== undefined, `${status} -> BLOCKED must be declared`);
        assert.ok(findRule("BLOCKED", status) !== undefined, `BLOCKED -> ${status} must be declared`);
      }
    });

    it("declares no bare row from BLOCKED to READY unless READY is a blockable origin", () => {
      // This is the exact shape of the original bypass: BLOCKED -> READY must
      // only exist because READY is itself a legitimate blockable origin, and
      // WorkflowService additionally enforces blockedFrom at runtime (see
      // workflowService.test.ts) so the table alone is not the only guard.
      assert.ok(BLOCKABLE_STATUSES.includes("READY"));
      assert.ok(findRule("BLOCKED", "READY") !== undefined);
    });

    it("does not allow blocking from IDEA, WAITING_FOR_HUMAN or a terminal status", () => {
      for (const status of ["IDEA", "WAITING_FOR_HUMAN", "DONE", "CANCELLED"] as const) {
        assert.equal(findRule(status, "BLOCKED"), undefined, `${status} -> BLOCKED should not be declared`);
      }
    });
  });
});
