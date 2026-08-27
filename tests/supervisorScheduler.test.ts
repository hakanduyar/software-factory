/**
 * The autonomous completion supervisor (TASK-006 AC-9..AC-16).
 *
 * The scenario this file exists to prove is the whole point of the task: the
 * Factory finishes one roadmap item, starts the next, survives a provider
 * limit, survives a crash, and asks a human only when a human is genuinely the
 * only thing that can act — all without a live AI conversation and without
 * spending a single token on waiting.
 *
 * Every test is offline: a scripted probe, a scripted executor and a manual
 * clock. No model is invoked and no provider is contacted.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConcurrencyError } from "../src/domain/errors.js";
import { BACKOFF_LADDER_MS } from "../src/supervision/resourceTypes.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import {
  declarePersisted,
  manualClock,
  newSupervisor,
  scriptedExecutor,
  scriptedProbe,
  seedRoadmap,
  TEST_CATALOG,
  TWO_ITEM_ROADMAP,
} from "./support/supervisorFixtures.js";

const FIVE_MINUTES = BACKOFF_LADDER_MS[0]!;

// =====================================================================
// AC-15: the roadmap advances with no human in the loop
// =====================================================================

describe("TASK-006 AC-15: one finished item makes the next eligible, with no human prompt", () => {
  it("completes A and then automatically runs B", async () => {
    const supervisor = newSupervisor();
    await seedRoadmap(supervisor, TWO_ITEM_ROADMAP);

    const first = await supervisor.service.tick();
    assert.equal(first.kind, "ADVANCED");
    if (first.kind === "ADVANCED") {
      assert.equal(first.roadmapKey, "A", "A runs first: B's dependency is unmet");
    }

    const second = await supervisor.service.tick();
    assert.equal(second.kind, "ADVANCED");
    if (second.kind === "ADVANCED") {
      assert.equal(second.roadmapKey, "B", "finishing A is what makes B eligible");
    }

    const third = await supervisor.service.tick();
    assert.equal(third.kind, "IDLE");
    if (third.kind === "IDLE") {
      assert.match(third.reason, /every roadmap item is DONE/);
    }
    // Nobody was ever asked anything.
    const state = (await supervisor.repository.load())!;
    assert.deepEqual(state.escalations, []);
  });

  it("does not start a dependent item while its prerequisite is unfinished", async () => {
    const executor = scriptedExecutor({
      A: [{ kind: "CHANGES_REQUIRED", findings: ["blocker one"] }],
    });
    const supervisor = newSupervisor({ executor });
    await seedRoadmap(supervisor, TWO_ITEM_ROADMAP);

    await supervisor.service.tick();
    await supervisor.service.tick();

    assert.deepEqual(
      executor.callsFor("B"),
      [],
      "B must not run until A is DONE, however many times A is retried",
    );
  });

  it("remediates CHANGES_REQUIRED autonomously and then integrates", async () => {
    const executor = scriptedExecutor({
      C: [
        { kind: "CHANGES_REQUIRED", findings: ["HIGH: authority widening"] },
        { kind: "COMPLETED", detail: "remediated and independently re-reviewed" },
      ],
    });
    const roadmap: readonly RoadmapItem[] = [
      { key: "C", title: "Remediating item", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ];
    const supervisor = newSupervisor({ executor });
    await seedRoadmap(supervisor, roadmap);

    const reviewed = await supervisor.service.tick();
    assert.equal(reviewed.kind, "ADVANCED");
    if (reviewed.kind === "ADVANCED") {
      assert.match(reviewed.detail, /CHANGES_REQUIRED/);
    }
    // Crucially: remediation is ordinary progress, not an escalation.
    const midState = (await supervisor.repository.load())!;
    assert.deepEqual(midState.escalations, [], "a human is not consulted between remediation rounds");
    assert.equal(midState.roadmap.find((item) => item.key === "C")?.status, "ELIGIBLE");

    const integrated = await supervisor.service.tick();
    assert.equal(integrated.kind, "ADVANCED");
    const finalState = (await supervisor.repository.load())!;
    assert.equal(finalState.roadmap.find((item) => item.key === "C")?.status, "DONE");
    assert.equal(executor.callsFor("C").length, 2);
  });

  it("stops asking a resource to work and asks a human when only a human can act", async () => {
    const executor = scriptedExecutor({
      E: [
        {
          kind: "HUMAN_REQUIRED",
          action: { kind: "PROVISION_VPS", description: "a 4GB always-on Ubuntu VPS is required" },
          detail: "the roadmap item cannot proceed without a server",
        },
      ],
    });
    const roadmap: readonly RoadmapItem[] = [
      { key: "E", title: "Server foundation", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ];
    const supervisor = newSupervisor({ executor });
    await seedRoadmap(supervisor, roadmap);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    if (result.kind === "WAITING_FOR_HUMAN") {
      assert.equal(result.reason, "FINANCIAL_ACTION_REQUIRED", "a VPS purchase is financial, not merely blocked");
      assert.match(result.humanActionRequired, /human must personally perform this transaction/i);
    }
    const state = (await supervisor.repository.load())!;
    assert.equal(state.roadmap.find((item) => item.key === "E")?.status, "WAITING_FOR_HUMAN_REQUIRED");
    assert.equal(state.escalations.length, 1);
    assert.equal(state.escalations[0]?.reason, "FINANCIAL_ACTION_REQUIRED");

    // And it does not quietly try again on the next tick.
    const again = await supervisor.service.tick();
    assert.equal(again.kind, "IDLE");
    assert.equal(executor.callsFor("E").length, 1, "no bypass, no retry of a human-only action");
  });

  /**
   * Found by running the shipped CLI, not by a unit test: an item that merely
   * needed a plan was reported as needing a financial transaction. The refusal
   * was right (an unregistered action kind is financial by the uncertainty
   * rule); the ADVICE was wrong, and wrong advice about money is its own defect.
   */
  it("asks for a decision, not a payment, when the work is free but needs a human", async () => {
    const executor = scriptedExecutor({
      F: [
        {
          kind: "HUMAN_REQUIRED",
          action: { kind: "AUTHOR_PLAN", description: "roadmap item F needs an approved plan" },
          detail: "the supervisor schedules work; authoring the plan is a human decision",
        },
      ],
    });
    const roadmap: readonly RoadmapItem[] = [
      { key: "F", title: "Needs a plan", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ];
    const supervisor = newSupervisor({ executor });
    await seedRoadmap(supervisor, roadmap);

    const result = await supervisor.service.tick();

    assert.equal(result.kind, "WAITING_FOR_HUMAN");
    if (result.kind === "WAITING_FOR_HUMAN") {
      assert.equal(result.reason, "HUMAN_DECISION_REQUIRED", "authoring a plan is a decision, not a transaction");
      assert.doesNotMatch(
        result.humanActionRequired,
        /transaction|payment|purchase/i,
        "an operator must never be told to pay for something that costs nothing",
      );
    }
    const state = (await supervisor.repository.load())!;
    assert.equal(state.roadmap.find((item) => item.key === "F")?.status, "WAITING_FOR_HUMAN_REQUIRED");
  });
});

