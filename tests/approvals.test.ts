/**
 * Protected approval gates (C1, C5, acceptance criterion 6), the trusted
 * human identity boundary, and the binding that decides whether an approval
 * still describes what is current.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PROTECTED_GATES, type ProtectedGate } from "../src/domain/approval.js";
import {
  ApprovalIntegrityError,
  ApprovalRequiredError,
  HumanIdentityError,
  ValidationError,
} from "../src/domain/errors.js";
import type { TrustedHumanToken } from "../src/domain/humanIdentity.js";
import {
  AGENT,
  FIXTURE_START_MS,
  HUMAN,
  OTHER_HUMAN,
  SYSTEM,
  TEST_CREDENTIAL,
  WRONG_CREDENTIAL,
  authorize,
  newFactory,
  registeredWorker,
  seedWorkItem,
  toWaitingForHuman,
} from "./support/factoryFixtures.js";

/** Drives a seeded item to PLAN_REVIEW, where a PLAN_APPROVAL may be decided. */
async function toPlanReview(factory: ReturnType<typeof newFactory>["factory"], itemId: string): Promise<void> {
  await factory.advance(itemId, "ANALYSIS", AGENT);
  await factory.advance(itemId, "PLAN_REVIEW", AGENT);
}

describe("trusted human identity boundary", () => {
  it("refuses authorizeHuman for a non-HUMAN actor", () => {
    const { factory } = newFactory();
    assert.throws(() => factory.authorizeHuman(AGENT, TEST_CREDENTIAL), HumanIdentityError);
    assert.throws(() => factory.authorizeHuman(SYSTEM, TEST_CREDENTIAL), HumanIdentityError);
  });

  it("refuses authorizeHuman with the wrong credential", () => {
    const { factory } = newFactory();
    assert.throws(() => factory.authorizeHuman(HUMAN, WRONG_CREDENTIAL), HumanIdentityError);
  });

  it("refuses a caller-created { kind: HUMAN } actor with no valid token", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toPlanReview(factory, item.id);

    const forged: TrustedHumanToken = {
      actorId: HUMAN.id,
      issuedAt: FIXTURE_START_MS,
      nonce: "forged",
      signature: "0".repeat(64),
    };

    await assert.rejects(
      factory.recordApproval({
        gate: "PLAN_APPROVAL",
        subject: factory.workItemSubject(item.id),
        decision: "APPROVED",
        actor: HUMAN,
        authorization: forged,
      }),
      HumanIdentityError,
    );
  });

  it("refuses a token minted for a different actor", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toPlanReview(factory, item.id);

    await assert.rejects(
      factory.recordApproval({
        gate: "PLAN_APPROVAL",
        subject: factory.workItemSubject(item.id),
        decision: "APPROVED",
        actor: HUMAN,
        authorization: authorize(factory, OTHER_HUMAN),
      }),
      HumanIdentityError,
    );
  });

  it("refuses a token whose signature has been tampered with", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toPlanReview(factory, item.id);
    const token = authorize(factory, HUMAN);
    const tampered: TrustedHumanToken = {
      ...token,
      signature: token.signature.replace(/^./, token.signature[0] === "a" ? "b" : "a"),
    };

    await assert.rejects(
      factory.recordApproval({
        gate: "PLAN_APPROVAL",
        subject: factory.workItemSubject(item.id),
        decision: "APPROVED",
        actor: HUMAN,
        authorization: tampered,
      }),
      HumanIdentityError,
    );
  });

  it("refuses an expired token", async () => {
    const { factory, clock } = newFactory();
    const item = await seedWorkItem(factory);
    await toPlanReview(factory, item.id);
    const token = authorize(factory, HUMAN);

    // Advance the clock well past the 15 minute default TTL.
    for (let i = 0; i < 20 * 60; i += 1) {
      clock.now();
    }

    await assert.rejects(
      factory.recordApproval({
        gate: "PLAN_APPROVAL",
        subject: factory.workItemSubject(item.id),
        decision: "APPROVED",
        actor: HUMAN,
        authorization: token,
      }),
      HumanIdentityError,
    );
  });

  it("accepts a valid token minted for the presenting actor and stamps the binding", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toPlanReview(factory, item.id);
    const atPlanReview = await factory.getWorkItem(item.id);

    const approval = await factory.recordApproval({
      gate: "PLAN_APPROVAL",
      subject: factory.workItemSubject(item.id),
      decision: "APPROVED",
      actor: HUMAN,
      authorization: authorize(factory),
      note: "looks right",
    });

    assert.equal(approval.decidedBy.id, HUMAN.id);
    assert.equal(approval.decidedBy.kind, "HUMAN");
    assert.equal(approval.note, "looks right");
    assert.equal(approval.context?.specRevision, atPlanReview.specRevision);
    assert.equal(approval.context?.statusWhenDecided, "PLAN_REVIEW");
  });
});

