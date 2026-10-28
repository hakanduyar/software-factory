/**
 * TASK-005 AC-14 — persistence integrity fails closed for persisted Plan rows.
 *
 * A plan row is untrusted input the moment it comes off disk: it decides which
 * work items get created, which approval a gate is bound to, and which external
 * worker is dispatched next. `JSON.parse(...) as Plan` would satisfy TypeScript
 * and prove nothing at runtime. These tests hold `parsePlan` to the stronger
 * standard TASK-005 §12 sets: every row a legitimate execution path could never
 * have written is REFUSED with `PersistenceCorruptionError`, not repaired and
 * not silently trusted.
 *
 * Each case starts from a genuinely valid plan (its revision digests really are
 * `computePlanContentDigest` of its content), then applies exactly one
 * corruption — the edit a hand-edited file, a partial write, or a tampering
 * process would produce — and asserts both the error type and a reason
 * substring taken verbatim from `src/planning/planSerialization.ts`.
 *
 * Three families here are load-bearing beyond ordinary shape validation:
 *
 * 1. THE DIGEST CHECK. A stored `contentDigest` is recomputed on every read, so
 *    edited plan content cannot even load, let alone execute.
 * 2. THE CORRELATION-TAG CHECK. Derived identities are recomputed, never
 *    trusted, so a corrupted row cannot point one plan item's mapping at
 *    another item's work item.
 * 3. THE APPROVAL TRIPLE. `approvalId`/`approvedRevision`/`approvedDigest` are
 *    all-or-nothing and mutually consistent — a half-written approval is
 *    corruption, not "probably fine".
 *
 * Fully offline: no database, no network, no AI. `parsePlan` is synchronous, so
 * every assertion here uses `assert.throws`, never `assert.rejects`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PersistenceCorruptionError } from "../src/domain/errors.js";
import { createHash } from "node:crypto";
import { approvalDigestOfPlan, computePlanContentDigest, type PlanDigestInput } from "../src/planning/planDigest.js";
import { encodePlan, parsePlan, type PlanRowColumns } from "../src/planning/planSerialization.js";
import {
  canonicalCorrelationTag,
  type DispatchRecord,
  type MaterializedItem,
  type Plan,
  type PlanEvent,
  type PlanEventKind,
  type PlannedWorkItem,
  type PlanPhase,
  type PlanRevision,
} from "../src/planning/planTypes.js";

const T = 1_800_000_000_000;
const PLAN_ID = "plan-fixture";
const PROJECT_ID = "prj-test";
const REQUEST_KEY = "req-fixture";

/** The canonical tags the fixture's approved revision 1 must produce. */
const CORR_A = canonicalCorrelationTag(PLAN_ID, 1, "WI-A");
const CORR_B = canonicalCorrelationTag(PLAN_ID, 1, "WI-B");

function item(key: string, overrides: Partial<PlannedWorkItem> = {}): PlannedWorkItem {
  return {
    key,
    title: `Deliver ${key}`,
    type: "FEATURE",
    priority: "P2",
    spec: `Implement ${key} exactly as the plan describes.`,
    acceptanceCriteria: [{ text: `${key} behaves as specified`, verificationHint: "npm test" }],
    dependsOn: [],
    ...overrides,
  };
}

/**
 * Builds a revision whose stored digest GENUINELY matches its content, so any
 * later digest failure in a test is caused by that test's own edit rather than
 * by a sloppy fixture.
 */
function revision(n: number, items: readonly PlannedWorkItem[], summary = `Revision ${n} of the plan.`): PlanRevision {
  const content: PlanDigestInput = {
    revision: n,
    summary,
    assumptions: ["The existing toolchain is available."],
    constraints: ["No new external infrastructure."],
    risks: ["Scope may grow during implementation."],
    items,
  };
  return {
    ...content,
    contentDigest: computePlanContentDigest(content),
    plannerRunRef: `run-planner-${n}`,
    generatedAt: T + n,
  };
}

function eventsOf(...kinds: PlanEventKind[]): readonly PlanEvent[] {
  return kinds.map((kind, index) => ({ seq: index + 1, kind, detail: `${kind} recorded`, at: T + index }));
}

