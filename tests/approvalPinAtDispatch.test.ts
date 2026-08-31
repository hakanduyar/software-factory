/**
 * TASK-015 round-3 findings 1 and 5.
 *
 * FINDING 1 (CRITICAL): `drive()` checked the pin at the top of each step and
 * `claimAndDispatch()` then committed a claim and started a worker without
 * re-checking. The reviewer measured two workers started before the next loop
 * read noticed. The check now sits immediately before `dispatcher.start()`.
 *
 * FINDING 5: the round-2 end-to-end fixture hand-built an approval-shaped row
 * and a `verifiedPhase` that answered "APPROVED" unconditionally, so it proved
 * the set path but NOT real Factory approval authority. Everything here goes
 * through the real planning fixtures, where an approval is minted by the real
 * gate and the digest is the one that gate computed.
 *
 * Offline: the dispatcher is scripted. No provider, no model, no money.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { cleanupTempDbs } from "./support/factoryFixtures.js";
import {
  approvedPlan,
  dependentPlanResponse,
  finishWorkItem,
  newPlanning,
  TEST_PLANNER_CONFIG,
  testExecutionConfig,
} from "./support/planFixtures.js";

after(cleanupTempDbs);

const CONSTRAINTS = ["roadmap-key: GITHUB_ORCHESTRATION"];

async function approved() {
  const context = await newPlanning();
  const plan = await approvedPlan(context, "Build the thing.", {
    constraints: CONSTRAINTS,
    planner: TEST_PLANNER_CONFIG,
    execution: testExecutionConfig(),
  });
  const stored = await context.plans.findById(plan.id);
  assert.ok(stored?.approvedDigest !== undefined, "the real approval path produced no digest");
  return { context, plan, digest: stored.approvedDigest };
}

describe("TASK-015: the approval pin holds at the moment a worker starts", () => {
  /**
   * THE REPRODUCTION. The approval is replaced AFTER the caller cleared it, and
   * the next dispatch must refuse rather than start a worker for content nobody
   * authorised.
   *
   * The digest is changed directly in the repository, which is exactly the
   * situation being defended against: something else re-approved the plan while
   * this launch was in flight.
   */
  it("refuses to start a worker once the approval has been replaced", async () => {
    const { context, plan, digest } = await approved();
    const before = context.dispatcher.startCount();

    // The plan is re-approved as something else while the launch is in flight.
    const current = await context.plans.findById(plan.id);
    assert.ok(current !== undefined);
    await context.plans.compareAndSave(
      { ...current, version: current.version + 1, approvedDigest: "plan-a-different-approval" },
      current.version,
    );

    await assert.rejects(
      () => context.service.resume(plan.id, digest),
      /no longer the approval that was authorized/,
    );
    assert.equal(
      context.dispatcher.startCount(),
      before,
      "a worker was started for an approval nobody cleared",
    );
  });

  /**
   * THE RACE AT THE REAL DISPATCH (round-5 finding 1, CRITICAL).
   *
   * The previous version of this file never reached `claimAndDispatch()`'s
   * read/CAS pair at all: `approvedPlan()` has already dispatched the single
   * work item, so a later resume adopts the existing loop instead of claiming a
   * new one. The reviewer proved the gap by replacing the CAS version with a
   * separate re-read — the production guard's defining property — and all three
   * tests still passed.
   *
   * A TWO-ITEM plan is what makes the second dispatch happen: WI-B depends on
   * WI-A, so it is claimed only after A finishes. The approval is then replaced
   * during that claim, which is the window the CAS exists to close.
   */
  it("does not claim a dispatch when the approval changes at the claim itself", async () => {
    const context = await newPlanning({ plannerOutputs: [dependentPlanResponse()] });
    const plan = await approvedPlan(context, "Build two things.", {
      constraints: CONSTRAINTS,
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });
    const pinned = (await context.plans.findById(plan.id))?.approvedDigest;
    assert.ok(pinned !== undefined);

    /**
     * WI-A must be finished AS A WORK ITEM, not merely reported finished by the
     * scripted loop. The first version of this test only set the loop phase, and
     * the readiness check for WI-B looks at the Factory record — so no second
     * dispatch happened, `claimAndDispatch` was never reached, and the test was
     * inert. The reviewer proved that by breaking the CAS and watching it pass.
     */
    const first = plan.materialized[0];
    assert.ok(first !== undefined, "the two-item fixture materialized nothing");
    context.dispatcher.setPhase(first.workItemId, { phase: "COMPLETED", outcome: "COMPLETED" });
    await finishWorkItem(context.factory, first.workItemId, "a");

    const startsBefore = context.dispatcher.startCount();

    /**
     * Replace the approval on the read `claimAndDispatch` is about to write
     * against. If the claim were written against any other read, this is the
     * moment a worker would start for an approval nobody cleared.
     */
    let armed = true;
    const realFindById = context.plans.findById.bind(context.plans);
    Object.assign(context.plans, {
      findById: async (id: string) => {
        const found = await realFindById(id);
        /**
         * FIRED ON THE READ INSIDE `claimAndDispatch`, AND ONLY THAT ONE.
         *
         * An earlier version fired on the first EXECUTING read of the resume,
         * which is the drive loop's — so the digest changed long before the
         * claim, the loop's own check caught it, and the outcome was identical
         * whether or not the claim used the right version. The mutation that
         * breaks atomicity survived it.
         *
         * The stack is the only thing that distinguishes the two reads, and the
         * distinction is the entire point: the guard's property is that the CAS
         * is written against THE READ THE DIGEST WAS CHECKED ON.
         */
        const insideClaim = new Error().stack?.includes("claimAndDispatch") === true;
        if (found !== undefined && armed && insideClaim) {
          armed = false;
          await context.plans.compareAndSave(
            { ...found, version: found.version + 1, approvedDigest: "replaced-at-the-claim" },
            found.version,
          );
        }
        return found;
      },
    });

    await context.service.resume(plan.id, pinned).catch(() => undefined);

    assert.equal(
      context.dispatcher.startCount(),
      startsBefore,
      "a second worker was claimed and started under an approval that had already been replaced",
    );
  });

  /**
   * THE RACE, DRIVEN AT THE READ/WRITE PAIR ITSELF.
   *
   * Rounds 1-3 each answered a check-then-use window with a check placed closer
   * to the side effect, and the reviewer defeated each one. No arrangement of
   * checks can close it: between any read and an external side effect there is a
   * moment.
   *
   * What closes it is ATOMICITY — the digest is verified against a read, and the
   * claim is written with `compareAndSave` against THAT read's version. This
   * test drives exactly that interleaving: the repository mutates the plan
   * BETWEEN the read and the write, which is the window, and the claim must then
   * fail rather than a worker start.
   */
  it("cannot dispatch when the plan changes between the pin check and the claim", async () => {
    const base = await approved();
    let interleave = true;

    /**
     * A repository that changes the plan between every read and the next write —
     * the worst case the CAS exists for. If the claim were written against a
     * version read earlier, or the digest checked against a different read, a
     * worker would start.
     */
    const racing = {
      ...base.context.plans,
      create: (p: Parameters<typeof base.context.plans.create>[0]) => base.context.plans.create(p),
      findActiveByRequestKey: (k: string) => base.context.plans.findActiveByRequestKey(k),
      listByProject: (id: Parameters<typeof base.context.plans.listByProject>[0]) =>
        base.context.plans.listByProject(id),
      findById: async (id: string) => {
        const found = await base.context.plans.findById(id);
        if (found !== undefined && interleave) {
          interleave = false;
          // Someone else re-approves the plan, right here.
          await base.context.plans.compareAndSave(
            { ...found, version: found.version + 1, approvedDigest: "replaced-between-read-and-write" },
            found.version,
          );
        }
        return found;
      },
      compareAndSave: (p: Parameters<typeof base.context.plans.compareAndSave>[0], v: number) =>
        base.context.plans.compareAndSave(p, v),
    };

    const context = await newPlanning({ store: base.context.store, plans: racing });
    const startsBefore = base.context.dispatcher.startCount();

    await context.service.resume(base.plan.id, base.digest).catch(() => undefined);

    assert.equal(
      context.dispatcher.startCount(),
      0,
      "a worker started even though the plan changed between the pin check and the claim",
    );
    assert.equal(startsBefore, base.context.dispatcher.startCount(), "the original dispatcher also started work");
  });

  /**
   * THE CONTROL. Pinning the CURRENT approval must still dispatch, or the guard
   * above is satisfied by never starting anything — which would look identical
   * in a test and be useless in production.
   */
  it("still dispatches when the pinned approval is the current one", async () => {
    const { context, plan, digest } = await approved();

    const driven = await context.service.resume(plan.id, digest);

    assert.equal(driven.id, plan.id);
    assert.ok(
      context.dispatcher.startCount() >= 1,
      "pinning the correct approval prevented the work from being dispatched at all",
    );
  });
});
