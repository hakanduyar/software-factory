import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateStrictFrozenTicket,
  DirectAdmissionRefusedError,
} from "../src/supervision/directWorkerAdmission.js";
import { computeTicketDigest, parseWorkerTicket } from "../src/supervision/workerContract.js";

function completeTicket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    ticketId: "t-1",
    objective: "Implement a strict frozen validation helper now",
    acceptanceCriteria: [
      { id: "ac-1", version: "1.0.0", description: "Does the thing correctly" },
    ],
    scope: {
      owned: ["src/a.ts"],
      forbidden: [],
      read: [],
      dependencies: [],
      validation: ["npm test"],
    },
    model: {
      eligibleModels: ["model-a"],
      reasoningEffort: "low",
      rationale: "simple deterministic task",
    },
    budgets: { contextTokens: 1000, outputTokens: 500, elapsedSeconds: 60, maxAttempts: 1 },
    policy: { checkpoint: "checkpoint", stopConditions: ["done"], escalation: "escalate to human" },
    resultSchema: { requiredFields: ["schemaVersion", "ticketId"], maxResultBytes: 2048 },
    ...overrides,
  };
}

test("accepts strict complete ticket matching existing digest", () => {
  const candidate = completeTicket();
  const parsed = parseWorkerTicket(candidate);
  assert.equal(parsed.ok, true);
  const digest = computeTicketDigest((parsed as { ok: true; value: unknown }).value as never);
  const result = validateStrictFrozenTicket(candidate, digest);
  assert.equal(result.digest, digest);
  assert.equal(result.ticket.ticketId, "t-1");
});

test("rejects partial legacy DirectWorkerTicket shape", () => {
  const legacy = { ticketId: "t-1", workItemId: "w-1", approved: true };
  assert.throws(() => validateStrictFrozenTicket(legacy, "deadbeef"), DirectAdmissionRefusedError);
});

test("rejects malformed complete ticket (bad budgets)", () => {
  const bad = completeTicket({ budgets: { contextTokens: -1, outputTokens: 1, elapsedSeconds: 1, maxAttempts: 1 } });
  assert.throws(() => validateStrictFrozenTicket(bad, "deadbeef"), DirectAdmissionRefusedError);
});

test("rejects malformed complete ticket (bad model)", () => {
  const bad = completeTicket({ model: { eligibleModels: [], reasoningEffort: "low", rationale: "simple deterministic task" } });
  assert.throws(() => validateStrictFrozenTicket(bad, "deadbeef"), DirectAdmissionRefusedError);
});

test("rejects malformed complete ticket (bad acceptanceCriteria)", () => {
  const bad = completeTicket({ acceptanceCriteria: [{ id: "ac-1", version: "not-semver", description: "Does the thing correctly" }] });
  assert.throws(() => validateStrictFrozenTicket(bad, "deadbeef"), DirectAdmissionRefusedError);
});

test("rejects malformed complete ticket (bad scope)", () => {
  const bad = completeTicket({ scope: { owned: [], forbidden: [], read: [], dependencies: [], validation: ["npm test"] } });
  assert.throws(() => validateStrictFrozenTicket(bad, "deadbeef"), DirectAdmissionRefusedError);
});

test("rejects valid ticket with mismatched trusted digest", () => {
  const candidate = completeTicket();
  assert.throws(
    () => validateStrictFrozenTicket(candidate, "0".repeat(64)),
    DirectAdmissionRefusedError,
  );
});

test("changed criteria version/content/dependency/scope/budget no longer matches approved digest", () => {
  const base = completeTicket();
  const parsedBase = parseWorkerTicket(base);
  assert.equal(parsedBase.ok, true);
  const baseDigest = computeTicketDigest((parsedBase as { ok: true; value: unknown }).value as never);

  const changedVersion = completeTicket({
    acceptanceCriteria: [{ id: "ac-1", version: "1.0.1", description: "Does the thing correctly" }],
  });
  assert.throws(() => validateStrictFrozenTicket(changedVersion, baseDigest), DirectAdmissionRefusedError);

  const changedOwned = completeTicket({
    scope: { owned: ["src/b.ts"], forbidden: [], read: [], dependencies: [], validation: ["npm test"] },
  });
  assert.throws(() => validateStrictFrozenTicket(changedOwned, baseDigest), DirectAdmissionRefusedError);

  const changedBudget = completeTicket({
    budgets: { contextTokens: 1000, outputTokens: 500, elapsedSeconds: 61, maxAttempts: 1 },
  });
  assert.throws(() => validateStrictFrozenTicket(changedBudget, baseDigest), DirectAdmissionRefusedError);

  const changedDescription = completeTicket({
    acceptanceCriteria: [{ id: "ac-1", version: "1.0.0", description: "Does the thing differently now" }],
  });
  assert.throws(() => validateStrictFrozenTicket(changedDescription, baseDigest), DirectAdmissionRefusedError);

  const changedDependencies = completeTicket({
    scope: { owned: ["src/a.ts"], forbidden: [], read: [], dependencies: ["src/dep.ts"], validation: ["npm test"] },
  });
  assert.throws(() => validateStrictFrozenTicket(changedDependencies, baseDigest), DirectAdmissionRefusedError);
});

test("source-input mutation cannot mutate accepted returned snapshot", () => {
  const candidate = completeTicket();
  const parsed = parseWorkerTicket(candidate);
  assert.equal(parsed.ok, true);
  const digest = computeTicketDigest((parsed as { ok: true; value: unknown }).value as never);
  const result = validateStrictFrozenTicket(candidate, digest);
  (candidate.scope as { owned: string[] }).owned.push("src/injected.ts");
  assert.deepEqual(result.ticket.scope.owned, ["src/a.ts"]);
  assert.throws(() => {
    (result.ticket.scope.owned as unknown as string[]).push("x");
  });
});
