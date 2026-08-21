/**
 * `npm run demo:loop` — deterministic, fully offline demonstration of the
 * TASK-004 autonomous engineering loop (docs/tasks/TASK-004-autonomous-engineering-loop.md §13).
 *
 * No real AI CLI is ever invoked: IMPLEMENTER/REVIEWER are scripted
 * `Worker`s (src/orchestration/scriptedLoopWorkers.ts). Deterministic
 * verification genuinely spawns real, trivial, offline `node -e` processes
 * through the real `ProcessRunner`/`createVerificationWorker` — not an AI
 * provider, just a deterministic local command, exactly like the fake-CLI
 * fixtures TASK-003's own tests spawn.
 *
 * Three scenarios (§13): PASS straight through, CHANGES_REQUIRED then a
 * remediation that passes, and repeated CHANGES_REQUIRED past budget
 * (EXHAUSTED).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInMemoryLoopRepository } from "../adapters/orchestration/inMemoryLoopRepository.js";
import { createNodeProcessRunner } from "../adapters/process/nodeProcessRunner.js";
import { createInMemoryStore } from "../adapters/memory/inMemoryStore.js";
import { createLocalHumanIdentityGate } from "../adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../adapters/security/localWorkerRegistry.js";
import { resolveWorkspace } from "../adapters/workers/workspace.js";
import { FactoryService } from "../app/factoryService.js";
import { agent, human } from "../domain/actor.js";
import { createSequentialIdGenerator } from "../domain/ids.js";
import { EngineeringLoopService } from "../orchestration/engineeringLoopService.js";
import { toStatusView, type LoopStatusView, type VerificationCommandConfig } from "../orchestration/loopTypes.js";
import {
  asLoopWorkerFactory,
  createScriptedImplementerWorker,
  createScriptedReviewerWorker,
} from "../orchestration/scriptedLoopWorkers.js";
import { createFixedClock } from "../ports/clock.js";

const DEMO_CREDENTIAL = "demo-loop-local-operator-secret";

const PASSING_COMMANDS: readonly VerificationCommandConfig[] = [
  { id: "trivial-check", executable: process.execPath, argv: ["-e", "process.exit(0)"] },
];

export interface LoopDemoOptions {
  readonly log?: (line: string) => void;
}

export interface LoopDemoResult {
  readonly scenario1: LoopStatusView;
  readonly scenario2: LoopStatusView;
  readonly scenario3: LoopStatusView;
  readonly transcript: readonly string[];
}

function makeScratchWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-demo-loop-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  return dir;
}

async function readyWorkItem(factory: FactoryService, title: string) {
  const project = await factory.createProject({ key: "LOOPDEMO", name: "Loop Demo" });
  const item = await factory.createWorkItem({
    projectId: project.id,
    title,
    type: "FEATURE",
    planVersion: "loop-demo-v1",
    acceptanceCriteria: [{ text: "Demo criterion", verificationHint: "trivial-check" }],
  });

  const orchestrator = agent("agent:demo-orchestrator", "Demo Orchestrator");
  const operator = human("user:demo-operator", "Demo Operator");
  await factory.advance(item.id, "ANALYSIS", orchestrator);
  await factory.advance(item.id, "PLAN_REVIEW", orchestrator);
  await factory.recordApproval({
    gate: "PLAN_APPROVAL",
    subject: factory.workItemSubject(item.id),
    decision: "APPROVED",
    actor: operator,
    authorization: factory.authorizeHuman(operator, DEMO_CREDENTIAL),
  });
  await factory.advance(item.id, "READY", orchestrator);
  return item;
}

function makeFactory() {
  const clock = createFixedClock("2026-01-01T00:00:00.000Z");
  const store = createInMemoryStore();
  const factory = new FactoryService({
    store,
    clock,
    ids: createSequentialIdGenerator(),
    identityGate: createLocalHumanIdentityGate({ credential: DEMO_CREDENTIAL, clock }),
    workerRegistry: createLocalWorkerRegistry(clock),
  });
  return { clock, factory };
}

export async function runLoopDemo(options: LoopDemoOptions = {}): Promise<LoopDemoResult> {
  const transcript: string[] = [];
  const emit = (line: string): void => {
    transcript.push(line);
    options.log?.(line);
  };

  const processRunner = createNodeProcessRunner();
  const scratchDirs: string[] = [];

  try {
    emit("== Software Factory autonomous loop demo (TASK-004) ==");
    emit("No network, no AI provider. Scripted workers, real deterministic verification commands.");

    // Scenario 1: implement -> verify (pass) -> review PASS -> WAITING_FOR_HUMAN
    emit("");
    emit("-- scenario 1: clean PASS --");
    const workspace1 = makeScratchWorkspace();
    scratchDirs.push(workspace1);
    const { clock: clock1, factory: factory1 } = makeFactory();
    const item1 = await readyWorkItem(factory1, "Loop demo scenario 1: clean pass");
    const service1 = new EngineeringLoopService({
      factory: factory1,
      loops: createInMemoryLoopRepository(),
      clock: clock1,
      ids: createSequentialIdGenerator(),
      processRunner,
      log: emit,
      createImplementerWorker: asLoopWorkerFactory(createScriptedImplementerWorker()),
      createReviewerWorker: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["PASS"] })),
    });
    const loop1 = await service1.start({
      workItemId: item1.id,
      actor: human("user:demo-operator", "Demo Operator"),
      taskInstructions: "Implement the demo feature.",
      implementer: { tool: "claude-code", model: "demo-model" },
      reviewer: { tool: "codex-cli", model: "demo-model" },
      verificationCommands: PASSING_COMMANDS,
      workspace: resolveWorkspace(workspace1),
      budget: { maxIterations: 3 },
    });
    const scenario1 = toStatusView(loop1);
    emit(`scenario 1 result: phase=${scenario1.phase} outcome=${scenario1.outcome ?? "-"}`);

    // Scenario 2: CHANGES_REQUIRED -> remediation -> PASS -> WAITING_FOR_HUMAN
    emit("");
    emit("-- scenario 2: CHANGES_REQUIRED then a passing remediation --");
    const workspace2 = makeScratchWorkspace();
    scratchDirs.push(workspace2);
    const { clock: clock2, factory: factory2 } = makeFactory();
    const item2 = await readyWorkItem(factory2, "Loop demo scenario 2: remediation");
    const service2 = new EngineeringLoopService({
      factory: factory2,
      loops: createInMemoryLoopRepository(),
      clock: clock2,
      ids: createSequentialIdGenerator(),
      processRunner,
      log: emit,
      createImplementerWorker: asLoopWorkerFactory(createScriptedImplementerWorker()),
      createReviewerWorker: asLoopWorkerFactory(
        createScriptedReviewerWorker({ verdicts: ["CHANGES_REQUIRED", "PASS"], findings: ["Tighten error handling"] }),
      ),
    });
    const loop2 = await service2.start({
      workItemId: item2.id,
      actor: human("user:demo-operator", "Demo Operator"),
      taskInstructions: "Implement the demo feature.",
      implementer: { tool: "claude-code", model: "demo-model" },
      reviewer: { tool: "codex-cli", model: "demo-model" },
      verificationCommands: PASSING_COMMANDS,
      workspace: resolveWorkspace(workspace2),
      budget: { maxIterations: 3 },
    });
    const scenario2 = toStatusView(loop2);
    emit(`scenario 2 result: phase=${scenario2.phase} outcome=${scenario2.outcome ?? "-"} iterations=${scenario2.iteration}`);

    // Scenario 3: repeated CHANGES_REQUIRED past budget -> EXHAUSTED
    emit("");
    emit("-- scenario 3: repeated CHANGES_REQUIRED exhausts the budget --");
    const workspace3 = makeScratchWorkspace();
    scratchDirs.push(workspace3);
    const { clock: clock3, factory: factory3 } = makeFactory();
    const item3 = await readyWorkItem(factory3, "Loop demo scenario 3: exhausted");
    const service3 = new EngineeringLoopService({
      factory: factory3,
      loops: createInMemoryLoopRepository(),
      clock: clock3,
      ids: createSequentialIdGenerator(),
      processRunner,
      log: emit,
      createImplementerWorker: asLoopWorkerFactory(createScriptedImplementerWorker()),
      createReviewerWorker: asLoopWorkerFactory(createScriptedReviewerWorker({ verdicts: ["CHANGES_REQUIRED"] })),
    });
    const loop3 = await service3.start({
      workItemId: item3.id,
      actor: human("user:demo-operator", "Demo Operator"),
      taskInstructions: "Implement the demo feature.",
      implementer: { tool: "claude-code", model: "demo-model" },
      reviewer: { tool: "codex-cli", model: "demo-model" },
      verificationCommands: PASSING_COMMANDS,
      workspace: resolveWorkspace(workspace3),
      budget: { maxIterations: 2 },
    });
    const scenario3 = toStatusView(loop3);
    const item3Final = await factory3.getWorkItem(item3.id);
    emit(`scenario 3 result: phase=${scenario3.phase} outcome=${scenario3.outcome ?? "-"} workItemStatus=${item3Final.status}`);

    emit("");
    emit("== summary ==");
    emit(`scenario 1 (clean pass)          : ${scenario1.phase}`);
    emit(`scenario 2 (remediate then pass) : ${scenario2.phase}`);
    emit(`scenario 3 (budget exhausted)    : ${scenario3.phase}`);

    return { scenario1, scenario2, scenario3, transcript };
  } finally {
    for (const dir of scratchDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
