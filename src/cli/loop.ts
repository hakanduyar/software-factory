/**
 * `sf loop start|status|resume|cancel` — CLI surface for the TASK-004
 * autonomous engineering loop. Wires the durable SQLite `FactoryStore`
 * (TASK-002) and its own, independent loop-state SQLite file (see
 * docs/tasks/TASK-004-autonomous-engineering-loop.md §5) into a real
 * `EngineeringLoopService`.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createSqliteLoopRepository, type SqliteLoopRepository } from "../adapters/orchestration/sqliteLoopRepository.js";
import { createNodeProcessRunner } from "../adapters/process/nodeProcessRunner.js";
import { createLocalHumanIdentityGate } from "../adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../adapters/security/localWorkerRegistry.js";
import { resolveWorkspace } from "../adapters/workers/workspace.js";
import { createSqliteStore, type SqliteFactoryStore } from "../adapters/sqlite/sqliteStore.js";
import { FactoryService } from "../app/factoryService.js";
import { human } from "../domain/actor.js";
import { createRandomIdGenerator } from "../domain/ids.js";
import { EngineeringLoopService } from "../orchestration/engineeringLoopService.js";
import {
  toStatusView,
  type LoopBudget,
  type LoopStatusView,
  type LoopWorkerConfig,
  type VerificationCommandConfig,
} from "../orchestration/loopTypes.js";
import { systemClock } from "../ports/clock.js";

const DEFAULT_FACTORY_DB_PATH = ".factory-data/factory.db";
const DEFAULT_LOOPS_DB_PATH = ".factory-data/loops.db";
/** Fixture-scale credential, same posture as sf demo:persistent's: never a real secret (C6). */
const CLI_CREDENTIAL = "sf-loop-local-operator-secret";

const DEFAULT_IMPLEMENTER: LoopWorkerConfig = { tool: "claude-code", model: "claude-sonnet-5", effort: "xhigh" };
const DEFAULT_REVIEWER: LoopWorkerConfig = { tool: "codex-cli", model: "gpt-5.6-luna", effort: "xhigh" };
const DEFAULT_VERIFICATION_COMMANDS: readonly VerificationCommandConfig[] = [
  { id: "typecheck", executable: "npm", argv: ["run", "typecheck"] },
  { id: "test", executable: "npm", argv: ["test"] },
];

interface LoopCliConfig {
  readonly workspace: string;
  readonly taskInstructions: string;
  readonly implementer?: LoopWorkerConfig;
  readonly reviewer?: LoopWorkerConfig;
  readonly verificationCommands?: readonly VerificationCommandConfig[];
  readonly budget?: Partial<LoopBudget>;
}

function validateVerificationCommands(value: unknown): readonly VerificationCommandConfig[] {
  if (!Array.isArray(value)) {
    throw new Error('--config "verificationCommands" must be an array');
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`--config "verificationCommands[${index}]" must be an object`);
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.length === 0) {
      throw new Error(`--config "verificationCommands[${index}].id" must be a non-empty string`);
    }
    if (typeof row.executable !== "string" || row.executable.length === 0) {
      throw new Error(`--config "verificationCommands[${index}].executable" must be a non-empty string`);
    }
    if (!Array.isArray(row.argv) || row.argv.some((arg) => typeof arg !== "string")) {
      throw new Error(`--config "verificationCommands[${index}].argv" must be an array of strings (never a shell string)`);
    }
    return row as unknown as VerificationCommandConfig;
  });
}

