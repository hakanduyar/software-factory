/**
 * `sf loop start|status|resume|cancel` — CLI surface for the TASK-004
 * autonomous engineering loop. Wires the durable SQLite `FactoryStore`
 * (TASK-002) and its own, independent loop-state SQLite file (see
 * docs/tasks/TASK-004-autonomous-engineering-loop.md §5) into a real
 * `EngineeringLoopService`.
 */

import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { AcceptedResultNoteRequest } from "../adapters/obsidian/acceptedResultNoteConsumer.js";
import type { AcceptedResultNoteStorageResult } from "../adapters/obsidian/acceptedResultNotePersistence.js";
import { recallAcceptedResultNote } from "../adapters/obsidian/acceptedResultNoteRecall.js";

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
import type { ProcessRunner } from "../ports/processRunner.js";

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
  readonly acceptedNote?: AcceptedNoteSelection;
}

/** Operator-supplied CLAIMS to verify through recallAcceptedResultNote; never authority and never a note body. */
interface AcceptedNoteSelection {
  readonly request: AcceptedResultNoteRequest;
  readonly ownedDirectory: string;
  readonly expected: AcceptedResultNoteStorageResult;
}

function exactObject(value: unknown, keys: readonly string[], context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`--config "${context}" must be an object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`--config "${context}" must be an ordinary object`);
  }
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((k, i) => k !== wanted[i])) {
    throw new Error(`--config "${context}" must have exactly the fields ${wanted.join(", ")}`);
  }
  return row;
}

function nonEmptyString(row: Record<string, unknown>, key: string, context: string): string {
  const v = row[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`--config "${context}.${key}" must be a non-empty string`);
  return v;
}

function safeInt(row: Record<string, unknown>, key: string, context: string, min: number): number {
  const v = row[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) {
    throw new Error(`--config "${context}.${key}" must be a safe integer >= ${min}`);
  }
  return v;
}

function absolutePathField(row: Record<string, unknown>, key: string, context: string): string {
  const v = nonEmptyString(row, key, context);
  if (!isAbsolute(v) || /[\u0000-\u001f\u007f]/.test(v)) throw new Error(`--config "${context}.${key}" must be an absolute path`);
  return v;
}

function validateAcceptedNote(value: unknown): AcceptedNoteSelection {
  const ctx = "acceptedNote";
  const top = exactObject(value, ["request", "ownedDirectory", "expected"], ctx);
  const rq = exactObject(top.request, ["workItemId", "expectedSnapshotId", "decision", "lesson"], `${ctx}.request`);
  const request: AcceptedResultNoteRequest = {
    workItemId: nonEmptyString(rq, "workItemId", `${ctx}.request`),
    expectedSnapshotId: nonEmptyString(rq, "expectedSnapshotId", `${ctx}.request`),
    decision: nonEmptyString(rq, "decision", `${ctx}.request`),
    lesson: nonEmptyString(rq, "lesson", `${ctx}.request`),
  };
  const ownedDirectory = absolutePathField(top, "ownedDirectory", ctx);
  const ex = exactObject(top.expected, ["status", "path", "sha256", "byteLength", "source"], `${ctx}.expected`);
  if (ex.status !== "CREATED" && ex.status !== "EXISTING") {
    throw new Error(`--config "${ctx}.expected.status" must be CREATED or EXISTING`);
  }
  const path = absolutePathField(ex, "path", `${ctx}.expected`);
  const sha256 = ex.sha256;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`--config "${ctx}.expected.sha256" must be 64 lowercase hex characters`);
  }
  const byteLength = safeInt(ex, "byteLength", `${ctx}.expected`, 0);
  // The existing AcceptedResultNoteDraft["source"] contract (all ten fields); recall compares every key.
  const sctx = `${ctx}.expected.source`;
  const sc = exactObject(ex.source, [
    "snapshotId", "workItemId", "specRevision", "implementationRunId", "implementationPrincipalId",
    "reviewerRunId", "reviewerPrincipalId", "reviewId", "reviewKind", "reviewVerdict",
  ], sctx);
  if (sc.reviewKind !== "SEMANTIC") throw new Error(`--config "${sctx}.reviewKind" must be SEMANTIC`);
  if (sc.reviewVerdict !== "PASS") throw new Error(`--config "${sctx}.reviewVerdict" must be PASS`);
  const expected: AcceptedResultNoteStorageResult = {
    status: ex.status,
    path,
    sha256,
    byteLength,
    source: {
      snapshotId: nonEmptyString(sc, "snapshotId", sctx),
      workItemId: nonEmptyString(sc, "workItemId", sctx),
      specRevision: safeInt(sc, "specRevision", sctx, 1),
      implementationRunId: nonEmptyString(sc, "implementationRunId", sctx),
      implementationPrincipalId: nonEmptyString(sc, "implementationPrincipalId", sctx),
      reviewerRunId: nonEmptyString(sc, "reviewerRunId", sctx),
      reviewerPrincipalId: nonEmptyString(sc, "reviewerPrincipalId", sctx),
      reviewId: nonEmptyString(sc, "reviewId", sctx),
      reviewKind: "SEMANTIC",
      reviewVerdict: "PASS",
    },
  };
  return { request, ownedDirectory, expected };
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
  // Present-but-wrong (null, array, malformed) refuses; only an absent key means "no selection".
  const acceptedNote = "acceptedNote" in row ? validateAcceptedNote(row.acceptedNote) : undefined;

  return {
    workspace: row.workspace,
    taskInstructions: row.taskInstructions,
    ...(implementer === undefined ? {} : { implementer }),
    ...(reviewer === undefined ? {} : { reviewer }),
    ...(verificationCommands === undefined ? {} : { verificationCommands }),
    ...(budget === undefined ? {} : { budget }),
    ...(acceptedNote === undefined ? {} : { acceptedNote }),
  };
}

export interface LoopCliOptions {
  readonly log?: (line: string) => void;
  readonly factoryDbPath?: string;
  readonly loopsDbPath?: string;
  /** Test seam only: replaces the real process runner. Does not change worker admission or approval policy. */
  readonly processRunner?: ProcessRunner;
}

function resolveFactoryDbPath(options: LoopCliOptions): string {
  return resolve(options.factoryDbPath ?? process.env.FACTORY_DB_PATH ?? DEFAULT_FACTORY_DB_PATH);
}

interface OpenStores {
  readonly store: SqliteFactoryStore;
  readonly loops: SqliteLoopRepository;
  readonly factory: FactoryService;
  readonly service: EngineeringLoopService;
}

function openStores(options: LoopCliOptions): OpenStores {
  const factoryDbPath = resolveFactoryDbPath(options);
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
    processRunner: options.processRunner ?? createNodeProcessRunner(),
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
  // Parse config (and any note selector) first; a selected note needs an EXISTING ordinary
  // factory DB before openStores, which would otherwise create an empty DB and storage.
  const config = loadLoopConfig(configPath);
  if (config.acceptedNote !== undefined) {
    const dbPath = resolveFactoryDbPath(options);
    let ordinary = false;
    try {
      ordinary = lstatSync(dbPath).isFile();
    } catch {
      ordinary = false;
    }
    if (!ordinary) {
      throw new Error("--config acceptedNote requires an existing ordinary factory database file; none was created");
    }
  }
  const { store, loops, factory, service } = openStores(options);
  try {
    const workspace = resolveWorkspace(config.workspace);
    // Recall BEFORE any loop/run is created; any refusal propagates unchanged.
    const verified =
      config.acceptedNote === undefined
        ? undefined
        : await recallAcceptedResultNote(factory, config.acceptedNote.request, config.acceptedNote.ownedDirectory, config.acceptedNote.expected);
    const loop = await service.start({
      workItemId,
      actor: human("user:cli-operator", "CLI Operator"),
      taskInstructions: config.taskInstructions,
      implementer: config.implementer ?? DEFAULT_IMPLEMENTER,
      reviewer: config.reviewer ?? DEFAULT_REVIEWER,
      verificationCommands: config.verificationCommands ?? DEFAULT_VERIFICATION_COMMANDS,
      workspace,
      ...(config.budget === undefined ? {} : { budget: config.budget }),
      ...(verified === undefined ? {} : { recalledNote: verified }),
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
  const { store, loops, factory, service } = openStores(options);
  try {
    // HIGH 1 (remediation round 3): loop cancellation is a protected human
    // governance operation. The CLI operator mints a TrustedHumanToken from
    // the same local identity gate the FactoryService uses (the exact
    // mechanism behind every `sf` approval), then presents it — the loop
    // service refuses cancellation without it. This is the interactive
    // operator's own governance action, not a routine unattended loop step.
    const operator = human("user:cli-operator", "CLI Operator");
    const authorization = factory.authorizeHuman(operator, CLI_CREDENTIAL);
    const view = toStatusView(await service.cancel(loopId, operator, authorization));
    printStatus(view, log);
    return view;
  } finally {
    store.close();
    loops.close();
  }
}