describe("approval integrity", () => {
  it("refuses approvals from AGENT and SYSTEM actors, for every gate, before even checking the token", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    const forged: TrustedHumanToken = {
      actorId: "irrelevant",
      issuedAt: FIXTURE_START_MS,
      nonce: "x",
      signature: "0".repeat(64),
    };

    for (const gate of PROTECTED_GATES) {
      for (const actor of [AGENT, SYSTEM]) {
        await assert.rejects(
          factory.recordApproval({
            gate,
            subject: factory.workItemSubject(item.id),
            decision: "APPROVED",
            actor,
            authorization: forged,
          }),
          (error: unknown) => {
            assert.ok(error instanceof ApprovalIntegrityError);
            assert.equal(error.code, "APPROVAL_INTEGRITY");
            return true;
          },
        );
      }
    }
  });

  it("names all four gates in the domain", () => {
    const expected: readonly ProtectedGate[] = [
      "PLAN_APPROVAL",
      "RELEASE_APPROVAL",
      "PUBLISH_APPROVAL",
      "CONSTITUTION_CHANGE",
    ];
    assert.deepEqual([...PROTECTED_GATES], [...expected]);
  });
});

describe("work-item gates are bound to the status where they are decided", () => {
  it("refuses PLAN_APPROVAL anywhere except PLAN_REVIEW", async () => {
    for (const status of ["IDEA", "ANALYSIS"] as const) {
      const { factory } = newFactory();
      const item = await seedWorkItem(factory);
      if (status === "ANALYSIS") {
        await factory.advance(item.id, "ANALYSIS", AGENT);
      }
      await assert.rejects(
        factory.recordApproval({
          gate: "PLAN_APPROVAL",
          subject: factory.workItemSubject(item.id),
          decision: "APPROVED",
          actor: HUMAN,
          authorization: authorize(factory),
        }),
        ValidationError,
        `PLAN_APPROVAL must not be recordable at ${status}`,
      );
    }
  });

  it("refuses RELEASE_APPROVAL anywhere except WAITING_FOR_HUMAN", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toPlanReview(factory, item.id);

    await assert.rejects(
      factory.recordApproval({
        gate: "RELEASE_APPROVAL",
        subject: factory.workItemSubject(item.id),
        decision: "APPROVED",
        actor: HUMAN,
        authorization: authorize(factory),
      }),
      ValidationError,
    );
  });

  it("leaves PUBLISH_APPROVAL and CONSTITUTION_CHANGE decidable at any status", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);

    for (const gate of ["PUBLISH_APPROVAL", "CONSTITUTION_CHANGE"] as const) {
      const approval = await factory.recordApproval({
        gate,
        subject: factory.workItemSubject(item.id),
        decision: "APPROVED",
        actor: HUMAN,
        authorization: authorize(factory),
      });
      assert.equal(approval.gate, gate);
    }
  });
});

