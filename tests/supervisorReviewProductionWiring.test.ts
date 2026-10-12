import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

test("production composition launches a bounded review through stub executables", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-review-production-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const previousPath = process.env.PATH;
  const previousReviewDir = process.env.SF_REVIEW_DIR;
  const previousCwd = process.cwd();
  const blockedEnvNames = [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL", "BASH_ENV", "NODE_OPTIONS", "FAKE_PLUGIN_TOKEN",
  ] as const;
  const previousBlocked = Object.fromEntries(blockedEnvNames.map((name) => [name, process.env[name]]));
  const bashMarker = join(root, "bash-env-ran");
  const bashHook = join(root, "bash-env.sh");
  writeFileSync(bashHook, "printf sourced > " + JSON.stringify(bashMarker) + "\n");
  for (const name of blockedEnvNames) process.env[name] = "FAKE_SENTINEL_" + name;
  process.env.BASH_ENV = bashHook;
  process.env.NODE_OPTIONS = "--no-warnings";
  process.env.PATH = bin + ":/usr/bin:/bin";
  process.env.SF_REVIEW_DIR = join(root, "reviews");
  process.chdir(root);
  const calls = join(root, "calls.jsonl");
  writeFileSync(join(bin, "codex"), "#!" + process.execPath + "\n" +
    "const fs=require('node:fs');const a=process.argv.slice(2);" +
    "const e={PATH:!!process.env.PATH,HOME:!!process.env.HOME,blocked:Object.keys(process.env).filter(n=>" +
      JSON.stringify(blockedEnvNames) + ".includes(n))};" +
    "fs.appendFileSync(" + JSON.stringify(calls) + ",JSON.stringify({args:a,env:e})+'\\n');" +
    "if(a[0]==='doctor'){console.log(JSON.stringify({checks:{'auth.credentials':{status:'ok',details:{'stored auth mode':'chatgpt','stored API key':'false'}}}}));}" +
    "else if(a[0]==='exec'){const text='VERDICT: CHANGES_REQUIRED\\nSafe to commit: NO\\nFACTORY_ACCEPTANCE_COUNTS: CRITICAL=0 HIGH=1\\nFACTORY_ACCEPTANCE_CANDIDATE: abc1234 def5678 0123456789ab';" +
    "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));" +
    "console.log(JSON.stringify({type:'turn.completed'}));}" +
    "else process.exit(96);", { mode: 0o700 });
  writeFileSync(join(bin, "claude"), "#!" + process.execPath + "\n" +
    "const fs=require('node:fs');const a=process.argv.slice(2);if(a.join(' ')!=='auth status')process.exit(96);" +
    "const e={PATH:!!process.env.PATH,HOME:!!process.env.HOME,blocked:Object.keys(process.env).filter(n=>" +
      JSON.stringify(blockedEnvNames) + ".includes(n))};" +
    "fs.appendFileSync(" + JSON.stringify(calls) + ",JSON.stringify({args:a,env:e})+'\\n');" +
    "console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}));",
    { mode: 0o700 });

  try {
    // Dynamic imports ensure the review directory is bound after this test's
    // environment is set. No installed provider binary is invoked.
    const { createSqliteSupervisorRepository } = await import("../src/adapters/supervision/sqliteSupervisorRepository.js");
    const { buildSupervisorService } = await import("../src/cli/supervise.js");
    const { DEFAULT_ROADMAP } = await import("../src/supervision/supervisorTypes.js");
    const repository = createSqliteSupervisorRepository(join(root, "supervisor.db"));
    try {
      await repository.create({
        version: 1, financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
        resources: [], roadmap: DEFAULT_ROADMAP, checkpoints: [], escalations: [],
        provenance: [], updatedAt: Date.now(),
        reviewRequests: [{
          roadmapKey: "LOCAL_24_7_RUNTIME", attempt: 1, requestedAt: Date.now(),
          provider: "codex-cli", model: "gpt-5.6-luna", effort: "xhigh",
          candidate: { commit: "abc1234", tree: "def5678", fingerprint: "0123456789ab" },
        }],
      });
      const service = buildSupervisorService(repository, () => {}, {
        execute: async () => ({ kind: "HUMAN_REQUIRED", action: { kind: "AUTHOR_PLAN", description: "stub" }, detail: "stub only" }),
      });
      await service.tick();
      const state = await repository.load();
      const review = state?.activities?.find((activity) => activity.review !== undefined)?.review;
      assert.ok(review, "production service did not record a review");
      const deadline = Date.now() + 10_000;
      while (!existsSync(review.source + ".run.done") && Date.now() < deadline) await sleep(20);
      assert.ok(existsSync(review.source + ".run.done"), "stub review publisher did not finish");
      assert.ok(existsSync(review.source + ".run.rc"), "stub reviewer did not record its exit code");
      assert.equal(readFileSync(review.source + ".run.rc", "utf8").trim(), "0");
      const invocations = readFileSync(calls, "utf8").trim().split("\n").map((line) =>
        JSON.parse(line) as { args: string[]; env: { PATH: boolean; HOME: boolean; blocked: string[] } });
      assert.ok(invocations.some((call) => call.args[0] === "doctor"));
      assert.ok(invocations.some((call) => call.args.join(" ") === "auth status"));
      const reviewCall = invocations.find((call) => call.args[0] === "exec");
      assert.ok(reviewCall);
      assert.ok(reviewCall.args.includes("gpt-5.6-luna"));
      assert.ok(reviewCall.args.includes('model_reasoning_effort="xhigh"'));
      assert.ok(reviewCall.args.includes("read-only"));
      for (const call of invocations) {
        assert.equal(call.env.HOME, true, "CLI lost HOME");
        assert.equal(call.env.PATH, true, "CLI lost PATH");
        assert.deepEqual(call.env.blocked, [], "probe or reviewer received a blocked environment variable");
      }
      assert.equal(existsSync(bashMarker), false, "BASH_ENV hook ran inside the review wrapper");
      assert.ok(readFileSync(review.source, "utf8").includes("VERDICT: CHANGES_REQUIRED"));
    } finally { repository.close(); }
  } finally {
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousReviewDir === undefined) delete process.env.SF_REVIEW_DIR; else process.env.SF_REVIEW_DIR = previousReviewDir;
    for (const name of blockedEnvNames) {
      const previous = previousBlocked[name];
      if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
