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

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
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
import { reconcileRoadmapWithCatalog } from "../supervision/roadmapCatalog.js";
import { DEFAULT_ROADMAP } from "../supervision/supervisorTypes.js";
import { verifyAgainstAnchor } from "../supervision/provenanceChain.js";
import { createSqlitePlanRepository } from "../adapters/planning/sqlitePlanRepository.js";
import {
  createChildPlanAdvancer,
  createChildPlanStateReader,
} from "../adapters/supervision/childPlanAdvancer.js";
import { DEFAULT_PLANS_DB_PATH } from "./plan.js";
import {
  createPlanBackedExecutor,
  type PlanAdvancer,
  type PlanStateReader,
  type RoadmapPlanLookup,
} from "../supervision/planBackedExecutor.js";
import { SupervisorService, type TickResult } from "../supervision/supervisorService.js";
import type { WorkExecutor } from "../supervision/supervisorPorts.js";
import { ESCALATION_REASONS, type EscalationReason, type SupervisorState } from "../supervision/supervisorTypes.js";
import { systemClock } from "../ports/clock.js";

const DEFAULT_SUPERVISOR_DB_PATH = ".factory/supervisor.db";

export interface SuperviseCliOptions {
  readonly supervisorDbPath?: string;
  readonly log?: (line: string) => void;
  /**
   * Permission to LAUNCH — `--drive-plans` (round-2 finding 2).
   *
   * This replaced `--plan-config`, and the replacement is the fix rather than a
   * rename. That flag named a configuration FILE, from which the supervisor
   * built its own planning stack in its own process: an AI execution path inside
   * the supervisor (TASK-011 AC-1/AC-11), and one that could drive a plan with
   * verification commands and worker models its approval never covered, because
   * every other `sf plan` command builds from the plan's PERSISTED config.
   *
   * There is now nothing to configure. Driving means running `sf plan resume` as
   * a child process, and that child reads the plan's own stored configuration.
   * What remains is a decision — may this supervisor spend? — so what remains is
   * a boolean, and its default is no.
   */
  readonly drivePlans?: boolean;
  /**
   * Which approved plan serves which roadmap item, declared by a human.
   *
   * NOT a convention derived from the plan's intent text. A plan's `requestKey`
   * comes from the human's goal and carries no roadmap linkage, so any
   * automatic binding would be a guess this layer invented. Binding an approved
   * plan to a roadmap item is a decision that belongs beside the approval
   * itself, which C1 already reserves to a person.
   *
   * Shape: `{ "EXECUTOR_WIRING": "plan-abc123" }`.
   */
  readonly roadmapPlansPath?: string;
  /** Where the plans database lives; defaults as `sf plan` does. */
  readonly plansDbPath?: string;
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
 * Which approved plan serves which roadmap item, read from the file a human
 * declared it in.
 *
 * Nothing here can approve a plan. Approval is `PLAN_APPROVAL`, a protected gate
 * under C1, and this path holds no `TrustedHumanToken`.
 */
/** Bounds on the operator's bindings file. Generous, and finite. */
const MAX_BINDINGS_BYTES = 64 * 1024;
const MAX_BINDINGS_ENTRIES = 100;
const MAX_PLAN_ID_LENGTH = 200;

function readRoadmapPlanBindings(path: string): Readonly<Record<string, string>> {
  const resolved = resolve(path);
  /**
   * BOUNDED BEFORE IT IS PARSED (round-2 binding assessment).
   *
   * `JSON.parse` on an arbitrarily large file is an arbitrarily large
   * allocation, and this file is operator input read at the start of every
   * tick. Checking the size first costs one `stat`.
   */
  const size = statSync(resolved).size;
  if (size > MAX_BINDINGS_BYTES) {
    throw new Error(
      `--roadmap-plans "${path}" is ${size} bytes; the limit is ${MAX_BINDINGS_BYTES}`,
    );
  }

  const raw = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`--roadmap-plans "${path}" must be a JSON object of roadmapKey -> planId`);
  }

  const entries = Object.entries(raw);
  if (entries.length > MAX_BINDINGS_ENTRIES) {
    throw new Error(
      `--roadmap-plans "${path}" declares ${entries.length} bindings; the limit is ${MAX_BINDINGS_ENTRIES}`,
    );
  }

  const declared = new Set(DEFAULT_ROADMAP.map((item) => item.key));
  const bindings: Record<string, string> = {};
  for (const [key, value] of entries) {
    /**
     * AN UNKNOWN ROADMAP KEY IS A MISTAKE, NOT A NO-OP.
     *
     * Round-2 review pointed out that this accepted any key. A typo bound
     * nothing and said nothing: the operator saw a successful tick and
     * concluded their plan was wired, when in fact the item they meant was
     * still reporting that it needs a plan. Refusing names the typo.
     */
    if (!declared.has(key)) {
      throw new Error(
        `--roadmap-plans entry ${JSON.stringify(safe(key))} is not a roadmap key this installation declares`,
      );
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`--roadmap-plans entry "${key}" must be a non-empty plan id`);
    }
    /**
     * Surrounding whitespace is refused rather than trimmed. A trimmed id would
     * silently mean something different from what the file says, and the whole
     * point of this file is that a human declared exactly which plan serves
     * which item.
     */
    if (value !== value.trim()) {
      throw new Error(`--roadmap-plans entry "${key}" has surrounding whitespace in its plan id`);
    }
    if (value.length > MAX_PLAN_ID_LENGTH) {
      throw new Error(`--roadmap-plans entry "${key}" has a plan id longer than ${MAX_PLAN_ID_LENGTH} characters`);
    }
    bindings[key] = value;
  }
  return bindings;
}