function mapped(key: string, workItemId: string, readied: boolean, correlationTag?: string): MaterializedItem {
  return {
    planItemKey: key,
    workItemId,
    correlationTag: correlationTag ?? canonicalCorrelationTag(PLAN_ID, 1, key),
    materializedAt: T + 20,
    readied,
  };
}

function dispatched(key: string, workItemId: string, loopId: string): DispatchRecord {
  return { planItemKey: key, workItemId, loopId, dispatchedAt: T + 30, adopted: false };
}

const ITEMS: readonly PlannedWorkItem[] = [item("WI-A"), item("WI-B", { dependsOn: ["WI-A"] })];
const REV1 = revision(1, ITEMS);

/** A valid pre-approval plan sitting at PLAN_REVIEW. */
function basePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: PLAN_ID,
    projectId: PROJECT_ID,
    requestKey: REQUEST_KEY,
    version: 3,
    phase: "PLAN_REVIEW",
    intent: "Build the requested capability.",
    declaredConstraints: ["Stay entirely offline."],
    budget: { maxPlannerAttempts: 2, maxClarificationCycles: 2, maxTotalPlannerRuns: 6 },
    planner: { tool: "scripted", model: "test-planner" },
    execution: {
      implementer: { tool: "scripted", model: "test-implementer" },
      reviewer: { tool: "scripted", model: "test-reviewer" },
      verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
      workspaceRoot: "/tmp/sf-plan-serialization-test",
      loopBudget: { maxIterations: 2 },
    },
    revisions: [REV1],
    openQuestions: [],
    answers: [],
    attemptsForCurrentRevision: 1,
    clarificationCycles: 0,
    totalPlannerRuns: 1,
    materialized: [],
    dispatches: [],
    cancelRequested: false,
    events: eventsOf("REQUEST_CREATED", "PLANNER_RUN_STARTED", "REVISION_GENERATED", "ENTERED_PLAN_REVIEW"),
    startedBy: { id: "user:test", kind: "HUMAN", displayName: "Test Human" },
    startedAt: T,
    lastTransitionAt: T + 10,
    ...overrides,
  };
}

/**
 * A valid post-approval plan with a claim-free materialization and one dispatch.
 *
 * `approvedDigest` is DERIVED from the plan this builds (remediation round 1,
 * HIGH 4: the approval digest covers plan-level configuration, not just the
 * revision). A caller that passes an explicit `approvedDigest` override is
 * deliberately building a tampered row.
 */
function executingPlan(overrides: Partial<Plan> = {}): Plan {
  const shaped = basePlan({
    phase: "EXECUTING",
    version: 7,
    approvalId: "apr-0001",
    approvedRevision: 1,
    approvedDigest: "",
    materialized: [mapped("WI-A", "wi-0001", true), mapped("WI-B", "wi-0002", false)],
    dispatches: [dispatched("WI-A", "wi-0001", "loop-0001")],
    events: eventsOf(
      "REQUEST_CREATED",
      "REVISION_GENERATED",
      "ENTERED_PLAN_REVIEW",
      "APPROVED",
      "MATERIALIZATION_STARTED",
      "WORK_ITEM_MATERIALIZED",
      "WORK_ITEM_READIED",
      "DISPATCHED",
    ),
    ...overrides,
  });
  return overrides.approvedDigest === undefined
    ? { ...shaped, approvedDigest: approvalDigestOfPlan(shaped, REV1) }
    : shaped;
}

/** The SQL columns the adapter would have queried for this plan. */
function columnsOf(plan: Plan): PlanRowColumns {
  return {
    id: plan.id,
    projectId: plan.projectId,
    requestKey: plan.requestKey,
    phase: plan.phase,
    version: plan.version,
  };
}

type Row = Record<string, unknown>;

/** One element of a decoded JSON array, as a mutable bag (`noUncheckedIndexedAccess`). */
function entry(container: unknown, index: number): Row {
  return (container as Row[])[index]!;
}

/** Encodes `plan`, then edits the JSON exactly as a hand-edited or torn row would be. */
function corruptedJson(plan: Plan, mutate: (row: Row) => void): string {
  const row = JSON.parse(encodePlan(plan)) as Row;
  mutate(row);
  return JSON.stringify(row);
}

