/**
 * The content digest that makes **approval content binding** real (TASK-005;
 * the property AC-5 leans on: "the approval binds to plan id + revision +
 * exact content digest", so a content change after approval invalidates the
 * approval at the central gate).
 *
 * The hazard this exists to close was proved by the Round-2 review of TASK-001:
 * binding an approval to a revision COUNTER is not enough, because content can
 * change without the counter moving and the stale approval still satisfies the
 * gate. So this file proves both halves of the digest's contract:
 *
 *  - SENSITIVITY: every semantically authoritative field — summary, revision
 *    number, assumptions, constraints, risks, and each item's key, title, type,
 *    priority, spec, acceptance criteria and dependencies — changes the digest.
 *    Nothing that could change what gets built, what "done" means, or what order
 *    things happen in can move without the approval going stale.
 *  - STABILITY: re-derivations that are not material changes do NOT move it —
 *    item array order, dependency declaration order, a JSON round-trip, and pure
 *    provenance (`plannerRunRef`, `generatedAt`) are all irrelevant. A digest
 *    that drifted spuriously would train people to re-approve reflexively.
 *
 * It also pins the length-prefix property directly: `["a|b"]` and `["a","b"]`
 * must not collide, because a collision would let two different plans share one
 * digest and therefore share one human approval.
 *
 * Pure and offline: hashing only, no AI, no network, no filesystem, no timers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Priority, WorkItemType } from "../src/domain/workItem.js";
import { computePlanApprovalDigest, computePlanContentDigest, digestOfRevision, type PlanApprovalDigestInput, type PlanDigestInput } from "../src/planning/planDigest.js";
import type { PlanExecutionConfig, PlannedWorkItem, PlanRevision } from "../src/planning/planTypes.js";

type Criterion = { readonly text: string; readonly verificationHint: string };

function item(fields: {
  key?: string;
  title?: string;
  type?: WorkItemType;
  priority?: Priority;
  spec?: string;
  acceptanceCriteria?: readonly Criterion[];
  dependsOn?: readonly string[];
} = {}): PlannedWorkItem {
  return {
    key: fields.key ?? "WI-A",
    title: fields.title ?? "Harden the planner contract",
    type: fields.type ?? "FEATURE",
    priority: fields.priority ?? "P1",
    spec: fields.spec ?? "Reject anything the contract does not explicitly name.",
    acceptanceCriteria: fields.acceptanceCriteria ?? [{ text: "the digest is stable", verificationHint: "npm test" }],
    dependsOn: fields.dependsOn ?? [],
  };
}

const BASE: PlanDigestInput = {
  revision: 1,
  summary: "Deliver the strict planner contract.",
  assumptions: ["Node 22 is available"],
  constraints: ["No network access during tests"],
  risks: ["A chatty planner wastes attempts"],
  items: [item({ key: "WI-A" }), item({ key: "WI-B", dependsOn: ["WI-A"] })],
};

function withItems(items: readonly PlannedWorkItem[]): PlanDigestInput {
  return { ...BASE, items };
}

/** The two base items, pulled out once so variants can be built by spreading them. */
const ITEM_A = BASE.items[0]!;
const ITEM_B = BASE.items[1]!;

const BASE_DIGEST = computePlanContentDigest(BASE);

/** Builds a full stored revision around some content, with deliberately wrong provenance. */
function revisionOf(content: PlanDigestInput, plannerRunRef = "run-0001", generatedAt = 1_700_000_000_000): PlanRevision {
  return {
    revision: content.revision,
    summary: content.summary,
    assumptions: content.assumptions,
    constraints: content.constraints,
    risks: content.risks,
    items: content.items,
    // Deliberately not a real digest: `digestOfRevision` must RECOMPUTE from
    // content rather than echo whatever was stored alongside it.
    contentDigest: "plan-deliberately-wrong",
    plannerRunRef,
    generatedAt,
  };
}

