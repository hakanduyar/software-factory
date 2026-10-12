import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createDirectHostAdmissionChannel,
  type DirectHostLaunchRequest,
  type DirectHostLaunchGrant,
  type DirectLaunchCapabilityEvidence,
} from "../src/supervision/directWorkerAdmission.js";
import { computeTicketDigest, type WorkerTicket } from "../src/supervision/workerContract.js";
import type {
  DirectLaunchBinding,
  DirectLaunchReceipt,
  DirectLaunchAuthorityPort,
} from "../src/ports/worker.js";

function makeTicket(overrides: Partial<WorkerTicket> = {}): WorkerTicket {
  return {
    schemaVersion: "1.0.0",
    ticketId: "ticket-1",
    objective: "do it thoroughly and well",
    acceptanceCriteria: [{ id: "ac-1", version: "1.0.0", description: "work is done" }],
    scope: {
      owned: ["src/a.ts"],
      forbidden: [],
      read: [],
      dependencies: [],
      validation: ["npm test"],
    },
    model: { eligibleModels: ["model-a"], reasoningEffort: "low", rationale: "stable baseline" },
    budgets: { contextTokens: 1000, outputTokens: 500, elapsedSeconds: 60, maxAttempts: 1 },
    policy: { checkpoint: "checkpoint", stopConditions: ["done"], escalation: "human" },
    resultSchema: { requiredFields: ["schemaVersion", "ticketId"], maxResultBytes: 2048 },
    ...overrides,
  } as WorkerTicket;
}

function makeRequest(overrides: Partial<DirectHostLaunchRequest> = {}): DirectHostLaunchRequest {
  const ticket = makeTicket();
  return {
    ticketReference: "ref-1" as DirectHostLaunchRequest["ticketReference"],
    registryPrincipalId: "principal-1",
    workItemId: "wi-1" as DirectHostLaunchRequest["workItemId"],
    specRevision: 1,
    runId: "run-1" as DirectHostLaunchRequest["runId"],
    role: "builder" as DirectHostLaunchRequest["role"],
    acceptanceCriteria: [{ id: "ac-1", workItemId: "wi-1", text: "done", verificationHint: "check" }] as unknown as DirectHostLaunchRequest["acceptanceCriteria"],
    dependencyWorkItemIds: [],
    scope: ticket.scope,
    model: ticket.model,
    ...overrides,
  };
}

function makeBinding(ticketDigest: string, overrides: Partial<DirectLaunchBinding> = {}): DirectLaunchBinding {
  return {
    ticketDigest,
    registryPrincipalId: "principal-1",
    workItemId: "wi-1",
    specRevision: 1,
    runId: "run-1",
    reservationId: "res-1",
    reservationVersion: 1,
    ...overrides,
  } as unknown as DirectLaunchBinding;
}

function makeEvidence(
  ticket: WorkerTicket,
  binding: DirectLaunchBinding,
  overrides: Partial<DirectLaunchCapabilityEvidence> = {},
): DirectLaunchCapabilityEvidence {
  return {
    ticketDigest: binding.ticketDigest,
    registryPrincipalId: binding.registryPrincipalId,
    workItemId: binding.workItemId,
    specRevision: binding.specRevision,
    runId: binding.runId,
    reservationId: binding.reservationId,
    reservationVersion: binding.reservationVersion,
    scope: ticket.scope,
    model: ticket.model,
    budgets: ticket.budgets,
    observedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    evidenceReference: "evid-1",
    evidenceDigest: "digest",
    quota: {
      availableContextTokens: 1000,
      availableOutputTokens: 500,
      availableElapsedSeconds: 60,
      availableAttempts: 1,
      verified: true,
    },
    context: { supportedModels: ["model-a"], supportedReasoningEfforts: ["low"], verified: true },
    confinement: { supportedScopeOwned: ["src/a.ts"], supportedScopeForbidden: [], verified: true },
    ...overrides,
  };
}

