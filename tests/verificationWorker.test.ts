/**
 * Deterministic verification `Worker` (TASK-004 §4): trusted argv-only
 * commands, never a shell; process outcome decides pass/fail per command,
 * but the harness's own `WorkerOutcome.status` stays SUCCEEDED whenever
 * every command actually ran — see verificationWorker.ts's header comment
 * for why that split is load-bearing for the rest of the loop.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { createVerificationWorker, resolveContainedCwd } from "../src/orchestration/verificationWorker.js";
import type { VerificationCommandResult } from "../src/orchestration/loopTypes.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(cleanupTempWorkspaces);

const runner = createNodeProcessRunner({ killGraceMs: 100 });

function baseRequest(role: "VERIFIER" = "VERIFIER") {
  return { runId: "run-test", workItemId: "wi-test", role, title: "test", instructions: "verify", acceptanceCriteria: [] };
}

describe("createVerificationWorker", () => {
  it("reports SUCCEEDED and claimsAcceptanceMet=true when every command exits 0", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const worker = createVerificationWorker({
      commands: [
        { id: "a", executable: process.execPath, argv: ["-e", "process.exit(0)"] },
        { id: "b", executable: process.execPath, argv: ["-e", "process.exit(0)"] },
      ],
      workspace,
      processRunner: runner,
    });

    const outcome = await worker.execute(baseRequest());
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(outcome.claimsAcceptanceMet, true);
    assert.equal(outcome.evidence.length, 2);
    assert.match(outcome.summary, /2\/2 commands passed/);
  });

  it("still reports SUCCEEDED (the harness ran) but claimsAcceptanceMet=false when a command fails", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const worker = createVerificationWorker({
      commands: [
        { id: "passing", executable: process.execPath, argv: ["-e", "process.exit(0)"] },
        { id: "failing", executable: process.execPath, argv: ["-e", "process.exit(1)"] },
      ],
      workspace,
      processRunner: runner,
    });

    const outcome = await worker.execute(baseRequest());
    assert.equal(outcome.status, "SUCCEEDED", "the harness itself completed — a failing check is a successfully observed fact");
    assert.equal(outcome.claimsAcceptanceMet, false);
    assert.match(outcome.summary, /1\/2 commands passed/);
  });

  it("invokes onCommandResult once per command with structured pass/fail data", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const collected: VerificationCommandResult[] = [];
    const worker = createVerificationWorker({
      commands: [
        { id: "one", executable: process.execPath, argv: ["-e", "process.exit(0)"] },
        { id: "two", executable: process.execPath, argv: ["-e", "process.exit(7)"] },
      ],
      workspace,
      processRunner: runner,
      onCommandResult: (result) => collected.push(result),
    });

    await worker.execute(baseRequest());
    assert.equal(collected.length, 2);
    assert.equal(collected[0]?.commandId, "one");
    assert.equal(collected[0]?.passed, true);
    assert.equal(collected[0]?.exitCode, 0);
    assert.equal(collected[1]?.commandId, "two");
    assert.equal(collected[1]?.passed, false);
    assert.equal(collected[1]?.exitCode, 7);
  });

  it("treats a timed-out command as failed, not as a harness crash", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const worker = createVerificationWorker({
      commands: [{ id: "slow", executable: process.execPath, argv: ["-e", "setTimeout(() => {}, 5000)"], timeoutMs: 100 }],
      workspace,
      processRunner: runner,
    });

    const outcome = await worker.execute(baseRequest());
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(outcome.claimsAcceptanceMet, false);
  });

  it("resolves a command's cwd relative to the workspace root", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const collected: VerificationCommandResult[] = [];
    const worker = createVerificationWorker({
      commands: [
        {
          id: "pwd-check",
          executable: process.execPath,
          argv: ["-e", `process.exit(process.cwd() === ${JSON.stringify(workspace.root)} ? 0 : 1)`],
        },
      ],
      workspace,
      processRunner: runner,
      onCommandResult: (result) => collected.push(result),
    });

    await worker.execute(baseRequest());
    assert.equal(collected[0]?.passed, true, "command must run with cwd === workspace.root when no cwd override is given");
  });

  it("redacts secret-shaped output before it becomes evidence", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const secret = "sk-ant-test-1234567890abcdefghijklmnop";
    const worker = createVerificationWorker({
      commands: [
        {
          // The secret must reach evidence only via the command's actual
          // stdout (an env var), never via argv itself — argv is trusted
          // configuration and is deliberately never redacted (same posture
          // as cliWorker.ts's trusted tool/model/effort fields). `exitCode`
          // (not `exit()`) avoids truncating an async pipe write on POSIX —
          // see AI-HANDOFF.md's TASK-003 fixture note.
          id: "leaky",
          executable: process.execPath,
          argv: ["-e", "process.stdout.write(process.env.LEAKY_SECRET || ''); process.exitCode = 1;"],
        },
      ],
      workspace,
      processRunner: runner,
      environmentPolicy: { allowedVars: ["PATH"], extraVars: { LEAKY_SECRET: secret } },
    });

    const outcome = await worker.execute(baseRequest());
    const text = outcome.evidence.map((entry) => entry.summary).join("\n");
    assert.ok(!text.includes(secret), "raw secret must never reach evidence");
    assert.ok(text.includes("[REDACTED]"));
  });

  it("is vacuously SUCCEEDED with claimsAcceptanceMet=true for zero configured commands", async () => {
    const workspace = resolveWorkspace(createTempWorkspace());
    const worker = createVerificationWorker({ commands: [], workspace, processRunner: runner });
    const outcome = await worker.execute(baseRequest());
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(outcome.claimsAcceptanceMet, true);
    assert.equal(outcome.evidence.length, 0);
  });
});

/**
 * Remediation round 1, HIGH 4 / PART J: every configured cwd is confined to
 * the approved workspace with REAL (symlink-resolved) paths, both at loop
 * start and again immediately before each command executes. Containment is
 * against workspace.root — the narrower approved execution workspace.
 */
