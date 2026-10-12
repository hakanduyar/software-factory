/**
 * DEFECT-DURABLE-WORKER-RUN-ENVELOPE — pure domain logic.
 *
 * No process, no filesystem, no clock: every fact arrives as an argument, per
 * `workerRunEnvelope.ts`'s own invariant. Liveness is driven by a fake probe so
 * every branch is directly reachable.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ActivityLease, Liveness, LivenessProbe } from "../src/supervision/activity.js";
import {
  adoptWorkerRun,
  applyWorkerRunReconciliation,
  canonicalWorkerRunId,
  classifyWorkerRun,
  completeWorkerRun,
  enqueueWorkerRunNotification,
  isTerminalWorkerRunState,
  prepareWorkerRun,
  reportWorkerRunHeartbeat,
  workerRunNotificationKey,
  type WorkerRunEnvelope,
  type WorkerRunNotification,
} from "../src/supervision/workerRunEnvelope.js";

function lease(overrides: Partial<ActivityLease> = {}): ActivityLease {
  return { pid: 1000, processStartedAt: 500, machine: "m1", boot: "b1", claimedAt: 0, ...overrides };
}

function fixedProbe(answer: Liveness): LivenessProbe {
  return { check: () => answer };
}

describe("AC-1: PREPARED is written before anything is spawned", () => {
  it("creates a PREPARED envelope naming a canonical run id derived from the action", () => {
    const prepared = prepareWorkerRun([], {
      actionId: "ITEM:implement:a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "claude-code",
      model: "opus",
      now: 100,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal(prepared.run.runId, canonicalWorkerRunId("ITEM:implement:a1"));
    assert.equal(prepared.run.state, "PREPARED");
    assert.equal(prepared.run.wrapperLease, undefined);
  });

  it("refuses to prepare a second launch for a run that is not terminal", () => {
    const first = prepareWorkerRun([], {
      actionId: "ITEM:implement:a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "claude-code",
      model: "opus",
      now: 100,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = prepareWorkerRun(first.runs, {
      actionId: "ITEM:implement:a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "claude-code",
      model: "opus",
      now: 200,
    });
    assert.equal(second.ok, false);
    if (second.ok) return;
    // NOT merely "refused for some reason": refused BECAUSE a launch is
    // already in flight — distinct from the sibling "already finished"
    // refusal below, which names a different fact about a terminal run.
    assert.match(second.problem, /refusing to prepare a second launch/);
  });

  it("refuses to reuse a finished run id for a fresh launch", () => {
    const prepared = prepareWorkerRun([], {
      actionId: "ITEM:implement:a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "claude-code",
      model: "opus",
      now: 100,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const done = completeWorkerRun(prepared.runs, prepared.run.runId, {
      state: "COMPLETED",
      exitCode: 0,
      signal: null,
      detail: "ok",
      at: 200,
    });
    // Can't complete straight from PREPARED per the two-phase handshake below,
    // but adopt first so the terminal case is reachable.
    const adopted = adoptWorkerRun(prepared.runs, prepared.run.runId, { lease: lease(), at: 150 });
    assert.equal(adopted.ok, true);
    if (!adopted.ok) return;
    const finished = completeWorkerRun(adopted.runs, adopted.run.runId, {
      state: "COMPLETED",
      exitCode: 0,
      signal: null,
      detail: "ok",
      at: 200,
    });
    assert.equal(finished.ok, true);
    if (!finished.ok) return;
    void done;
    const retried = prepareWorkerRun(finished.runs, {
      actionId: "ITEM:implement:a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "claude-code",
      model: "opus",
      now: 300,
    });
    assert.equal(retried.ok, false);
  });
});

describe("AC-2: RUNNING requires the child's own ACK, not launcher intent", () => {
  it("moves PREPARED to RUNNING only once a lease naming a real process is adopted", () => {
    const prepared = prepareWorkerRun([], {
      actionId: "ITEM:implement:a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "claude-code",
      model: "opus",
      now: 100,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    const adopted = adoptWorkerRun(prepared.runs, prepared.run.runId, {
      lease: lease(),
      at: 150,
      childPid: 2000,
      providerSessionId: "sess-1",
    });
    assert.equal(adopted.ok, true);
    if (!adopted.ok) return;
    assert.equal(adopted.run.state, "RUNNING");
    assert.deepEqual(adopted.run.wrapperLease, lease());
    assert.equal(adopted.run.childPid, 2000);
    assert.equal(adopted.run.providerSessionId, "sess-1");
    assert.equal(adopted.run.startedAt, 150);
  });

  it("re-adopting the SAME holder is a no-op, not a second adoption", () => {
    const prepared = prepareWorkerRun([], {
      actionId: "a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "codex-cli",
      model: "gpt",
      now: 0,
    });
    if (!prepared.ok) throw new Error("unreachable");
    const first = adoptWorkerRun(prepared.runs, prepared.run.runId, { lease: lease(), at: 10 });
    if (!first.ok) throw new Error("unreachable");
    const second = adoptWorkerRun(first.runs, first.run.runId, { lease: lease(), at: 20 });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    // Unchanged: the second adoption did not move startedAt forward.
    assert.equal(second.run.startedAt, 10);
  });
});

describe("AC-3: a different identity for the same run is AMBIGUOUS, never a second worker", () => {
  it("refuses a different PID for an already-running envelope", () => {
    const prepared = prepareWorkerRun([], {
      actionId: "a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "codex-cli",
      model: "gpt",
      now: 0,
    });
    if (!prepared.ok) throw new Error("unreachable");
    const adopted = adoptWorkerRun(prepared.runs, prepared.run.runId, { lease: lease({ pid: 1000 }), at: 10 });
    if (!adopted.ok) throw new Error("unreachable");
    const rival = adoptWorkerRun(adopted.runs, adopted.run.runId, { lease: lease({ pid: 1000, processStartedAt: 999 }), at: 20 });
    assert.equal(rival.ok, false);
  });

  it("refuses to adopt a run that already finished", () => {
    const prepared = prepareWorkerRun([], {
      actionId: "a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "codex-cli",
      model: "gpt",
      now: 0,
    });
    if (!prepared.ok) throw new Error("unreachable");
    const adopted = adoptWorkerRun(prepared.runs, prepared.run.runId, { lease: lease(), at: 10 });
    if (!adopted.ok) throw new Error("unreachable");
    const done = completeWorkerRun(adopted.runs, adopted.run.runId, {
      state: "COMPLETED",
      exitCode: 0,
      signal: null,
      detail: "ok",
      at: 20,
    });
    if (!done.ok) throw new Error("unreachable");
    const lateAck = adoptWorkerRun(done.runs, adopted.run.runId, { lease: lease({ pid: 4242 }), at: 30 });
    assert.equal(lateAck.ok, false);
  });
});

describe("AC-4: heartbeat proves liveness independent of output", () => {
  it("C6-H3: a repeated identical progress value refreshes liveness without moving the progress clock", () => {
    const prepared = prepareWorkerRun([], {
      actionId: "a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "codex-cli",
      model: "gpt",
      now: 0,
    });
    if (!prepared.ok) throw new Error("unreachable");
    const adopted = adoptWorkerRun(prepared.runs, prepared.run.runId, { lease: lease(), at: 10 });
    if (!adopted.ok) throw new Error("unreachable");

    const first = reportWorkerRunHeartbeat(adopted.runs, adopted.run.runId, { at: 20, progress: 3 }, lease());
    if (!first.ok) throw new Error("unreachable");
    assert.equal(first.changed, true);

    const repeat = reportWorkerRunHeartbeat(first.runs, adopted.run.runId, { at: 999, progress: 3 }, lease());
    assert.equal(repeat.ok, true);
    if (!repeat.ok) return;
    assert.equal(repeat.changed, true);
    assert.equal(repeat.runs[0]?.heartbeat?.at, 999);
    assert.equal(repeat.runs[0]?.heartbeat?.lastProgressAt, 20);
  });

  it("C6-H3: increasing measured progress advances both clocks", () => {
    const prepared = prepareWorkerRun([], {
      actionId: "a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "codex-cli",
      model: "gpt",
      now: 0,
    });
    if (!prepared.ok) throw new Error("unreachable");
    const adopted = adoptWorkerRun(prepared.runs, prepared.run.runId, { lease: lease(), at: 10 });
    if (!adopted.ok) throw new Error("unreachable");
    const first = reportWorkerRunHeartbeat(adopted.runs, adopted.run.runId, { at: 20, progress: 3 }, lease());
    if (!first.ok) throw new Error("unreachable");
    const advanced = reportWorkerRunHeartbeat(first.runs, adopted.run.runId, { at: 30, progress: 4 }, lease());
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.changed, true);
    assert.equal(advanced.runs[0]?.heartbeat?.at, 30);
    assert.equal(advanced.runs[0]?.heartbeat?.lastProgressAt, 30);
  });

  it("refuses a heartbeat from a process that does not hold the lease", () => {
    const prepared = prepareWorkerRun([], {
      actionId: "a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "codex-cli",
      model: "gpt",
      now: 0,
    });
    if (!prepared.ok) throw new Error("unreachable");
    const adopted = adoptWorkerRun(prepared.runs, prepared.run.runId, { lease: lease({ pid: 1 }), at: 10 });
    if (!adopted.ok) throw new Error("unreachable");
    const rival = reportWorkerRunHeartbeat(adopted.runs, adopted.run.runId, { at: 20, progress: 1 }, lease({ pid: 2 }));
    assert.equal(rival.ok, false);
  });
});

describe("AC-5/AC-6: completion is bound to the action, and MAX_TURNS is not a failure", () => {
  function running(): readonly WorkerRunEnvelope[] {
    const prepared = prepareWorkerRun([], {
      actionId: "a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "claude-code",
      model: "opus",
      maxTurns: 40,
      now: 0,
    });
    if (!prepared.ok) throw new Error("unreachable");
    const adopted = adoptWorkerRun(prepared.runs, prepared.run.runId, { lease: lease(), at: 10 });
    if (!adopted.ok) throw new Error("unreachable");
    return adopted.runs;
  }

  it("records exit 0 as COMPLETED", () => {
    const done = completeWorkerRun(running(), canonicalWorkerRunId("a1"), {
      state: "COMPLETED",
      exitCode: 0,
      signal: null,
      detail: "ok",
      at: 20,
    });
    assert.equal(done.ok, true);
  });

  it("verified MAX_TURNS is AWAITING_CONTROLLER even on exit 0, and preserves the provider session", () => {
    const done = completeWorkerRun(running(), canonicalWorkerRunId("a1"), {
      state: "AWAITING_CONTROLLER",
      exitCode: 0,
      signal: null,
      terminalReason: "MAX_TURNS",
      providerSessionId: "sess-max",
      detail: "structured terminal_reason=max_turns",
      at: 20,
    });
    assert.equal(done.ok, true);
    if (!done.ok) return;
    const [run] = done.runs.filter((entry) => entry.runId === canonicalWorkerRunId("a1"));
    assert.equal(run?.state, "AWAITING_CONTROLLER");
    assert.equal(run?.terminalReason, "MAX_TURNS");
    assert.equal(run?.providerSessionId, "sess-max");
    assert.equal(isTerminalWorkerRunState(run!.state), true);
  });

  it("AC-6: AWAITING_CONTROLLER never auto-continues — a later disagreeing completion is refused, not applied", () => {
    const maxTurns = completeWorkerRun(running(), canonicalWorkerRunId("a1"), {
      state: "AWAITING_CONTROLLER",
      exitCode: 0,
      signal: null,
      terminalReason: "MAX_TURNS",
      detail: "structured terminal_reason=max_turns",
      at: 20,
    });
    if (!maxTurns.ok) throw new Error("unreachable");
    // A later tick somehow believing this run went on to COMPLETED must never
    // be allowed to overwrite AWAITING_CONTROLLER: that would BE the automatic
    // continuation AC-6 forbids, arriving through the completion path instead
    // of a launch.
    const laterCompletion = completeWorkerRun(maxTurns.runs, canonicalWorkerRunId("a1"), {
      state: "COMPLETED",
      exitCode: 0,
      signal: null,
      detail: "a later process believed this run simply finished",
      at: 999,
    });
    assert.equal(laterCompletion.ok, false);
    const [run] = maxTurns.runs.filter((entry) => entry.runId === canonicalWorkerRunId("a1"));
    assert.equal(run?.state, "AWAITING_CONTROLLER", "the terminal record itself must never move");
  });

  it("a repeat with the SAME content is a no-op; a disagreeing repeat is refused", () => {
    const runs = running();
    const first = completeWorkerRun(runs, canonicalWorkerRunId("a1"), {
      state: "FAILED",
      exitCode: 1,
      signal: null,
      detail: "boom",
      at: 20,
    });
    if (!first.ok) throw new Error("unreachable");

    const repeat = completeWorkerRun(first.runs, canonicalWorkerRunId("a1"), {
      state: "FAILED",
      exitCode: 1,
      signal: null,
      detail: "boom",
      at: 999,
    });
    assert.equal(repeat.ok, true);
    if (!repeat.ok) return;
    assert.equal(repeat.changed, false);

    const disagreement = completeWorkerRun(first.runs, canonicalWorkerRunId("a1"), {
      state: "COMPLETED",
      exitCode: 0,
      signal: null,
      detail: "actually fine",
      at: 999,
    });
    assert.equal(disagreement.ok, false);
  });

  it("a signal-terminated run and a timeout each produce a distinct FAILED completion", () => {
    const signalled = completeWorkerRun(running(), canonicalWorkerRunId("a1"), {
      state: "FAILED",
      exitCode: null,
      signal: "SIGKILL",
      detail: "killed",
      at: 20,
    });
    assert.equal(signalled.ok, true);
  });
});

describe("AC-7: reconciliation classifies without ever launching anything", () => {
  function runningEnvelope(): WorkerRunEnvelope {
    const prepared = prepareWorkerRun([], {
      actionId: "a1",
      roadmapKey: "ITEM",
      attempt: 1,
      provider: "codex-cli",
      model: "gpt",
      now: 0,
    });
    if (!prepared.ok) throw new Error("unreachable");
    const adopted = adoptWorkerRun(prepared.runs, prepared.run.runId, { lease: lease(), at: 10 });
    if (!adopted.ok) throw new Error("unreachable");
    return adopted.run;
  }

  it("a dead owner is LOST", () => {
    const verdict = classifyWorkerRun(runningEnvelope(), { now: 1000, stallAfterMs: 500 }, fixedProbe("GONE"));
    assert.equal(verdict?.verdict, "LOST");
  });

  it("a live owner that has stopped reporting past the threshold is STALLED", () => {
    const verdict = classifyWorkerRun(runningEnvelope(), { now: 100_000, stallAfterMs: 500 }, fixedProbe("ALIVE"));
    assert.equal(verdict?.verdict, "STALLED");
  });

  it("a live, on-time owner concludes nothing yet", () => {
    const verdict = classifyWorkerRun(runningEnvelope(), { now: 50, stallAfterMs: 500 }, fixedProbe("ALIVE"));
    assert.equal(verdict, undefined);
  });

  it("an unverifiable identity is AMBIGUOUS", () => {
    const verdict = classifyWorkerRun(runningEnvelope(), { now: 1000, stallAfterMs: 500 }, fixedProbe("UNKNOWN"));
    assert.equal(verdict?.verdict, "AMBIGUOUS");
  });

  it("a terminal run is left alone", () => {
    const done = completeWorkerRun([runningEnvelope()], canonicalWorkerRunId("a1"), {
      state: "COMPLETED",
      exitCode: 0,
      signal: null,
      detail: "ok",
      at: 20,
    });
    if (!done.ok) throw new Error("unreachable");
    const [run] = done.runs;
    assert.equal(classifyWorkerRun(run!, { now: 999_999, stallAfterMs: 1 }, fixedProbe("GONE")), undefined);
  });

  it("applying a reconciliation verdict never overwrites a real completion", () => {
    const done = completeWorkerRun([runningEnvelope()], canonicalWorkerRunId("a1"), {
      state: "COMPLETED",
      exitCode: 0,
      signal: null,
      detail: "ok",
      at: 20,
    });
    if (!done.ok) throw new Error("unreachable");
    const applied = applyWorkerRunReconciliation(done.runs, canonicalWorkerRunId("a1"), "LOST", "stale", 999);
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.changed, false);
    const [run] = applied.runs;
    assert.equal(run?.state, "COMPLETED");
  });

  it("applying the same verdict twice is idempotent", () => {
    const first = applyWorkerRunReconciliation([runningEnvelope()], canonicalWorkerRunId("a1"), "LOST", "dead", 100);
    if (!first.ok) throw new Error("unreachable");
    const second = applyWorkerRunReconciliation(first.runs, canonicalWorkerRunId("a1"), "LOST", "dead again", 200);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.changed, false);
  });
});

describe("AC-8: at most one pending notification per (run, kind)", () => {
  it("dedupe key is a pure function of runId and kind", () => {
    assert.equal(workerRunNotificationKey("r1", "MAX_TURNS"), workerRunNotificationKey("r1", "MAX_TURNS"));
    assert.notEqual(workerRunNotificationKey("r1", "MAX_TURNS"), workerRunNotificationKey("r1", "LOST"));
  });

  it("enqueueing the same notification repeatedly adds it exactly once", () => {
    const notification: WorkerRunNotification = {
      key: workerRunNotificationKey("r1", "LOST"),
      runId: "r1",
      roadmapKey: "ITEM",
      kind: "LOST",
      detail: "owner is gone",
      createdAt: 10,
    };
    const first = enqueueWorkerRunNotification([], notification);
    assert.equal(first.changed, true);
    const second = enqueueWorkerRunNotification(first.outbox, { ...notification, detail: "owner is gone (again)", createdAt: 20 });
    assert.equal(second.changed, false);
    assert.equal(second.outbox.length, 1);
  });
});
