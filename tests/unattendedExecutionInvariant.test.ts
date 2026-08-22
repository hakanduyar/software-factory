/**
 * TASK-004 — Unattended Execution Invariant (added pre-final-review, agreed
 * with the human owner; see docs/tasks/TASK-004-autonomous-engineering-loop.md
 * §12a and acceptance criterion 21).
 *
 * INVARIANT: once an already-approved (`READY`) WorkItem enters the
 * autonomous loop, routine implementation, deterministic verification,
 * independent review, and remediation proceed WITHOUT interactive human
 * approval — no "may I run this?" prompts for tests/typecheck/build/git
 * status/child processes/Claude/Codex/verification/remediation/re-review.
 * The loop may stop for a human only at an explicit governance/recovery gate
 * (`RECOVERY_REQUIRED`, explicit `cancel()`, or a future release/publish/
 * plan-approval gate — none of which are "routine" execution steps).
 *
 * This suite proves the invariant four ways:
 *   A. structurally — no interactive-I/O primitive exists anywhere in the
 *      autonomous-execution source tree;
 *   B. structurally — the real Claude/Codex adapters never select an
 *      interactive permission mode or emit an approval flag, for any role;
 *   C. dynamically — all three required full-loop scenarios (clean PASS;
 *      CHANGES_REQUIRED → remediate → PASS; verification failure →
 *      remediate → PASS) complete with zero stdin listener registrations;
 *   D. dynamically — a worker whose underlying process would otherwise hang
 *      forever (simulating an unanswerable interactive prompt) fails closed
 *      via the existing bounded timeout/SIGKILL mechanism and the loop
 *      proceeds through its ordinary budget/exhaustion policy, never asking
 *      the human and never hanging;
 *   E. the explicit governance/recovery gates this invariant does NOT
 *      remove — `cancel()` and `RECOVERY_REQUIRED` — remain reachable and
 *      still require an explicit human/operator action.
 *
 * No real Claude/Codex model is invoked anywhere in this file.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createInMemoryLoopRepository } from "../src/adapters/orchestration/inMemoryLoopRepository.js";
import { createNodeProcessRunner } from "../src/adapters/process/nodeProcessRunner.js";
import { buildClaudeInvocation, permissionModeForRole } from "../src/adapters/workers/claudeCodeAdapter.js";
import { buildCodexInvocation, sandboxForRole } from "../src/adapters/workers/codexCliAdapter.js";
import { createClaudeCodeWorker } from "../src/adapters/workers/claudeCodeAdapter.js";
import { resolveWorkspace } from "../src/adapters/workers/workspace.js";
import { FACTORY_ROLES } from "../src/domain/role.js";
import { human } from "../src/domain/actor.js";
import { createSequentialIdGenerator } from "../src/domain/ids.js";
import { EngineeringLoopService, type LoopWorkerFactory, type StartLoopInput } from "../src/orchestration/engineeringLoopService.js";
import type { LoopRepository } from "../src/orchestration/loopRepository.js";
import type { VerificationCommandConfig } from "../src/orchestration/loopTypes.js";
import {
  asLoopWorkerFactory,
  createScriptedImplementerWorker,
  createScriptedReviewerWorker,
} from "../src/orchestration/scriptedLoopWorkers.js";
import { authorize, newFactory, seedWorkItem, toReady, type TestFactory } from "./support/factoryFixtures.js";
import { fakeCliPath } from "./support/fakeCli.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./support/tempWorkspace.js";

after(cleanupTempWorkspaces);

const processRunner = createNodeProcessRunner({ killGraceMs: 100 });

const PASSING_COMMANDS: readonly VerificationCommandConfig[] = [
  { id: "trivial-pass", executable: process.execPath, argv: ["-e", "process.exit(0)"] },
];
function baseInput(workItemId: string, overrides: Partial<StartLoopInput> = {}): StartLoopInput {
  return {
    workItemId,
    actor: human("user:test", "Test Operator"),
    taskInstructions: "Implement the widget.",
    implementer: { tool: "claude-code", model: "test-model" },
    reviewer: { tool: "codex-cli", model: "test-model" },
    verificationCommands: PASSING_COMMANDS,
    workspace: resolveWorkspace(createTempWorkspace()),
    ...overrides,
  };
}

function makeService(
  fx: TestFactory,
  loops: LoopRepository,
  overrides: { implementerFactory?: LoopWorkerFactory; reviewerFactory?: LoopWorkerFactory } = {},
): EngineeringLoopService {
  return new EngineeringLoopService({
    factory: fx.factory,
    loops,
    clock: fx.clock,
    ids: createSequentialIdGenerator(),
    processRunner,
    createImplementerWorker: overrides.implementerFactory ?? asLoopWorkerFactory(createScriptedImplementerWorker()),
    createReviewerWorker: overrides.reviewerFactory ?? asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
  });
}

describe("A. structural — no interactive-I/O primitive exists in the autonomous-execution source tree", () => {
  const SCAN_ROOTS = ["src/orchestration", "src/cli", "src/adapters/workers", "src/adapters/process", "src/adapters/orchestration"];
  // Anything that could pause a process waiting for a human at a keyboard.
  // "prompt(" deliberately excluded as a bare token — this codebase's own
  // buildWorkerPrompt/promptTemplates.ts naming would false-positive; the
  // more specific patterns below (readline, inquirer, .question(, raw stdin
  // reads, TTY prompts) are what actually matter and do not collide with it.
  const FORBIDDEN_PATTERNS: readonly RegExp[] = [
    /\breadline\b/i,
    /\binquirer\b/i,
    /\bprompts\b/i,
    /process\.stdin/,
    /\.question\(/,
    /setRawMode/,
    /confirm\(\s*["'`]/i,
  ];

  function listFiles(dir: string): string[] {
    const entries = readdirSync(dir);
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        files.push(...listFiles(full));
      } else if (entry.endsWith(".ts")) {
        files.push(full);
      }
    }
    return files;
  }

  for (const root of SCAN_ROOTS) {
    it(`contains no interactive-I/O primitive under ${root}`, () => {
      const files = listFiles(root);
      assert.ok(files.length > 0, `sanity: ${root} must contain at least one .ts file for this scan to mean anything`);
      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(text)) {
            offenders.push(`${file} matches ${pattern}`);
          }
        }
      }
      assert.deepEqual(offenders, [], `interactive-I/O primitives must never appear in the autonomous execution path:\n${offenders.join("\n")}`);
    });
  }
});

describe("B. structural — real Claude/Codex adapters never select an interactive mode", () => {
  it("Claude: permissionModeForRole returns only acceptEdits|plan for every FactoryRole, never an interactive/ask mode", () => {
    for (const role of FACTORY_ROLES) {
      const mode = permissionModeForRole(role);
      assert.ok(mode === "acceptEdits" || mode === "plan", `role ${role} resolved to non-safe permission mode ${mode}`);
    }
  });

  it("Claude: buildClaudeInvocation never emits an interactive/ask permission mode in argv, for any role", () => {
    for (const role of FACTORY_ROLES) {
      const plan = buildClaudeInvocation({
        request: { runId: "r", workItemId: "w", role, title: "t", instructions: "i", acceptanceCriteria: [] },
        prompt: "do it",
        workspace: { root: "/tmp/x", repositoryRoot: "/tmp/x" },
        model: "m",
        effort: undefined,
      });
      const modeIndex = plan.argv.indexOf("--permission-mode");
      assert.notEqual(modeIndex, -1, `role ${role} must always pass --permission-mode explicitly`);
      const mode = plan.argv[modeIndex + 1];
      assert.ok(mode === "acceptEdits" || mode === "plan", `role ${role} argv used interactive mode ${mode}`);
      assert.ok(!plan.argv.includes("auto") && !plan.argv.includes("manual") && !plan.argv.includes("dontAsk"), "no interactive permission-mode token present anywhere in argv");
    }
  });

  it("Codex: sandboxForRole returns only read-only|workspace-write for every FactoryRole", () => {
    for (const role of FACTORY_ROLES) {
      const sandbox = sandboxForRole(role);
      assert.ok(sandbox === "read-only" || sandbox === "workspace-write", `role ${role} resolved to unexpected sandbox ${sandbox}`);
    }
  });

  it("Codex: buildCodexInvocation never emits an approval-prompt flag, for any role (exec has none — confirmed against the real CLI in TASK-003)", () => {
    for (const role of FACTORY_ROLES) {
      const plan = buildCodexInvocation({
        request: { runId: "r", workItemId: "w", role, title: "t", instructions: "i", acceptanceCriteria: [] },
        prompt: "do it",
        workspace: { root: "/tmp/x", repositoryRoot: "/tmp/x" },
        model: "m",
        effort: undefined,
      });
      assert.ok(
        plan.argv.every((token) => !/ask-for-approval|interactive/i.test(token)),
        `role ${role} argv must never contain an approval-prompt flag: ${JSON.stringify(plan.argv)}`,
      );
      assert.ok(plan.argv.includes("exec"), "must use the non-interactive exec subcommand");
    }
  });
});

/** Counts, but never throws on, stdin listener registration — see the module doc for why a counting spy (not a throwing shim) is used. */
function withStdinGuard<T>(run: () => Promise<T>): Promise<{ result: T; stdinTouches: number }> {
  const stdin = process.stdin;
  let touches = 0;
  const originalOn = stdin.on.bind(stdin);
  const originalOnce = stdin.once.bind(stdin);
  const originalResume = stdin.resume.bind(stdin);
  stdin.on = ((...args: Parameters<typeof originalOn>) => {
    touches += 1;
    return originalOn(...args);
  }) as typeof stdin.on;
  stdin.once = ((...args: Parameters<typeof originalOnce>) => {
    touches += 1;
    return originalOnce(...args);
  }) as typeof stdin.once;
  stdin.resume = ((...args: Parameters<typeof originalResume>) => {
    touches += 1;
    return originalResume(...args);
  }) as typeof stdin.resume;

  return run()
    .then((result) => ({ result, stdinTouches: touches }))
    .finally(() => {
      stdin.on = originalOn;
      stdin.once = originalOnce;
      stdin.resume = originalResume;
    });
}