interface SupervisorExecutorWiring {
  readonly executor: WorkExecutor;
  close(): void;
}

/**
 * THE EXECUTOR THE SHIPPED CLI WIRES IN (TASK-014 AC-1).
 *
 * `createUnimplementedExecutor` used to live here and answered every roadmap
 * item with `HUMAN_REQUIRED / AUTHOR_PLAN`. That was honest when nothing
 * connected the queue to TASK-005 planning, and it is not honest any more.
 *
 * FINDING A PLAN AND DRIVING ONE ARE SEPARATE CAPABILITIES, and separating them
 * was forced by evidence rather than taste. They were one option, so a
 * supervisor could not look up a plan without the entire planning stack. That
 * made the unconfigured and stub behaviours observationally IDENTICAL, and
 * round-1 review proved the consequence: a mutation that constructed the real
 * executor, discarded it, and returned the old stub passed every test. Nothing
 * could distinguish them because nothing could reach a configuration where they
 * differ.
 *
 * So `--roadmap-plans` (with the plans database) is enough to FIND a plan and
 * report its real state — blocked, awaiting approval, running — which is already
 * something no stub can do. `--drive-plans` is additionally required to LAUNCH
 * one, and launching happens in a CHILD PROCESS running `sf plan resume`
 * (TASK-011 AC-1). The supervisor's own process never contains the engineering
 * loop or an AI worker.
 */
function createSupervisorExecutor(
  options: SuperviseCliOptions,
  log: (line: string) => void,
): SupervisorExecutorWiring {
  const closers: (() => void)[] = [];

  let lookup: RoadmapPlanLookup = {
    async findPlanForItem() {
      return undefined;
    },
  };
  let planning: PlanAdvancer | undefined;
  let state: PlanStateReader | undefined;

  if (options.roadmapPlansPath !== undefined) {
    const bindings = readRoadmapPlanBindings(options.roadmapPlansPath);
    /**
     * RESOLVED ONCE, and shared by everything that touches plans.
     *
     * Round-2 finding 1 named the drift: the lookup resolved a plans database
     * here while the planning stack resolved its own, so a supervisor could read
     * a plan from one database and advance a plan in another. The same resolved
     * string now feeds the lookup AND is handed to the child process in its
     * environment, so there is one path and no way for the two to disagree.
     */
    const plansDbPath = resolve(
      options.plansDbPath ?? process.env["FACTORY_PLANS_DB_PATH"] ?? DEFAULT_PLANS_DB_PATH,
    );
    mkdirSync(dirname(plansDbPath), { recursive: true });
    const plans = createSqlitePlanRepository(plansDbPath);
    closers.push(() => plans.close());
    lookup = {
      async findPlanForItem(item) {
        const planId = bindings[item.key];
        return planId === undefined ? undefined : plans.findById(planId);
      },
    };

    /**
     * THE AUTHORITY-CHECKED READ IS ALWAYS WIRED (round-3 finding 1).
     *
     * It runs `sf plan status`, which launches no worker and spends nothing, so
     * there is no reason to gate it behind `--drive-plans` — and every reason
     * not to. A supervisor that can only READ must still be unable to certify a
     * completion it cannot verify, which is exactly the configuration the
     * fabricated-row reproduction ran in.
     */
    state = createChildPlanStateReader({
      processRunner: createNodeProcessRunner(),
      plans,
      cwd: process.cwd(),
      plansDbPath,
      log,
    });

    if (options.drivePlans === true) {
      planning = createChildPlanAdvancer({
        processRunner: createNodeProcessRunner(),
        plans,
        cwd: process.cwd(),
        plansDbPath,
        log,
      });
    }
  } else if (options.drivePlans === true) {
    /**
     * REFUSED LOUDLY rather than silently doing nothing.
     *
     * Driving needs a plan to drive, and only `--roadmap-plans` says which plan
     * serves which roadmap item. An operator who asked for driving and got a
     * supervisor that quietly never drives anything would reasonably conclude
     * the feature works and nothing was ready.
     */
    throw new Error("--drive-plans also needs --roadmap-plans: there is no plan to drive without a binding");
  }

  return {
    executor: createPlanBackedExecutor({
      plans: lookup,
      ...(planning === undefined ? {} : { planning }),
      ...(state === undefined ? {} : { state }),
      clock: systemClock,
      log,
    }),
    close(): void {
      for (const close of closers.reverse()) {
        close();
      }
    },
  };
}