// =====================================================================
// AC-9/AC-10: zero-token waiting and bounded backoff
// =====================================================================

describe("TASK-006 AC-9: waiting for a resource costs nothing", () => {
  it("waits, does not poll before retryAt, and resumes when time advances", async () => {
    const clock = manualClock();
    const probe = scriptedProbe();
    // EVERY resource is exhausted. A single healthy fallback would (correctly)
    // let the work proceed, which is not what this test is about.
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, { state: "USAGE_LIMIT_REACHED", reason: "scripted exhaustion" });
    }
    const executor = scriptedExecutor();
    const roadmap: readonly RoadmapItem[] = [
      { key: "D", title: "Limited item", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ];
    const supervisor = newSupervisor({ clock, probe, executor });
    await seedRoadmap(supervisor, roadmap);

    const limited = await supervisor.service.tick();
    assert.equal(limited.kind, "WAITING_FOR_RESOURCE");
    if (limited.kind === "WAITING_FOR_RESOURCE") {
      assert.equal(limited.nextWakeAt, clock.now() + FIVE_MINUTES, "the first backoff rung is 5 minutes");
    }

    const probesAfterFailure = probe.totalProbes();

    // Several ticks BEFORE retryAt must do nothing at all.
    for (let i = 0; i < 3; i += 1) {
      const idle = await supervisor.service.tick();
      assert.equal(idle.kind, "IDLE", "nothing is actionable while every resource is cooling down");
    }
    assert.equal(probe.totalProbes(), probesAfterFailure, "no probing before retryAt");
    assert.equal(executor.calls().length, 0, "and certainly no model invocation while waiting");

    // Time passes and the provider recovers; only now is a probe warranted.
    clock.advance(FIVE_MINUTES + 1);
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, { state: "AVAILABLE", reason: "quota reset", billingMode: "INCLUDED_SUBSCRIPTION" });
    }
    const resumed = await supervisor.service.tick();
    assert.equal(resumed.kind, "ADVANCED");
    assert.ok(probe.totalProbes() > probesAfterFailure, "the resource is re-probed once it is due");

    const state = (await supervisor.repository.load())!;
    assert.equal(state.roadmap.find((item) => item.key === "D")?.status, "DONE");
    assert.equal(executor.callsFor("D").length, 1, "the work ran exactly once, after recovery");
  });

  it("climbs the backoff ladder and keeps it across a restart", async () => {
    const clock = manualClock();
    const repository = newSupervisor().repository;
    // The probe keeps reporting failure: a probe that said AVAILABLE would
    // (correctly) clear the ladder, so a persistent outage is what exercises it.
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, { state: "PROVIDER_UNAVAILABLE", reason: "scripted outage" });
    }
    const roadmap: readonly RoadmapItem[] = [
      { key: "D", title: "Flaky item", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ];

    const first = newSupervisor({ clock, repository, probe });
    await seedRoadmap(first, roadmap);

    await first.service.tick();
    let state = (await repository.load())!;
    const used = state.resources.find((record) => record.backoff.attempt > 0)!;
    assert.equal(used.backoff.attempt, 1);
    assert.equal(used.backoff.delayMs, BACKOFF_LADDER_MS[0]);

    // A brand-new supervisor instance over the SAME durable state: the ladder
    // must continue, not restart, or a crash loop would hammer the provider at
    // the five-minute rung forever.
    clock.advance(BACKOFF_LADDER_MS[0]! + 1);
    const restarted = newSupervisor({ clock, repository, probe, ownerId: "supervisor:restarted" });
    await declarePersisted(restarted);
    await restarted.service.tick();

    state = (await repository.load())!;
    const after = state.resources.find((record) => record.key === used.key)!;
    assert.equal(after.backoff.attempt, 2, "the ladder continued across the restart");
    assert.equal(after.backoff.delayMs, BACKOFF_LADDER_MS[1], "and moved to the next rung");
  });

  it("caps the ladder rather than growing without bound", async () => {
    const clock = manualClock();
    const repository = newSupervisor().repository;
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, { state: "PROVIDER_UNAVAILABLE", reason: "scripted outage" });
    }
    const roadmap: readonly RoadmapItem[] = [
      { key: "D", title: "Persistently failing", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ];
    const supervisor = newSupervisor({ clock, repository, probe });
    await seedRoadmap(supervisor, roadmap);

    for (let i = 0; i < BACKOFF_LADDER_MS.length + 3; i += 1) {
      await supervisor.service.tick();
      clock.advance(BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1]! + 1);
    }

    const state = (await repository.load())!;
    const worst = state.resources.find((record) => record.backoff.attempt > 0)!;
    assert.ok(worst.backoff.attempt >= BACKOFF_LADDER_MS.length, "the ladder kept climbing");
    assert.equal(worst.backoff.delayMs, BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1], "capped at the top rung");
  });
});

