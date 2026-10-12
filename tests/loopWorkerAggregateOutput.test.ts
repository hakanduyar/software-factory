/**
 * Adoption of maxTotalOutputBytes on createLoopWorker (loopWorkerFactory.ts),
 * as distinct from the concrete-adapter coverage in
 * concreteCliAggregateOutput.test.ts. Reuses that file's real
 * NodeProcessRunner + fake-CLI + createDirectHostAdmissionChannel
 * scaffolding; the factory has no environmentPolicy option, so the big
 * fixture message is injected by a ProcessRunner wrapper that replaces
 * request.env outright with only the test-owned FAKE_CLAUDE_MESSAGE/
 * FAKE_CODEX_MESSAGE entry, never forwarding ambient process environment.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createLoopWorker } from "../src/orchestration/loopWorkerFactory.js";
import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import type { WorkerRequest } from "../src/ports/worker.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import {
  createDirectHostAdmissionChannel,
  type DirectHostLaunchRequest,
  type DirectHostLaunchGrant,
  type DirectHostAuthorityPort,
} from "../src/supervision/directWorkerAdmission.js";
import { computeTicketDigest, type WorkerTicket } from "../src/supervision/workerContract.js";
import type { DirectLaunchBinding, DirectLaunchReceipt } from "../src/ports/worker.js";
import { fakeCliPath } from "./support/fakeCli.js";
import { createTempWorkspace, cleanupTempWorkspaces } from "./support/tempWorkspace.js";
import type { LoopWorkerConfig } from "../src/orchestration/loopTypes.js";

const runner = createNodeProcessRunner({ killGraceMs: 100 });

/** Prepends the requested fake-cli executable to argv and runs it through process.execPath, avoiding shebang/PATH dependency while every other process request field passes through unchanged. */
function scriptRunner(real: ProcessRunner): ProcessRunner {
  return {
    run(request: ProcessRequest): Promise<ProcessResult> {
      return real.run({ ...request, executable: process.execPath, argv: [request.executable, ...request.argv] });
    },
  };
}

/** The factory has no environmentPolicy option, so this wrapper is the only place a fixture's FAKE_*_MESSAGE variable can be injected for this test — it replaces request.env outright rather than extending it, so no ambient secret ever reaches the child. */
function fakeMessageOnlyEnvRunner(real: ProcessRunner, envVar: string, value: string): ProcessRunner {
  return {
    run(request: ProcessRequest): Promise<ProcessResult> {
      return real.run({ ...request, env: { [envVar]: value } });
    },
  };
}

function makeTicket(): WorkerTicket {
  return {
    schemaVersion: "1.0.0",
    ticketId: "ticket-1",
    objective: "do it thoroughly and well",
    acceptanceCriteria: [{ id: "ac-1", version: "1.0.0", description: "work is done" }],
    scope: { owned: ["src/a.ts"], forbidden: [], read: [], dependencies: [], validation: ["npm test"] },
    model: { eligibleModels: ["model-a"], reasoningEffort: "low", rationale: "stable baseline" },
    budgets: { contextTokens: 1000, outputTokens: 500, elapsedSeconds: 60, maxAttempts: 1 },
    policy: { checkpoint: "checkpoint", stopConditions: ["done"], escalation: "human" },
    resultSchema: { requiredFields: ["schemaVersion", "ticketId"], maxResultBytes: 2048 },
  } as WorkerTicket;
}

function makeDirectHostRequest(): DirectHostLaunchRequest {
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
  };
}

function makeGrant(): DirectHostLaunchGrant {
  const ticket = makeTicket();
  const ticketDigest = computeTicketDigest(ticket);
  const binding: DirectLaunchBinding = {
    ticketDigest,
    registryPrincipalId: "principal-1",
    workItemId: "wi-1",
    specRevision: 1,
    runId: "run-1",
    reservationId: "res-1",
    reservationVersion: 1,
  } as unknown as DirectLaunchBinding;
  return {
    ticket,
    ticketDigest,
    binding,
    evidence: {
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
    },
  };
}

function makeFakeAuthority() {
  const grant = makeGrant();
  const calls = { atomicConsumeLaunch: 0 };
  const authority: DirectHostAuthorityPort<DirectHostLaunchRequest, DirectHostLaunchGrant> = {
    async resolveAndReserve(_request: DirectHostLaunchRequest) {
      return grant;
    },
    async revalidate(_grant: DirectHostLaunchGrant, _request: DirectHostLaunchRequest) {
      // no-op
    },
    async checkReadiness() {
      return true;
    },
    async atomicConsumeLaunch(binding: DirectLaunchBinding) {
      calls.atomicConsumeLaunch++;
      if (calls.atomicConsumeLaunch > 1) throw new Error("already consumed");
      return { binding, consumedAt: "2026-01-01T00:00:00.000Z" } as DirectLaunchReceipt;
    },
    async cancel(_binding: DirectLaunchBinding) {
      // no-op
    },
  };
  return { authority, calls };
}

function makeWorkerRequest(directAdmissionHandle: unknown): WorkerRequest {
  return {
    runId: "run-1" as WorkerRequest["runId"],
    workItemId: "wi-1" as WorkerRequest["workItemId"],
    role: "IMPLEMENTER",
    title: "demo task",
    instructions: "do the work",
    acceptanceCriteria: [],
    directAdmissionHandle,
  } as unknown as WorkerRequest;
}

