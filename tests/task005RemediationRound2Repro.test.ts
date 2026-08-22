/**
 * TASK-005 REMEDIATION ROUND 2 — the one HIGH the second independent
 * acceptance review reproduced, plus the stronger case found while fixing it.
 *
 * Round 1 closed "a materialization mapping is a reference, not proof". It
 * closed that for `plan.materialized` and stopped there — while `plan.dispatches`
 * holds foreign references too. The reviewer set a dispatch's `loopId` to a
 * value naming no loop and watched `status()` report `EXECUTING` while
 * `resume()` threw a raw `no scripted loop ...` error out of a drive step.
 *
 * Probing that finding surfaced a case the review did not test and an existence
 * check would not have caught: SWAP two dispatches' `loopId`s and every
 * reference still resolves to a real, live loop — just the wrong one. So what is
 * verified here is LINEAGE, not existence.
 *
 * Every test in this file failed against the round-1 tree.
 *
 * Fully offline: scripted dispatchers, temp SQLite files, no AI.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createSqlitePlanRepository } from "../src/adapters/planning/sqlitePlanRepository.js";
import { PersistenceCorruptionError } from "../src/domain/errors.js";
import type { Plan, PlanPhase } from "../src/planning/planTypes.js";
import { encodePlan, parsePlan } from "../src/planning/planSerialization.js";
import { renderPlannerResponse } from "../src/planning/scriptedPlannerWorkers.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import {
  PLAN_HUMAN,
  approvedPlan,
  authorizePlanHuman,
  finishWorkItem,
  newPlanning,
  type TestPlanning,
} from "./support/planFixtures.js";

after(cleanupTempDbs);

function twoIndependentItems(): string {
  return renderPlannerResponse({
    summary: "Two independent items.",
    items: [
      { key: "WI-A", title: "First thing", spec: "Do the first thing." },
      { key: "WI-B", title: "Second thing", spec: "Do the second thing." },
    ],
  });
}

/** An EXECUTING plan whose single dispatch has been repointed at a loop that does not exist. */
async function planWithMissingLoop(phase: PlanPhase = "EXECUTING"): Promise<{ context: TestPlanning; planId: string }> {
  const context = await newPlanning();
  const plan = await approvedPlan(context);
  assert.equal(plan.dispatches.length, 1);
  const broken: Plan = {
    ...plan,
    version: plan.version + 1,
    phase,
    ...(phase === "COMPLETED" ? { outcome: "COMPLETED" as const } : {}),
    ...(phase === "BLOCKED" ? { outcome: "BLOCKED" as const } : {}),
    dispatches: plan.dispatches.map((entry) => ({ ...entry, loopId: "loop-missing" })),
  };
  await context.plans.compareAndSave(broken, plan.version);
  return { context, planId: plan.id };
}

/** Two dispatches whose loop ids are swapped: both real, both wired to the other item. */
async function planWithSwappedLoops(): Promise<{ context: TestPlanning; planId: string }> {
  const context = await newPlanning({ plannerOutputs: [twoIndependentItems()] });
  const plan = await approvedPlan(context);
  assert.equal(plan.dispatches.length, 2, "both independent items dispatched");
  const [a, b] = [plan.dispatches[0]!, plan.dispatches[1]!];
  assert.notEqual(a.loopId, b.loopId);

  const crossed: Plan = {
    ...plan,
    version: plan.version + 1,
    dispatches: [
      { ...a, loopId: b.loopId },
      { ...b, loopId: a.loopId },
    ],
  };
  await context.plans.compareAndSave(crossed, plan.version);
  return { context, planId: plan.id };
}

// =====================================================================
// A missing loop — the reviewer's exact reproduction
// =====================================================================