/** Asserts BOTH the error class and a reason substring lifted from the source. */
function assertRefused(json: string, columns: PlanRowColumns, reason: RegExp): void {
  assert.throws(() => parsePlan(json, columns), PersistenceCorruptionError);
  assert.throws(() => parsePlan(json, columns), { code: "PERSISTENCE_CORRUPTION", message: reason });
}

/** Applies one JSON-level corruption to an otherwise valid plan and asserts refusal. */
function assertCorrupt(plan: Plan, mutate: (row: Row) => void, reason: RegExp): void {
  assertRefused(corruptedJson(plan, mutate), columnsOf(plan), reason);
}

/** Asserts refusal of a plan whose CONTENT is invalid but whose digests are honest. */
function assertRefusedPlan(plan: Plan, reason: RegExp): void {
  assertRefused(encodePlan(plan), columnsOf(plan), reason);
}

describe("parsePlan — a valid row still parses", () => {
  it("parses a valid pre-approval plan row", () => {
    const plan = basePlan();
    const parsed = parsePlan(encodePlan(plan), columnsOf(plan));
    assert.deepEqual(parsed, plan);
    assert.equal(parsed.phase, "PLAN_REVIEW");
    assert.equal(parsed.revisions[0]?.contentDigest, REV1.contentDigest);
  });

  it("round-trips an approved, materialized, dispatched plan without losing a field", () => {
    const plan = executingPlan();
    const parsed = parsePlan(encodePlan(plan), columnsOf(plan));

    assert.deepEqual(parsed, plan, "encode -> parse preserves every field");
    assert.equal(parsed.approvedDigest, approvalDigestOfPlan(plan, REV1));
    assert.equal(parsed.revisions[0]?.items[1]?.dependsOn[0], "WI-A");
    assert.equal(parsed.materialized[0]?.correlationTag, "plan-fixture:r1:WI-A");
    assert.equal(parsed.dispatches[0]?.loopId, "loop-0001");
    assert.equal(parsed.events.at(-1)?.kind, "DISPATCHED");

    // parse -> encode -> parse is stable, so a re-persisted row stays readable.
    const reparsed = parsePlan(encodePlan(parsed), columnsOf(parsed));
    assert.deepEqual(reparsed, parsed);
    assert.equal(encodePlan(reparsed), encodePlan(parsed));
  });
});

describe("parsePlan — the data column itself", () => {
  it("refuses a data column that is not valid JSON at all", () => {
    assertRefused("{ this is not json", columnsOf(basePlan()), /data column is not valid JSON/);
  });
});

/**
 * The SQL columns are what queries select on; the JSON body is what the state
 * machine branches on. Trusting either half silently would let a query select a
 * plan whose contents say something else entirely — e.g. `findActiveByRequestKey`
 * returning a row indexed as EXECUTING whose payload claims it was CANCELLED, or
 * a CAS "winning" against a version the payload never held.
 */
describe("parsePlan — SQL column / JSON payload cross-checks", () => {
  it("refuses a payload id that disagrees with the row's id column", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        row.id = "plan-someone-else";
      },
      /data\.id plan-someone-else does not match the row id plan-fixture/,
    );
  });

  it("refuses a payload projectId that disagrees with the row's project_id column", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        row.projectId = "prj-someone-else";
      },
      /data\.projectId prj-someone-else does not match the row project_id prj-test/,
    );
  });

  it("refuses a payload requestKey that disagrees with the row's request_key column", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        row.requestKey = "req-someone-else";
      },
      /data\.requestKey req-someone-else does not match the row request_key req-fixture/,
    );
  });

  it("refuses a payload phase that disagrees with the row's phase column", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        row.phase = "PLANNING";
      },
      /data\.phase PLANNING does not match the row phase PLAN_REVIEW/,
    );
  });

  it("refuses a payload version that disagrees with the row's version column", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        row.version = 99;
      },
      /data\.version 99 does not match the row version 3/,
    );
  });
});

