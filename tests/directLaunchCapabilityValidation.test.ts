import { test } from "node:test";
import assert from "node:assert/strict";

import { validateDirectLaunchCapabilityEvidence } from "../src/supervision/directLaunchCapabilityValidation.js";
import { DirectAdmissionRefusedError } from "../src/supervision/directWorkerAdmission.js";
import { computeTicketDigest, type WorkerTicket } from "../src/supervision/workerContract.js";
import type { DirectLaunchBinding } from "../src/ports/worker.js";

function makeTicket(): WorkerTicket {
  return {
    schemaVersion: "1.0.0",
    ticketId: "ticket-1",
    objective: "Validate direct launch capability evidence",
    acceptanceCriteria: [
      { id: "AC-1", version: "1.0.0", description: "exact identity and expectation match" },
    ],
    scope: {
      owned: ["src/supervision/directLaunchCapabilityValidation.ts"],
      forbidden: ["src/ports/worker.ts"],
      read: ["src/supervision/directWorkerAdmission.ts"],
      dependencies: [],
      validation: ["npm run typecheck"],
    },
    model: {
      eligibleModels: ["claude-sonnet-5"],
      reasoningEffort: "medium",
      rationale: "sufficiently capable for bounded validation logic",
    },
    budgets: {
      contextTokens: 10000,
      outputTokens: 2000,
      elapsedSeconds: 600,
      maxAttempts: 2,
    },
    policy: {
      checkpoint: "after each file write",
      stopConditions: ["two failed corrections"],
      escalation: "route to diagnosis",
    },
    resultSchema: {
      requiredFields: ["summary", "fingerprint"],
      maxResultBytes: 2048,
    },
  };
}

function makeBinding(ticketDigest: string): DirectLaunchBinding {
  return {
    ticketDigest,
    registryPrincipalId: "principal-1",
    workItemId: "work-item-1",
    specRevision: 3,
    runId: "run-1",
    reservationId: "reservation-1",
    reservationVersion: 1,
  } as unknown as DirectLaunchBinding;
}

const TRUSTED_NOW = Date.parse("2026-10-07T12:00:00.000Z");
const MAX_AGE_SECONDS = 300;

function makeValidEvidence(
  ticket: WorkerTicket,
  ticketDigest: string,
  binding: DirectLaunchBinding,
) {
  return {
    ticketDigest,
    registryPrincipalId: binding.registryPrincipalId,
    workItemId: binding.workItemId,
    specRevision: binding.specRevision,
    runId: binding.runId,
    reservationId: binding.reservationId,
    reservationVersion: binding.reservationVersion,
    scope: ticket.scope,
    model: ticket.model,
    budgets: ticket.budgets,
    observedAt: "2026-10-07T11:58:00.000Z",
    expiresAt: "2026-10-07T12:30:00.000Z",
    evidenceReference: "evidence/direct-launch/run-1.json",
    evidenceDigest: "sha256:" + "a".repeat(64),
    quota: {
      availableContextTokens: ticket.budgets.contextTokens,
      availableOutputTokens: ticket.budgets.outputTokens,
      availableElapsedSeconds: ticket.budgets.elapsedSeconds,
      availableAttempts: ticket.budgets.maxAttempts,
      verified: true,
    },
    context: {
      supportedModels: [...ticket.model.eligibleModels],
      supportedReasoningEfforts: [ticket.model.reasoningEffort],
      verified: true,
    },
    confinement: {
      supportedScopeOwned: [...ticket.scope.owned],
      supportedScopeForbidden: [...ticket.scope.forbidden],
      verified: true,
    },
  };
}

function baseline() {
  const ticket = makeTicket();
  const ticketDigest = computeTicketDigest(ticket);
  const binding = makeBinding(ticketDigest);
  const evidence = makeValidEvidence(ticket, ticketDigest, binding);
  return { ticket, ticketDigest, binding, evidence };
}

