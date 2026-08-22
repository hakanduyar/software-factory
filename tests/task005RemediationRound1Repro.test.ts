/**
 * TASK-005 REMEDIATION ROUND 1 — permanent reproductions of the seven HIGH
 * findings from the independent acceptance review (CHANGES_REQUIRED).
 *
 * Every test in this file FAILED against the pre-fix build. They are kept
 * together, and kept adversarial, because the review's sharpest observation was
 * that a green 825-test suite proved nothing about these cases: the happy paths
 * were all correct, and the authority holes were all in what happens when
 * somebody supplies something the happy path never supplies.
 *
 *   HIGH 1  a derived plan approval could authorize an arbitrary work item,
 *           including one in a different project
 *   HIGH 2  a superseded plan approval could still be replayed, and repeated
 *           derivation appended duplicate authority
 *   HIGH 3  materialization adopted a work item on its correlation tag alone
 *   HIGH 4  projectId and execution configuration sat outside the approval
 *           digest, so both could be changed while approval survived
 *   HIGH 5  a concurrent resume launched a second real planner run
 *   HIGH 6  the production CLI planner rejected its own valid output
 *   HIGH 7  a dangling work-item mapping loaded as executable state
 *
 * Fully offline: scripted planners, fake process runners, temp SQLite files.
 * No AI model is reachable from anything here.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createCliPlannerWorker } from "../src/adapters/planning/cliPlannerWorker.js";
import { createSqlitePlanRepository } from "../src/adapters/planning/sqlitePlanRepository.js";
import type { Workspace } from "../src/adapters/workers/workspace.js";
import { agent } from "../src/domain/actor.js";
import { planSubject, workItemSubject } from "../src/domain/approval.js";
import { ApprovalIntegrityError, PersistenceCorruptionError } from "../src/domain/errors.js";
import type { WorkItem } from "../src/domain/workItem.js";
import { approvalDigestOfPlan } from "../src/planning/planDigest.js";
import { parsePlannerOutput } from "../src/planning/plannerOutputContract.js";
import type { PlannerOutcome, PlannerWorker } from "../src/planning/plannerWorker.js";
import {
  canonicalCorrelationTag,
  canonicalPlannerActionTag,
  type Plan,
  type PlannedWorkItem,
} from "../src/planning/planTypes.js";
import { renderPlannerResponse } from "../src/planning/scriptedPlannerWorkers.js";
import type { ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import {
  PLAN_HUMAN,
  TEST_PLANNER_CONFIG,
  approvedPlan,
  authorizePlanHuman,
  newPlanning,
  planAtReview,
  simplePlanResponse,
  testExecutionConfig,
  type TestPlanning,
} from "./support/planFixtures.js";

after(cleanupTempDbs);

const ORCHESTRATOR = agent("agent:round1-repro", "Round 1 Repro Orchestrator");

// =====================================================================
// Shared staging helpers
// =====================================================================

/** Approves a plan through the REAL gate, then stops before the drive materializes anything. */
async function approvedButNotMaterialized(context: TestPlanning, intent = "Build the thing."): Promise<Plan> {
  const plan = await planAtReview(context, intent);
  const revision = plan.revisions.at(-1)!;
  const approval = await context.factory.recordApproval({
    gate: "PLAN_APPROVAL",
    subject: planSubject(plan.id),
    decision: "APPROVED",
    actor: PLAN_HUMAN,
    authorization: authorizePlanHuman(context.factory),
  });
  const staged: Plan = {
    ...plan,
    version: plan.version + 1,
    phase: "APPROVED",
    approvalId: approval.id,
    approvedRevision: revision.revision,
    approvedDigest: approvalDigestOfPlan(plan, revision),
  };
  return context.plans.compareAndSave(staged, plan.version);
}

interface Staged {
  readonly plan: Plan;
  readonly workItem: WorkItem;
  readonly item: PlannedWorkItem;
  readonly tag: string;
}

/**
 * The exact state in which deriving a work-item approval is LEGITIMATE: an
 * approved plan, a durable mapping, and a work item at PLAN_REVIEW carrying the
 * approved content. Built by hand rather than by driving, so the derivation
 * boundary can be exercised directly.
 */
async function stagedForDerivation(
  context: TestPlanning,
  intent = "Build the thing.",
  contentOverrides: Partial<{ title: string; type: WorkItem["type"]; priority: WorkItem["priority"] }> = {},
  criteriaOverride?: readonly { text: string; verificationHint: string }[],
): Promise<Staged> {
  const plan = await approvedButNotMaterialized(context, intent);
  const revision = plan.revisions.find((entry) => entry.revision === plan.approvedRevision)!;
  const item = revision.items[0]!;
  const tag = canonicalCorrelationTag(plan.id, revision.revision, item.key);

  const workItem = await context.factory.createWorkItem({
    projectId: plan.projectId,
    title: contentOverrides.title ?? item.title,
    type: contentOverrides.type ?? item.type,
    priority: contentOverrides.priority ?? item.priority,
    planVersion: tag,
    acceptanceCriteria: (criteriaOverride ?? item.acceptanceCriteria).map((criterion) => ({
      text: criterion.text,
      verificationHint: criterion.verificationHint,
    })),
  });
  await context.factory.advance(workItem.id, "ANALYSIS", ORCHESTRATOR);
  await context.factory.advance(workItem.id, "PLAN_REVIEW", ORCHESTRATOR);

  const mapped: Plan = {
    ...plan,
    version: plan.version + 1,
    phase: "MATERIALIZING",
    materialized: [
      { planItemKey: item.key, workItemId: workItem.id, correlationTag: tag, materializedAt: 0, readied: false },
    ],
  };
  return { plan: await context.plans.compareAndSave(mapped, plan.version), workItem, item, tag };
}

async function unmappedItemAtPlanReview(
  context: TestPlanning,
  projectId: string,
  planVersion: string,
): Promise<WorkItem> {
  const created = await context.factory.createWorkItem({
    projectId,
    title: "Unrelated work nobody approved",
    type: "CHORE",
    priority: "P3",
    planVersion,
    acceptanceCriteria: [{ text: "unrelated", verificationHint: "none" }],
  });
  await context.factory.advance(created.id, "ANALYSIS", ORCHESTRATOR);
  await context.factory.advance(created.id, "PLAN_REVIEW", ORCHESTRATOR);
  return created;
}