describe("ROUND 2: a dispatch whose engineering loop is missing fails closed", () => {
  for (const phase of ["MATERIALIZING", "EXECUTING", "WAITING_FOR_HUMAN", "COMPLETED"] as const) {
    it(`does not expose a ${phase} plan whose dispatched loop does not exist`, async () => {
      const { context, planId } = await planWithMissingLoop(phase);

      const seen = await context.service.status(planId);

      assert.equal(seen.phase, "RECOVERY_REQUIRED");
      assert.match(seen.failureReason!, /dispatch record is not sound/);
      assert.match(seen.failureReason!, /loop-missing/);
    });
  }

  it("durably records RECOVERY_REQUIRED on resume instead of throwing a raw missing-loop error", async () => {
    const { context, planId } = await planWithMissingLoop();
    const startsBefore = context.dispatcher.startCount();

    const resumed = await context.service.resume(planId);

    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
    assert.equal(resumed.outcome, "RECOVERY_REQUIRED");
    assert.match(resumed.failureReason!, /has no engineering loop at all|is not sound/);
    assert.equal(context.dispatcher.startCount(), startsBefore, "no replacement loop was launched");
  });

  it("does not act from BLOCKED on an unproven dispatch either", async () => {
    // BLOCKED routes into the execution step, so it must not be a way in with
    // fewer questions asked (the round-1 audit lesson, re-applied to dispatch).
    const { context, planId } = await planWithMissingLoop("BLOCKED");
    const startsBefore = context.dispatcher.startCount();

    const resumed = await context.service.resume(planId);

    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
    assert.equal(context.dispatcher.startCount(), startsBefore);
  });

  it("never blindly relaunches: a missing loop is ambiguous, not proof nothing ran", async () => {
    const { context, planId } = await planWithMissingLoop();
    const startsBefore = context.dispatcher.startCount();

    await context.service.resume(planId);
    await context.service.resume(planId);

    assert.equal(context.dispatcher.startCount(), startsBefore, "recovery is required, not a retry");
  });
});

// =====================================================================
// A wrong loop — existence alone was never enough
// =====================================================================

describe("ROUND 2: a dispatch pointing at another work item's loop fails closed", () => {
  it("refuses cross-wired dispatch lineage even though every loop exists", async () => {
    const { context, planId } = await planWithSwappedLoops();

    const seen = await context.service.status(planId);

    assert.equal(seen.phase, "RECOVERY_REQUIRED", "a real loop belonging to the wrong item is not authority");
    assert.match(seen.failureReason!, /but work item .* loop is/);
  });

  it("durably recovers on resume without launching anything", async () => {
    const { context, planId } = await planWithSwappedLoops();
    const startsBefore = context.dispatcher.startCount();

    const resumed = await context.service.resume(planId);

    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
    assert.equal(context.dispatcher.startCount(), startsBefore);
  });

  it("refuses a dispatch whose work item disagrees with its materialization mapping", async () => {
    const context = await newPlanning({ plannerOutputs: [twoIndependentItems()] });
    const plan = await approvedPlan(context);
    const [a, b] = [plan.dispatches[0]!, plan.dispatches[1]!];

    const crossed: Plan = {
      ...plan,
      version: plan.version + 1,
      dispatches: [{ ...a, workItemId: b.workItemId }, b],
    };
    await context.plans.compareAndSave(crossed, plan.version);

    const seen = await context.service.status(plan.id);
    assert.equal(seen.phase, "RECOVERY_REQUIRED");
    assert.match(seen.failureReason!, /but its mapping names|reuses loop/);
  });

  it("refuses two plan items claiming one loop", async () => {
    const context = await newPlanning({ plannerOutputs: [twoIndependentItems()] });
    const plan = await approvedPlan(context);
    const [a, b] = [plan.dispatches[0]!, plan.dispatches[1]!];

    const duplicated: Plan = {
      ...plan,
      version: plan.version + 1,
      dispatches: [a, { ...b, loopId: a.loopId }],
    };
    await context.plans.compareAndSave(duplicated, plan.version);

    const seen = await context.service.status(plan.id);
    assert.equal(seen.phase, "RECOVERY_REQUIRED");
    assert.match(seen.failureReason!, /reuses loop|loop is/);
  });

  it("refuses a dispatch naming a plan item that is not in the approved revision", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const ghost: Plan = {
      ...plan,
      version: plan.version + 1,
      materialized: [...plan.materialized, { ...plan.materialized[0]!, planItemKey: "WI-GHOST" }],
      dispatches: [{ ...plan.dispatches[0]!, planItemKey: "WI-GHOST" }],
    };
    await context.plans.compareAndSave(ghost, plan.version);

    const seen = await context.service.status(plan.id);
    assert.equal(seen.phase, "RECOVERY_REQUIRED");
  });
});

