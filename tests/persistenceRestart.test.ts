/**
 * TASK-002 acceptance criterion 3: state survives closing one store instance
 * and opening a second instance against the same database file.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createSqliteStore } from "../src/adapters/sqlite/sqliteStore.js";
import {
  AGENT,
  HUMAN,
  authorize,
  cleanupTempDbs,
  newSqliteFactory,
  registeredWorker,
  tempDbPath,
  toWaitingForHuman,
} from "./support/factoryFixtures.js";

describe("restart durability", () => {
  after(cleanupTempDbs);

  it("preserves a fully-released work item's version, history, and every linked record across a restart", async () => {
    const dbPath = tempDbPath();
    const instanceA = newSqliteFactory(dbPath);

    const item = await instanceA.factory.createWorkItem({
      projectId: (await instanceA.factory.createProject({ key: "RST", name: "Restart Project" })).id,
      title: "Survives a restart",
      type: "FEATURE",
      planVersion: "v1",
      acceptanceCriteria: [
        { text: "A", verificationHint: "npm test" },
        { text: "B", verificationHint: "npm run typecheck" },
      ],
    });

    const fixture = await toWaitingForHuman(instanceA.factory, item.id);
    await instanceA.factory.recordApproval({
      gate: "RELEASE_APPROVAL",
      subject: instanceA.factory.workItemSubject(item.id),
      decision: "APPROVED",
      actor: HUMAN,
      authorization: authorize(instanceA.factory),
    });
    const done = await instanceA.factory.advance(item.id, "DONE", AGENT);
    const evidenceBefore = await instanceA.factory.listEvidence(item.id);
    const runsBefore = await instanceA.factory.listRuns(item.id);
    const criteriaBefore = await instanceA.factory.listCriteria(item.id);
    const verificationsBefore = await instanceA.factory.listVerifications(item.id);

    // Close instance A entirely — no reference to its store is reused below.
    instanceA.store.close();

    const storeB = createSqliteStore(dbPath);
    const reread = await storeB.workItems.findById(item.id);

    assert.equal(reread?.status, "DONE");
    assert.equal(reread?.version, done.version);
    assert.equal(reread?.specRevision, done.specRevision);
    assert.deepEqual(
      reread?.history.map((entry) => `${entry.from}->${entry.to}`),
      done.history.map((entry) => `${entry.from}->${entry.to}`),
    );
    assert.deepEqual([...(reread?.runIds ?? [])], [...done.runIds]);

    const runsAfter = await storeB.runs.listByWorkItem(item.id);
    assert.deepEqual(
      runsAfter.map((r) => `${r.id}:${r.role}:${r.status}`),
      runsBefore.map((r) => `${r.id}:${r.role}:${r.status}`),
    );

    const evidenceAfter = await storeB.evidence.listByWorkItem(item.id);
    assert.deepEqual(
      evidenceAfter.map((e) => e.id),
      evidenceBefore.map((e) => e.id),
    );

    const reviewsAfter = await storeB.reviews.listByWorkItem(item.id);
    assert.equal(reviewsAfter.length, 2, "deterministic + semantic review must both survive");

    const approvalsAfter = await storeB.approvals.listBySubject({ type: "WORK_ITEM", id: item.id });
    assert.equal(approvalsAfter.length, 2, "PLAN_APPROVAL and RELEASE_APPROVAL must both survive");
    assert.equal(approvalsAfter[approvalsAfter.length - 1]?.context?.snapshotId !== undefined, true);

    const criteriaAfter = await storeB.criteria.listByWorkItem(item.id);
    assert.deepEqual(criteriaAfter.map((c) => c.id), criteriaBefore.map((c) => c.id));

    const verificationsAfter = await storeB.verifications.listByWorkItem(item.id);
    assert.deepEqual(
      verificationsAfter.map((v) => `${v.criterionId}:${v.result}`),
      verificationsBefore.map((v) => `${v.criterionId}:${v.result}`),
    );

    // Everything read back is frozen — the restart path is not exempt.
    assert.ok(Object.isFrozen(reread));
    assert.ok(runsAfter.every((r) => Object.isFrozen(r)));

    void fixture;
    storeB.close();
  });

  it("can continue safely from reopened state: a new FactoryService built on the reopened store enforces the same invariants", async () => {
    const dbPath = tempDbPath();
    const instanceA = newSqliteFactory(dbPath);
    const item = await instanceA.factory.createWorkItem({
      projectId: (await instanceA.factory.createProject({ key: "CONT", name: "Continue Project" })).id,
      title: "Continues after restart",
      type: "FEATURE",
      planVersion: "v1",
      acceptanceCriteria: [{ text: "A", verificationHint: "npm test" }],
    });
    await instanceA.factory.advance(item.id, "ANALYSIS", AGENT);
    await instanceA.factory.advance(item.id, "PLAN_REVIEW", AGENT);
    await instanceA.factory.recordApproval({
      gate: "PLAN_APPROVAL",
      subject: instanceA.factory.workItemSubject(item.id),
      decision: "APPROVED",
      actor: HUMAN,
      authorization: authorize(instanceA.factory),
    });
    instanceA.store.close();

    // A brand new store + FactoryService, no in-process state shared with A.
    const instanceB = newSqliteFactory(dbPath);
    const reread = await instanceB.factory.getWorkItem(item.id);
    assert.equal(reread.status, "PLAN_REVIEW");

    // Continue the workflow: this only works if the reopened store correctly
    // reports the PLAN_APPROVAL that instance A recorded before closing.
    const advanced = await instanceB.factory.advance(item.id, "READY", AGENT);
    assert.equal(advanced.status, "READY");

    // Invariants still hold post-restart: an unauthorized cancellation is
    // still refused, proving the reopened store is wired through the same
    // FactoryService logic, not a degraded read-only view.
    await assert.rejects(instanceB.factory.advance(item.id, "CANCELLED", HUMAN), { code: "HUMAN_IDENTITY" });

    const worker = registeredWorker(instanceB.factory, "worker-after-restart", ["IMPLEMENTER"]);
    await instanceB.factory.advance(item.id, "IMPLEMENTING", AGENT);
    const implementation = await instanceB.factory.runWorker({
      workItemId: item.id,
      role: "IMPLEMENTER",
      worker,
      instructions: "implement after restart",
    });
    assert.equal(implementation.run.status, "SUCCEEDED");

    instanceB.store.close();
  });
});