/** Asserts a refused derivation changed absolutely nothing about the target. */
async function assertNoAuthorityLeaked(context: TestPlanning, workItemId: string): Promise<void> {
  const approvals = await context.factory.listApprovals(workItemSubject(workItemId));
  assert.deepEqual(approvals, [], "a refused derivation must append no approval record");
  const after2 = await context.factory.getWorkItem(workItemId);
  assert.equal(after2.status, "PLAN_REVIEW", "a refused derivation must not move the work item");
  const gate = await context.factory.gateStatus("PLAN_APPROVAL", workItemSubject(workItemId), {
    specRevision: after2.specRevision,
  });
  assert.equal(gate.satisfied, false, "a refused derivation must leave the gate unsatisfied");
}

// =====================================================================
// HIGH 1 — a plan approval authorizes ONLY its own approved items
// =====================================================================

describe("ROUND 1 / HIGH 1: a derived plan approval cannot widen to another work item", () => {
  it("refuses an unrelated work item in the SAME project", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const victim = await unmappedItemAtPlanReview(context, context.projectId, "not-a-plan-tag");

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: victim.id,
        sourceApprovalId: plan.approvalId!,
        planId: plan.id,
      }),
      ApprovalIntegrityError,
    );
    await assertNoAuthorityLeaked(context, victim.id);
  });

  it("refuses a work item in a DIFFERENT project", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const other = await context.factory.createProject({ key: "OTH", name: "Other Project" });
    const victim = await unmappedItemAtPlanReview(context, other.id, "cross-project-tag");

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: victim.id,
        sourceApprovalId: plan.approvalId!,
        planId: plan.id,
      }),
      ApprovalIntegrityError,
    );
    await assertNoAuthorityLeaked(context, victim.id);
  });

  it("refuses a work item that belongs to a DIFFERENT plan", async () => {
    const context = await newPlanning();
    const planA = await approvedPlan(context, "Build capability A.");
    const stagedB = await stagedForDerivation(context, "Build capability B.");

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: stagedB.workItem.id,
        sourceApprovalId: planA.approvalId!,
        planId: planA.id,
      }),
      ApprovalIntegrityError,
    );
    await assertNoAuthorityLeaked(context, stagedB.workItem.id);
  });

  it("refuses a work item created with the canonical tag but never mapped by the plan", async () => {
    const context = await newPlanning();
    const plan = await approvedButNotMaterialized(context);
    const revision = plan.revisions.at(-1)!;
    const tag = canonicalCorrelationTag(plan.id, revision.revision, revision.items[0]!.key);
    const squatter = await unmappedItemAtPlanReview(context, plan.projectId, tag);

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: squatter.id,
        sourceApprovalId: plan.approvalId!,
        planId: plan.id,
      }),
      /is not a materialized target/,
    );
    await assertNoAuthorityLeaked(context, squatter.id);
  });

  it("refuses when the plan's mapping was substituted to another work item", async () => {
    const context = await newPlanning();
    const staged = await stagedForDerivation(context);
    const substitute = await unmappedItemAtPlanReview(context, staged.plan.projectId, "some-other-tag");

    const tampered: Plan = {
      ...staged.plan,
      version: staged.plan.version + 1,
      materialized: [{ ...staged.plan.materialized[0]!, workItemId: substitute.id }],
    };
    await context.plans.compareAndSave(tampered, staged.plan.version);

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: substitute.id,
        sourceApprovalId: staged.plan.approvalId!,
        planId: staged.plan.id,
      }),
      ApprovalIntegrityError,
    );
    await assertNoAuthorityLeaked(context, substitute.id);
  });

  it("refuses a mapped work item whose title is not the approved title", async () => {
    const context = await newPlanning();
    const staged = await stagedForDerivation(context, "Build the thing.", { title: "Something else entirely" });

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: staged.workItem.id,
        sourceApprovalId: staged.plan.approvalId!,
        planId: staged.plan.id,
      }),
      /is not the approved/,
    );
    await assertNoAuthorityLeaked(context, staged.workItem.id);
  });

  it("refuses a mapped work item whose type or priority is not approved", async () => {
    for (const override of [{ type: "CHORE" as const }, { priority: "P0" as const }]) {
      const context = await newPlanning();
      const staged = await stagedForDerivation(context, "Build the thing.", override);
      await assert.rejects(
        context.factory.recordDerivedPlanApproval({
          workItemId: staged.workItem.id,
          sourceApprovalId: staged.plan.approvalId!,
          planId: staged.plan.id,
        }),
        /is not the approved/,
      );
      await assertNoAuthorityLeaked(context, staged.workItem.id);
    }
  });

  it("refuses a mapped work item whose acceptance criteria are not approved", async () => {
    const variants: readonly (readonly { text: string; verificationHint: string }[])[] = [
      [{ text: "something else entirely", verificationHint: "nothing" }],
      [
        { text: "the approved one", verificationHint: "npm test" },
        { text: "and one nobody approved", verificationHint: "npm test" },
      ],
    ];
    for (const criteria of variants) {
      const context = await newPlanning();
      const staged = await stagedForDerivation(context, "Build the thing.", {}, criteria);
      await assert.rejects(
        context.factory.recordDerivedPlanApproval({
          workItemId: staged.workItem.id,
          sourceApprovalId: staged.plan.approvalId!,
          planId: staged.plan.id,
        }),
        ApprovalIntegrityError,
      );
      await assertNoAuthorityLeaked(context, staged.workItem.id);
    }
  });

  it("refuses a mapped work item whose spec was revised outside the plan", async () => {
    const context = await newPlanning();
    const staged = await stagedForDerivation(context);
    // PLAN_REVIEW -> ANALYSIS is the plan-rework edge: it bumps specRevision,
    // which is exactly what "this is no longer what was approved" means.
    await context.factory.advance(staged.workItem.id, "ANALYSIS", ORCHESTRATOR);
    await context.factory.advance(staged.workItem.id, "PLAN_REVIEW", ORCHESTRATOR);
    const reworked = await context.factory.getWorkItem(staged.workItem.id);
    assert.equal(reworked.specRevision, 2);

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: staged.workItem.id,
        sourceApprovalId: staged.plan.approvalId!,
        planId: staged.plan.id,
      }),
      /spec revision/,
    );
  });

  it("ACCEPTS the exact approved item — the fix must not break the legitimate path", async () => {
    const context = await newPlanning();
    const staged = await stagedForDerivation(context);

    const derived = await context.factory.recordDerivedPlanApproval({
      workItemId: staged.workItem.id,
      sourceApprovalId: staged.plan.approvalId!,
      planId: staged.plan.id,
    });

    assert.equal(derived.decision, "APPROVED");
    assert.equal(derived.decidedBy.id, PLAN_HUMAN.id, "attributed to the real human, never invented");
    assert.equal(derived.context?.derivedFromApprovalId, staged.plan.approvalId);
    assert.equal(derived.context?.planId, staged.plan.id);
    const gate = await context.factory.gateStatus("PLAN_APPROVAL", workItemSubject(staged.workItem.id), {
      specRevision: 1,
    });
    assert.equal(gate.satisfied, true);
  });

  it("still drives a whole plan end to end", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    assert.equal(plan.phase, "EXECUTING");
    const item = await context.factory.getWorkItem(plan.materialized[0]!.workItemId);
    assert.ok(["READY", "IMPLEMENTING", "VERIFYING", "REVIEW", "WAITING_FOR_HUMAN"].includes(item.status));
  });
});

