/**
 * Adoption of PHASE7-109's ProcessRunner aggregate output ceiling at the
 * shared CLI worker constructor (CliWorkerAdapterConfig.maxTotalOutputBytes).
 * Real NodeProcessRunner + real child fixture throughout; the fake-authority
 * scaffolding below is copied/adapted from
 * tests/directHostAdmissionHandle.test.ts and goes through the actual
 * exported createDirectHostAdmissionChannel()/channel.issue() — an offline
 * behavioral fixture, never live grant evidence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createCliWorker, type CliReportedResult } from "../src/adapters/workers/cliWorker.js";
import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import type { WorkerRequest } from "../src/ports/worker.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { DEFAULT_WORKER_ENVIRONMENT_POLICY } from "../src/adapters/workers/environmentPolicy.js";
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
import { fakeCliInvocation } from "./support/fakeCli.js";
import { createTempWorkspace, cleanupTempWorkspaces } from "./support/tempWorkspace.js";

const runner = createNodeProcessRunner({ killGraceMs: 100 });

function interpretOutput(processResult: ProcessResult): CliReportedResult {
  return processResult.stdout.length > 0 ? { finalMessage: processResult.stdout } : {};
}

// --- copied/adapted fake-authority scaffolding from tests/directHostAdmissionHandle.test.ts ---

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

function makeDirectHostRequest(overrides: Partial<DirectHostLaunchRequest> = {}): DirectHostLaunchRequest {
  const ticket = makeTicket();
  return {
    ticketReference: "ref-1" as DirectHostLaunchRequest["ticketReference"],
    registryPrincipalId: "principal-1",
    workItemId: "wi-1" as DirectHostLaunchRequest["workItemId"],
    specRevision: 1,
    runId: "run-1" as DirectHostLaunchRequest["runId"],
    role: "IMPLEMENTER" as DirectHostLaunchRequest["role"],
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

function makeFakeAuthority(opts: { grant?: DirectHostLaunchGrant; ready?: boolean } = {}) {
  const grant = opts.grant ?? makeGrant();
  const calls = { atomicConsumeLaunch: 0 };
  const authority: DirectLaunchAuthorityPort & {
    resolveAndReserve: (r: DirectHostLaunchRequest) => Promise<DirectHostLaunchGrant>;
    revalidate: (g: DirectHostLaunchGrant, r: DirectHostLaunchRequest) => Promise<void>;
    cancel: (b: DirectLaunchBinding) => Promise<void>;
  } = {
    async resolveAndReserve() {
      return grant;
    },
    async revalidate() {
      // no-op: matches the baseline fixture's non-mutating revalidate
    },
    async checkReadiness() {
      return opts.ready ?? true;
    },
    async atomicConsumeLaunch(binding: DirectLaunchBinding) {
      calls.atomicConsumeLaunch++;
      if (calls.atomicConsumeLaunch > 1) throw new Error("already consumed");
      return { binding, consumedAt: "2026-01-01T00:00:00.000Z" } as DirectLaunchReceipt;
    },
    async cancel() {
      // no-op
    },
  };
  return { authority, calls };
}

// --- end copied scaffolding ---

function makeWorkerRequest(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return {
    runId: "run-1" as WorkerRequest["runId"],
    workItemId: "wi-1" as WorkerRequest["workItemId"],
    role: "IMPLEMENTER",
    title: "demo task",
    instructions: "do the work",
    acceptanceCriteria: [],
    ...overrides,
  };
}

function countingRunner(real: ProcessRunner, counter: { launches: number }): ProcessRunner {
  return {
    run(request: ProcessRequest) {
      counter.launches++;
      return real.run(request);
    },
  };
}

test("genuine issued handle + configured aggregate ceiling: real mixed-stream child exceeding it yields FAILED with OUTPUT_LIMIT evidence, authority consumed exactly once", async () => {
  const workspace = resolveWorkspace(createTempWorkspace());
  try {
    const { authority, calls } = makeFakeAuthority();
    const channel = createDirectHostAdmissionChannel(authority, async (_binding, r) => r);
    const handle = await channel.issue(makeDirectHostRequest());

    const invocation = fakeCliInvocation("large-output.mjs", [String(50_000), String(50_000)]);
    const worker = createCliWorker({
      id: "demo-worker",
      tool: "claude-code",
      roles: ["IMPLEMENTER"],
      executable: invocation.executable,
      model: "demo-model",
      timeoutMs: 10_000,
      workspace,
      processRunner: runner,
      environmentPolicy: DEFAULT_WORKER_ENVIRONMENT_POLICY,
      maxTotalOutputBytes: 60_000,
      buildInvocation: () => ({ argv: invocation.argv, effortApplication: { applied: false } }),
      interpretOutput,
      directAdmissionChannel: channel,
    });

    const outcome = await worker.execute(makeWorkerRequest({ directAdmissionHandle: handle }));

    assert.equal(outcome.status, "FAILED");
    assert.ok(
      outcome.evidence.some((entry) => entry.summary.includes("OUTPUT_LIMIT")),
      "evidence must surface the OUTPUT_LIMIT diagnostic derived from ProcessResult.outputLimitExceeded",
    );
    assert.equal(outcome.claimsAcceptanceMet, false, "failure evidence must never become an acceptance claim");
    assert.equal(calls.atomicConsumeLaunch, 1, "the same-channel authority must be consumed exactly once");
  } finally {
    cleanupTempWorkspaces();
  }
});

test("genuine issued handle + omitted aggregate ceiling: same real mixed-stream child succeeds, no OUTPUT_LIMIT", async () => {
  const workspace = resolveWorkspace(createTempWorkspace());
  try {
    const { authority, calls } = makeFakeAuthority();
    const channel = createDirectHostAdmissionChannel(authority, async (_binding, r) => r);
    const handle = await channel.issue(makeDirectHostRequest());

    const invocation = fakeCliInvocation("large-output.mjs", [String(50_000), String(50_000)]);
    const worker = createCliWorker({
      id: "demo-worker",
      tool: "claude-code",
      roles: ["IMPLEMENTER"],
      executable: invocation.executable,
      model: "demo-model",
      timeoutMs: 10_000,
      workspace,
      processRunner: runner,
      environmentPolicy: DEFAULT_WORKER_ENVIRONMENT_POLICY,
      buildInvocation: () => ({ argv: invocation.argv, effortApplication: { applied: false } }),
      interpretOutput,
      directAdmissionChannel: channel,
    });

    const outcome = await worker.execute(makeWorkerRequest({ directAdmissionHandle: handle }));

    assert.equal(outcome.status, "SUCCEEDED");
    assert.ok(
      !outcome.evidence.some((entry) => entry.summary.includes("OUTPUT_LIMIT")),
      "no OUTPUT_LIMIT diagnostic when the aggregate ceiling is omitted",
    );
    assert.equal(calls.atomicConsumeLaunch, 1);
  } finally {
    cleanupTempWorkspaces();
  }
});

test("missing admission channel or missing handle refuses before any process launch", async () => {
  const workspace = resolveWorkspace(createTempWorkspace());
  try {
    const invocation = fakeCliInvocation("large-output.mjs", ["0", "0"]);
    const counter = { launches: 0 };
    const guardedRunner = countingRunner(runner, counter);

    const workerNoChannel = createCliWorker({
      id: "demo-worker",
      tool: "claude-code",
      roles: ["IMPLEMENTER"],
      executable: invocation.executable,
      model: "demo-model",
      timeoutMs: 10_000,
      workspace,
      processRunner: guardedRunner,
      environmentPolicy: DEFAULT_WORKER_ENVIRONMENT_POLICY,
      maxTotalOutputBytes: 1_000,
      buildInvocation: () => ({ argv: invocation.argv, effortApplication: { applied: false } }),
      interpretOutput,
    });
    await assert.rejects(
      workerNoChannel.execute(makeWorkerRequest({ directAdmissionHandle: { ticketDigest: "x" } })),
    );

    const { authority } = makeFakeAuthority();
    const channel = createDirectHostAdmissionChannel(authority, async (_binding, r) => r);
    const workerNoHandle = createCliWorker({
      id: "demo-worker",
      tool: "claude-code",
      roles: ["IMPLEMENTER"],
      executable: invocation.executable,
      model: "demo-model",
      timeoutMs: 10_000,
      workspace,
      processRunner: guardedRunner,
      environmentPolicy: DEFAULT_WORKER_ENVIRONMENT_POLICY,
      maxTotalOutputBytes: 1_000,
      buildInvocation: () => ({ argv: invocation.argv, effortApplication: { applied: false } }),
      interpretOutput,
      directAdmissionChannel: channel,
    });
    await assert.rejects(workerNoHandle.execute(makeWorkerRequest()));

    assert.equal(counter.launches, 0, "no process may ever launch when channel or handle is missing");
  } finally {
    cleanupTempWorkspaces();
  }
});

test("invalid aggregate ceiling is refused at worker construction: authority consume stays 0, process launch stays 0", async () => {
  const workspace = resolveWorkspace(createTempWorkspace());
  try {
    const { authority, calls } = makeFakeAuthority();
    const channel = createDirectHostAdmissionChannel(authority, async (_binding, r) => r);
    const invocation = fakeCliInvocation("large-output.mjs", ["0", "0"]);
    const counter = { launches: 0 };
    const guardedRunner = countingRunner(runner, counter);

    for (const invalid of [0, -5, 1.5, NaN, Infinity]) {
      assert.throws(() =>
        createCliWorker({
          id: "demo-worker",
          tool: "claude-code",
          roles: ["IMPLEMENTER"],
          executable: invocation.executable,
          model: "demo-model",
          timeoutMs: 10_000,
          workspace,
          processRunner: guardedRunner,
          environmentPolicy: DEFAULT_WORKER_ENVIRONMENT_POLICY,
          maxTotalOutputBytes: invalid,
          buildInvocation: () => ({ argv: invocation.argv, effortApplication: { applied: false } }),
          interpretOutput,
          directAdmissionChannel: channel,
        }),
      );
    }

    assert.equal(calls.atomicConsumeLaunch, 0, "an invalid cap must never reach the authority");
    assert.equal(counter.launches, 0, "an invalid cap must never reach a process launch");
  } finally {
    cleanupTempWorkspaces();
  }
});
