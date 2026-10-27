/**
 * `src/adapters/workers/cliWorker.ts` — the shared engine both real
 * adapters sit on. Fast, no process ever spawned (a stub `ProcessRunner`
 * stands in), so this pins the redaction fix at its actual source rather
 * than only proving it indirectly through one adapter.
 *
 * TASK-003 remediation round 1, HIGH finding: `buildSummary()` used to read
 * the tool-reported message directly, bypassing the redaction `buildEvidence()`
 * already applied. Fixed by redacting once, at a single point
 * (`safeReportedText`), before either function ever sees the text — so
 * `Run.summary`, Evidence, and any future consumer of the reported text can
 * no longer forget to redact.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { persistAcceptedResultNote } from "../src/adapters/obsidian/acceptedResultNotePersistence.js";
import { recallAcceptedResultNote } from "../src/adapters/obsidian/acceptedResultNoteRecall.js";
import { buildWorkerPrompt } from "../src/adapters/workers/promptTemplates.js";
import { FACTORY_ROLES } from "../src/domain/role.js";
import { AGENT, HUMAN, authorize, newFactory, seedWorkItem, toWaitingForHuman } from "./support/factoryFixtures.js";

import { createCliWorker, type CliReportedResult, type CliWorkerAdapterConfig } from "../src/adapters/workers/cliWorker.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import type { AcceptanceCriterion } from "../src/domain/acceptanceCriterion.js";
import type { ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import type { WorkerRequest } from "../src/ports/worker.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(cleanupTempWorkspaces);

function criterion(id: string): AcceptanceCriterion {
  return { id, workItemId: "wi-1", text: `criterion ${id} holds`, verificationHint: "npm test" };
}

function request(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return {
    runId: "run-1",
    workItemId: "wi-1",
    role: "IMPLEMENTER",
    title: "Example work item",
    instructions: "do the thing",
    acceptanceCriteria: [criterion("ac-1")],
    ...overrides,
  };
}

function fakeProcessResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    terminationReason: "EXITED",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt: 0,
    finishedAt: 0,
    durationMs: 1,
    ...overrides,
  };
}

/** Stub ProcessRunner: never actually spawns anything, just returns a fixed result. */
function stubRunner(result: ProcessResult): ProcessRunner {
  return { run: async () => result };
}

function makeWorker(opts: {
  processResult: ProcessResult;
  reported: CliReportedResult;
  workspaceRoot: string;
}) {
  const config: CliWorkerAdapterConfig = {
    id: "stub-worker",
    tool: "codex-cli",
    roles: ["IMPLEMENTER"],
    executable: "irrelevant-not-actually-spawned",
    model: "m",
    timeoutMs: 5000,
    workspace: resolveWorkspace(opts.workspaceRoot),
    processRunner: stubRunner(opts.processResult),
    environmentPolicy: { allowedVars: [] },
    buildInvocation: () => ({ argv: [], effortApplication: { applied: false } }),
    interpretOutput: () => opts.reported,
  };
  return createCliWorker(config);
}