// =====================================================================
// HIGH 2 — historical approval evidence is not current authority
// =====================================================================

describe("ROUND 1 / HIGH 2: a superseded plan approval cannot be replayed", () => {
  it("refuses to derive after the plan gate has been rejected", async () => {
    const context = await newPlanning();
    const staged = await stagedForDerivation(context);

    // A later human rejection, appended to the same append-only gate.
    await context.store.approvals.save({
      id: "apr-later-rejection",
      gate: "PLAN_APPROVAL",
      subject: planSubject(staged.plan.id),
      decision: "REJECTED",
      decidedBy: PLAN_HUMAN,
      context: {
        statusWhenDecided: "PLAN_REVIEW",
        specRevision: staged.plan.approvedRevision!,
        planContentDigest: staged.plan.approvedDigest!,
      },
      decidedAt: 1,
    });

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: staged.workItem.id,
        sourceApprovalId: staged.plan.approvalId!,
        planId: staged.plan.id,
      }),
      /no longer the current decision/,
    );
    await assertNoAuthorityLeaked(context, staged.workItem.id);
  });

  it("refuses to derive from revision N once revision N+1 exists", async () => {
    const context = await newPlanning();
    const staged = await stagedForDerivation(context);
    const revision = staged.plan.revisions.at(-1)!;

    const superseded: Plan = {
      ...staged.plan,
      version: staged.plan.version + 1,
      revisions: [...staged.plan.revisions, { ...revision, revision: 2 }],
    };
    await context.plans.compareAndSave(superseded, staged.plan.version);

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: staged.workItem.id,
        sourceApprovalId: staged.plan.approvalId!,
        planId: staged.plan.id,
      }),
      /superseded/,
    );
    await assertNoAuthorityLeaked(context, staged.workItem.id);
  });

  it("refuses to derive once the plan carries a durable cancellation request", async () => {
    const context = await newPlanning();
    const staged = await stagedForDerivation(context);
    const cancelled: Plan = { ...staged.plan, version: staged.plan.version + 1, cancelRequested: true };
    await context.plans.compareAndSave(cancelled, staged.plan.version);

    await assert.rejects(
      context.factory.recordDerivedPlanApproval({
        workItemId: staged.workItem.id,
        sourceApprovalId: staged.plan.approvalId!,
        planId: staged.plan.id,
      }),
      /cancellation request/,
    );
    await assertNoAuthorityLeaked(context, staged.workItem.id);
  });

  it("is idempotent: repeated identical derivation appends exactly one approval", async () => {
    const context = await newPlanning();
    const staged = await stagedForDerivation(context);
    const input = {
      workItemId: staged.workItem.id,
      sourceApprovalId: staged.plan.approvalId!,
      planId: staged.plan.id,
    };

    const first = await context.factory.recordDerivedPlanApproval(input);
    const second = await context.factory.recordDerivedPlanApproval(input);
    const third = await context.factory.recordDerivedPlanApproval(input);

    assert.equal(second.id, first.id, "the existing derivation is returned, not a new one");
    assert.equal(third.id, first.id);
    const all = await context.factory.listApprovals(workItemSubject(staged.workItem.id));
    assert.equal(all.length, 1, "exactly one authoritative approval row");
  });

  it("is idempotent under concurrent derivation", async () => {
    const context = await newPlanning();
    const staged = await stagedForDerivation(context);
    const input = {
      workItemId: staged.workItem.id,
      sourceApprovalId: staged.plan.approvalId!,
      planId: staged.plan.id,
    };

    const results = await Promise.all([
      context.factory.recordDerivedPlanApproval(input),
      context.factory.recordDerivedPlanApproval(input),
      context.factory.recordDerivedPlanApproval(input),
    ]);

    const all = await context.factory.listApprovals(workItemSubject(staged.workItem.id));
    assert.equal(all.length, 1, "concurrent derivation appends no duplicate authority");
    assert.equal(new Set(results.map((approval) => approval.id)).size, 1);
  });

  it("is idempotent across a restart", async () => {
    const context = await newPlanning();
    const staged = await stagedForDerivation(context);
    const input = {
      workItemId: staged.workItem.id,
      sourceApprovalId: staged.plan.approvalId!,
      planId: staged.plan.id,
    };
    await context.factory.recordDerivedPlanApproval(input);

    // A fresh service over the SAME durable stores is the restart.
    const restarted = await newPlanning({ store: context.store, plans: context.plans });
    await restarted.factory.recordDerivedPlanApproval(input);

    const all = await restarted.factory.listApprovals(workItemSubject(staged.workItem.id));
    assert.equal(all.length, 1);
  });

  it("keeps a superseded approval auditable even though it authorizes nothing", async () => {
    const context = await newPlanning();
    const staged = await stagedForDerivation(context);
    await context.store.approvals.save({
      id: "apr-later-rejection-2",
      gate: "PLAN_APPROVAL",
      subject: planSubject(staged.plan.id),
      decision: "REJECTED",
      decidedBy: PLAN_HUMAN,
      context: {
        statusWhenDecided: "PLAN_REVIEW",
        specRevision: staged.plan.approvedRevision!,
        planContentDigest: staged.plan.approvedDigest!,
      },
      decidedAt: 1,
    });

    const history = await context.factory.listApprovals(planSubject(staged.plan.id));
    assert.equal(history.length, 2, "the original approval remains in the audit trail (C8)");
    assert.ok(history.some((approval) => approval.id === staged.plan.approvalId));
  });
});

