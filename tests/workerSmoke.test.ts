/**
 * `sf worker smoke` (src/cli/workerSmoke.ts).
 *
 * TASK-003 remediation round 1, LOW finding (independent Codex review,
 * 2026-08-20): the scratch workspace directory was created but never
 * cleaned up by the command itself. Fixed with a `finally`-style cleanup
 * around the whole run. This suite proves cleanup happens both on success
 * and when the run throws — never only on the happy path — using the
 * deterministic fake Codex CLI, never a real AI provider.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

import { runWorkerSmoke } from "../src/cli/workerSmoke.js";
import type { ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import { fakeCliPath } from "./support/fakeCli.js";

function extractScratchRoot(lines: readonly string[]): string {
  const line = lines.find((entry) => entry.startsWith("scratch workspace: "));
  assert.ok(line !== undefined, "expected a 'scratch workspace: <path>' log line");
  return line.slice("scratch workspace: ".length);
}

describe("runWorkerSmoke: scratch workspace cleanup", () => {
  it("removes the scratch directory after a successful run", async () => {
    const lines: string[] = [];
    const result = await runWorkerSmoke("codex", {
      executable: fakeCliPath("fake-codex.mjs"),
      timeoutMs: 5000,
      log: (line) => lines.push(line),
    });

    assert.equal(result.run.status, "SUCCEEDED");
    assert.ok(!existsSync(result.workspaceRoot), "scratch workspace must be removed after a successful run");
    assert.ok(lines.some((l) => l.startsWith("cleaned up scratch workspace: ")));
  });

  it("removes the scratch directory even when the run itself throws", async () => {
    const lines: string[] = [];
    const throwingRunner: ProcessRunner = {
      run(): Promise<ProcessResult> {
        return Promise.reject(new Error("simulated adapter-level failure, not a process result"));
      },
    };

    await assert.rejects(
      runWorkerSmoke("codex", {
        executable: fakeCliPath("fake-codex.mjs"),
        processRunner: throwingRunner,
        timeoutMs: 5000,
        log: (line) => lines.push(line),
      }),
    );

    const scratchRoot = extractScratchRoot(lines);
    assert.ok(!existsSync(scratchRoot), "scratch workspace must be removed even when the run throws");
    assert.ok(lines.some((l) => l === `cleaned up scratch workspace: ${scratchRoot}`));
  });

  it("removes the scratch directory when the worker fails at the process level (non-zero exit)", async () => {
    const lines: string[] = [];
    const result = await runWorkerSmoke("codex", {
      executable: "/definitely/not/a/real/codex/binary",
      timeoutMs: 5000,
      log: (line) => lines.push(line),
    });

    assert.equal(result.run.status, "FAILED");
    assert.ok(!existsSync(result.workspaceRoot), "scratch workspace must be removed after a FAILED (spawn-error) run");
  });
});
