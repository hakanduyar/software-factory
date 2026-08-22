/**
 * TASK-005 post-implementation hardening.
 *
 * Every case here corresponds to a gap found by the implementation's own
 * security/authority audit (design §"Security / authority review"), after the
 * main acceptance tests were already green. They are kept together, rather than
 * folded invisibly into the files above, so the audit trail is legible: these
 * are the things that were nearly wrong.
 *
 * 1. `PlanningService.start` claimed to fail fast on an unknown project but
 *    inferred existence from an empty work-item list, which is also what a
 *    real-but-empty project looks like. A typo'd project id therefore created a
 *    plan row and would have charged a real model invocation.
 * 2. Persisted clarification answers had no lineage validation at all, while
 *    every other reference in the same file is rigorously checked.
 * 3. `dispatches` enforced uniqueness on `planItemKey` but not on `loopId`, so
 *    two plan items could claim one engineering loop.
 * 4. The duplicate-id vs duplicate-request-key error message depended on
 *    SQLite's internal index-check order when an insert violated both.
 *
 * No real Claude/Codex model is invoked anywhere in this file.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createSqlitePlanRepository } from "../src/adapters/planning/sqlitePlanRepository.js";
import { ConcurrencyError, NotFoundError, PersistenceCorruptionError } from "../src/domain/errors.js";
import { approvalDigestOfPlan, computePlanContentDigest } from "../src/planning/planDigest.js";
import { encodePlan, parsePlan } from "../src/planning/planSerialization.js";
import { canonicalCorrelationTag, type Plan, type PlannedWorkItem } from "../src/planning/planTypes.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import {
  approvedPlan,
  clarificationResponse,
  finishWorkItem,
  newPlanning,
  PLAN_HUMAN,
  simplePlanResponse,
  TEST_PLANNER_CONFIG,
  testExecutionConfig,
} from "./support/planFixtures.js";

after(cleanupTempDbs);

const ITEM: PlannedWorkItem = {
  key: "WI-A",
  title: "Do the thing",
  type: "FEATURE",
  priority: "P2",
  spec: "Implement the thing.",
  acceptanceCriteria: [{ text: "It works", verificationHint: "npm test" }],
  dependsOn: [],
};

/** A minimal, genuinely valid plan whose digests really are computed. */
function validPlan(overrides: Partial<Plan> = {}): Plan {
  const contentDigest = computePlanContentDigest({
    revision: 1,
    summary: "Deliver it.",
    assumptions: [],
    constraints: [],
    risks: [],
    items: [ITEM],
  });
  return {
    id: "plan-0001",
    projectId: "prj-0001",
    requestKey: "req-abc",
    version: 1,
    phase: "PLAN_REVIEW",
    intent: "Build the thing.",
    declaredConstraints: [],
    budget: { maxPlannerAttempts: 2, maxClarificationCycles: 2, maxTotalPlannerRuns: 6 },
    planner: { tool: "scripted", model: "test" },
    execution: {
      implementer: { tool: "scripted", model: "impl" },
      reviewer: { tool: "scripted", model: "rev" },
      verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "0"] }],
      workspaceRoot: "/tmp/ws",
    },
    revisions: [
      {
        revision: 1,
        summary: "Deliver it.",
        assumptions: [],
        constraints: [],
        risks: [],
        items: [ITEM],
        contentDigest,
        plannerRunRef: "plan-0001:r1:planner:a1",
        generatedAt: 0,
      },
    ],
    openQuestions: [],
    answers: [],
    attemptsForCurrentRevision: 0,
    clarificationCycles: 0,
    totalPlannerRuns: 1,
    materialized: [],
    dispatches: [],
    cancelRequested: false,
    events: [{ seq: 1, kind: "REQUEST_CREATED", detail: "created", at: 0 }],
    startedBy: { id: "user:test", kind: "HUMAN", displayName: "Test Human" },
    startedAt: 0,
    lastTransitionAt: 0,
    ...overrides,
  };
}

function columnsOf(plan: Plan) {
  return { id: plan.id, projectId: plan.projectId, requestKey: plan.requestKey, phase: plan.phase, version: plan.version };
}

/** Parse a plan that has been mutated in ways the TYPE system would reject. */
function parseMutated(plan: Plan, mutate: (raw: Record<string, unknown>) => void): void {
  const raw = JSON.parse(encodePlan(plan)) as Record<string, unknown>;
  mutate(raw);
  parsePlan(JSON.stringify(raw), columnsOf(plan));
}

// =====================================================================
// 1. fail fast on an unknown project
// =====================================================================

