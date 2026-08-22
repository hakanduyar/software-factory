/**
 * Headless coverage of `npm run demo:plan` (src/cli/demoPlan.ts) — the TASK-005
 * durable-planner demo required by
 * docs/tasks/TASK-005-planner-task-generator.md §16.
 *
 * The demo is the one place where all five §16 scenarios run against the REAL
 * Factory gates and (for scenarios 1 and 2) the REAL TASK-004
 * `EngineeringLoopService` over a real temporary git workspace, with only the
 * two model calls replaced by scripted closures. So asserting on its RESULT
 * OBJECT — not on log formatting — is what turns "the demo printed something
 * plausible" into a permanent, executable proof (C3).
 *
 * What this file proves, and the acceptance criteria each part covers:
 *
 *   - §16.1 / AC-10 — a clear intent reaches human approval, materializes a
 *     real WorkItem and is handed to the real TASK-004 loop, which finishes
 *     execution; the plan derives WAITING_FOR_HUMAN from authoritative WorkItem
 *     state rather than from any agent's self-report (AC-16).
 *   - §16.2 / AC-3 — genuine blocking ambiguity produces a durable clarification
 *     cycle, and the human's answer produces a real, approvable revision from a
 *     SECOND planner run. Note the deliberate design point this pins down:
 *     asking is not planning (§6), so the clarification-only response persists
 *     NO revision — the answered plan is revision 1 off two planner runs, not
 *     revision 2, and every persisted revision therefore stays approvable.
 *   - §16.3 / AC-9 — B is not dispatched until A is genuinely execution
 *     finished; once A is, every item is dispatched.
 *   - §16.4 / AC-1 — a planner that writes the word "APPROVED" in prose gains
 *     nothing: the plan fails closed to BLOCKED with no approvable revision at
 *     all (revision 0).
 *   - §16.5 / AC-7, AC-11, AC-12 — a crash mid-materialization, then a restart
 *     over the same durable state, reconciles to exactly two WorkItems with no
 *     duplicates.
 *   - AC-13 — unattended execution: the demo source contains no interactive-I/O
 *     primitive, so the whole five-scenario run completes with zero stdin
 *     reads. Proven structurally, in the same style as
 *     tests/unattendedExecutionInvariant.test.ts §A.
 *   - §16 — the run is deterministic: two runs produce byte-identical
 *     transcripts (fixed clocks, sequential id generators, no wall-clock or
 *     temp-path text in any emitted line).
 *
 * No real AI CLI is invoked and no network is touched: the demo's planner is a
 * canned-string closure and its loop workers are TASK-004's scripted ones. The
 * demo creates (and removes, in its own `finally`) its temporary git
 * workspaces, so this file allocates no database or directory of its own and
 * therefore needs no `cleanupTempDbs()`/`cleanupTempWorkspaces()` hook.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { runPlanDemo, type PlanDemoResult } from "../src/cli/demoPlan.js";

/**
 * Generous: the demo initializes several git repositories and spawns real
 * `node -e "process.exit(0)"` verification processes for the two scenarios
 * driven by the real TASK-004 loop, and this file runs the whole demo twice.
 */
const DEMO_TIMEOUT_MS = 180_000;

interface DemoRuns {
  readonly first: PlanDemoResult;
  readonly second: PlanDemoResult;
  /** Everything the first run pushed through its `log` option, in order. */
  readonly firstLogged: readonly string[];
}

let runsPromise: Promise<DemoRuns> | undefined;

/**
 * Runs the demo exactly twice, strictly sequentially, and memoizes the result
 * for every `it()` in this file.
 *
 * Sequential is not incidental: `runPlanDemo` tracks its scratch git
 * workspaces in module-level state and removes every tracked directory in its
 * `finally`, so two overlapping runs would delete each other's workspaces.
 */
function demoRuns(): Promise<DemoRuns> {
  if (runsPromise === undefined) {
    runsPromise = (async (): Promise<DemoRuns> => {
      const firstLogged: string[] = [];
      // `log` is a pure sink — it cannot influence what the demo does or what
      // it records in `transcript` — so run 2 omitting it does not make the
      // determinism comparison below unfair.
      const first = await runPlanDemo({ log: (line) => firstLogged.push(line) });
      const second = await runPlanDemo();
      return { first, second, firstLogged };
    })();
  }
  return runsPromise;
}

