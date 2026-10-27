import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it, type TestContext } from "node:test";

import { AcceptedResultNoteRefusal } from "../src/adapters/obsidian/acceptedResultNote.js";
import {
  AcceptedResultNotePersistenceRefusal,
  persistAcceptedResultNote,
} from "../src/adapters/obsidian/acceptedResultNotePersistence.js";
import {
  AGENT, HUMAN, authorize, newFactory, seedWorkItem, toWaitingForHuman,
} from "./support/factoryFixtures.js";

const TEXT = { decision: "Persist exact draft bytes.", lesson: "Never overwrite a differing note." };
const owned: string[] = [];

afterEach(async () => {
  for (const d of owned.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "arn-persist-"));
  owned.push(d);
  return d;
}

async function doneItem() {
  const t = newFactory();
  const item = await seedWorkItem(t.factory);
  await toWaitingForHuman(t.factory, item.id);
  const snapshot = await t.factory.releaseSnapshot(item.id);
  assert.ok(snapshot !== undefined);
  await t.factory.recordApproval({
    gate: "RELEASE_APPROVAL", subject: t.factory.workItemSubject(item.id),
    decision: "APPROVED", actor: HUMAN, authorization: authorize(t.factory),
  });
  await t.factory.advance(item.id, "DONE", AGENT);
  return { ...t, item, snapshotId: snapshot.id };
}

async function code(p: Promise<unknown>, expected: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AcceptedResultNotePersistenceRefusal, String(e));
    assert.ok(e instanceof AcceptedResultNoteRefusal);
    assert.equal((e as AcceptedResultNotePersistenceRefusal).code, expected);
    return true;
  });
}

async function trySymlink(t: TestContext, target: string, link: string, type?: "dir"): Promise<boolean> {
  try {
    await symlink(target, link, type);
    return true;
  } catch (e) {
    const c = (e as NodeJS.ErrnoException).code;
    if (c === "EPERM" || c === "ENOSYS" || c === "EACCES") {
      t.skip(`symlink privilege unavailable (${c})`);
      return false;
    }
    throw e;
  }
}

