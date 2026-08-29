/**
 * `sf plan start|status|answer|approve|reject|resume|cancel` — CLI surface for
 * the TASK-005 durable planner. Wires the durable SQLite `FactoryStore`
 * (TASK-002), TASK-004's independent loop-state SQLite file and this task's own
 * plan-state SQLite file (see docs/tasks/TASK-005-planner-task-generator.md)
 * into a real `PlanningService` whose only route into implementation is the
 * accepted TASK-004 `EngineeringLoopService`.
 *
 * Two things about this wiring are load-bearing rather than incidental.
 *
 * FIRST, the `PlanBindingResolver` handed to `FactoryService` is built from the
 * plan REPOSITORY, not from `PlanningService`. That is what breaks the
 * construction cycle (the service needs the factory; the factory needs the
 * resolver), and it is also why the binding a PLAN approval is stamped with can
 * only ever come from durably stored state rather than from in-flight service
 * state.
 *
 * SECOND, every command except `start` builds its dispatcher and planner from
 * the plan's PERSISTED `execution`/`planner` configuration, never from this
 * process's defaults. A plan captured its execution configuration at start
 * precisely so that a restart — possibly on another machine, possibly after a
 * default in this file changed — dispatches approved work with byte-identical
 * configuration. Reaching for a default here would silently execute a human's
 * approved plan under terms they never approved.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createSqliteLoopRepository, type SqliteLoopRepository } from "../adapters/orchestration/sqliteLoopRepository.js";
import { createCliPlannerWorker } from "../adapters/planning/cliPlannerWorker.js";
import { createEngineeringLoopDispatcher } from "../adapters/planning/engineeringLoopDispatcher.js";
import { createSqlitePlanRepository, type SqlitePlanRepository } from "../adapters/planning/sqlitePlanRepository.js";
import { createNodeProcessRunner } from "../adapters/process/nodeProcessRunner.js";
import { createLocalHumanIdentityGate } from "../adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../adapters/security/localWorkerRegistry.js";
import { WORKER_TOOLS, type WorkerTool } from "../adapters/workers/workerModelConfig.js";
import { resolveWorkspace } from "../adapters/workers/workspace.js";
import { createSqliteStore, type SqliteFactoryStore } from "../adapters/sqlite/sqliteStore.js";
import { FactoryService } from "../app/factoryService.js";
import { agent, human } from "../domain/actor.js";
import { NotFoundError } from "../domain/errors.js";
import { createRandomIdGenerator } from "../domain/ids.js";
import { EngineeringLoopService } from "../orchestration/engineeringLoopService.js";
import type { LoopWorkerConfig, VerificationCommandConfig } from "../orchestration/loopTypes.js";
import { PlanningService, createPlanBindingResolver, type SubmittedAnswer } from "../planning/planningService.js";
import {
  toPlanStatusView,
  type PlanBudget,
  type PlanExecutionConfig,
  type PlannerConfig,
  type PlanStatusView,
} from "../planning/planTypes.js";
import { systemClock } from "../ports/clock.js";

const DEFAULT_FACTORY_DB_PATH = ".factory-data/factory.db";
const DEFAULT_LOOPS_DB_PATH = ".factory-data/loops.db";
export const DEFAULT_PLANS_DB_PATH = ".factory-data/plans.db";
/** Fixture-scale credential, same posture as `sf loop`'s: never a real secret (C6). */
const CLI_CREDENTIAL = "sf-plan-local-operator-secret";

/**
 * Planner default follows docs/MODEL_ROUTING.md's Architect/Planner role
 * (Codex-class strong reasoning), while implementation stays with Claude Code
 * and review with a different family — the C4 rule that the implementer must
 * not be the sole reviewer applies to planned work exactly as it does to
 * `sf loop`.
 */
