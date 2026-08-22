/**
 * TASK-005 concurrency, cancellation and unattended execution.
 *
 * Covers AC-12 (races are prevented by durable CAS / database constraints, not
 * by caller discipline) and AC-13 (after approval, everything proceeds with
 * zero routine human prompts).
 *
 * Note on what "concurrent" means here: these run on one event loop, so the
 * interleavings tested are the ones a single-threaded process can actually
 * produce — two operations reading the same version before either writes. That
 * is exactly the shape the CAS token exists to resolve, and the losing writer
 * must lose safely rather than duplicate work. Cross-process races are covered
 * where they belong: at the database constraint, in the repository tests.
 *
 * No real Claude/Codex model is invoked anywhere in this file.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planSubject } from "../src/domain/approval.js";
import { ConcurrencyError, HumanIdentityError } from "../src/domain/errors.js";
import { buildPlannerPrompt } from "../src/planning/planPrompts.js";
import { renderPlannerResponse } from "../src/planning/scriptedPlannerWorkers.js";
import type { Plan } from "../src/planning/planTypes.js";
import {
  approvedPlan,
  authorizePlanHuman,
  newPlanning,
  planAtReview,
  PLAN_AGENT,
  PLAN_CREDENTIAL,
  PLAN_HUMAN,
  simplePlanResponse,
  TEST_PLANNER_CONFIG,
  testExecutionConfig,
} from "./support/planFixtures.js";

const A_THEN_B = renderPlannerResponse({
  summary: "Two ordered items.",
  items: [
    { key: "WI-A", title: "First", spec: "Do the first thing." },
    { key: "WI-B", title: "Second", spec: "Do the second thing.", dependsOn: ["WI-A"] },
  ],
});

// =====================================================================
// AC-12 — races
// =====================================================================

describe("TASK-005 AC-12: duplicate work is prevented structurally", () => {
  it("starting the same intent twice adopts the existing plan instead of duplicating it", async () => {
    const context = await newPlanning();
    const first = await context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Build exactly this.",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });
    const second = await context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Build exactly this.",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });

    assert.equal(second.id, first.id, "the same request key adopts the same plan");
    assert.equal(second.requestKey, first.requestKey);
  });

  it("a different intent is a different request", async () => {
    const context = await newPlanning();
    const first = await context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Build thing one.",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });
    const second = await context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Build thing two.",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });

    assert.notEqual(second.id, first.id);
    assert.notEqual(second.requestKey, first.requestKey);
  });

  it("concurrent starts of one intent settle on a single plan", async () => {
    const context = await newPlanning();
    const input = {
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Concurrent start.",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    };

    const results = await Promise.allSettled([context.service.start(input), context.service.start(input)]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const ids = new Set(fulfilled.map((result) => (result as PromiseFulfilledResult<Plan>).value.id));
    assert.equal(ids.size, 1, "at most one plan exists for the request");
    // Whichever lost must have lost cleanly, not silently created a second plan.
    for (const result of results) {
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof ConcurrencyError, `unexpected rejection: ${String(result.reason)}`);
      }
    }
  });

  it("concurrent resumes never duplicate work items or loops", async () => {
    const context = await newPlanning({ plannerOutputs: [A_THEN_B] });
    const plan = await approvedPlan(context);
    const itemsBefore = (await context.factory.listWorkItemsByProject(context.projectId)).length;
    const startsBefore = context.dispatcher.startCount();

    await Promise.allSettled([
      context.service.resume(plan.id),
      context.service.resume(plan.id),
      context.service.resume(plan.id),
    ]);

    assert.equal((await context.factory.listWorkItemsByProject(context.projectId)).length, itemsBefore);
    assert.equal(context.dispatcher.startCount(), startsBefore);
    const stored = await context.plans.findById(plan.id);
    assert.equal(new Set(stored?.materialized.map((entry) => entry.planItemKey)).size, stored?.materialized.length);
    assert.equal(new Set(stored?.dispatches.map((entry) => entry.planItemKey)).size, stored?.dispatches.length);
  });

  it("concurrent approvals settle on one approved revision", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);

    const results = await Promise.allSettled([
      context.service.approve(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory)),
      context.service.approve(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory)),
    ]);

    const stored = await context.plans.findById(plan.id);
    assert.equal(stored?.approvedRevision, 1);
    assert.equal((await context.factory.listWorkItemsByProject(context.projectId)).length, 1, "one item, not two");
    assert.equal(context.dispatcher.startCount(), 1, "one loop, not two");
    for (const result of results) {
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof ConcurrencyError, `unexpected rejection: ${String(result.reason)}`);
      }
    }
  });

  it("a plan already approved cannot be approved again for a new revision", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);

    await assert.rejects(
      context.service.approve(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory)),
      /only a plan at PLAN_REVIEW may be approved/,
    );
  });
});

// =====================================================================
// Cancellation (design §14)
// =====================================================================

describe("TASK-005: cancellation is a trusted-human governance action", () => {
  it("cancels before approval, having created nothing", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);

    const cancelled = await context.service.cancel(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory));

    assert.equal(cancelled.phase, "CANCELLED");
    assert.equal(cancelled.outcome, "CANCELLED");
    assert.deepEqual(await context.factory.listWorkItemsByProject(context.projectId), []);
    assert.equal(context.dispatcher.startCount(), 0);
  });

  it("a cancelled plan can never be approved afterwards", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);
    await context.service.cancel(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory));

    await assert.rejects(
      context.service.approve(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory)),
      /durable cancellation request/,
    );
  });

  it("refuses to record a plan approval once cancellation is durable", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);
    const current = (await context.plans.findById(plan.id))!;
    await context.plans.compareAndSave({ ...current, cancelRequested: true, version: current.version + 1 }, current.version);

    await assert.rejects(
      context.factory.recordApproval({
        gate: "PLAN_APPROVAL",
        subject: planSubject(plan.id),
        decision: "APPROVED",
        actor: PLAN_HUMAN,
        authorization: authorizePlanHuman(context.factory),
      }),
      /cancellation/,
    );
  });

  it("no new dispatch happens after cancellation, and existing work is left for the human", async () => {
    const context = await newPlanning({ plannerOutputs: [A_THEN_B] });
    const plan = await approvedPlan(context);
    assert.equal(plan.dispatches.length, 1, "WI-A dispatched, WI-B waiting");

    const cancelled = await context.service.cancel(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory));
    assert.equal(cancelled.phase, "CANCELLED");

    // Even a resume after cancellation must not launch the waiting item.
    const afterResume = await context.service.resume(plan.id);
    assert.equal(afterResume.phase, "CANCELLED");
    assert.equal(afterResume.dispatches.length, 1);
    assert.equal(context.dispatcher.startCount(), 1);

    // Already-created work items are NOT mass-cancelled; a human decides.
    const items = await context.factory.listWorkItemsByProject(context.projectId);
    assert.equal(items.length, 2);
    assert.ok(items.every((item) => item.status !== "CANCELLED"));
  });

  it("a durable cancellation request beats an in-flight drive", async () => {
    const context = await newPlanning({ plannerOutputs: [A_THEN_B] });
    const plan = await approvedPlan(context);

    const current = (await context.plans.findById(plan.id))!;
    await context.plans.compareAndSave({ ...current, cancelRequested: true, version: current.version + 1 }, current.version);

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.phase, "CANCELLED");
    assert.equal(context.dispatcher.startCount(), 1, "the waiting item was never launched");
  });

  it("cancelling twice is idempotent", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);
    const first = await context.service.cancel(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory));
    const second = await context.service.cancel(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory));

    assert.equal(first.phase, "CANCELLED");
    assert.equal(second.phase, "CANCELLED");
    assert.equal(second.version, first.version, "the second cancel wrote nothing");
  });

  it("refuses cancellation from an untrusted caller, with zero mutation", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const before = await context.plans.findById(plan.id);

    await assert.rejects(context.service.cancel(plan.id, PLAN_AGENT, undefined), HumanIdentityError);

    const after = await context.plans.findById(plan.id);
    assert.equal(after?.version, before?.version);
    assert.equal(after?.cancelRequested, false);
  });
});

// =====================================================================
// AC-13 — unattended execution
// =====================================================================

describe("TASK-005 AC-13: approved execution proceeds with no human prompts", () => {
  it("materializes and dispatches with no interactive input at all", async () => {
    const context = await newPlanning({ plannerOutputs: [A_THEN_B] });

    // The whole approve -> materialize -> ready -> dispatch cycle runs to
    // completion inside one call, with nothing read from stdin and no callback
    // asking a question. If any step needed a human, this would hang or throw.
    const plan = await approvedPlan(context);

    assert.equal(plan.phase, "EXECUTING");
    assert.equal(plan.materialized.length, 2);
    assert.equal(plan.dispatches.length, 1);
  });

  /**
   * The structural no-interactive-I/O scan itself lives where that invariant
   * already lives — tests/unattendedExecutionInvariant.test.ts, whose SCAN_ROOTS
   * TASK-005 extends to `src/planning` and `src/adapters/planning`. Duplicating
   * it here would create a second, weaker copy of an accepted rule.
   *
   * What belongs here is the planning-specific half: the model-facing channel
   * must have no route through which a credential could reach a planner (C6).
   */
  it("hands the planner exactly the declared fields and nothing else (C6)", async () => {
    const seen: Record<string, unknown>[] = [];
    const context = await newPlanning({
      planner: {
        id: "spy-planner",
        async plan(request) {
          seen.push(request as unknown as Record<string, unknown>);
          return { status: "SUCCEEDED", rawOutput: simplePlanResponse(), summary: "spy" };
        },
      },
    });
    await planAtReview(context, "Build the thing.");

    assert.equal(seen.length, 1);
    // The allow-list IS the guarantee: anything the planning layer might later
    // add to this object would fail here rather than silently reach a model.
    assert.deepEqual(Object.keys(seen[0]!).sort(), [
      "answeredQuestions",
      "attempt",
      "constraints",
      "correlationTag",
      "intent",
      "outputContract",
      "planId",
      "projectKey",
      "projectRules",
      "revision",
    ]);
  });

  it("no value reachable by the planner contains the local credential", async () => {
    const seen: string[] = [];
    const context = await newPlanning({
      planner: {
        id: "spy-planner",
        async plan(request) {
          seen.push(JSON.stringify(request));
          return { status: "SUCCEEDED", rawOutput: simplePlanResponse(), summary: "spy" };
        },
      },
    });
    await planAtReview(context, "Build the thing.");

    assert.equal(seen.length, 1);
    assert.ok(!seen[0]!.includes(PLAN_CREDENTIAL), "the planner must never see the human identity credential");
  });

  it("the prompt built for a planner carries no credential and no gate reference", () => {
    // The prompt builder's only inputs are the request fields asserted above,
    // so this pins the rendered output too: a future edit that interpolated an
    // environment value would fail here.
    const prompt = buildPlannerPrompt({
      projectKey: "prj-1",
      intent: "Build the thing.",
      constraints: [],
      answeredQuestions: [],
      projectRules: ["Never weaken approval rules."],
      revision: 1,
      attempt: 1,
    });
    assert.ok(!prompt.includes(PLAN_CREDENTIAL));
    for (const token of ["authorizeHuman", "identityGate", "TrustedHumanToken"]) {
      assert.ok(!prompt.includes(token), `the planner prompt must not mention "${token}"`);
    }
    // ...while still stating the trust boundary the planner is operating under.
    assert.match(prompt, /has no authority/);
  });
});