test("accepts a demonstrably valid deterministic baseline", () => {
  const { ticket, ticketDigest, binding, evidence } = baseline();
  const result = validateDirectLaunchCapabilityEvidence(evidence, {
    ticket,
    ticketDigest,
    binding,
    trustedNowMillis: TRUSTED_NOW,
    maxEvidenceAgeSeconds: MAX_AGE_SECONDS,
  });
  assert.equal(result.evidence.ticketDigest, ticketDigest);
  assert.notEqual(result.validatedAgainstBinding, binding);
  assert.deepEqual(result.validatedAgainstBinding, binding);
  assert.equal(result.validatedAt, TRUSTED_NOW);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.evidence));
  assert.ok(Object.isFrozen(result.validatedAgainstBinding));
});

test("returned binding snapshot is isolated from later mutation of the supplied binding object", () => {
  const { ticket, ticketDigest, binding, evidence } = baseline();
  const mutableBinding = { ...binding };
  const result = validateDirectLaunchCapabilityEvidence(evidence, {
    ticket,
    ticketDigest,
    binding: mutableBinding,
    trustedNowMillis: TRUSTED_NOW,
    maxEvidenceAgeSeconds: MAX_AGE_SECONDS,
  });
  mutableBinding.registryPrincipalId = "someone-else";
  assert.equal(result.validatedAgainstBinding.registryPrincipalId, binding.registryPrincipalId);
});

test("evidence boundary exactly at the maximum allowed age is accepted", () => {
  const { ticket, ticketDigest, binding, evidence } = baseline();
  const boundaryEvidence = {
    ...evidence,
    observedAt: new Date(TRUSTED_NOW - MAX_AGE_SECONDS * 1000).toISOString(),
  };
  const result = validateDirectLaunchCapabilityEvidence(boundaryEvidence, {
    ticket,
    ticketDigest,
    binding,
    trustedNowMillis: TRUSTED_NOW,
    maxEvidenceAgeSeconds: MAX_AGE_SECONDS,
  });
  assert.equal(result.evidence.observedAt, boundaryEvidence.observedAt);
});

test("evidence one second beyond the maximum allowed age is refused", () => {
  const { ticket, ticketDigest, binding, evidence } = baseline();
  const staleEvidence = {
    ...evidence,
    observedAt: new Date(TRUSTED_NOW - (MAX_AGE_SECONDS + 1) * 1000).toISOString(),
  };
  assert.throws(
    () =>
      validateDirectLaunchCapabilityEvidence(staleEvidence, {
        ticket,
        ticketDigest,
        binding,
        trustedNowMillis: TRUSTED_NOW,
        maxEvidenceAgeSeconds: MAX_AGE_SECONDS,
      }),
    DirectAdmissionRefusedError,
  );
});

test("exact capacity equal to the frozen budget is accepted, one below is refused", () => {
  const { ticket, ticketDigest, binding, evidence } = baseline();
  const exact = validateDirectLaunchCapabilityEvidence(evidence, {
    ticket,
    ticketDigest,
    binding,
    trustedNowMillis: TRUSTED_NOW,
    maxEvidenceAgeSeconds: MAX_AGE_SECONDS,
  });
  assert.equal(exact.evidence.quota.availableContextTokens, ticket.budgets.contextTokens);

  const insufficient = {
    ...evidence,
    quota: { ...evidence.quota, availableContextTokens: ticket.budgets.contextTokens - 1 },
  };
  assert.throws(
    () =>
      validateDirectLaunchCapabilityEvidence(insufficient, {
        ticket,
        ticketDigest,
        binding,
        trustedNowMillis: TRUSTED_NOW,
        maxEvidenceAgeSeconds: MAX_AGE_SECONDS,
      }),
    DirectAdmissionRefusedError,
  );
});

interface InvalidCase {
  readonly name: string;
  readonly mutate: (ctx: ReturnType<typeof baseline>) => unknown;
}

