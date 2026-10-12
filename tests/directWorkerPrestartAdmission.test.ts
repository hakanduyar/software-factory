import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveApprovedPrestart,
  PrestartAdmissionRefusedError,
  type ApprovedPrestartPort,
  type ApprovedPrestartRecord,
  type RetainedPrestartRecord,
  type CurrentPrestartSnapshot,
  type PrestartTicketReference,
} from "../src/supervision/directWorkerPrestartAdmission.js";
import { computeTicketDigest, parseWorkerTicket } from "../src/supervision/workerContract.js";
import type { WorkerPrincipal } from "../src/domain/workerPrincipal.js";
import type { RunId } from "../src/domain/ids.js";

function strictTicket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    ticketId: "t-approved-1",
    objective: "Implement the approved prestart primitive now",
    acceptanceCriteria: [
      { id: "ac-1", version: "1.0.0", description: "Does the approved thing correctly" },
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

function digestOf(candidate: Record<string, unknown>): string {
  const parsed = parseWorkerTicket(candidate);
  assert.equal(parsed.ok, true);
  return computeTicketDigest((parsed as { ok: true; value: unknown }).value as never);
}

function principal(overrides: Partial<WorkerPrincipal> = {}): WorkerPrincipal {
  return {
    principalId: "principal-approved-1",
    declaredId: "declared-1",
    roles: ["IMPLEMENTER"],
    // WorkerPrincipal.registeredAt is a numeric Timestamp, not an ISO string.
    registeredAt: 1767225600000,
    requiresDirectAdmission: true,
    ...overrides,
  };
}

/** Fixture authority: registers explicit disposition records, independent of any request shape. */
function createRegistry(): ApprovedPrestartPort & {
  register(reference: string, record: RetainedPrestartRecord): void;
} {
  const store = new Map<string, RetainedPrestartRecord>();
  return {
    register(reference: string, record: RetainedPrestartRecord): void {
      store.set(reference, record);
    },
    resolveApprovedPrestart(reference: PrestartTicketReference): RetainedPrestartRecord | undefined {
      return store.get(reference);
    },
  };
}

function baseApprovedRecord(
  ticket: Record<string, unknown>,
  overrides: Partial<ApprovedPrestartRecord> = {},
): ApprovedPrestartRecord {
  const parsed = parseWorkerTicket(ticket);
  assert.equal(parsed.ok, true);
  const value = (parsed as { ok: true; value: {
    scope: unknown;
    model: unknown;
    budgets: unknown;
  } }).value;
  return {
    ticket,
    ticketDigest: digestOf(ticket),
    approvedPrincipalId: "principal-approved-1",
    approvedRole: "IMPLEMENTER",
    approvedWorkItemId: "wi-approved-1",
    approvedSpecRevision: 3,
    approvedAcceptanceCriteria: [
      { id: "ac-1", version: "1.0.0", description: "Does the approved thing correctly" },
    ],
    approvedDependencyWorkItemIds: ["wi-dep-1"],
    approvedScope: value.scope as ApprovedPrestartRecord["approvedScope"],
    approvedModel: value.model as ApprovedPrestartRecord["approvedModel"],
    approvedBudgets: value.budgets as ApprovedPrestartRecord["approvedBudgets"],
    ...overrides,
  };
}

function approvedDisposition(record: ApprovedPrestartRecord): RetainedPrestartRecord {
  return { disposition: "approved", approval: record };
}

function baseSnapshot(overrides: Partial<CurrentPrestartSnapshot> = {}): CurrentPrestartSnapshot {
  const ticket = strictTicket();
  const parsed = parseWorkerTicket(ticket);
  assert.equal(parsed.ok, true);
  const value = (parsed as { ok: true; value: {
    scope: unknown;
    model: unknown;
    budgets: unknown;
  } }).value;
  return {
    item: { id: "wi-approved-1", specRevision: 3, dependencies: ["wi-dep-1"] },
    role: "IMPLEMENTER",
    principal: principal(),
    criteria: [
      { id: "ac-1", version: "1.0.0", description: "Does the approved thing correctly" },
    ],
    requestedScope: value.scope as CurrentPrestartSnapshot["requestedScope"],
    requestedModel: value.model as CurrentPrestartSnapshot["requestedModel"],
    requestedBudgets: value.budgets as CurrentPrestartSnapshot["requestedBudgets"],
    ...overrides,
  };
}

test("positive control: genuinely registered approval matches a genuine current snapshot", () => {
  const registry = createRegistry();
  const ticket = strictTicket();
  const record = baseApprovedRecord(ticket);
  registry.register("ref-ok", approvedDisposition(record));

  const result = resolveApprovedPrestart(
    registry,
    "ref-ok" as PrestartTicketReference,
    baseSnapshot(),
  );

  assert.equal(result.ticketDigest, record.ticketDigest);
  assert.equal(result.ticket.ticketId, "t-approved-1");
});

test("positive control: genuine approved target run matches current target run", () => {
  const registry = createRegistry();
  const targetRunId = "run-approved-1" as RunId;
  const record = baseApprovedRecord(strictTicket(), { approvedTargetRunId: targetRunId });
  registry.register("ref-ok-target", approvedDisposition(record));

  const result = resolveApprovedPrestart(
    registry,
    "ref-ok-target" as PrestartTicketReference,
    baseSnapshot({ targetRunId }),
  );

  assert.equal(result.ticketDigest, record.ticketDigest);
});

test("refuses when no authority is supplied", () => {
  assert.throws(
    () =>
      resolveApprovedPrestart(
        undefined as unknown as ApprovedPrestartPort,
        "ref-ok" as PrestartTicketReference,
        baseSnapshot(),
      ),
    PrestartAdmissionRefusedError,
  );
});

test("refuses an unknown/unregistered reference", () => {
  const registry = createRegistry();
  registry.register("ref-ok", approvedDisposition(baseApprovedRecord(strictTicket())));

  assert.throws(
    () =>
      resolveApprovedPrestart(
        registry,
        "ref-does-not-exist" as PrestartTicketReference,
        baseSnapshot(),
      ),
    PrestartAdmissionRefusedError,
  );
});

test("a raw caller-asserted ticket/boolean never substitutes for the retained approval", () => {
  const registry = createRegistry();
  // No record registered at all: a caller presenting its own ticket plus an
  // "approved: true" flag must not grant anything, because resolution comes
  // only from the port's own store, never from caller-supplied content.
  const forgedTicket = strictTicket({ ticketId: "forged" });
  void forgedTicket;

  assert.throws(
    () =>
      resolveApprovedPrestart(
        registry,
        "ref-never-registered" as PrestartTicketReference,
        baseSnapshot(),
      ),
    PrestartAdmissionRefusedError,
  );
});

test("nonreservation: a successful resolution performs no reservation/claim and can be called repeatedly", () => {
  const registry = createRegistry();
  const record = baseApprovedRecord(strictTicket());
  registry.register("ref-ok", approvedDisposition(record));

  const first = resolveApprovedPrestart(registry, "ref-ok" as PrestartTicketReference, baseSnapshot());
  const second = resolveApprovedPrestart(registry, "ref-ok" as PrestartTicketReference, baseSnapshot());

  assert.equal(first.ticketDigest, second.ticketDigest);
  assert.deepEqual(first.ticket, second.ticket);
});

type RefusalCase = {
  readonly name: string;
  readonly retained?: RetainedPrestartRecord;
  readonly mutateRecord?: (record: ApprovedPrestartRecord) => ApprovedPrestartRecord;
  readonly mutateSnapshot?: (snapshot: CurrentPrestartSnapshot) => CurrentPrestartSnapshot;
};

const refusalCases: readonly RefusalCase[] = [
  {
    name: "retained record explicitly registered as unapproved",
    retained: { disposition: "unapproved" },
  },
  {
    name: "retained record explicitly registered as unavailable",
    retained: { disposition: "unavailable" },
  },
  {
    name: "malformed retained ticket (fails strict parser)",
    mutateRecord: (record) => ({ ...record, ticket: { ticketId: "only-a-fragment" } }),
  },
  {
    name: "wrong trusted digest for an otherwise-valid retained ticket",
    mutateRecord: (record) => ({ ...record, ticketDigest: "0".repeat(64) }),
  },
  {
    name: "stale approved specRevision vs current WorkItem",
    mutateSnapshot: (snapshot) => ({
      ...snapshot,
      item: { ...snapshot.item, specRevision: snapshot.item.specRevision + 1 },
    }),
  },
  {
    name: "wrong registry principal for the current run",
    mutateSnapshot: (snapshot) => ({
      ...snapshot,
      principal: principal({ principalId: "someone-else" }),
    }),
  },
  {
    name: "wrong role for the current run",
    mutateSnapshot: (snapshot) => ({ ...snapshot, role: "REVIEWER" }),
  },
  {
    name: "differing full acceptance criteria facts (extra current criterion)",
    mutateSnapshot: (snapshot) => ({
      ...snapshot,
      criteria: [
        ...snapshot.criteria,
        { id: "ac-2", version: "1.0.0", description: "An unapproved extra criterion" },
      ],
    }),
  },
  {
    name: "differing full acceptance criteria facts (changed description)",
    mutateSnapshot: (snapshot) => ({
      ...snapshot,
      criteria: [{ id: "ac-1", version: "1.0.0", description: "A silently altered description" }],
    }),
  },
  {
    name: "differing dependency work items",
    mutateSnapshot: (snapshot) => ({
      ...snapshot,
      item: { ...snapshot.item, dependencies: ["wi-dep-1", "wi-dep-unapproved"] },
    }),
  },
  {
    name: "wrong current workItemId",
    mutateSnapshot: (snapshot) => ({
      ...snapshot,
      item: { ...snapshot.item, id: "wi-different" },
    }),
  },
  {
    name: "current target run present but approval has none (absence must be exact)",
    mutateSnapshot: (snapshot) => ({ ...snapshot, targetRunId: "run-unapproved-1" as RunId }),
  },
  {
    name: "current requested scope drifts from the approved scope",
    mutateSnapshot: (snapshot) => ({
      ...snapshot,
      requestedScope: { ...snapshot.requestedScope, owned: ["src/drifted.ts"] },
    }),
  },
  {
    name: "current requested model policy drifts from the approved model policy",
    mutateSnapshot: (snapshot) => ({
      ...snapshot,
      requestedModel: { ...snapshot.requestedModel, eligibleModels: ["model-drifted"] },
    }),
  },
  {
    name: "current requested budgets drift from the approved budgets",
    mutateSnapshot: (snapshot) => ({
      ...snapshot,
      requestedBudgets: { ...snapshot.requestedBudgets, maxAttempts: 7 },
    }),
  },
];

for (const refusalCase of refusalCases) {
  test(`refuses: ${refusalCase.name}`, () => {
    const registry = createRegistry();

    if (refusalCase.retained) {
      registry.register("ref-case", refusalCase.retained);
    } else {
      let record = baseApprovedRecord(strictTicket());
      if (refusalCase.mutateRecord) {
        record = refusalCase.mutateRecord(record);
      }
      registry.register("ref-case", approvedDisposition(record));
    }

    let snapshot = baseSnapshot();
    if (refusalCase.mutateSnapshot) {
      snapshot = refusalCase.mutateSnapshot(snapshot);
    }

    assert.throws(
      () => resolveApprovedPrestart(registry, "ref-case" as PrestartTicketReference, snapshot),
      PrestartAdmissionRefusedError,
    );
  });
}

test("refuses when the approved record's own scope/model/budgets were tampered independently of the ticket payload", () => {
  const registry = createRegistry();
  const record = baseApprovedRecord(strictTicket());
  const tampered: ApprovedPrestartRecord = {
    ...record,
    approvedBudgets: { ...record.approvedBudgets, maxAttempts: 99 },
  };
  registry.register("ref-case", approvedDisposition(tampered));

  assert.throws(
    () => resolveApprovedPrestart(registry, "ref-case" as PrestartTicketReference, baseSnapshot()),
    PrestartAdmissionRefusedError,
  );
});
