/**
 * `ProcessRunner` (src/adapters/process/nodeProcessRunner.ts) exercised
 * entirely against fake CLI fixtures (tests/fixtures/fake-clis) — no real
 * AI CLI is ever invoked here, and no shell is ever used.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import type { ProcessRequest } from "../src/ports/processRunner.js";
import { fakeCliInvocation } from "./support/fakeCli.js";

const REPO_ROOT = process.cwd();

function baseRequest(overrides: Partial<ProcessRequest> & Pick<ProcessRequest, "executable" | "argv">): ProcessRequest {
  return {
    cwd: REPO_ROOT,
    env: {},
    timeoutMs: 5000,
    ...overrides,
  };
}

const fastRunner = createNodeProcessRunner({ killGraceMs: 100 });

describe("ProcessRunner: argv, cwd, stdin, success", () => {
  it("passes argv, cwd and env through exactly, and delivers stdin byte-for-byte", async () => {
    const invocation = fakeCliInvocation("echo-args.mjs", ["--role", "REVIEWER"]);
    const result = await fastRunner.run(
      baseRequest({
        ...invocation,
        cwd: REPO_ROOT,
        env: { EXAMPLE_VAR: "abc", PATH: process.env["PATH"] ?? "" },
        input: "hello from the caller",
      }),
    );

    assert.equal(result.terminationReason, "EXITED");
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout) as { argv: string[]; cwd: string; env: Record<string, string>; stdin: string };
    assert.deepEqual(parsed.argv, ["--role", "REVIEWER"]);
    assert.equal(parsed.cwd, REPO_ROOT);
    assert.equal(parsed.env["EXAMPLE_VAR"], "abc");
    assert.equal(parsed.stdin, "hello from the caller");
  });

  it("closes stdin immediately when no input is given", async () => {
    const result = await fastRunner.run(baseRequest(fakeCliInvocation("stdin-echo.mjs")));
    assert.equal(result.terminationReason, "EXITED");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "received:");
  });

  it("only forwards exactly the env map given, nothing ambient", async () => {
    const invocation = fakeCliInvocation("echo-args.mjs");
    const result = await fastRunner.run(baseRequest({ ...invocation, env: { ONLY_THIS: "1" } }));
    const parsed = JSON.parse(result.stdout) as { env: Record<string, string> };
    assert.deepEqual(Object.keys(parsed.env), ["ONLY_THIS"]);
  });
});

describe("ProcessRunner: exit codes", () => {
  it("reports a clean zero exit", async () => {
    const result = await fastRunner.run(baseRequest(fakeCliInvocation("exit-code.mjs", ["0"])));
    assert.equal(result.terminationReason, "EXITED");
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /exiting with 0/);
    assert.match(result.stderr, /stderr marker 0/);
  });

  it("reports a non-zero exit as EXITED, not as success", async () => {
    const result = await fastRunner.run(baseRequest(fakeCliInvocation("exit-code.mjs", ["7"])));
    assert.equal(result.terminationReason, "EXITED");
    assert.equal(result.exitCode, 7);
  });
});

describe("ProcessRunner: spawn failure", () => {
  it("reports a missing executable as SPAWN_ERROR, distinct from a process exit", async () => {
    const result = await fastRunner.run(
      baseRequest({ executable: "/definitely/does/not/exist/binary-xyz", argv: [] }),
    );
    assert.equal(result.terminationReason, "SPAWN_ERROR");
    assert.equal(result.exitCode, null);
    assert.ok(result.spawnError !== undefined && result.spawnError.length > 0);
  });

  it("reports an invalid cwd as SPAWN_ERROR", async () => {
    const invocation = fakeCliInvocation("exit-code.mjs", ["0"]);
    const result = await fastRunner.run(baseRequest({ ...invocation, cwd: "/definitely/not/a/real/directory" }));
    assert.equal(result.terminationReason, "SPAWN_ERROR");
    assert.equal(result.exitCode, null);
  });
});

describe("ProcessRunner: timeout", () => {
  it("terminates a slow-but-eventually-exiting process and reports TIMEOUT", async () => {
    const result = await fastRunner.run(
      baseRequest({ ...fakeCliInvocation("slow-exit.mjs", ["2000", "0"]), timeoutMs: 100 }),
    );
    assert.equal(result.terminationReason, "TIMEOUT");
    assert.notEqual(result.exitCode, 0);
  });

  it("escalates to SIGKILL when the child ignores SIGTERM, and still settles exactly once", async () => {
    // Generous timeout/grace margin on purpose: this must hold even when a
    // fresh `node` child process's own startup (module load, handler
    // registration) is slow under a loaded machine — the assertion is about
    // SIGKILL escalation actually working, not about sub-100ms responsiveness.
    const runner = createNodeProcessRunner({ killGraceMs: 300 });
    const result = await runner.run(baseRequest({ ...fakeCliInvocation("never-exits.mjs"), timeoutMs: 500 }));
    assert.equal(result.terminationReason, "TIMEOUT");
    assert.match(result.stdout, /started/);
    // SIGKILL cannot be caught, so the process is genuinely gone (signal-terminated, not exit-coded).
    assert.equal(result.signal, "SIGKILL");
  });

  it("does not report TIMEOUT when the process exits comfortably before the deadline", async () => {
    const result = await fastRunner.run(
      baseRequest({ ...fakeCliInvocation("slow-exit.mjs", ["10", "0"]), timeoutMs: 5000 }),
    );
    assert.equal(result.terminationReason, "EXITED");
    assert.equal(result.exitCode, 0);
  });
});

describe("ProcessRunner: cancellation", () => {
  it("terminates the process when the AbortSignal fires and reports CANCELLED", async () => {
    const controller = new AbortController();
    const promise = fastRunner.run(
      baseRequest({ ...fakeCliInvocation("slow-exit.mjs", ["2000", "0"]), timeoutMs: 5000, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    assert.equal(result.terminationReason, "CANCELLED");
  });

  it("treats an already-aborted signal as an immediate cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await fastRunner.run(
      baseRequest({ ...fakeCliInvocation("slow-exit.mjs", ["2000", "0"]), timeoutMs: 5000, signal: controller.signal }),
    );
    assert.equal(result.terminationReason, "CANCELLED");
  });

  it("does not report CANCELLED when the process exits before the abort fires", async () => {
    const controller = new AbortController();
    const promise = fastRunner.run(
      baseRequest({ ...fakeCliInvocation("slow-exit.mjs", ["10", "0"]), timeoutMs: 5000, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 2000);
    const result = await promise;
    assert.equal(result.terminationReason, "EXITED");
  });
});

describe("ProcessRunner: bounded output capture", () => {
  it("captures and drains large stdout/stderr without deadlocking", async () => {
    const result = await fastRunner.run(
      baseRequest({ ...fakeCliInvocation("large-output.mjs", [String(2 * 1024 * 1024), String(512 * 1024)]), timeoutMs: 10000 }),
    );
    assert.equal(result.terminationReason, "EXITED");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.length, 2 * 1024 * 1024);
    assert.equal(result.stderr.length, 512 * 1024);
    assert.equal(result.stdoutTruncated, false);
    assert.equal(result.stderrTruncated, false);
  });

  it("truncates output past maxOutputBytes and records that it did", async () => {
    const result = await fastRunner.run(
      baseRequest({
        ...fakeCliInvocation("large-output.mjs", [String(200_000), "0"]),
        timeoutMs: 10000,
        maxOutputBytes: 1000,
      }),
    );
    assert.equal(result.terminationReason, "EXITED");
    assert.equal(result.stdout.length, 1000);
    assert.equal(result.stdoutTruncated, true);
  });
});

describe("ProcessRunner: aggregate output ceiling", () => {
  it("refuses an invalid maxTotalOutputBytes before spawning the child", async () => {
    const invalidValues = [0, -5, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
    for (const invalid of invalidValues) {
      const onSpawnCalls: number[] = [];
      await assert.rejects(
        fastRunner.run(
          baseRequest({
            ...fakeCliInvocation("echo-args.mjs"),
            maxTotalOutputBytes: invalid,
            onSpawn: (info) => onSpawnCalls.push(info.pid),
          }),
        ),
      );
      assert.equal(onSpawnCalls.length, 0, `onSpawn must never fire for a refused resource bound (${invalid})`);
    }
  });

  it("terminates and reports outputLimitExceeded when combined raw stdout+stderr exceeds the ceiling, and never captures more than the ceiling", async () => {
    const result = await fastRunner.run(
      baseRequest({
        ...fakeCliInvocation("large-output.mjs", [String(50_000), String(50_000)]),
        timeoutMs: 10000,
        maxTotalOutputBytes: 60_000,
      }),
    );
    assert.equal(result.terminationReason, "CANCELLED");
    assert.equal(result.outputLimitExceeded, true);
    assert.ok(
      result.stdout.length + result.stderr.length <= 60_000,
      "combined captured output must never exceed the configured aggregate ceiling",
    );
  });

  it("does not terminate when combined raw output is exactly at the ceiling", async () => {
    const result = await fastRunner.run(
      baseRequest({
        ...fakeCliInvocation("large-output.mjs", [String(30_000), String(20_000)]),
        timeoutMs: 10000,
        maxTotalOutputBytes: 50_000,
      }),
    );
    assert.equal(result.terminationReason, "EXITED");
    assert.equal(result.outputLimitExceeded, undefined);
    assert.equal(result.stdout.length, 30_000);
    assert.equal(result.stderr.length, 20_000);
  });

  it("omitting the ceiling preserves existing unbounded-aggregate behavior", async () => {
    const result = await fastRunner.run(
      baseRequest({
        ...fakeCliInvocation("large-output.mjs", [String(100_000), String(100_000)]),
        timeoutMs: 10000,
      }),
    );
    assert.equal(result.terminationReason, "EXITED");
    assert.equal(result.outputLimitExceeded, undefined);
  });
});

describe("ProcessRunner: hostile stdin", () => {
  it("does not crash or hang when the child exits without reading stdin", async () => {
    const largeInput = "x".repeat(5 * 1024 * 1024);
    const result = await fastRunner.run(
      baseRequest({ ...fakeCliInvocation("ignore-stdin-exit.mjs"), input: largeInput, timeoutMs: 5000 }),
    );
    assert.equal(result.terminationReason, "EXITED");
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /done/);
  });
});

describe("ProcessRunner: exactly-once settlement", () => {
  it("settles exactly once even when timeout and natural close both fire in quick succession", async () => {
    // The timeout fires first; SIGTERM causes the process to exit almost
    // immediately afterward. Only one ProcessResult should ever be produced.
    const result = await fastRunner.run(
      baseRequest({ ...fakeCliInvocation("slow-exit.mjs", ["10000", "0"]), timeoutMs: 20 }),
    );
    assert.equal(result.terminationReason, "TIMEOUT");
  });
});

/**
 * DEFECT-DURABLE-WORKER-RUN-ENVELOPE AC-2: `onSpawn`.
 *
 * The one new capability this port gained for this defect: a synchronous
 * callback firing with the real OS pid the moment the child is confirmed to
 * exist — the ACK a durable "RUNNING" record may be built from, as opposed to
 * launcher intent alone.
 */