/**
 * THE load-bearing check. A stored `contentDigest` is never authority: it must
 * equal the hash of the content stored beside it. This is what makes "approved
 * plan content may not be edited" ENFORCEABLE rather than aspirational — an
 * edited revision cannot even be loaded, so it can never be materialized into
 * work items, bound to a stale approval, or dispatched to a worker. Binding
 * approval to a revision NUMBER alone would not do this: content can change
 * without the counter moving.
 */
describe("parsePlan — revision content digests are recomputed, never trusted", () => {
  it("refuses a revision whose summary was edited without updating its stored digest", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        entry(row.revisions, 0).summary = "Quietly rewritten scope.";
      },
      /does not match the digest of the stored content/,
    );
    // The reason names the rule explicitly, so an operator reading a log knows
    // this is a tampering signal rather than a transient decode failure.
    assertCorrupt(
      basePlan(),
      (row) => {
        entry(row.revisions, 0).summary = "Quietly rewritten scope.";
      },
      /approved plan content may not be edited/,
    );
  });

  it("refuses a revision whose item spec was edited without updating its stored digest", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        entry(entry(row.revisions, 0).items, 0).spec = "Delete the production database instead.";
      },
      /does not match the digest of the stored content/,
    );
  });

  it("refuses a revision whose stored digest was simply wrong from the start", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        entry(row.revisions, 0).contentDigest = "plan-notarealdigest";
      },
      /stored contentDigest plan-notarealdigest does not match the digest of the stored content/,
    );
  });
});

describe("parsePlan — append-only sequences must be strictly 1..n", () => {
  it("refuses revisions with a gap ([1, 3])", () => {
    assertRefusedPlan(
      basePlan({ revisions: [revision(1, ITEMS), revision(3, ITEMS)] }),
      /revisions must be numbered strictly 1\.\.n in order; entry 1 is revision 3/,
    );
  });

  it("refuses revisions stored out of order ([2, 1])", () => {
    assertRefusedPlan(
      basePlan({ revisions: [revision(2, ITEMS), revision(1, ITEMS)] }),
      /revisions must be numbered strictly 1\.\.n in order; entry 0 is revision 2/,
    );
  });

  it("refuses events that are not numbered strictly 1..n in order", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        entry(row.events, 1).seq = 3;
      },
      /events must be numbered strictly 1\.\.n in order; entry 1 has seq 3/,
    );
  });
});

describe("parsePlan — enums and scalar ranges", () => {
  it("refuses an unknown phase value", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        row.phase = "SOMEDAY_MAYBE";
      },
      /field "phase" must be one of/,
    );
  });

  it("refuses an unknown event kind", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        entry(row.events, 0).kind = "NOT_A_KIND";
      },
      /field "kind" must be one of/,
    );
  });

  it("refuses a negative timestamp", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        row.startedAt = -1;
      },
      /field "startedAt" must be a non-negative integer timestamp, got -1/,
    );
  });

  it("refuses a non-integer timestamp", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        entry(row.events, 0).at = 1.5;
      },
      /field "at" must be a non-negative integer timestamp, got 1\.5/,
    );
  });
});

/**
 * A half-written approval is corruption, not "probably fine": accepting one
 * would let a plan claim human authority for content no human ever saw.
 */
