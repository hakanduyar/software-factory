/**
 * Deterministic plan validation (TASK-005 §8, acceptance criterion
 * **AC-6 — Deterministic validation**: "Cyclic dependency graphs,
 * self-dependencies, dangling dependency references, duplicate item keys,
 * missing specs and missing acceptance criteria are all rejected before
 * `PLAN_REVIEW`.").
 *
 * What this file proves, in two halves:
 *
 *  1. Nothing malformed can ever reach a human. A human approval is authority,
 *     and authority granted over a nonsense graph is still authority — so every
 *     structural defect must be caught here, before the revision is shown.
 *  2. The topological order is DETERMINISTIC. It is not a by-product: it is the
 *     materialization and dispatch order, so the same plan must produce the same
 *     sequence on any machine, before and after a restart, regardless of the
 *     order the planner happened to emit its items in.
 *
 * Proposals are built as plain `ParsedPlannerProposal` literals rather than
 * through the parser: this module's contract is about graph semantics, not text
 * parsing (`plannerOutputContract.test.ts` covers that boundary). Pure and
 * offline — no AI, no network, no filesystem, no timers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ParsedPlannerProposal } from "../src/planning/plannerOutputContract.js";
import { topologicalOrder, validateProposal, type PlanValidation } from "../src/planning/planValidation.js";
import type { PlannedWorkItem } from "../src/planning/planTypes.js";

type Criterion = { readonly text: string; readonly verificationHint: string };

function itemWith(
  key: string,
  fields: { spec?: string; acceptanceCriteria?: readonly Criterion[]; dependsOn?: readonly string[] },
): PlannedWorkItem {
  return {
    key,
    title: `Item ${key}`,
    type: "FEATURE",
    priority: "P2",
    spec: fields.spec ?? `Implement ${key}.`,
    acceptanceCriteria: fields.acceptanceCriteria ?? [{ text: `${key} behaves as specified`, verificationHint: "npm test" }],
    dependsOn: fields.dependsOn ?? [],
  };
}

function item(key: string, dependsOn: readonly string[] = []): PlannedWorkItem {
  return itemWith(key, { dependsOn });
}

function proposal(items: readonly PlannedWorkItem[], summary = "A coherent plan."): ParsedPlannerProposal {
  return { summary, assumptions: [], constraints: [], risks: [], blockingQuestions: [], items };
}

/** Fails the test if validation rejected; otherwise hands back the order. */
function expectOrder(result: PlanValidation): readonly string[] {
  if (!result.ok) {
    throw new Error(`expected validation to pass, but it was rejected: ${result.reason}`);
  }
  return result.order;
}

/** Fails the test if validation passed; otherwise hands back the reason. */
function expectReason(result: PlanValidation): string {
  if (result.ok) {
    throw new Error(`expected validation to fail, but it produced the order: ${result.order.join(", ")}`);
  }
  return result.reason;
}

/** The defining property of a topological order, checked structurally rather than by literal. */
function assertOrderRespectsDependencies(order: readonly string[], items: readonly PlannedWorkItem[]): void {
  assert.equal(order.length, items.length, "every item must appear exactly once in the order");
  for (const entry of items) {
    const position = order.indexOf(entry.key);
    assert.notEqual(position, -1, `${entry.key} is missing from the order`);
    for (const dependency of entry.dependsOn) {
      const dependencyPosition = order.indexOf(dependency);
      assert.ok(dependencyPosition !== -1, `${dependency} is missing from the order`);
      assert.ok(dependencyPosition < position, `${entry.key} must be ordered after its dependency ${dependency}`);
    }
  }
}

const DIAMOND: readonly PlannedWorkItem[] = [
  item("WI-A"),
  item("WI-B", ["WI-A"]),
  item("WI-C", ["WI-A"]),
  item("WI-D", ["WI-B", "WI-C"]),
];

describe("topologicalOrder", () => {
  it("orders a single item", () => {
    const order = expectOrder(topologicalOrder([item("WI-A")]));
    assert.deepEqual(order, ["WI-A"]);
  });

  it("orders a linear chain so each item follows its dependencies", () => {
    const items = [item("WI-A"), item("WI-B", ["WI-A"]), item("WI-C", ["WI-B"])];
    const order = expectOrder(topologicalOrder(items));
    assert.deepEqual(order, ["WI-A", "WI-B", "WI-C"]);
    assertOrderRespectsDependencies(order, items);
  });

  it("orders a diamond graph correctly", () => {
    const order = expectOrder(topologicalOrder(DIAMOND));
    assertOrderRespectsDependencies(order, DIAMOND);
    assert.equal(order[0], "WI-A");
    assert.equal(order.at(-1), "WI-D");
    assert.deepEqual(order, ["WI-A", "WI-B", "WI-C", "WI-D"]);
  });

  it("is deterministic: the same items in a different array order produce the same order", () => {
    const shuffled = [DIAMOND[3]!, DIAMOND[1]!, DIAMOND[2]!, DIAMOND[0]!];
    assert.deepEqual(expectOrder(topologicalOrder(shuffled)), expectOrder(topologicalOrder(DIAMOND)));
  });

  it("breaks ties between independent items by key, not by input position", () => {
    const items = [item("WI-C"), item("WI-A"), item("WI-B")];
    assert.deepEqual(expectOrder(topologicalOrder(items)), ["WI-A", "WI-B", "WI-C"]);
  });

  it("rejects a 2-cycle and names the involved keys", () => {
    const reason = expectReason(topologicalOrder([item("WI-A", ["WI-B"]), item("WI-B", ["WI-A"])]));
    assert.match(reason, /dependency graph contains a cycle involving/);
    assert.match(reason, /WI-A/);
    assert.match(reason, /WI-B/);
  });

  it("rejects a 3-cycle and names all three keys", () => {
    const reason = expectReason(
      topologicalOrder([item("WI-A", ["WI-C"]), item("WI-B", ["WI-A"]), item("WI-C", ["WI-B"])]),
    );
    assert.match(reason, /cycle/);
    assert.ok(reason.includes("WI-A, WI-B, WI-C"), `reason should name every stuck key, got: ${reason}`);
  });

  it("names only the items actually caught in the cycle", () => {
    const reason = expectReason(topologicalOrder([item("WI-A"), item("WI-B", ["WI-C"]), item("WI-C", ["WI-B"])]));
    assert.match(reason, /cycle/);
    assert.ok(reason.includes("WI-B, WI-C"), `reason should name the cyclic keys, got: ${reason}`);
    assert.ok(!reason.includes("WI-A"), `the acyclic item must not be blamed, got: ${reason}`);
  });
});

