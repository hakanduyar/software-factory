/**
 * End-to-end proof that the real CLI-backed adapters (spawning a fake CLI
 * process, never a real AI provider) satisfy `FactoryService.runWorker`'s
 * existing three-phase lifecycle (TASK-001/002) exactly the same way the
 * deterministic mock worker does — trusted-principal binding, same-run
 * finalization, and reviewer independence (C4) with two genuinely distinct
 * process-backed workers (a Codex-backed "implementer" and a Claude-backed
 * "reviewer").
 *
 * D1: these are the real process-backed ("direct") runs, so each worker is
 * registered `requiresDirectAdmission: true` and each runWorker call carries
 * a trusted, test-configured DirectWorkerTicket bound to the exact
 * WorkItem/specRevision/role/principal/criteria in play.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import { createClaudeCodeWorker } from "../src/adapters/workers/claudeCodeAdapter.js";
import { createCodexCliWorker } from "../src/adapters/workers/codexCliAdapter.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { WorkerExecutionError } from "../src/domain/errors.js";
import { newFactory, seedWorkItem, toImplementing } from "./support/factoryFixtures.js";
import { fakeCliPath } from "./support/fakeCli.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";
import {
  buildRuntime,
  makeRetainedAuthority,
  TICKET,
  TICKET_REFERENCE,
  PRESTART_TICKET_REFERENCE,
} from "./support/directRuntimeFixture.js";
import type { DirectHostAdmissionSurface } from "../src/supervision/directWorkerAdmission.js";

after(cleanupTempWorkspaces);

const runner = createNodeProcessRunner({ killGraceMs: 100 });

function codexWorker(overrides: Partial<Parameters<typeof createCodexCliWorker>[0]> = {}) {
  const workspace = resolveWorkspace(createTempWorkspace());
  return createCodexCliWorker({ executable: fakeCliPath("fake-codex.mjs"), model: "gpt-5.6-luna", workspace, processRunner: runner, ...overrides });
}

function claudeWorker(overrides: Partial<Parameters<typeof createClaudeCodeWorker>[0]> = {}) {
  const workspace = resolveWorkspace(createTempWorkspace());
  return createClaudeCodeWorker({ executable: fakeCliPath("fake-claude.mjs"), model: "claude-sonnet-5", workspace, processRunner: runner, ...overrides });
}

describe("worker runner: FactoryService integration with real process-backed adapters", () => {
  it("runs a Codex-backed IMPLEMENTER through the real three-phase lifecycle", async () => {
    const { authority, calls } = makeRetainedAuthority();
    const { factory, store, registerApprovedPrestart } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const codexModel = TICKET.model.eligibleModels[0];
    assert.ok(codexModel !== undefined, "fixture TICKET must declare at least one eligible model");

    const channel = factory.sharedDirectAdmissionChannel;
    assert.ok(channel !== undefined, "buildRuntime must configure a shared trusted admission channel");

    const worker = codexWorker({ model: codexModel, directAdmissionChannel: channel });
    const principal = factory.registerWorker(worker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const criteria = await store.criteria.listByWorkItem(item.id);
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });

    const { run, evidence } = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "implement the thing",
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });

    assert.equal(run.status, "SUCCEEDED");
    assert.ok(evidence.length > 0);
    assert.equal((await factory.getWorkItem(item.id)).status, "IMPLEMENTING", "runWorker never changes work item status");
    assert.equal(run.claimsAcceptanceMet, false);
    assert.equal(calls.atomicConsumeLaunch, 1, "the retained authority's single reservation is consumed exactly once");
  });

  it("refuses a direct-admission-required worker with no ticket — zero spawn, zero abandoned RUNNING", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const worker = codexWorker();
    factory.registerWorker(worker, ["IMPLEMENTER"], { requiresDirectAdmission: true });

    await assert.rejects(
      factory.runWorker({ workItemId: item.id, role: "IMPLEMENTER", worker, instructions: "implement the thing" }),
      { code: "VALIDATION" },
    );
    assert.equal((await factory.listRuns(item.id)).length, 0, "a refused prelaunch must leave no RUNNING run at all");
  });

  it("finalizes the same run as FAILED, not RUNNING, on a non-zero exit — no thrown exception needed", async () => {
    const { authority, calls } = makeRetainedAuthority();
    const { factory, store, registerApprovedPrestart } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const codexModel = TICKET.model.eligibleModels[0];
    assert.ok(codexModel !== undefined, "fixture TICKET must declare at least one eligible model");

    const channel = factory.sharedDirectAdmissionChannel;
    assert.ok(channel !== undefined, "buildRuntime must configure a shared trusted admission channel");

    const worker = codexWorker({
      model: codexModel,
      directAdmissionChannel: channel,
      environmentPolicy: { allowedVars: ["PATH"], extraVars: { FAKE_CODEX_MODE: "fail" } },
    });
    const principal = factory.registerWorker(worker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const criteria = await store.criteria.listByWorkItem(item.id);
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });

    const { run, evidence } = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "implement the thing",
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });

    assert.equal(run.status, "FAILED");
    const runs = await factory.listRuns(item.id);
    assert.equal(runs.length, 1);
    assert.notEqual(runs[0]?.status, "RUNNING");
    assert.equal(calls.atomicConsumeLaunch, 1, "the retained authority's single reservation is consumed exactly once");
    assert.ok(evidence.some((e) => /exit=1/.test(e.summary)), "admitted process path must surface the real nonzero exit code");
  });

  it("finalizes the same run as FAILED on timeout", async () => {
    const { authority, calls } = makeRetainedAuthority();
    const { factory, store, registerApprovedPrestart } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const codexModel = TICKET.model.eligibleModels[0];
    assert.ok(codexModel !== undefined, "fixture TICKET must declare at least one eligible model");

    const channel = factory.sharedDirectAdmissionChannel;
    assert.ok(channel !== undefined, "buildRuntime must configure a shared trusted admission channel");

    const worker = codexWorker({
      model: codexModel,
      directAdmissionChannel: channel,
      timeoutMs: 100,
      environmentPolicy: { allowedVars: ["PATH"], extraVars: { FAKE_CODEX_SLEEP_MS: "5000" } },
    });
    const principal = factory.registerWorker(worker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const criteria = await store.criteria.listByWorkItem(item.id);
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });

    const { run, evidence } = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "implement the thing",
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });

    assert.equal(run.status, "FAILED");
    assert.equal(calls.atomicConsumeLaunch, 1, "the retained authority's single reservation is consumed exactly once");
    assert.ok(evidence.some((e) => /TIMEOUT/.test(e.summary)), "admitted process path must surface the real timeout outcome");
  });

  it("finalizes the same run as FAILED when the executable cannot be spawned at all", async () => {
    const { authority, calls } = makeRetainedAuthority();
    const { factory, store, registerApprovedPrestart } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const codexModel = TICKET.model.eligibleModels[0];
    assert.ok(codexModel !== undefined, "fixture TICKET must declare at least one eligible model");

    const channel = factory.sharedDirectAdmissionChannel;
    assert.ok(channel !== undefined, "buildRuntime must configure a shared trusted admission channel");

    const worker = codexWorker({
      model: codexModel,
      directAdmissionChannel: channel,
      executable: "/definitely/not/a/real/codex/binary",
    });
    const principal = factory.registerWorker(worker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
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
      worker,
      instructions: "implement the thing",
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });

    assert.equal(run.status, "FAILED");
    assert.ok((await factory.listEvidence(item.id)).some((e) => /SPAWN_ERROR/.test(e.summary)));
    assert.equal(calls.atomicConsumeLaunch, 1, "the retained authority's single reservation is consumed exactly once");
  });

  it("keeps two distinct CLI-adapter Worker objects as two distinct trusted principals", async () => {
    const { factory } = newFactory();
    const workerA = codexWorker({ id: "codex-cli" });
    const workerB = codexWorker({ id: "codex-cli" }); // same declared id, different object
    const principalA = factory.registerWorker(workerA, ["IMPLEMENTER"]);
    const principalB = factory.registerWorker(workerB, ["IMPLEMENTER"]);
    assert.notEqual(principalA.principalId, principalB.principalId);
  });

  it("supports an independent semantic review: Codex-backed IMPLEMENTER + Claude-backed REVIEWER", async () => {
    const { authority, calls } = makeRetainedAuthority();
    const { factory, store, registerApprovedPrestart } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const eligibleModel = TICKET.model.eligibleModels[0];
    assert.ok(eligibleModel !== undefined, "fixture TICKET must declare at least one eligible model");

    const channel: DirectHostAdmissionSurface | undefined = factory.sharedDirectAdmissionChannel;
    assert.ok(channel !== undefined, "buildRuntime must configure a shared trusted admission channel");

    const implementer = codexWorker({ model: eligibleModel, directAdmissionChannel: channel });
    const implementerPrincipal = factory.registerWorker(implementer, ["IMPLEMENTER"], { requiresDirectAdmission: true });
    const criteria = await store.criteria.listByWorkItem(item.id);
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal: implementerPrincipal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });
    const implementation = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: implementer,
      instructions: "implement",
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });
    assert.equal(implementation.run.status, "SUCCEEDED");

    const reviewer = claudeWorker({ model: eligibleModel, directAdmissionChannel: channel });
    const reviewerPrincipal = factory.registerWorker(reviewer, ["REVIEWER"], { requiresDirectAdmission: true });
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal: reviewerPrincipal,
      role: "REVIEWER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
      targetRunId: implementation.run.id,
    });
    const review = await factory.runWorker({
      workItemId: item.id,
      role: "REVIEWER",
      worker: reviewer,
      instructions: "review",
      againstRunId: implementation.run.id,
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });
    assert.equal(review.run.status, "SUCCEEDED");
    assert.notEqual(review.run.workerPrincipalId, implementation.run.workerPrincipalId);

    const recorded = await factory.recordReview({
      workItemId: item.id,
      reviewedRunId: implementation.run.id,
      reviewerRunId: review.run.id,
      kind: "SEMANTIC",
      verdict: "PASS",
    });
    assert.equal(recorded.reviewerPrincipalId, review.run.workerPrincipalId);
    assert.equal(recorded.implementerPrincipalId, implementation.run.workerPrincipalId);
    assert.equal(calls.atomicConsumeLaunch, 2, "both the implementer and reviewer launches consume one retained reservation each");
  });

  it("refuses a Claude-backed worker reviewing its own Claude-backed implementation (C4)", async () => {
    const { authority, calls } = makeRetainedAuthority();
    const { factory, store, registerApprovedPrestart } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const eligibleModel = TICKET.model.eligibleModels[0];
    assert.ok(eligibleModel !== undefined, "fixture TICKET must declare at least one eligible model");

    const channel: DirectHostAdmissionSurface | undefined = factory.sharedDirectAdmissionChannel;
    assert.ok(channel !== undefined, "buildRuntime must configure a shared trusted admission channel");

    const sameWorker = claudeWorker({ roles: ["IMPLEMENTER", "REVIEWER"], model: eligibleModel, directAdmissionChannel: channel });
    const principal = factory.registerWorker(sameWorker, ["IMPLEMENTER", "REVIEWER"], { requiresDirectAdmission: true });
    const criteria = await store.criteria.listByWorkItem(item.id);
    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal,
      role: "IMPLEMENTER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
    });
    const implementation = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: sameWorker,
      instructions: "implement",
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });
    assert.equal(implementation.run.status, "SUCCEEDED");

    registerApprovedPrestart({
      reference: PRESTART_TICKET_REFERENCE,
      item: { id: item.id, specRevision: item.specRevision },
      principal,
      role: "REVIEWER",
      criteria,
      dependencyWorkItemIds: item.dependencies,
      targetRunId: implementation.run.id,
    });
    const selfReview = await factory.runWorker({
      workItemId: item.id,
      role: "REVIEWER",
      worker: sameWorker,
      instructions: "review your own work",
      againstRunId: implementation.run.id,
      directTicketReference: TICKET_REFERENCE,
      expectedModel: TICKET.model,
      expectedScope: TICKET.scope,
      expectedBudgets: TICKET.budgets,
    });
    assert.equal(selfReview.run.status, "SUCCEEDED");
    assert.equal(calls.atomicConsumeLaunch, 2, "both the implementer and self-review launches consume one retained reservation each");

    await assert.rejects(
      factory.recordReview({
        workItemId: item.id,
        reviewedRunId: implementation.run.id,
        reviewerRunId: selfReview.run.id,
        kind: "SEMANTIC",
        verdict: "PASS",
      }),
      { code: "REVIEW_INTEGRITY" },
    );
  });

  it("throwing adapter code (a genuine bug, not a process failure) still leaves an honest FAILED run", async () => {
    const { authority, calls } = makeRetainedAuthority();
    const { factory, store, registerApprovedPrestart } = buildRuntime(authority);
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const eligibleModel = TICKET.model.eligibleModels[0];
    assert.ok(eligibleModel !== undefined, "fixture TICKET must declare at least one eligible model");

    const channel: DirectHostAdmissionSurface | undefined = factory.sharedDirectAdmissionChannel;
    assert.ok(channel !== undefined, "buildRuntime must configure a shared trusted admission channel");

    const executeCalls: number[] = [];
    const buggyWorker = {
      id: "buggy",
      capabilities: { roles: ["IMPLEMENTER"] as const, deterministic: false },
      execute() {
        executeCalls.push(executeCalls.length + 1);
        throw new Error("adapter programmer error, not a process result");
      },
    };
    const principal = factory.registerWorker(buggyWorker, ["IMPLEMENTER"], { requiresDirectAdmission: true });
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
        worker: buggyWorker,
        instructions: "implement",
        directTicketReference: TICKET_REFERENCE,
        expectedModel: TICKET.model,
        expectedScope: TICKET.scope,
        expectedBudgets: TICKET.budgets,
      }),
      WorkerExecutionError,
    );
    assert.equal(executeCalls.length, 1, "the real adapter bug must be observed exactly once before it throws");
    const runs = await factory.listRuns(item.id);
    assert.equal(runs[0]?.status, "FAILED");
    assert.equal(calls.atomicConsumeLaunch, 0, "the bug precedes the provider launch, so the reservation is never consumed");
    assert.equal(calls.cancel, 1, "the live admission handle issued before the bug is cancelled, not left dangling");
  });
});
