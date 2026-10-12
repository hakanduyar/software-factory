/**
 * D1: the direct provider-admission gate (src/supervision/directWorkerAdmission.ts)
 * plus its wiring through FactoryService.runWorker.
 *
 * Covers: missing/unapproved/mismatched-criteria/stale-specRevision/wrong-principal
 * ticket negatives (refused BEFORE worker.execute, zero RUNNING persisted),
 * an authorized exact ticket admitting and launching a mock worker exactly
 * once, and a changed-authority-between-phases negative caught by the Phase 2
 * revalidate handle immediately before the (simulated) ProcessRunner call.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  admitDirectWorkerRun,
  DirectAdmissionRefusedError,
  type DirectWorkerTicket,
} from "../src/supervision/directWorkerAdmission.js";
import { newFactory, seedWorkItem, toImplementing } from "./support/factoryFixtures.js";
import {
  makeRetainedAuthority,
  buildRuntime,
  TICKET,
  TICKET_REFERENCE,
  PRESTART_TICKET_REFERENCE,
} from "./support/directRuntimeFixture.js";

async function buildValidTicket(
  factory: ReturnType<typeof newFactory>["factory"],
  item: { id: string; specRevision: number },
  principalId: string,
): Promise<DirectWorkerTicket> {
  const criteria = await factory.listCriteria(item.id as never);
  return {
    ticketId: `tk-${item.id}`,
    workItemId: item.id as never,
    specRevision: item.specRevision,
    role: "IMPLEMENTER",
    principalId,
    criteriaIds: criteria.map((c) => c.id),
    dependencyWorkItemIds: [],
    budgets: { maxAttempts: 1, elapsedSeconds: 60 },
    approved: true,
  };
}

describe("directWorkerAdmission: module-level binding checks", () => {
  it("admits a matching, approved ticket and returns a stable digest", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    const criteria = await factory.listCriteria(item.id);
    const ticket = await buildValidTicket(factory, item, "wp-test-1");
    const binding = admitDirectWorkerRun(ticket, {
      item,
      role: "IMPLEMENTER",
      principal: { principalId: "wp-test-1", declaredId: "x", roles: ["IMPLEMENTER"], registeredAt: 0 as never, requiresDirectAdmission: true },
      criteria,
    });
    assert.ok(/^[0-9a-f]{64}$/.test(binding.ticketDigest));
  });

  it("refuses an unapproved ticket", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    const criteria = await factory.listCriteria(item.id);
    const ticket = { ...(await buildValidTicket(factory, item, "wp-test-1")), approved: false };
    assert.throws(
      () =>
        admitDirectWorkerRun(ticket, {
          item,
          role: "IMPLEMENTER",
          principal: { principalId: "wp-test-1", declaredId: "x", roles: ["IMPLEMENTER"], registeredAt: 0 as never, requiresDirectAdmission: true },
          criteria,
        }),
      DirectAdmissionRefusedError,
    );
  });

  it("refuses a ticket whose criteria no longer match the WorkItem's current criteria", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    const criteria = await factory.listCriteria(item.id);
    const ticket = { ...(await buildValidTicket(factory, item, "wp-test-1")), criteriaIds: ["forged-criterion"] };
    assert.throws(
      () =>
        admitDirectWorkerRun(ticket, {
          item,
          role: "IMPLEMENTER",
          principal: { principalId: "wp-test-1", declaredId: "x", roles: ["IMPLEMENTER"], registeredAt: 0 as never, requiresDirectAdmission: true },
          criteria,
        }),
      DirectAdmissionRefusedError,
    );
  });

  it("refuses a ticket bound to a different principal than the one executing", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    const criteria = await factory.listCriteria(item.id);
    const ticket = await buildValidTicket(factory, item, "wp-forged");
    assert.throws(
      () =>
        admitDirectWorkerRun(ticket, {
          item,
          role: "IMPLEMENTER",
          principal: { principalId: "wp-real", declaredId: "x", roles: ["IMPLEMENTER"], registeredAt: 0 as never, requiresDirectAdmission: true },
          criteria,
        }),
      DirectAdmissionRefusedError,
    );
  });

  it("revalidate() refuses when authority changed between Phase 1 and the ProcessRunner checkpoint", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    const criteria = await factory.listCriteria(item.id);
    const ticket = await buildValidTicket(factory, item, "wp-test-1");
    const principal = { principalId: "wp-test-1", declaredId: "x", roles: ["IMPLEMENTER"], registeredAt: 0 as never, requiresDirectAdmission: true } as const;
    const binding = admitDirectWorkerRun(ticket, { item, role: "IMPLEMENTER", principal, criteria });
    // Simulate authority changing (e.g. a concurrent spec revision) before spawn.
    assert.throws(
      () =>
        binding.revalidate({
          item: { id: item.id, specRevision: item.specRevision + 1 },
          role: "IMPLEMENTER",
          principal,
          criteria,
        }),
      DirectAdmissionRefusedError,
    );
    // Unchanged state still revalidates cleanly.
    assert.doesNotThrow(() => binding.revalidate({ item, role: "IMPLEMENTER", principal, criteria }));
  });
});

describe("FactoryService.runWorker: D1 direct admission wiring", () => {
  it("refuses a requiresDirectAdmission principal with no trusted ticketReference before worker.execute — zero spawn", async () => {
    const { authority } = makeRetainedAuthority();
    const { factory, processRunner, cliWorker } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    factory.registerWorker(cliWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });

    await assert.rejects(
      factory.runWorker({ workItemId: item.id, role: "IMPLEMENTER", worker: cliWorker, instructions: "do it" }),
    );
    assert.equal(processRunner.invocations.length, 0);
    assert.equal((await factory.listRuns(item.id)).length, 0);
  });

  it("admits a trusted reference/model/scope over the shared channel and launches the real CLI worker exactly once", async () => {
    const { authority, calls } = makeRetainedAuthority();
    const { factory, processRunner, cliWorker, registerApprovedPrestart } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const principal = factory.registerWorker(cliWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const criteria = await factory.listCriteria(item.id);
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });

    const { run } = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: cliWorker,
      instructions: "do it",
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });

    assert.equal(run.status, "SUCCEEDED");
    assert.equal(processRunner.invocations.length, 1);
    assert.equal(calls.atomicConsumeLaunch, 1);
  });

  it("registration with no options at all (absent flag) still requires admission for a nonmock worker", async () => {
    const { authority } = makeRetainedAuthority();
    const { factory, processRunner, cliWorker } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    factory.registerWorker(cliWorker, ["IMPLEMENTER"]);

    await assert.rejects(
      factory.runWorker({ workItemId: item.id, role: "IMPLEMENTER", worker: cliWorker, instructions: "do it" }),
    );
    assert.equal(processRunner.invocations.length, 0);
  });
});