async function demo(): Promise<PlanDemoResult> {
  return (await demoRuns()).first;
}

/** The first transcript line satisfying `predicate`, or undefined. */
function findLine(transcript: readonly string[], predicate: (line: string) => boolean): string | undefined {
  return transcript.find(predicate);
}

describe("demo:plan — the five TASK-005 §16 scenarios, offline", () => {
  it("runs all five scenarios to completion without throwing, and the transcript matches the log sink", { timeout: DEMO_TIMEOUT_MS }, async () => {
    const { first, firstLogged } = await demoRuns();

    assert.ok(first.transcript.length > 0, "the demo must produce a transcript");
    assert.deepEqual(
      [...firstLogged],
      [...first.transcript],
      "every line handed to the `log` option must also be recorded in the returned transcript",
    );
    assert.equal(first.transcript[0], "== Software Factory durable planner demo (TASK-005) ==");
    assert.ok(
      first.transcript.some((line) => line.includes("No network, no AI provider")),
      "the demo must state its offline posture",
    );
  });

  it("scenario 1: a clear intent materializes and dispatches real work, and the plan derives WAITING_FOR_HUMAN (§16.1, AC-10, AC-16)", { timeout: DEMO_TIMEOUT_MS }, async () => {
    const { scenario1, transcript } = await demo();

    assert.ok(scenario1.materializedCount >= 1, `expected at least one materialized item, got ${scenario1.materializedCount}`);
    assert.ok(scenario1.dispatchedCount >= 1, `expected at least one dispatched item, got ${scenario1.dispatchedCount}`);
    assert.equal(scenario1.materializedCount, 1);
    assert.equal(scenario1.dispatchedCount, 1);
    assert.equal(scenario1.itemCount, 1);
    assert.equal(scenario1.revision, 1);
    assert.equal(scenario1.approvedRevision, 1);
    assert.equal(scenario1.totalPlannerRuns, 1);

    // Derived, not asserted by an agent: the real TASK-004 loop drives the
    // WorkItem to WAITING_FOR_HUMAN, `deriveCompletion` re-checks that
    // execution really is finished with live review authority, and only then
    // moves the plan itself to WAITING_FOR_HUMAN. It is deliberately NOT
    // COMPLETED — that would require a human release approval (AC-16).
    assert.equal(scenario1.phase, "WAITING_FOR_HUMAN");
    assert.equal(scenario1.outcome, undefined, "execution finished is not a plan outcome; only release approval could complete the plan");
    assert.equal(scenario1.humanActionRequired, true);

    assert.equal(
      findLine(transcript, (line) => line.startsWith("scenario 1 result:")),
      "scenario 1 result: phase=WAITING_FOR_HUMAN materialized=1 dispatched=1",
    );
  });

  it("scenario 2: a blocking question yields no approvable revision, and the answered plan is revision 1 (§16.2, AC-3)", { timeout: DEMO_TIMEOUT_MS }, async () => {
    const { scenario2, transcript } = await demo();

    // Asking is not planning (design §6): a clarification-only response
    // persists NO revision, so the first real plan is revision 1 rather than a
    // question-shaped revision 1 followed by a real revision 2. This keeps the
    // invariant that every persisted revision is approvable.
    assert.equal(scenario2.revision, 1, "the clarification consumed no revision number");
    assert.equal(scenario2.approvedRevision, 1, "the human approved the only approvable revision that ever existed");
    assert.equal(scenario2.openQuestionCount, 0, "the blocking question must be closed once answered");
    assert.equal(scenario2.totalPlannerRuns, 2, "one planner run asked the question, a second produced the plan");
    assert.equal(scenario2.phase, "WAITING_FOR_HUMAN");
    assert.equal(scenario2.dispatchedCount, 1);

    assert.ok(
      transcript.some((line) => line.includes("Should expired records be deleted or archived?")),
      "the demo must show the genuine blocking question the planner asked",
    );
    assert.equal(
      findLine(transcript, (line) => line.startsWith("after the answer the plan is")),
      "after the answer the plan is PLAN_REVIEW at revision 1",
    );
    assert.equal(
      findLine(transcript, (line) => line.startsWith("scenario 2 result:")),
      "scenario 2 result: phase=WAITING_FOR_HUMAN revision=1 dispatched=1",
    );
  });

  it("scenario 3: B is dispatched only after A genuinely finished, so every item ends dispatched (§16.3, AC-9)", { timeout: DEMO_TIMEOUT_MS }, async () => {
    const { scenario3, transcript } = await demo();

    assert.equal(scenario3.itemCount, 2);
    assert.equal(scenario3.materializedCount, 2);
    assert.equal(
      scenario3.dispatchedCount,
      scenario3.itemCount,
      "once A is execution-finished with live authority, B must eventually be dispatched too",
    );

    // Immediately after approval only A is eligible; B's prerequisite has not
    // finished, so exactly one of the two items is dispatched at that point.
    assert.equal(
      findLine(transcript, (line) => line.startsWith("after approval:")),
      "after approval: 1 of 2 item(s) dispatched — B is waiting on A",
    );
    assert.ok(
      transcript.some((line) => line.includes("finished execution and its independent review authority now holds")),
      "the demo must show A finishing through the real Factory gates, not a flag being flipped",
    );

    // The plan stays EXECUTING: B's own scripted loop has not finished, so
    // completion is not derivable yet.
    assert.equal(scenario3.phase, "EXECUTING");
    assert.equal(
      findLine(transcript, (line) => line.startsWith("scenario 3 result:")),
      "scenario 3 result: phase=EXECUTING dispatched=2/2",
    );
  });

  it("scenario 4: 'APPROVED' in planner prose grants nothing — the plan fails closed with no revision at all (§16.4, AC-1)", { timeout: DEMO_TIMEOUT_MS }, async () => {
    const { scenario4, transcript } = await demo();

    assert.equal(scenario4.phase, "BLOCKED");
    assert.equal(scenario4.outcome, "BLOCKED");
    assert.equal(scenario4.revision, 0, "malformed planner output must never become an approvable revision");
    assert.equal(scenario4.itemCount, 0);
    assert.equal(scenario4.materializedCount, 0, "nothing may be created from unparseable planner prose");
    assert.equal(scenario4.dispatchedCount, 0, "nothing may be dispatched from unparseable planner prose");
    assert.equal(scenario4.approvedRevision, undefined);
    assert.equal(scenario4.humanActionRequired, true);
    assert.match(scenario4.failureReason ?? "", /planner run budget exhausted/, "retries must be bounded, then fail closed");
    assert.equal(scenario4.totalPlannerRuns, 2, "exactly the budgeted number of attempts, no more");

    // The transcript line that states the point in so many words.
    assert.equal(
      findLine(transcript, (line) => line.includes('the word "APPROVED" in prose granted nothing')),
      'the word "APPROVED" in prose granted nothing: phase=BLOCKED',
    );
  });

  it("scenario 5: a crash mid-materialization restarts and reconciles to exactly 2 items, no duplicates (§16.5, AC-7, AC-11)", { timeout: DEMO_TIMEOUT_MS }, async () => {
    const { scenario5, transcript } = await demo();

    assert.equal(scenario5.materializedCount, 2, "the restart must complete materialization — and produce exactly two items");
    assert.equal(scenario5.itemCount, 2);
    assert.equal(scenario5.dispatchedCount, 2);
    assert.equal(scenario5.phase, "EXECUTING");

    assert.ok(
      transcript.some((line) => line.includes("instance 1 crashed as scripted")),
      "the demo must genuinely crash instance 1, not merely describe a crash",
    );
    assert.equal(
      findLine(transcript, (line) => line.startsWith("mid-crash state:")),
      'mid-crash state: 1 item(s) materialized, dangling claim=WI-B',
    );

    const restartLine = findLine(transcript, (line) => line.startsWith("after restart:")) ?? "";
    assert.notEqual(restartLine, "", "the demo must report what the restarted instance found");
    assert.match(restartLine, /^after restart: 2 materialized, 2 work item\(s\) in the project, 2 distinct plan tag\(s\)/);
    assert.match(restartLine, /no duplicates$/, "the restarted instance must report that it created no duplicates");

    // One loop per work item and no more: proven by the scripted dispatcher's
    // own start counter, which mirrors TASK-004's database-level
    // one-active-loop-per-work-item constraint.
    assert.equal(
      findLine(transcript, (line) => line.startsWith("scenario 5 result:")),
      "scenario 5 result: phase=EXECUTING dispatched=2 loops started=2",
    );
  });

  it("prints a summary section listing all five scenarios", { timeout: DEMO_TIMEOUT_MS }, async () => {
    const { transcript } = await demo();

    const summaryIndex = transcript.indexOf("== summary ==");
    assert.notEqual(summaryIndex, -1, "the demo must print a summary section");

    const summary = transcript.slice(summaryIndex + 1);
    for (const label of [
      "scenario 1 (clear intent)",
      "scenario 2 (clarification cycle)",
      "scenario 3 (dependency ordering)",
      "scenario 4 (malformed, fail closed)",
      "scenario 5 (crash + reconcile)",
    ]) {
      assert.ok(
        summary.some((line) => line.startsWith(label)),
        `the summary must list ${label}`,
      );
    }
    assert.equal(summary.length, 5, "the summary lists exactly the five §16 scenarios");
  });
});