// =====================================================================
// HIGH 3 — a correlation tag identifies a candidate, it does not prove one
// =====================================================================

describe("ROUND 1 / HIGH 3: materialization never adopts on the tag alone", () => {
  const impostors: readonly { readonly label: string; readonly build: (base: PlannedWorkItem) => Record<string, unknown> }[] = [
    { label: "wrong title", build: (item) => ({ title: "COMPLETELY DIFFERENT TITLE", type: item.type, priority: item.priority }) },
    { label: "wrong type", build: (item) => ({ title: item.title, type: "CHORE", priority: item.priority }) },
    { label: "wrong priority", build: (item) => ({ title: item.title, type: item.type, priority: "P0" }) },
  ];

  for (const impostor of impostors) {
    it(`refuses to adopt a tagged work item with the ${impostor.label}`, async () => {
      const context = await newPlanning();
      const plan = await approvedButNotMaterialized(context);
      const revision = plan.revisions.at(-1)!;
      const item = revision.items[0]!;
      const tag = canonicalCorrelationTag(plan.id, revision.revision, item.key);
      const shape = impostor.build(item) as { title: string; type: WorkItem["type"]; priority: WorkItem["priority"] };

      const planted = await context.factory.createWorkItem({
        projectId: plan.projectId,
        title: shape.title,
        type: shape.type,
        priority: shape.priority,
        planVersion: tag,
        acceptanceCriteria: item.acceptanceCriteria.map((criterion) => ({
          text: criterion.text,
          verificationHint: criterion.verificationHint,
        })),
      });

      const driven = await context.service.resume(plan.id);

      assert.equal(driven.phase, "RECOVERY_REQUIRED", "adoption of unapproved content fails closed");
      assert.match(driven.failureReason!, /is not the approved item/);
      assert.deepEqual(driven.materialized, [], "no mapping was recorded");
      const untouched = await context.factory.getWorkItem(planted.id);
      assert.equal(untouched.status, "IDEA", "the impostor was neither advanced nor edited into compliance");
      assert.equal(untouched.title, shape.title);
      const created = await context.factory.listWorkItemsByProject(plan.projectId);
      assert.equal(created.length, 1, "and no second work item was created behind it");
    });
  }

  it("refuses to adopt a tagged work item with unapproved acceptance criteria", async () => {
    const context = await newPlanning();
    const plan = await approvedButNotMaterialized(context);
    const revision = plan.revisions.at(-1)!;
    const item = revision.items[0]!;
    const tag = canonicalCorrelationTag(plan.id, revision.revision, item.key);

    await context.factory.createWorkItem({
      projectId: plan.projectId,
      title: item.title,
      type: item.type,
      priority: item.priority,
      planVersion: tag,
      acceptanceCriteria: [{ text: "nothing anybody approved", verificationHint: "none" }],
    });

    const driven = await context.service.resume(plan.id);
    assert.equal(driven.phase, "RECOVERY_REQUIRED");
    assert.match(driven.failureReason!, /acceptance criterion|is not the approved/);
  });

  it("refuses to adopt a tagged work item naming another plan item's key", async () => {
    const context = await newPlanning({ plannerOutputs: [twoItemResponse()] });
    const plan = await approvedButNotMaterialized(context);
    const revision = plan.revisions.at(-1)!;
    const [first, second] = [revision.items[0]!, revision.items[1]!];

    // Content of WI-B, planted under WI-A's canonical tag.
    await context.factory.createWorkItem({
      projectId: plan.projectId,
      title: second.title,
      type: second.type,
      priority: second.priority,
      planVersion: canonicalCorrelationTag(plan.id, revision.revision, first.key),
      acceptanceCriteria: second.acceptanceCriteria.map((criterion) => ({
        text: criterion.text,
        verificationHint: criterion.verificationHint,
      })),
    });

    const driven = await context.service.resume(plan.id);
    assert.equal(driven.phase, "RECOVERY_REQUIRED");
  });

  it("ADOPTS a genuine crash-orphaned work item exactly once, across a restart", async () => {
    const dbPath = tempDbPath("round1-adopt-");
    const plans = createSqlitePlanRepository(dbPath);
    const context = await newPlanning({ plans });
    const plan = await approvedButNotMaterialized(context);
    const revision = plan.revisions.at(-1)!;
    const item = revision.items[0]!;
    const tag = canonicalCorrelationTag(plan.id, revision.revision, item.key);

    // Exactly what the service would have created before dying: correct content,
    // correct tag, but no mapping committed yet.
    const orphan = await context.factory.createWorkItem({
      projectId: plan.projectId,
      title: item.title,
      type: item.type,
      priority: item.priority,
      planVersion: tag,
      acceptanceCriteria: item.acceptanceCriteria.map((criterion) => ({
        text: criterion.text,
        verificationHint: criterion.verificationHint,
      })),
    });
    const withClaim: Plan = {
      ...plan,
      version: plan.version + 1,
      phase: "MATERIALIZING",
      materializationClaim: { planItemKey: item.key, correlationTag: tag, claimedAt: 0 },
    };
    await plans.compareAndSave(withClaim, plan.version);
    plans.close();

    const reopened = createSqlitePlanRepository(dbPath);
    try {
      const restarted = await newPlanning({ plans: reopened, store: context.store });
      const driven = await restarted.service.resume(plan.id);

      assert.notEqual(driven.phase, "RECOVERY_REQUIRED", driven.failureReason ?? "");
      assert.equal(driven.materialized.length, 1);
      assert.equal(driven.materialized[0]!.workItemId, orphan.id, "the orphan was adopted, not duplicated");
      const all = await restarted.factory.listWorkItemsByProject(plan.projectId);
      assert.equal(all.length, 1, "exactly one work item exists for this plan item");
    } finally {
      reopened.close();
    }
  });

  it("adopts once under concurrent materialization", async () => {
    const context = await newPlanning();
    const plan = await approvedButNotMaterialized(context);

    const [a, b] = await Promise.all([context.service.resume(plan.id), context.service.resume(plan.id)]);

    assert.notEqual(a.phase, "RECOVERY_REQUIRED", a.failureReason ?? "");
    assert.notEqual(b.phase, "RECOVERY_REQUIRED", b.failureReason ?? "");
    const created = await context.factory.listWorkItemsByProject(plan.projectId);
    assert.equal(created.length, 1, "one plan item, one work item, whatever the interleaving");
  });
});