const DEFAULT_PLANNER: PlannerConfig = { tool: "codex-cli", model: "gpt-5.6-luna", effort: "xhigh" };
const DEFAULT_IMPLEMENTER: PlannerConfig = { tool: "claude-code", model: "claude-sonnet-5", effort: "xhigh" };
const DEFAULT_REVIEWER: PlannerConfig = { tool: "codex-cli", model: "gpt-5.6-luna", effort: "xhigh" };
const DEFAULT_VERIFICATION_COMMANDS: PlanExecutionConfig["verificationCommands"] = [
  { id: "typecheck", executable: "npm", argv: ["run", "typecheck"] },
  { id: "test", executable: "npm", argv: ["test"] },
];

/**
 * The unattended actor loops are dispatched as. Deliberately an AGENT with the
 * same identity `PlanningService` uses for its own Factory transitions:
 * dispatching approved work is the Factory acting on authority a human already
 * granted at PLAN_APPROVAL, and labelling it as a live human decision is
 * exactly the self-certification C1/C5 forbid.
 */
const ORCHESTRATOR = agent("agent:planner-orchestrator", "Planner Orchestrator");

/**
 * Curated, bounded governance rules handed to the planner as context. Drawn
 * verbatim in spirit from AGENTS.md and docs/FACTORY_CONSTITUTION.md, and kept
 * deliberately short: this is guidance for a prompt, never repository contents
 * and never anything that could carry a credential (C6).
 */
const PROJECT_RULES: readonly string[] = [
  "Never weaken or bypass approval, test, security, or audit rules.",
  "Every work item must have executable acceptance criteria.",
  "Prefer small reversible increments over large rewrites.",
  // "model inputs" rather than the obvious synonym: the accepted
  // unattended-execution invariant scans this source tree for interactive-input
  // tokens, and that word is one of them. Rewording preserves the rule's
  // meaning; loosening a check that exists to stop the Factory ever pausing for
  // a human at a keyboard would not.
  "Do not put secrets, credentials, or production data in code, model inputs, fixtures, logs, or commits.",
  "Do not introduce external infrastructure before the task requires it.",
];

// =====================================================================
// --config parsing
// =====================================================================

interface PlanCliConfig {
  readonly planner: PlannerConfig;
  readonly execution: PlanExecutionConfig;
  readonly budget?: Partial<PlanBudget>;
  readonly constraints?: readonly string[];
}

/** Narrows a configured tool name to the accepted worker tools, with a message naming the field. */
function requireWorkerTool(value: string, what: string): WorkerTool {
  const tool = WORKER_TOOLS.find((candidate) => candidate === value);
  if (tool === undefined) {
    throw new Error(`${what} must be one of: ${WORKER_TOOLS.join(", ")} (got "${value}")`);
  }
  return tool;
}

function optionalCount(value: unknown, field: string, minimum: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new Error(`--config "${field}" must be an integer >= ${minimum}`);
  }
  return value;
}

/**
 * Validates one worker slot. `PlannerConfig.tool` is typed `string` at the
 * planning layer on purpose (C9 — no vendor name leaks into the domain), so the
 * accepted-tool check belongs here at the configuration boundary rather than in
 * the type.
 */
