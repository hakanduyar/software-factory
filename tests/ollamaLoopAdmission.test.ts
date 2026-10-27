import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { ValidationError } from "../src/domain/errors.js";
import { createLoopWorker } from "../src/orchestration/loopWorkerFactory.js";
import type { ProcessRunner } from "../src/ports/processRunner.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(cleanupTempWorkspaces);

describe("createLoopWorker: ollama-cli", () => {
  it("refuses with ValidationError, constructing nothing and never running a process", () => {
    let runs = 0;
    const processRunner: ProcessRunner = {
      async run() {
        runs += 1;
        throw new Error("must not run");
      },
    };
    const workspace = resolveWorkspace(createTempWorkspace(), { requireGitRepository: false });
    assert.throws(
      () => createLoopWorker({ tool: "ollama-cli", model: "llama3" }, { workspace, processRunner, roles: ["REVIEWER"] }),
      ValidationError,
    );
    assert.equal(runs, 0);
  });

  it("still builds existing providers", () => {
    const processRunner: ProcessRunner = { async run() { throw new Error("unused"); } };
    const workspace = resolveWorkspace(createTempWorkspace(), { requireGitRepository: false });
    const worker = createLoopWorker({ tool: "codex-cli", model: "gpt-5.6-luna" }, { workspace, processRunner, roles: ["REVIEWER"] });
    assert.equal(worker.id, "codex-cli");
  });
});
