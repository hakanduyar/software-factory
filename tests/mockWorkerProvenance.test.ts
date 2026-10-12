import test from "node:test";
import assert from "node:assert/strict";
import { createMockWorker, isTrustedMockWorker } from "../src/adapters/workers/mockWorker.js";
import { FACTORY_ROLES } from "../src/domain/role.js";
import type { WorkerRequest } from "../src/ports/worker.js";

const role = FACTORY_ROLES[0];

function makeRequest(): WorkerRequest {
  return {
    runId: "run-1" as any,
    workItemId: "item-1" as any,
    role,
    title: "Title",
    instructions: "Do it",
    acceptanceCriteria: [],
  };
}

test("isTrustedMockWorker rejects non-worker values", () => {
  assert.equal(isTrustedMockWorker(null), false);
  assert.equal(isTrustedMockWorker(undefined), false);
  assert.equal(isTrustedMockWorker(42), false);
  assert.equal(isTrustedMockWorker("mock-worker"), false);
  assert.equal(isTrustedMockWorker(true), false);
});

test("genuine createMockWorker output is trusted", () => {
  const worker = createMockWorker();
  assert.equal(isTrustedMockWorker(worker), true);
});

test("handcrafted deterministic worker is not trusted", () => {
  const fake = {
    id: "mock-worker",
    capabilities: { roles: FACTORY_ROLES, deterministic: true },
    async execute() {
      return { status: "SUCCEEDED", summary: "", evidence: [], claimsAcceptanceMet: true };
    },
  };
  assert.equal(isTrustedMockWorker(fake), false);
});

test("clone with same id is not trusted", () => {
  const worker = createMockWorker({ id: "same-id" });
  const clone = { ...worker };
  assert.equal(isTrustedMockWorker(clone), false);
});

test("Object.create based copy is not trusted", () => {
  const worker = createMockWorker();
  const copy = Object.create(worker);
  assert.equal(isTrustedMockWorker(copy), false);
});

test("Proxy wrapping a trusted worker is not trusted", () => {
  const worker = createMockWorker();
  const proxied = new Proxy(worker, {});
  assert.equal(isTrustedMockWorker(proxied), false);
});

test("worker object and capabilities are frozen, roles copy is frozen and independent", () => {
  const roles = [...FACTORY_ROLES];
  const worker = createMockWorker({ roles });
  assert.equal(Object.isFrozen(worker), true);
  assert.equal(Object.isFrozen(worker.capabilities), true);
  assert.equal(Object.isFrozen(worker.capabilities.roles), true);

  roles.push(role);
  assert.notDeepEqual(worker.capabilities.roles, roles);

  const mutated = Reflect.set(worker, "id", "other");
  assert.equal(mutated, false);
});

test("execute reports success with evidence", async () => {
  const worker = createMockWorker();
  const outcome = await worker.execute(makeRequest());
  assert.equal(outcome.status, "SUCCEEDED");
  assert.equal(outcome.claimsAcceptanceMet, true);
});

test("execute can simulate failure and throwing", async () => {
  const failing = createMockWorker({ outcomeStatus: "FAILED" });
  const failOutcome = await failing.execute(makeRequest());
  assert.equal(failOutcome.status, "FAILED");
  assert.equal(failOutcome.claimsAcceptanceMet, false);

  const throwing = createMockWorker({ throws: new Error("boom") });
  await assert.rejects(() => throwing.execute(makeRequest()), /boom/);
});