describe("C. dynamic — all three required full-loop scenarios complete with zero stdin listener registrations", () => {
  it("1: implement -> verify -> review PASS -> WAITING_FOR_HUMAN, zero stdin touches", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);
    const service = makeService(fx, createInMemoryLoopRepository());

    const { result: loop, stdinTouches } = await withStdinGuard(() => service.start(baseInput(item.id)));

    assert.equal(loop.phase, "WAITING_FOR_HUMAN");
    assert.equal(stdinTouches, 0, "a normal PASS run must never register a stdin listener");
  });

  it("2: implement -> verify -> review CHANGES_REQUIRED -> remediation -> verify -> review PASS, zero stdin touches", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);
    const service = makeService(fx, createInMemoryLoopRepository(), {
      reviewerFactory: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["CHANGES_REQUIRED", "PASS"] })),
    });

    const { result: loop, stdinTouches } = await withStdinGuard(() => service.start(baseInput(item.id, { budget: { maxIterations: 3 } })));

    assert.equal(loop.phase, "WAITING_FOR_HUMAN");
    assert.equal(loop.iterations.length, 2, "sanity: remediation genuinely happened");
    assert.equal(stdinTouches, 0, "remediation must never register a stdin listener");
  });

  it("3: verification failure -> remediation -> verify (pass) -> review PASS, zero stdin touches", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);
    const service = makeService(fx, createInMemoryLoopRepository());

    // The loop's verificationCommands are fixed at start() time and
    // remediation re-runs the SAME configured commands — so a genuine
    // deterministic-verification-triggered remediation (distinct from
    // scenario 2's reviewer-triggered one) needs a command whose own result
    // differs between attempts. A marker file dropped in the workspace on
    // the first run makes the same fixed command fail once, then pass.
    const workspace = resolveWorkspace(createTempWorkspace());
    const markerCommand: VerificationCommandConfig = {
      id: "fails-once",
      executable: process.execPath,
      argv: [
        "-e",
        "const fs=require('fs');const p='.attempted';if(fs.existsSync(p)){process.exit(0);}else{fs.writeFileSync(p,'1');process.exit(1);}",
      ],
    };

    const { result: loop, stdinTouches } = await withStdinGuard(() =>
      service.start(
        baseInput(item.id, {
          workspace,
          verificationCommands: [markerCommand],
          budget: { maxIterations: 3 },
        }),
      ),
    );

    assert.equal(loop.phase, "WAITING_FOR_HUMAN");
    assert.equal(loop.iterations.length, 2, "sanity: verification-triggered remediation genuinely happened");
    assert.equal(loop.iterations[0]?.verificationPassed, false);
    assert.equal(loop.iterations[1]?.verificationPassed, true);
    assert.equal(stdinTouches, 0, "verification-triggered remediation must never register a stdin listener");
  });
});