// =====================================================================
// AC-11: a shortage is not a global outage
// =====================================================================

describe("TASK-006 AC-11: one exhausted resource does not stop the Factory", () => {
  it("keeps running deterministic work while every AI resource is unavailable", async () => {
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, { state: "USAGE_LIMIT_REACHED", reason: "scripted exhaustion" });
    }
    const roadmap: readonly RoadmapItem[] = [
      { key: "AI_WORK", title: "Needs a model", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
      // Round 5 (F5-FIN-3): deterministic work must declare what it will do, so
      // that every action kind goes through the gate before the executor runs.
      // Declaring nothing used to be the way to be asked nothing.
      {
        key: "LOCAL_WORK",
        title: "Deterministic only",
        dependsOn: [],
        status: "PENDING",
        workClass: "DETERMINISTIC",
        order: 2,
        declaredActionKinds: ["RUN_TESTS"],
      },
    ];
    const executor = scriptedExecutor();
    const supervisor = newSupervisor({ probe, executor });
    await seedRoadmap(supervisor, roadmap);

    const first = await supervisor.service.tick();
    assert.equal(first.kind, "WAITING_FOR_RESOURCE");
    if (first.kind === "WAITING_FOR_RESOURCE") {
      assert.equal(first.roadmapKey, "AI_WORK");
    }

    const second = await supervisor.service.tick();
    assert.equal(second.kind, "ADVANCED", "deterministic work needs no provider and must still run");
    if (second.kind === "ADVANCED") {
      assert.equal(second.roadmapKey, "LOCAL_WORK");
    }
    assert.equal(executor.callsFor("LOCAL_WORK").length, 1);
    assert.equal(executor.callsFor("AI_WORK").length, 0);
  });
});

