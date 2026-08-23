/**
 * `sf supervise` — the operator surface for the autonomous completion
 * supervisor (TASK-006 §7).
 *
 * `tick` is the important one, and it is deliberately a ONE-SHOT command: it
 * does one bounded pass and exits, printing `nextWakeAt`. That shape is what
 * lets a systemd timer or cron own the waiting, so that between ticks no
 * process runs at all and waiting costs nothing.
 *
 * The read commands (`status`, `resources`, `roadmap`) are strictly read-only:
 * they never probe a provider, never launch a worker and never write.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createCliResourceProbe } from "../adapters/supervision/cliResourceProbe.js";
import {
  createSqliteSupervisorRepository,
  type SqliteSupervisorRepository,
} from "../adapters/supervision/sqliteSupervisorRepository.js";
import { createNodeProcessRunner } from "../adapters/process/nodeProcessRunner.js";
import { createSequentialIdGenerator } from "../domain/ids.js";
import { DEFAULT_ROUTING_POLICY } from "../supervision/modelRouting.js";
import { parseFinancialPolicy } from "../supervision/financialSafety.js";
import { boundedDiagnostic } from "../supervision/resourceClassifier.js";
import { SupervisorService, type TickResult } from "../supervision/supervisorService.js";
import type { WorkExecutionInput, WorkExecutor, WorkOutcome } from "../supervision/supervisorPorts.js";
import { ESCALATION_REASONS, type EscalationReason, type SupervisorState } from "../supervision/supervisorTypes.js";
import { systemClock } from "../ports/clock.js";

const DEFAULT_SUPERVISOR_DB_PATH = ".factory/supervisor.db";

export interface SuperviseCliOptions {
  readonly supervisorDbPath?: string;
  readonly log?: (line: string) => void;
}

/**
 * The resources this installation may use. Configuration, not architecture (C9).
 *
 * `billingMode` here is a CEILING, not a declaration (NEW-FIN-1, F4-3). The mode
 * that decides anything is the one the PROVIDER reports to a probe the
 * supervisor runs in-process immediately before each launch; this entry can only
 * make that answer stricter. Listing `INCLUDED_SUBSCRIPTION` therefore says "do
 * not additionally restrict these", not "trust me, these are free" — the earlier
 * version of this comment claimed the latter, and that was the bug.
 */
const RESOURCE_CATALOG = [
  { provider: "claude-code", model: "opus", billingMode: "INCLUDED_SUBSCRIPTION" as const },
  { provider: "claude-code", model: "sonnet", billingMode: "INCLUDED_SUBSCRIPTION" as const },
  { provider: "codex-cli", model: "gpt-5.6-luna", billingMode: "INCLUDED_SUBSCRIPTION" as const },
];

/**
 * THE OUTPUT CHOKEPOINT (review finding R9-SEC-1, HIGH).
 *
 * The supervisor sanitizes everything it WRITES. This file reads a database and
 * prints it — and a database is not a trusted input: it can be edited, restored
 * from elsewhere, or carry rows written by an older build with weaker rules. The
 * ninth review put token-shaped text into policy data, resource diagnostics,
 * roadmap titles and escalation actions, and `status`, `resources` and `roadmap`
 * all printed it verbatim, including through the policy PARSE ERROR — which
 * quotes the offending value back.
 *
 * Every persisted string now leaves through here. Same reasoning as `setStatus`
 * and `sanitizeTickResult`: one chokepoint that a later call site cannot forget,
 * rather than a rule each `log()` is trusted to remember.
 */
function safe(value: string): string {
  return boundedDiagnostic(value);
}

function resolveDbPath(options: SuperviseCliOptions): string {
  return resolve(
    options.supervisorDbPath ?? process.env["FACTORY_SUPERVISOR_DB_PATH"] ?? DEFAULT_SUPERVISOR_DB_PATH,
  );
}

function openRepository(options: SuperviseCliOptions): SqliteSupervisorRepository {
  const path = resolveDbPath(options);
  mkdirSync(dirname(path), { recursive: true });
  return createSqliteSupervisorRepository(path);
}

/**
 * Opens the database for a READ-ONLY command, or reports that there is nothing
 * to read (review note, round 4).
 *
 * `status`, `resources` and `roadmap` already refused to WRITE state, but
 * opening the database created the file and its schema — so running a read
 * command against a fresh machine left a database behind and quietly changed
 * what a subsequent `tick` would find. A command that says it only reads should
 * leave no trace at all, including on disk.
 */
function openForReading(options: SuperviseCliOptions, log: (line: string) => void): SqliteSupervisorRepository | undefined {
  const path = resolveDbPath(options);
  if (!existsSync(path)) {
    log("supervisor state has not been initialized yet; run `sf supervise tick` first");
    return undefined;
  }
  return createSqliteSupervisorRepository(path);
}