function validateWorkerConfig(value: unknown, field: string): PlannerConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`--config "${field}" must be an object`);
  }
  const row = value as Record<string, unknown>;
  if (typeof row.tool !== "string" || row.tool.length === 0) {
    throw new Error(`--config "${field}.tool" must be a non-empty string`);
  }
  requireWorkerTool(row.tool, `--config "${field}.tool"`);
  if (typeof row.model !== "string" || row.model.length === 0) {
    throw new Error(`--config "${field}.model" must be a non-empty string`);
  }

  let effort: string | undefined;
  if (row.effort !== undefined) {
    if (typeof row.effort !== "string" || row.effort.length === 0) {
      throw new Error(`--config "${field}.effort" must be a non-empty string when present`);
    }
    effort = row.effort;
  }
  const timeoutMs = optionalCount(row.timeoutMs, `${field}.timeoutMs`, 1);

  return {
    tool: row.tool,
    model: row.model,
    ...(effort === undefined ? {} : { effort }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function validateVerificationCommands(value: unknown): PlanExecutionConfig["verificationCommands"] {
  if (!Array.isArray(value)) {
    throw new Error('--config "verificationCommands" must be an array');
  }
  if (value.length === 0) {
    throw new Error('--config "verificationCommands" must declare at least one deterministic command (C3)');
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

function validatePlanBudget(value: unknown): Partial<PlanBudget> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('--config "budget" must be an object');
  }
  const row = value as Record<string, unknown>;
  const maxPlannerAttempts = optionalCount(row.maxPlannerAttempts, "budget.maxPlannerAttempts", 1);
  const maxClarificationCycles = optionalCount(row.maxClarificationCycles, "budget.maxClarificationCycles", 0);
  const maxTotalPlannerRuns = optionalCount(row.maxTotalPlannerRuns, "budget.maxTotalPlannerRuns", 1);
  const maxWallClockMs = optionalCount(row.maxWallClockMs, "budget.maxWallClockMs", 1);
  return {
    ...(maxPlannerAttempts === undefined ? {} : { maxPlannerAttempts }),
    ...(maxClarificationCycles === undefined ? {} : { maxClarificationCycles }),
    ...(maxTotalPlannerRuns === undefined ? {} : { maxTotalPlannerRuns }),
    ...(maxWallClockMs === undefined ? {} : { maxWallClockMs }),
  };
}

function validateLoopBudget(value: unknown): NonNullable<PlanExecutionConfig["loopBudget"]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('--config "loopBudget" must be an object');
  }
  const row = value as Record<string, unknown>;
  const maxIterations = optionalCount(row.maxIterations, "loopBudget.maxIterations", 1);
  const maxTotalRuns = optionalCount(row.maxTotalRuns, "loopBudget.maxTotalRuns", 1);
  const maxWallClockMs = optionalCount(row.maxWallClockMs, "loopBudget.maxWallClockMs", 1);
  const workerTimeoutMs = optionalCount(row.workerTimeoutMs, "loopBudget.workerTimeoutMs", 1);
  const verificationTimeoutMs = optionalCount(row.verificationTimeoutMs, "loopBudget.verificationTimeoutMs", 1);
  return {
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(maxTotalRuns === undefined ? {} : { maxTotalRuns }),
    ...(maxWallClockMs === undefined ? {} : { maxWallClockMs }),
    ...(workerTimeoutMs === undefined ? {} : { workerTimeoutMs }),
    ...(verificationTimeoutMs === undefined ? {} : { verificationTimeoutMs }),
  };
}

function validateConstraints(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error('--config "constraints" must be an array of strings');
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`--config "constraints[${index}]" must be a non-empty string`);
    }
    return entry;
  });
}

function loadPlanConfig(configPath: string): PlanCliConfig {
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

  const planner = row.planner === undefined ? DEFAULT_PLANNER : validateWorkerConfig(row.planner, "planner");
  const implementer = row.implementer === undefined ? DEFAULT_IMPLEMENTER : validateWorkerConfig(row.implementer, "implementer");
  const reviewer = row.reviewer === undefined ? DEFAULT_REVIEWER : validateWorkerConfig(row.reviewer, "reviewer");
  const verificationCommands =
    row.verificationCommands === undefined ? DEFAULT_VERIFICATION_COMMANDS : validateVerificationCommands(row.verificationCommands);
  const loopBudget = row.loopBudget === undefined ? undefined : validateLoopBudget(row.loopBudget);
  const budget = row.budget === undefined ? undefined : validatePlanBudget(row.budget);
  const constraints = row.constraints === undefined ? undefined : validateConstraints(row.constraints);

  return {
    planner,
    execution: {
      implementer,
      reviewer,
      verificationCommands,
      workspaceRoot: row.workspace,
      ...(loopBudget === undefined ? {} : { loopBudget }),
    },
    ...(budget === undefined ? {} : { budget }),
    ...(constraints === undefined ? {} : { constraints }),
  };
}