function loadLoopConfig(configPath: string): LoopCliConfig {
  const raw = readFileSync(resolve(configPath), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--config file is not valid JSON: ${String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--config file must contain a JSON object");
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.workspace !== "string" || row.workspace.length === 0) {
    throw new Error('--config file must set "workspace" (a string path)');
  }
  if (typeof row.taskInstructions !== "string" || row.taskInstructions.length === 0) {
    throw new Error('--config file must set "taskInstructions" (a non-empty string)');
  }

  const implementer = row.implementer as LoopWorkerConfig | undefined;
  const reviewer = row.reviewer as LoopWorkerConfig | undefined;
  const verificationCommands = row.verificationCommands === undefined ? undefined : validateVerificationCommands(row.verificationCommands);
  const budget = row.budget as Partial<LoopBudget> | undefined;

  return {
    workspace: row.workspace,
    taskInstructions: row.taskInstructions,
    ...(implementer === undefined ? {} : { implementer }),
    ...(reviewer === undefined ? {} : { reviewer }),
    ...(verificationCommands === undefined ? {} : { verificationCommands }),
    ...(budget === undefined ? {} : { budget }),
  };
}

export interface LoopCliOptions {
  readonly log?: (line: string) => void;
  readonly factoryDbPath?: string;
  readonly loopsDbPath?: string;
}

interface OpenStores {
  readonly store: SqliteFactoryStore;
  readonly loops: SqliteLoopRepository;
  readonly factory: FactoryService;
  readonly service: EngineeringLoopService;
}

function openStores(options: LoopCliOptions): OpenStores {
  const factoryDbPath = resolve(options.factoryDbPath ?? process.env.FACTORY_DB_PATH ?? DEFAULT_FACTORY_DB_PATH);
  const loopsDbPath = resolve(options.loopsDbPath ?? process.env.FACTORY_LOOPS_DB_PATH ?? DEFAULT_LOOPS_DB_PATH);
  mkdirSync(dirname(factoryDbPath), { recursive: true });
  mkdirSync(dirname(loopsDbPath), { recursive: true });

  const store = createSqliteStore(factoryDbPath);
  const loops = createSqliteLoopRepository(loopsDbPath);
  const factory = new FactoryService({
    store,
    clock: systemClock,
    ids: createRandomIdGenerator(),
    identityGate: createLocalHumanIdentityGate({ credential: CLI_CREDENTIAL, clock: systemClock }),
    workerRegistry: createLocalWorkerRegistry(systemClock),
  });
  const service = new EngineeringLoopService({
    factory,
    loops,
    clock: systemClock,
    ids: createRandomIdGenerator(),
    processRunner: createNodeProcessRunner(),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  return { store, loops, factory, service };
}

function printStatus(view: LoopStatusView, log: (line: string) => void): void {
  log(`loop        : ${view.id}`);
  log(`work item   : ${view.workItemId}`);
  log(`phase       : ${view.phase}`);
  log(`iteration   : ${view.iteration}/${view.maxIterations}`);
  if (view.lastImplementerRunId !== undefined) {
    log(`implementer : ${view.lastImplementerRunId} (${view.lastImplementerOutcome ?? "pending"})`);
  }
  if (view.lastVerificationPassed !== undefined) {
    log(`verification: ${view.lastVerificationPassed ? "PASSED" : "FAILED"}${
      view.lastVerificationFailedCommandIds === undefined ? "" : ` (${view.lastVerificationFailedCommandIds.join(", ")})`
    }`);
  }
  if (view.lastReviewVerdict !== undefined) {
    log(`review      : ${view.lastReviewVerdict}`);
  }
  log(`total runs  : ${view.totalRunCount}`);
  if (view.outcome !== undefined) {
    log(`outcome     : ${view.outcome}`);
  }
  if (view.failureReason !== undefined) {
    log(`reason      : ${view.failureReason}`);
  }
  log(`human action required: ${view.humanActionRequired}`);
}

export async function runLoopStart(workItemId: string, configPath: string, options: LoopCliOptions = {}): Promise<LoopStatusView> {
  const log = options.log ?? ((): void => {});
  const { store, loops, service } = openStores(options);
  try {
    const config = loadLoopConfig(configPath);
    const workspace = resolveWorkspace(config.workspace);
    const loop = await service.start({
      workItemId,
      actor: human("user:cli-operator", "CLI Operator"),
      taskInstructions: config.taskInstructions,
      implementer: config.implementer ?? DEFAULT_IMPLEMENTER,
      reviewer: config.reviewer ?? DEFAULT_REVIEWER,
      verificationCommands: config.verificationCommands ?? DEFAULT_VERIFICATION_COMMANDS,
      workspace,
      ...(config.budget === undefined ? {} : { budget: config.budget }),
    });
    const view = toStatusView(loop);
    printStatus(view, log);
    return view;
  } finally {
    store.close();
    loops.close();
  }
}

export async function runLoopStatus(loopId: string, options: LoopCliOptions = {}): Promise<LoopStatusView> {
  const log = options.log ?? ((): void => {});
  const { store, loops, service } = openStores(options);
  try {
    const view = toStatusView(await service.status(loopId));
    printStatus(view, log);
    return view;
  } finally {
    store.close();
    loops.close();
  }
}

export async function runLoopResume(loopId: string, options: LoopCliOptions = {}): Promise<LoopStatusView> {
  const log = options.log ?? ((): void => {});
  const { store, loops, service } = openStores(options);
  try {
    const view = toStatusView(await service.resume(loopId));
    printStatus(view, log);
    return view;
  } finally {
    store.close();
    loops.close();
  }
}

export async function runLoopCancel(loopId: string, options: LoopCliOptions = {}): Promise<LoopStatusView> {
  const log = options.log ?? ((): void => {});
  const { store, loops, service } = openStores(options);
  try {
    const view = toStatusView(await service.cancel(loopId, human("user:cli-operator", "CLI Operator")));
    printStatus(view, log);
    return view;
  } finally {
    store.close();
    loops.close();
  }
}
