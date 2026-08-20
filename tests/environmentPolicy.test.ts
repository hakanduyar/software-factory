import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWorkerEnvironment, DEFAULT_WORKER_ENV_ALLOWLIST, redactSecrets } from "../src/adapters/workers/environmentPolicy.js";

describe("buildWorkerEnvironment", () => {
  it("forwards only allowlisted variables that are actually present", () => {
    const env = buildWorkerEnvironment(
      { allowedVars: ["PATH", "HOME", "ANTHROPIC_API_KEY"] },
      { PATH: "/usr/bin", HOME: "/home/x", SOME_OTHER: "y" },
    );
    // ANTHROPIC_API_KEY is allowlisted here but absent from source — still not forwarded.
    assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/x" });
  });

  it("never forwards a variable absent from the allowlist, however sensitive-looking", () => {
    const env = buildWorkerEnvironment({ allowedVars: ["PATH"] }, { PATH: "/usr/bin", OPENAI_API_KEY: "sk-should-not-leak" });
    assert.deepEqual(env, { PATH: "/usr/bin" });
  });

  it("layers extraVars on top of the allowlisted values", () => {
    const env = buildWorkerEnvironment({ allowedVars: ["PATH"], extraVars: { CODEX_MODE: "test" } }, { PATH: "/usr/bin" });
    assert.deepEqual(env, { PATH: "/usr/bin", CODEX_MODE: "test" });
  });

  it("the default allowlist never names an API-key/token/secret variable", () => {
    for (const name of DEFAULT_WORKER_ENV_ALLOWLIST) {
      assert.doesNotMatch(name, /key|token|secret|password|credential/i);
    }
  });
});

describe("redactSecrets", () => {
  it("masks provider-specific token shapes in context", () => {
    assert.equal(redactSecrets("value is sk-ant-abcdefghij1234567890 here"), "value is [REDACTED] here");
    assert.equal(redactSecrets("Authorization: Bearer abcdef123456"), "Authorization: [REDACTED]");
    assert.equal(redactSecrets("see ghp_abcdefghijklmnopqrstuvwxyz012345 in the log"), "see [REDACTED] in the log");
  });

  it("masks a whole labeled key/token/secret assignment, label included", () => {
    // The label is swallowed along with the value — over-redaction here is
    // the safe failure mode, not a bug.
    assert.equal(redactSecrets("token=sk-ant-abcdefghij1234567890"), "[REDACTED]");
    assert.equal(redactSecrets("api_key: abc123"), "[REDACTED]");
  });

  it("leaves ordinary text untouched", () => {
    const text = "The build passed with 12 tests and no failures.";
    assert.equal(redactSecrets(text), text);
  });
});
