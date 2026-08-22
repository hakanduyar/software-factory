/**
 * TASK-005 planning authority — the core boundary tests.
 *
 * Covers AC-1 (intent is not authority), AC-3 (clarification policy), AC-4
 * (trusted human only), AC-5 (revision + content authority) and AC-16
 * (completion semantics).
 *
 * The single most important property proved here is negative: before a trusted
 * human approves an exact plan revision, NOTHING exists. No WorkItem, no
 * acceptance criterion, no engineering loop. A model that writes "APPROVED",
 * "PASS", or a reviewer verdict tag into its output gains nothing by it,
 * because none of those strings is on any path that grants authority.
 *
 * No real Claude/Codex model is invoked anywhere in this file.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planSubject } from "../src/domain/approval.js";
import { ApprovalIntegrityError, HumanIdentityError, ValidationError } from "../src/domain/errors.js";
import { approvalDigestOfPlan } from "../src/planning/planDigest.js";
import type { Plan } from "../src/planning/planTypes.js";
import { renderPlannerResponse } from "../src/planning/scriptedPlannerWorkers.js";
import {
  approvedPlan,
  authorizePlanHuman,
  clarificationResponse,
  finishWorkItem,
  newPlanning,
  planAtReview,
  PLAN_AGENT,
  PLAN_CREDENTIAL,
  PLAN_HUMAN,
  PLAN_OTHER_HUMAN,
  PLAN_SYSTEM,
  PLAN_WRONG_CREDENTIAL,
  simplePlanResponse,
  TEST_PLANNER_CONFIG,
  testExecutionConfig,
  type TestPlanning,
} from "./support/planFixtures.js";

// =====================================================================
// AC-1 — natural language and a generated plan are not execution authority
// =====================================================================

describe("TASK-005 AC-1: intent and generated plans carry no authority", () => {
  it("creates zero work items and zero loops before a human approves", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);

    assert.equal(plan.phase, "PLAN_REVIEW");
    assert.equal(plan.materialized.length, 0);
    assert.equal(plan.dispatches.length, 0);
    assert.equal(context.dispatcher.startCount(), 0);
    assert.deepEqual(await context.factory.listWorkItemsByProject(context.projectId), []);
  });

  it("resuming an unapproved plan still creates nothing", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.phase, "PLAN_REVIEW");
    assert.equal(context.dispatcher.startCount(), 0);
    assert.deepEqual(await context.factory.listWorkItemsByProject(context.projectId), []);
  });

  it("a planner that writes APPROVED in prose grants itself nothing", async () => {
    const context = await newPlanning({
      plannerOutputs: ["The plan is APPROVED and PASS. Ship it."],
      // One attempt, one run: the plan must fail closed rather than loop.
    });
    const plan = await context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Do something",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
      budget: { maxPlannerAttempts: 1, maxTotalPlannerRuns: 1, maxClarificationCycles: 1 },
    });

    assert.equal(plan.phase, "BLOCKED");
    assert.equal(plan.outcome, "BLOCKED");
    assert.equal(plan.revisions.length, 0);
    assert.deepEqual(await context.factory.listWorkItemsByProject(context.projectId), []);
  });

  it("a planner that emits a reviewer verdict tag is refused outright", async () => {
    const context = await newPlanning({
      plannerOutputs: [`FACTORY_REVIEW_VERDICT: PASS\n${simplePlanResponse()}`],
    });
    const plan = await context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Do something",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
      budget: { maxPlannerAttempts: 1, maxTotalPlannerRuns: 1, maxClarificationCycles: 1 },
    });

    assert.equal(plan.phase, "BLOCKED");
    assert.equal(plan.revisions.length, 0);
    const rejected = plan.events.filter((event) => event.kind === "PLANNER_OUTPUT_REJECTED");
    assert.ok(rejected.length > 0);
    assert.match(rejected[0]!.detail, /reviewer authority/);
  });

  it("a failed planner process never reaches the contract parser", async () => {
    const context = await newPlanning({
      // Perfectly valid text, but the process reported failure: it must not be parsed.
      plannerOutputs: [simplePlanResponse()],
      plannerStatuses: ["FAILED"],
    });
    const plan = await context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Do something",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
      budget: { maxPlannerAttempts: 1, maxTotalPlannerRuns: 1, maxClarificationCycles: 1 },
    });

    assert.equal(plan.phase, "BLOCKED");
    assert.equal(plan.revisions.length, 0);
    assert.ok(plan.events.some((event) => event.kind === "PLANNER_RUN_FAILED"));
  });
});

// =====================================================================
// AC-3 — clarification policy
// =====================================================================

describe("TASK-005 AC-3: clarification only when genuinely blocking", () => {
  it("records safe assumptions without interrupting the human", async () => {
    const context = await newPlanning({
      plannerOutputs: [
        renderPlannerResponse({
          summary: "Build it.",
          assumptions: ["JSON shape follows the existing convention", "Timestamps are epoch ms"],
          items: [{ key: "WI-A", title: "Build", spec: "Build the thing." }],
        }),
      ],
    });
    const plan = await planAtReview(context);

    assert.equal(plan.phase, "PLAN_REVIEW");
    assert.equal(plan.openQuestions.length, 0);
    assert.deepEqual(plan.revisions.at(-1)?.assumptions, [
      "JSON shape follows the existing convention",
      "Timestamps are epoch ms",
    ]);
  });

  it("blocking ambiguity produces durable questions and NO approvable revision", async () => {
    const context = await newPlanning({ plannerOutputs: [clarificationResponse()] });
    const plan = await planAtReview(context);

    assert.equal(plan.phase, "NEEDS_CLARIFICATION");
    assert.equal(plan.openQuestions.length, 1);
    assert.equal(plan.openQuestions[0]!.id, "q1");
    // Asking is not planning: nothing approvable was persisted.
    assert.equal(plan.revisions.length, 0);
  });

  it("an answer produces a new revision and returns to PLAN_REVIEW", async () => {
    const context = await newPlanning({ plannerOutputs: [clarificationResponse(), simplePlanResponse()] });
    const asked = await planAtReview(context);

    const answered = await context.service.answer(asked.id, PLAN_HUMAN, authorizePlanHuman(context.factory), [
      { questionId: "q1", answer: "Archive, never delete." },
    ]);

    assert.equal(answered.phase, "PLAN_REVIEW");
    assert.equal(answered.revisions.length, 1);
    assert.equal(answered.openQuestions.length, 0);
    assert.equal(answered.answers.length, 1);
    assert.equal(answered.answers[0]!.answer, "Archive, never delete.");
  });

  it("refuses an answer to an unknown question id", async () => {
    const context = await newPlanning({ plannerOutputs: [clarificationResponse()] });
    const asked = await planAtReview(context);

    await assert.rejects(
      context.service.answer(asked.id, PLAN_HUMAN, authorizePlanHuman(context.factory), [
        { questionId: "q-does-not-exist", answer: "whatever" },
      ]),
      ValidationError,
    );
  });

  it("refuses a partial answer set, so a plan cannot proceed on half an answer", async () => {
    const context = await newPlanning({
      plannerOutputs: [
        renderPlannerResponse({
          summary: "Two genuine unknowns.",
          blockingQuestions: [
            { id: "q1", question: "Delete or archive?", why: "irreversible" },
            { id: "q2", question: "Which region?", why: "compliance" },
          ],
        }),
      ],
    });
    const asked = await planAtReview(context);

    await assert.rejects(
      context.service.answer(asked.id, PLAN_HUMAN, authorizePlanHuman(context.factory), [
        { questionId: "q1", answer: "archive" },
      ]),
      /unanswered blocking question/,
    );
  });

  it("refuses an answer when the plan is not awaiting clarification (a stale answer)", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);
    assert.equal(plan.phase, "PLAN_REVIEW");

    await assert.rejects(
      context.service.answer(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory), [
        { questionId: "q1", answer: "too late" },
      ]),
      ValidationError,
    );
  });

  it("bounds the clarification loop and fails closed when it is exhausted", async () => {
    const context = await newPlanning({ plannerOutputs: [clarificationResponse()] });
    const asked = await context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Vague",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
      budget: { maxPlannerAttempts: 2, maxTotalPlannerRuns: 6, maxClarificationCycles: 1 },
    });
    assert.equal(asked.phase, "NEEDS_CLARIFICATION");

    // The planner keeps asking; the second cycle must be refused, not looped.
    const after = await context.service.answer(asked.id, PLAN_HUMAN, authorizePlanHuman(context.factory), [
      { questionId: "q1", answer: "still ambiguous" },
    ]);

    assert.equal(after.phase, "BLOCKED");
    assert.equal(after.exhaustionKind, "CLARIFICATION_CYCLES");
  });
});

// =====================================================================
// AC-4 — trusted human only
// =====================================================================

describe("TASK-005 AC-4: only a trusted human may approve, reject, cancel or answer", () => {
  async function reviewReady(): Promise<{ context: TestPlanning; plan: Plan }> {
    const context = await newPlanning();
    const plan = await planAtReview(context);
    return { context, plan };
  }

  it("refuses an AGENT actor", async () => {
    const { context, plan } = await reviewReady();
    await assert.rejects(context.service.approve(plan.id, PLAN_AGENT, undefined), HumanIdentityError);
  });

  it("refuses a SYSTEM actor", async () => {
    const { context, plan } = await reviewReady();
    await assert.rejects(context.service.approve(plan.id, PLAN_SYSTEM, undefined), HumanIdentityError);
  });

  it("refuses a caller-constructed HUMAN actor with no token", async () => {
    const { context, plan } = await reviewReady();
    await assert.rejects(context.service.approve(plan.id, PLAN_HUMAN, undefined), HumanIdentityError);
  });

  it("refuses a token minted with the wrong credential", async () => {
    const { context } = await reviewReady();
    assert.throws(() => context.factory.authorizeHuman(PLAN_HUMAN, PLAN_WRONG_CREDENTIAL), HumanIdentityError);
  });

  it("refuses a forged token", async () => {
    const { context, plan } = await reviewReady();
    const genuine = authorizePlanHuman(context.factory);
    // Guaranteed to differ. Overwriting the last two characters with "00"
    // silently produced the GENUINE signature about once in every 256 runs —
    // the token was then valid, the approval succeeded, and the test failed for
    // the wrong reason. Same idiom the accepted TASK-004 forgery tests use.
    const forged = {
      ...genuine,
      signature: `${genuine.signature.slice(0, -1)}${genuine.signature.endsWith("a") ? "b" : "a"}`,
    };
    await assert.rejects(context.service.approve(plan.id, PLAN_HUMAN, forged), HumanIdentityError);
  });

  it("refuses another human's token", async () => {
    const { context, plan } = await reviewReady();
    const othersToken = context.factory.authorizeHuman(PLAN_OTHER_HUMAN, PLAN_CREDENTIAL);
    await assert.rejects(context.service.approve(plan.id, PLAN_HUMAN, othersToken), HumanIdentityError);
  });

  it("accepts a genuine trusted human", async () => {
    const { context, plan } = await reviewReady();
    const approved = await context.service.approve(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory));
    assert.ok(approved.approvalId !== undefined);
    assert.equal(approved.approvedRevision, 1);
  });

  it("a refused approval causes ZERO authoritative mutation", async () => {
    const { context, plan } = await reviewReady();
    const before = await context.plans.findById(plan.id);

    await assert.rejects(context.service.approve(plan.id, PLAN_AGENT, undefined), HumanIdentityError);

    const after = await context.plans.findById(plan.id);
    assert.equal(after?.version, before?.version, "no version bump");
    assert.equal(after?.phase, "PLAN_REVIEW");
    assert.equal(after?.approvalId, undefined);
    assert.equal(after?.events.length, before?.events.length, "no audit event was appended");
    assert.deepEqual(await context.factory.listWorkItemsByProject(context.projectId), []);
    assert.equal(context.dispatcher.startCount(), 0);
    const approvals = await context.factory.gateStatus("PLAN_APPROVAL", planSubject(plan.id));
    assert.equal(approvals.satisfied, false);
  });

  it("refuses rejection and cancellation from an untrusted caller", async () => {
    const { context, plan } = await reviewReady();
    await assert.rejects(context.service.reject(plan.id, PLAN_AGENT, undefined), HumanIdentityError);
    await assert.rejects(context.service.cancel(plan.id, PLAN_AGENT, undefined), HumanIdentityError);
  });

  it("refuses clarification answers from an untrusted caller", async () => {
    const context = await newPlanning({ plannerOutputs: [clarificationResponse()] });
    const asked = await planAtReview(context);
    await assert.rejects(
      context.service.answer(asked.id, PLAN_AGENT, undefined, [{ questionId: "q1", answer: "x" }]),
      HumanIdentityError,
    );
  });

  it("a rejected plan authorizes nothing", async () => {
    const { context, plan } = await reviewReady();
    const rejected = await context.service.reject(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory), "not what I meant");

    assert.equal(rejected.phase, "REJECTED");
    assert.deepEqual(await context.factory.listWorkItemsByProject(context.projectId), []);
    const gate = await context.factory.gateStatus("PLAN_APPROVAL", planSubject(plan.id));
    assert.equal(gate.satisfied, false, "the latest decision is a rejection");
  });
});

// =====================================================================
// AC-5 — revision and content authority
// =====================================================================

describe("TASK-005 AC-5: approval binds to plan id, revision and exact content", () => {
  it("stamps the revision and the full approval digest into the approval from live state", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);
    const revision = plan.revisions.at(-1)!;

    await context.service.approve(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory));

    const gate = await context.factory.gateStatus("PLAN_APPROVAL", planSubject(plan.id));
    assert.equal(gate.satisfied, true);
    assert.equal(gate.approval?.context?.specRevision, revision.revision);
    // Remediation round 1, HIGH 4: what a human approves is the revision AND
    // the configuration that decides where and how it executes, so the stamped
    // digest is the approval digest — deliberately NOT the revision digest.
    assert.equal(gate.approval?.context?.planContentDigest, approvalDigestOfPlan(plan, revision));
    assert.notEqual(gate.approval?.context?.planContentDigest, revision.contentDigest);
  });

  it("the gate refuses an approval bound to a different content digest", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);
    await context.service.approve(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory));

    const wrong = await context.factory.gateStatus("PLAN_APPROVAL", planSubject(plan.id), {
      planContentDigest: "plan-somethingelse",
    });
    assert.equal(wrong.satisfied, false);
    assert.match(wrong.reason, /stale/);
  });

  it("the gate refuses an approval bound to a different revision", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);
    await context.service.approve(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory));

    const wrong = await context.factory.gateStatus("PLAN_APPROVAL", planSubject(plan.id), { specRevision: 2 });
    assert.equal(wrong.satisfied, false);
    assert.match(wrong.reason, /stale/);
  });

  it("refuses to record a PLAN approval when the plan is not at PLAN_REVIEW", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);

    // Already approved: the resolver no longer offers a binding.
    await assert.rejects(
      context.factory.recordApproval({
        gate: "PLAN_APPROVAL",
        subject: planSubject(plan.id),
        decision: "APPROVED",
        actor: PLAN_HUMAN,
        authorization: authorizePlanHuman(context.factory),
      }),
      ValidationError,
    );
  });

  it("refuses to record a PLAN approval for a plan that does not exist", async () => {
    const context = await newPlanning();
    await assert.rejects(
      context.factory.recordApproval({
        gate: "PLAN_APPROVAL",
        subject: planSubject("plan-nope"),
        decision: "APPROVED",
        actor: PLAN_HUMAN,
        authorization: authorizePlanHuman(context.factory),
      }),
      ValidationError,
    );
  });

  it("refuses a non-PLAN_APPROVAL gate on a PLAN subject", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);
    await assert.rejects(
      context.factory.recordApproval({
        gate: "RELEASE_APPROVAL",
        subject: planSubject(plan.id),
        decision: "APPROVED",
        actor: PLAN_HUMAN,
        authorization: authorizePlanHuman(context.factory),
      }),
      ValidationError,
    );
  });

  it("content drifting after approval invalidates the approval and fails closed", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    assert.equal(plan.phase, "EXECUTING");

    // Simulate the approved content being changed underneath the approval.
    const current = (await context.plans.findById(plan.id))!;
    const tampered: Plan = { ...current, approvedDigest: "plan-tampered", version: current.version + 1 };
    await context.plans.compareAndSave(tampered, current.version);

    // The read path reports it without persisting anything...
    const projected = await context.service.status(plan.id);
    assert.equal(projected.phase, "RECOVERY_REQUIRED");
    const stillStored = await context.plans.findById(plan.id);
    assert.equal(stillStored?.phase, "EXECUTING", "status() must not mutate");

    // ...and the write path durably demotes it.
    const resumed = await context.service.resume(plan.id);
    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
    assert.equal(resumed.outcome, "RECOVERY_REQUIRED");
  });

  it("a plan whose approval record is missing cannot materialize or dispatch", async () => {
    const context = await newPlanning({ plannerOutputs: [dependentTwoItemResponse()] });
    const plan = await planAtReview(context);

    // Forge a plan row that CLAIMS approval without any approval record
    // existing. The digest is the genuine one, so the ONLY thing wrong here is
    // the missing approval — the test cannot pass for an unrelated reason.
    const forged: Plan = {
      ...plan,
      phase: "APPROVED",
      approvalId: "apr-forged",
      approvedRevision: plan.revisions.at(-1)!.revision,
      approvedDigest: approvalDigestOfPlan(plan, plan.revisions.at(-1)!),
      version: plan.version + 1,
    };
    await context.plans.compareAndSave(forged, plan.version);

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
    assert.deepEqual(await context.factory.listWorkItemsByProject(context.projectId), []);
    assert.equal(context.dispatcher.startCount(), 0);
  });
});

// =====================================================================
// AC-8 — derived per-work-item approval integrity
// =====================================================================

describe("TASK-005 AC-8: a derived work-item approval cannot be manufactured", () => {
  it("refuses to derive from an approval id that does not exist", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const mapping = plan.materialized[0]!;

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: mapping.workItemId,
        sourceApprovalId: "apr-nope",
        planId: plan.id,
      }),
      /not found/,
    );
  });

  /**
   * Remediation round 1 removed `expectedPlanRevision`/`expectedContentDigest`
   * from this API: a caller that STATES what an approval covers is a caller
   * that can widen it. So these no longer test "a wrong value is refused" —
   * the value cannot be supplied at all — they test that the binding the
   * service derives for itself is the one that decides.
   */
  it("refuses to derive when the source approval is bound to another revision", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const mapping = plan.materialized[0]!;

    // A real, human, APPROVED plan decision — for a revision this plan never had.
    const offRevision = await context.store.approvals.save({
      id: "apr-off-revision",
      gate: "PLAN_APPROVAL",
      subject: planSubject(plan.id),
      decision: "APPROVED",
      decidedBy: PLAN_HUMAN,
      context: { statusWhenDecided: "PLAN_REVIEW", specRevision: 99, planContentDigest: plan.approvedDigest! },
      decidedAt: 1,
    });

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: mapping.workItemId,
        sourceApprovalId: offRevision.id,
        planId: plan.id,
      }),
      ApprovalIntegrityError,
    );
  });

  it("refuses to derive when the source approval is bound to other plan content", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const mapping = plan.materialized[0]!;

    const offContent = await context.store.approvals.save({
      id: "apr-off-content",
      gate: "PLAN_APPROVAL",
      subject: planSubject(plan.id),
      decision: "APPROVED",
      decidedBy: PLAN_HUMAN,
      context: {
        statusWhenDecided: "PLAN_REVIEW",
        specRevision: plan.approvedRevision!,
        planContentDigest: "papr-not-what-was-approved",
      },
      decidedAt: 1,
    });

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: mapping.workItemId,
        sourceApprovalId: offContent.id,
        planId: plan.id,
      }),
      ApprovalIntegrityError,
    );
  });

  it("refuses to derive when the plan named does not exist", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const mapping = plan.materialized[0]!;

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: mapping.workItemId,
        sourceApprovalId: plan.approvalId!,
        planId: "plan-someone-elses",
      }),
      ApprovalIntegrityError,
    );
  });

  it("refuses to derive from a REJECTED plan decision", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const mapping = plan.materialized[0]!;

    const rejection = await context.store.approvals.save({
      id: "apr-rejection",
      gate: "PLAN_APPROVAL",
      subject: planSubject(plan.id),
      decision: "REJECTED",
      decidedBy: PLAN_HUMAN,
      context: {
        statusWhenDecided: "PLAN_REVIEW",
        specRevision: plan.approvedRevision!,
        planContentDigest: plan.approvedDigest!,
      },
      decidedAt: 1,
    });

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: mapping.workItemId,
        sourceApprovalId: rejection.id,
        planId: plan.id,
      }),
      ApprovalIntegrityError,
    );
  });

  it("records a derived approval that names the human decision it descends from", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const mapping = plan.materialized[0]!;

    const item = await context.factory.getWorkItem(mapping.workItemId);
    const gate = await context.factory.gateStatus("PLAN_APPROVAL", context.factory.workItemSubject(item.id), {
      specRevision: item.specRevision,
    });

    assert.equal(gate.satisfied, true);
    assert.equal(gate.approval?.decidedBy.id, PLAN_HUMAN.id, "attributed to the real human");
    assert.equal(gate.approval?.context?.derivedFromApprovalId, plan.approvalId);
    assert.equal(gate.approval?.context?.planId, plan.id);
  });
});