const INVALID_CASES: readonly InvalidCase[] = [
  {
    name: "wrong ticketDigest identity",
    mutate: ({ evidence }) => ({ ...evidence, ticketDigest: "deadbeef" }),
  },
  {
    name: "wrong registryPrincipalId identity",
    mutate: ({ evidence }) => ({ ...evidence, registryPrincipalId: "someone-else" }),
  },
  {
    name: "wrong workItemId identity",
    mutate: ({ evidence }) => ({ ...evidence, workItemId: "other-work-item" }),
  },
  {
    name: "wrong specRevision identity",
    mutate: ({ evidence }) => ({ ...evidence, specRevision: evidence.specRevision + 1 }),
  },
  {
    name: "wrong runId identity",
    mutate: ({ evidence }) => ({ ...evidence, runId: "other-run" }),
  },
  {
    name: "wrong reservationId identity",
    mutate: ({ evidence }) => ({ ...evidence, reservationId: "other-reservation" }),
  },
  {
    name: "wrong reservationVersion identity",
    mutate: ({ evidence }) => ({ ...evidence, reservationVersion: evidence.reservationVersion + 1 }),
  },
  {
    name: "scope does not match the strict frozen ticket",
    mutate: ({ evidence }) => ({
      ...evidence,
      scope: { ...evidence.scope, owned: [...evidence.scope.owned, "extra/path.ts"] },
    }),
  },
  {
    name: "model does not match the strict frozen ticket",
    mutate: ({ evidence }) => ({
      ...evidence,
      model: { ...evidence.model, reasoningEffort: "high" },
    }),
  },
  {
    name: "model rationale does not match the strict frozen ticket",
    mutate: ({ evidence }) => ({
      ...evidence,
      model: { ...evidence.model, rationale: "a materially different rationale text" },
    }),
  },
  {
    name: "model rationale is missing",
    mutate: ({ evidence }) => ({
      ...evidence,
      model: { eligibleModels: evidence.model.eligibleModels, reasoningEffort: evidence.model.reasoningEffort },
    }),
  },
  {
    name: "model rationale is a non-string",
    mutate: ({ evidence }) => ({
      ...evidence,
      model: { ...evidence.model, rationale: 12345 },
    }),
  },
  {
    name: "budgets do not match the strict frozen ticket",
    mutate: ({ evidence }) => ({
      ...evidence,
      budgets: { ...evidence.budgets, maxAttempts: evidence.budgets.maxAttempts + 1 },
    }),
  },
  {
    name: "missing evidenceReference",
    mutate: ({ evidence }) => ({ ...evidence, evidenceReference: "" }),
  },
  {
    name: "missing evidenceDigest",
    mutate: ({ evidence }) => ({ ...evidence, evidenceDigest: "" }),
  },
  {
    name: "malformed observedAt timestamp",
    mutate: ({ evidence }) => ({ ...evidence, observedAt: "not-a-timestamp" }),
  },
  {
    name: "observedAt in the future relative to the trusted clock",
    mutate: ({ evidence }) => ({
      ...evidence,
      observedAt: new Date(TRUSTED_NOW + 60_000).toISOString(),
    }),
  },
  {
    name: "expiresAt before observedAt",
    mutate: ({ evidence }) => ({
      ...evidence,
      expiresAt: new Date(Date.parse(evidence.observedAt) - 1000).toISOString(),
    }),
  },
  {
    name: "evidence already expired relative to the trusted clock",
    mutate: () => ({
      ...baseline().evidence,
      observedAt: new Date(TRUSTED_NOW - 600_000).toISOString(),
      expiresAt: new Date(TRUSTED_NOW - 1000).toISOString(),
    }),
  },
  {
    name: "quota.verified is false",
    mutate: ({ evidence }) => ({
      ...evidence,
      quota: { ...evidence.quota, verified: false },
    }),
  },
  {
    name: "quota.verified is a truthy non-boolean",
    mutate: ({ evidence }) => ({
      ...evidence,
      quota: { ...evidence.quota, verified: 1 },
    }),
  },
  {
    name: "quota availability is not a finite safe integer",
    mutate: ({ evidence }) => ({
      ...evidence,
      quota: { ...evidence.quota, availableContextTokens: Number.POSITIVE_INFINITY },
    }),
  },
  {
    name: "context.verified is false",
    mutate: ({ evidence }) => ({
      ...evidence,
      context: { ...evidence.context, verified: false },
    }),
  },
  {
    name: "context.supportedModels does not cover the eligible ticket model",
    mutate: ({ evidence }) => ({
      ...evidence,
      context: { ...evidence.context, supportedModels: ["unsupported-model"] },
    }),
  },
  {
    name: "context.supportedReasoningEfforts does not cover the ticket effort",
    mutate: ({ evidence }) => ({
      ...evidence,
      context: { ...evidence.context, supportedReasoningEfforts: ["low"] },
    }),
  },
  {
    name: "confinement.verified is false",
    mutate: ({ evidence }) => ({
      ...evidence,
      confinement: { ...evidence.confinement, verified: false },
    }),
  },
  {
    name: "confinement.supportedScopeOwned does not cover the owned ticket scope",
    mutate: ({ evidence }) => ({
      ...evidence,
      confinement: { ...evidence.confinement, supportedScopeOwned: [] },
    }),
  },
  {
    name: "confinement.supportedScopeForbidden does not cover the forbidden ticket scope",
    mutate: ({ evidence }) => ({
      ...evidence,
      confinement: { ...evidence.confinement, supportedScopeForbidden: [] },
    }),
  },
  {
    name: "evidence is not an object",
    mutate: () => null,
  },
];