describe("resolveContainedCwd — workspace containment", () => {
  function scaffold(): { parent: string; workspaceDir: string; outsideDir: string } {
    const parent = mkdtempSync(join(tmpdir(), "sf-containment-"));
    const workspaceDir = join(parent, "workspace");
    const outsideDir = join(parent, "outside");
    mkdirSync(workspaceDir);
    mkdirSync(outsideDir);
    return { parent, workspaceDir, outsideDir };
  }

  function fakeWorkspace(root: string) {
    return { root, repositoryRoot: root };
  }

  it("defaults to the workspace root itself", () => {
    const { parent, workspaceDir } = scaffold();
    try {
      const resolved = resolveContainedCwd(fakeWorkspace(workspaceDir), undefined);
      assert.ok(resolved.endsWith("workspace"));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("accepts a genuine subdirectory, including one with spaces in its name", () => {
    const { parent, workspaceDir } = scaffold();
    try {
      mkdirSync(join(workspaceDir, "sub dir with spaces"));
      const resolved = resolveContainedCwd(fakeWorkspace(workspaceDir), "sub dir with spaces");
      assert.ok(resolved.endsWith("sub dir with spaces"));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects a ../ escape", () => {
    const { parent, workspaceDir } = scaffold();
    try {
      assert.throws(() => resolveContainedCwd(fakeWorkspace(workspaceDir), "../outside"), { code: "VALIDATION" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects an absolute path outside the workspace", () => {
    const { parent, workspaceDir, outsideDir } = scaffold();
    try {
      assert.throws(() => resolveContainedCwd(fakeWorkspace(workspaceDir), outsideDir), { code: "VALIDATION" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects a symlink inside the workspace that points outside (real paths, not lexical prefixes)", () => {
    const { parent, workspaceDir, outsideDir } = scaffold();
    try {
      symlinkSync(outsideDir, join(workspaceDir, "sneaky-link"));
      assert.throws(() => resolveContainedCwd(fakeWorkspace(workspaceDir), "sneaky-link"), { code: "VALIDATION" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects a nonexistent cwd", () => {
    const { parent, workspaceDir } = scaffold();
    try {
      assert.throws(() => resolveContainedCwd(fakeWorkspace(workspaceDir), "does-not-exist"), { code: "VALIDATION" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects a file where a directory is required", () => {
    const { parent, workspaceDir } = scaffold();
    try {
      writeFileSync(join(workspaceDir, "a-file.txt"), "not a directory\n");
      assert.throws(() => resolveContainedCwd(fakeWorkspace(workspaceDir), "a-file.txt"), { code: "VALIDATION" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects a lexical prefix cousin (workspace-evil is not inside workspace)", () => {
    const { parent, workspaceDir } = scaffold();
    try {
      mkdirSync(join(parent, "workspace-evil"));
      assert.throws(() => resolveContainedCwd(fakeWorkspace(workspaceDir), join(parent, "workspace-evil")), { code: "VALIDATION" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("a symlink created AFTER loop start is still rejected at execution time (defense in depth)", async () => {
    const { parent, workspaceDir, outsideDir } = scaffold();
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "--quiet"], { cwd: workspaceDir });
      mkdirSync(join(workspaceDir, "checks"));
      const workspace = resolveWorkspace(workspaceDir);
      const worker = createVerificationWorker({
        commands: [{ id: "late-symlink", executable: process.execPath, argv: ["-e", "process.exit(0)"], cwd: "checks" }],
        workspace,
        processRunner: runner,
      });
      // Start-time validation would have passed for "checks" — now swap it
      // for a symlink pointing outside, as an attacker with workspace write
      // access could between start and verification.
      rmSync(join(workspaceDir, "checks"), { recursive: true, force: true });
      symlinkSync(outsideDir, join(workspaceDir, "checks"));

      await assert.rejects(
        worker.execute({ runId: "run-x", workItemId: "wi-x", role: "VERIFIER", title: "t", instructions: "verify", acceptanceCriteria: [] }),
        { code: "VALIDATION" },
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
