import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWorkerEnvironment, DEFAULT_WORKER_ENV_ALLOWLIST, DEFAULT_WORKER_ENVIRONMENT_POLICY } from "../src/adapters/workers/environmentPolicy.js";
import { runWorkerDoctor } from "../src/cli/workerDoctor.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/ports/processRunner.js";

// Discovery only: every test uses an injected ProcessRunner, so no real
// process, provider, account, credential or network is ever touched.

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    terminationReason: "EXITED",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt: "2026-01-01T00:00:00.000Z" as ProcessResult["startedAt"],
    finishedAt: "2026-01-01T00:00:00.000Z" as ProcessResult["finishedAt"],
    durationMs: 0,
    ...overrides,
  };
}

function fakeRunner(respond: (request: ProcessRequest) => ProcessResult): { runner: ProcessRunner; requests: ProcessRequest[] } {
  const requests: ProcessRequest[] = [];
  const runner: ProcessRunner = {
    run: async (request) => {
      requests.push(request);
      return respond(request);
    },
  };
  return { runner, requests };
}

describe("runWorkerDoctor discovery", () => {
  it("probes claude then codex with exactly --version, the policy environment and the 5000ms timeout", async () => {
    const { runner, requests } = fakeRunner((r) => result({ stdout: `${r.executable} 1.2.3\n` }));
    const out = await runWorkerDoctor({ processRunner: runner });

    assert.deepEqual(
      requests.map((r) => [r.executable, [...r.argv]]),
      [
        ["claude", ["--version"]],
        ["codex", ["--version"]],
      ],
    );
    const expectedEnv = buildWorkerEnvironment(DEFAULT_WORKER_ENVIRONMENT_POLICY);
    for (const r of requests) {
      assert.equal(r.timeoutMs, 5000);
      assert.equal(r.cwd, process.cwd());
      assert.deepEqual(r.env, expectedEnv);
      for (const name of Object.keys(r.env)) {
        assert.ok(DEFAULT_WORKER_ENV_ALLOWLIST.includes(name), `${name} is not allowlisted`);
      }
      // Discovery never asks a model anything: no stdin prompt, no extra argv.
      assert.equal(r.input, undefined);
      assert.equal(r.argv.length, 1);
    }
    assert.equal(out.claude.version, "claude 1.2.3");
    assert.equal(out.codex.version, "codex 1.2.3");
  });

  it("honours custom executables while keeping argv exactly --version", async () => {
    const { runner, requests } = fakeRunner(() => result({ stdout: "v\n" }));
    await runWorkerDoctor({ processRunner: runner, claudeExecutable: "/opt/c", codexExecutable: "/opt/x" });
    assert.deepEqual(
      requests.map((r) => [r.executable, [...r.argv]]),
      [
        ["/opt/c", ["--version"]],
        ["/opt/x", ["--version"]],
      ],
    );
  });

  it("reports a missing executable (SPAWN_ERROR) as found=false with the spawn error", async () => {
    const { runner } = fakeRunner(() => result({ terminationReason: "SPAWN_ERROR", exitCode: null, spawnError: "spawn claude ENOENT" }));
    const lines: string[] = [];
    const out = await runWorkerDoctor({ processRunner: runner, log: (l) => lines.push(l) });
    assert.equal(out.claude.found, false);
    assert.equal(out.claude.detail, "spawn claude ENOENT");
    assert.equal(out.claude.version, undefined);
    assert.equal(out.codex.found, false);
    assert.match(lines[0] ?? "", /NOT FOUND/);
  });

  it("falls back to a generic detail when SPAWN_ERROR carries no message", async () => {
    const { runner } = fakeRunner(() => result({ terminationReason: "SPAWN_ERROR", exitCode: null }));
    const out = await runWorkerDoctor({ processRunner: runner });
    assert.equal(out.claude.found, false);
    assert.equal(out.claude.detail, "spawn failed");
  });

  it("keeps found=true with explanatory detail on a nonzero exit, without a version", async () => {
    const { runner } = fakeRunner(() => result({ exitCode: 2, stdout: "9.9.9" }));
    const out = await runWorkerDoctor({ processRunner: runner });
    assert.equal(out.claude.found, true);
    assert.equal(out.claude.version, undefined);
    assert.match(out.claude.detail ?? "", /did not exit cleanly \(EXITED, exit=2\)/);
  });

  it("keeps found=true with explanatory detail on timeout, without a version", async () => {
    const { runner } = fakeRunner(() => result({ terminationReason: "TIMEOUT", exitCode: null, stdout: "partial 1.0" }));
    const out = await runWorkerDoctor({ processRunner: runner });
    assert.equal(out.codex.found, true);
    assert.equal(out.codex.version, undefined);
    assert.match(out.codex.detail ?? "", /did not exit cleanly \(TIMEOUT, exit=null\)/);
  });

  it("treats cancellation like any non-clean termination: found=true, no version", async () => {
    const { runner } = fakeRunner(() => result({ terminationReason: "CANCELLED", exitCode: null }));
    const out = await runWorkerDoctor({ processRunner: runner });
    assert.equal(out.claude.found, true);
    assert.match(out.claude.detail ?? "", /CANCELLED/);
  });

  it("reports a clean exit with empty output as found=true with no version", async () => {
    const { runner } = fakeRunner(() => result({ stdout: "  \n", stderr: "\t\n" }));
    const lines: string[] = [];
    const out = await runWorkerDoctor({ processRunner: runner, log: (l) => lines.push(l) });
    assert.equal(out.claude.found, true);
    assert.equal(out.claude.version, undefined);
    assert.match(lines[0] ?? "", /found \(claude\), but /);
  });

  it("uses trimmed stdout as the version, preferring it over stderr", async () => {
    const { runner } = fakeRunner(() => result({ stdout: "  2.0.1 (Claude Code)\n", stderr: "warn: ignored" }));
    const out = await runWorkerDoctor({ processRunner: runner });
    assert.equal(out.claude.version, "2.0.1 (Claude Code)");
  });

  it("falls back to trimmed stderr when stdout is empty", async () => {
    const { runner } = fakeRunner(() => result({ stdout: "", stderr: "\n codex-cli 0.5.0 \n" }));
    const out = await runWorkerDoctor({ processRunner: runner });
    assert.equal(out.codex.version, "codex-cli 0.5.0");
  });

  it("found=true means discovered only: the report carries no model or account readiness", async () => {
    const { runner, requests } = fakeRunner(() => result({ stdout: "1.0.0" }));
    const out = await runWorkerDoctor({ processRunner: runner });
    assert.deepEqual(Object.keys(out.claude).sort(), ["executable", "found", "tool", "version"]);
    assert.equal(requests.length, 2);
  });
});