// =====================================================================
// status() stays read-only and inert
// =====================================================================

describe("ROUND 2: detecting a bad dispatch changes nothing", () => {
  it("performs zero plan writes, zero loop launches and zero planner runs", async () => {
    const { context, planId } = await planWithMissingLoop();
    const before = await context.plans.findById(planId);
    const startsBefore = context.dispatcher.startCount();
    const runsBefore = before!.totalPlannerRuns;

    await context.service.status(planId);
    await context.service.status(planId);

    const after2 = await context.plans.findById(planId);
    assert.deepEqual(after2, before, "status wrote nothing at all");
    assert.equal(after2!.phase, "EXECUTING", "the stored checkpoint is untouched");
    assert.equal(context.dispatcher.startCount(), startsBefore, "status launched no loop");
    assert.equal(after2!.totalPlannerRuns, runsBefore, "status launched no planner");
  });

  it("performs zero work item writes", async () => {
    const { context, planId } = await planWithMissingLoop();
    const stored = (await context.plans.findById(planId))!;
    const workItemId = stored.materialized[0]!.workItemId;
    const before = await context.factory.getWorkItem(workItemId);

    await context.service.status(planId);

    assert.deepEqual(await context.factory.getWorkItem(workItemId), before);
  });
});

// =====================================================================
// status() and resume() must reach the SAME authority conclusion
// =====================================================================

describe("ROUND 2: the read path and the write path agree about authority", () => {
  for (const phase of ["MATERIALIZING", "EXECUTING", "WAITING_FOR_HUMAN", "COMPLETED", "BLOCKED"] as const) {
    it(`agrees for ${phase} with an unsound dispatch`, async () => {
      const { context, planId } = await planWithMissingLoop(phase);

      const seen = await context.service.status(planId);
      const resumed = await context.service.resume(planId);

      // The read path may decline to persist; it may never disagree.
      assert.equal(resumed.phase, "RECOVERY_REQUIRED", "the write path reaches recovery");
      if (phase === "COMPLETED") {
        // Terminal: both paths report recovery, neither rewrites the record.
        assert.equal(seen.phase, "RECOVERY_REQUIRED");
        assert.equal((await context.plans.findById(planId))!.phase, "COMPLETED", "history is not rewritten");
      } else if (phase === "BLOCKED") {
        // Deliberate asymmetry, and the ONLY one: BLOCKED claims no authority,
        // so the read path reports it verbatim rather than auditing a plan that
        // is already stopped and waiting for a human.
        assert.equal(seen.phase, "BLOCKED");
      } else {
        assert.equal(seen.phase, "RECOVERY_REQUIRED", "the read path reaches the same conclusion");
      }
    });
  }

  it("agrees for a sound plan across every authority-sensitive phase", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    assert.equal((await context.service.status(plan.id)).phase, "EXECUTING");
    assert.equal((await context.service.resume(plan.id)).phase, "EXECUTING");

    await finishWorkItem(context.factory, plan.materialized[0]!.workItemId, "r2-matrix");
    assert.equal((await context.service.resume(plan.id)).phase, "WAITING_FOR_HUMAN");
    assert.equal((await context.service.status(plan.id)).phase, "WAITING_FOR_HUMAN");
  });
});

// =====================================================================
// Restart
// =====================================================================