describe("parsePlan — the approval triple is all-or-nothing and coherent", () => {
  it("refuses an approvalId with no approvedRevision beside it", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        delete row.approvedRevision;
      },
      /approvalId, approvedRevision and approvedDigest must all be present or all absent/,
    );
  });

  it("refuses an approvedRevision that names a revision this plan does not have", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        row.approvedRevision = 9;
      },
      /approvedRevision 9 does not exist in this plan/,
    );
  });

  it("refuses an approvedDigest that does not match this plan's approved content and configuration", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        row.approvedDigest = "papr-notthestoreddigest";
      },
      /approvedDigest papr-notthestoreddigest does not match this plan's approved content and configuration/,
    );
  });

  // Remediation round 1, HIGH 4. These are the two mutations independent review
  // performed successfully against the pre-fix build: switching the project the
  // approved work is created in, and rewriting the commands that verify it.
  // Neither is inside a revision, so neither used to change any digest.
  it("refuses a projectId switched after approval", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        row.projectId = "prj-somewhere-else";
      },
      /does not match the row project_id/,
    );
  });

  it("refuses a projectId switched in BOTH the row column and the payload", () => {
    const plan = executingPlan();
    const moved: Plan = { ...plan, projectId: "prj-somewhere-else" };
    assert.throws(
      () => parsePlan(encodePlan(moved), columnsOf(moved)),
      /approvedDigest .* does not match this plan's approved content and configuration/,
    );
  });

  it("refuses verification commands rewritten to a shell after approval", () => {
    const plan = executingPlan();
    const rewritten: Plan = {
      ...plan,
      execution: {
        ...plan.execution,
        verificationCommands: [{ id: "check", executable: "sh", argv: ["-c", "echo pwned"] }],
      },
    };
    assert.throws(
      () => parsePlan(encodePlan(rewritten), columnsOf(rewritten)),
      /approvedDigest .* does not match this plan's approved content and configuration/,
    );
  });

  it("refuses a workspaceRoot moved after approval", () => {
    const plan = executingPlan();
    const moved: Plan = { ...plan, execution: { ...plan.execution, workspaceRoot: "/tmp/somewhere-else" } };
    assert.throws(
      () => parsePlan(encodePlan(moved), columnsOf(moved)),
      /approvedDigest .* does not match this plan's approved content and configuration/,
    );
  });

  it("refuses an implementer worker configuration swapped after approval", () => {
    const plan = executingPlan();
    const swapped: Plan = {
      ...plan,
      execution: { ...plan.execution, implementer: { tool: "scripted", model: "some-other-model" } },
    };
    assert.throws(
      () => parsePlan(encodePlan(swapped), columnsOf(swapped)),
      /approvedDigest .* does not match this plan's approved content and configuration/,
    );
  });

  it("refuses an approval superseded by a newer revision", () => {
    const plan = executingPlan();
    const superseded: Plan = { ...plan, revisions: [...plan.revisions, revision(2, ITEMS)] };
    assert.throws(() => parsePlan(encodePlan(superseded), columnsOf(superseded)), /is superseded/);
  });
});

/**
 * Derived identities are RECOMPUTED, never trusted (the TASK-004 round-2
 * lesson). A correlation tag is a pure function of (planId, approvedRevision,
 * planItemKey), so a corrupted row cannot point one plan item's mapping at
 * another item's — or another plan's — work item and have it survive a read.
 */
describe("parsePlan — materialization state", () => {
  it("refuses a materialized mapping whose correlationTag is not the canonical one", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        // WI-A's mapping wearing WI-B's tag: exactly the cross-wiring the
        // recomputation exists to catch.
        entry(row.materialized, 0).correlationTag = CORR_B;
      },
      new RegExp(`materialized mapping tag ${CORR_B} is not the canonical ${CORR_A}`),
    );
  });

  it("refuses a materialization claim naming a plan item that is not in the approved revision", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        row.materializationClaim = {
          planItemKey: "WI-GHOST",
          correlationTag: canonicalCorrelationTag(PLAN_ID, 1, "WI-GHOST"),
          claimedAt: T + 15,
        };
      },
      /materialization claim names plan item "WI-GHOST", which is not in the approved revision/,
    );
  });

  it("refuses a materialized mapping naming a plan item that is not in the approved revision", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        entry(row.materialized, 0).planItemKey = "WI-GHOST";
      },
      /materialized mapping names plan item "WI-GHOST", which is not in the approved revision/,
    );
  });

  it("refuses materialization state with no approved revision at all — work may not exist before approval", () => {
    assertRefusedPlan(
      basePlan({ materialized: [mapped("WI-A", "wi-0001", true)] }),
      /materialization state exists without an approved revision; work may not be created before approval/,
    );
  });

  it("refuses two materialized entries for the same plan item key", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        row.materialized = [mapped("WI-A", "wi-0001", true), mapped("WI-A", "wi-0002", true)];
      },
      /plan item "WI-A" is materialized more than once/,
    );
  });

  it("refuses two materialized entries mapping to the same work item id", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        row.materialized = [mapped("WI-A", "wi-0001", true), mapped("WI-B", "wi-0001", true)];
      },
      /work item wi-0001 is mapped to more than one plan item/,
    );
  });
});