function buildService(
  repository: SqliteSupervisorRepository,
  log: (line: string) => void,
  executor: WorkExecutor,
): SupervisorService {
  return new SupervisorService({
    repository,
    probe: createCliResourceProbe({ processRunner: createNodeProcessRunner(), cwd: process.cwd() }),
    executor,
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

  /**
   * Recording a blocker NEVER executes work, so it opens no planning wiring at
   * all (round-2 finding 4). The previous version opened the plans database and
   * possibly the whole planning stack to record a note, which is both wasteful
   * and a second way to fail before the `try`.
   *
   * `buildService` still needs an executor, so it gets one that refuses: if the
   * blocker path ever did reach execution, it must fail loudly rather than run
   * work through a command that is not supposed to.
   */
  const refuseToExecute: WorkExecutor = {
    async execute() {
      throw new Error("sf supervise block does not execute work");
    },
  };
  let repository: SqliteSupervisorRepository | undefined;
  try {
    repository = openRepository(options);
    const service = buildService(repository, log, refuseToExecute);
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
    repository?.close();
  }
}

export async function runSuperviseTick(options: SuperviseCliOptions = {}): Promise<TickResult> {
  const log = options.log ?? ((line: string): void => console.log(line));
  /**
   * EVERY handle is opened inside the `try` (round-2 finding 4).
   *
   * Both were constructed BEFORE it, so a throw from the second -- a missing
   * bindings file, a malformed plan config -- left the first open. The reviewer
   * reproduced exactly that: `rejected ENOENT` with supervisor.db, its WAL and
   * its SHM still in `open_fds`. A CLI that leaks a database handle on a
   * configuration typo is a CLI that eventually cannot reopen its own state.
   */
  let repository: SqliteSupervisorRepository | undefined;
  let wiring: SupervisorExecutorWiring | undefined;
  try {
    repository = openRepository(options);
    wiring = createSupervisorExecutor(options, log);
    const result = await buildService(repository, log, wiring.executor).tick();
    describeTick(result, log);
    return result;
  } finally {
    wiring?.close();
    repository?.close();
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

    /**
     * TASK-008 AC-8: say what this is, where an operator actually reads it.
     *
     * "tamper-evident" is printed on the same line as the verdict, not buried
     * in a source comment, because the failure mode being guarded against is a
     * reader who sees "intact" and concludes the history cannot have been
     * changed. It can — by anyone who recomputes the chain. What "intact" means
     * is that nobody edited it WITHOUT recomputing.
     */
    /**
     * VERIFIED AGAINST THE ANCHOR, not merely internally consistent (round-8
     * HIGH).
     *
     * `verifyChain` asks whether every link still hashes to its successor. Tail
     * TRUNCATION leaves that perfectly true — the reviewer removed the second
     * of two entries from real SQLite and this line reported "1 entries, chain
     * intact". The anchor is the only record that knows how long the chain was
     * and what its head was, which is precisely why it exists, and the status
     * command is where an operator looks to find out.
     */
    const chain = verifyAgainstAnchor(state.provenance, state.provenanceAnchor);
    log(
      `provenance     : ${state.provenance.length} entries, ${
        chain.intact ? "chain intact" : `CHAIN BROKEN — ${safe(chain.problem)}`
      } (tamper-evident, not tamper-proof)`,
    );

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
    /**
     * RECONCILED BEFORE IT IS PRINTED (round-9 HIGH).
     *
     * This command read `state.roadmap` and printed it, so a forged title or
     * order was displayed as fact — the reviewer wrote "999. LOCAL_24_7_RUNTIME
     * FORGED DATABASE TITLE" into the database and read it straight back out of
     * the tool an operator uses to check the roadmap.
     *
     * The tick refuses such a state, which is the important half; but a public
     * read path that presents the row as the definition undoes the point of
     * having a catalog. Where the two disagree this reports the disagreement and
     * prints the CATALOG's definition, because that is the one that decides
     * anything.
     */
    const reconciliation = reconcileRoadmapWithCatalog(state.roadmap, DEFAULT_ROADMAP);
    if (!reconciliation.ok) {
      log("");
      log(`!! THE PERSISTED ROADMAP DISAGREES WITH THIS INSTALLATION'S CATALOG`);
      log(`!! ${safe(reconciliation.problem)}`);
      log(`!! The definitions below are the CATALOG's. The supervisor will not act on this database`);
      log(`!! until it is restored; nothing here is evidence about what the persisted rows say.`);
      log("");
    }
    const progressByKey = new Map(state.roadmap.map((item) => [item.key, item]));
    const displayed = reconciliation.ok
      ? reconciliation.roadmap
      : DEFAULT_ROADMAP.map((declared) => {
          const progress = progressByKey.get(declared.key);
          return progress === undefined ? declared : { ...progress, ...declared, status: progress.status };
        });
    for (const item of [...displayed].sort((a, b) => a.order - b.order)) {
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
