export function parseTelegramImportArgv(
  argv: readonly string[],
): { readonly updatePath: string; readonly configPath: string } {
  const fail = (): never => {
    throw new Error('Telegram import failed.');
  };
  if (!Array.isArray(argv) || argv.length !== 4) {
    return fail();
  }
  let updatePath: string | undefined;
  let configPath: string | undefined;
  for (let i = 0; i < 4; i += 2) {
    const flag: unknown = argv[i];
    const value: unknown = argv[i + 1];
    if (
      typeof flag !== 'string' ||
      typeof value !== 'string' ||
      value.trim().length === 0
    ) {
      return fail();
    }
    if (flag === '--update' && updatePath === undefined) {
      updatePath = value;
    } else if (flag === '--config' && configPath === undefined) {
      configPath = value;
    } else {
      return fail();
    }
  }
  if (updatePath === undefined || configPath === undefined) {
    return fail();
  }
  return { updatePath, configPath };
}

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { TextDecoder } from "node:util";

const MAX_IMPORT_BYTES = 65536;

export function readTelegramImportJsonFile(path: string): {
  readonly raw: string;
  readonly value: unknown;
} {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    if (!fstatSync(fd).isFile()) {
      throw new Error("not a regular file");
    }
    const buffer = Buffer.alloc(MAX_IMPORT_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) {
        break;
      }
      total += read;
    }
    if (total > MAX_IMPORT_BYTES) {
      throw new Error("too large");
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, total),
    );
    const value: unknown = JSON.parse(raw);
    return { raw, value };
  } catch {
    throw new Error("Telegram import failed.");
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // close failure must not mask the primary outcome
      }
    }
  }
}

export interface TelegramImportOperatorConfig {
  factoryDbPath: string;
  plansDbPath: string;
  trustedBotId: number;
  projectId: string;
  allowedTuples: Array<{ botId: number; chatId: number; senderId: number }>;
  planner: Record<string, unknown>;
  execution: Record<string, unknown>;
  budget?: Record<string, unknown>;
  constraints?: string[];
}

export function parseTelegramImportOperatorConfig(value: unknown): TelegramImportOperatorConfig {
  const fail = (): never => {
    throw new Error('Telegram import failed.');
  };
  const isRecord = (v: unknown): v is Record<string, unknown> => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  };
  const str = (v: unknown): string => (typeof v === 'string' && v.length > 0 ? v : fail());
  const pos = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail());
  const nonZero = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v !== 0 ? v : fail());
  const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : fail());

  if (!isRecord(value)) return fail();
  const required = ['factoryDbPath', 'plansDbPath', 'trustedBotId', 'projectId', 'allowedTuples', 'planner', 'execution'];
  const allowed = new Set([...required, 'budget', 'constraints']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail();
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) fail();

  const tuples = value.allowedTuples;
  if (!Array.isArray(tuples) || tuples.length === 0) return fail();
  const allowedTuples = tuples.map((t) => {
    const r = rec(t);
    const keys = Object.keys(r);
    if (keys.length !== 3 || !['botId', 'senderId', 'chatId'].every((k) => keys.includes(k))) fail();
    return { botId: pos(r.botId), chatId: nonZero(r.chatId), senderId: pos(r.senderId) };
  });

  const config: TelegramImportOperatorConfig = {
    factoryDbPath: str(value.factoryDbPath),
    plansDbPath: str(value.plansDbPath),
    trustedBotId: pos(value.trustedBotId),
    projectId: str(value.projectId),
    allowedTuples,
    planner: rec(value.planner),
    execution: rec(value.execution),
  };
  if (Object.prototype.hasOwnProperty.call(value, 'budget')) config.budget = rec(value.budget);
  if (Object.prototype.hasOwnProperty.call(value, 'constraints')) {
    const c = value.constraints;
    if (!Array.isArray(c) || !c.every((x) => typeof x === 'string')) return fail();
    config.constraints = [...(c as string[])];
  }
  return config;
}