const ADAPTERS = [
  { name: "claude-code", tool: "claude-code" as const, fixture: "fake-claude.mjs", envVar: "FAKE_CLAUDE_MESSAGE" },
  { name: "codex-cli", tool: "codex-cli" as const, fixture: "fake-codex.mjs", envVar: "FAKE_CODEX_MESSAGE" },
] as const;

for (const adapter of ADAPTERS) {
  test(`createLoopWorker(${adapter.name}): configured aggregate cap fails OUTPUT_LIMIT on real large fixture output`, async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    try {
      const { authority, calls } = makeFakeAuthority();
      const channel = createDirectHostAdmissionChannel(authority, async (_binding: DirectLaunchBinding, r: DirectHostLaunchRequest) => r);
      const handle = await channel.issue(makeDirectHostRequest());
      const bigMessage = "x".repeat(50_000);

      const config: LoopWorkerConfig = { tool: adapter.tool, model: "demo-model" };
      const worker = createLoopWorker(config, {
        workspace,
        processRunner: fakeMessageOnlyEnvRunner(scriptRunner(runner), adapter.envVar, bigMessage),
        roles: ["IMPLEMENTER"],
        executable: fakeCliPath(adapter.fixture),
        maxTotalOutputBytes: 100,
        directAdmissionChannel: channel,
      });

      const outcome = await worker.execute(makeWorkerRequest(handle));

      assert.equal(outcome.status, "FAILED");
      assert.ok(outcome.evidence.some((entry) => entry.summary.includes("OUTPUT_LIMIT")));
      assert.equal(outcome.claimsAcceptanceMet, false);
      assert.equal(calls.atomicConsumeLaunch, 1);
    } finally {
      cleanupTempWorkspaces();
    }
  });

  test(`createLoopWorker(${adapter.name}): omitted aggregate cap succeeds on same real large fixture output`, async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    try {
      const { authority, calls } = makeFakeAuthority();
      const channel = createDirectHostAdmissionChannel(authority, async (_binding: DirectLaunchBinding, r: DirectHostLaunchRequest) => r);
      const handle = await channel.issue(makeDirectHostRequest());
      const bigMessage = "x".repeat(50_000);

      const config: LoopWorkerConfig = { tool: adapter.tool, model: "demo-model" };
      const worker = createLoopWorker(config, {
        workspace,
        processRunner: fakeMessageOnlyEnvRunner(scriptRunner(runner), adapter.envVar, bigMessage),
        roles: ["IMPLEMENTER"],
        executable: fakeCliPath(adapter.fixture),
        directAdmissionChannel: channel,
      });

      const outcome = await worker.execute(makeWorkerRequest(handle));

      assert.equal(outcome.status, "SUCCEEDED");
      assert.ok(!outcome.evidence.some((entry) => entry.summary.includes("OUTPUT_LIMIT")));
      assert.equal(calls.atomicConsumeLaunch, 1);
    } finally {
      cleanupTempWorkspaces();
    }
  });

  test(`createLoopWorker(${adapter.name}): invalid aggregate cap refuses at construction, authority consume stays 0, process launch stays 0`, async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    try {
      const { authority, calls } = makeFakeAuthority();
      const channel = createDirectHostAdmissionChannel(authority, async (_binding: DirectLaunchBinding, r: DirectHostLaunchRequest) => r);
      const counter = { launches: 0 };
      const guardedRunner: ProcessRunner = {
        run(request: ProcessRequest) {
          counter.launches++;
          return scriptRunner(runner).run(request);
        },
      };

      const config: LoopWorkerConfig = { tool: adapter.tool, model: "demo-model" };
      assert.throws(() =>
        createLoopWorker(config, {
          workspace,
          processRunner: guardedRunner,
          roles: ["IMPLEMENTER"],
          executable: fakeCliPath(adapter.fixture),
          maxTotalOutputBytes: -5,
          directAdmissionChannel: channel,
        }),
      );

      assert.equal(calls.atomicConsumeLaunch, 0, "an invalid cap must never reach the authority");
      assert.equal(counter.launches, 0, "an invalid cap must never reach a process launch");
    } finally {
      cleanupTempWorkspaces();
    }
  });

  test(`createLoopWorker(${adapter.name}): missing admission channel or missing handle refuses before any process launch`, async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    try {
      const counter = { launches: 0 };
      const guardedRunner: ProcessRunner = {
        run(request: ProcessRequest) {
          counter.launches++;
          return scriptRunner(runner).run(request);
        },
      };

      const config: LoopWorkerConfig = { tool: adapter.tool, model: "demo-model" };
      const workerNoChannel = createLoopWorker(config, {
        workspace,
        processRunner: guardedRunner,
        roles: ["IMPLEMENTER"],
        executable: fakeCliPath(adapter.fixture),
        maxTotalOutputBytes: 1_000,
      });
      await assert.rejects(workerNoChannel.execute(makeWorkerRequest({ ticketDigest: "x" })));

      const { authority } = makeFakeAuthority();
      const channel = createDirectHostAdmissionChannel(authority, async (_binding: DirectLaunchBinding, r: DirectHostLaunchRequest) => r);
      const workerNoHandle = createLoopWorker(config, {
        workspace,
        processRunner: guardedRunner,
        roles: ["IMPLEMENTER"],
        executable: fakeCliPath(adapter.fixture),
        maxTotalOutputBytes: 1_000,
        directAdmissionChannel: channel,
      });
      await assert.rejects(workerNoHandle.execute(makeWorkerRequest(undefined)));

      assert.equal(counter.launches, 0, "no process may ever launch when channel or handle is missing");
    } finally {
      cleanupTempWorkspaces();
    }
  });
}