describe("computePlanContentDigest: shape and determinism", () => {
  it("is deterministic for the same input", () => {
    assert.equal(computePlanContentDigest(BASE), computePlanContentDigest(BASE));
  });

  it('produces a "plan-" prefixed digest', () => {
    assert.ok(BASE_DIGEST.startsWith("plan-"), `expected a plan- prefixed digest, got: ${BASE_DIGEST}`);
    assert.match(BASE_DIGEST, /^plan-[0-9a-f]{32}$/);
  });

  it("is stable across a JSON round-trip of the content", () => {
    const roundTripped = JSON.parse(JSON.stringify(BASE)) as PlanDigestInput;
    assert.equal(computePlanContentDigest(roundTripped), BASE_DIGEST);
  });
});

describe("computePlanContentDigest: orderings that are not material changes", () => {
  it("ignores the order items arrive in — the digest sorts by key", () => {
    const shuffled = withItems([ITEM_B, ITEM_A]);
    assert.equal(computePlanContentDigest(shuffled), BASE_DIGEST);
  });

  it("ignores the order dependencies are declared in — dependsOn is a set", () => {
    const forwards = withItems([
      item({ key: "WI-A" }),
      item({ key: "WI-B" }),
      item({ key: "WI-C", dependsOn: ["WI-A", "WI-B"] }),
    ]);
    const backwards = withItems([
      item({ key: "WI-A" }),
      item({ key: "WI-B" }),
      item({ key: "WI-C", dependsOn: ["WI-B", "WI-A"] }),
    ]);
    assert.equal(computePlanContentDigest(forwards), computePlanContentDigest(backwards));
  });
});

describe("computePlanContentDigest: every authoritative field is covered", () => {
  it("changes when the summary changes", () => {
    assert.notEqual(computePlanContentDigest({ ...BASE, summary: "A materially different plan." }), BASE_DIGEST);
  });

  it("changes when the revision number changes", () => {
    assert.notEqual(computePlanContentDigest({ ...BASE, revision: 2 }), BASE_DIGEST);
  });

  it("changes when assumptions, constraints or risks change", () => {
    assert.notEqual(computePlanContentDigest({ ...BASE, assumptions: ["Node 20 is available"] }), BASE_DIGEST);
    assert.notEqual(computePlanContentDigest({ ...BASE, constraints: [] }), BASE_DIGEST);
    assert.notEqual(computePlanContentDigest({ ...BASE, risks: ["A brand new risk"] }), BASE_DIGEST);
  });

  it("changes when an item's spec changes", () => {
    assert.notEqual(computePlanContentDigest(withItems([{ ...ITEM_A, spec: "Do something else entirely." }, ITEM_B])), BASE_DIGEST);
  });

  it("changes when an item's title changes", () => {
    assert.notEqual(computePlanContentDigest(withItems([{ ...ITEM_A, title: "A different title" }, ITEM_B])), BASE_DIGEST);
  });

  it("changes when an item's type changes", () => {
    assert.notEqual(computePlanContentDigest(withItems([{ ...ITEM_A, type: "CHORE" }, ITEM_B])), BASE_DIGEST);
  });

  it("changes when an item's priority changes", () => {
    assert.notEqual(computePlanContentDigest(withItems([{ ...ITEM_A, priority: "P0" }, ITEM_B])), BASE_DIGEST);
  });

  it("changes when an item's key changes", () => {
    assert.notEqual(computePlanContentDigest(withItems([{ ...ITEM_A, key: "WI-RENAMED" }, ITEM_B])), BASE_DIGEST);
  });

  it("changes when an acceptance criterion is added or removed", () => {
    const added = withItems([
      {
        ...ITEM_A,
        acceptanceCriteria: [...ITEM_A.acceptanceCriteria, { text: "an extra criterion", verificationHint: "npm test" }],
      },
      ITEM_B,
    ]);
    const removed = withItems([{ ...ITEM_A, acceptanceCriteria: [] }, ITEM_B]);
    assert.notEqual(computePlanContentDigest(added), BASE_DIGEST);
    assert.notEqual(computePlanContentDigest(removed), BASE_DIGEST);
    assert.notEqual(computePlanContentDigest(added), computePlanContentDigest(removed));
  });

  it("changes when an acceptance criterion's text or verification hint is edited", () => {
    const editedText = withItems([
      { ...ITEM_A, acceptanceCriteria: [{ text: "the digest is NOT stable", verificationHint: "npm test" }] },
      ITEM_B,
    ]);
    const editedHint = withItems([
      { ...ITEM_A, acceptanceCriteria: [{ text: "the digest is stable", verificationHint: "npm run verify" }] },
      ITEM_B,
    ]);
    assert.notEqual(computePlanContentDigest(editedText), BASE_DIGEST);
    assert.notEqual(computePlanContentDigest(editedHint), BASE_DIGEST);
  });

  it("changes when a dependency is added or removed", () => {
    const withoutDependency = withItems([ITEM_A, { ...ITEM_B, dependsOn: [] }]);
    const withExtraDependency = withItems([
      ITEM_A,
      item({ key: "WI-C" }),
      { ...ITEM_B, dependsOn: ["WI-A", "WI-C"] },
    ]);
    assert.notEqual(computePlanContentDigest(withoutDependency), BASE_DIGEST);
    assert.notEqual(computePlanContentDigest(withExtraDependency), BASE_DIGEST);
  });

  it("changes when an item is added or removed", () => {
    assert.notEqual(computePlanContentDigest(withItems([ITEM_A])), BASE_DIGEST);
  });
});