describe("gate evaluation", () => {
  it("treats all four constitutional gates as unsatisfied by default", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);

    for (const gate of PROTECTED_GATES) {
      const subject = factory.workItemSubject(item.id);
      assert.equal((await factory.gateStatus(gate, subject)).satisfied, false, gate);
      await assert.rejects(factory.assertGateSatisfied(gate, subject), ApprovalRequiredError);
    }
  });

  it("opens only its own gate, never a sibling", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    const subject = factory.workItemSubject(item.id);

    await factory.recordApproval({
      gate: "PUBLISH_APPROVAL",
      subject,
      decision: "APPROVED",
      actor: HUMAN,
      authorization: authorize(factory),
    });

    assert.equal((await factory.gateStatus("PUBLISH_APPROVAL", subject)).satisfied, true);
    for (const other of PROTECTED_GATES.filter((gate) => gate !== "PUBLISH_APPROVAL")) {
      assert.equal((await factory.gateStatus(other, subject)).satisfied, false, `must not open ${other}`);
    }
  });

  it("does not let an approval on one work item open a gate on another", async () => {
    const { factory } = newFactory();
    const first = await seedWorkItem(factory);
    const second = await seedWorkItem(factory);

    await factory.recordApproval({
      gate: "PUBLISH_APPROVAL",
      subject: factory.workItemSubject(first.id),
      decision: "APPROVED",
      actor: HUMAN,
      authorization: authorize(factory),
    });

    assert.equal((await factory.gateStatus("PUBLISH_APPROVAL", factory.workItemSubject(second.id))).satisfied, false);
  });

  it("does not open a gate on a REJECTED decision", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    const subject = factory.workItemSubject(item.id);

    await factory.recordApproval({
      gate: "PUBLISH_APPROVAL",
      subject,
      decision: "REJECTED",
      actor: HUMAN,
      authorization: authorize(factory),
    });

    const status = await factory.gateStatus("PUBLISH_APPROVAL", subject);
    assert.equal(status.satisfied, false);
    assert.match(status.reason, /REJECTED/);
  });

  it("lets a later human REJECTED decision revoke an earlier APPROVED one", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    const subject = factory.workItemSubject(item.id);

    await factory.recordApproval({
      gate: "PUBLISH_APPROVAL",
      subject,
      decision: "APPROVED",
      actor: HUMAN,
      authorization: authorize(factory),
    });
    assert.equal((await factory.gateStatus("PUBLISH_APPROVAL", subject)).satisfied, true);

    await factory.recordApproval({
      gate: "PUBLISH_APPROVAL",
      subject,
      decision: "REJECTED",
      actor: HUMAN,
      authorization: authorize(factory),
    });
    assert.equal((await factory.gateStatus("PUBLISH_APPROVAL", subject)).satisfied, false);
  });

  it("distinguishes subject types with the same id", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);

    await factory.recordApproval({
      gate: "PUBLISH_APPROVAL",
      subject: { type: "ARTIFACT", id: item.id },
      decision: "APPROVED",
      actor: HUMAN,
      authorization: authorize(factory),
    });

    assert.equal((await factory.gateStatus("PUBLISH_APPROVAL", { type: "ARTIFACT", id: item.id })).satisfied, true);
    assert.equal((await factory.gateStatus("PUBLISH_APPROVAL", factory.workItemSubject(item.id))).satisfied, false);
  });

  it("refuses a release binding when the approval carries no snapshot", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    const subject = factory.workItemSubject(item.id);

    await factory.recordApproval({
      gate: "PUBLISH_APPROVAL",
      subject,
      decision: "APPROVED",
      actor: HUMAN,
      authorization: authorize(factory),
    });

    const status = await factory.gateStatus("PUBLISH_APPROVAL", subject, { snapshotId: "snap-anything" });
    assert.equal(status.satisfied, false);
    assert.match(status.reason, /not bound to a release snapshot/);
  });
});