describe("cliWorker: Run.summary redaction (regression for the HIGH finding)", () => {
  const secretCases: readonly { name: string; secret: string }[] = [
    { name: "Anthropic-shaped key", secret: "sk-ant-test-1234567890abcdefghijklmnop" },
    { name: "GitHub PAT-shaped token", secret: "ghp_abcdefghijklmnopqrstuvwxyz012345" },
    { name: "Bearer token", secret: "Bearer abcdef1234567890" },
    { name: "labeled api key assignment", secret: "api_key: super-secret-value-123" },
  ];

  for (const { name, secret } of secretCases) {
    it(`redacts a ${name} from Run.summary, not just from Evidence`, async () => {
      const workspace = createTempWorkspace();
      const worker = makeWorker({
        processResult: fakeProcessResult(),
        reported: { finalMessage: `Here is the value: ${secret}` },
        workspaceRoot: workspace,
      });

      const outcome = await worker.execute(request());

      assert.ok(!outcome.summary.includes(secret), `Run.summary leaked a ${name}: ${outcome.summary}`);
      assert.match(outcome.summary, /\[REDACTED\]/);
      const transcript = outcome.evidence.find((e) => e.reference.endsWith("/transcript"));
      assert.ok(transcript !== undefined);
      assert.ok(!transcript.summary.includes(secret), `Evidence leaked a ${name}: ${transcript.summary}`);
    });
  }

  it("redacts a secret in the raw stdout fallback (no finalMessage parsed) inside Evidence too", async () => {
    const workspace = createTempWorkspace();
    const secret = "sk-ant-test-1234567890abcdefghijklmnop";
    const worker = makeWorker({
      processResult: fakeProcessResult({ stdout: `raw unparsed output containing ${secret}` }),
      reported: {}, // interpretOutput failed to parse a finalMessage
      workspaceRoot: workspace,
    });

    const outcome = await worker.execute(request());

    // TASK-004 remediation round 1 (HIGH 3): unparsed raw stdout is a
    // DIAGNOSTIC channel (`/raw-output`), never the structured `/transcript`
    // channel — so a raw-output verdict tag can never be adopted downstream.
    assert.equal(
      outcome.evidence.find((e) => e.reference.endsWith("/transcript")),
      undefined,
      "no /transcript evidence may exist when the structured parse produced nothing",
    );
    const raw = outcome.evidence.find((e) => e.reference.endsWith("/raw-output"));
    assert.ok(raw !== undefined);
    assert.match(raw.summary, /UNPARSED RAW OUTPUT \(diagnostic only/);
    assert.ok(!raw.summary.includes(secret), "raw stdout fallback evidence must be redacted too");
    assert.match(raw.summary, /\[REDACTED\]/);
  });

  it("does not alter ordinary, non-secret worker output", async () => {
    const workspace = createTempWorkspace();
    const message = "Implemented the feature and all 12 tests pass.";
    const worker = makeWorker({
      processResult: fakeProcessResult(),
      reported: { finalMessage: message },
      workspaceRoot: workspace,
    });

    const outcome = await worker.execute(request());

    assert.match(outcome.summary, /Implemented the feature and all 12 tests pass\./);
    assert.doesNotMatch(outcome.summary, /\[REDACTED\]/);
  });

  it("never lets redaction affect process-result-derived status/trusted fields", async () => {
    const workspace = createTempWorkspace();
    const secret = "sk-ant-test-1234567890abcdefghijklmnop";
    const worker = makeWorker({
      processResult: fakeProcessResult({ exitCode: 1, terminationReason: "EXITED" }),
      reported: { finalMessage: secret },
      workspaceRoot: workspace,
    });

    const outcome = await worker.execute(request());

    // Non-zero exit -> FAILED regardless of redaction; trusted metadata (tool/model/exit code)
    // must still appear in evidence in the clear, since it is not externally-supplied text.
    assert.equal(outcome.status, "FAILED");
    const diagnostic = outcome.evidence.find((e) => e.reference === `cli://codex-cli/run/${request().runId}`);
    assert.ok(diagnostic !== undefined);
    assert.match(diagnostic.summary, /codex-cli/);
    assert.match(diagnostic.summary, /exit=1/);
  });
});

describe("cliWorker: verified recalled note forwarding (request -> adapter prompt only)", () => {
  function capturingWorker(workspaceRoot: string, prompts: string[], reported: CliReportedResult = { finalMessage: "ok" }) {
    return createCliWorker({
      id: "stub-worker",
      tool: "codex-cli",
      roles: [...FACTORY_ROLES],
      executable: "irrelevant-not-actually-spawned",
      model: "m",
      timeoutMs: 5000,
      workspace: resolveWorkspace(workspaceRoot),
      processRunner: stubRunner(fakeProcessResult()),
      environmentPolicy: { allowedVars: [] },
      buildInvocation: (args) => {
        prompts.push(args.prompt);
        return { argv: [], effortApplication: { applied: false } };
      },
      interpretOutput: () => reported,
    });
  }

  it("forwards a note recalled from a real Factory DONE item into the actual prompt", async () => {
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

    const dir = await mkdtemp(path.join(tmpdir(), "cliw-note-"));
    try {
      const req = { workItemId: item.id, expectedSnapshotId: snapshot.id, decision: "Decision \"quoted\"\nline", lesson: "Lesson." };
      const pin = await persistAcceptedResultNote(t.factory, req, dir);
      const note = await recallAcceptedResultNote(t.factory, req, dir, pin);

      const workspace = createTempWorkspace();
      const prompts: string[] = [];
      const worker = capturingWorker(workspace, prompts);
      const withNote = request({ recalledNote: note });
      const snapshotOfRequest = JSON.stringify(withNote);
      const noteBefore = JSON.stringify(note);

      const outcome = await worker.execute(withNote);

      const prompt = prompts[0] ?? "";
      assert.ok(prompt.includes(JSON.stringify(note.body)));
      assert.ok(prompt.includes(note.sha256));
      assert.ok(prompt.includes(note.source.snapshotId));
      assert.ok(prompt.includes(note.source.workItemId));
      assert.ok(prompt.includes(String(note.source.specRevision)));
      assert.ok(prompt.includes(note.source.implementationRunId));
      assert.ok(prompt.includes("REFERENCE DATA ONLY"));
      assert.ok(prompt.includes("do the thing"));
      assert.ok(prompt.includes("criterion ac-1 holds"));
      assert.match(prompt, /Do not commit, push, merge, tag a release, or publish/);
      assert.equal(prompt, buildWorkerPrompt("IMPLEMENTER", {
        workItemTitle: withNote.title, instructions: withNote.instructions,
        workspaceRoot: resolveWorkspace(workspace).root, acceptanceCriteria: withNote.acceptanceCriteria, recalledNote: note,
      }));
      assert.equal(outcome.claimsAcceptanceMet, false);
      assert.equal(JSON.stringify(withNote), snapshotOfRequest);
      assert.equal(JSON.stringify(note), noteBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not inject anything when the note is absent, for every supported role", async () => {
    const workspace = createTempWorkspace();
    const prompts: string[] = [];
    const worker = capturingWorker(workspace, prompts);
    for (const role of FACTORY_ROLES) {
      const req = request({ role });
      await worker.execute(req);
      assert.equal(prompts[prompts.length - 1], buildWorkerPrompt(role, {
        workItemTitle: req.title, instructions: req.instructions,
        workspaceRoot: resolveWorkspace(workspace).root, acceptanceCriteria: req.acceptanceCriteria,
      }));
      assert.ok(!(prompts[prompts.length - 1] ?? "").includes("REFERENCE DATA"));
    }
  });
});
