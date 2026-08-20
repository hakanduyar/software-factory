import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWorkerPrompt, type PromptContext } from "../src/adapters/workers/promptTemplates.js";
import type { AcceptanceCriterion } from "../src/domain/acceptanceCriterion.js";
import { FACTORY_ROLES } from "../src/domain/role.js";

function context(overrides: Partial<PromptContext> = {}): PromptContext {
  const criteria: AcceptanceCriterion[] = [
    { id: "ac-1", workItemId: "wi-1", text: "Behaviour holds", verificationHint: "npm test" },
  ];
  return {
    workItemTitle: "Example work item",
    instructions: "SECRET_INSTRUCTION_MARKER do the thing",
    workspaceRoot: "/workspace/root",
    acceptanceCriteria: criteria,
    ...overrides,
  };
}

describe("buildWorkerPrompt", () => {
  it("has a template for every FactoryRole", () => {
    for (const role of FACTORY_ROLES) {
      const prompt = buildWorkerPrompt(role, context());
      assert.ok(prompt.length > 0);
    }
  });

  it("always includes the workspace, the instructions, and the acceptance criteria", () => {
    const prompt = buildWorkerPrompt("IMPLEMENTER", context());
    assert.match(prompt, /\/workspace\/root/);
    assert.match(prompt, /SECRET_INSTRUCTION_MARKER/);
    assert.match(prompt, /Behaviour holds/);
    assert.match(prompt, /npm test/);
  });

  it("prohibits commit/push by default", () => {
    const prompt = buildWorkerPrompt("IMPLEMENTER", context());
    assert.match(prompt, /Do not commit, push, merge, tag a release, or publish/);
  });

  it("allows local commits only when allowCommit is explicitly true, still prohibiting push/release", () => {
    const prompt = buildWorkerPrompt("IMPLEMENTER", context({ allowCommit: true }));
    assert.match(prompt, /You may create local commits/);
    assert.match(prompt, /Do not push, merge, tag a release, or publish/);
  });

  it("distinguishes IMPLEMENTER from REVIEWER instructions", () => {
    const implementer = buildWorkerPrompt("IMPLEMENTER", context());
    const reviewer = buildWorkerPrompt("REVIEWER", context());
    assert.match(implementer, /IMPLEMENTATION ENGINEER/);
    assert.match(reviewer, /independent REVIEWER/);
    assert.match(reviewer, /do not rewrite the implementation/);
    assert.notEqual(implementer, reviewer);
  });

  it("reports plainly when no acceptance criteria were supplied", () => {
    const prompt = buildWorkerPrompt("VERIFIER", context({ acceptanceCriteria: [] }));
    assert.match(prompt, /No acceptance criteria were supplied/);
  });
});
