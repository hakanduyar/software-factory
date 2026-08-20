/**
 * End-to-end proof that the real CLI-backed adapters (spawning a fake CLI
 * process, never a real AI provider) satisfy `FactoryService.runWorker`'s
 * existing three-phase lifecycle (TASK-001/002) exactly the same way the
 * deterministic mock worker does — trusted-principal binding, same-run
 * finalization, and reviewer independence (C4) with two genuinely distinct
 * process-backed workers (a Codex-backed "implementer" and a Claude-backed
 * "reviewer").
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
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const worker = codexWorker();
    factory.registerWorker(worker, ["IMPLEMENTER"]);

    const { run, evidence } = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "implement the thing",
    });

    assert.equal(run.status, "SUCCEEDED");
    assert.ok(evidence.length > 0);
    assert.equal((await factory.getWorkItem(item.id)).status, "IMPLEMENTING", "runWorker never changes work item status");
    assert.equal(run.claimsAcceptanceMet, false);
  });

  it("finalizes the same run as FAILED, not RUNNING, on a non-zero exit — no thrown exception needed", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const worker = codexWorker({ environmentPolicy: { allowedVars: ["PATH"], extraVars: { FAKE_CODEX_MODE: "fail" } } });
    factory.registerWorker(worker, ["IMPLEMENTER"]);

    const { run } = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "implement the thing",
    });

    assert.equal(run.status, "FAILED");
    const runs = await factory.listRuns(item.id);
    assert.equal(runs.length, 1);
    assert.notEqual(runs[0]?.status, "RUNNING");
  });

  it("finalizes the same run as FAILED on timeout", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const worker = codexWorker({
      timeoutMs: 100,
      environmentPolicy: { allowedVars: ["PATH"], extraVars: { FAKE_CODEX_SLEEP_MS: "5000" } },
    });
    factory.registerWorker(worker, ["IMPLEMENTER"]);

    const { run } = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "implement the thing",
    });

    assert.equal(run.status, "FAILED");
  });

  it("finalizes the same run as FAILED when the executable cannot be spawned at all", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const worker = codexWorker({ executable: "/definitely/not/a/real/codex/binary" });
    factory.registerWorker(worker, ["IMPLEMENTER"]);

    const { run } = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "implement the thing",
    });

    assert.equal(run.status, "FAILED");
    assert.ok((await factory.listEvidence(item.id)).some((e) => /SPAWN_ERROR/.test(e.summary)));
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
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const implementer = codexWorker();
    factory.registerWorker(implementer, ["IMPLEMENTER"]);
    const implementation = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: implementer,
      instructions: "implement",
    });
    assert.equal(implementation.run.status, "SUCCEEDED");

    const reviewer = claudeWorker();
    factory.registerWorker(reviewer, ["REVIEWER"]);
    const review = await factory.runWorker({
      workItemId: item.id,
      role: "REVIEWER",
      worker: reviewer,
      instructions: "review",
      againstRunId: implementation.run.id,
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
  });

  it("refuses a Claude-backed worker reviewing its own Claude-backed implementation (C4)", async () => {
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const sameWorker = claudeWorker({ roles: ["IMPLEMENTER", "REVIEWER"] });
    factory.registerWorker(sameWorker);
    const implementation = await factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker: sameWorker,
      instructions: "implement",
    });
    const selfReview = await factory.runWorker({
      workItemId: item.id,
      role: "REVIEWER",
      worker: sameWorker,
      instructions: "review your own work",
      againstRunId: implementation.run.id,
    });

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
    const { factory } = newFactory();
    const item = await seedWorkItem(factory);
    await toImplementing(factory, item.id);

    const buggyWorker = {
      id: "buggy",
      capabilities: { roles: ["IMPLEMENTER"] as const, deterministic: false },
      execute() {
        throw new Error("adapter programmer error, not a process result");
      },
    };
    factory.registerWorker(buggyWorker);

    await assert.rejects(
      factory.runWorker({ workItemId: item.id, role: "IMPLEMENTER", worker: buggyWorker, instructions: "implement" }),
      WorkerExecutionError,
    );
    const runs = await factory.listRuns(item.id);
    assert.equal(runs[0]?.status, "FAILED");
  });
});