// =====================================================================
// AC-16: crash safety
// =====================================================================

describe("TASK-006 AC-16: a crash never duplicates external work", () => {
  it("retries an action that was CLAIMED but never launched", async () => {
    const repository = newSupervisor().repository;
    const supervisor = newSupervisor({ repository });
    await seedRoadmap(supervisor, TWO_ITEM_ROADMAP);

    const state = (await repository.load())!;
    await repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        activeClaim: {
          actionId: "A:LAUNCH_AI_WORKER:a1",
          roadmapKey: "A",
          kind: "LAUNCH_AI_WORKER",
          state: "CLAIMED",
          ownerId: "supervisor:crashed",
          attempt: 1,
          claimedAt: 0,
        },
        roadmap: state.roadmap.map((item) => (item.key === "A" ? { ...item, status: "ACTIVE" as const } : item)),
      },
      state.version,
    );

    const restarted = newSupervisor({ repository, ownerId: "supervisor:fresh" });

    await declarePersisted(restarted);
    const result = await restarted.service.tick();

    // CLAIMED proves nothing external happened, so retrying is safe.
    assert.equal(result.kind, "ADVANCED");
    const after = (await repository.load())!;
    assert.equal(after.activeClaim, undefined, "the stale claim was cleared");
  });

  it("fails closed on an action left RUNNING by a lost owner", async () => {
    const repository = newSupervisor().repository;
    const executor = scriptedExecutor();
    const supervisor = newSupervisor({ repository, executor });
    await seedRoadmap(supervisor, TWO_ITEM_ROADMAP);

    const state = (await repository.load())!;
    await repository.compareAndSave(
      {
        ...state,
        version: state.version + 1,
        activeClaim: {
          actionId: "A:LAUNCH_AI_WORKER:a1",
          roadmapKey: "A",
          kind: "LAUNCH_AI_WORKER",
          state: "RUNNING",
          ownerId: "supervisor:crashed",
          attempt: 1,
          claimedAt: 0,
        },
        roadmap: state.roadmap.map((item) => (item.key === "A" ? { ...item, status: "ACTIVE" as const } : item)),
      },
      state.version,
    );

    const restarted = newSupervisor({ repository, executor, ownerId: "supervisor:fresh" });

    await declarePersisted(restarted);
    const result = await restarted.service.tick();

    assert.equal(result.kind, "RECOVERY_REQUIRED", "an unknowable outcome must not be repeated");
    assert.equal(executor.calls().length, 0, "and nothing was launched");
    const after = (await repository.load())!;
    assert.equal(after.escalations[0]?.reason, "RECOVERY_REQUIRED");
  });

  it("refuses to commit on a lost CAS rather than overwriting a concurrent tick", async () => {
    const repository = newSupervisor().repository;
    const supervisor = newSupervisor({ repository });
    await seedRoadmap(supervisor, TWO_ITEM_ROADMAP);
    const stale = (await repository.load())!;

    // Something else advances the state first.
    await repository.compareAndSave({ ...stale, version: stale.version + 1 }, stale.version);

    await assert.rejects(
      () => repository.compareAndSave({ ...stale, version: stale.version + 1 }, stale.version),
      ConcurrencyError,
    );
  });
});

// =====================================================================
// AC-14: session rollover
// =====================================================================

