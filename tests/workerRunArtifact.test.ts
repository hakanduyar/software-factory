/**
 * DEFECT-DURABLE-WORKER-RUN-ENVELOPE AC-5 — the bounded, redacted, atomic
 * terminal artifact, against a REAL filesystem.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  readWorkerRunArtifact,
  workerRunArtifactPath,
  writeWorkerRunArtifact,
} from "../src/adapters/supervision/workerRunArtifact.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "worker-run-artifact-"));
}

it("C6-H4: action binding and durable hash reject freshly rehashed foreign or replaced artifacts", () => {
  const path = workerRunArtifactPath(tempDir(), "a1:wr1");
  const data = { runId: "a1:wr1", actionId: "a1", exitCode: 0, signal: null,
    terminationReason: "EXITED", detail: "ok", at: 100 };
  const original = writeWorkerRunArtifact(path, data);
  assert.equal(readWorkerRunArtifact(path, "a1:wr1", "a1", original.hash).kind, "FOUND");
  writeWorkerRunArtifact(path, { ...data, actionId: "foreign" });
  assert.equal(readWorkerRunArtifact(path, "a1:wr1", "a1").kind, "UNUSABLE");
  writeWorkerRunArtifact(path, { ...data, detail: "replacement" });
  assert.equal(readWorkerRunArtifact(path, "a1:wr1", "a1", original.hash).kind, "UNUSABLE");
});

it("C6-H4: invalid timestamp and terminal domain fail closed even with a fresh hash", () => {
  const path = workerRunArtifactPath(tempDir(), "a1:wr1");
  for (const invalid of [{ at: -1 }, { at: Infinity }, { at: 1.5 },
    { terminationReason: "invented" }, { signal: "unknown" }, { exitCode: -1 }]) {
    writeWorkerRunArtifact(path, { runId: "a1:wr1", actionId: "a1", exitCode: 0, signal: null,
      terminationReason: "EXITED", detail: "ok", at: 100, ...invalid });
    assert.equal(readWorkerRunArtifact(path, "a1:wr1", "a1").kind, "UNUSABLE");
  }
});

describe("writeWorkerRunArtifact / readWorkerRunArtifact", () => {
  it("round-trips exactly what was written", () => {
    const dir = tempDir();
    const path = workerRunArtifactPath(dir, "ITEM:implement:a1:wr1");
    writeWorkerRunArtifact(path, {
      runId: "ITEM:implement:a1:wr1",
      actionId: "ITEM:implement:a1",
      exitCode: 0,
      signal: null,
      terminationReason: "EXITED",
      detail: "finished cleanly",
      at: 1000,
    });
    const read = readWorkerRunArtifact(path, "ITEM:implement:a1:wr1");
    assert.equal(read.kind, "FOUND");
    if (read.kind !== "FOUND") return;
    assert.equal(read.data.runId, "ITEM:implement:a1:wr1");
    assert.equal(read.data.exitCode, 0);
    assert.equal(read.data.detail, "finished cleanly");
  });

  it("preserves providerSessionId and terminalReason for a verified MAX_TURNS artifact", () => {
    const dir = tempDir();
    const path = workerRunArtifactPath(dir, "a1:wr1");
    writeWorkerRunArtifact(path, {
      runId: "a1:wr1",
      actionId: "a1",
      exitCode: 0,
      signal: null,
      terminationReason: "EXITED",
      providerSessionId: "sess-max",
      terminalReason: "MAX_TURNS",
      detail: "structured terminal_reason=max_turns",
      at: 1000,
    });
    const read = readWorkerRunArtifact(path, "a1:wr1");
    assert.equal(read.kind, "FOUND");
    if (read.kind !== "FOUND") return;
    assert.equal(read.data.terminalReason, "MAX_TURNS");
    assert.equal(read.data.providerSessionId, "sess-max");
  });

  it("reports NONE when nothing has been written yet", () => {
    const dir = tempDir();
    const path = workerRunArtifactPath(dir, "never-written");
    assert.equal(readWorkerRunArtifact(path, "never-written").kind, "NONE");
  });

  it("REFUSES a foreign artifact: the file exists but names a different run", () => {
    const dir = tempDir();
    const path = workerRunArtifactPath(dir, "run-a");
    writeWorkerRunArtifact(path, {
      runId: "run-a",
      actionId: "a1",
      exitCode: 0,
      signal: null,
      terminationReason: "EXITED",
      detail: "ok",
      at: 1,
    });
    const read = readWorkerRunArtifact(path, "run-b");
    assert.equal(read.kind, "UNUSABLE");
  });

  it("REFUSES a torn write: bytes that disagree with their own recorded hash", () => {
    const dir = tempDir();
    const path = workerRunArtifactPath(dir, "a1:wr1");
    writeWorkerRunArtifact(path, {
      runId: "a1:wr1",
      actionId: "a1",
      exitCode: 0,
      signal: null,
      terminationReason: "EXITED",
      detail: "ok",
      at: 1,
    });
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { data: { detail: string }; hash: string };
    parsed.data.detail = "tampered after the hash was computed";
    writeFileSync(path, JSON.stringify(parsed));
    const read = readWorkerRunArtifact(path, "a1:wr1");
    assert.equal(read.kind, "UNUSABLE");
  });

  it("REFUSES malformed JSON outright", () => {
    const dir = tempDir();
    const path = workerRunArtifactPath(dir, "run-broken");
    writeFileSync(path, "{not json");
    assert.equal(readWorkerRunArtifact(path, "run-broken").kind, "UNUSABLE");
  });

  it("bounds and redacts the detail text before it is hashed", () => {
    const dir = tempDir();
    const path = workerRunArtifactPath(dir, "a1:wr1");
    writeWorkerRunArtifact(path, {
      runId: "a1:wr1",
      actionId: "a1",
      exitCode: 1,
      signal: null,
      terminationReason: "EXITED",
      detail: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWX leaked",
      at: 1,
    });
    const read = readWorkerRunArtifact(path, "a1:wr1");
    assert.equal(read.kind, "FOUND");
    if (read.kind !== "FOUND") return;
    assert.equal(read.data.detail.includes("sk-ant-api03"), false);
  });
});