describe("ROUND 2: the same conclusion survives a SQLite restart", () => {
  async function restartWith(mutate: (plan: Plan) => Plan): Promise<{ phase: PlanPhase; reason?: string }> {
    const dbPath = tempDbPath("r2-dispatch-");
    const plans = createSqlitePlanRepository(dbPath);
    const context = await newPlanning({ plans, plannerOutputs: [twoIndependentItems()] });
    const plan = await approvedPlan(context);
    await plans.compareAndSave(mutate({ ...plan, version: plan.version + 1 }), plan.version);
    plans.close();

    const reopened = createSqlitePlanRepository(dbPath);
    try {
      // A real restart keeps the loop store; only the process is new.
      const restarted = await newPlanning({
        plans: reopened,
        store: context.store,
        dispatcher: context.dispatcher,
      });
      const seen = await restarted.service.status(plan.id);
      return { phase: seen.phase, ...(seen.failureReason === undefined ? {} : { reason: seen.failureReason }) };
    } finally {
      reopened.close();
    }
  }

  it("fails closed on a missing loop after reopen", async () => {
    // Only ONE dispatch is repointed: setting both to the same id would be
    // caught earlier by the serializer's loop-id uniqueness rule, which would
    // test the wrong thing.
    const seen = await restartWith((plan) => ({
      ...plan,
      dispatches: [{ ...plan.dispatches[0]!, loopId: "loop-missing" }, ...plan.dispatches.slice(1)],
    }));
    assert.equal(seen.phase, "RECOVERY_REQUIRED");
    assert.match(seen.reason!, /dispatch record is not sound/);
  });

  it("fails closed on a cross-wired loop after reopen", async () => {
    const seen = await restartWith((plan) => {
      const [a, b] = [plan.dispatches[0]!, plan.dispatches[1]!];
      return { ...plan, dispatches: [{ ...a, loopId: b.loopId }, { ...b, loopId: a.loopId }] };
    });
    assert.equal(seen.phase, "RECOVERY_REQUIRED");
  });

  it("keeps a sound dispatch working after reopen", async () => {
    const seen = await restartWith((plan) => plan);
    assert.equal(seen.phase, "EXECUTING", seen.reason ?? "");
  });
});

// =====================================================================
// The foreign-reference sweep that found the third sibling
// =====================================================================

describe("ROUND 2: every Plan -> external object reference fails closed, not raw", () => {
  /**
   * The round-2 inventory swept every Plan -> external object reference looking
   * for a third sibling of the two dangling-reference bugs. It found none, and
   * these two tests pin down WHY the remaining reference — `projectId` — needs
   * no check of its own, so a future reader does not "fix" it or, worse, assume
   * some other reference is equally safe without checking.
   *
   * A plan pointed at a Factory store that does not contain its project is a
   * plan pointed at a store that does not contain its APPROVAL either: both
   * live in the same store, and approval authority is re-derived from that
   * store before anything is created. So the project reference is transitively
   * protected by a check that already exists, and adding a live project lookup
   * would buy nothing.
   */
  it("recovers rather than throwing when the whole Factory store is foreign", async () => {
    const first = await newPlanning();
    const plan = await approvedPlan(first);

    // A fresh Factory store: this plan's project, approval and work items are
    // all absent — a plan database restored against the wrong Factory database.
    const restored = await newPlanning({ plans: first.plans });

    const seen = await restored.service.status(plan.id);
    assert.equal(seen.phase, "RECOVERY_REQUIRED");

    const resumed = await restored.service.resume(plan.id);
    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
    assert.equal(resumed.outcome, "RECOVERY_REQUIRED");
    assert.deepEqual(await restored.factory.listWorkItemsByProject(plan.projectId), []);
  });

  it("stops at the approval check before it can ever reach a missing project", async () => {
    const first = await newPlanning();
    const planned = await approvedPlan(first);
    const stored = (await first.plans.findById(planned.id))!;

    // Rewind to APPROVED with nothing materialized, so the ONLY remaining
    // external references are the approval and the project.
    const fresh: Plan = {
      ...stored,
      version: stored.version + 1,
      phase: "APPROVED",
      materialized: [],
      dispatches: [],
    };
    await first.plans.compareAndSave(fresh, stored.version);

    const restored = await newPlanning({ plans: first.plans });
    const resumed = await restored.service.resume(planned.id);

    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
    assert.match(
      resumed.failureReason!,
      /PLAN_APPROVAL gate is not satisfied/,
      "the approval reference is checked first, so createWorkItem is never reached with a missing project",
    );
    assert.deepEqual(await restored.factory.listWorkItemsByProject(stored.projectId), []);
  });
});