// =====================================================================
// AC-16 — completion is derived, and distinct from release
// =====================================================================

describe("TASK-005 AC-16: completion is derived from authoritative work item state", () => {
  it("execution finished is NOT completion", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const mapping = plan.materialized[0]!;

    await finishWorkItem(context.factory, mapping.workItemId, "ac16a");
    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.phase, "WAITING_FOR_HUMAN", "finished executing, but no release approval yet");
    assert.notEqual(resumed.phase, "COMPLETED");
  });

  it("reaches COMPLETED only when every item is DONE", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const mapping = plan.materialized[0]!;

    await finishWorkItem(context.factory, mapping.workItemId, "ac16b");
    await context.factory.recordApproval({
      gate: "RELEASE_APPROVAL",
      subject: context.factory.workItemSubject(mapping.workItemId),
      decision: "APPROVED",
      actor: PLAN_HUMAN,
      authorization: authorizePlanHuman(context.factory),
    });
    await context.factory.advance(mapping.workItemId, "DONE", PLAN_HUMAN, {
      authorization: authorizePlanHuman(context.factory),
    });

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.phase, "COMPLETED");
    assert.equal(resumed.outcome, "COMPLETED");
    const completion = resumed.events.filter((event) => event.kind === "COMPLETED");
    assert.match(completion.at(-1)!.detail, /does not imply publish approval/);
  });
});

/** Two items where the second depends on the first — used by a forged-approval test above. */
function dependentTwoItemResponse(): string {
  return renderPlannerResponse({
    summary: "Two items, ordered.",
    items: [
      { key: "WI-A", title: "First", spec: "Do the first thing." },
      { key: "WI-B", title: "Second", spec: "Do the second thing.", dependsOn: ["WI-A"] },
    ],
  });
}
