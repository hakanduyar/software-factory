/**
 * D1-85 isolated runtime proof: a REAL FactoryService + real local worker
 * registry + real createCliWorker adapter + a fake ProcessRunner, wired
 * through the SAME trusted host-constructed DirectHostAdmissionSurface via
 * FactoryServiceDeps.createDirectAdmissionChannel and
 * FactoryService.sharedDirectAdmissionChannel. The authority below is a
 * test-owned retained fixture only; no production D3 supplier is invented.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FactoryService } from "../src/app/factoryService.js";
import { createInMemoryStore } from "../src/adapters/memory/inMemoryStore.js";
import { createLocalHumanIdentityGate } from "../src/adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../src/adapters/security/localWorkerRegistry.js";
import { createMockWorker } from "../src/adapters/workers/mockWorker.js";
import { createCliWorker } from "../src/adapters/workers/cliWorker.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import { createFixedClock } from "../src/ports/clock.js";
import { createDirectHostAdmissionChannel } from "../src/supervision/directWorkerAdmission.js";
import {
  HUMAN,
  TEST_CREDENTIAL,
  FIXTURE_START,
  seedWorkItem,
  toImplementing,
} from "./support/factoryFixtures.js";
import {
  makeRetainedAuthority,
  makeFakeProcessRunner,
  buildRuntime,
  TICKET,
  TICKET_REFERENCE,
  PRESTART_TICKET_REFERENCE,
} from "./support/directRuntimeFixture.js";

describe("D1-85 isolated runtime: real Factory + registry + createCliWorker + fake ProcessRunner", () => {
  it("positive baseline: trusted channel admits, CLI consumes exactly once, fake runner spawns exactly once", async () => {
    const { authority, calls } = makeRetainedAuthority();
    const { factory, store, processRunner, cliWorker, registerApprovedPrestart } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const principal = factory.registerWorker(cliWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const criteria = await store.criteria.listByWorkItem(item.id);
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
      instructions: "implement",
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });

    assert.equal(run.status, "SUCCEEDED");
    assert.equal(processRunner.invocations.length, 1);
    assert.equal(calls.atomicConsumeLaunch, 1);
    assert.equal(calls.resolveAndReserve, 1);
  });
});

describe("D1-85 runtime: mandatory admission regardless of registration flag", () => {
  it("missing channel (no createDirectAdmissionChannel hook) refuses a nonmock worker before spawn", async () => {
    const clock = createFixedClock(FIXTURE_START);
    const factory = new FactoryService({
      store: createInMemoryStore(),
      clock,
      ids: createSequentialIdGenerator(),
      identityGate: createLocalHumanIdentityGate({ credential: TEST_CREDENTIAL, clock }),
      workerRegistry: createLocalWorkerRegistry(clock),
    });
    assert.equal(factory.sharedDirectAdmissionChannel, undefined);
    const processRunner = makeFakeProcessRunner();
    const cliWorker = createCliWorker({
      id: "cli-no-channel",
      tool: "claude-code",
      roles: ["IMPLEMENTER"],
      executable: "fake-cli",
      model: "model-a",
      timeoutMs: 1000,
      workspace: { root: "/tmp/ws", repositoryRoot: "/tmp/ws" },
      processRunner,
      environmentPolicy: { allowedVars: [] },
      buildInvocation: () => ({ argv: ["--run"], effortApplication: { applied: false } }),
      interpretOutput: () => ({}),
    });
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    factory.registerWorker(cliWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });

    await assert.rejects(
      factory.runWorker({
        workItemId: item.id,
        role: "IMPLEMENTER",
        worker: cliWorker,
        instructions: "implement",
        directTicketReference: TICKET_REFERENCE,
        expectedModel: TICKET.model,
        expectedScope: TICKET.scope,
      }),
    );
    assert.equal(processRunner.invocations.length, 0);
  });

  it("missing trusted ticketReference refuses before spawn even though a channel exists", async () => {
    const { authority } = makeRetainedAuthority();
    const { factory, processRunner, cliWorker } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    factory.registerWorker(cliWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });

    await assert.rejects(
      factory.runWorker({
        workItemId: item.id,
        role: "IMPLEMENTER",
        worker: cliWorker,
        instructions: "implement",
      }),
    );
    assert.equal(processRunner.invocations.length, 0);
  });

  it("registration with requiresDirectAdmission explicitly false still requires admission for a nonmock worker", async () => {
    const { authority } = makeRetainedAuthority();
    const { factory, processRunner, cliWorker } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    // Explicit false is overridden by the identity-backed A80 predicate: this
    // is a real (nonmock) worker object, so registry still marks it required.
    factory.registerWorker(cliWorker, ["IMPLEMENTER"], { requiresDirectAdmission: false });

    await assert.rejects(
      factory.runWorker({
        workItemId: item.id,
        role: "IMPLEMENTER",
        worker: cliWorker,
        instructions: "implement",
      }),
    );
    assert.equal(processRunner.invocations.length, 0);
  });

  it("registration with no options at all (absent flag) still requires admission for a nonmock worker", async () => {
    const { authority } = makeRetainedAuthority();
    const { factory, processRunner, cliWorker } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    factory.registerWorker(cliWorker, ["IMPLEMENTER"]);

    await assert.rejects(
      factory.runWorker({ workItemId: item.id, role: "IMPLEMENTER", worker: cliWorker, instructions: "implement" }),
    );
    assert.equal(processRunner.invocations.length, 0);
  });

  it("A80 mock identity positive path is unchanged: a createMockWorker-trusted worker runs with no ticket/channel at all", async () => {
    const clock = createFixedClock(FIXTURE_START);
    const factory = new FactoryService({
      store: createInMemoryStore(),
      clock,
      ids: createSequentialIdGenerator(),
      identityGate: createLocalHumanIdentityGate({ credential: TEST_CREDENTIAL, clock }),
      workerRegistry: createLocalWorkerRegistry(clock),
    });
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const mock = createMockWorker({ id: "mock-rt", roles: ["IMPLEMENTER"] });
    factory.registerWorker(mock, ["IMPLEMENTER"]);

    const { run } = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: mock,
      instructions: "implement",
    });
    assert.equal(run.status, "SUCCEEDED");
  });

  it("D1-93: a configured, valid admission channel with NO approved-prestart authority still refuses a nonmock worker before spawn", async () => {
    const { authority } = makeRetainedAuthority();
    const clock = createFixedClock(FIXTURE_START);
    const store = createInMemoryStore();
    const factory = new FactoryService({
      store,
      clock,
      ids: createSequentialIdGenerator(),
      identityGate: createLocalHumanIdentityGate({ credential: TEST_CREDENTIAL, clock }),
      workerRegistry: createLocalWorkerRegistry(clock),
      createDirectAdmissionChannel: (readCurrentRequest) =>
        createDirectHostAdmissionChannel(authority, readCurrentRequest),
      // Deliberately no approvedPrestartPort: a genuinely configured, valid
      // channel exists, but the independent prestart authority does not.
    });
    const sharedChannel = factory.sharedDirectAdmissionChannel;
    assert.ok(sharedChannel !== undefined, "the channel itself must be genuinely configured");
    const processRunner = makeFakeProcessRunner();
    const cliWorker = createCliWorker({
      id: "cli-no-prestart-authority",
      tool: "claude-code",
      roles: ["IMPLEMENTER"],
      executable: "fake-cli",
      model: "model-a",
      timeoutMs: 1000,
      workspace: { root: "/tmp/ws", repositoryRoot: "/tmp/ws" },
      processRunner,
      environmentPolicy: { allowedVars: [] },
      buildInvocation: () => ({ argv: ["--run"], effortApplication: { applied: false } }),
      interpretOutput: () => ({}),
      directAdmissionChannel: sharedChannel,
    });
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    factory.registerWorker(cliWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });

    await assert.rejects(
      factory.runWorker({
        workItemId: item.id,
        role: "IMPLEMENTER",
        worker: cliWorker,
        instructions: "implement",
        directTicketReference: TICKET_REFERENCE,
        expectedModel: TICKET.model,
        expectedScope: TICKET.scope,
        expectedBudgets: TICKET.budgets,
      }),
    );
    assert.equal(processRunner.invocations.length, 0);
    assert.equal((await factory.listRuns(item.id)).length, 0);
  });

  it("D1-93: a configured channel and prestart authority but an UNKNOWN reference (no retained record at all) refuses before spawn", async () => {
    const { authority } = makeRetainedAuthority();
    const { factory, processRunner, cliWorker } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    factory.registerWorker(cliWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    // No registerApprovedPrestart call at all: TICKET_REFERENCE/
    // PRESTART_TICKET_REFERENCE is entirely unknown to this authority's
    // retained store, distinct from a malformed-but-present record.

    await assert.rejects(
      factory.runWorker({
        workItemId: item.id,
        role: "IMPLEMENTER",
        worker: cliWorker,
        instructions: "implement",
        directTicketReference: TICKET_REFERENCE,
        expectedModel: TICKET.model,
        expectedScope: TICKET.scope,
        expectedBudgets: TICKET.budgets,
      }),
    );
    assert.equal(processRunner.invocations.length, 0);
    assert.equal((await factory.listRuns(item.id)).length, 0);
  });

  it("D1-93: a genuinely requested expectedBudgets omitted (actual request, not the registered approval) refuses before spawn even with a valid approval registered", async () => {
    const { authority } = makeRetainedAuthority();
    const { factory, store, registerApprovedPrestart } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const sharedChannel = factory.sharedDirectAdmissionChannel;
    assert.ok(sharedChannel !== undefined, "the channel itself must be genuinely configured");
    const cliWorker = createCliWorker({
      id: "cli-omitted-expectation",
      tool: "claude-code",
      roles: ["IMPLEMENTER"],
      executable: "fake-cli",
      model: "model-a",
      timeoutMs: 1000,
      workspace: { root: "/tmp/ws", repositoryRoot: "/tmp/ws" },
      processRunner: makeFakeProcessRunner(),
      environmentPolicy: { allowedVars: [] },
      buildInvocation: () => ({ argv: ["--run"], effortApplication: { applied: false } }),
      interpretOutput: () => ({}),
      directAdmissionChannel: sharedChannel,
    });
    const principal = factory.registerWorker(cliWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const criteria = await store.criteria.listByWorkItem(item.id);
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });

    await assert.rejects(
      factory.runWorker({
        workItemId: item.id,
        role: "IMPLEMENTER",
        worker: cliWorker,
        instructions: "implement",
        directTicketReference: TICKET_REFERENCE,
        expectedModel: TICKET.model,
        expectedScope: TICKET.scope,
        // expectedBudgets deliberately omitted: a genuine current request
        // missing a mandatory expectation must refuse even though a valid
        // approval is independently retained for this exact reference.
      }),
    );
  });
});

describe("D1-85 runtime: forged/plain/foreign/retired/legacy handle yields zero spawn", () => {
  it("a worker that ignores the issued handle and fabricates a plain object is refused by the CLI's own channel consume", async () => {
    const { authority } = makeRetainedAuthority();
    const { factory, store, processRunner, registerApprovedPrestart } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const forgingWorker = {
      id: "cli-forging",
      capabilities: { roles: ["IMPLEMENTER"] as const, deterministic: false },
      async execute() {
        // Directly call the channel the CLI would use, with a forged handle,
        // to prove the channel itself (not just createCliWorker's own guard)
        // refuses — zero spawn either way.
        await assert.rejects(factory.sharedDirectAdmissionChannel!.consume({}));
        return { status: "SUCCEEDED" as const, summary: "forged", evidence: [], claimsAcceptanceMet: false };
      },
    };
    const principal = factory.registerWorker(forgingWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const criteria = await store.criteria.listByWorkItem(item.id);
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
      worker: forgingWorker,
      instructions: "implement",
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });
    // The worker itself never consumed the real handle it was given, so the
    // real admission is retired uncommitted; the run still completes because
    // the mock-style worker above reported SUCCEEDED on its own terms, but no
    // real process ever spawned via the fake runner.
    assert.equal(run.status, "SUCCEEDED");
    assert.equal(processRunner.invocations.length, 0);
  });

  it("a foreign channel's handle (issued by a second channel/authority) is refused by this Factory's channel", async () => {
    const { authority: authorityA } = makeRetainedAuthority();
    const { authority: authorityB } = makeRetainedAuthority();
    const channelB = createDirectHostAdmissionChannel(authorityB, async (_b, r) => r);
    const foreignHandle = await channelB.issue({
      ticketReference: TICKET_REFERENCE,
      registryPrincipalId: "foreign-principal",
      workItemId: "wi-foreign" as never,
      specRevision: 1,
      runId: "run-foreign" as never,
      role: "IMPLEMENTER",
      acceptanceCriteria: [],
      dependencyWorkItemIds: [],
      scope: TICKET.scope,
      model: TICKET.model,
    });

    const { factory, store, processRunner, registerApprovedPrestart } = buildRuntime(authorityA);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const foreignHandleWorker = {
      id: "cli-foreign-handle",
      capabilities: { roles: ["IMPLEMENTER"] as const, deterministic: false },
      async execute() {
        await assert.rejects(factory.sharedDirectAdmissionChannel!.consume(foreignHandle));
        return { status: "SUCCEEDED" as const, summary: "foreign", evidence: [], claimsAcceptanceMet: false };
      },
    };
    const principal = factory.registerWorker(foreignHandleWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const criteria = await store.criteria.listByWorkItem(item.id);
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });

    await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: foreignHandleWorker,
      instructions: "implement",
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });
    assert.equal(processRunner.invocations.length, 0);
  });

  it("a retired (already-consumed) binding yields zero further launches on direct replay against the retained authority", async () => {
    const { authority, calls, reservations } = makeRetainedAuthority();
    const { factory, store, processRunner, cliWorker, registerApprovedPrestart } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const principal = factory.registerWorker(cliWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const criteria = await store.criteria.listByWorkItem(item.id);
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });

    await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: cliWorker,
      instructions: "implement",
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });
    assert.equal(processRunner.invocations.length, 1);
    assert.equal(calls.atomicConsumeLaunch, 1);

    // The exact binding this run consumed is now retained as "consumed" in
    // the authority's own durable map (opaque handles cannot be replayed
    // directly by test code, by design — this proves the UNDERLYING
    // at-most-once invariant the channel depends on: a replay of the
    // identical reservation tuple is refused, never re-launched).
    const [reservationId, entry] = [...reservations.entries()][0]!;
    assert.equal(entry.state, "consumed");
    await assert.rejects(authority.atomicConsumeLaunch(entry.binding));
    assert.equal(calls.atomicConsumeLaunch, 2);
    assert.equal(reservations.get(reservationId)!.state, "consumed");
  });
});

describe("D1-85 runtime: trusted current-reader refuses on live-state drift; owned FAILED settlement", () => {
  it("a dependency that is not ready at admission time refuses before spawn and finalizes the owned run as FAILED", async () => {
    const { authority, calls } = makeRetainedAuthority();
    const { factory, store, processRunner, cliWorker, registerApprovedPrestart } = buildRuntime(authority);
    const dependency = await seedWorkItem(factory);
    const item = await seedWorkItem(factory);
    const current = await factory.getWorkItem(item.id);
    await store.workItems.compareAndSave({ ...current, dependencies: [dependency.id] }, current.version);
    await toImplementing(factory, item.id);
    const principal = factory.registerWorker(cliWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const refreshed = await factory.getWorkItem(item.id);
    const criteria = await store.criteria.listByWorkItem(item.id);
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: refreshed.id, specRevision: refreshed.specRevision },
      principal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: refreshed.dependencies,
    });

    await assert.rejects(
      factory.runWorker({
        workItemId: item.id,
        role: "IMPLEMENTER",
        worker: cliWorker,
        instructions: "implement",
        directTicketReference: TICKET_REFERENCE,
        expectedModel: TICKET.model,
        expectedScope: TICKET.scope,
        expectedBudgets: TICKET.budgets,
      }),
    );
    assert.equal(processRunner.invocations.length, 0);
    assert.equal(calls.atomicConsumeLaunch, 0);
    const runs = await factory.listRuns(item.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "FAILED");
  });

  it("readiness reporting not-ready refuses before spawn, cancels the live owned handle, and finalizes FAILED", async () => {
    const { authority, calls, setReady } = makeRetainedAuthority();
    setReady(false);
    const { factory, store, processRunner, cliWorker, registerApprovedPrestart } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);
    const principal = factory.registerWorker(cliWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const criteria = await store.criteria.listByWorkItem(item.id);
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });

    await assert.rejects(
      factory.runWorker({
        workItemId: item.id,
        role: "IMPLEMENTER",
        worker: cliWorker,
        instructions: "implement",
        directTicketReference: TICKET_REFERENCE,
        expectedModel: TICKET.model,
        expectedScope: TICKET.scope,
        expectedBudgets: TICKET.budgets,
      }),
    );
    assert.equal(processRunner.invocations.length, 0);
    assert.equal(calls.atomicConsumeLaunch, 0);
    const runs = await factory.listRuns(item.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "FAILED");
    // A84 owned cancellation: readiness failure after issuance cancels the
    // handle this run itself issued, never leaving it live/reserved.
    assert.equal(calls.cancel, 1);
  });

  it("a terminal/CANCELLED work item at the current-reader checkpoint refuses the already-issued handle and settles FAILED, never spawning", async () => {
    const { authority, calls } = makeRetainedAuthority();
    const { factory, store, processRunner, cliWorker, registerApprovedPrestart } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const cancellingWorker = {
      id: "cli-cancelling",
      capabilities: { roles: ["IMPLEMENTER"] as const, deterministic: false },
      async execute(request: Parameters<typeof cliWorker.execute>[0]) {
        // Simulate a human cancelling the work item between Phase 1 (RUNNING
        // row durable, handle issued) and Phase 2 (this execute call), via
        // the real advance/transition path.
        await factory.advance(item.id, "CANCELLED", HUMAN, { authorization: factory.authorizeHuman(HUMAN, TEST_CREDENTIAL) });
        // Same shared channel, nonconsuming readiness re-check against the
        // now-live-cancelled state; refusal propagates. Only if readiness
        // unexpectedly reports true would this delegate to the real adapter.
        const ready = await factory.sharedDirectAdmissionChannel!.checkReadiness(request.directAdmissionHandle);
        if (!ready) {
          throw new Error("admission handle not ready: work item cancelled");
        }
        return cliWorker.execute(request);
      },
    };
    const principal = factory.registerWorker(cancellingWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const criteria = await store.criteria.listByWorkItem(item.id);
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });

    await assert.rejects(
      factory.runWorker({
        workItemId: item.id,
        role: "IMPLEMENTER",
        worker: cancellingWorker,
        instructions: "implement",
        directTicketReference: TICKET_REFERENCE,
        expectedModel: TICKET.model,
        expectedScope: TICKET.scope,
        expectedBudgets: TICKET.budgets,
      }),
    );
    assert.equal(processRunner.invocations.length, 0);
    assert.equal(calls.atomicConsumeLaunch, 0);
    assert.equal(calls.cancel, 1);
    const runs = await factory.listRuns(item.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "FAILED");
  });
});