// =====================================================================
// HIGH 4 — the approval digest covers everything that decides execution
// =====================================================================

describe("ROUND 1 / HIGH 4: execution-authoritative configuration is inside the approval digest", () => {
  const mutations: readonly { readonly label: string; readonly apply: (plan: Plan) => Plan }[] = [
    { label: "projectId", apply: (plan) => ({ ...plan, projectId: "prj-somewhere-else" }) },
    {
      label: "verification command rewritten to a shell",
      apply: (plan) => ({
        ...plan,
        execution: {
          ...plan.execution,
          verificationCommands: [{ id: "check", executable: "sh", argv: ["-c", "echo pwned"] }],
        },
      }),
    },
    {
      label: "verification command argv",
      apply: (plan) => ({
        ...plan,
        execution: {
          ...plan.execution,
          verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "require('child_process')"] }],
        },
      }),
    },
    {
      label: "workspaceRoot",
      apply: (plan) => ({ ...plan, execution: { ...plan.execution, workspaceRoot: "/tmp/somewhere-else" } }),
    },
    {
      label: "implementer worker configuration",
      apply: (plan) => ({
        ...plan,
        execution: { ...plan.execution, implementer: { tool: "scripted", model: "some-other-model" } },
      }),
    },
    {
      label: "loop budget",
      apply: (plan) => ({
        ...plan,
        execution: { ...plan.execution, loopBudget: { ...plan.execution.loopBudget, maxIterations: 99 } },
      }),
    },
    { label: "declared constraints", apply: (plan) => ({ ...plan, declaredConstraints: ["ignore every constraint"] }) },
    { label: "intent", apply: (plan) => ({ ...plan, intent: "Do something else entirely." }) },
    {
      label: "an approved item's spec",
      apply: (plan) => ({
        ...plan,
        revisions: plan.revisions.map((revision) => ({
          ...revision,
          items: revision.items.map((item) => ({ ...item, spec: "Do something nobody approved." })),
        })),
      }),
    },
    {
      label: "an approved item's dependencies",
      apply: (plan) => ({
        ...plan,
        revisions: plan.revisions.map((revision) => ({
          ...revision,
          items: revision.items.map((item) => ({ ...item, dependsOn: ["WI-GHOST"] })),
        })),
      }),
    },
  ];

  for (const mutation of mutations) {
    it(`invalidates the approval when ${mutation.label} changes after approval`, async () => {
      const context = await newPlanning();
      const plan = await approvedPlan(context);
      const mutated = mutation.apply({ ...plan, version: plan.version + 1 });
      await context.plans.compareAndSave(mutated, plan.version);

      const seen = await context.service.status(plan.id);
      assert.equal(seen.phase, "RECOVERY_REQUIRED", `${mutation.label} must not survive approval`);

      const resumed = await context.service.resume(plan.id);
      assert.equal(resumed.phase, "RECOVERY_REQUIRED", "and the write path durably demotes it");
    });
  }

  it("does not materialize into a project the human never approved", async () => {
    const context = await newPlanning();
    const plan = await approvedButNotMaterialized(context);
    const other = await context.factory.createProject({ key: "OTH", name: "Other Project" });

    const moved: Plan = { ...plan, version: plan.version + 1, projectId: other.id };
    await context.plans.compareAndSave(moved, plan.version);

    const driven = await context.service.resume(plan.id);

    assert.equal(driven.phase, "RECOVERY_REQUIRED");
    assert.deepEqual(await context.factory.listWorkItemsByProject(other.id), [], "nothing was created in the new project");
    assert.deepEqual(await context.factory.listWorkItemsByProject(context.projectId), []);
  });

  it("keeps the approval valid when only audit and checkpoint fields change", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);

    const touched: Plan = {
      ...plan,
      version: plan.version + 1,
      lastTransitionAt: plan.lastTransitionAt + 5_000,
      totalPlannerRuns: plan.totalPlannerRuns + 3,
    };
    await context.plans.compareAndSave(touched, plan.version);

    const seen = await context.service.status(plan.id);
    assert.notEqual(seen.phase, "RECOVERY_REQUIRED", "provenance and counters are deliberately outside the digest");
  });

  it("binds the same digest into the recorded approval and the plan row", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);
    const revision = plan.revisions.at(-1)!;
    const approved = await context.service.approve(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory));

    const gate = await context.factory.gateStatus("PLAN_APPROVAL", planSubject(plan.id));
    assert.equal(gate.approval?.context?.planContentDigest, approved.approvedDigest);
    assert.equal(approved.approvedDigest, approvalDigestOfPlan(plan, revision));
    assert.notEqual(approved.approvedDigest, revision.contentDigest, "not merely the revision digest");
  });
});

// =====================================================================
// HIGH 5 — one logical planning action, one external planner run
// =====================================================================

interface BlockingPlanner {
  readonly worker: PlannerWorker;
  calls(): number;
  release(): void;
  firstPlanId(): Promise<string>;
}