describe("computePlanContentDigest: the length-prefix property", () => {
  it('does not collide ["a|b"] with ["a","b"] in a list field', () => {
    // A naive join on "|" would serialize both to the same string, letting two
    // different plans share one digest and therefore share one human approval.
    const joined = computePlanContentDigest({ ...BASE, assumptions: ["a|b"] });
    const split = computePlanContentDigest({ ...BASE, assumptions: ["a", "b"] });
    assert.notEqual(joined, split);

    const joinedDeps = computePlanContentDigest(withItems([{ ...ITEM_A, dependsOn: ["a|b"] }]));
    const splitDeps = computePlanContentDigest(withItems([{ ...ITEM_A, dependsOn: ["a", "b"] }]));
    assert.notEqual(joinedDeps, splitDeps);
  });

  it("does not collide when an item field value contains the | separator", () => {
    const separatorInSpec = computePlanContentDigest(withItems([{ ...ITEM_A, title: "x", spec: "y|z" }]));
    const separatorInTitle = computePlanContentDigest(withItems([{ ...ITEM_A, title: "x|y", spec: "z" }]));
    assert.notEqual(separatorInSpec, separatorInTitle);

    // And a value that itself imitates the canonical field syntax buys nothing.
    const imitatesFieldSyntax = computePlanContentDigest(withItems([{ ...ITEM_A, title: "x|type:7:REFACTOR" }]));
    assert.notEqual(imitatesFieldSyntax, computePlanContentDigest(withItems([{ ...ITEM_A, type: "REFACTOR" }])));
  });
});

describe("digestOfRevision", () => {
  it("agrees with computePlanContentDigest for the same content", () => {
    assert.equal(digestOfRevision(revisionOf(BASE)), BASE_DIGEST);
  });

  it("recomputes from content rather than trusting the stored contentDigest", () => {
    const stored = revisionOf(BASE);
    assert.equal(stored.contentDigest, "plan-deliberately-wrong");
    assert.equal(digestOfRevision(stored), BASE_DIGEST);
  });

  it("ignores pure provenance: a different plannerRunRef or generatedAt is not a content change", () => {
    const first = revisionOf(BASE, "run-0001", 1_700_000_000_000);
    const second = revisionOf(BASE, "run-9999", 1_800_000_000_000);
    assert.equal(digestOfRevision(first), digestOfRevision(second));
  });

  it("moves when the revision's content moves", () => {
    const edited = revisionOf({ ...BASE, summary: "A materially different plan." });
    assert.notEqual(digestOfRevision(edited), BASE_DIGEST);
  });
});

// =====================================================================
// PHASE7-101: approved deterministic verification policy
// =====================================================================