function makeGrant(overrides: {
  ticket?: WorkerTicket;
  binding?: Partial<DirectLaunchBinding>;
  evidence?: Partial<DirectLaunchCapabilityEvidence>;
} = {}): DirectHostLaunchGrant {
  const ticket = overrides.ticket ?? makeTicket();
  const ticketDigest = computeTicketDigest(ticket);
  const binding = makeBinding(ticketDigest, overrides.binding);
  const evidence = makeEvidence(ticket, binding, overrides.evidence);
  return { ticket, ticketDigest, binding, evidence };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeFakeAuthority(opts: {
  grant?: DirectHostLaunchGrant;
  ready?: boolean;
  receiptOverride?: Partial<DirectLaunchReceipt>;
  gateConsume?: ReturnType<typeof deferred<void>>;
  gateReadiness?: ReturnType<typeof deferred<void>>;
} = {}) {
  const grant = opts.grant ?? makeGrant();
  const calls = { resolveAndReserve: 0, revalidate: 0, checkReadiness: 0, atomicConsumeLaunch: 0, cancel: 0 };
  const authority: DirectLaunchAuthorityPort & {
    resolveAndReserve: (r: DirectHostLaunchRequest) => Promise<DirectHostLaunchGrant>;
    revalidate: (g: DirectHostLaunchGrant, r: DirectHostLaunchRequest) => Promise<void>;
    cancel: (b: DirectLaunchBinding) => Promise<void>;
  } = {
    async resolveAndReserve() {
      calls.resolveAndReserve++;
      return grant;
    },
    async revalidate() {
      calls.revalidate++;
    },
    async checkReadiness() {
      calls.checkReadiness++;
      if (opts.gateReadiness) await opts.gateReadiness.promise;
      return opts.ready ?? true;
    },
    async atomicConsumeLaunch(binding: DirectLaunchBinding) {
      calls.atomicConsumeLaunch++;
      if (opts.gateConsume) await opts.gateConsume.promise;
      if (calls.atomicConsumeLaunch > 1) throw new Error("already consumed");
      const receipt = {
        binding,
        consumedAt: "2026-01-01T00:00:00.000Z",
        ...opts.receiptOverride,
      } as DirectLaunchReceipt;
      return receipt;
    },
    async cancel() {
      calls.cancel++;
    },
  };
  return { authority, calls, grant };
}

test("construction rejects missing authority methods or callback", () => {
  const { authority } = makeFakeAuthority();
  assert.throws(() =>
    createDirectHostAdmissionChannel({ ...authority, cancel: undefined } as never, async (_b, r) => r),
  );
  assert.throws(() => createDirectHostAdmissionChannel(authority, undefined as never));
});

test("happy path: issue, readiness nonconsuming, consume exactly once", async () => {
  const { authority, calls } = makeFakeAuthority();
  const request = makeRequest();
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
  const handle = await channel.issue(request);
  assert.ok(Object.isFrozen(handle));
  assert.equal(await channel.checkReadiness(handle), true);
  assert.equal(await channel.checkReadiness(handle), true);
  assert.equal(calls.atomicConsumeLaunch, 0);
  const receipt = await channel.consume(handle);
  assert.equal(calls.atomicConsumeLaunch, 1);
  assert.equal(receipt.binding.reservationId, "res-1");
  await assert.rejects(channel.consume(handle));
  await assert.rejects(channel.checkReadiness(handle));
});

test("snapshots are frozen against later caller mutation", async () => {
  const { authority } = makeFakeAuthority();
  const request = makeRequest();
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
  const issuePromise = channel.issue(request);
  (request as { registryPrincipalId: string }).registryPrincipalId = "mutated";
  const handle = await issuePromise;
  assert.equal(await channel.checkReadiness(handle), true);
});

test("captured authority methods survive later replacement", async () => {
  const { authority, calls } = makeFakeAuthority();
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
  authority.checkReadiness = async () => {
    throw new Error("should not be called");
  };
  const handle = await channel.issue(makeRequest());
  assert.equal(await channel.checkReadiness(handle), true);
  assert.equal(calls.checkReadiness, 1);
});

const unknownHandleCases: Array<[string, () => unknown]> = [
  ["null", () => null],
  ["plain clone", () => ({})],
];

for (const [name, make] of unknownHandleCases) {
  test(`refuses ${name} handle before any authority call`, async () => {
    const { authority, calls } = makeFakeAuthority();
    const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
    await assert.rejects(channel.checkReadiness(make()));
    await assert.rejects(channel.consume(make()));
    assert.equal(calls.revalidate, 0);
    assert.equal(calls.checkReadiness, 0);
    assert.equal(calls.atomicConsumeLaunch, 0);
  });
}

test("refuses proxy-wrapped real handle and cross-channel handle", async () => {
  const fakeA = makeFakeAuthority();
  const fakeB = makeFakeAuthority();
  const channelA = createDirectHostAdmissionChannel(fakeA.authority, async (_b, r) => r);
  const channelB = createDirectHostAdmissionChannel(fakeB.authority, async (_b, r) => r);
  const handleA = await channelA.issue(makeRequest());
  const proxied = new Proxy(handleA as object, {});
  await assert.rejects(channelA.checkReadiness(proxied));
  await assert.rejects(channelB.checkReadiness(handleA));
  assert.equal(fakeB.calls.revalidate, 0);
});

const badGrantCases: Array<[string, DirectHostLaunchGrant, string]> = [
  ["wrong ticketDigest", (() => { const g = makeGrant(); return { ...g, ticketDigest: "deadbeef" }; })(), "canonical digest does not match trusted expected digest"],
  ["binding/evidence ticketDigest mismatch", makeGrant({ evidence: { ticketDigest: "other" } }), "grant ticketDigest is inconsistent"],
  ["binding/evidence reservationId mismatch", makeGrant({ evidence: { reservationId: "res-2" } }), "binding/evidence field reservationId"],
  ["binding/evidence reservationVersion mismatch", makeGrant({ evidence: { reservationVersion: 2 } }), "binding/evidence field reservationVersion"],
  ["binding workItemId mismatches request", makeGrant({ binding: { workItemId: "wi-2" } }), "grant binding does not match the issuing request"],
];

for (const [name, grant, expected] of badGrantCases) {
  test(`issue rejects: ${name}`, async () => {
    const { authority, calls } = makeFakeAuthority({ grant });
    const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
    await assert.rejects(channel.issue(makeRequest()), (err: Error) => err.message.includes(expected));
    assert.equal(calls.atomicConsumeLaunch, 0);
  });
}

test("trusted callback request drift causes refusal", async () => {
  const { authority } = makeFakeAuthority();
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => ({
    ...r,
    specRevision: r.specRevision + 1,
  }));
  const handle = await channel.issue(makeRequest());
  await assert.rejects(channel.checkReadiness(handle));
  await assert.rejects(channel.consume(handle));
});