describe("D. dynamic — an unanswerable-interactive-prompt hang fails closed, never hangs, never asks the human", () => {
  it("a worker whose underlying process never exits (simulating a stuck approval prompt) times out, is recorded FAILED, and the loop proceeds to EXHAUSTED — bounded, not indefinite", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);

    // The real Claude adapter, pointed at a fixture that ignores SIGTERM and
    // never exits on its own (tests/fixtures/fake-clis/never-exits.mjs) —
    // exactly what an unexpectedly-hung interactive approval prompt would
    // look like from the orchestrator's side: a child process that stops
    // producing output and never terminates. A short worker timeoutMs plus
    // the process runner's short killGraceMs (100ms, configured above) bound
    // the whole thing well under the test's own timeout.
    const hangingImplementer: LoopWorkerFactory = (config, options) =>
      createClaudeCodeWorker({
        executable: fakeCliPath("never-exits.mjs"),
        model: config.model,
        timeoutMs: 150,
        workspace: options.workspace,
        processRunner: options.processRunner,
        roles: options.roles,
      });

    const service = makeService(fx, createInMemoryLoopRepository(), { implementerFactory: hangingImplementer });

    const startedAt = Date.now();
    const loop = await service.start(baseInput(item.id, { budget: { maxIterations: 1 } }));
    const elapsedMs = Date.now() - startedAt;

    assert.equal(loop.phase, "EXHAUSTED", "a hung worker must fail closed into the normal budget/exhaustion policy, never PASS, never a hang");
    assert.equal(loop.iterations[0]?.implementerOutcome, "FAILED");
    assert.ok(elapsedMs < 5000, `must resolve within a bounded time (timeout+killGrace), took ${elapsedMs}ms — a true hang would exceed this easily`);

    const finalItem = await fx.factory.getWorkItem(item.id);
    assert.equal(finalItem.status, "BLOCKED", "the WorkItem is left for a human to look at — not silently retried forever, not silently passed");
  });
});

