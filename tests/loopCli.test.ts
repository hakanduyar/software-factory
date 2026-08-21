/**
 * `sf loop` CLI wiring (TASK-004 §12): config-file validation and the
 * illegal-state/not-found rejection paths, which do not require spawning a
 * real Claude/Codex CLI (workers are only constructed once `drive()` starts
 * externally acting, which these cases never reach). Real end-to-end use of
 * an installed CLI is exercised by hand, not by `npm test` — see
 * docs/tasks/TASK-004-autonomous-engineering-loop.md §11 (optional real
 * smoke, deliberately not automated here).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { runLoopCancel, runLoopResume, runLoopStart, runLoopStatus } from "../src/cli/loop.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(() => {
  cleanupTempDbs();
  cleanupTempWorkspaces();
});

const createdConfigDirs: string[] = [];
after(() => {
  while (createdConfigDirs.length > 0) {
    const dir = createdConfigDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function writeConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-loop-cli-test-"));
  createdConfigDirs.push(dir);
  const path = join(dir, "loop-config.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

function dbOptions() {
  return { factoryDbPath: tempDbPath(), loopsDbPath: tempDbPath() };
}

describe("sf loop start — config validation", () => {
  it("rejects invalid JSON", async () => {
    const configPath = writeConfig("{ not json");
    await assert.rejects(runLoopStart("wi-0001", configPath, dbOptions()), /not valid JSON/);
  });

  it("rejects a config that is not a JSON object", async () => {
    const configPath = writeConfig([1, 2, 3]);
    await assert.rejects(runLoopStart("wi-0001", configPath, dbOptions()), /must contain a JSON object/);
  });

  it("requires a workspace field", async () => {
    const configPath = writeConfig({ taskInstructions: "do it" });
    await assert.rejects(runLoopStart("wi-0001", configPath, dbOptions()), /"workspace"/);
  });

  it("requires a taskInstructions field", async () => {
    const configPath = writeConfig({ workspace: "/tmp" });
    await assert.rejects(runLoopStart("wi-0001", configPath, dbOptions()), /"taskInstructions"/);
  });

  it("rejects a verificationCommands entry whose argv is not an array of strings (never a shell string)", async () => {
    const configPath = writeConfig({
      workspace: createTempWorkspace(),
      taskInstructions: "do it",
      verificationCommands: [{ id: "x", executable: "npm", argv: "test --shell-like-string" }],
    });
    await assert.rejects(runLoopStart("wi-0001", configPath, dbOptions()), /argv.*must be an array of strings/);
  });

  it("rejects a verificationCommands entry missing an id", async () => {
    const configPath = writeConfig({
      workspace: createTempWorkspace(),
      taskInstructions: "do it",
      verificationCommands: [{ executable: "npm", argv: ["test"] }],
    });
    await assert.rejects(runLoopStart("wi-0001", configPath, dbOptions()), /\.id.*must be a non-empty string/);
  });

  it("rejects starting against a work item that does not exist", async () => {
    const configPath = writeConfig({ workspace: createTempWorkspace(), taskInstructions: "do it" });
    await assert.rejects(runLoopStart("wi-does-not-exist", configPath, dbOptions()), { code: "NOT_FOUND" });
  });

  it("rejects a verification command whose cwd escapes the approved workspace (HIGH 4)", async () => {
    const configPath = writeConfig({
      workspace: createTempWorkspace(),
      taskInstructions: "do it",
      verificationCommands: [{ id: "escapee", executable: "npm", argv: ["test"], cwd: "../../outside" }],
    });
    await assert.rejects(runLoopStart("wi-0001", configPath, dbOptions()), { code: "VALIDATION" });
  });
});

describe("sf loop status|resume|cancel — not-found handling", () => {
  it("status on an unknown loop id rejects with NOT_FOUND", async () => {
    await assert.rejects(runLoopStatus("loop-does-not-exist", dbOptions()), { code: "NOT_FOUND" });
  });

  it("resume on an unknown loop id rejects with NOT_FOUND", async () => {
    await assert.rejects(runLoopResume("loop-does-not-exist", dbOptions()), { code: "NOT_FOUND" });
  });

  it("cancel on an unknown loop id rejects with NOT_FOUND", async () => {
    await assert.rejects(runLoopCancel("loop-does-not-exist", dbOptions()), { code: "NOT_FOUND" });
  });
});