function blockingPlanner(output = simplePlanResponse()): BlockingPlanner {
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let announce: ((id: string) => void) | undefined;
  const first = new Promise<string>((resolve) => {
    announce = resolve;
  });
  return {
    worker: {
      id: "blocking-planner",
      async plan(request): Promise<PlannerOutcome> {
        calls += 1;
        announce?.(request.planId);
        await gate;
        return { status: "SUCCEEDED", rawOutput: output, summary: "ok" };
      },
    },
    calls: () => calls,
    release: () => release?.(),
    firstPlanId: () => first,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("ROUND 1 / HIGH 5: a concurrent resume never launches a second planner run", () => {
  it("two concurrent drives launch exactly one planner action", async () => {
    const planner = blockingPlanner();
    const context = await newPlanning({ planner: planner.worker });
    const started = context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Concurrent planning probe.",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });
    const planId = await planner.firstPlanId();
    const resumed = context.service.resume(planId);
    await settle();

    assert.equal(planner.calls(), 1, "the in-flight lease is never stolen");

    planner.release();
    const [a] = await Promise.all([started, resumed]);
    assert.equal(a.phase, "PLAN_REVIEW");
    assert.equal(a.totalPlannerRuns, 1, "the planning budget was charged exactly once");
  });

  it("three concurrent drives launch exactly one planner action", async () => {
    const planner = blockingPlanner();
    const context = await newPlanning({ planner: planner.worker });
    const started = context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Three-way planning probe.",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });
    const planId = await planner.firstPlanId();
    const others = [context.service.resume(planId), context.service.resume(planId)];
    await settle();

    assert.equal(planner.calls(), 1);
    planner.release();
    await Promise.all([started, ...others]);
    const final = (await context.plans.findById(planId))!;
    assert.equal(final.totalPlannerRuns, 1);
  });

  it("a second service instance over the same database does not relaunch a RUNNING action", async () => {
    const planner = blockingPlanner();
    const context = await newPlanning({ planner: planner.worker });
    const started = context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Restart-during-planning probe.",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });
    const planId = await planner.firstPlanId();
    await settle();

    const secondPlanner = blockingPlanner();
    const restarted = await newPlanning({
      planner: secondPlanner.worker,
      store: context.store,
      plans: context.plans,
    });
    const seen = await restarted.service.resume(planId);

    assert.equal(secondPlanner.calls(), 0, "no second planner run was launched");
    assert.equal(seen.phase, "RECOVERY_REQUIRED", "an unknowable outcome fails closed");
    assert.match(seen.failureReason!, /a second planner run must not be launched/);

    planner.release();
    await Promise.allSettled([started]);
  });

  it("a lease left CLAIMED (never launched) is safely and audibly retried", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);
    const current = (await context.plans.findById(plan.id))!;
    const claimedOnly: Plan = {
      ...current,
      version: current.version + 1,
      phase: "PLANNING",
      revisions: [],
      attemptsForCurrentRevision: 1,
      totalPlannerRuns: 1,
      plannerAction: {
        revision: 1,
        attempt: 1,
        correlationTag: canonicalPlannerActionTag(plan.id, 1, 1),
        ownerId: "planner-owner:gone",
        state: "CLAIMED",
        claimedAt: 0,
      },
    };
    await context.plans.compareAndSave(claimedOnly, current.version);

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.phase, "PLAN_REVIEW");
    assert.ok(resumed.totalPlannerRuns >= 2, "the retry charged the budget");
    assert.equal(resumed.plannerAction, undefined);
  });

  it("does not re-run the planner once an action has settled", async () => {
    const context = await newPlanning();
    const plan = await planAtReview(context);
    const runsBefore = plan.totalPlannerRuns;

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.totalPlannerRuns, runsBefore, "a settled action is adopted, never repeated");
    assert.equal(resumed.phase, "PLAN_REVIEW");
    assert.equal(resumed.revisions.length, 1);
  });

  it("charges and audits a failed planner action once, then retries under budget", async () => {
    const context = await newPlanning({
      plannerOutputs: ["nothing resembling a plan", simplePlanResponse()],
      plannerStatuses: ["FAILED", "SUCCEEDED"],
    });
    const plan = await planAtReview(context);

    assert.equal(plan.phase, "PLAN_REVIEW");
    assert.equal(plan.totalPlannerRuns, 2, "one failed action, one successful retry");
    assert.equal(plan.plannerAction, undefined);
  });

  it("launches no planner at all when cancellation committed first", async () => {
    let calls = 0;
    const counting: PlannerWorker = {
      id: "counting-planner",
      async plan(): Promise<PlannerOutcome> {
        calls += 1;
        return { status: "SUCCEEDED", rawOutput: simplePlanResponse(), summary: "ok" };
      },
    };
    const context = await newPlanning({ planner: counting });
    const plan = await planAtReview(context);
    assert.equal(calls, 1);

    // Rewind to DRAFT with a durable cancellation request already recorded:
    // exactly the state a cancellation that committed before the claim leaves.
    const current = (await context.plans.findById(plan.id))!;
    const cancelled: Plan = {
      ...current,
      version: current.version + 1,
      phase: "DRAFT",
      revisions: [],
      attemptsForCurrentRevision: 0,
      cancelRequested: true,
    };
    await context.plans.compareAndSave(cancelled, current.version);

    const resumed = await context.service.resume(plan.id);

    assert.equal(resumed.phase, "CANCELLED");
    assert.equal(calls, 1, "a committed cancellation defeats the claim; no new planner action began");
  });

  it("lets an in-flight planner finish but starts no new action after cancellation", async () => {
    const planner = blockingPlanner();
    const context = await newPlanning({ planner: planner.worker });
    const started = context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Cancel-during-planning probe.",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });
    const planId = await planner.firstPlanId();
    await settle();

    await context.service.cancel(planId, PLAN_HUMAN, authorizePlanHuman(context.factory));
    planner.release();
    await Promise.allSettled([started]);

    const final = (await context.plans.findById(planId))!;
    assert.equal(final.phase, "CANCELLED");
    assert.equal(planner.calls(), 1, "the running action finished; no further action began");
    assert.equal(final.revisions.length, 0, "a cancelled plan adopts no revision from a losing action");
  });

  it("runs exactly one planner action for a clarification replan", async () => {
    let calls = 0;
    const outputs = [clarificationOnly(), simplePlanResponse()];
    const counting: PlannerWorker = {
      id: "counting-planner",
      async plan(): Promise<PlannerOutcome> {
        const output = outputs[Math.min(calls, outputs.length - 1)]!;
        calls += 1;
        return { status: "SUCCEEDED", rawOutput: output, summary: "ok" };
      },
    };
    const context = await newPlanning({ planner: counting });
    const plan = await planAtReview(context);
    assert.equal(plan.phase, "NEEDS_CLARIFICATION");
    assert.equal(calls, 1);

    const answered = await context.service.answer(plan.id, PLAN_HUMAN, authorizePlanHuman(context.factory), [
      { questionId: "q1", answer: "Archive." },
    ]);

    assert.equal(answered.phase, "PLAN_REVIEW");
    assert.equal(calls, 2, "the replan is one planner action, not one per caller");
    assert.equal(answered.totalPlannerRuns, 2);

    // A resume racing behind the answer must not start a third.
    await context.service.resume(plan.id);
    assert.equal(calls, 2);
  });
});