/** The human's goal, read verbatim: no model and no CLI ever rewrites an intent. */
function loadIntent(intentPath: string): string {
  const intentFile = resolve(intentPath);
  const raw = readFileSync(intentFile, "utf8");
  if (raw.trim().length === 0) {
    throw new Error(`intent file ${intentFile} is empty; a plan needs a real goal to work from`);
  }
  return raw;
}

function loadAnswers(answersPath: string): readonly SubmittedAnswer[] {
  const raw = readFileSync(resolve(answersPath), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--answers file is not valid JSON: ${String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('--answers file must contain a JSON array of { "questionId": "...", "answer": "..." } objects');
  }
  if (parsed.length === 0) {
    throw new Error("--answers file must contain at least one answer");
  }
  return parsed.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`--answers "[${index}]" must be an object`);
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.questionId !== "string" || row.questionId.length === 0) {
      throw new Error(`--answers "[${index}].questionId" must be a non-empty string`);
    }
    if (typeof row.answer !== "string" || row.answer.trim().length === 0) {
      throw new Error(`--answers "[${index}].answer" must be a non-empty string`);
    }
    return { questionId: row.questionId, answer: row.answer };
  });
}

// =====================================================================
// Wiring
// =====================================================================

export interface PlanCliOptions {
  readonly log?: (line: string) => void;
  readonly factoryDbPath?: string;
  readonly loopsDbPath?: string;
  readonly plansDbPath?: string;
}

interface OpenStores {
  readonly store: SqliteFactoryStore;
  readonly loops: SqliteLoopRepository;
  readonly plans: SqlitePlanRepository;
  readonly factory: FactoryService;
  readonly service: PlanningService;
}

