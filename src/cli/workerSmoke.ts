/**
 * `sf worker smoke claude|codex` — a controlled, explicit, real invocation of
 * an installed CLI through the actual Factory path (TASK-003 item 14).
 *
 * Not run by `npm test`. Guarded behind its own CLI subcommand /
 * `npm run smoke:*` script so ordinary development never burns model usage.
 *
 * Safety properties, all deliberate:
 *   - runs in a brand-new, throwaway, git-initialized scratch directory —
 *     never the Factory's own repository;
 *   - role is REVIEWER (read-only sandbox for Codex; no file-editing intent
 *     in the prompt either way) against a zero-cost mock IMPLEMENTER run, so
 *     nothing about this smoke test can write, commit, or push anything;
 *   - a short timeout;
 *   - goes through the real `FactoryService.runWorker` three-phase
 *     lifecycle, proving the Factory itself launched the CLI, not just the
 *     adapter in isolation.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInMemoryStore } from "../adapters/memory/inMemoryStore.js";
import { createNodeProcessRunner } from "../adapters/process/nodeProcessRunner.js";
import { createLocalHumanIdentityGate } from "../adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../adapters/security/localWorkerRegistry.js";
import { createClaudeCodeWorker } from "../adapters/workers/claudeCodeAdapter.js";
import { createCodexCliWorker } from "../adapters/workers/codexCliAdapter.js";
import { createMockWorker } from "../adapters/workers/mockWorker.js";
import { resolveWorkspace } from "../adapters/workers/workspace.js";
import { FactoryService } from "../app/factoryService.js";
import { agent, human } from "../domain/actor.js";
import type { Evidence } from "../domain/evidence.js";
import { createSequentialIdGenerator } from "../domain/ids.js";
import type { Run } from "../domain/run.js";
import type { ProcessRunner } from "../ports/processRunner.js";
import { systemClock } from "../ports/clock.js";

export type SmokeTool = "claude" | "codex";

export interface WorkerSmokeOptions {
  readonly log?: (line: string) => void;
  readonly processRunner?: ProcessRunner;
  readonly executable?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly timeoutMs?: number;
}

export interface WorkerSmokeResult {
  readonly tool: SmokeTool;
  readonly workspaceRoot: string;
  readonly run: Run;
  readonly evidence: readonly Evidence[];
}

const SMOKE_CREDENTIAL = "smoke-local-operator-secret";

function defaultModel(tool: SmokeTool): string {
  return tool === "claude" ? "claude-sonnet-5" : "gpt-5.6-luna";
}

function defaultExecutable(tool: SmokeTool): string {
  return tool === "claude" ? "claude" : "codex";
}

export async function runWorkerSmoke(tool: SmokeTool, options: WorkerSmokeOptions = {}): Promise<WorkerSmokeResult> {
  const emit = options.log ?? ((): void => {});
  const runner = options.processRunner ?? createNodeProcessRunner();

  // Scratch workspace/temp dir cleanup runs in `finally` below so it happens
  // on every exit path — success, a FAILED WorkerOutcome (non-zero exit,
  // timeout, spawn failure), or a thrown adapter error — never only on the
  // happy path (TASK-003 remediation round 1, LOW finding). Only this
  // freshly `mkdtemp`'d path is ever removed; no user repository is touched.
  const scratchRoot = mkdtempSync(join(tmpdir(), `sf-worker-smoke-${tool}-`));
  try {
    return await runSmokeInWorkspace(tool, scratchRoot, emit, runner, options);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
    emit(`cleaned up scratch workspace: ${scratchRoot}`);
  }
}

async function runSmokeInWorkspace(
  tool: SmokeTool,
  scratchRoot: string,
  emit: (line: string) => void,
  runner: ProcessRunner,
  options: WorkerSmokeOptions,
): Promise<WorkerSmokeResult> {
  execFileSync("git", ["init", "--quiet"], { cwd: scratchRoot });
  writeFileSync(join(scratchRoot, "README.md"), "Scratch workspace for `sf worker smoke`. Safe to delete.\n");
  emit(`scratch workspace: ${scratchRoot}`);
  const workspace = resolveWorkspace(scratchRoot);

  const clock = systemClock;
  const store = createInMemoryStore();
  const factory = new FactoryService({
    store,
    clock,
    ids: createSequentialIdGenerator(),
    identityGate: createLocalHumanIdentityGate({ credential: SMOKE_CREDENTIAL, clock }),
    workerRegistry: createLocalWorkerRegistry(clock),
  });

  const orchestrator = agent("agent:smoke", "Worker Smoke CLI");
  const operator = human("user:smoke", "Smoke Operator");

  const project = await factory.createProject({ key: "SMOKE", name: "Worker Smoke Test" });
  const item = await factory.createWorkItem({
    projectId: project.id,
    title: `sf worker smoke ${tool}`,
    type: "CHORE",
    planVersion: "smoke-v1",
    acceptanceCriteria: [{ text: "The configured CLI responds to a trivial, read-only prompt", verificationHint: "manual" }],
  });

  await factory.advance(item.id, "ANALYSIS", orchestrator);
  await factory.advance(item.id, "PLAN_REVIEW", orchestrator);
  await factory.recordApproval({
    gate: "PLAN_APPROVAL",
    subject: factory.workItemSubject(item.id),
    decision: "APPROVED",
    actor: operator,
    authorization: factory.authorizeHuman(operator, SMOKE_CREDENTIAL),
  });
  await factory.advance(item.id, "READY", orchestrator);
  await factory.advance(item.id, "IMPLEMENTING", orchestrator);

  // Zero-cost placeholder so the real CLI worker has a concrete implementation run to review.
  const mockImplementer = createMockWorker({ id: "smoke-mock-implementer", roles: ["IMPLEMENTER"] });
  factory.registerWorker(mockImplementer);
  const implementation = await factory.runWorker({
    workItemId: item.id,
    role: "IMPLEMENTER",
    worker: mockImplementer,
    instructions: "placeholder implementation for the worker smoke test",
  });

  const model = options.model ?? defaultModel(tool);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const executable = options.executable ?? defaultExecutable(tool);
  const sharedConfig = {
    executable,
    model,
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    timeoutMs,
    workspace,
    processRunner: runner,
    roles: ["REVIEWER"] as const,
  };
  const worker = tool === "claude" ? createClaudeCodeWorker(sharedConfig) : createCodexCliWorker(sharedConfig);
  factory.registerWorker(worker);

  emit(`launching ${tool} (executable=${executable}, model=${model}, timeoutMs=${timeoutMs}) against ${workspace.root} ...`);

  const { run, evidence } = await factory.runWorker({
    workItemId: item.id,
    role: "REVIEWER",
    worker,
    instructions:
      "This is a read-only smoke test. List the files in this workspace and reply with one short sentence " +
      "confirming you can see them. Do not create, modify, or delete any file, and do not run any command " +
      "beyond reading.",
    againstRunId: implementation.run.id,
  });

  emit(`run ${run.id} status=${run.status}`);
  emit(`summary: ${run.summary}`);
  for (const entry of evidence) {
    emit(`evidence [${entry.kind}] ${entry.reference}: ${entry.summary}`);
  }

  return { tool, workspaceRoot: scratchRoot, run, evidence };
}
