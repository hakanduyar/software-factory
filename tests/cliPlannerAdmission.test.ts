/**
 * PHASE7-116: cliPlannerWorker's mandatory constructor-trusted admissionSource.
 * Exercises refusal before createWorker/process when admissionSource is
 * absent, refusal on each prepared-request mismatch, same-channel/opaque
 * handle forwarding, cancellation on construction/execute failure preserving
 * the original error, and two real offline-child positives (NodeProcessRunner
 * + fake-cli fixtures) consuming the admission exactly once.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  createCliPlannerWorker,
  type CliPlannerAdmissionSource,
  type CliPlannerWorkerDeps,
} from "../src/adapters/planning/cliPlannerWorker.js";
import { createClaudeCodeWorker } from "../src/adapters/workers/claudeCodeAdapter.js";
import { createCodexCliWorker } from "../src/adapters/workers/codexCliAdapter.js";
import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import { DEFAULT_WORKER_ENVIRONMENT_POLICY } from "../src/adapters/workers/environmentPolicy.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import type { Worker } from "../src/ports/worker.js";
import type { PlannerRequest } from "../src/planning/plannerWorker.js";
import { parsePlannerOutput } from "../src/planning/plannerOutputContract.js";
import type { DirectHostAdmissionSurface, DirectHostLaunchRequest } from "../src/supervision/directWorkerAdmission.js";
import { fakeCliPath } from "./support/fakeCli.js";
import { createTempWorkspace, cleanupTempWorkspaces } from "./support/tempWorkspace.js";
import { createSyntheticPlannerAdmissionSource } from "./support/plannerAdmissionFixtures.js";

after(cleanupTempWorkspaces);

const nodeRunner = createNodeProcessRunner({ killGraceMs: 100 });

function scriptRunner(real: ProcessRunner): ProcessRunner {
  return {
    run(request: ProcessRequest): Promise<ProcessResult> {
      return real.run({ ...request, executable: process.execPath, argv: [request.executable, ...request.argv] });
    },
  };
}

function countingRunner(real: ProcessRunner): { runner: ProcessRunner; calls: { count: number } } {
  const calls = { count: 0 };
  return {
    calls,
    runner: {
      run(request: ProcessRequest) {
        calls.count++;
        return real.run(request);
      },
    },
  };
}

function baseRequest(overrides: Partial<PlannerRequest> = {}): PlannerRequest {
  return {
    planId: "plan-1",
    revision: 1,
    attempt: 1,
    correlationTag: "corr-1",
    projectKey: "proj",
    intent: "do the thing",
    constraints: [],
    answeredQuestions: [],
    projectRules: [],
    outputContract: "contract",
    ...overrides,
  };
}

describe("cliPlannerWorker: mandatory constructor admission source", () => {
  it("refuses before createWorker or any process when admissionSource is absent", async () => {
    const { calls: processCalls, runner: guardedRunner } = countingRunner(nodeRunner);
    let createCalls = 0;
    const worker = createCliPlannerWorker({
      tool: "claude-code",
      model: "demo-model",
      workspace: resolveWorkspace(createTempWorkspace()),
      processRunner: guardedRunner,
      createWorker: () => {
        createCalls++;
        throw new Error("must not be called");
      },
    });

    await assert.rejects(worker.plan(baseRequest()));
    assert.equal(createCalls, 0);
    assert.equal(processCalls.count, 0);
  });

  const MISMATCHES: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (req: DirectHostLaunchRequest) => DirectHostLaunchRequest;
  }> = [
    { name: "role", mutate: (r) => ({ ...r, role: "IMPLEMENTER" as DirectHostLaunchRequest["role"] }) },
    {
      name: "workItemId",
      mutate: (r) => ({ ...r, workItemId: "wrong-plan" as unknown as DirectHostLaunchRequest["workItemId"] }),
    },
    {
      name: "runId",
      mutate: (r) => ({ ...r, runId: "wrong-corr" as unknown as DirectHostLaunchRequest["runId"] }),
    },
    { name: "specRevision", mutate: (r) => ({ ...r, specRevision: 999 }) },
    { name: "model", mutate: (r) => ({ ...r, model: { ...r.model, eligibleModels: ["other-model"] } }) },
    { name: "effort", mutate: (r) => ({ ...r, model: { ...r.model, reasoningEffort: "high" } }) },
  ];

  for (const mismatch of MISMATCHES) {
    it(`refuses before any process when the prepared request mismatches on ${mismatch.name}`, async () => {
      const { source } = createSyntheticPlannerAdmissionSource({ model: "demo-model", effort: "low" });
      const admissionSource: CliPlannerAdmissionSource = {
        channel: source.channel,
        prepareRequest: async (request) => mismatch.mutate(await source.prepareRequest(request)),
      };
      const { calls: processCalls, runner: guardedRunner } = countingRunner(nodeRunner);

      const worker = createCliPlannerWorker({
        tool: "claude-code",
        model: "demo-model",
        effort: "low",
        workspace: resolveWorkspace(createTempWorkspace()),
        processRunner: guardedRunner,
        admissionSource,
      });

      await assert.rejects(worker.plan(baseRequest()));
      assert.equal(processCalls.count, 0);
    });
  }

  it("forwards the exact channel as createWorker's 4th arg and the issued handle as directAdmissionHandle", async () => {
    const { source } = createSyntheticPlannerAdmissionSource({ model: "demo-model" });
    let observedChannel: DirectHostAdmissionSurface | undefined;
    let observedHandle: unknown;

    const worker = createCliPlannerWorker({
      tool: "claude-code",
      model: "demo-model",
      workspace: resolveWorkspace(createTempWorkspace()),
      processRunner: nodeRunner,
      admissionSource: source,
      createWorker: (_config, _workspace, _processRunner, channel) => {
        observedChannel = channel;
        const fakeWorker: Worker = {
          id: "fake",
          capabilities: { roles: ["PLANNER"], deterministic: true },
          async execute(request) {
            observedHandle = request.directAdmissionHandle;
            return { status: "SUCCEEDED", summary: "ok", evidence: [], claimsAcceptanceMet: true };
          },
        };
        return fakeWorker;
      },
    });

    await worker.plan(baseRequest());
    assert.equal(observedChannel, source.channel);
    assert.ok(observedHandle !== undefined);
  });

  it("cancels the issued handle, preserving the original error, when createWorker throws", async () => {
    const { source } = createSyntheticPlannerAdmissionSource({ model: "demo-model" });
    let cancelled = false;
    const wrappedChannel: DirectHostAdmissionSurface = {
      ...source.channel,
      async cancel(handle) {
        cancelled = true;
        return source.channel.cancel(handle);
      },
    };
    const admissionSource: CliPlannerAdmissionSource = { channel: wrappedChannel, prepareRequest: source.prepareRequest };

    const worker = createCliPlannerWorker({
      tool: "claude-code",
      model: "demo-model",
      workspace: resolveWorkspace(createTempWorkspace()),
      processRunner: nodeRunner,
      admissionSource,
      createWorker: () => {
        throw new Error("construction boom");
      },
    });

    await assert.rejects(worker.plan(baseRequest()), /construction boom/);
    assert.equal(cancelled, true);
  });

  it("cancels the issued handle, preserving the original error, when worker.execute throws", async () => {
    const { source } = createSyntheticPlannerAdmissionSource({ model: "demo-model" });
    let cancelled = false;
    const wrappedChannel: DirectHostAdmissionSurface = {
      ...source.channel,
      async cancel(handle) {
        cancelled = true;
        return source.channel.cancel(handle);
      },
    };
    const admissionSource: CliPlannerAdmissionSource = { channel: wrappedChannel, prepareRequest: source.prepareRequest };

    const worker = createCliPlannerWorker({
      tool: "claude-code",
      model: "demo-model",
      workspace: resolveWorkspace(createTempWorkspace()),
      processRunner: nodeRunner,
      admissionSource,
      createWorker: () => {
        const fakeWorker: Worker = {
          id: "fake",
          capabilities: { roles: ["PLANNER"], deterministic: true },
          async execute() {
            throw new Error("execute boom");
          },
        };
        return fakeWorker;
      },
    });

    await assert.rejects(worker.plan(baseRequest()), /execute boom/);
    assert.equal(cancelled, true);
  });

  it("captures constructor model/effort/channel/preparation once; retained-alias mutation during prepareRequest's await cannot switch them mid-plan", async () => {
    const { source: sourceA } = createSyntheticPlannerAdmissionSource({ model: "demo-model", effort: "low" });
    const { source: sourceB } = createSyntheticPlannerAdmissionSource({ model: "other-model", effort: "high" });
    let issuedOnA = 0;
    let issuedOnB = 0;
    const channelA: DirectHostAdmissionSurface = {
      ...sourceA.channel,
      async issue(request) {
        issuedOnA++;
        return sourceA.channel.issue(request);
      },
    };
    const channelB: DirectHostAdmissionSurface = {
      ...sourceB.channel,
      async issue(request) {
        issuedOnB++;
        return sourceB.channel.issue(request);
      },
    };

    type MutableAdmissionSource = {
      -readonly [K in keyof CliPlannerAdmissionSource]: CliPlannerAdmissionSource[K];
    };
    const mutableAdmissionSource: MutableAdmissionSource = {
      channel: channelA,
      async prepareRequest(request) {
        const prepared = await sourceA.prepareRequest(request);
        // Mutate the SAME options object the constructor was given, and the
        // admission source's own channel property, during this await —
        // after construction has already captured its own locals but before
        // issue/create/execute run.
        options.model = "other-model";
        options.effort = "high";
        mutableAdmissionSource.channel = channelB;
        return prepared;
      },
    };

    let observedChannel: DirectHostAdmissionSurface | undefined;
    let observedModel: string | undefined;
    let observedEffort: string | undefined;

    // ONE retained options object, built before construction and passed
    // directly (no spread), so the mutation above during the awaited
    // prepareRequest targets the exact object the constructor read from.
    type MutableCliPlannerWorkerDeps = {
      -readonly [K in keyof CliPlannerWorkerDeps]: CliPlannerWorkerDeps[K];
    };
    const options: MutableCliPlannerWorkerDeps = {
      tool: "claude-code",
      model: "demo-model",
      effort: "low",
      workspace: resolveWorkspace(createTempWorkspace()),
      processRunner: nodeRunner,
      admissionSource: mutableAdmissionSource,
      createWorker: (config, _workspace, _processRunner, channel) => {
        observedChannel = channel;
        observedModel = config.model;
        observedEffort = config.effort;
        const fakeWorker: Worker = {
          id: "fake",
          capabilities: { roles: ["PLANNER"], deterministic: true },
          async execute() {
            return { status: "SUCCEEDED", summary: "ok", evidence: [], claimsAcceptanceMet: true };
          },
        };
        return fakeWorker;
      },
    };

    const worker = createCliPlannerWorker(options);

    const outcome = await worker.plan(baseRequest());
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(observedChannel, channelA);
    assert.equal(observedModel, "demo-model");
    assert.equal(observedEffort, "low");
    assert.equal(issuedOnA, 1);
    assert.equal(issuedOnB, 0);
  });

  const TOOLS = [
    { tool: "claude-code" as const, create: createClaudeCodeWorker, fixture: "fake-claude.mjs", envVar: "FAKE_CLAUDE_MESSAGE" },
    { tool: "codex-cli" as const, create: createCodexCliWorker, fixture: "fake-codex.mjs", envVar: "FAKE_CODEX_MESSAGE" },
  ];

  for (const { tool, create, fixture, envVar } of TOOLS) {
    it(`${tool}: real NodeProcessRunner + fake CLI consumes the admission exactly once on a successful bounded plan`, async () => {
      const { source, calls } = createSyntheticPlannerAdmissionSource({ model: "demo-model" });
      const workspace = resolveWorkspace(createTempWorkspace());
      const plan = {
        summary: "A sufficiently long plan summary.",
        assumptions: [],
        constraints: [],
        risks: [],
        blockingQuestions: [],
        items: [
          {
            key: "WI-A",
            title: "Do the thing",
            type: "FEATURE",
            priority: "P2",
            spec: "spec",
            acceptanceCriteria: [{ text: "done", verificationHint: "check" }],
            dependsOn: [],
          },
        ],
      };
      const message = `FACTORY_PLAN_V1\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`;

      const worker = createCliPlannerWorker({
        tool,
        model: "demo-model",
        workspace,
        processRunner: nodeRunner,
        admissionSource: source,
        createWorker: (config, ws, processRunner, channel) =>
          create({
            executable: fakeCliPath(fixture),
            model: config.model,
            workspace: ws,
            processRunner: scriptRunner(processRunner),
            environmentPolicy: {
              ...DEFAULT_WORKER_ENVIRONMENT_POLICY,
              allowedVars: [],
              extraVars: { [envVar]: message },
            },
            maxEvidenceChars: 100_000,
            directAdmissionChannel: channel,
          }),
      });

      const outcome = await worker.plan(baseRequest());
      assert.equal(outcome.status, "SUCCEEDED");
      const parsed = parsePlannerOutput(outcome.rawOutput);
      assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
      assert.equal(calls.atomicConsumeLaunch, 1);
    });
  }
});