// =====================================================================
// HIGH 6 — the production CLI planner path must accept valid output
// =====================================================================

const PLANNER_WORKSPACE: Workspace = { root: "/tmp/sf-round1-planner-ws", repositoryRoot: "/tmp/sf-round1-planner-ws" };

function fakeProcessResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    terminationReason: "EXITED",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
    ...overrides,
  };
}

/** The REAL chain: createCliPlannerWorker -> createLoopWorker -> createCliWorker -> ProcessRunner. */
function productionPlanner(result: ProcessResult): PlannerWorker {
  const runner: ProcessRunner = { run: async () => result };
  return createCliPlannerWorker({
    tool: "claude-code",
    model: "fake-model-never-invoked",
    workspace: PLANNER_WORKSPACE,
    processRunner: runner,
  });
}

/** Claude Code's `--output-format json` contract: one JSON object with a `.result` string. */
function claudeStdout(message: string): string {
  return JSON.stringify({ result: message });
}

async function planOnce(result: ProcessResult): Promise<PlannerOutcome> {
  return productionPlanner(result).plan({
    planId: "plan-round1",
    revision: 1,
    attempt: 1,
    correlationTag: "plan-round1:r1:planner:a1",
    projectKey: "prj-round1",
    intent: "Build the thing.",
    constraints: [],
    answeredQuestions: [],
    projectRules: [],
    outputContract: "contract",
  });
}

describe("ROUND 1 / HIGH 6: the production CLI planner parses exactly one structured channel", () => {
  it("accepts a valid planner answer through the real worker composition", async () => {
    const response = simplePlanResponse();
    const outcome = await planOnce(fakeProcessResult({ stdout: claudeStdout(response) }));

    const markers = outcome.rawOutput.split("\n").filter((line) => line.trim() === "FACTORY_PLAN_V1").length;
    assert.equal(markers, 1, "the bounded run summary is no longer pooled as a second result channel");

    const parsed = parsePlannerOutput(outcome.rawOutput);
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
    if (parsed.ok) {
      assert.equal(parsed.proposal.items.length, 1);
      assert.equal(parsed.proposal.items[0]?.key, "WI-A");
    }
  });

  it("rejects a transcript that genuinely contains two contract blocks", async () => {
    const doubled = `${simplePlanResponse()}\n${simplePlanResponse()}`;
    const outcome = await planOnce(fakeProcessResult({ stdout: claudeStdout(doubled) }));
    assert.equal(parsePlannerOutput(outcome.rawOutput).ok, false, "real ambiguity must still be refused");
  });

  it("rejects a malformed transcript", async () => {
    const outcome = await planOnce(fakeProcessResult({ stdout: claudeStdout("FACTORY_PLAN_V1\n```json\n{oh no\n```") }));
    assert.equal(parsePlannerOutput(outcome.rawOutput).ok, false);
  });

  it("cannot be given authority by stderr", async () => {
    const outcome = await planOnce(fakeProcessResult({ stdout: "", stderr: simplePlanResponse() }));
    assert.equal(outcome.rawOutput, "", "diagnostic output is not a structured answer");
    assert.equal(parsePlannerOutput(outcome.rawOutput).ok, false);
  });

  it("cannot be given authority by unstructured stdout", async () => {
    const outcome = await planOnce(fakeProcessResult({ stdout: simplePlanResponse() }));
    assert.equal(parsePlannerOutput(outcome.rawOutput).ok, false, "raw output that violates the tool contract is diagnostic only");
  });

  it("drives a real plan through to PLAN_REVIEW using the production planner wiring", async () => {
    const context = await newPlanning({
      planner: productionPlanner(fakeProcessResult({ stdout: claudeStdout(simplePlanResponse()) })),
    });

    const plan = await context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Build the thing through the production planner path.",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });

    assert.equal(plan.phase, "PLAN_REVIEW", "the documented CLI-start gap is closed for the production composition");
    assert.equal(plan.revisions.length, 1);
    assert.equal(plan.revisions[0]?.items.length, 1);
  });
});

// =====================================================================
// HIGH 7 — a mapping is a reference, never proof
// =====================================================================

