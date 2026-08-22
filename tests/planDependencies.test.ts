/**
 * TASK-005 dependency-ordered execution and the TASK-004 handoff.
 *
 * Covers AC-9 (dependencies gate dispatch) and AC-10 (work reaches TASK-004
 * through the accepted service, never a second loop).
 *
 * The central claim being tested is the definition of "prerequisite satisfied":
 * it is EXECUTION FINISHED, not RELEASED, and "finished" is decided by asking
 * the Factory whether the independent-review authority currently holds — not by
 * reading a status field. A work item whose row merely SAYS
 * `WAITING_FOR_HUMAN`, with no review lineage behind it, must satisfy nothing.
 *
 * No real Claude/Codex model is invoked anywhere in this file.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderPlannerResponse } from "../src/planning/scriptedPlannerWorkers.js";
import { createScriptedDispatcher } from "../src/planning/scriptedPlannerWorkers.js";
import { approvedPlan, finishWorkItem, newPlanning, type TestPlanning } from "./support/planFixtures.js";

const A_THEN_B = renderPlannerResponse({
  summary: "Schema first, then the API that needs it.",
  items: [
    { key: "WI-A", title: "Schema", spec: "Create the table." },
    { key: "WI-B", title: "API", spec: "Expose the API.", dependsOn: ["WI-A"] },
  ],
});

const DIAMOND = renderPlannerResponse({
  summary: "Diamond dependency graph.",
  items: [
    { key: "WI-A", title: "Base", spec: "Base work." },
    { key: "WI-B", title: "Left", spec: "Left branch.", dependsOn: ["WI-A"] },
    { key: "WI-C", title: "Right", spec: "Right branch.", dependsOn: ["WI-A"] },
    { key: "WI-D", title: "Join", spec: "Join branch.", dependsOn: ["WI-B", "WI-C"] },
  ],
});

function mappingFor(plan: Awaited<ReturnType<typeof approvedPlan>>, key: string): { workItemId: string } {
  const mapping = plan.materialized.find((entry) => entry.planItemKey === key);
  assert.ok(mapping !== undefined, `no mapping for ${key}`);
  return mapping;
}

describe("TASK-005 AC-9: a dependent item waits for its prerequisites", () => {
  it("dispatches only the root item while its dependent waits", async () => {
    const context = await newPlanning({ plannerOutputs: [A_THEN_B] });
    const plan = await approvedPlan(context);

    assert.equal(plan.materialized.length, 2, "both items are materialized up front");
    assert.equal(plan.dispatches.length, 1, "only the unblocked item is dispatched");
    assert.equal(plan.dispatches[0]!.planItemKey, "WI-A");
    assert.equal(context.dispatcher.startCount(), 1);
  });

  it("dispatches the dependent once the prerequisite has genuinely finished", async () => {
    const context = await newPlanning({ plannerOutputs: [A_THEN_B] });
    const plan = await approvedPlan(context);

    await finishWorkItem(context.factory, mappingFor(plan, "WI-A").workItemId, "dep-a");
    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.dispatches.length, 2);
    assert.ok(resumed.dispatches.some((entry) => entry.planItemKey === "WI-B"));
  });

  it("a status field alone does not satisfy a dependency — live authority is required", async () => {
    const context = await newPlanning({ plannerOutputs: [A_THEN_B] });
    const plan = await approvedPlan(context);
    const itemA = mappingFor(plan, "WI-A").workItemId;

    // Force the row to CLAIM it finished, with no review lineage behind it —
    // exactly the corrupted/drifted checkpoint the authority resolver exists
    // to catch. This writes straight to the repository, bypassing the workflow
    // service, which is the only way to produce this state at all.
    const stored = await context.store.workItems.findById(itemA);
    assert.ok(stored !== undefined);
    await context.store.workItems.compareAndSave(
      { ...stored, status: "WAITING_FOR_HUMAN", version: stored.version + 1 },
      stored.version,
    );

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.dispatches.length, 1, "WI-B must not dispatch on an unbacked claim");
    assert.ok(!resumed.dispatches.some((entry) => entry.planItemKey === "WI-B"));
  });

  it("respects a diamond graph, releasing the join only after both branches finish", async () => {
    const context = await newPlanning({ plannerOutputs: [DIAMOND] });
    let plan = await approvedPlan(context);

    assert.equal(plan.dispatches.length, 1);
    assert.equal(plan.dispatches[0]!.planItemKey, "WI-A");

    await finishWorkItem(context.factory, mappingFor(plan, "WI-A").workItemId, "dia-a");
    plan = await context.service.resume(plan.id);
    assert.equal(plan.dispatches.length, 3, "both branches are released together");
    assert.ok(!plan.dispatches.some((entry) => entry.planItemKey === "WI-D"));

    await finishWorkItem(context.factory, mappingFor(plan, "WI-B").workItemId, "dia-b");
    plan = await context.service.resume(plan.id);
    assert.equal(plan.dispatches.length, 3, "the join still waits on the second branch");

    await finishWorkItem(context.factory, mappingFor(plan, "WI-C").workItemId, "dia-c");
    plan = await context.service.resume(plan.id);
    assert.equal(plan.dispatches.length, 4);
    assert.ok(plan.dispatches.some((entry) => entry.planItemKey === "WI-D"));
  });

  it("dependency progress survives a restart", async () => {
    const context = await newPlanning({ plannerOutputs: [A_THEN_B] });
    const plan = await approvedPlan(context);
    await finishWorkItem(context.factory, mappingFor(plan, "WI-A").workItemId, "restart-a");
    const advanced = await context.service.resume(plan.id);
    assert.equal(advanced.dispatches.length, 2);

    // A fresh service over the same durable state must not redo anything.
    const restarted: TestPlanning = await newPlanning({
      plannerOutputs: [A_THEN_B],
      store: context.store,
      plans: context.plans,
      dispatcher: context.dispatcher,
    });
    const resumed = await restarted.service.resume(plan.id);

    assert.equal(resumed.dispatches.length, 2);
    assert.equal(context.dispatcher.startCount(), 2, "no loop was started twice");
  });
});

describe("TASK-005 AC-9: a failed prerequisite stops everything downstream", () => {
  for (const phase of ["EXHAUSTED", "FAILED", "RECOVERY_REQUIRED", "CANCELLED"]) {
    it(`blocks the plan when a dispatched loop ends in ${phase}`, async () => {
      const dispatcher = createScriptedDispatcher();
      const context = await newPlanning({ plannerOutputs: [A_THEN_B], dispatcher });
      const plan = await approvedPlan(context);
      const itemA = mappingFor(plan, "WI-A").workItemId;

      dispatcher.setPhase(itemA, { phase, outcome: phase, failureReason: `loop ended ${phase}` });
      const resumed = await context.service.resume(plan.id);

      assert.equal(resumed.phase, "BLOCKED");
      assert.equal(resumed.outcome, "BLOCKED");
      assert.match(resumed.failureReason ?? "", new RegExp(phase));
      assert.equal(resumed.dispatches.length, 1, "the dependent was never dispatched");
      assert.equal(dispatcher.startCount(), 1);
    });
  }

  it("a blocked plan can recover once the human resolves the failure", async () => {
    const dispatcher = createScriptedDispatcher();
    const context = await newPlanning({ plannerOutputs: [A_THEN_B], dispatcher });
    const plan = await approvedPlan(context);
    const itemA = mappingFor(plan, "WI-A").workItemId;

    dispatcher.setPhase(itemA, { phase: "EXHAUSTED", outcome: "EXHAUSTED" });
    const blocked = await context.service.resume(plan.id);
    assert.equal(blocked.phase, "BLOCKED");

    // BLOCKED is not terminal: the human fixes the item, and resume re-derives.
    dispatcher.setPhase(itemA, { phase: "WAITING_FOR_HUMAN", outcome: "WAITING_FOR_HUMAN" });
    await finishWorkItem(context.factory, itemA, "unblock-a");
    const recovered = await context.service.resume(plan.id);

    assert.equal(recovered.dispatches.length, 2, "the dependent was released after the fix");
  });
});

describe("TASK-005 AC-10: work reaches TASK-004, and only through TASK-004", () => {
  it("dispatches through the loop dispatcher and records the loop id", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);

    assert.equal(plan.dispatches.length, 1);
    assert.match(plan.dispatches[0]!.loopId, /^loop-/);
    assert.equal(plan.dispatches[0]!.adopted, false);
    assert.equal(context.dispatcher.startCount(), 1);
  });

  it("hands the loop the approved spec and acceptance criteria", async () => {
    const captured: string[] = [];
    const dispatcher = createScriptedDispatcher();
    const wrapped = {
      ...dispatcher,
      async start(input: { workItemId: string; taskInstructions: string }) {
        captured.push(input.taskInstructions);
        return dispatcher.start(input);
      },
    };
    const context = await newPlanning({ dispatcher: wrapped as typeof dispatcher });
    await approvedPlan(context);

    assert.equal(captured.length, 1);
    assert.match(captured[0]!, /## Specification/);
    assert.match(captured[0]!, /Implement the thing as described\./);
    assert.match(captured[0]!, /## Acceptance criteria/);
  });

  it("propagates a finished loop to a plan-level WAITING_FOR_HUMAN", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    await finishWorkItem(context.factory, plan.materialized[0]!.workItemId, "prop-a");

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
    assert.notEqual(resumed.phase, "COMPLETED", "execution finished is not release approved");
  });

  it("never starts a second loop for the same work item", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);

    await context.service.resume(plan.id);
    await context.service.resume(plan.id);
    await context.service.resume(plan.id);

    assert.equal(context.dispatcher.startCount(), 1);
  });

  it("adopts an externally-started loop rather than competing with it", async () => {
    const dispatcher = createScriptedDispatcher();
    const context = await newPlanning({ plannerOutputs: [A_THEN_B], dispatcher });
    const plan = await approvedPlan(context);

    // Forget the dispatch, then resume: the loop is already there.
    const current = (await context.plans.findById(plan.id))!;
    await context.plans.compareAndSave({ ...current, dispatches: [], version: current.version + 1 }, current.version);

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.dispatches.length, 1);
    assert.equal(resumed.dispatches[0]!.adopted, true);
    assert.equal(dispatcher.startCount(), 1, "adoption, not a second start");
  });
});