import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

const IMPORT_FAILURE = "Telegram import failed.";

interface CanonicalFile {
  readonly path: string;
  readonly identity: string;
}

function rejectImport(): never {
  throw new Error(IMPORT_FAILURE);
}

function statRegularNonEmpty(path: string): bigint {
  const stats = lstatSync(path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size <= 0n || stats.ino === 0n) {
    rejectImport();
  }
  return stats.dev * (1n << 64n) + stats.ino;
}

function rejectLinkComponents(absolutePath: string): void {
  let current = absolutePath;
  for (;;) {
    if (lstatSync(current).isSymbolicLink()) {
      rejectImport();
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

function canonicalExistingFile(path: string): CanonicalFile {
  if (typeof path !== "string" || path.length === 0) {
    rejectImport();
  }
  const absolutePath = resolve(path);
  statRegularNonEmpty(absolutePath);
  rejectLinkComponents(absolutePath);
  const canonicalPath = realpathSync(absolutePath);
  return { path: canonicalPath, identity: statRegularNonEmpty(canonicalPath).toString() };
}

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function canonicalTelegramImportDatabases(
  factoryDbPath: string,
  plansDbPath: string,
): { readonly factoryDbPath: string; readonly plansDbPath: string } {
  try {
    const factory = canonicalExistingFile(factoryDbPath);
    const plans = canonicalExistingFile(plansDbPath);
    if (
      comparablePath(factory.path) === comparablePath(plans.path) ||
      factory.identity === plans.identity
    ) {
      rejectImport();
    }
    return { factoryDbPath: factory.path, plansDbPath: plans.path };
  } catch {
    throw new Error(IMPORT_FAILURE);
  }
}

import * as importLockFs from 'node:fs';

const LOCK_SUFFIX = '.sf-telegram-import.lock';
const FAILURE_MESSAGE = 'Telegram import failed.';

const OWNERSHIP_UNVERIFIED_CODE = 'LOCK_OWNERSHIP_UNVERIFIED';

// Carries only a stable code and the generic public message: no paths or private data.
class LockOwnershipUnverifiedError extends Error {
  readonly code = OWNERSHIP_UNVERIFIED_CODE;
  constructor() {
    super(FAILURE_MESSAGE);
  }
}

interface OwnedImportLock {
  readonly path: string;
  readonly fd: number;
  readonly dev: bigint;
  readonly ino: bigint;
}

// Cooperative/operator-exclusive locking: no guarantee against a hostile path swap.
function acquireOwnedLock(path: string): OwnedImportLock {
  const fd = importLockFs.openSync(path, 'wx', 0o600);
  try {
    const stat = importLockFs.fstatSync(fd, { bigint: true });
    return { path, fd, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    try {
      importLockFs.closeSync(fd);
    } catch {
      // Identity was never captured so nothing is unlinked; residual needs operator recovery.
    }
    throw new LockOwnershipUnverifiedError();
  }
}

// Attempts every cleanup step even after an error; returns false if any step failed.
function releaseOwnedLocks(locks: readonly OwnedImportLock[]): boolean {
  let clean = true;
  for (const lock of locks) {
    try {
      importLockFs.closeSync(lock.fd);
    } catch {
      clean = false;
    }
    try {
      const current = importLockFs.lstatSync(lock.path, { bigint: true });
      if (current.isFile() && current.dev === lock.dev && current.ino === lock.ino) {
        importLockFs.unlinkSync(lock.path);
      } else {
        clean = false; // Foreign file at our path: never delete it.
      }
    } catch {
      clean = false;
    }
  }
  return clean;
}

export function acquireTelegramImportDatabaseLocks(
  factoryDbPath: string,
  plansDbPath: string,
): () => void {
  const lockPaths = [factoryDbPath, plansDbPath]
    .map((dbPath) => dbPath + LOCK_SUFFIX)
    .sort();
  const held: OwnedImportLock[] = [];
  try {
    for (const lockPath of lockPaths) {
      held.push(acquireOwnedLock(lockPath));
    }
  } catch (error) {
    // Only locks this call created are cleaned; a contended existing lock is never touched.
    releaseOwnedLocks(held);
    if (error instanceof LockOwnershipUnverifiedError) {
      throw error;
    }
    throw new Error(FAILURE_MESSAGE);
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    if (!releaseOwnedLocks(held)) {
      throw new Error(FAILURE_MESSAGE);
    }
  };
}

import { DatabaseSync } from "node:sqlite";
import { assertReadonlyFactorySchema } from "../adapters/sqlite/schema.js";
import { assertReadonlyPlanSchemaV2 } from "../adapters/planning/sqlitePlanRepository.js";

export function assertTelegramImportDatabaseSchemas(factoryDbPath: string, plansDbPath: string): void {
  const handles: DatabaseSync[] = [];
  let failed = false;
  try {
    const factoryDb = new DatabaseSync(factoryDbPath, { readOnly: true });
    handles.push(factoryDb);
    const plansDb = new DatabaseSync(plansDbPath, { readOnly: true });
    handles.push(plansDb);
    assertReadonlyFactorySchema(factoryDb);
    assertReadonlyPlanSchemaV2(plansDb);
  } catch {
    failed = true;
  }
  for (const handle of handles.reverse()) {
    try {
      handle.close();
    } catch {
      failed = true;
    }
  }
  if (failed) {
    throw new Error("Telegram import failed.");
  }
}

import { createLocalWorkerRegistry } from "../adapters/security/localWorkerRegistry.js";
import { systemClock } from "../ports/clock.js";
import {
  createLinkedTextPlanRequestAdapter,
  type TextPlanRequestConfig,
  type TextPlanRequestResult,
} from "../adapters/telegram/textPlanRequest.js";
import { createRandomIdGenerator } from "../domain/ids.js";
import { FactoryService } from "../app/factoryService.js";
import type { NormalizedTextEnvelope } from "../adapters/telegram/textUpdateEnvelope.js";
import { system } from "../domain/actor.js";
import type { PlannerWorker } from "../planning/plannerWorker.js";
import { PlanningService } from "../planning/planningService.js";
import {
  createSqlitePlanRepository,
  type SqlitePlanRepository,
} from "../adapters/planning/sqlitePlanRepository.js";
import { createSqliteStore } from "../adapters/sqlite/sqliteStore.js";
import type { HumanIdentityGate } from "../ports/humanIdentityGate.js";
import type { LoopDispatcher } from "../planning/loopDispatcher.js";

export async function submitTelegramImportRequest(
  config: TelegramImportOperatorConfig,
  envelope: NormalizedTextEnvelope,
  dbPaths: { readonly factoryDbPath: string; readonly plansDbPath: string },
): Promise<TextPlanRequestResult> {
  const failure = (): Error => new Error("Telegram import failed.");
  const reject = async (): Promise<never> => {
    throw failure();
  };

  // Authority check strictly before any writable opener.
  const allowed =
    envelope.botId === config.trustedBotId &&
    config.allowedTuples.some(
      (tuple) =>
        tuple.botId === envelope.botId &&
        tuple.chatId === envelope.chatId &&
        tuple.senderId === envelope.senderId,
    );
  if (!allowed) throw failure();

  let store: ReturnType<typeof createSqliteStore> | undefined;
  let plans: SqlitePlanRepository | undefined;
  let result: TextPlanRequestResult | undefined;
  let primaryError: unknown;
  let failed = false;

  try {
    store = createSqliteStore(dbPaths.factoryDbPath);
    plans = createSqlitePlanRepository(dbPaths.plansDbPath);

    const clock = systemClock;
    const ids = createRandomIdGenerator();

    const identityGate: HumanIdentityGate = {
      authorize: () => {
        throw failure();
      },
      verify: () => false,
    };
    const factory = new FactoryService({
      store,
      clock,
      ids,
      identityGate,
      workerRegistry: createLocalWorkerRegistry(clock),
    });

    const planner: PlannerWorker = { id: "telegram-import-denied", plan: reject };
    const dispatcher: LoopDispatcher = {
      find: reject,
      start: reject,
      resume: reject,
      status: reject,
    };
    const planning = new PlanningService({ factory, plans, clock, ids, planner, dispatcher });

    const adapterConfig = {
      projectId: config.projectId,
      actor: system("system:offline-telegram-import", "Offline Telegram Import"),
      allowedTuples: config.allowedTuples.map((tuple) => ({
        botId: tuple.botId,
        chatId: tuple.chatId,
        senderId: tuple.senderId,
      })),
      planner: config.planner,
      execution: config.execution,
      ...(config.budget !== undefined ? { budget: config.budget } : {}),
      ...(config.constraints !== undefined ? { constraints: config.constraints } : {}),
    } as unknown as TextPlanRequestConfig;

    const adapter = createLinkedTextPlanRequestAdapter({ planning, config: adapterConfig });
    result = await adapter.submit(envelope);
  } catch (error) {
    failed = true;
    primaryError = error;
  }

  // Attempt every close regardless of earlier failures.
  let closeFailed = false;
  for (const handle of [plans, store]) {
    if (handle === undefined) continue;
    try {
      handle.close();
    } catch {
      closeFailed = true;
    }
  }

  if (failed || closeFailed || result === undefined) {
    void primaryError;
    throw failure();
  }
  return result;
}

import { normalizeTextUpdate } from "../adapters/telegram/textUpdateEnvelope.js";

export async function handleTelegramImport(argv: readonly string[]): Promise<number> {
  let release: (() => void) | undefined;
  let outcome: { readonly planId: unknown; readonly phase: unknown } | undefined;
  let failed = false;
  let ownershipUnverified = false;

  try {
    const args = parseTelegramImportArgv(argv);
    const config = parseTelegramImportOperatorConfig(
      readTelegramImportJsonFile(args.configPath).value,
    );
    const normalized = normalizeTextUpdate(
      readTelegramImportJsonFile(args.updatePath).raw,
      config.trustedBotId,
    ) as unknown as { readonly envelope?: NormalizedTextEnvelope };
    const envelope = normalized.envelope;
    if (envelope === undefined || envelope === null) {
      throw new Error("Telegram import failed.");
    }
    const allowed =
      envelope.botId === config.trustedBotId &&
      config.allowedTuples.some(
        (tuple) =>
          tuple.botId === envelope.botId &&
          tuple.chatId === envelope.chatId &&
          tuple.senderId === envelope.senderId,
      );
    if (!allowed) {
      throw new Error("Telegram import failed.");
    }

    const pair = canonicalTelegramImportDatabases(config.factoryDbPath, config.plansDbPath);
    release = acquireTelegramImportDatabaseLocks(pair.factoryDbPath, pair.plansDbPath);
    assertTelegramImportDatabaseSchemas(pair.factoryDbPath, pair.plansDbPath);
    const submitted = (await submitTelegramImportRequest(config, envelope, pair)) as unknown as {
      readonly planId: unknown;
      readonly phase: unknown;
    };
    outcome = { planId: submitted.planId, phase: submitted.phase };
  } catch (error) {
    failed = true;
    ownershipUnverified =
      error instanceof Error &&
      (error as { readonly code?: unknown }).code === OWNERSHIP_UNVERIFIED_CODE;
  }

  if (release !== undefined) {
    try {
      release();
    } catch {
      failed = true;
    }
  }

  if (failed || outcome === undefined) {
    process.stderr.write("Telegram import failed.\n");
    if (ownershipUnverified) {
      process.stderr.write(`Recovery required: ${OWNERSHIP_UNVERIFIED_CODE}\n`);
    }
    return 1;
  }
  process.stdout.write(`${JSON.stringify({ planId: outcome.planId, phase: outcome.phase })}\n`);
  return 0;
}
