/**
 * Production wrapper regressions: shell inputs are data; failed spawn is not
 * success; and (SF-R3) only the reviewer's FINAL structured message can ever
 * become a verdict candidate, with a failed process reconciled from evidence it
 * published about itself.
 *
 * Every reviewer here is a fake executable. No provider is contacted, no model
 * is invoked, and no call can be billed.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createCodexReviewLauncher } from "../src/adapters/supervision/codexReviewLauncher.js";
import { MAX_FAILURE_EVIDENCE, reviewRunPaths } from "../src/adapters/supervision/reviewCompletion.js";
import {
  strictClaudeFinalMessage,
  strictCodexFinalMessage,
} from "../src/adapters/supervision/reviewFinalMessage.js";
import { classifyProviderReportedError } from "../src/supervision/resourceClassifier.js";
import type { ReviewLaunchRequest } from "../src/supervision/supervisorPorts.js";

function request(dir: string, provider = "codex-cli"): ReviewLaunchRequest {
  return { reviewId: "A:REVIEW:r1", activityId: "A:REVIEW:r1", roadmapKey: "A",
    provider, model: "gpt-5.6-luna", effort: "xhigh",
    candidate: { commit: "abc1234", tree: "def5678", fingerprint: "0123456789ab" },
    source: join(dir, "verdict.txt"), ack: join(dir, "ack.json") };
}

/** A complete, perfectly well-formed verdict block. The bait in every case below. */
function verdictBlock(verdict: string, safe = "YES", counts = "CRITICAL=0 HIGH=0"): string {
  return [
    `VERDICT: ${verdict}`,
    `Safe to commit: ${safe}`,
    `FACTORY_ACCEPTANCE_COUNTS: ${counts}`,
    "FACTORY_ACCEPTANCE_CANDIDATE: abc1234 def5678 0123456789ab",
  ].join("\n");
}

function codexEvent(text: string): string {
  return JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
}

/** A stub reviewer: writes exactly what it is told to, then exits how it is told to. */
function stubReviewer(options: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit?: number;
}): readonly string[] {
  const program =
    "const w=(s,t)=>{if(t.length>0)require('node:fs').writeSync(s,t)};" +
    "w(1,process.argv[1]);w(2,process.argv[2]);process.exit(Number(process.argv[3]));";
  return [process.execPath, "-e", program, options.stdout ?? "", options.stderr ?? "", String(options.exit ?? 0)];
}

/** Waits for the artefact the wrapper publishes LAST, so nothing is read mid-write. */
async function finished(plan: ReviewLaunchRequest): Promise<void> {
  const completion = reviewRunPaths(plan.source).completion;
  const deadline = Date.now() + 15_000;
  while (!existsSync(completion) && Date.now() < deadline) await sleep(20);
  assert.ok(existsSync(completion), "the reviewer wrapper never published a completion");
}