describe("ProcessRunner: onSpawn", () => {
  it("fires exactly once, with the real pid, before the process settles", async () => {
    const calls: number[] = [];
    const result = await fastRunner.run(
      baseRequest({
        ...fakeCliInvocation("echo-args.mjs"),
        onSpawn: (info) => calls.push(info.pid),
      }),
    );
    assert.equal(result.terminationReason, "EXITED");
    assert.equal(calls.length, 1, "onSpawn must fire exactly once");
    assert.ok(Number.isInteger(calls[0]) && calls[0]! > 0, "onSpawn must report a real, positive OS pid");
  });

  it("never fires for a spawn error, and a throwing callback never breaks the runner", async () => {
    const calls: number[] = [];
    const result = await fastRunner.run(
      baseRequest({
        executable: "/definitely/not/a/real/executable/anywhere",
        argv: [],
        onSpawn: (info) => {
          calls.push(info.pid);
          throw new Error("a caller's callback misbehaving must never propagate");
        },
      }),
    );
    assert.equal(result.terminationReason, "SPAWN_ERROR");
    assert.equal(calls.length, 0, "a process that never spawned must never ACK");
  });

  it("a throwing onSpawn callback does not prevent the process from completing normally", async () => {
    const result = await fastRunner.run(
      baseRequest({
        ...fakeCliInvocation("echo-args.mjs"),
        onSpawn: () => {
          throw new Error("must be swallowed, exactly like a stream error is");
        },
      }),
    );
    assert.equal(result.terminationReason, "EXITED");
    assert.equal(result.exitCode, 0);
  });
});