describe("PHASE7-101: approved deterministic verification policy", () => {
  /**
   * Captured from the old compiled public `computePlanApprovalDigest`, before
   * `verificationExecutionPolicy` existed, against the exact input produced by
   * the public `newPlanning`/`planAtReview` fixtures. This is not a
   * re-derivation of the current algorithm — it is a frozen fact about what an
   * old, legacy-absent-policy approval already hashed to, so a later change to
   * this module cannot silently move a digest a human already approved under.
   *
   * Embedded as ordinary typed data rather than read from a file at runtime:
   * `tsc` does not copy non-TS inputs into `dist`, so a runtime read would make
   * this module fail to load in a compiled build before reaching any of the
   * assertions below.
   */
  const LEGACY_EXPECTED_DIGEST = "papr-f7090a079f9347b100744c03a901c428";

  const POLICY_BASE_REVISION: PlanRevision = {
    revision: 1,
    summary: "Deliver the requested capability.",
    assumptions: [],
    constraints: [],
    risks: [],
    items: [
      {
        key: "WI-A",
        title: "Do the thing",
        type: "FEATURE",
        priority: "P2",
        spec: "Implement the thing as described.",
        acceptanceCriteria: [{ text: "Do the thing behaves as specified", verificationHint: "npm test" }],
        dependsOn: [],
      },
    ],
    contentDigest: "plan-98c96e2312979c79f0d54b71663df6d5",
    plannerRunRef: "plan-0001:r1:planner:a1",
    generatedAt: 1767225605000,
  };

  const POLICY_BASE: PlanApprovalDigestInput = {
    projectId: "prj-0001",
    intent: "Build the thing.",
    declaredConstraints: [],
    budget: { maxPlannerAttempts: 2, maxClarificationCycles: 2, maxTotalPlannerRuns: 6 },
    planner: { tool: "scripted", model: "test-planner" },
    execution: {
      implementer: { tool: "scripted", model: "test-implementer" },
      reviewer: { tool: "scripted", model: "test-reviewer" },
      verificationCommands: [{ id: "check", executable: "node", argv: ["-e", "process.exit(0)"] }],
      workspaceRoot: "/tmp/sf-plan-test",
      loopBudget: { maxIterations: 2 },
      ticketTemplates: [
        {
          planItemKey: "WI-A",
          schemaVersion: "1.0.0",
          objective: "Implement the roadmap item to a reviewable, verifiable state.",
          acceptanceCriteria: [{ id: "AC-1", version: "1.0.0", description: "Do the thing behaves as specified" }],
          scope: {
            owned: ["src/example.ts"],
            forbidden: [],
            read: [],
            dependencies: [],
            validation: ["npm test"],
          },
          model: {
            eligibleModels: ["claude-code/opus"],
            reasoningEffort: "medium",
            rationale: "Needs multi-file reasoning across the module.",
          },
          budgets: { contextTokens: 100000, outputTokens: 4000, elapsedSeconds: 1800, maxAttempts: 2 },
          policy: {
            checkpoint: "after each verification pass",
            stopConditions: ["acceptance criteria met"],
            escalation: "escalate to a human on repeated failure",
          },
          resultSchema: { requiredFields: ["status", "summary"], maxResultBytes: 2048 },
        },
      ],
    },
    revision: POLICY_BASE_REVISION,
  };

  const VALID_POLICY: NonNullable<PlanExecutionConfig["verificationExecutionPolicy"]> = {
    budgets: { elapsedSeconds: 900, outputBytes: 65536, maxAttempts: 3 },
    executionPolicy: { rationale: "Bounded deterministic verification only." },
  };

  function withPolicy(policy: unknown): PlanApprovalDigestInput {
    return {
      ...POLICY_BASE,
      execution: { ...POLICY_BASE.execution, verificationExecutionPolicy: policy } as unknown as PlanExecutionConfig,
    };
  }

  it("the genuine legacy, policy-absent input reproduces the exact pinned legacy digest", () => {
    assert.equal(computePlanApprovalDigest(POLICY_BASE), LEGACY_EXPECTED_DIGEST);
    assert.equal(LEGACY_EXPECTED_DIGEST, "papr-f7090a079f9347b100744c03a901c428");
  });

  it("adding a valid policy to the legacy-absent baseline changes the digest", () => {
    const withValidPolicy = computePlanApprovalDigest(withPolicy(VALID_POLICY));
    assert.notEqual(withValidPolicy, LEGACY_EXPECTED_DIGEST);
  });

  it("each authoritative policy field mutation changes the digest", () => {
    const baseline = computePlanApprovalDigest(withPolicy(VALID_POLICY));

    const elapsedChanged = computePlanApprovalDigest(
      withPolicy({ ...VALID_POLICY, budgets: { ...VALID_POLICY.budgets, elapsedSeconds: 901 } }),
    );
    const outputBytesChanged = computePlanApprovalDigest(
      withPolicy({ ...VALID_POLICY, budgets: { ...VALID_POLICY.budgets, outputBytes: 65537 } }),
    );
    const maxAttemptsChanged = computePlanApprovalDigest(
      withPolicy({ ...VALID_POLICY, budgets: { ...VALID_POLICY.budgets, maxAttempts: 4 } }),
    );
    const rationaleChanged = computePlanApprovalDigest(
      withPolicy({ ...VALID_POLICY, executionPolicy: { rationale: "A different, equally meaningful rationale." } }),
    );

    assert.notEqual(elapsedChanged, baseline);
    assert.notEqual(outputBytesChanged, baseline);
    assert.notEqual(maxAttemptsChanged, baseline);
    assert.notEqual(rationaleChanged, baseline);
  });

  it("rejects a malformed present policy rather than silently narrowing it away", () => {
    assert.throws(() => computePlanApprovalDigest(withPolicy({ budgets: { elapsedSeconds: 0, outputBytes: 1, maxAttempts: 1 }, executionPolicy: { rationale: "Meaningful enough." } })));
    assert.throws(() => computePlanApprovalDigest(withPolicy({ budgets: { elapsedSeconds: 1, outputBytes: 1, maxAttempts: 1 }, executionPolicy: { rationale: "short" } })));
  });

  it("rejects an unknown top-level or nested field rather than ignoring it", () => {
    const unknownTopLevel: unknown = { ...VALID_POLICY, extra: true };
    const unknownBudgets: unknown = { ...VALID_POLICY, budgets: { ...VALID_POLICY.budgets, tokens: 10 } };
    const unknownNestedPolicy: unknown = { ...VALID_POLICY, executionPolicy: { ...VALID_POLICY.executionPolicy, provider: "mixed" } };

    assert.throws(() => computePlanApprovalDigest(withPolicy(unknownTopLevel)));
    assert.throws(() => computePlanApprovalDigest(withPolicy(unknownBudgets)));
    assert.throws(() => computePlanApprovalDigest(withPolicy(unknownNestedPolicy)));
  });

  it("rejects an explicit undefined or null policy as malformed-present, not absent", () => {
    // Constructed as `unknown` deliberately: the production `PlanExecutionConfig`
    // type never allows `null` here, so this proves the runtime boundary refuses
    // it rather than weakening that type to accommodate the test.
    const explicitUndefined: PlanApprovalDigestInput = {
      ...POLICY_BASE,
      execution: { ...POLICY_BASE.execution, verificationExecutionPolicy: undefined } as unknown as PlanExecutionConfig,
    };
    const explicitNull: PlanApprovalDigestInput = {
      ...POLICY_BASE,
      execution: { ...POLICY_BASE.execution, verificationExecutionPolicy: null } as unknown as PlanExecutionConfig,
    };

    // Explicit `undefined` key presence still satisfies `"key" in object`, so it
    // must be rejected by the strict validator rather than treated as absence.
    assert.ok("verificationExecutionPolicy" in explicitUndefined.execution);
    assert.throws(() => computePlanApprovalDigest(explicitUndefined));
    assert.throws(() => computePlanApprovalDigest(explicitNull));
  });

  it("keeps every pre-existing digest case intact: BASE_DIGEST and the legacy baseline are unaffected", () => {
    assert.equal(computePlanContentDigest(BASE), BASE_DIGEST);
    assert.equal(computePlanApprovalDigest(POLICY_BASE), LEGACY_EXPECTED_DIGEST);
  });
});