describe("E. explicit governance/recovery gates remain — the invariant narrows only ROUTINE steps", () => {
  it("cancel() remains the only way to stop a healthy loop before a terminal phase, and still requires an explicit actor", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);
    const loops = createInMemoryLoopRepository();

    let releaseImplementer!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseImplementer = resolve;
    });
    const gatedImplementer = {
      id: "gated",
      capabilities: { roles: ["IMPLEMENTER"] as const, deterministic: true },
      async execute(request: { runId: string }) {
        await gate;
        return {
          status: "SUCCEEDED" as const,
          summary: "done",
          evidence: [{ kind: "NOTE" as const, summary: "done", reference: `scripted://implementer/${request.runId}/transcript` }],
          claimsAcceptanceMet: true,
        };
      },
    };
    const service = makeService(fx, loops, { implementerFactory: () => gatedImplementer });
    const startPromise = service.start(baseInput(item.id));

    await new Promise<void>((resolve) => {
      const check = (): void => {
        const loopId = 0; // presence check below drives the wait
        void loopId;
        loops.listByWorkItem(item.id).then((found) => (found.length > 0 ? resolve() : setTimeout(check, 5)));
      };
      check();
    });
    const loopId = (await loops.listByWorkItem(item.id))[0]!.id;

    const operator = human("user:operator", "Operator");
    const cancelled = await service.cancel(loopId, operator, authorize(fx.factory, operator));
    releaseImplementer();
    const settled = await startPromise;

    assert.equal(cancelled.phase, "CANCELLED");
    assert.equal(settled.phase, "CANCELLED", "cancellation — an explicit human action — is honored, unlike routine steps which proceed unattended");
  });

  it("RECOVERY_REQUIRED remains terminal and distinct from routine progression — a durably RUNNING run is never silently resolved", async () => {
    const fx = newFactory();
    const item = await seedWorkItem(fx.factory);
    await toReady(fx.factory, item.id);
    const loops = createInMemoryLoopRepository();

    const neverResolves = {
      id: "never-resolves",
      capabilities: { roles: ["IMPLEMENTER"] as const, deterministic: true },
      execute(): Promise<never> {
        return new Promise<never>(() => {});
      },
    };
    const hungService = makeService(fx, loops, { implementerFactory: () => neverResolves });
    const abandoned = hungService.start(baseInput(item.id));
    abandoned.catch(() => {});

    for (let i = 0; i < 200; i++) {
      const runs = await fx.factory.listRuns(item.id);
      if (runs.length === 1 && runs[0]!.status === "RUNNING") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const loopId = (await loops.listByWorkItem(item.id))[0]!.id;
    const resumed = await makeService(fx, loops).resume(loopId);

    assert.equal(resumed.phase, "RECOVERY_REQUIRED", "an unprovable in-flight outcome remains a human-actionable gate, never silently resolved as routine progress");
  });
});