describe("demo:plan — AC-13 unattended execution", () => {
  /**
   * Structural, in the same style as tests/unattendedExecutionInvariant.test.ts
   * §A: a run that completed cannot by itself prove no prompt COULD have been
   * raised, but a source file with no interactive-I/O primitive in it cannot
   * raise one at all. `prompt(` is safe to forbid as a bare token here (unlike
   * in the broader scan, where this codebase's own buildWorkerPrompt naming
   * would false-positive) because demoPlan.ts builds no prompts itself.
   *
   * Read relative to the repository root, exactly as the accepted invariant
   * suite does — `npm test` runs from there.
   */
  const DEMO_SOURCE_PATH = "src/cli/demoPlan.ts";

  const FORBIDDEN_PATTERNS: readonly RegExp[] = [
    /\breadline\b/i,
    /\binquirer\b/i,
    /process\.stdin/,
    /\bprompt\(/,
    /\.question\(/,
    /setRawMode/,
  ];

  it("the demo source contains no interactive-I/O primitive, so the whole run needs no stdin", () => {
    const source = readFileSync(DEMO_SOURCE_PATH, "utf8");
    assert.ok(source.length > 0, `sanity: ${DEMO_SOURCE_PATH} must be readable for this scan to mean anything`);
    assert.ok(source.includes("runPlanDemo"), `sanity: ${DEMO_SOURCE_PATH} must be the demo module`);

    const offenders = FORBIDDEN_PATTERNS.filter((pattern) => pattern.test(source)).map((pattern) => String(pattern));
    assert.deepEqual(
      offenders,
      [],
      `an interactive-I/O primitive must never appear in the unattended demo path: ${offenders.join(", ")}`,
    );
  });
});

describe("demo:plan — determinism (§16)", () => {
  it("two runs produce byte-identical transcripts and identical scenario views", { timeout: DEMO_TIMEOUT_MS }, async () => {
    const { first, second } = await demoRuns();

    // Every id in the demo comes from a per-run `createSequentialIdGenerator`
    // and every timestamp from a per-run `createFixedClock`, and no emitted
    // line carries a temp workspace path or a wall-clock duration — so the two
    // transcripts must match exactly, line for line.
    assert.equal(second.transcript.length, first.transcript.length, "the two runs must emit the same number of lines");
    const firstDifference = first.transcript.findIndex((line, index) => line !== second.transcript[index]);
    assert.equal(
      firstDifference,
      -1,
      firstDifference === -1
        ? ""
        : `run 1 and run 2 diverge at line ${firstDifference}:\n  run 1: ${String(first.transcript[firstDifference])}\n  run 2: ${String(second.transcript[firstDifference])}`,
    );
    assert.deepEqual([...second.transcript], [...first.transcript]);

    // The structured results are the load-bearing half of determinism: even if
    // a future change made one printed line vary, the five scenario outcomes
    // must not.
    assert.deepEqual(second.scenario1, first.scenario1);
    assert.deepEqual(second.scenario2, first.scenario2);
    assert.deepEqual(second.scenario3, first.scenario3);
    assert.deepEqual(second.scenario4, first.scenario4);
    assert.deepEqual(second.scenario5, first.scenario5);
  });
});