test("concurrent consume: atomic call at most once, other rejects", async () => {
  const gateConsume = deferred<void>();
  const { authority, calls } = makeFakeAuthority({ gateConsume });
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
  const handle = await channel.issue(makeRequest());
  const first = channel.consume(handle);
  const second = channel.consume(handle);
  await assert.rejects(second);
  gateConsume.resolve();
  await first;
  assert.equal(calls.atomicConsumeLaunch, 1);
});

test("failure during revalidate leaves handle permanently retired", async () => {
  const { authority, calls } = makeFakeAuthority();
  authority.revalidate = async () => {
    throw new Error("boom");
  };
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
  const handle = await channel.issue(makeRequest());
  await assert.rejects(channel.consume(handle));
  await assert.rejects(channel.checkReadiness(handle));
  assert.equal(calls.atomicConsumeLaunch, 0);
});

test("not-ready refusal leaves handle retired", async () => {
  const { authority } = makeFakeAuthority({ ready: false });
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
  const handle = await channel.issue(makeRequest());
  await assert.rejects(channel.consume(handle));
  await assert.rejects(channel.checkReadiness(handle));
});

test("readiness suspended during concurrent consume cannot report renewed readiness", async () => {
  const gateReadiness = deferred<void>();
  const entered = deferred<void>();
  const { authority, calls } = makeFakeAuthority({
    gateReadiness: { promise: gateReadiness.promise.finally(() => undefined), resolve: gateReadiness.resolve, reject: gateReadiness.reject },
  });
  const realCheckReadiness = authority.checkReadiness.bind(authority);
  authority.checkReadiness = async (binding: DirectLaunchBinding) => {
    entered.resolve();
    return realCheckReadiness(binding);
  };
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
  const handle = await channel.issue(makeRequest());
  const readinessPromise = channel.checkReadiness(handle);
  await entered.promise;
  const consumePromise = channel.consume(handle);
  gateReadiness.resolve();
  await assert.rejects(readinessPromise);
  await consumePromise;
  assert.equal(calls.atomicConsumeLaunch, 1);
});

const sevenBindingFields: Array<keyof DirectLaunchBinding> = [
  "ticketDigest",
  "registryPrincipalId",
  "workItemId",
  "specRevision",
  "runId",
  "reservationId",
  "reservationVersion",
];