describe("persistAcceptedResultNote", () => {
  it("creates exact bytes once, then reports EXISTING without mutating the factory", async () => {
    const { factory, item, snapshotId } = await doneItem();
    const dir = await tmp();
    const req = { workItemId: item.id, expectedSnapshotId: snapshotId, ...TEXT };
    const dump = async () => JSON.stringify([
      await factory.getWorkItem(item.id), await factory.listRuns(item.id),
      await factory.listReviews(item.id), await factory.listEvidence(item.id),
      await factory.releaseSnapshot(item.id),
    ]);
    const before = await dump();

    const a = await persistAcceptedResultNote(factory, req, dir);
    const bytes = await readFile(a.path);
    assert.equal(a.status, "CREATED");
    assert.equal(a.byteLength, bytes.length);
    assert.equal(a.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(a.source.snapshotId, snapshotId);
    assert.match(path.basename(a.path), /^[0-9a-f]{64}\.md$/);
    assert.ok(!path.basename(a.path).includes(item.id));
    assert.ok(bytes.toString("utf8").includes("Draft only"));
    assert.ok(!bytes.toString("utf8").startsWith("---"));

    const b = await persistAcceptedResultNote(factory, req, dir);
    assert.equal(b.status, "EXISTING");
    assert.equal(b.path, a.path);
    assert.equal(b.sha256, a.sha256);
    assert.equal((await readdir(dir)).length, 1);
    assert.equal(await dump(), before);
  });

  it("conflicts on changed decision or lesson for the same snapshot and preserves the original", async () => {
    const { factory, item, snapshotId } = await doneItem();
    const dir = await tmp();
    const req = { workItemId: item.id, expectedSnapshotId: snapshotId, ...TEXT };
    const a = await persistAcceptedResultNote(factory, req, dir);
    const original = await readFile(a.path);
    await code(persistAcceptedResultNote(factory, { ...req, decision: "Other decision." }, dir), "CONFLICT");
    await code(persistAcceptedResultNote(factory, { ...req, lesson: "Other lesson." }, dir), "CONFLICT");
    assert.deepEqual(await readFile(a.path), original);
    assert.deepEqual(await readdir(dir), [path.basename(a.path)]);
  });

  it("creates no note for stale snapshot, non-DONE item or unsatisfied approval", async () => {
    const { factory, item, snapshotId } = await doneItem();
    const dir = await tmp();
    await assert.rejects(
      persistAcceptedResultNote(factory, { workItemId: item.id, expectedSnapshotId: "snap-stale", ...TEXT }, dir),
      /stale/,
    );
    const t = newFactory();
    const wi = await seedWorkItem(t.factory);
    await toWaitingForHuman(t.factory, wi.id);
    const snap = await t.factory.releaseSnapshot(wi.id);
    await assert.rejects(
      persistAcceptedResultNote(t.factory, { workItemId: wi.id, expectedSnapshotId: snap?.id ?? "x", ...TEXT }, dir),
      /must be DONE/,
    );
    const noGate = new Proxy(factory, {
      get(target, prop, receiver) {
        if (prop === "assertGateSatisfied") return async () => { throw new Error("no approval"); };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await assert.rejects(
      persistAcceptedResultNote(noGate, { workItemId: item.id, expectedSnapshotId: snapshotId, ...TEXT }, dir),
      /RELEASE_APPROVAL/,
    );
    assert.deepEqual(await readdir(dir), []);
  });

  it("refuses relative, missing and non-directory roots without creating anything", async () => {
    const { factory, item, snapshotId } = await doneItem();
    const req = { workItemId: item.id, expectedSnapshotId: snapshotId, ...TEXT };
    const dir = await tmp();
    await code(persistAcceptedResultNote(factory, req, "relative/dir"), "INVALID_DIRECTORY");
    const missing = path.join(dir, "missing");
    await code(persistAcceptedResultNote(factory, req, missing), "INVALID_DIRECTORY");
    const file = path.join(dir, "plain.txt");
    await writeFile(file, "x");
    await code(persistAcceptedResultNote(factory, req, file), "INVALID_DIRECTORY");
    assert.deepEqual(await readdir(dir), ["plain.txt"]);
  });

  it("refuses non-regular destinations", async () => {
    const { factory, item, snapshotId } = await doneItem();
    const req = { workItemId: item.id, expectedSnapshotId: snapshotId, ...TEXT };
    const dir = await tmp();
    const probe = await persistAcceptedResultNote(factory, req, dir);
    await rm(probe.path);
    await mkdir(probe.path);
    await code(persistAcceptedResultNote(factory, req, dir), "INVALID_DESTINATION");
  });

  it("refuses a symlink root", async (t) => {
    const { factory, item, snapshotId } = await doneItem();
    const dir = await tmp();
    const real = path.join(dir, "real");
    await mkdir(real);
    const link = path.join(dir, "link");
    if (!(await trySymlink(t, real, link, "dir"))) return;
    await code(persistAcceptedResultNote(factory, { workItemId: item.id, expectedSnapshotId: snapshotId, ...TEXT }, link), "INVALID_DIRECTORY");
    assert.deepEqual(await readdir(real), []);
  });

  it("refuses a symlink destination and leaves its target untouched", async (t) => {
    const { factory, item, snapshotId } = await doneItem();
    const req = { workItemId: item.id, expectedSnapshotId: snapshotId, ...TEXT };
    const dir = await tmp();
    const outside = await tmp();
    const probe = await persistAcceptedResultNote(factory, req, dir);
    await rm(probe.path);
    const target = path.join(outside, "target.md");
    await writeFile(target, "untouched");
    if (!(await trySymlink(t, target, probe.path))) return;
    await code(persistAcceptedResultNote(factory, req, dir), "INVALID_DESTINATION");
    assert.equal(await readFile(target, "utf8"), "untouched");
  });
});