describe("TASK-005 hardening: an unknown project is refused before anything is spent", () => {
  it("throws NotFoundError rather than creating a plan and charging a planner run", async () => {
    const context = await newPlanning();

    await assert.rejects(
      context.service.start({
        projectId: "prj-does-not-exist",
        actor: PLAN_HUMAN,
        intent: "Build something.",
        planner: TEST_PLANNER_CONFIG,
        execution: testExecutionConfig(),
      }),
      NotFoundError,
    );
  });

  it("an existing but empty project is still a valid project", async () => {
    const context = await newPlanning();
    const empty = await context.factory.createProject({ key: "EMPTY", name: "Empty Project" });

    // The bug this pins: an empty work-item list is exactly what an unknown
    // project also looks like, so existence must be asked of the project.
    const plan = await context.service.start({
      projectId: empty.id,
      actor: PLAN_HUMAN,
      intent: "Build something in an empty project.",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });
    assert.equal(plan.phase, "PLAN_REVIEW");
  });
});

// =====================================================================
// 2. clarification answer lineage
// =====================================================================

describe("TASK-005 hardening: persisted clarification answers must have valid lineage", () => {
  const answered = validPlan({
    phase: "PLAN_REVIEW",
    clarificationCycles: 1,
    answers: [
      {
        questionId: "q1",
        askedAtCycle: 1,
        askedAtRevision: 0,
        question: "Delete or archive?",
        answer: "Archive.",
        answeredBy: { id: "user:test", kind: "HUMAN", displayName: "Test Human" },
        answeredAt: 0,
      },
    ],
  });

  it("accepts a well-formed answer", () => {
    assert.doesNotThrow(() => parsePlan(encodePlan(answered), columnsOf(answered)));
  });

  it("rejects an answer claiming a clarification round that never happened", () => {
    assert.throws(
      () =>
        parseMutated(answered, (raw) => {
          (raw.answers as Record<string, unknown>[])[0]!.askedAtCycle = 5;
        }),
      PersistenceCorruptionError,
    );
  });

  it("rejects an answer claiming a revision that does not exist", () => {
    assert.throws(
      () =>
        parseMutated(answered, (raw) => {
          (raw.answers as Record<string, unknown>[])[0]!.askedAtRevision = 99;
        }),
      PersistenceCorruptionError,
    );
  });

  it("rejects the same question answered twice within one round", () => {
    assert.throws(
      () =>
        parseMutated(answered, (raw) => {
          const list = raw.answers as Record<string, unknown>[];
          list.push({ ...list[0]! });
        }),
      PersistenceCorruptionError,
    );
  });

  it("ALLOWS a question id reused across two clarification rounds", () => {
    // A planner may legitimately call its first question "q1" every round, so
    // id-only uniqueness would reject a valid multi-round history. This is the
    // case that made `(questionId, askedAtCycle)` the real key.
    const twoRounds = validPlan({
      clarificationCycles: 2,
      answers: [
        { ...answered.answers[0]!, askedAtCycle: 1 },
        { ...answered.answers[0]!, askedAtCycle: 2 },
      ],
    });
    assert.doesNotThrow(() => parsePlan(encodePlan(twoRounds), columnsOf(twoRounds)));
  });

  it("rejects a duplicate open question id", () => {
    const asking = validPlan({
      phase: "NEEDS_CLARIFICATION",
      revisions: [],
      openQuestions: [
        { id: "q1", question: "A?", why: "because" },
        { id: "q1", question: "B?", why: "because" },
      ],
    });
    assert.throws(() => parsePlan(encodePlan(asking), columnsOf(asking)), PersistenceCorruptionError);
  });

  it("the service records the round that actually asked", async () => {
    const context = await newPlanning({ plannerOutputs: [clarificationResponse(), simplePlanResponse()] });
    const asked = await context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Ambiguous.",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
    });
    assert.equal(asked.clarificationCycles, 1);

    const { authorizePlanHuman } = await import("./support/planFixtures.js");
    const after2 = await context.service.answer(asked.id, PLAN_HUMAN, authorizePlanHuman(context.factory), [
      { questionId: "q1", answer: "Archive." },
    ]);

    assert.equal(after2.answers[0]!.askedAtCycle, 1, "the round that asked, not the next one");
  });
});

// =====================================================================
// 3. dispatch loop uniqueness
// =====================================================================

describe("TASK-005 hardening: two plan items may not claim one engineering loop", () => {
  const twoItems: PlannedWorkItem[] = [ITEM, { ...ITEM, key: "WI-B", title: "Second" }];
  const digest = computePlanContentDigest({
    revision: 1,
    summary: "Two items.",
    assumptions: [],
    constraints: [],
    risks: [],
    items: twoItems,
  });
  const executingShape = validPlan({
    phase: "EXECUTING",
    approvalId: "apr-1",
    approvedRevision: 1,
    approvedDigest: "",
    revisions: [
      {
        revision: 1,
        summary: "Two items.",
        assumptions: [],
        constraints: [],
        risks: [],
        items: twoItems,
        contentDigest: digest,
        plannerRunRef: "plan-0001:r1:planner:a1",
        generatedAt: 0,
      },
    ],
    materialized: [
      { planItemKey: "WI-A", workItemId: "wi-1", correlationTag: canonicalCorrelationTag("plan-0001", 1, "WI-A"), materializedAt: 0, readied: true },
      { planItemKey: "WI-B", workItemId: "wi-2", correlationTag: canonicalCorrelationTag("plan-0001", 1, "WI-B"), materializedAt: 0, readied: true },
    ],
    dispatches: [
      { planItemKey: "WI-A", workItemId: "wi-1", loopId: "loop-1", dispatchedAt: 0, adopted: false },
      { planItemKey: "WI-B", workItemId: "wi-2", loopId: "loop-2", dispatchedAt: 0, adopted: false },
    ],
  });
  // Round 1, HIGH 4: what is approved is the revision AND the plan-level
  // configuration, so a fixture's approvedDigest has to be the real one.
  const executing: Plan = {
    ...executingShape,
    approvedDigest: approvalDigestOfPlan(executingShape, executingShape.revisions[0]!),
  };

  it("accepts distinct loop ids", () => {
    assert.doesNotThrow(() => parsePlan(encodePlan(executing), columnsOf(executing)));
  });

  it("rejects two dispatches sharing one loop id", () => {
    assert.throws(
      () =>
        parseMutated(executing, (raw) => {
          (raw.dispatches as Record<string, unknown>[])[1]!.loopId = "loop-1";
        }),
      PersistenceCorruptionError,
    );
  });
});

