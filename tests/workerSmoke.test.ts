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

import { ensureNodeGit } from "./support/nodeGit.js";

/**
 * THE CLI UNDER TEST RUNS `git init` (AC-12). Production keeps calling real
 * git; the suite supplies a Node one so no test needs git on the host.
 */
ensureNodeGit();

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
      timeoutMs: null,
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
        timeoutMs: null,
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
      timeoutMs: null,
      log: (line) => lines.push(line),
    });

    assert.equal(result.run.status, "FAILED");
    assert.ok(!existsSync(result.workspaceRoot), "scratch workspace must be removed after a FAILED (spawn-error) run");
  });
});

describe("runWorkerSmoke: author timeout policy (no total deadline)", () => {
  function recordingRunner(calls: (number | null)[]): ProcessRunner {
    return {
      async run(request): Promise<ProcessResult> {
        calls.push(request.timeoutMs);
        return { terminationReason: "EXITED", exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, startedAt: 0, finishedAt: 0, durationMs: 0 };
      },
    };
  }

  it("propagates null to the process runner both by default and when explicit", async () => {
    const calls: (number | null)[] = [];
    await runWorkerSmoke("codex", { executable: "stub", processRunner: recordingRunner(calls), log: () => {} });
    await runWorkerSmoke("claude", { executable: "stub", processRunner: recordingRunner(calls), timeoutMs: null, log: () => {} });
    assert.deepEqual(calls, [null, null]);
  });

  it("refuses a finite timeout before any child call and still cleans up the scratch workspace", async () => {
    const calls: (number | null)[] = [];
    const lines: string[] = [];
    await assert.rejects(
      runWorkerSmoke("codex", { executable: "stub", processRunner: recordingRunner(calls), timeoutMs: 5000, log: (l) => lines.push(l) }),
      /must be null/,
    );
    assert.equal(calls.length, 0);
    assert.ok(!existsSync(extractScratchRoot(lines)));
  });
});
