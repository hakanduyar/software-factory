import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WORKER_TOOLS } from "../src/adapters/workers/workerModelConfig.js";
import { SUPPORTED_MODELS, planAiRunConfig } from "../src/supervision/modelEnforcement.js";

describe("ollama model admission", () => {
  it("lists ollama-cli with a frozen empty model list", () => {
    assert.ok(WORKER_TOOLS.includes("ollama-cli"));
    assert.equal(SUPPORTED_MODELS["ollama-cli"].length, 0);
    assert.ok(Object.isFrozen(SUPPORTED_MODELS["ollama-cli"]));
  });

  it("refuses every Ollama model, with or without effort, and yields no argv", () => {
    for (const effort of [undefined, "high", "xhigh"]) {
      for (const model of ["llama3", "gpt-5.6-luna", "opus", ""]) {
        const planned = planAiRunConfig({
          provider: "ollama-cli",
          model,
          role: "REVIEWER",
          ...(effort === undefined ? {} : { effort }),
        });
        assert.equal(planned.ok, false);
        assert.ok(!("value" in planned));
      }
    }
  });

  it("keeps existing provider controls working", () => {
    assert.equal(planAiRunConfig({ provider: "codex-cli", model: "gpt-5.6-luna", role: "REVIEWER" }).ok, true);
    assert.equal(planAiRunConfig({ provider: "claude-code", model: "opus", role: "REVIEWER" }).ok, true);
    assert.equal(planAiRunConfig({ provider: "codex-cli", model: "llama3", role: "REVIEWER" }).ok, false);
  });
});