describe("plan approval staleness (specRevision binding)", () => {
  it("consumes an approval granted for the current plan", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toPlanReview(factory, item.id);
    await factory.recordApproval({
      gate: "PLAN_APPROVAL",
      subject: factory.workItemSubject(item.id),
      decision: "APPROVED",
      actor: HUMAN,
      authorization: authorize(factory),
    });

    assert.equal((await factory.advance(item.id, "READY", AGENT)).status, "READY");
  });

  it("makes a plan approval stale once the plan is sent back for rework", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    const subject = factory.workItemSubject(item.id);

    await toPlanReview(factory, item.id);
    const beforeRework = await factory.getWorkItem(item.id);
    await factory.recordApproval({
      gate: "PLAN_APPROVAL",
      subject,
      decision: "APPROVED",
      actor: HUMAN,
      authorization: authorize(factory),
    });
    assert.equal((await factory.gateStatus("PLAN_APPROVAL", subject, { specRevision: beforeRework.specRevision })).satisfied, true);

    // PLAN_REVIEW -> ANALYSIS is the plan-rework edge.
    await factory.advance(item.id, "ANALYSIS", AGENT);
    const afterRework = await factory.getWorkItem(item.id);
    assert.equal(afterRework.specRevision, beforeRework.specRevision + 1);

    const stale = await factory.gateStatus("PLAN_APPROVAL", subject, { specRevision: afterRework.specRevision });
    assert.equal(stale.satisfied, false);
    assert.match(stale.reason, /stale/);

    await factory.advance(item.id, "PLAN_REVIEW", AGENT);
    await assert.rejects(factory.advance(item.id, "READY", AGENT), ApprovalRequiredError);
  });
});

describe("release approval staleness (snapshot binding)", () => {
  it("binds the approval to the exact release candidate and permits DONE", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toWaitingForHuman(factory, item.id);

    const snapshot = await factory.releaseSnapshot(item.id);
    assert.ok(snapshot !== undefined);

    const approval = await factory.recordApproval({
      gate: "RELEASE_APPROVAL",
      subject: factory.workItemSubject(item.id),
      decision: "APPROVED",
      actor: HUMAN,
      authorization: authorize(factory),
    });
    assert.equal(approval.context?.snapshotId, snapshot.id);
    assert.equal(approval.context?.statusWhenDecided, "WAITING_FOR_HUMAN");

    assert.equal((await factory.advance(item.id, "DONE", AGENT)).status, "DONE");
  });

  it("refuses DONE once a new implementation changes the snapshot", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toWaitingForHuman(factory, item.id);

    await factory.recordApproval({
      gate: "RELEASE_APPROVAL",
      subject: factory.workItemSubject(item.id),
      decision: "APPROVED",
      actor: HUMAN,
      authorization: authorize(factory),
    });

    const second = registeredWorker(factory, "worker-impl-2", ["IMPLEMENTER"]);
    await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: second,
      instructions: "supersede",
    });

    await assert.rejects(factory.advance(item.id, "DONE", AGENT), { code: "PRECONDITION_NOT_MET" });
  });

  it("refuses DONE after rework even when the old approval is still the latest", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toWaitingForHuman(factory, item.id);

    await factory.recordApproval({
      gate: "RELEASE_APPROVAL",
      subject: factory.workItemSubject(item.id),
      decision: "APPROVED",
      actor: HUMAN,
      authorization: authorize(factory),
    });

    // Human rejects: back to implementation, then all the way round again
    // with a new implementation run.
    await factory.advance(item.id, "IMPLEMENTING", AGENT);
    const second = registeredWorker(factory, "worker-impl-2", ["IMPLEMENTER"]);
    await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: second,
      instructions: "second attempt",
    });
    await factory.advance(item.id, "VERIFYING", AGENT);
    await assert.rejects(factory.advance(item.id, "REVIEW", AGENT), { code: "PRECONDITION_NOT_MET" });
  });
});
