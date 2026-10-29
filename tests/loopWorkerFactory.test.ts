import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";
import type { WorkerRequest } from "../src/ports/worker.js";
import type { LoopWorkerConfig } from "../src/orchestration/loopTypes.js";
import { createLoopWorker } from "../src/orchestration/loopWorkerFactory.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(() => cleanupTempWorkspaces());

const OK: ProcessResult = {
  terminationReason: "EXITED",
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  startedAt: 0,
  finishedAt: 0,
  durationMs: 0,
};

function stub(): { runner: ProcessRunner; calls: ProcessRequest[] } {
  const calls: ProcessRequest[] = [];
  return {
    calls,
    runner: {
      async run(req) {
        calls.push(req);
        return OK;
      },
    },
  };
}

function request(): WorkerRequest {
  return {
    runId: "run-1",
    workItemId: "wi-1",
    role: "IMPLEMENTER",
    title: "t",
    instructions: "do",
    acceptanceCriteria: [{ id: "ac-1", workItemId: "wi-1", text: "holds", verificationHint: "npm test" }],
  };
}

describe("createLoopWorker: author timeout policy", () => {
  for (const tool of ["claude-code", "codex-cli"] as const) {
    const options = (runner: ProcessRunner, extra: object = {}) => ({
      workspace: resolveWorkspace(createTempWorkspace()),
      processRunner: runner,
      roles: ["IMPLEMENTER" as const],
      ...extra,
    });

    it(`${tool}: absent config and absent default forward null`, async () => {
      const { runner, calls } = stub();
      await createLoopWorker({ tool, model: "m" }, options(runner)).execute(request());
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.timeoutMs, null);
    });

    it(`${tool}: explicit null (config or default) stays null`, async () => {
      const { runner, calls } = stub();
      await createLoopWorker({ tool, model: "m", timeoutMs: null }, options(runner)).execute(request());
      await createLoopWorker({ tool, model: "m" }, options(runner, { defaultTimeoutMs: null })).execute(request());
      // explicit config null wins over a (hypothetical) finite default only by being refused-free null:
      assert.deepEqual(calls.map((c) => c.timeoutMs), [null, null]);
    });

    it(`${tool}: finite or malformed worker/default timeout is refused before any runner call`, () => {
      const { runner, calls } = stub();
      for (const bad of [300000, 1, 0, -5, "100", Number.NaN]) {
        assert.throws(
          () => createLoopWorker({ tool, model: "m", timeoutMs: bad as unknown as number }, options(runner)),
          /must be null/,
        );
        assert.throws(
          () => createLoopWorker({ tool, model: "m" }, options(runner, { defaultTimeoutMs: bad })),
          /must be null/,
        );
      }
      assert.equal(calls.length, 0);
    });
  }

  it("keeps ollama/gemini/opencode admission closed, even with null timeout", () => {
    const { runner, calls } = stub();
    for (const tool of ["ollama-cli", "gemini-cli", "opencode-cli"] as const) {
      const config: LoopWorkerConfig = { tool, model: "m", timeoutMs: null };
      assert.throws(
        () => createLoopWorker(config, { workspace: resolveWorkspace(createTempWorkspace()), processRunner: runner, roles: ["REVIEWER"] }),
        /unavailable/,
      );
    }
    assert.equal(calls.length, 0);
  });
});