describe("ROUND 1 / HIGH 7: a dangling work item mapping fails closed on read and on resume", () => {
  async function withDanglingMapping(phase: Plan["phase"]): Promise<{ context: TestPlanning; planId: string }> {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const dangling: Plan = {
      ...plan,
      version: plan.version + 1,
      phase,
      ...(phase === "COMPLETED" ? { outcome: "COMPLETED" as const } : {}),
      materialized: plan.materialized.map((entry) => ({ ...entry, workItemId: "wi-does-not-exist" })),
      dispatches: [],
    };
    await context.plans.compareAndSave(dangling, plan.version);
    return { context, planId: plan.id };
  }

  for (const phase of ["MATERIALIZING", "EXECUTING", "WAITING_FOR_HUMAN", "COMPLETED"] as const) {
    it(`does not present a ${phase} plan with a dangling mapping as sound`, async () => {
      const { context, planId } = await withDanglingMapping(phase);

      const seen = await context.service.status(planId);
      assert.equal(seen.phase, "RECOVERY_REQUIRED");
      assert.match(seen.failureReason!, /no longer exists/);

      // status() is read-only: the stored row is untouched.
      const stored = await context.plans.findById(planId);
      assert.equal(stored?.phase, phase, "reading a plan must never be what changes it");
    });
  }

  it("durably records RECOVERY_REQUIRED on resume instead of throwing NotFoundError", async () => {
    const { context, planId } = await withDanglingMapping("EXECUTING");

    const resumed = await context.service.resume(planId);

    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
    assert.equal(resumed.outcome, "RECOVERY_REQUIRED");
    assert.equal(context.dispatcher.startCount(), 1, "no replacement loop was started");
  });

  it("fails closed when a mapping points at a work item in another project", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const other = await context.factory.createProject({ key: "OTH", name: "Other Project" });
    const foreign = await context.factory.createWorkItem({
      projectId: other.id,
      title: "Elsewhere",
      type: "FEATURE",
      priority: "P2",
      planVersion: plan.materialized[0]!.correlationTag,
      acceptanceCriteria: [{ text: "x", verificationHint: "y" }],
    });

    const crossed: Plan = {
      ...plan,
      version: plan.version + 1,
      materialized: [{ ...plan.materialized[0]!, workItemId: foreign.id }],
      dispatches: [],
    };
    await context.plans.compareAndSave(crossed, plan.version);

    const seen = await context.service.status(plan.id);
    assert.equal(seen.phase, "RECOVERY_REQUIRED");
    assert.match(seen.failureReason!, /is not the approved project/);
  });

  it("fails closed when a mapping points at a work item with unapproved content", async () => {
    const context = await newPlanning();
    const plan = await approvedPlan(context);
    const impostor = await context.factory.createWorkItem({
      projectId: context.projectId,
      title: "Not what was approved",
      type: "CHORE",
      priority: "P0",
      planVersion: plan.materialized[0]!.correlationTag,
      acceptanceCriteria: [{ text: "x", verificationHint: "y" }],
    });

    const swapped: Plan = {
      ...plan,
      version: plan.version + 1,
      materialized: [{ ...plan.materialized[0]!, workItemId: impostor.id }],
      dispatches: [],
    };
    await context.plans.compareAndSave(swapped, plan.version);

    assert.equal((await context.service.status(plan.id)).phase, "RECOVERY_REQUIRED");
  });

  /**
   * Found by the post-fix authority audit, not by the review: routing the
   * write-path checks through the same phase list as the read projection would
   * have let a BLOCKED plan reach the execution step with fewer questions
   * asked. `authorityProblem(plan, "act")` deliberately checks everything.
   */
  it("does not let a BLOCKED plan dispatch on an unverified mapping", async () => {
    const { context, planId } = await withDanglingMapping("EXECUTING");
    const current = (await context.plans.findById(planId))!;
    await context.plans.compareAndSave(
      { ...current, version: current.version + 1, phase: "BLOCKED", outcome: "BLOCKED" },
      current.version,
    );

    const resumed = await context.service.resume(planId);

    assert.equal(resumed.phase, "RECOVERY_REQUIRED");
    assert.equal(context.dispatcher.startCount(), 1, "no new loop was started from BLOCKED");
  });

  it("starts no worker and mutates nothing when status reports a broken plan", async () => {
    const { context, planId } = await withDanglingMapping("EXECUTING");
    const dispatchesBefore = context.dispatcher.startCount();
    const before = await context.plans.findById(planId);

    await context.service.status(planId);
    await context.service.status(planId);

    assert.equal(context.dispatcher.startCount(), dispatchesBefore, "status starts nothing");
    assert.deepEqual(await context.plans.findById(planId), before, "status writes nothing");
  });

  it("keeps a valid mapping working, and survives a SQLite restart", async () => {
    const dbPath = tempDbPath("round1-mapping-");
    const plans = createSqlitePlanRepository(dbPath);
    const context = await newPlanning({ plans });
    const plan = await approvedPlan(context);
    assert.equal(plan.phase, "EXECUTING");
    plans.close();

    const reopened = createSqlitePlanRepository(dbPath);
    try {
      // A real restart reopens the Factory store AND the loop store; only the
      // process is new. Handing the restarted service a fresh, empty dispatcher
      // would model a wiped loop database — which round 2 correctly reports as
      // RECOVERY_REQUIRED, and which is not what this test is about.
      const restarted = await newPlanning({
        plans: reopened,
        store: context.store,
        dispatcher: context.dispatcher,
      });
      const seen = await restarted.service.status(plan.id);
      assert.equal(seen.phase, "EXECUTING", "a sound mapping still validates after reopen");
    } finally {
      reopened.close();
    }
  });

  it("refuses to load a plan whose planner lease contradicts its phase", async () => {
    const dbPath = tempDbPath("round1-lease-");
    const plans = createSqlitePlanRepository(dbPath);
    const context = await newPlanning({ plans });
    const plan = await planAtReview(context);

    const contradictory: Plan = {
      ...plan,
      version: plan.version + 1,
      plannerAction: {
        revision: 2,
        attempt: 1,
        correlationTag: canonicalPlannerActionTag(plan.id, 2, 1),
        ownerId: "planner-owner:whoever",
        state: "RUNNING",
        claimedAt: 0,
      },
    };
    await assert.rejects(
      plans.compareAndSave(contradictory, plan.version).then(() => plans.findById(plan.id)),
      PersistenceCorruptionError,
    );
    plans.close();
  });
});

// =====================================================================
// Local fixtures
// =====================================================================

function twoItemResponse(): string {
  return renderPlannerResponse({
    summary: "Two independent items.",
    items: [
      { key: "WI-A", title: "First thing", spec: "Do the first thing." },
      { key: "WI-B", title: "Second thing", spec: "Do the second thing." },
    ],
  });
}

function clarificationOnly(): string {
  return renderPlannerResponse({
    summary: "One decision is required first.",
    blockingQuestions: [{ id: "q1", question: "Delete or archive?", why: "Deletion is irreversible." }],
  });
}
