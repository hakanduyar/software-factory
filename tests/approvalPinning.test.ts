/**
 * TASK-015 round-2 finding 1 (CRITICAL): the pin must protect the LAUNCH.
 *
 * Round 1 checked the approval digest once, in the CLI, and then called
 * `service.resume(planId)` without it. `drive()` re-reads the plan on every
 * step, so a revision approved in between was driven anyway — the same
 * check-then-use shape one level down from where it was first found. A mutation
 * removing the parent's digest argument passed 31 tests.
 *
 * Offline: the plan never leaves PLAN_REVIEW/APPROVED here. No worker runs.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { cleanupTempDbs } from "./support/factoryFixtures.js";
import { approvedPlan, newPlanning, TEST_PLANNER_CONFIG, testExecutionConfig } from "./support/planFixtures.js";

after(cleanupTempDbs);

describe("TASK-015: PlanningService refuses a plan that is no longer the approval it was given", () => {
  /**
   * THE GUARD. A caller that cleared one approval must not drive another, and
   * `drive()` enforces that against every read rather than once at the door.
   */
  it("refuses to drive when the pinned digest does not match", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context, "Build the thing.", {
      constraints: ["roadmap-key: GITHUB_ORCHESTRATION"],
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });

    await assert.rejects(
      () => context.service.resume(plan.id, "plan-a-completely-different-approval"),
      /no longer the approval that was authorized/,
    );
  });

  /**
   * THE CONTROL, and it is the half that makes the guard meaningful: pinning the
   * CORRECT digest must still drive. Without this, "refuses everything" would
   * score as a pass and the pin would be indistinguishable from a breakage.
   */
  it("drives normally when the pinned digest is the current approval", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context, "Build the thing.", {
      constraints: ["roadmap-key: GITHUB_ORCHESTRATION"],
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });
    const current = await context.plans.findById(plan.id);
    assert.ok(current?.approvedDigest !== undefined, "the fixture plan carries no approval digest");

    const driven = await context.service.resume(plan.id, current.approvedDigest);

    assert.equal(driven.id, plan.id);
  });

  /**
   * And an UNPINNED caller is unaffected, which is the interactive human path.
   */
  it("drives normally when no digest is pinned at all", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context, "Build the thing.", {
      constraints: ["roadmap-key: GITHUB_ORCHESTRATION"],
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });

    const driven = await context.service.resume(plan.id);

    assert.equal(driven.id, plan.id);
  });
});
