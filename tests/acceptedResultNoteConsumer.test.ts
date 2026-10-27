import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AcceptedResultNoteRefusal } from "../src/adapters/obsidian/acceptedResultNote.js";
import { buildAcceptedResultNoteDraft } from "../src/adapters/obsidian/acceptedResultNoteConsumer.js";
import type { FactoryService } from "../src/app/factoryService.js";
import {
  AGENT, HUMAN, authorize, newFactory, seedWorkItem, toWaitingForHuman,
} from "./support/factoryFixtures.js";

const TEXT = { decision: "Compose reads into the projector.", lesson: "Resolve lineage from the core, not callers." };

async function doneItem() {
  const t = newFactory();
  const item = await seedWorkItem(t.factory);
  const fx = await toWaitingForHuman(t.factory, item.id);
  const snapshot = await t.factory.releaseSnapshot(item.id);
  assert.ok(snapshot !== undefined);
  await t.factory.recordApproval({
    gate: "RELEASE_APPROVAL", subject: t.factory.workItemSubject(item.id),
    decision: "APPROVED", actor: HUMAN, authorization: authorize(t.factory),
  });
  await t.factory.advance(item.id, "DONE", AGENT);
  return { ...t, item, fx, snapshotId: snapshot.id };
}

async function refused(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AcceptedResultNoteRefusal, String(e));
    assert.match((e as Error).message, pattern);
    return true;
  });
}

/** Controlled read fault: overrides one public read on a proxy of the real service. */
function faulty(factory: FactoryService, overrides: Partial<Record<keyof FactoryService, unknown>>): FactoryService {
  return new Proxy(factory, {
    get(target, prop, receiver) {
      if (prop in overrides) return overrides[prop as keyof FactoryService];
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

describe("buildAcceptedResultNoteDraft", () => {
  it("builds an attributable draft from a real DONE work item", async () => {
    const { factory, item, fx, snapshotId } = await doneItem();
    const draft = await buildAcceptedResultNoteDraft(factory, { workItemId: item.id, expectedSnapshotId: snapshotId, ...TEXT });
    assert.equal(draft.inert, true);
    assert.equal(draft.source.snapshotId, snapshotId);
    assert.equal(draft.source.workItemId, item.id);
    assert.equal(draft.source.implementationRunId, fx.implementationRunId);
    assert.equal(draft.source.reviewerRunId, fx.reviewerRunId);
    const impl = (await factory.listRuns(item.id)).find((r) => r.id === fx.implementationRunId);
    assert.ok(impl !== undefined && impl.evidenceIds.length > 0);
    assert.deepEqual(draft.evidence.map((e) => e.id), [...impl.evidenceIds]);
    assert.notEqual(draft.source.implementationPrincipalId, draft.source.reviewerPrincipalId);
    assert.ok(draft.body.includes(snapshotId));
  });

  it("is deterministic and does not mutate repository state", async () => {
    const { factory, item, snapshotId } = await doneItem();
    const dump = async () => JSON.stringify([
      await factory.getWorkItem(item.id), await factory.listRuns(item.id),
      await factory.listReviews(item.id), await factory.listEvidence(item.id),
      await factory.releaseSnapshot(item.id),
    ]);
    const before = await dump();
    const req = { workItemId: item.id, expectedSnapshotId: snapshotId, ...TEXT };
    const a = await buildAcceptedResultNoteDraft(factory, req);
    const b = await buildAcceptedResultNoteDraft(factory, req);
    assert.deepEqual(a, b);
    assert.equal(await dump(), before);
  });

  it("refuses a stale expected snapshot", async () => {
    const { factory, item } = await doneItem();
    await refused(buildAcceptedResultNoteDraft(factory, { workItemId: item.id, expectedSnapshotId: "snap-stale", ...TEXT }), /stale/);
  });

  it("refuses a work item that is not DONE", async () => {
    const t = newFactory();
    const item = await seedWorkItem(t.factory);
    await toWaitingForHuman(t.factory, item.id);
    const snapshot = await t.factory.releaseSnapshot(item.id);
    await refused(buildAcceptedResultNoteDraft(t.factory, {
      workItemId: item.id, expectedSnapshotId: snapshot?.id ?? "x", ...TEXT,
    }), /must be DONE/);
  });

  it("refuses an unknown work item", async () => {
    const { factory } = newFactory();
    await refused(buildAcceptedResultNoteDraft(factory, { workItemId: "wi-missing", expectedSnapshotId: "s", ...TEXT }), /could not read work item/);
  });

  it("refuses when the release approval gate is not satisfied", async () => {
    const { factory, item, snapshotId } = await doneItem();
    const wrapped = faulty(factory, {
      assertGateSatisfied: async () => { throw new Error("no approval recorded"); },
    });
    await refused(buildAcceptedResultNoteDraft(wrapped, { workItemId: item.id, expectedSnapshotId: snapshotId, ...TEXT }), /RELEASE_APPROVAL/);
  });

  it("refuses missing implementation run, review, reviewer run or evidence", async () => {
    const { factory, item, fx, snapshotId } = await doneItem();
    const req = { workItemId: item.id, expectedSnapshotId: snapshotId, ...TEXT };
    const runs = await factory.listRuns(item.id);
    const reviews = await factory.listReviews(item.id);
    const evidence = await factory.listEvidence(item.id);

    await refused(buildAcceptedResultNoteDraft(faulty(factory, {
      listRuns: async () => runs.filter((r) => r.id !== fx.implementationRunId),
    }), req), /implementation run .* not found/);
    await refused(buildAcceptedResultNoteDraft(faulty(factory, {
      listRuns: async () => runs.filter((r) => r.id !== fx.reviewerRunId),
    }), req), /reviewer run .* not found/);
    await refused(buildAcceptedResultNoteDraft(faulty(factory, {
      listReviews: async () => [],
    }), req), /semantic review .* not found/);
    assert.ok(reviews.length > 0);
    await refused(buildAcceptedResultNoteDraft(faulty(factory, {
      listEvidence: async () => evidence.slice(1),
    }), req), /evidence .* not found/);
  });

  it("refuses mismatched lineage records via the projector", async () => {
    const { factory, item, fx, snapshotId } = await doneItem();
    const req = { workItemId: item.id, expectedSnapshotId: snapshotId, ...TEXT };
    const runs = await factory.listRuns(item.id);
    await refused(buildAcceptedResultNoteDraft(faulty(factory, {
      listRuns: async () => runs.map((r) => (r.id === fx.reviewerRunId ? { ...r, targetRunId: "run-other" } : r)),
    }), req), /targetRunId/);
    const evidence = await factory.listEvidence(item.id);
    await refused(buildAcceptedResultNoteDraft(faulty(factory, {
      listEvidence: async () => evidence.map((e, i) => (i === 0 ? { ...e, runId: "run-other" } : e)),
    }), req), /runId/);
  });

  it("refuses when the snapshot drifts during the read", async () => {
    const { factory, item, snapshotId } = await doneItem();
    const real = await factory.releaseSnapshot(item.id);
    assert.ok(real !== undefined);
    let calls = 0;
    const wrapped = faulty(factory, {
      releaseSnapshot: async () => (++calls === 1 ? real : { ...real, id: "snap-drifted" }),
    });
    await refused(buildAcceptedResultNoteDraft(wrapped, { workItemId: item.id, expectedSnapshotId: snapshotId, ...TEXT }), /changed while/);
  });
});