/**
 * The executor the shipped CLI wires in.
 *
 * TASK-006 builds the SCHEDULER, not a new way to do work: driving TASK-005
 * planning and the TASK-004 loop from a roadmap item is the next roadmap task's
 * job, and inventing it here would be exactly the "second engineering loop"
 * every previous task refused to build.
 *
 * So this reports honestly that a human-authored plan is required for the item,
 * rather than pretending to execute it. Every other part of the supervisor —
 * resource states, waiting, backoff, gating, checkpointing, escalation — is
 * fully live.
 */
function createUnimplementedExecutor(): WorkExecutor {
  return {
    async execute(input: WorkExecutionInput): Promise<WorkOutcome> {
      return {
        kind: "HUMAN_REQUIRED",
        action: {
          kind: "AUTHOR_PLAN",
          description: `roadmap item ${input.item.key} ("${input.item.title}") needs an approved plan before it can be executed`,
        },
        detail:
          "the supervisor schedules work; turning a roadmap item into an approved plan is TASK-005's job and is not yet wired to the queue",
      };
    },
  };
}

function buildService(repository: SqliteSupervisorRepository, log: (line: string) => void): SupervisorService {
  return new SupervisorService({
    repository,
    probe: createCliResourceProbe({ processRunner: createNodeProcessRunner(), cwd: process.cwd() }),
    executor: createUnimplementedExecutor(),
    clock: systemClock,
    ids: createSequentialIdGenerator(),
    routingPolicy: DEFAULT_ROUTING_POLICY,
    resourceCatalog: RESOURCE_CATALOG,
    log,
  });
}

/**
 * Loads state for a READ-ONLY command.
 *
 * Review non-blocking note: these commands previously called
 * `ensureInitialized`, so merely asking "what is the state?" could CREATE it.
 * A read that writes is a read you cannot safely run to diagnose a problem, so
 * an uninitialised database is now reported rather than quietly seeded.
 */
async function requireInitialized(
  repository: SqliteSupervisorRepository,
  log: (line: string) => void,
): Promise<SupervisorState | undefined> {
  const state = await repository.load();
  if (state === undefined) {
    log("supervisor state has not been initialized yet; run `sf supervise tick` first");
  }
  return state;
}

/**
 * R10-SEC-1: `roadmapKey` and `actionId` come from the DATABASE too.
 *
 * `sanitizeTickResult` cleans the free-text fields, and this function then
 * printed the identifier fields raw — so a hostile row keyed
 * `BAD-sk-ant-api03-…` reached the console through the one command an operator
 * runs most. Identifiers felt like structure rather than content, which is
 * exactly the assumption that made every earlier instance of this bug possible.
 * Everything persisted goes through `safe()`.
 */
function describeTick(result: TickResult, log: (line: string) => void): number {
  switch (result.kind) {
    case "ADVANCED":
      log(`advanced   : ${safe(result.roadmapKey)} (${safe(result.actionId)})`);
      log(`detail     : ${safe(result.detail)}`);
      return 0;
    case "IDLE":
      log(`idle       : ${safe(result.reason)}`);
      if (result.nextWakeAt !== undefined) {
        log(`next wake  : ${new Date(result.nextWakeAt).toISOString()}`);
      }
      return 0;
    case "WAITING_FOR_RESOURCE":
      log(`waiting    : ${safe(result.roadmapKey)} needs a resource`);
      log(`reason     : ${safe(result.reason)}`);
      if (result.nextWakeAt !== undefined) {
        log(`next wake  : ${new Date(result.nextWakeAt).toISOString()}`);
      }
      // Not a failure: a resource shortage is an expected, recoverable state.
      return 0;
    case "WAITING_FOR_HUMAN":
      log(`HUMAN NEEDED for ${safe(result.roadmapKey)} (${result.reason})`);
      log(`action     : ${safe(result.humanActionRequired)}`);
      return 0;
    case "RECOVERY_REQUIRED":
      log(`RECOVERY REQUIRED: ${safe(result.reason)}`);
      return 1;
  }
}

export interface SuperviseBlockOptions extends SuperviseCliOptions {
  readonly roadmapKey: string;
  readonly reason: string;
  readonly humanActionRequired: string;
  readonly detail: string;
}

/**
 * Records a durable blocker (TASK-009).
 *
 * The one write command besides `tick`, and deliberately the narrowest possible
 * one: it can only ever move an item INTO a fail-closed state. There is no
 * counterpart that clears a blocker, because unblocking is done by fixing the
 * cause and letting the supervisor re-derive — not by asserting it is fine now.
 */
export async function runSuperviseBlock(options: SuperviseBlockOptions): Promise<number> {
  const log = options.log ?? ((line: string): void => console.log(line));

  if (!(ESCALATION_REASONS as readonly string[]).includes(options.reason)) {
    log(`unknown reason ${JSON.stringify(options.reason)}; expected one of: ${ESCALATION_REASONS.join(", ")}`);
    return 1;
  }

  const repository = openRepository(options);
  try {
    const service = buildService(repository, log);
    const result = await service.recordBlocker({
      roadmapKey: options.roadmapKey,
      reason: options.reason as EscalationReason,
      humanActionRequired: options.humanActionRequired,
      detail: options.detail,
    });
    if (!result.ok) {
      log(safe(result.reason));
      return 1;
    }
    log(`blocked    : ${safe(options.roadmapKey)} (${options.reason})`);
    log(`action     : ${safe(options.humanActionRequired)}`);
    log(`detail     : ${safe(options.detail)}`);
    return 0;
  } finally {
    repository.close();
  }
}