// =====================================================================
// 5. the read path must not present an unbacked WAITING_FOR_HUMAN either
// =====================================================================

describe("TASK-005 hardening: every approval-asserting phase is re-derived on read", () => {
  it("a plan-level WAITING_FOR_HUMAN with a broken approval fails closed on status()", async () => {
    const context = await newPlanning();
    const approved = await approvedPlan(context);
    await finishWorkItem(context.factory, approved.materialized[0]!.workItemId, "harden-wfh");
    const plan = await context.service.resume(approved.id);
    assert.equal(plan.phase, "WAITING_FOR_HUMAN");

    // Break the content binding underneath the approval.
    const current = (await context.plans.findById(plan.id))!;
    await context.plans.compareAndSave(
      { ...current, approvedDigest: "plan-tampered", version: current.version + 1 },
      current.version,
    );

    const projected = await context.service.status(plan.id);
    assert.equal(projected.phase, "RECOVERY_REQUIRED", "an unbacked WAITING_FOR_HUMAN must not be presented as real");
    assert.equal((await context.plans.findById(plan.id))?.phase, "WAITING_FOR_HUMAN", "status() must not mutate");
  });

  it("a BLOCKED plan that was never approved is reported as BLOCKED, not as corrupted", async () => {
    // The counter-case that decides the scope of the check above: planner-budget
    // exhaustion blocks a plan long before any approval exists, and demanding
    // approval authority of it would misreport an ordinary refusal.
    const context = await newPlanning({ plannerOutputs: ["no contract block here"] });
    const plan = await context.service.start({
      projectId: context.projectId,
      actor: PLAN_HUMAN,
      intent: "Vague.",
      planner: TEST_PLANNER_CONFIG,
      execution: testExecutionConfig(),
      budget: { maxPlannerAttempts: 1, maxTotalPlannerRuns: 1, maxClarificationCycles: 1 },
    });
    assert.equal(plan.phase, "BLOCKED");

    const projected = await context.service.status(plan.id);
    assert.equal(projected.phase, "BLOCKED");
    assert.notEqual(projected.phase, "RECOVERY_REQUIRED");
  });

  it("a persisted WAITING_FOR_HUMAN or COMPLETED with no approval at all is corruption", () => {
    for (const phase of ["WAITING_FOR_HUMAN", "COMPLETED"] as const) {
      const forged = validPlan({
        phase,
        ...(phase === "COMPLETED" ? { outcome: "COMPLETED" as const } : {}),
      });
      assert.throws(
        () => parsePlan(encodePlan(forged), columnsOf(forged)),
        PersistenceCorruptionError,
        `${phase} without an approval must not load`,
      );
    }
  });
});

// =====================================================================
// 4. deterministic duplicate-insert diagnosis
// =====================================================================

describe("TASK-005 hardening: a doubly-violating insert reports a deterministic reason", () => {
  it("names the duplicate id when BOTH the id and the active request key collide", async () => {
    const repository = createSqlitePlanRepository(tempDbPath("plan-harden-"));
    try {
      const plan = validPlan({ phase: "DRAFT", revisions: [] });
      await repository.create(plan);

      // Same id AND same active request key: SQLite may report either index
      // first, so the adapter must pin which diagnosis wins.
      await assert.rejects(repository.create(plan), (error: unknown) => {
        assert.ok(error instanceof ConcurrencyError);
        assert.match(error.message, /Plan plan-0001 already exists/);
        return true;
      });
    } finally {
      repository.close();
    }
  });

  it("names the active request when only the request key collides", async () => {
    const repository = createSqlitePlanRepository(tempDbPath("plan-harden-"));
    try {
      await repository.create(validPlan({ id: "plan-0001", phase: "DRAFT", revisions: [] }));
      await assert.rejects(
        repository.create(validPlan({ id: "plan-0002", phase: "DRAFT", revisions: [] })),
        /an active Plan already exists for request req-abc/,
      );
    } finally {
      repository.close();
    }
  });
});