for (const field of sevenBindingFields) {
  test(`consume rejects receipt with mismatched binding field: ${String(field)}`, async () => {
    const badValue = field === "specRevision" || field === "reservationVersion" ? 99 : "mismatched";
    const grant = makeGrant();
    const badBinding: DirectLaunchBinding = { ...grant.binding, [field]: badValue } as DirectLaunchBinding;
    const { authority, calls } = makeFakeAuthority({
      grant,
      receiptOverride: { binding: badBinding },
    });
    const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
    const handle = await channel.issue(makeRequest());
    await assert.rejects(channel.consume(handle), (err: Error) => err.message.includes(String(field)));
    assert.equal(calls.atomicConsumeLaunch, 1);
    await assert.rejects(channel.checkReadiness(handle));
    await assert.rejects(channel.consume(handle));
    assert.equal(calls.atomicConsumeLaunch, 1);
  });
}

test("consume rejects malformed consumedAt, consumes exactly once, retires handle", async () => {
  const grant = makeGrant();
  const badReceiptBinding = { ...grant.binding };
  const { authority, calls } = makeFakeAuthority({
    grant,
    receiptOverride: { binding: badReceiptBinding, consumedAt: "not-a-date" },
  });
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
  const handle = await channel.issue(makeRequest());
  await assert.rejects(
    channel.consume(handle),
    (err: Error) => err.message.includes("receipt consumedAt is not a valid timestamp"),
  );
  assert.equal(calls.atomicConsumeLaunch, 1);
  await assert.rejects(channel.checkReadiness(handle));
  await assert.rejects(channel.consume(handle));
  assert.equal(calls.atomicConsumeLaunch, 1);
});

test("private snapshots are frozen and detached from caller mutation of originals", async () => {
  const grant = makeGrant();
  const { authority } = makeFakeAuthority({ grant });
  let capturedRequest: DirectHostLaunchRequest | undefined;
  let capturedGrant: DirectHostLaunchGrant | undefined;
  const originalRevalidate = authority.revalidate.bind(authority);
  authority.revalidate = async (g: DirectHostLaunchGrant, r: DirectHostLaunchRequest) => {
    capturedGrant = g;
    capturedRequest = r;
    return originalRevalidate(g, r);
  };
  const request = makeRequest();
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
  const handle = await channel.issue(request);
  (request.dependencyWorkItemIds as unknown as string[]).push("wi-mutated");
  (request.scope.owned as unknown as string[]).push("src/mutated.ts");
  (grant.ticket.scope.owned as unknown as string[]).push("src/mutated.ts");
  (grant as { binding: DirectLaunchBinding }).binding = { ...grant.binding, reservationId: "mutated" } as DirectLaunchBinding;
  await channel.checkReadiness(handle);
  assert.ok(capturedRequest);
  assert.ok(capturedGrant);
  assert.deepEqual(capturedRequest?.dependencyWorkItemIds, []);
  assert.deepEqual(capturedRequest?.scope.owned, ["src/a.ts"]);
  assert.deepEqual(capturedGrant?.ticket.scope.owned, ["src/a.ts"]);
  assert.equal(capturedGrant?.binding.reservationId, "res-1");
  assert.ok(Object.isFrozen(capturedRequest));
  assert.ok(Object.isFrozen(capturedRequest?.scope));
  assert.ok(Object.isFrozen(capturedGrant?.ticket));
  const receipt = await channel.consume(handle);
  assert.equal(receipt.binding.reservationId, "res-1");
});

const midFlightFailureCases: Array<[string, string, number]> = [
  ["trusted callback throws", "boom-callback", 0],
  ["atomicConsumeLaunch throws", "boom-consume", 1],
];

for (const [name, reason, expectedAtomicAttempts] of midFlightFailureCases) {
  test(`failure during ${name} leaves handle permanently retired, no second atomic call`, async () => {
    const { authority, calls } = makeFakeAuthority();
    if (name === "atomicConsumeLaunch throws") {
      authority.atomicConsumeLaunch = async () => {
        calls.atomicConsumeLaunch++;
        throw new Error(reason);
      };
    }
    const channel = createDirectHostAdmissionChannel(
      authority,
      name === "trusted callback throws"
        ? async () => {
            throw new Error(reason);
          }
        : async (_b, r) => r,
    );
    const handle = await channel.issue(makeRequest());
    await assert.rejects(channel.consume(handle), (err: Error) => err.message.includes(reason));
    assert.equal(calls.atomicConsumeLaunch, expectedAtomicAttempts);
    await assert.rejects(channel.checkReadiness(handle));
    await assert.rejects(channel.consume(handle));
    assert.equal(calls.atomicConsumeLaunch, expectedAtomicAttempts);
  });
}
test("cancel passes the exact private binding to captured authority.cancel, consumes zero atomic launches, retires handle", async () => {
  const grant = makeGrant();
  const { authority, calls } = makeFakeAuthority({ grant });
  let capturedBinding: DirectLaunchBinding | undefined;
  const realCancel = authority.cancel.bind(authority);
  authority.cancel = async (binding: DirectLaunchBinding) => {
    capturedBinding = binding;
    return realCancel(binding);
  };
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
  const handle = await channel.issue(makeRequest());
  authority.cancel = async () => {
    throw new Error("should not be called after capture");
  };
  await channel.cancel(handle);
  assert.equal(calls.cancel, 1);
  assert.equal(calls.atomicConsumeLaunch, 0);
  assert.deepEqual(capturedBinding, grant.binding);
  await assert.rejects(channel.consume(handle));
  await assert.rejects(channel.checkReadiness(handle));
  await assert.rejects(channel.cancel(handle));
  assert.equal(calls.cancel, 1);
});

