/**
 * TASK-018 PART B — the liveness probe, against REAL processes and against the
 * `/proc` shapes that break naive parsers.
 *
 * `activity.test.ts` chooses its own liveness answers, because there the answer
 * is an input. Here the answer is the thing under test, so the processes are
 * real: spawned, observed, killed, and observed again.
 *
 * Offline: no provider is contacted, no model is invoked, no money can be spent.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  createProcLivenessProbe,
  leaseForThisProcess,
  machineIdentity,
  processStartTime,
  startTimeFromStat,
  stateFromStat,
} from "../src/adapters/supervision/procLiveness.js";
import type { ActivityLease } from "../src/supervision/activity.js";

const MACHINE = machineIdentity();
const children: number[] = [];

after(() => {
  for (const pid of children) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is what most of these tests arranged.
    }
  }
});

/** A real child that does nothing but stay alive until it is killed. */
function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert.ok(child.pid, "the child did not start");
  children.push(child.pid);
  return child;
}

/**
 * Waits for the child to be REAPED, not merely killed.
 *
 * The first version of this polled `/proc` until the entry disappeared and hung
 * for ten seconds, which is worth recording because the reason is the subject of
 * this file: a killed child whose parent has not called `wait()` is a ZOMBIE,
 * and its `/proc/<pid>/stat` is still there. The probe was right — it reported
 * GONE, because a zombie cannot act — and the test's own wait was wrong.
 *
 * Node reaps on the `exit` event, so that is what to wait for.
 */
async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

// =====================================================================
// Real processes
// =====================================================================

describe("TASK-018 AC-12: holding a lease is a fact about a live process", () => {
  it("reports ALIVE for a real running process, and GONE once it is killed", async () => {
    const child = spawnSleeper();
    const pid = child.pid!;
    const started = processStartTime(pid);
    assert.ok(started !== undefined, "could not read the child's start time");

    const lease: ActivityLease = { pid, processStartedAt: started, machine: MACHINE, claimedAt: 1 };
    const probe = createProcLivenessProbe();
    assert.equal(probe.check(lease), "ALIVE");

    child.kill("SIGKILL");
    await waitForExit(child);

    /**
     * Checked only AFTER the reap, and the first draft of this test was wrong
     * to check immediately after `kill()`: signal delivery is asynchronous, so
     * the process is legitimately still ALIVE for an instant and the assertion
     * was racing the kernel. A test that can fail for a reason it does not name
     * is worse than no test.
     *
     * The ZOMBIE window — terminated but not yet reaped, `/proc` entry still
     * present — is real and is where a naive probe reports ALIVE. It is proven
     * against a fixture `/proc` below rather than here, because Node reaps its
     * own children and an unreaped zombie is not reliably arrangeable inside
     * the test runner.
     */
    assert.equal(probe.check(lease), "GONE", "a killed process still reads as alive");
  });

  it("reports GONE when the pid is REUSED by an unrelated process", () => {
    // The defect this exists for: a lease naming a pid that now belongs to
    // something else would read as alive forever, and nothing could reclaim it.
    const pid = spawnSleeper().pid!;
    const started = processStartTime(pid);
    assert.ok(started !== undefined);

    const impostor: ActivityLease = {
      pid,
      processStartedAt: started - 1, // the same pid, a different process
      machine: MACHINE,
      claimedAt: 1,
    };
    assert.equal(createProcLivenessProbe().check(impostor), "GONE");

    // ...and the positive control: the genuine lease on the same live pid.
    assert.equal(
      createProcLivenessProbe().check({ pid, processStartedAt: started, machine: MACHINE, claimedAt: 1 }),
      "ALIVE",
    );
  });

  it("builds a lease for THIS process that this process can verify", () => {
    const lease = leaseForThisProcess(1_000);
    assert.ok(lease, "no lease was produced for a process that is obviously running");
    assert.equal(lease.pid, process.pid);
    assert.equal(createProcLivenessProbe().check(lease), "ALIVE");
  });

  it("reports UNKNOWN for a lease from another machine, rather than guessing", () => {
    const lease = leaseForThisProcess(1_000);
    assert.ok(lease);
    assert.equal(
      createProcLivenessProbe().check({ ...lease, machine: "some-other-host" }),
      "UNKNOWN",
      "a lease this host cannot check was judged anyway",
    );
  });

  it("reports UNKNOWN for a pid that is not a pid", () => {
    const probe = createProcLivenessProbe();
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      assert.equal(probe.check({ pid, processStartedAt: 1, machine: MACHINE, claimedAt: 1 }), "UNKNOWN", `pid ${pid}`);
    }
  });
});

// =====================================================================
// The parser, against the shapes that break naive splits
// =====================================================================