/**
 * A loop can only legally start from READY, so a dispatch of anything that is
 * not both materialized and readied is an impossible lineage rather than a
 * crash window a legitimate execution path could have left behind.
 */
describe("parsePlan — dispatch state", () => {
  it("refuses a dispatch referencing a plan item that is not materialized", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        entry(row.dispatches, 0).planItemKey = "WI-GHOST";
      },
      /dispatch references plan item "WI-GHOST", which is not materialized/,
    );
  });

  it("refuses a dispatch whose workItemId disagrees with the mapping", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        entry(row.dispatches, 0).workItemId = "wi-9999";
      },
      /dispatch for "WI-A" names work item wi-9999, but the mapping names wi-0001/,
    );
  });

  it("refuses a dispatch of an item that was never readied", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        row.dispatches = [dispatched("WI-B", "wi-0002", "loop-0002")];
      },
      /dispatch references plan item "WI-B", which was never readied/,
    );
  });

  it("refuses two dispatches of the same plan item key", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        row.dispatches = [dispatched("WI-A", "wi-0001", "loop-0001"), dispatched("WI-A", "wi-0001", "loop-0002")];
      },
      /plan item "WI-A" is dispatched more than once/,
    );
  });

  it("refuses a dispatch claim for an item that is not materialized", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        row.dispatchClaim = { planItemKey: "WI-GHOST", workItemId: "wi-0003", claimedAt: T + 25 };
      },
      /dispatch claim references plan item "WI-GHOST", which is not materialized/,
    );
  });

  it("refuses a dispatch claim for an item that was never readied", () => {
    assertCorrupt(
      executingPlan(),
      (row) => {
        row.dispatchClaim = { planItemKey: "WI-B", workItemId: "wi-0002", claimedAt: T + 25 };
      },
      /dispatch claim references plan item "WI-B", which was never readied/,
    );
  });
});

describe("parsePlan — revision internal coherence", () => {
  it("refuses an item depending on a key that is not part of its revision", () => {
    // Digest recomputed for the edited content, so the ONLY thing wrong here is
    // the dangling dependency — which would otherwise stall dispatch forever.
    assertRefusedPlan(
      basePlan({ revisions: [revision(1, [item("WI-A", { dependsOn: ["WI-GHOST"] }), item("WI-B")])] }),
      /work item "WI-A" depends on "WI-GHOST", which is not part of this revision/,
    );
  });

  it("refuses an item depending on itself", () => {
    assertRefusedPlan(
      basePlan({ revisions: [revision(1, [item("WI-A", { dependsOn: ["WI-A"] })])] }),
      /work item "WI-A" depends on itself/,
    );
  });

  it("refuses duplicate item keys within one revision", () => {
    assertRefusedPlan(
      basePlan({ revisions: [revision(1, [item("WI-A"), item("WI-A", { title: "Same key, different item" })])] }),
      /duplicate work item key "WI-A"/,
    );
  });

  it("refuses a revision with zero items", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        entry(row.revisions, 0).items = [];
      },
      /a persisted revision must contain at least one work item/,
    );
  });

  it("refuses an item with zero acceptance criteria (C2/C3)", () => {
    assertCorrupt(
      basePlan(),
      (row) => {
        entry(entry(row.revisions, 0).items, 0).acceptanceCriteria = [];
      },
      /a planned work item must declare at least one acceptance criterion \(C2\/C3\)/,
    );
  });
});