const invalidCancelHandleCases: Array<[string, () => Promise<unknown>]> = [
  ["null", async () => null],
  ["plain clone", async () => ({})],
];

for (const [name, make] of invalidCancelHandleCases) {
  test(`cancel refuses ${name} handle without calling authority`, async () => {
    const { authority, calls } = makeFakeAuthority();
    const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
    await assert.rejects(channel.cancel(await make()));
    assert.equal(calls.cancel, 0);
  });
}

test("cancel refuses a proxy-wrapped real handle and a foreign channel's handle", async () => {
  const fakeA = makeFakeAuthority();
  const fakeB = makeFakeAuthority();
  const channelA = createDirectHostAdmissionChannel(fakeA.authority, async (_b, r) => r);
  const channelB = createDirectHostAdmissionChannel(fakeB.authority, async (_b, r) => r);
  const handleA = await channelA.issue(makeRequest());
  const proxied = new Proxy(handleA as object, {});
  await assert.rejects(channelA.cancel(proxied));
  await assert.rejects(channelB.cancel(handleA));
  assert.equal(fakeA.calls.cancel, 0);
  assert.equal(fakeB.calls.cancel, 0);
});

test("cancel refuses an already-consumed handle", async () => {
  const { authority, calls } = makeFakeAuthority();
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
  const handle = await channel.issue(makeRequest());
  await channel.consume(handle);
  await assert.rejects(channel.cancel(handle));
  assert.equal(calls.cancel, 0);
});

test("concurrent cancel vs consume: cancel wins, exactly one cancel, zero atomic launches", async () => {
  const gateCancel = deferred<void>();
  const { authority, calls } = makeFakeAuthority();
  const realCancel = authority.cancel.bind(authority);
  authority.cancel = async (binding: DirectLaunchBinding) => {
    await gateCancel.promise;
    return realCancel(binding);
  };
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
  const handle = await channel.issue(makeRequest());
  const cancelPromise = channel.cancel(handle);
  const consumePromise = channel.consume(handle);
  const consumeRejection = assert.rejects(consumePromise);
  gateCancel.resolve();
  await cancelPromise;
  await consumeRejection;
  assert.equal(calls.cancel, 1);
  assert.equal(calls.atomicConsumeLaunch, 0);
});

test("concurrent cancel vs consume: consume wins, exactly one atomic launch, zero cancels", async () => {
  const gateConsume = deferred<void>();
  const { authority, calls } = makeFakeAuthority({ gateConsume });
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
  const handle = await channel.issue(makeRequest());
  const consumePromise = channel.consume(handle);
  const cancelPromise = channel.cancel(handle);
  const cancelRejection = assert.rejects(cancelPromise);
  gateConsume.resolve();
  await consumePromise;
  await cancelRejection;
  assert.equal(calls.atomicConsumeLaunch, 1);
  assert.equal(calls.cancel, 0);
});

test("authority.cancel throwing leaves handle permanently retired, no second cancel on replay", async () => {
  const { authority, calls } = makeFakeAuthority();
  authority.cancel = async () => {
    calls.cancel++;
    throw new Error("boom-cancel");
  };
  const channel = createDirectHostAdmissionChannel(authority, async (_b, r) => r);
  const handle = await channel.issue(makeRequest());
  await assert.rejects(channel.cancel(handle), (err: Error) => err.message.includes("boom-cancel"));
  assert.equal(calls.cancel, 1);
  await assert.rejects(channel.cancel(handle));
  await assert.rejects(channel.consume(handle));
  assert.equal(calls.cancel, 1);
  assert.equal(calls.atomicConsumeLaunch, 0);
});