describe("TASK-018 AC-12: /proc/<pid>/stat is parsed from the LAST parenthesis", () => {
  /** Fields 3..22, so that index 19 after the comm is the start time. */
  function statLine(comm: string, state: string, startTime: number): string {
    const between = Array.from({ length: 18 }, (_, index) => String(index + 100));
    return `1234 (${comm}) ${state} ${between.join(" ")} ${startTime} 0 0\n`;
  }

  it("reads the start time from an ordinary line", () => {
    assert.equal(startTimeFromStat(statLine("node", "S", 987_654)), 987_654);
    assert.equal(stateFromStat(statLine("node", "S", 987_654)), "S");
  });

  it("reads it when the executable name contains spaces and parentheses", () => {
    // A parser that splits on whitespace, or on the FIRST ')', gets this wrong —
    // and the filename is chosen by whoever starts the process.
    for (const comm of ["my ) program", "a b c", "((nested))", ") (", "weird )name("]) {
      assert.equal(startTimeFromStat(statLine(comm, "R", 4242)), 4242, `comm ${JSON.stringify(comm)}`);
      assert.equal(stateFromStat(statLine(comm, "R", 4242)), "R", `comm ${JSON.stringify(comm)}`);
    }
  });

  it("refuses to invent a value from a line it cannot read", () => {
    for (const raw of ["", "no parenthesis here", "1234 (node)", "1234 (node) S"]) {
      assert.equal(startTimeFromStat(raw), undefined, JSON.stringify(raw));
    }
  });
});

// =====================================================================
// A fixture /proc, for the cases a real one will not produce on demand
// =====================================================================

describe("TASK-018 AC-16: unreadable and zombie processes", () => {
  const root = mkdtempSync(join(tmpdir(), "sf-proc-"));

  function fakeProc(pid: number, line: string): void {
    mkdirSync(join(root, String(pid)), { recursive: true });
    writeFileSync(join(root, String(pid), "stat"), line, "utf8");
  }

  it("reports GONE for a ZOMBIE, because it cannot act and will never release the lease", () => {
    const between = Array.from({ length: 18 }, (_, index) => String(index + 100));
    fakeProc(501, `501 (dead) Z ${between.join(" ")} 777 0 0\n`);
    const probe = createProcLivenessProbe({ procRoot: root, machine: MACHINE });
    assert.equal(probe.check({ pid: 501, processStartedAt: 777, machine: MACHINE, claimedAt: 1 }), "GONE");
  });

  it("reports ALIVE for the same process when it is merely sleeping — the positive control", () => {
    const between = Array.from({ length: 18 }, (_, index) => String(index + 100));
    fakeProc(502, `502 (alive) S ${between.join(" ")} 778 0 0\n`);
    const probe = createProcLivenessProbe({ procRoot: root, machine: MACHINE });
    assert.equal(probe.check({ pid: 502, processStartedAt: 778, machine: MACHINE, claimedAt: 1 }), "ALIVE");
  });

  it("reports GONE for an absent entry, and UNKNOWN for one it cannot parse", () => {
    const probe = createProcLivenessProbe({ procRoot: root, machine: MACHINE });
    assert.equal(probe.check({ pid: 9999, processStartedAt: 1, machine: MACHINE, claimedAt: 1 }), "GONE");

    fakeProc(503, "garbage with no parenthesis\n");
    assert.equal(probe.check({ pid: 503, processStartedAt: 1, machine: MACHINE, claimedAt: 1 }), "UNKNOWN");
  });

  /**
   * ONLY ENOENT IS EVIDENCE OF DEATH — and nothing tested that until a mutation
   * survived to say so.
   *
   * The case above reaches the parser, because a file full of garbage still
   * READS. The `catch` that separates "this process has ended" from "this host
   * would not tell me" was never entered by any test, so replacing the whole
   * expression with `return "GONE"` changed no result and the mutation
   * survived. That is the harness doing its job: the guard was real and the
   * coverage was not.
   *
   * A DIRECTORY where the file should be makes `readFileSync` throw EISDIR —
   * deterministically, without needing a permission this test may not be able
   * to arrange. Reported as death, it would let a second owner take a lease
   * whose holder is still writing.
   */
  it("reports UNKNOWN when the entry cannot be READ, rather than treating it as death", () => {
    mkdirSync(join(root, "504", "stat"), { recursive: true });
    const probe = createProcLivenessProbe({ procRoot: root, machine: MACHINE });
    assert.equal(
      probe.check({ pid: 504, processStartedAt: 1, machine: MACHINE, claimedAt: 1 }),
      "UNKNOWN",
      "an unreadable /proc entry was reported as a dead process",
    );
  });
});
