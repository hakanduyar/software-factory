/**
 * FactoryService.runWorker forwards a caller-SELECTED recalled note (service
 * input -> WorkerRequest -> real CLI adapter prompt). No selection, ranking or
 * acceptance happens in the service; the real recall verifier is the caller's.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { persistAcceptedResultNote } from "../src/adapters/obsidian/acceptedResultNotePersistence.js";
import { recallAcceptedResultNote } from "../src/adapters/obsidian/acceptedResultNoteRecall.js";
import { createCliWorker } from "../src/adapters/workers/cliWorker.js";
import { buildWorkerPrompt } from "../src/adapters/workers/promptTemplates.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { FACTORY_ROLES } from "../src/domain/role.js";
import type { ProcessResult } from "../src/ports/processRunner.js";
import {
  AGENT, HUMAN, authorize, newFactory, seedWorkItem, toImplementing, toWaitingForHuman,
} from "./support/factoryFixtures.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(cleanupTempWorkspaces);

const owned: string[] = [];
after(async () => {
  for (const d of owned.splice(0)) await rm(d, { recursive: true, force: true });
});

const PROCESS_RESULT: ProcessResult = {
  terminationReason: "EXITED", exitCode: 0, signal: null, stdout: "", stderr: "",
  stdoutTruncated: false, stderrTruncated: false, startedAt: 0, finishedAt: 0, durationMs: 1,
};

async function setup() {
  const t = newFactory();
  const source = await seedWorkItem(t.factory);
  await toWaitingForHuman(t.factory, source.id);
  const snapshot = await t.factory.releaseSnapshot(source.id);
  assert.ok(snapshot !== undefined);
  await t.factory.recordApproval({
    gate: "RELEASE_APPROVAL", subject: t.factory.workItemSubject(source.id),
    decision: "APPROVED", actor: HUMAN, authorization: authorize(t.factory),
  });
  await t.factory.advance(source.id, "DONE", AGENT);

  const dir = await mkdtemp(path.join(tmpdir(), "fsw-note-"));
  owned.push(dir);
  const req = { workItemId: source.id, expectedSnapshotId: snapshot.id, decision: "Decision \"q\"\nline", lesson: "Lesson." };
  const pin = await persistAcceptedResultNote(t.factory, req, dir);
  const note = await recallAcceptedResultNote(t.factory, req, dir, pin);

  const target = await t.factory.createWorkItem({
    projectId: source.projectId, title: "Distinct target", type: "FEATURE", planVersion: "test-v1",
    acceptanceCriteria: [{ text: "Target behaviour holds", verificationHint: "npm test" }],
  });
  await toImplementing(t.factory, target.id);

  const prompts: string[] = [];
  const runningAtExecute: string[] = [];
  const workspace = createTempWorkspace();
  const worker = createCliWorker({
    id: "stub-cli", tool: "codex-cli", roles: [...FACTORY_ROLES],
    executable: "irrelevant-not-actually-spawned", model: "m", timeoutMs: 5000,
    workspace: resolveWorkspace(workspace),
    processRunner: {
      run: async () => {
        const runs = await t.factory.listRuns(target.id);
        runningAtExecute.push(...runs.filter((r) => r.status === "RUNNING").map((r) => r.id));
        return PROCESS_RESULT;
      },
    },
    environmentPolicy: { allowedVars: [] },
    buildInvocation: (args) => {
      prompts.push(args.prompt);
      return { argv: [], effortApplication: { applied: false } };
    },
    interpretOutput: () => ({ finalMessage: "ok" }),
  });
  t.factory.registerWorker(worker);
  return { ...t, source, target, note, worker, prompts, runningAtExecute, workspace };
}

describe("FactoryService.runWorker recalled-note forwarding", () => {
  it("forwards the explicit note to a distinct target; running record durable first; no new authority", async () => {
    const s = await setup();
    const { factory, source, target } = s;
    const noteJson = JSON.stringify(s.note);
    const sourceBefore = JSON.stringify([await factory.getWorkItem(source.id), await factory.releaseSnapshot(source.id)]);
    const gatesBefore = JSON.stringify(await factory.listApprovals(factory.workItemSubject(source.id)));

    const result = await factory.runWorker({
      workItemId: target.id, role: "IMPLEMENTER", worker: s.worker, instructions: "TARGET do the thing", recalledNote: s.note,
    });

    const prompt = s.prompts[0] ?? "";
    assert.ok(prompt.includes(JSON.stringify(s.note.body)));
    assert.ok(prompt.includes(s.note.sha256));
    assert.ok(prompt.includes(s.note.source.snapshotId));
    assert.ok(prompt.includes(s.note.source.workItemId));
    assert.ok(prompt.includes(s.note.source.implementationRunId));
    assert.ok(prompt.includes("TARGET do the thing"));
    assert.ok(prompt.includes("Target behaviour holds"));
    assert.equal(prompt, buildWorkerPrompt("IMPLEMENTER", {
      workItemTitle: "Distinct target", instructions: "TARGET do the thing",
      workspaceRoot: resolveWorkspace(s.workspace).root,
      acceptanceCriteria: await factory.listCriteria(target.id), recalledNote: s.note,
    }));
    assert.deepEqual(s.runningAtExecute, [result.run.id]);
    assert.equal(result.run.status, "SUCCEEDED");
    assert.equal(result.run.claimsAcceptanceMet, false);
    assert.equal((await factory.getWorkItem(target.id))?.status, "IMPLEMENTING");
    assert.equal(JSON.stringify([await factory.getWorkItem(source.id), await factory.releaseSnapshot(source.id)]), sourceBefore);
    assert.equal(JSON.stringify(await factory.listApprovals(factory.workItemSubject(source.id))), gatesBefore);
    assert.equal(JSON.stringify(s.note), noteJson);
  });

  it("absent note leaves the prompt exactly as the old shape", async () => {
    const s = await setup();
    await s.factory.runWorker({ workItemId: s.target.id, role: "IMPLEMENTER", worker: s.worker, instructions: "TARGET do the thing" });
    assert.equal(s.prompts[0], buildWorkerPrompt("IMPLEMENTER", {
      workItemTitle: "Distinct target", instructions: "TARGET do the thing",
      workspaceRoot: resolveWorkspace(s.workspace).root,
      acceptanceCriteria: await s.factory.listCriteria(s.target.id),
    }));
    assert.ok(!s.prompts[0]?.includes("REFERENCE DATA ONLY"));
  });

  it("worker sees the synchronous owned snapshot despite caller mutation during START", async () => {
    const s = await setup();
    const mutable = JSON.parse(JSON.stringify(s.note)) as { body: string; sha256: string; byteLength: number; source: { snapshotId: string; workItemId: string; specRevision: number; implementationRunId: string } };
    const original = JSON.parse(JSON.stringify(s.note)) as typeof mutable;
    const pending = s.factory.runWorker({
      workItemId: s.target.id, role: "IMPLEMENTER", worker: s.worker, instructions: "TARGET do the thing",
      recalledNote: { ...mutable, extra: "x" } as never,
    });
    mutable.body = "TAMPERED";
    mutable.sha256 = "0".repeat(64);
    mutable.source.snapshotId = "snap-evil";
    await pending;
    const prompt = s.prompts[0] ?? "";
    assert.ok(prompt.includes(JSON.stringify(original.body)));
    assert.ok(prompt.includes(original.sha256));
    assert.ok(prompt.includes(original.source.snapshotId));
    assert.ok(!prompt.includes("TAMPERED") && !prompt.includes("snap-evil"));
  });

  it("existing refusals still reach neither worker nor stub", async () => {
    const s = await setup();
    // wrong role capability
    const { registeredWorker } = await import("./support/factoryFixtures.js");
    const verifierOnly = registeredWorker(s.factory, "only-verifier", ["VERIFIER"]);
    await assert.rejects(s.factory.runWorker({
      workItemId: s.target.id, role: "IMPLEMENTER", worker: verifierOnly, instructions: "x", recalledNote: s.note,
    }));
    // non-operable / non-startable target: the DONE source cannot start an implementer
    await assert.rejects(s.factory.runWorker({
      workItemId: s.source.id, role: "IMPLEMENTER", worker: s.worker, instructions: "x", recalledNote: s.note,
    }));
    assert.equal(s.prompts.length, 0);
    assert.equal(s.runningAtExecute.length, 0);
  });
});