describe("parsePlan — phase presuppositions", () => {
  it("refuses phase PLAN_REVIEW with no revisions stored", () => {
    assertRefusedPlan(
      basePlan({ revisions: [] }),
      /phase PLAN_REVIEW presupposes a generated revision, but none is stored/,
    );
  });

  it("refuses phase NEEDS_CLARIFICATION with no open questions stored", () => {
    assertRefusedPlan(
      basePlan({ phase: "NEEDS_CLARIFICATION" }),
      /phase NEEDS_CLARIFICATION presupposes at least one open question, but none is stored/,
    );
  });

  it("refuses APPROVED, MATERIALIZING and EXECUTING with no recorded approval", () => {
    const postApproval: readonly PlanPhase[] = ["APPROVED", "MATERIALIZING", "EXECUTING"];
    for (const phase of postApproval) {
      assertRefusedPlan(
        basePlan({ phase }),
        new RegExp(`phase ${phase} presupposes a recorded plan approval, but none is stored`),
      );
    }
  });

  it("refuses DRAFT, PLANNING and PLAN_REVIEW that already carry an approval", () => {
    const preApproval: readonly PlanPhase[] = ["DRAFT", "PLANNING", "PLAN_REVIEW"];
    for (const phase of preApproval) {
      assertRefusedPlan(
        basePlan({
          phase,
          approvalId: "apr-0001",
          approvedRevision: 1,
          approvedDigest: REV1.contentDigest,
        }),
        new RegExp(`phase ${phase} precedes approval, but an approval apr-0001 is stored`),
      );
    }
  });

  it("refuses a terminal phase with no outcome recorded", () => {
    assertRefusedPlan(basePlan({ phase: "COMPLETED" }), /phase COMPLETED is terminal but no outcome is recorded/);
  });

  it("refuses a non-terminal, non-BLOCKED phase that carries an outcome", () => {
    assertRefusedPlan(
      basePlan({ outcome: "COMPLETED" }),
      /phase PLAN_REVIEW is not terminal but an outcome COMPLETED is recorded/,
    );
  });
});