test("refuses: expected ticket changed while ticketDigest is stale, even though candidate evidence agrees with the changed ticket", () => {
  const { ticket, ticketDigest, binding, evidence } = baseline();
  const changedTicket: WorkerTicket = {
    ...ticket,
    objective: "A materially different objective than before",
  };
  assert.throws(
    () =>
      validateDirectLaunchCapabilityEvidence(evidence, {
        ticket: changedTicket,
        ticketDigest,
        binding,
        trustedNowMillis: TRUSTED_NOW,
        maxEvidenceAgeSeconds: MAX_AGE_SECONDS,
      }),
    DirectAdmissionRefusedError,
  );
});

test("refuses: expected ticket is a malformed/unsupported schema even though a freshly computed digest and matching evidence/binding agree with it", () => {
  const { ticket } = baseline();
  const malformedTicket = {
    ...ticket,
    acceptanceCriteria: "not-an-array",
  } as unknown as WorkerTicket;
  const malformedDigest = computeTicketDigest(malformedTicket);
  const malformedBinding = makeBinding(malformedDigest);
  const matchingEvidence = makeValidEvidence(ticket, malformedDigest, malformedBinding);
  assert.throws(
    () =>
      validateDirectLaunchCapabilityEvidence(matchingEvidence, {
        ticket: malformedTicket,
        ticketDigest: malformedDigest,
        binding: malformedBinding,
        trustedNowMillis: TRUSTED_NOW,
        maxEvidenceAgeSeconds: MAX_AGE_SECONDS,
      }),
    DirectAdmissionRefusedError,
  );
});

test("refuses: expected ticketDigest does not match the computed digest of the expected ticket", () => {
  const { ticket, binding, evidence } = baseline();
  assert.throws(
    () =>
      validateDirectLaunchCapabilityEvidence(evidence, {
        ticket,
        ticketDigest: "deadbeef",
        binding,
        trustedNowMillis: TRUSTED_NOW,
        maxEvidenceAgeSeconds: MAX_AGE_SECONDS,
      }),
    DirectAdmissionRefusedError,
  );
});

for (const { name, mutate } of INVALID_CASES) {
  test(`refuses: ${name}`, () => {
    const ctx = baseline();
    const candidate = mutate(ctx);
    assert.throws(
      () =>
        validateDirectLaunchCapabilityEvidence(candidate, {
          ticket: ctx.ticket,
          ticketDigest: ctx.ticketDigest,
          binding: ctx.binding,
          trustedNowMillis: TRUSTED_NOW,
          maxEvidenceAgeSeconds: MAX_AGE_SECONDS,
        }),
      DirectAdmissionRefusedError,
    );
  });
}