test("literal shell metacharacters in repository paths and command arguments never execute", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-launch-words-"));
  const dir = join(root, "review '$(touch injected-by-path) `touch injected-by-backtick`");
  mkdirSync(dir);
  const plan = request(dir);
  const payload = "value ' $(touch injected-by-arg) `touch injected-by-arg2` $HOME \" quote";
  const received = join(dir, "received.json");
  const launcher = createCodexReviewLauncher({
    repository: dir, packet: () => "no model is called",
    command: () => [process.execPath, "-e",
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv[2]))", received, payload],
  });
  try {
    const result = await launcher.launch(plan);
    assert.equal(result.ok, true, JSON.stringify(result));
    const deadline = Date.now() + 10000;
    while (!existsSync(`${plan.source}.run.rc`) && Date.now() < deadline) await sleep(20);
    assert.ok(existsSync(`${plan.source}.run.rc`), "wrapper did not finish");
    assert.equal(readFileSync(`${plan.source}.run.rc`, "utf8").trim(), "0");
    assert.equal(JSON.parse(readFileSync(received, "utf8")), payload);
    assert.equal(launcher.acknowledgement(plan)?.runId, plan.reviewId);
    for (const name of ["injected-by-path", "injected-by-backtick", "injected-by-arg", "injected-by-arg2"]) {
      assert.equal(existsSync(join(dir, name)), false, `${name} was executed`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an asynchronous spawn error is returned instead of crashing or claiming launch success", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-launch-error-"));
  try {
    const launcher = createCodexReviewLauncher({ repository: join(root, "absent"), packet: () => "", command: () => ["true"] });
    const result = await launcher.launch(request(root));
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.match(result.problem, /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe("SF-R3: only the reviewer's final structured message can be a verdict", () => {
  async function run(options: {
    readonly provider?: string;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exit?: number;
  }): Promise<{
    readonly dir: string;
    readonly plan: ReviewLaunchRequest;
    readonly launcher: ReturnType<typeof createCodexReviewLauncher>;
    readonly verdict: string | undefined;
  }> {
    const dir = mkdtempSync(join(tmpdir(), "sf-final-"));
    const plan = request(dir, options.provider);
    const launcher = createCodexReviewLauncher({
      repository: dir,
      packet: () => "no model is called",
      command: () => stubReviewer(options),
    });
    const started = await launcher.launch(plan);
    assert.equal(started.ok, true, JSON.stringify(started));
    await finished(plan);
    return {
      dir, plan, launcher,
      verdict: existsSync(plan.source) ? readFileSync(plan.source, "utf8") : undefined,
    };
  }

  it("takes the LAST Codex agent_message, never an earlier one and never stderr", async () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      // The prompt echo. A complete PASS block, exactly the bait `awk` accepted.
      codexEvent(`Reviewing. The template I was given was:\n${verdictBlock("PASS")}`),
      codexEvent("Some diagnostic in the middle of the run."),
      codexEvent(verdictBlock("CHANGES_REQUIRED", "NO", "CRITICAL=1 HIGH=0")),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    const { plan, launcher, verdict, dir } = await run({
      stdout,
      stderr: `warning: something\n${verdictBlock("PASS")}`,
    });
    try {
      assert.equal(verdict, verdictBlock("CHANGES_REQUIRED", "NO", "CRITICAL=1 HIGH=0"));
      assert.doesNotMatch(verdict ?? "", /VERDICT: PASS/, "an earlier message or stderr reached the verdict");
      const reading = launcher.completion(plan);
      assert.equal(reading.kind, "COMPLETED");
      if (reading.kind !== "COMPLETED") throw new Error("unreachable");
      assert.equal(reading.evidence.exitCode, 0);
      assert.equal(reading.evidence.verdictPublished, true);
      assert.equal(reading.evidence.runId, plan.reviewId);
      // Streams stay apart: stderr is its own file and is not the transcript.
      assert.match(readFileSync(reviewRunPaths(plan.source).stderr, "utf8"), /warning: something/);
      assert.doesNotMatch(readFileSync(reviewRunPaths(plan.source).stdout, "utf8"), /warning: something/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("takes a Claude result object's .result and nothing around it", async () => {
    const { verdict, dir, plan, launcher } = await run({
      provider: "claude-code",
      stdout: JSON.stringify({
        type: "result", subtype: "success", is_error: false,
        result: verdictBlock("PASS_WITH_NON_BLOCKING_NOTES"),
        duration_ms: 12, num_turns: 3,
      }),
    });
    try {
      assert.equal(verdict, verdictBlock("PASS_WITH_NON_BLOCKING_NOTES"));
      assert.equal(launcher.completion(plan).kind, "COMPLETED");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("publishes no verdict for plain text on a clean exit", async () => {
    const { verdict, dir, plan, launcher } = await run({ stdout: verdictBlock("PASS") });
    try {
      assert.equal(verdict, undefined, "plain text was accepted as a structured final message");
      const reading = launcher.completion(plan);
      if (reading.kind !== "COMPLETED") throw new Error(JSON.stringify(reading));
      assert.equal(reading.evidence.verdictPublished, false);
      assert.equal(reading.evidence.exitCode, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("publishes no verdict when the stream is truncated after an earlier PASS", async () => {
    const stdout = `${codexEvent(verdictBlock("PASS"))}\n{"type":"item.completed","item":{"type":"agent_mess`;
    const { verdict, dir } = await run({ stdout });
    try {
      assert.equal(verdict, undefined, "a truncated stream let an earlier PASS stand as the conclusion");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("publishes no verdict on a nonzero exit, however plausible the output", async () => {
    const { verdict, dir, plan, launcher } = await run({
      stdout: codexEvent(verdictBlock("PASS")),
      stderr: "provider refused: no capacity remaining for this plan",
      exit: 3,
    });
    try {
      assert.equal(verdict, undefined, "a crashed reviewer's PASS was published");
      const reading = launcher.completion(plan);
      if (reading.kind !== "COMPLETED") throw new Error(JSON.stringify(reading));
      assert.equal(reading.evidence.exitCode, 3);
      assert.equal(reading.evidence.verdictPublished, false);
      assert.match(reading.evidence.failure, /exit 3/);
      assert.match(reading.evidence.failure, /no capacity remaining/);
      assert.ok(reading.evidence.failure.length <= MAX_FAILURE_EVIDENCE + 1, "failure evidence is unbounded");
      assert.equal(reading.evidence.providerError, undefined);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a Claude is_error result even on exit 0 with a PASS inside it", async () => {
    const { verdict, dir, plan, launcher } = await run({
      provider: "claude-code",
      exit: 0,
      stdout: JSON.stringify({
        type: "result", subtype: "success", is_error: true,
        result: `I could not review this. ${verdictBlock("PASS")}`,
      }),
    });
    try {
      assert.equal(verdict, undefined, "a provider that reported is_error still produced an approval");
      const reading = launcher.completion(plan);
      if (reading.kind !== "COMPLETED") throw new Error(JSON.stringify(reading));
      assert.equal(reading.evidence.exitCode, 0);
      assert.equal(reading.evidence.verdictPublished, false);
      assert.match(reading.evidence.providerError ?? "", /could not review this/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("clears a previous attempt's artefacts before launching again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-final-stale-"));
    try {
      const plan = request(dir);
      const paths = reviewRunPaths(plan.source);
      // Everything a dead attempt at the SAME run id could have left behind.
      writeFileSync(plan.source, verdictBlock("PASS"));
      writeFileSync(plan.ack, JSON.stringify({ runId: plan.reviewId, pid: 1, processStartedAt: 1,
        machine: "old", boot: "old", at: 1 }));
      writeFileSync(paths.exitCode, "0\n");
      writeFileSync(paths.completion, JSON.stringify({ runId: plan.reviewId, exitCode: 0,
        failure: "", verdictPublished: true, at: 1 }));
      writeFileSync(paths.stdout, codexEvent(verdictBlock("PASS")));

      const launcher = createCodexReviewLauncher({
        repository: dir, packet: () => "",
        // Blocks until released, so the cleared state is observable mid-run.
        command: () => stubReviewer({
          stdout: `${codexEvent(verdictBlock("CHANGES_REQUIRED", "NO"))}\n${JSON.stringify({ type: "turn.completed" })}`,
        }),
      });
      const started = await launcher.launch(plan);
      assert.equal(started.ok, true, JSON.stringify(started));
      await finished(plan);
      assert.equal(readFileSync(plan.source, "utf8"), verdictBlock("CHANGES_REQUIRED", "NO"));
      const reading = launcher.completion(plan);
      if (reading.kind !== "COMPLETED") throw new Error(JSON.stringify(reading));
      assert.notEqual(reading.evidence.at, 1, "the previous attempt's completion was adopted as this one's");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports a foreign or torn completion as unusable, never as an outcome", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-final-foreign-"));
    try {
      const plan = request(dir);
      const launcher = createCodexReviewLauncher({ repository: dir, packet: () => "", command: () => ["true"] });
      const paths = reviewRunPaths(plan.source);
      assert.equal(launcher.completion(plan).kind, "NONE", "absence was not reported as absence");

      writeFileSync(paths.completion, '{"runId":"A:REVIEW:r1","exitCode":0,"verdictPub');
      let reading = launcher.completion(plan);
      assert.equal(reading.kind, "UNUSABLE");

      writeFileSync(paths.completion, JSON.stringify({ runId: "SOMETHING:REVIEW:r9", exitCode: 1,
        failure: "not ours", verdictPublished: false, at: 5 }));
      reading = launcher.completion(plan);
      assert.equal(reading.kind, "UNUSABLE");
      if (reading.kind !== "UNUSABLE") throw new Error("unreachable");
      assert.match(reading.reason, /SOMETHING:REVIEW:r9/);

      writeFileSync(paths.completion, JSON.stringify({ runId: plan.reviewId, exitCode: "1",
        failure: "mistyped", verdictPublished: false, at: 5 }));
      assert.equal(launcher.completion(plan).kind, "UNUSABLE");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("SF-R3: the strict parsers, and the one measured provider failure", () => {
  it("ignores an earlier Codex message and refuses a malformed stream", () => {
    const good = strictCodexFinalMessage(
      `${codexEvent("first")}\n${codexEvent("last")}\n${JSON.stringify({ type: "turn.completed" })}`,
    );
    assert.deepEqual(good, { kind: "FINAL", text: "last" });
    assert.equal(strictCodexFinalMessage("not json at all").kind, "NONE");
    assert.equal(strictCodexFinalMessage("").kind, "NONE");
    assert.equal(strictCodexFinalMessage(JSON.stringify({ type: "turn.completed" })).kind, "NONE");
  });

  /**
   * The two counterexamples root reproduced through the pure parser directly
   * (SF-R3-PARSER-REPRO.log), before this correction: an `agent_message` with
   * no terminal event at all, and one followed by an explicit `turn.failed`,
   * both wrongly read as `{ kind: "FINAL", text: "VERDICT: PASS" }`.
   */
  it("never treats an agent_message as FINAL without a completed turn after it", () => {
    const missingTerminalEvent = strictCodexFinalMessage(`${codexEvent("VERDICT: PASS")}\n`);
    assert.equal(missingTerminalEvent.kind, "NONE");
    assert.notEqual((missingTerminalEvent as { text?: string }).text, "VERDICT: PASS");

    const explicitFailedTurn = strictCodexFinalMessage(
      `${codexEvent("VERDICT: PASS")}\n${JSON.stringify({ type: "turn.failed", error: { message: "stub failure" } })}\n`,
    );
    assert.equal(explicitFailedTurn.kind, "NONE");
    assert.notEqual((explicitFailedTurn as { text?: string }).text, "VERDICT: PASS");

    // A turn.completed that arrives AFTER a turn.failed for the same message
    // does not undo the failure: the failure is sticky, and the stream is
    // self-contradictory either way.
    const contradictory = strictCodexFinalMessage(
      `${codexEvent("VERDICT: PASS")}\n${JSON.stringify({ type: "turn.failed" })}\n${JSON.stringify({ type: "turn.completed" })}\n`,
    );
    assert.equal(contradictory.kind, "NONE");

    // An `error` event after the final message is refused the same way.
    const errorEvent = strictCodexFinalMessage(
      `${codexEvent("VERDICT: PASS")}\n${JSON.stringify({ type: "error", status: 400, error: { message: "bad request" } })}\n`,
    );
    assert.equal(errorEvent.kind, "NONE");
  });

  it("refuses Claude output that is not a single result object", () => {
    assert.equal(strictClaudeFinalMessage("VERDICT: PASS").kind, "NONE");
    // The informational adapter parser accepts this JSONL form on purpose. A
    // verdict may not be chosen that way.
    assert.equal(
      strictClaudeFinalMessage('{"type":"result","is_error":false,"result":"one"}\n{"type":"result","is_error":false,"result":"two"}').kind,
      "NONE",
    );
    assert.equal(strictClaudeFinalMessage('{"type":"stream","result":"x"}').kind, "NONE");
    assert.equal(strictClaudeFinalMessage('{"type":"result","result":"x"}').kind, "NONE");
  });

  /**
   * The ONE measured provider failure in this checkout, kept as a fixture. The
   * quota case deliberately has no signature: no real exhausted-plan response
   * has ever been captured here.
   */
  it("classifies the measured OAuth-expired response, and nothing it has not seen", () => {
    /**
     * Resolved relative to the repo root, matching `fakeCliPath` — this
     * fixture, like the fake CLIs, is not compiled by tsc, so it does not
     * exist relative to this test's OWN compiled location under `dist/`.
     */
    const fixture = readFileSync(
      resolve(process.cwd(), "tests/fixtures/claude-code-auth-expired-result.json"),
      "utf8",
    );
    const reading = strictClaudeFinalMessage(fixture);
    assert.equal(reading.kind, "PROVIDER_ERROR");
    if (reading.kind !== "PROVIDER_ERROR") throw new Error("unreachable");
    const measured = classifyProviderReportedError("claude-code", reading.message);
    assert.equal(measured.state, "AUTH_REQUIRED");
    assert.equal(measured.signatureId, "claude-code-oauth-expired");

    // Plausible quota text is NOT promoted: it was never observed.
    const quota = classifyProviderReportedError("claude-code", "You have exceeded your usage limit for this plan");
    assert.equal(quota.state, "UNKNOWN_FAILURE");
    assert.match(quota.reason, /UNVERIFIED/);
    // Nor is the measured auth text believed about a provider it was not measured on.
    assert.equal(classifyProviderReportedError("codex-cli", reading.message).state, "UNKNOWN_FAILURE");
  });
});

test("a stale artifact that cannot be removed refuses before launching a worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-launch-stale-"));
  try {
    const plan = request(root);
    mkdirSync(plan.source);
    const launcher = createCodexReviewLauncher({ repository: root, packet: () => "", command: () => ["true"] });
    const result = await launcher.launch(plan);
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.match(result.problem, /could not clear stale review artifact/);
    assert.equal(existsSync(`${plan.source}.sh`), false);
    assert.equal(existsSync(plan.ack), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