describe("nullable author timeout (no total deadline)", () => {
  function withTimeouts(timeouts: { planner?: number | null; implementer?: number | null; workerTimeoutMs?: number | null }): Plan {
    const base = executingPlan();
    return executingPlan({
      planner: { ...base.planner, ...(timeouts.planner === undefined ? {} : { timeoutMs: timeouts.planner }) },
      execution: {
        ...base.execution,
        implementer: { ...base.execution.implementer, ...(timeouts.implementer === undefined ? {} : { timeoutMs: timeouts.implementer }) },
        loopBudget: { maxIterations: 2, ...(timeouts.workerTimeoutMs === undefined ? {} : { workerTimeoutMs: timeouts.workerTimeoutMs }) },
      },
    });
  }

  it("round-trips explicit null, absent and finite distinctly", () => {
    const nulled = withTimeouts({ planner: null, implementer: null, workerTimeoutMs: null });
    const parsedNull = parsePlan(encodePlan(nulled), columnsOf(nulled));
    assert.equal(parsedNull.planner.timeoutMs, null);
    assert.equal(parsedNull.execution.implementer.timeoutMs, null);
    assert.equal(parsedNull.execution.loopBudget?.workerTimeoutMs, null);

    const absent = withTimeouts({});
    const parsedAbsent = parsePlan(encodePlan(absent), columnsOf(absent));
    assert.equal("timeoutMs" in parsedAbsent.planner, false);
    assert.equal("workerTimeoutMs" in (parsedAbsent.execution.loopBudget ?? {}), false);

    const finite = withTimeouts({ planner: 300000, implementer: 300000, workerTimeoutMs: 300000 });
    const parsedFinite = parsePlan(encodePlan(finite), columnsOf(finite));
    assert.equal(parsedFinite.execution.implementer.timeoutMs, 300000);
    assert.equal(parsedFinite.execution.loopBudget?.workerTimeoutMs, 300000);
  });

  it("refuses malformed author scalars and null on non-author numeric fields", () => {
    const plan = withTimeouts({ implementer: null, workerTimeoutMs: null });
    for (const bad of ["5", true, 1.5, 0, -1]) {
      assertCorrupt(plan, (row) => ((row.execution as Row).implementer as Row).timeoutMs = bad, /timeoutMs/);
      assertCorrupt(plan, (row) => ((row.execution as Row).loopBudget as Row).workerTimeoutMs = bad, /workerTimeoutMs/);
    }
    assertCorrupt(plan, (row) => ((row.execution as Row).loopBudget as Row).verificationTimeoutMs = null, /verificationTimeoutMs/);
    assertCorrupt(plan, (row) => ((row.execution as Row).loopBudget as Row).maxIterations = null, /maxIterations/);
    assertCorrupt(plan, (row) => (((row.execution as Row).verificationCommands as Row[])[0] as Row).timeoutMs = null, /timeoutMs/);
  });

  // ORIGINAL algorithm, frozen here as an independent oracle (only the author-timeout segments matter).
  const seg = (v: string): string => `${v.length}:${v}`;
  const segList = (v: readonly string[]): string => `${v.length}[${v.map(seg).join("")}]`;
  const optSeg = (v: string | undefined): string => (v === undefined ? "~" : `=${seg(v)}`);
  const optNum = (v: number | undefined): string => (v === undefined ? "~" : `=${v}`);
  function oracleWorker(c: { tool: string; model: string; effort?: string; timeoutMs?: number }): string {
    return [`tool:${seg(c.tool)}`, `model:${seg(c.model)}`, `effort:${optSeg(c.effort)}`, `timeoutMs:${optNum(c.timeoutMs)}`].join(",");
  }
  function oracleApproval(plan: Plan): string {
    const rev = plan.revisions[0]!;
    const e = plan.execution;
    const commands = e.verificationCommands.map((c) =>
      [`id:${seg(c.id)}`, `executable:${seg(c.executable)}`, `argv:${segList(c.argv)}`, `cwd:${optSeg(c.cwd)}`, `timeoutMs:${optNum(c.timeoutMs)}`].join(","),
    );
    const b = e.loopBudget;
    const loopBudget =
      b === undefined
        ? "~"
        : `=${[
            `maxIterations:${optNum(b.maxIterations)}`,
            `maxTotalRuns:${optNum(b.maxTotalRuns)}`,
            `maxWallClockMs:${optNum(b.maxWallClockMs)}`,
            `workerTimeoutMs:${optNum(b.workerTimeoutMs as number | undefined)}`,
            `verificationTimeoutMs:${optNum(b.verificationTimeoutMs)}`,
          ].join(",")}`;
    const execution = [
      `implementer:${oracleWorker(e.implementer as never)}`,
      `reviewer:${oracleWorker(e.reviewer as never)}`,
      `commands:${commands.length}[${commands.map(seg).join("")}]`,
      `workspaceRoot:${seg(e.workspaceRoot)}`,
      `loopBudget:${loopBudget}`,
    ].join("|");
    const budget = [
      `maxPlannerAttempts:${plan.budget.maxPlannerAttempts}`,
      `maxClarificationCycles:${plan.budget.maxClarificationCycles}`,
      `maxTotalPlannerRuns:${plan.budget.maxTotalPlannerRuns}`,
      `maxWallClockMs:${optNum(plan.budget.maxWallClockMs)}`,
    ].join(",");
    const canonical = [
      "papr-v1",
      `projectId:${seg(plan.projectId)}`,
      `intent:${seg(plan.intent)}`,
      `declaredConstraints:${segList(plan.declaredConstraints)}`,
      `budget:${seg(budget)}`,
      `planner:${seg(oracleWorker(plan.planner as never))}`,
      `execution:${seg(execution)}`,
      `revision:${seg(computePlanContentDigest({
        revision: rev.revision, summary: rev.summary, assumptions: rev.assumptions, constraints: rev.constraints, risks: rev.risks, items: rev.items,
      }))}`,
    ].join("|");
    return `papr-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
  }

  it("keeps every absent/finite approval digest byte-identical to the original algorithm", () => {
    for (const plan of [
      withTimeouts({}),
      withTimeouts({ planner: 60000, implementer: 300000, workerTimeoutMs: 120000 }),
      withTimeouts({ workerTimeoutMs: 1 }),
    ]) {
      assert.equal(approvalDigestOfPlan(plan, plan.revisions[0]!), oracleApproval(plan));
    }
  });

  it("distinguishes explicit null from absent and from a finite value", () => {
    const digestOf = (p: Plan): string => approvalDigestOfPlan(p, p.revisions[0]!);
    const variants = [
      withTimeouts({}),
      withTimeouts({ implementer: null }),
      withTimeouts({ implementer: 300000 }),
      withTimeouts({ planner: null }),
      withTimeouts({ workerTimeoutMs: null }),
      withTimeouts({ workerTimeoutMs: 300000 }),
    ].map(digestOf);
    assert.equal(new Set(variants).size, variants.length);
  });
});