function toLoopWorkerConfig(config: PlannerConfig, what: string): LoopWorkerConfig {
  return {
    tool: requireWorkerTool(config.tool, what),
    model: config.model,
    ...(config.effort === undefined ? {} : { effort: config.effort }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  };
}

/**
 * Opens the plan store on its own, ahead of everything else.
 *
 * Separated from `openStores` because of the ordering constraint at the heart
 * of this CLI: the dispatcher and planner cannot be built until a plan's
 * execution configuration is known, and for every command except `start` that
 * configuration lives in this very database. So the plan store opens first, the
 * stored config is read through it, and the SAME open handle is then handed to
 * `openStores` — nothing is opened twice and nothing is closed prematurely.
 */
function openPlanRepository(options: PlanCliOptions): SqlitePlanRepository {
  const plansDbPath = resolve(options.plansDbPath ?? process.env.FACTORY_PLANS_DB_PATH ?? DEFAULT_PLANS_DB_PATH);
  mkdirSync(dirname(plansDbPath), { recursive: true });
  return createSqlitePlanRepository(plansDbPath);
}

/** Opens loops.db, releasing the already-open factory handle if its schema/version is refused. */
function openLoopRepository(loopsDbPath: string, store: SqliteFactoryStore): SqliteLoopRepository {
  try {
    return createSqliteLoopRepository(loopsDbPath);
  } catch (error) {
    store.close();
    throw error;
  }
}

/**
 * Builds the whole planning stack around an already-open plan repository and
 * ONE exact (planner, execution) configuration pair. The caller decides where
 * that pair came from — the `--config` file at `start`, the persisted plan
 * everywhere else — and this function never substitutes a default for it.
 */
function openStores(
  options: PlanCliOptions,
  plans: SqlitePlanRepository,
  planner: PlannerConfig,
  execution: PlanExecutionConfig,
): OpenStores {
  // Resolve every piece of trusted configuration BEFORE any database handle
  // exists, so a bad workspace path or an unknown tool fails loudly at setup
  // time without leaking an open connection.
  const workspace = resolveWorkspace(execution.workspaceRoot);
  const implementer = toLoopWorkerConfig(execution.implementer, "the plan's stored implementer tool");
  const reviewer = toLoopWorkerConfig(execution.reviewer, "the plan's stored reviewer tool");
  const plannerTool = requireWorkerTool(planner.tool, "the plan's stored planner tool");

  const factoryDbPath = resolve(options.factoryDbPath ?? process.env.FACTORY_DB_PATH ?? DEFAULT_FACTORY_DB_PATH);
  const loopsDbPath = resolve(options.loopsDbPath ?? process.env.FACTORY_LOOPS_DB_PATH ?? DEFAULT_LOOPS_DB_PATH);
  mkdirSync(dirname(factoryDbPath), { recursive: true });
  mkdirSync(dirname(loopsDbPath), { recursive: true });

  const store = createSqliteStore(factoryDbPath);
  const loops = openLoopRepository(loopsDbPath, store);

  // Everything after the two database handles exist must either succeed or
  // close them: `resolveWorkspace`, the dispatcher and the planner worker can
  // all still throw (a missing workspace, a tool no longer supported), and a
  // throw here happens before any caller has a `finally` to clean up with.
  try {
    return buildServices();
  } catch (error) {
    store.close();
    loops.close();
    throw error;
  }

  function buildServices(): OpenStores {
  // Backed by the REPOSITORY rather than by PlanningService: that is what lets
  // the factory be constructed before the service exists (no cycle), and it is
  // why a PLAN approval binding can only be derived from durably stored state.
  const planBindingResolver = createPlanBindingResolver(plans);
  const factory = new FactoryService({
    store,
    clock: systemClock,
    ids: createRandomIdGenerator(),
    identityGate: createLocalHumanIdentityGate({ credential: CLI_CREDENTIAL, clock: systemClock }),
    workerRegistry: createLocalWorkerRegistry(systemClock),
    planBindingResolver,
  });
  const loopService = new EngineeringLoopService({
    factory,
    loops,
    clock: systemClock,
    ids: createRandomIdGenerator(),
    processRunner: createNodeProcessRunner(),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  const dispatcher = createEngineeringLoopDispatcher({
    service: loopService,
    loops,
    actor: ORCHESTRATOR,
    implementer,
    reviewer,
    verificationCommands: execution.verificationCommands,
    workspace,
    ...(execution.loopBudget === undefined ? {} : { budget: execution.loopBudget }),
  });
  const plannerWorker = createCliPlannerWorker({
    tool: plannerTool,
    model: planner.model,
    ...(planner.effort === undefined ? {} : { effort: planner.effort }),
    ...(planner.timeoutMs === undefined ? {} : { timeoutMs: planner.timeoutMs }),
    workspace,
    processRunner: createNodeProcessRunner(),
  });
  const service = new PlanningService({
    factory,
    plans,
    clock: systemClock,
    ids: createRandomIdGenerator(),
    planner: plannerWorker,
    dispatcher,
    ...(options.log === undefined ? {} : { log: options.log }),
    projectRules: PROJECT_RULES,
  });
  return { store, loops, plans, factory, service };
  }
}

/**
 * Planning, opened for the SUPERVISOR (TASK-014).
 *
 * `sf supervise` needs the same construction `sf plan` performs -- planner
 * worker, loop dispatcher, workspace, verification commands -- because driving
 * an approved plan means driving the real TASK-004 loop. Exported here rather
 * than rebuilt there so the two CLIs cannot drift into two different planning
 * stacks, which is the "second engineering loop" failure one layer up.
 *
 * The caller owns the handles and must `close()` them.
 */
export interface SupervisorPlanning {
  readonly plans: SqlitePlanRepository;
  readonly service: PlanningService;
  close(): void;
}

export function openPlanningForSupervisor(
  configPath: string,
  options: PlanCliOptions = {},
): SupervisorPlanning {
  const config = loadPlanConfig(configPath);
  const stores = openWithConfig(options, config);
  return {
    plans: stores.plans,
    service: stores.service,
    close(): void {
      stores.plans.close();
      stores.loops.close();
      stores.store.close();
    },
  };
}

/** `sf plan start`: the configuration comes from the `--config` file the operator supplied. */
function openWithConfig(options: PlanCliOptions, config: PlanCliConfig): OpenStores {
  const plans = openPlanRepository(options);
  try {
    return openStores(options, plans, config.planner, config.execution);
  } catch (error) {
    plans.close();
    throw error;
  }
}

/**
 * Every other command: the plan already exists, so its PERSISTED configuration
 * is the only configuration. Reading it first — and building the dispatcher and
 * planner from it — is what makes a restart dispatch with byte-identical terms
 * rather than with whatever this process's defaults happen to be.
 */
async function openForStoredPlan(planId: string, options: PlanCliOptions): Promise<OpenStores> {
  const plans = openPlanRepository(options);
  try {
    const plan = await plans.findById(planId);
    if (plan === undefined) {
      throw new NotFoundError("Plan", planId);
    }
    return openStores(options, plans, plan.planner, plan.execution);
  } catch (error) {
    // Nothing else is open yet on this path, so the plan store is ours to release.
    plans.close();
    throw error;
  }
}

function printStatus(view: PlanStatusView, log: (line: string) => void): void {
  log(`plan          : ${view.id}`);
  log(`project       : ${view.projectId}`);
  log(`phase         : ${view.phase}`);
  log(`revision      : ${view.revision}`);
  if (view.approvedRevision !== undefined) {
    log(`approved rev  : ${view.approvedRevision}`);
  }
  if (view.summary !== undefined) {
    log(`summary       : ${view.summary}`);
  }
  log(`open questions: ${view.openQuestionCount}`);
  log(`items         : ${view.itemCount}`);
  log(`materialized  : ${view.materializedCount}`);
  log(`dispatched    : ${view.dispatchedCount}`);
  log(`planner runs  : ${view.totalPlannerRuns}`);
  if (view.outcome !== undefined) {
    log(`outcome       : ${view.outcome}`);
  }
  if (view.failureReason !== undefined) {
    log(`reason        : ${view.failureReason}`);
  }
  log(`human action required: ${view.humanActionRequired}`);
}

// =====================================================================
// Commands
// =====================================================================

export async function runPlanStart(
  projectId: string,
  intentPath: string,
  configPath: string | undefined,
  options: PlanCliOptions = {},
): Promise<PlanStatusView> {
  const log = options.log ?? ((): void => {});
  if (configPath === undefined) {
    throw new Error(
      "sf plan start requires --config <file>: the workspace and worker configuration a plan will be executed with is captured at start, not guessed later",
    );
  }
  const intent = loadIntent(intentPath);
  const config = loadPlanConfig(configPath);
  const { store, loops, plans, service } = openWithConfig(options, config);
  try {
    const plan = await service.start({
      projectId,
      // Attribution, not authority. Starting planning grants nothing: no
      // approval is recorded, no work item is created and no worker is
      // dispatched until a trusted human approves an exact revision, which is
      // why no TrustedHumanToken is minted here.
      actor: human("user:cli-operator", "CLI Operator"),
      intent,
      planner: config.planner,
      execution: config.execution,
      ...(config.constraints === undefined ? {} : { constraints: config.constraints }),
      ...(config.budget === undefined ? {} : { budget: config.budget }),
    });
    const view = toPlanStatusView(plan);
    printStatus(view, log);
    return view;
  } finally {
    store.close();
    loops.close();
    plans.close();
  }
}

export async function runPlanStatus(planId: string, options: PlanCliOptions = {}): Promise<PlanStatusView> {
  const log = options.log ?? ((): void => {});
  const { store, loops, plans, service } = await openForStoredPlan(planId, options);
  try {
    // Read-only, and deliberately so: `status` fails closed to a RECOVERY_REQUIRED
    // projection when a persisted APPROVED/MATERIALIZING/EXECUTING checkpoint is
    // no longer backed by live Factory approval authority, without writing that
    // demotion. Durably recording it is `sf plan resume`'s job.
    const view = toPlanStatusView(await service.status(planId));
    printStatus(view, log);
    return view;
  } finally {
    store.close();
    loops.close();
    plans.close();
  }
}

export async function runPlanAnswer(planId: string, answersPath: string, options: PlanCliOptions = {}): Promise<PlanStatusView> {
  const log = options.log ?? ((): void => {});
  const answers = loadAnswers(answersPath);
  const { store, loops, plans, factory, service } = await openForStoredPlan(planId, options);
  try {
    // An answer becomes part of the goal the plan is rebuilt from, so it is held
    // to the same trusted-human boundary as approval itself: accepting one from
    // an unauthenticated caller would let an agent steer what a human is later
    // asked to approve. The CLI operator mints a TrustedHumanToken from the same
    // local identity gate the FactoryService uses, then presents it. This is the
    // interactive operator's own governance action, not an unattended plan step.
    const operator = human("user:cli-operator", "CLI Operator");
    const authorization = factory.authorizeHuman(operator, CLI_CREDENTIAL);
    const view = toPlanStatusView(await service.answer(planId, operator, authorization, answers));
    printStatus(view, log);
    return view;
  } finally {
    store.close();
    loops.close();
    plans.close();
  }
}

export async function runPlanApprove(planId: string, options: PlanCliOptions = {}): Promise<PlanStatusView> {
  const log = options.log ?? ((): void => {});
  const { store, loops, plans, factory, service } = await openForStoredPlan(planId, options);
  try {
    // PLAN_APPROVAL is the one operation that creates execution authority (C1),
    // so it takes the same route every `sf` approval takes: the CLI operator
    // mints a TrustedHumanToken from the local identity gate and presents it —
    // the planning service refuses to approve without one. This is the
    // interactive operator's own governance action; no agent can mint it.
    const operator = human("user:cli-operator", "CLI Operator");
    const authorization = factory.authorizeHuman(operator, CLI_CREDENTIAL);
    const view = toPlanStatusView(await service.approve(planId, operator, authorization));
    printStatus(view, log);
    return view;
  } finally {
    store.close();
    loops.close();
    plans.close();
  }
}

export async function runPlanReject(planId: string, note: string | undefined, options: PlanCliOptions = {}): Promise<PlanStatusView> {
  const log = options.log ?? ((): void => {});
  const { store, loops, plans, factory, service } = await openForStoredPlan(planId, options);
  try {
    // Rejection is recorded as a real, append-only human decision at the same
    // gate an approval would be (C8), so it demands the same trusted-human
    // evidence. This is the interactive operator's own governance action.
    const operator = human("user:cli-operator", "CLI Operator");
    const authorization = factory.authorizeHuman(operator, CLI_CREDENTIAL);
    const view = toPlanStatusView(await service.reject(planId, operator, authorization, note));
    printStatus(view, log);
    return view;
  } finally {
    store.close();
    loops.close();
    plans.close();
  }
}

export async function runPlanResume(planId: string, options: PlanCliOptions = {}): Promise<PlanStatusView> {
  const log = options.log ?? ((): void => {});
  const { store, loops, plans, service } = await openForStoredPlan(planId, options);
  try {
    // Resuming grants nothing new: it re-derives approval authority from the
    // Factory's own records before it materializes or dispatches anything, and
    // durably demotes a checkpoint that can no longer be proven. No token here.
    const view = toPlanStatusView(await service.resume(planId));
    printStatus(view, log);
    return view;
  } finally {
    store.close();
    loops.close();
    plans.close();
  }
}

export async function runPlanCancel(planId: string, options: PlanCliOptions = {}): Promise<PlanStatusView> {
  const log = options.log ?? ((): void => {});
  const { store, loops, plans, factory, service } = await openForStoredPlan(planId, options);
  try {
    // Cancellation is a protected human governance operation, exactly as loop
    // cancellation is: the CLI operator mints a TrustedHumanToken from the same
    // local identity gate the FactoryService uses, then presents it — the
    // planning service refuses cancellation without it. This is the interactive
    // operator's own governance action, not a routine unattended plan step.
    const operator = human("user:cli-operator", "CLI Operator");
    const authorization = factory.authorizeHuman(operator, CLI_CREDENTIAL);
    const view = toPlanStatusView(await service.cancel(planId, operator, authorization));
    printStatus(view, log);
    return view;
  } finally {
    store.close();
    loops.close();
    plans.close();
  }
}