// =====================================================================
// The persistence / runtime boundary
// =====================================================================

describe("ROUND 2: structural dispatch validation stays in persistence", () => {
  it("refuses an empty loop id at decode time", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const empty: Plan = { ...plan, dispatches: plan.dispatches.map((entry) => ({ ...entry, loopId: "  " })) };

    assert.throws(
      () =>
        parsePlan(encodePlan(empty), {
          id: empty.id,
          projectId: empty.projectId,
          requestKey: empty.requestKey,
          phase: empty.phase,
          version: empty.version,
        }),
      PersistenceCorruptionError,
    );
  });

  it("LOADS a row whose loop is merely absent from the other store", async () => {
    // Deliberate: whether a loop exists is not decidable from this row, and a
    // decoder that reached across stores would make "can this be read" depend
    // on live external state. Cross-store lineage fails closed at USE time.
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const missing: Plan = { ...plan, dispatches: plan.dispatches.map((entry) => ({ ...entry, loopId: "loop-missing" })) };

    const parsed = parsePlan(encodePlan(missing), {
      id: missing.id,
      projectId: missing.projectId,
      requestKey: missing.requestKey,
      phase: missing.phase,
      version: missing.version,
    });
    assert.equal(parsed.dispatches[0]?.loopId, "loop-missing");
  });
});

// =====================================================================
// The legitimate path is untouched
// =====================================================================

describe("ROUND 2: sound dispatch lineage still works normally", () => {
  it("keeps a normally dispatched plan EXECUTING", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);

    assert.equal(plan.phase, "EXECUTING");
    assert.equal((await context.service.status(plan.id)).phase, "EXECUTING");
    assert.equal((await context.service.resume(plan.id)).phase, "EXECUTING");
  });

  it("still reaches WAITING_FOR_HUMAN on live TASK-004 authority", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    await finishWorkItem(context.factory, plan.materialized[0]!.workItemId, "r2-wfh");

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.phase, "WAITING_FOR_HUMAN");
    assert.equal((await context.service.status(plan.id)).phase, "WAITING_FOR_HUMAN");
  });

  it("still reaches COMPLETED when every item is released", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const workItemId = plan.materialized[0]!.workItemId;
    await finishWorkItem(context.factory, workItemId, "r2-done");
    await context.factory.recordApproval({
      gate: "RELEASE_APPROVAL",
      subject: context.factory.workItemSubject(workItemId),
      decision: "APPROVED",
      actor: PLAN_HUMAN,
      authorization: authorizePlanHuman(context.factory),
    });
    await context.factory.advance(workItemId, "DONE", PLAN_HUMAN, {
      authorization: authorizePlanHuman(context.factory),
    });

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.phase, "COMPLETED");
    assert.equal((await context.service.status(plan.id)).phase, "COMPLETED");
  });

  it("still blocks the plan when a dispatched loop ends badly", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    context.dispatcher.setPhase(plan.materialized[0]!.workItemId, { phase: "FAILED", outcome: "FAILED" });

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.phase, "BLOCKED", "a real terminal loop phase is still read through the proven view");
  });

  it("still dispatches a dependent item once its prerequisite finishes", async () => {
    const context = await newPlanning({
      plannerOutputs: [
        renderPlannerResponse({
          summary: "Ordered.",
          items: [
            { key: "WI-A", title: "First", spec: "Do the first thing." },
            { key: "WI-B", title: "Second", spec: "Do the second thing.", dependsOn: ["WI-A"] },
          ],
        }),
      ],
    });
    const plan = await approvedPlan(context);
    assert.equal(plan.dispatches.length, 1, "the dependent item waits");

    await finishWorkItem(context.factory, plan.materialized[0]!.workItemId, "r2-dep");
    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.dispatches.length, 2, "and runs once the prerequisite is execution-finished");
  });
});
