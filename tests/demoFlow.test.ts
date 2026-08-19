/**
 * The demo CLI flow, run headlessly (acceptance criteria 4 and 5). It walks
 * the full lifecycle including a superseded implementation, so it doubles as
 * an end-to-end regression check for every bypass the three review rounds
 * found.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runDemo } from "../src/cli/demo.js";

describe("demo flow", () => {
  it("advances a mock work item through a valid workflow to DONE", async () => {
    const result = await runDemo();

    assert.equal(result.finalStatus, "DONE");
    assert.deepEqual(
      [...result.statusPath],
      [
        "IDEA",
        "ANALYSIS",
        "BLOCKED",
        "ANALYSIS",
        "PLAN_REVIEW",
        "READY",
        "IMPLEMENTING",
        "VERIFYING",
        "REVIEW",
        "WAITING_FOR_HUMAN",
        // A new implementation arrived after approval, so the item had to go
        // back and re-earn every proof before it could be released.
        "IMPLEMENTING",
        "VERIFYING",
        "REVIEW",
        "WAITING_FOR_HUMAN",
        "DONE",
      ],
    );
    assert.equal(result.runCount, 7);
    assert.ok(result.evidenceCount > 0);
  });

  it("refuses every bypass attempt with the expected typed error, in order", async () => {
    const result = await runDemo();

    assert.deepEqual(
      result.refusals.map((refusal) => refusal.code),
      [
        "VALIDATION", // PLAN_APPROVAL pre-recorded at IDEA
        "HUMAN_IDENTITY", // cancellation by an untrusted { kind: HUMAN }
        "INVALID_TRANSITION", // BLOCKED -> READY bypassing PLAN_REVIEW
        "APPROVAL_REQUIRED", // PLAN_REVIEW -> READY with no plan approval
        "PRECONDITION_NOT_MET", // IMPLEMENTING -> VERIFYING with no implementation run
        "INVALID_TRANSITION", // IMPLEMENTING -> DONE
        "PRECONDITION_NOT_MET", // VERIFYING -> REVIEW with no deterministic verification
        "REVIEW_INTEGRITY", // implementer principal reviewing its own run under a new name
        "VALIDATION", // RELEASE_APPROVAL pre-recorded before WAITING_FOR_HUMAN
        "PRECONDITION_NOT_MET", // DONE before acceptance criteria are verified
        "APPROVAL_REQUIRED", // DONE with a complete snapshot but no release approval
        "APPROVAL_INTEGRITY", // an agent approving its own release
        "HUMAN_IDENTITY", // a forged HUMAN token
        "RUN_LIFECYCLE", // rewriting a terminal run
        "PRECONDITION_NOT_MET", // DONE using superseded implementation artifacts
      ],
    );
    assert.equal(result.refusals.length, 15);
  });

  it("is deterministic across runs", async () => {
    const first = await runDemo();
    const second = await runDemo();
    assert.deepEqual([...first.transcript], [...second.transcript]);
  });
});