export async function runSuperviseTick(options: SuperviseCliOptions = {}): Promise<TickResult> {
  const log = options.log ?? ((line: string): void => console.log(line));
  const repository = openRepository(options);
  try {
    const result = await buildService(repository, log).tick();
    describeTick(result, log);
    return result;
  } finally {
    repository.close();
  }
}

export async function runSuperviseStatus(options: SuperviseCliOptions = {}): Promise<SupervisorState | undefined> {
  const log = options.log ?? ((line: string): void => console.log(line));
  // Read-only: never creates the database (review note, round 4).
  const repository = openForReading(options, log);
  if (repository === undefined) {
    return undefined;
  }
  try {
    const state = await requireInitialized(repository, log);
    if (state === undefined) {
      return undefined;
    }
    const policy = parseFinancialPolicy(state.financialPolicy);

    log(`version        : ${state.version}`);
    log(`updated        : ${new Date(state.updatedAt).toISOString()}`);
    log(
      `spending       : ${
        policy.ok
          ? `${policy.value.autonomousSpendAllowed ? "ALLOWED" : "DENIED"} (limit ${policy.value.autonomousSpendLimit})`
          : `DENIED (policy untrusted: ${safe(policy.reason)})`
      }`,
    );
    log(`next wake      : ${state.nextWakeAt === undefined ? "none scheduled" : new Date(state.nextWakeAt).toISOString()}`);
    log(`active claim   : ${state.activeClaim === undefined ? "none" : `${safe(state.activeClaim.actionId)} (${state.activeClaim.state})`}`);

    const open = state.escalations.filter((entry) => !entry.resolved);
    log(`human needed   : ${open.length}`);
    for (const entry of open) {
      log(`  - ${safe(entry.roadmapKey)} [${entry.reason}] ${safe(entry.humanActionRequired)}`);
    }
    return state;
  } finally {
    repository.close();
  }
}

export async function runSuperviseResources(options: SuperviseCliOptions = {}): Promise<SupervisorState | undefined> {
  const log = options.log ?? ((line: string): void => console.log(line));
  // Read-only: never creates the database (review note, round 4).
  const repository = openForReading(options, log);
  if (repository === undefined) {
    return undefined;
  }
  try {
    const state = await requireInitialized(repository, log);
    if (state === undefined) {
      return undefined;
    }
    for (const record of state.resources) {
      const retry = record.retryAt === undefined ? "-" : new Date(record.retryAt).toISOString();
      log(`${safe(record.key).padEnd(28)} ${record.state.padEnd(22)} retry=${retry} backoff=${record.backoff.attempt}`);
      // Since NEW-FIN-1 this is what decides whether using the resource is a
      // FINANCIAL action, so an operator reading this output needs to see it —
      // "AVAILABLE" alone does not mean "usable".
      log(`  billing=${record.observedBillingMode ?? "UNKNOWN (not observed) — using this resource would need a human"}`);
      if (record.diagnostic !== undefined) {
        log(`  ${safe(record.diagnostic)}`);
      }
    }
    return state;
  } finally {
    repository.close();
  }
}

export async function runSuperviseRoadmap(options: SuperviseCliOptions = {}): Promise<SupervisorState | undefined> {
  const log = options.log ?? ((line: string): void => console.log(line));
  // Read-only: never creates the database (review note, round 4).
  const repository = openForReading(options, log);
  if (repository === undefined) {
    return undefined;
  }
  try {
    const state = await requireInitialized(repository, log);
    if (state === undefined) {
      return undefined;
    }
    for (const item of [...state.roadmap].sort((a, b) => a.order - b.order)) {
      log(`${String(item.order).padStart(2)}. ${safe(item.key).padEnd(26)} ${item.status.padEnd(26)} ${safe(item.title)}`);
      if (item.humanActionRequired !== undefined) {
        log(`    human: ${safe(item.humanActionRequired)}`);
      }
      /**
       * The blocker's REASON and DETAIL, from the open escalation.
       *
       * TASK-009 AC-10 claims the information needed to resume a blocked item is
       * recoverable from this command alone. It was not: the detail — spec path,
       * branch, commit — lived only in the escalation record, which `roadmap`
       * never printed. The information was durable but invisible, which is not
       * the same thing as recoverable. The independent review caught the claim.
       */
      const open = state.escalations.find((entry) => entry.roadmapKey === item.key && !entry.resolved);
      if (open !== undefined) {
        log(`    reason: ${open.reason}`);
        if (open.detail.length > 0) {
          log(`    detail: ${safe(open.detail)}`);
        }
      }
    }
    return state;
  } finally {
    repository.close();
  }
}
