import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { human } from "../src/domain/actor.js";
import { buildImplementerInstructions, buildReviewerInstructions } from "../src/orchestration/loopPrompts.js";
import type { EngineeringLoop, LoopIterationRecord } from "../src/orchestration/loopTypes.js";

function fixtureLoop(overrides: Partial<EngineeringLoop> = {}): EngineeringLoop {
  return {
    id: "loop-test",
    workItemId: "wi-test",
    version: 1,
    phase: "IMPLEMENTING",
    budget: { maxIterations: 3 },
    implementer: { tool: "claude-code", model: "m" },
    reviewer: { tool: "codex-cli", model: "m" },
    verificationCommands: [{ id: "c", executable: "node", argv: ["-e", "1"] }],
    workspaceRoot: "/tmp/does-not-matter",
    taskInstructions: "Implement the widget exactly as specified.",
    iterations: [],
    totalRunCount: 0,
    cancelRequested: false,
    startedBy: human("user:test", "Test"),
    startedAt: 0,
    lastTransitionAt: 0,
    ...overrides,
  };
}

describe("buildImplementerInstructions", () => {
  it("is exactly the task instructions on the first attempt", () => {
    const loop = fixtureLoop();
    const text = buildImplementerInstructions(loop, 1, undefined);
    assert.equal(text, loop.taskInstructions);
  });

  it("includes remediation context (iteration count, verification failures, review findings) for a later attempt", () => {
    const loop = fixtureLoop();
    const previous: LoopIterationRecord = {
      iteration: 1,
      implementerRunId: "run-0001",
      implementerOutcome: "SUCCEEDED",
      verificationRunId: "run-0002",
      verificationPassed: false,
      verificationCommandResults: [{ commandId: "typecheck", passed: false, exitCode: 1, terminationReason: "EXITED", durationMs: 5, stdoutTruncated: false, stderrTruncated: false }],
    };
    const text = buildImplementerInstructions(loop, 2, previous);
    assert.match(text, /remediation attempt 2 of a maximum of 3/);
    assert.match(text, /typecheck: EXITED/);
    assert.ok(text.startsWith(loop.taskInstructions));
  });

  it("includes reviewer findings when the previous iteration was CHANGES_REQUIRED", () => {
    const loop = fixtureLoop();
    const previous: LoopIterationRecord = {
      iteration: 1,
      implementerRunId: "run-0001",
      implementerOutcome: "SUCCEEDED",
      verificationPassed: true,
      reviewVerdict: "CHANGES_REQUIRED",
      reviewFindings: ["missing null check", "no test for the error path"],
    };
    const text = buildImplementerInstructions(loop, 2, previous);
    assert.match(text, /missing null check/);
    assert.match(text, /no test for the error path/);
  });

  it("surfaces a parse-failure reason distinctly from ordinary findings", () => {
    const loop = fixtureLoop();
    const previous: LoopIterationRecord = {
      iteration: 1,
      implementerRunId: "run-0001",
      implementerOutcome: "SUCCEEDED",
      reviewParseError: "no FACTORY_REVIEW_VERDICT tag found in reviewer output",
    };
    const text = buildImplementerInstructions(loop, 2, previous);
    assert.match(text, /could not be parsed/);
    assert.match(text, /no FACTORY_REVIEW_VERDICT tag found/);
  });
});

describe("buildReviewerInstructions", () => {
  it("includes the strict verdict-tag contract and verification results", () => {
    const loop = fixtureLoop();
    const current: LoopIterationRecord = {
      iteration: 1,
      implementerRunId: "run-0001",
      implementerOutcome: "SUCCEEDED",
      verificationCommandResults: [
        { commandId: "typecheck", passed: true, exitCode: 0, terminationReason: "EXITED", durationMs: 5, stdoutTruncated: false, stderrTruncated: false },
        { commandId: "test", passed: false, exitCode: 1, terminationReason: "EXITED", durationMs: 5, stdoutTruncated: false, stderrTruncated: false },
      ],
    };
    const text = buildReviewerInstructions(loop, current);
    assert.match(text, /FACTORY_REVIEW_VERDICT: PASS/);
    assert.match(text, /FACTORY_REVIEW_VERDICT: PASS_WITH_NON_BLOCKING_NOTES/);
    assert.match(text, /FACTORY_REVIEW_VERDICT: CHANGES_REQUIRED/);
    assert.match(text, /typecheck: PASSED/);
    assert.match(text, /test: FAILED/);
    assert.match(text, /Do not modify, commit, or push/);
  });
});