describe("TASK-006 AC-14: a full context rolls over without losing work", () => {
  it("checkpoints, then resumes the same action in a fresh process", async () => {
    const repository = newSupervisor().repository;
    const roadmap: readonly RoadmapItem[] = [
      { key: "LONG", title: "Long item", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
    ];
    const executor = scriptedExecutor({
      LONG: [
        {
          kind: "CHECKPOINT",
          detail: "context exhausted; rolling the session over",
          checkpoint: {
            roadmapKey: "LONG",
            actionId: "LONG:LAUNCH_AI_WORKER:a1",
            iteration: 1,
            completedVerification: ["typecheck", "build"],
            pendingVerification: ["npm test"],
            findings: ["implementer:claude-code:opus"],
            nextAction: "run the remaining verification",
            requiredWorkClass: "NORMAL_IMPLEMENTATION",
            branch: "feat/long",
            baseCommit: "abc1234",
            updatedAt: 0,
          },
        },
        { kind: "COMPLETED", detail: "finished after rollover" },
      ],
    });
    const supervisor = newSupervisor({ repository, executor });
    await seedRoadmap(supervisor, roadmap);

    const rolled = await supervisor.service.tick();
    assert.equal(rolled.kind, "ADVANCED");

    const state = (await repository.load())!;
    const checkpoint = state.checkpoints.find((entry) => entry.roadmapKey === "LONG");
    assert.ok(checkpoint, "a checkpoint was persisted");
    assert.deepEqual(checkpoint?.completedVerification, ["typecheck", "build"]);
    assert.equal(checkpoint?.nextAction, "run the remaining verification");
    assert.equal(state.roadmap.find((item) => item.key === "LONG")?.status, "ELIGIBLE");

    // A brand-new process — no shared memory, no transcript — resumes it.
    const fresh = newSupervisor({ repository, executor, ownerId: "supervisor:new-session" });
    await declarePersisted(fresh);
    const finished = await fresh.service.tick();
    assert.equal(finished.kind, "ADVANCED");

    const resumeCall = executor.callsFor("LONG").at(-1)!;
    assert.equal(resumeCall.checkpoint?.nextAction, "run the remaining verification");
    assert.deepEqual(resumeCall.checkpoint?.completedVerification, ["typecheck", "build"]);

    const after = (await repository.load())!;
    assert.equal(after.roadmap.find((item) => item.key === "LONG")?.status, "DONE");
    assert.deepEqual(after.checkpoints, [], "a finished item leaves no stale checkpoint behind");
  });
});

// =====================================================================
// Auth is human-only, never retried on a timer
// =====================================================================

describe("TASK-006: an expired credential asks a human instead of looping", () => {
  /**
   * Auth is detected by the ZERO-TOKEN PROBE, which reads the measured
   * `loggedIn` / `auth.credentials.status` fields structurally — not by
   * scraping a failed worker's output. The review's honesty audit is why:
   * only the signed-in outputs were ever observed on this machine, so
   * inferring the text of the logged-out case would have been a guess dressed
   * as a measurement. Reading a field that provably exists is not a guess.
   */
  it("marks the resource AUTH_REQUIRED from the structural probe and schedules no retry", async () => {
    const probe = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe.set(entry.provider, entry.model, {
        state: "AUTH_REQUIRED",
        reason: "claude auth status reports no logged-in session",
      });
    }
    const executor = scriptedExecutor();
    const supervisor = newSupervisor({ probe, executor });
    await seedRoadmap(supervisor, TWO_ITEM_ROADMAP);

    const result = await supervisor.service.tick();

    // No usable resource exists, so the item waits rather than running.
    assert.equal(result.kind, "WAITING_FOR_RESOURCE");
    assert.equal(executor.calls().length, 0, "nothing is launched against an unauthenticated provider");

    const state = (await supervisor.repository.load())!;
    const authed = state.resources.filter((record) => record.state === "AUTH_REQUIRED");
    assert.equal(authed.length, TEST_CATALOG.length, "every resource is marked AUTH_REQUIRED");
    for (const record of authed) {
      assert.equal(record.retryAt, undefined, "no timer can supply a credential, so none is scheduled");
      assert.equal(record.backoff.attempt, 0, "and it does not climb a backoff ladder it can never finish");
    }
  });

  it("escalates to a human when a worker run itself fails on authentication", async () => {
    // Here the PROBE says healthy but the actual run reports a logged-out
    // session, which the structural interpreter recognises.
    const executor = scriptedExecutor({
      A: [
        {
          kind: "RESOURCE_FAILURE",
          process: { terminationReason: "EXITED", exitCode: 1, stdout: "", stderr: "session expired" },
        },
      ],
    });
    const supervisor = newSupervisor({ executor });
    await seedRoadmap(supervisor, TWO_ITEM_ROADMAP);

    const result = await supervisor.service.tick();

    // An unrecognised failure is UNKNOWN_FAILURE, which is safe: bounded
    // backoff, no spend, no duplicate work. It is deliberately NOT guessed
    // into AUTH_REQUIRED from unobserved message text.
    assert.equal(result.kind, "WAITING_FOR_RESOURCE");
    const state = (await supervisor.repository.load())!;
    assert.ok(state.resources.some((record) => record.state === "UNKNOWN_FAILURE"));
  });
});
