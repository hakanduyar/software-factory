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
import { computePlanContentDigest, digestOfRevision, type PlanDigestInput } from "../src/planning/planDigest.js";
import type { PlannedWorkItem, PlanRevision } from "../src/planning/planTypes.js";

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