describe("validateProposal: accepted plans", () => {
  it("validates a single-item proposal and returns an order of length 1", () => {
    const order = expectOrder(validateProposal(proposal([item("WI-A")])));
    assert.equal(order.length, 1);
    assert.deepEqual(order, ["WI-A"]);
  });

  it("validates a linear chain A -> B -> C", () => {
    const items = [item("WI-A"), item("WI-B", ["WI-A"]), item("WI-C", ["WI-B"])];
    const order = expectOrder(validateProposal(proposal(items)));
    assertOrderRespectsDependencies(order, items);
    assert.deepEqual(order, ["WI-A", "WI-B", "WI-C"]);
  });

  it("validates a diamond graph and orders it deterministically", () => {
    const order = expectOrder(validateProposal(proposal(DIAMOND)));
    assertOrderRespectsDependencies(order, DIAMOND);
    const shuffled = [DIAMOND[2]!, DIAMOND[0]!, DIAMOND[3]!, DIAMOND[1]!];
    assert.deepEqual(expectOrder(validateProposal(proposal(shuffled))), order);
  });

  it("accepts a dependency declared before the item it points at appears in the array", () => {
    const items = [item("WI-B", ["WI-A"]), item("WI-A")];
    assert.deepEqual(expectOrder(validateProposal(proposal(items))), ["WI-A", "WI-B"]);
  });
});

describe("validateProposal: rejected plans", () => {
  it("rejects a cyclic graph", () => {
    const reason = expectReason(validateProposal(proposal([item("WI-A", ["WI-B"]), item("WI-B", ["WI-A"])])));
    assert.match(reason, /dependency graph contains a cycle involving/);
    assert.ok(reason.includes("WI-A, WI-B"), `reason should name the cyclic keys, got: ${reason}`);
  });

  it("rejects a self-dependency", () => {
    const reason = expectReason(validateProposal(proposal([item("WI-A", ["WI-A"])])));
    assert.match(reason, /work item "WI-A" depends on itself/);
  });

  it("rejects a dependency on a key that is not part of the plan", () => {
    const reason = expectReason(validateProposal(proposal([item("WI-A"), item("WI-B", ["WI-Z"])])));
    assert.match(reason, /work item "WI-B" depends on "WI-Z", which is not part of this plan/);
  });

  it("rejects a duplicate dependency inside one item", () => {
    const reason = expectReason(validateProposal(proposal([item("WI-A"), item("WI-B", ["WI-A", "WI-A"])])));
    assert.match(reason, /work item "WI-B" declares duplicate dependency "WI-A"/);
  });

  it("rejects duplicate item keys", () => {
    const reason = expectReason(validateProposal(proposal([item("WI-A"), item("WI-A")])));
    assert.match(reason, /duplicate work item key "WI-A"/);
  });

  it("rejects an empty or whitespace-only spec", () => {
    assert.match(expectReason(validateProposal(proposal([itemWith("WI-A", { spec: "" })]))), /work item "WI-A" has an empty spec/);
    assert.match(
      expectReason(validateProposal(proposal([itemWith("WI-A", { spec: "  \t \n " })]))),
      /work item "WI-A" has an empty spec/,
    );
  });

  it("rejects an item with zero acceptance criteria", () => {
    const reason = expectReason(validateProposal(proposal([itemWith("WI-A", { acceptanceCriteria: [] })])));
    assert.match(reason, /work item "WI-A" has no acceptance criteria/);
    assert.match(reason, /nothing to verify means it can never be honestly DONE \(C2\/C3\)/);
  });

  it("rejects an acceptance criterion with empty text", () => {
    const reason = expectReason(
      validateProposal(proposal([itemWith("WI-A", { acceptanceCriteria: [{ text: "   ", verificationHint: "npm test" }] })])),
    );
    assert.match(reason, /work item "WI-A" has an acceptance criterion with empty text or verification hint/);
  });

  it("rejects an acceptance criterion with an empty verification hint", () => {
    const reason = expectReason(
      validateProposal(proposal([itemWith("WI-A", { acceptanceCriteria: [{ text: "it works", verificationHint: "" }] })])),
    );
    assert.match(reason, /work item "WI-A" has an acceptance criterion with empty text or verification hint/);
  });

  it("rejects an empty or whitespace-only summary", () => {
    assert.match(expectReason(validateProposal(proposal([item("WI-A")], ""))), /plan summary is empty/);
    assert.match(expectReason(validateProposal(proposal([item("WI-A")], "   \t "))), /plan summary is empty/);
  });

  it("rejects a proposal with zero items", () => {
    const reason = expectReason(validateProposal(proposal([])));
    assert.match(reason, /an approvable plan must contain at least one work item/);
  });
});
