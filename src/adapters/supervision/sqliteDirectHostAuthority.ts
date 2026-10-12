/**
 * PHASE7-98 retained SQLite host supplier.
 *
 * A host-only, constructor-injected adapter that binds ONE registered,
 * guarded Worker object to ONE approved, loop-current action and persists
 * that binding durably in SQLite, so a later reservation/consume/cancel
 * lifecycle can be proven across process restart.
 *
 * What this file is NOT: a new validator, a new ticket schema, or a
 * replacement authority. It composes exactly the dependencies the review
 * named:
 *
 *   - `PlanningService.verifiedApprovedExecutionSnapshot` (PHASE7-97) for the
 *     live, re-derived human-approved execution facts (ticket templates,
 *     materialized items).
 *   - `FactoryStore` for the live WorkItem/criteria shape.
 *   - `LoopRepository` for the live loop/iteration/action-claim facts (which
 *     slot, which attempt, which implementer run this iteration actually
 *     recorded).
 *   - The SAME `WorkerRegistry` the rest of the Factory uses:
 *     `principalFor(worker)` proves IDENTITY and ROLES for the exact
 *     registered object, never a model or tool — that always comes from the
 *     approved ticket template, never from `Worker.id` or capabilities.
 *   - A trusted, host-injected capability callback, validated through the
 *     existing `validateDirectLaunchCapabilityEvidence` — never a caller- or
 *     request-supplied approval.
 *   - Its own `node:sqlite` `DatabaseSync` for durable reservation/consume/
 *     cancel state, and an injected `Clock`.
 *
 * This class IS the trusted `ApprovedPrestartPort`
 * (src/supervision/directWorkerPrestartAdmission.ts) for its own prepared
 * rows — it is never a consumer of some OTHER injected prestart supplier.
 * `prepare()` is the only writer of a retained approved record, derived
 * entirely from the live, re-verified approval/loop/store/registry facts
 * above; `resolveApprovedPrestart()` is the synchronous reader of that SAME
 * retained row, used by `directWorkerPrestartAdmission.ts`'s own
 * `resolveApprovedPrestart` helper to re-validate against a genuine current
 * snapshot. There is no caller-supplied `prestartReference` and no second
 * approval producer to delegate to.
 *
 * Lifecycle:
 *
 *   `prepare()` — host-only, async. Re-verifies the plan's approval, reads
 *   the live loop/iteration, derives role from the loop slot, binds the
 *   EXACT registered Worker object (via `principalFor`) to the approved
 *   ticket template for that work item, composes+parses the candidate ticket
 *   with the unchanged strict parser/digest, and persists an immutable
 *   "prepared" row — itself the retained approved record — keyed by a
 *   derived reservation id that doubles as the `PrestartTicketReference`.
 *   VERIFY is refused: the existing loop carries no approved MODEL config for
 *   a verifier, and this adapter invents none.
 *
 *   `lookup()` — a synchronous, point-in-time read of what `prepare()`
 *   already persisted, exposed as this host's own `ApprovedPrestartFacts`.
 *
 *   `resolveApprovedPrestart()` — the synchronous `ApprovedPrestartPort`
 *   surface itself: reads back this SAME persisted row as a
 *   `RetainedPrestartRecord`/`ApprovedPrestartRecord` carrying the full
 *   approved facts (`ticket`, digest, principal, role, work item, spec
 *   revision, acceptance criteria, dependencies, target run, scope, model,
 *   budgets) this authority itself retained at `prepare()` time. Both prove
 *   nothing new; a caller must still go through reserve/revalidate/consume
 *   for anything that spawns a process.
 *
 *   `reserve()` / `revalidate()` / `consume()` / `cancel()` — the
 *   `DirectHostAuthorityPort` surface. Each re-queries live plan approval,
 *   live loop state and the live capability callback before acting; an
 *   unknown, stale, foreign or drifted binding fails closed. `consume()` is
 *   at-most-once, durable across restart (a tombstone row survives). `cancel`
 *   only ever releases the exact reservation this same authority created for
 *   the exact same owner.
 *
 * Explicitly out of scope (ADR/task boundary): no loop/CLI wiring, no change
 * to `parseWorkerTicket`/`candidateTicketFromTemplate`, no live provider
 * call, no claim of cross-store atomicity between this SQLite database and
 * the Factory's own store/loop repository — only that THIS database's own
 * reservation rows are serialized and durable.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { AcceptanceCriterion } from "../../domain/acceptanceCriterion.js";
import type { RunId, WorkItemId } from "../../domain/ids.js";
import type { FactoryRole } from "../../domain/role.js";
import type { Run } from "../../domain/run.js";
import type { WorkItem } from "../../domain/workItem.js";
import type { Clock } from "../../ports/clock.js";
import type { FactoryStore } from "../../ports/repositories.js";
import type { DirectLaunchBinding, DirectLaunchReceipt } from "../../ports/worker.js";
import type { Worker } from "../../ports/worker.js";
import type { WorkerRegistry } from "../../ports/workerRegistry.js";
import type { LoopRepository } from "../../orchestration/loopRepository.js";
import type {
  EngineeringLoop,
  LoopIterationRecord,
  LoopWorkerConfig,
  WorkerActionClaim,
  WorkerActionKind,
} from "../../orchestration/loopTypes.js";
import {
  ACTIVE_LOOP_PHASES,
  canonicalActionId,
  correlationTag,
  isTerminalLoopPhase,
} from "../../orchestration/loopTypes.js";
import type { ApprovedExecutionSnapshot, PlanningService } from "../../planning/planningService.js";
import type { PlannedWorkItem, PlannerConfig, WorkItemTicketTemplate } from "../../planning/planTypes.js";
import {
  canonicalCorrelationTag,
  candidateTicketFromTemplate,
  expectedMaterializedItemShape,
  findUnknownTicketTemplateFields,
  validateVerificationExecutionPolicy,
} from "../../planning/planTypes.js";
import {
  compareMaterializedItemShape,
  materializedItemFingerprint,
  type MaterializedItemShape,
} from "../../ports/planBindingResolver.js";
import {
  computeTicketDigest,
  computeDeterministicExecutionTicketDigest,
  parseWorkerTicket,
  parseDeterministicExecutionTicket,
  DETERMINISTIC_EXECUTION_KIND,
  DETERMINISTIC_TICKET_SCHEMA_VERSION,
  MAX_RESULT_BYTES,
  type DeterministicBudgets,
  type DeterministicCommand,
  type DeterministicExecutionPolicy,
  type DeterministicExecutionTicket,
  type WorkerTicket,
} from "../../supervision/workerContract.js";
import {
  validateDirectLaunchCapabilityEvidence,
  type ValidatedDirectLaunchCapability,
} from "../../supervision/directLaunchCapabilityValidation.js";
import {
  DirectAdmissionRefusedError,
  type DirectHostAuthorityPort,
  type DirectHostExecutionLaunchGrant,
  type DirectHostExecutionLaunchRequest,
  type DirectLaunchCapabilityEvidence,
  type DirectLaunchDeterministicCapabilityEvidence,
} from "../../supervision/directWorkerAdmission.js";
import type {
  ApprovedDeterministicPrestartRecord,
  ApprovedExecutionPrestartRecord,
  ApprovedPrestartPort,
  ApprovedPrestartRecord,
  PrestartAcceptanceCriterion,
  RetainedExecutionPrestartRecord,
} from "../../supervision/directWorkerPrestartAdmission.js";

function fail(reason: string): never {
  throw new DirectAdmissionRefusedError(reason);
}

/**
 * UNIT A. The genuine, independently captured action configuration this
 * authority binds, taken from the HOST constructor — never from a request,
 * never from an approval payload, and never inferred from `Worker.id` or
 * `worker.capabilities`. `principalFor` proves object identity and roles
 * only; the tool/model/effort/workspace a launch may ever use comes from
 * here and must additionally AGREE with the approved execution config and
 * the loop's own independently captured copy before any row is written.
 *
 * Structural, not nominal: `tool` is typed exactly as the existing
 * `LoopWorkerConfig["tool"]` (`WorkerTool`) so no new vocabulary is
 * introduced and no unmapped tool string can be smuggled in.
 */
export interface BoundWorkerAction {
  /** Absent means "ai", so every existing host composition is unchanged. */
  readonly executionKind?: "ai";
  /** The EXACT registered, guarded Worker object this authority may launch. */
  readonly worker: Worker;
  /** The slot this object is bound to for its whole lifetime in this process. */
  readonly slot: HostSupplierSlot;
  /** Host-captured action configuration, independent of any request. */
  readonly config: LoopWorkerConfig;
  /** Host-captured workspace root the bound action's owned scope resolves under. */
  readonly workspaceRoot: string;
}

/**
 * UNIT B. The genuine, independently captured DETERMINISTIC action
 * configuration for the exact registered, guarded VERIFIER object.
 *
 * Deliberately a SEPARATE constructor-composed shape rather than an AI
 * binding with optional extras: a deterministic verification has no tool,
 * no model, no reasoning effort and no provider at all, so there is nothing
 * here that could be read as one and nothing an AI-shaped check could be
 * satisfied by. What it does carry is the host's own independently
 * configured ORDERED command sequence, the workspace root those commands
 * resolve under, and the process-limit policy (elapsed/output/attempts plus
 * the rationale) it is willing to impose.
 *
 * Like its AI sibling this is constructor-only: `prepare()` may SELECT one
 * of these by Worker object identity but can never mint one, and authority
 * is never inferred from `Worker.id`, `worker.capabilities`, a caller role
 * or a persisted row. Every field below must additionally AGREE with the
 * approved execution configuration's own `verificationCommands`,
 * `workspaceRoot` and `verificationExecutionPolicy` before a row is written.
 */
export interface BoundDeterministicWorkerAction {
  readonly executionKind: typeof DETERMINISTIC_EXECUTION_KIND;
  /** The EXACT registered, guarded VERIFIER object this authority may launch. */
  readonly worker: Worker;
  readonly slot: "VERIFY";
  /** Host-captured ordered command sequence. Order is significant and never normalized. */
  readonly commands: readonly DeterministicCommand[];
  /** Host-captured workspace root every command cwd must resolve under. */
  readonly workspaceRoot: string;
  /** Host-captured process limits — never derived from token or result-byte budgets. */
  readonly budgets: DeterministicBudgets;
  readonly executionPolicy: DeterministicExecutionPolicy;
}

/** The host-composable binding union. The AI member keeps its exact old shape. */
export type BoundExecutionWorkerAction = BoundWorkerAction | BoundDeterministicWorkerAction;

/** Narrowing on the binding's OWN discriminant; never on slot or Worker identity. */
function isDeterministicBinding(
  binding: BoundExecutionWorkerAction,
): binding is BoundDeterministicWorkerAction {
  return binding.executionKind === DETERMINISTIC_EXECUTION_KIND;
}

/**
 * The immutable, host-only composition captured at CONSTRUCTION time: the
 * exact Worker objects this authority may ever bind, each already paired
 * with its own configured tool/model/effort and workspace root.
 *
 * Why this is a constructor input and not a `prepare()` argument: a request
 * must not be able to mint or rebind authority. `prepare()` may only SELECT
 * one of these pre-composed bindings by object identity; it can never
 * introduce a Worker object the host did not compose, and it can never
 * attach a different configuration to one that it did.
 */
type BoundWorkerIndex = ReadonlyMap<Worker, BoundExecutionWorkerAction>;

/**
 * Validates and freezes ONE host-composed deterministic VERIFY binding. The
 * limits are checked as real, usable numbers here — not restated from an
 * approval, and never derived from `MAX_RESULT_BYTES`, a token budget or a
 * timeout default. A command whose `cwd` escapes the bound workspace root is
 * refused outright rather than clamped.
 */
function freezeDeterministicBinding(
  binding: BoundDeterministicWorkerAction,
): BoundDeterministicWorkerAction {
  if (typeof binding.workspaceRoot !== "string" || binding.workspaceRoot.trim().length === 0) {
    fail("a host-composed deterministic binding carries no workspace root");
  }
  if (!Array.isArray(binding.commands) || binding.commands.length === 0) {
    fail("a host-composed deterministic binding carries no ordered command sequence");
  }
  const commands = binding.commands.map((command, index) => {
    if (command === null || typeof command !== "object") {
      fail(`host-composed deterministic command ${index + 1} is not a command object`);
    }
    if (typeof command.executable !== "string" || command.executable.trim().length === 0) {
      fail(`host-composed deterministic command ${index + 1} names no executable`);
    }
    if (!Array.isArray(command.argv) || command.argv.some((arg: unknown) => typeof arg !== "string")) {
      fail(`host-composed deterministic command ${index + 1} has a malformed argv`);
    }
    if (typeof command.cwd !== "string" || command.cwd.trim().length === 0) {
      fail(`host-composed deterministic command ${index + 1} names no cwd`);
    }
    // Refuses closed on escape; the returned canonical form is deliberately
    // discarded, because the command's own literal cwd is what is digest-bound.
    canonicalizeOwnedPath(binding.workspaceRoot, command.cwd);
    return Object.freeze({
      executable: command.executable,
      argv: Object.freeze([...command.argv]) as readonly string[],
      cwd: command.cwd,
    }) as DeterministicCommand;
  });
  const budgets = binding.budgets;
  if (budgets === null || typeof budgets !== "object") {
    fail("a host-composed deterministic binding carries no process budgets");
  }
  if (
    typeof budgets.elapsedSeconds !== "number" ||
    !Number.isFinite(budgets.elapsedSeconds) ||
    budgets.elapsedSeconds <= 0
  ) {
    fail("a host-composed deterministic binding carries no positive elapsedSeconds limit");
  }
  if (!Number.isSafeInteger(budgets.outputBytes) || budgets.outputBytes <= 0) {
    fail("a host-composed deterministic binding carries no positive outputBytes limit");
  }
  if (!Number.isSafeInteger(budgets.maxAttempts) || budgets.maxAttempts <= 0) {
    fail("a host-composed deterministic binding carries no positive maxAttempts limit");
  }
  const executionPolicy = binding.executionPolicy;
  if (
    executionPolicy === null ||
    typeof executionPolicy !== "object" ||
    typeof executionPolicy.rationale !== "string" ||
    executionPolicy.rationale.trim().length < 10
  ) {
    fail("a host-composed deterministic binding carries no meaningful executionPolicy rationale");
  }
  // A deterministic binding must carry no AI vocabulary whatsoever: a bound
  // tool/model/effort here would be exactly the invented provider identity
  // this branch exists to refuse.
  for (const forbidden of ["config", "tool", "model", "effort", "provider"] as const) {
    if (forbidden in (binding as unknown as Record<string, unknown>)) {
      fail(`a host-composed deterministic binding carries an AI-only field (${forbidden})`);
    }
  }
  return Object.freeze({
    executionKind: DETERMINISTIC_EXECUTION_KIND,
    worker: binding.worker,
    slot: "VERIFY",
    commands: Object.freeze(commands) as readonly DeterministicCommand[],
    workspaceRoot: binding.workspaceRoot,
    budgets: Object.freeze({
      elapsedSeconds: budgets.elapsedSeconds,
      outputBytes: budgets.outputBytes,
      maxAttempts: budgets.maxAttempts,
    }) as DeterministicBudgets,
    executionPolicy: Object.freeze({
      rationale: executionPolicy.rationale.trim(),
    }) as DeterministicExecutionPolicy,
  }) as BoundDeterministicWorkerAction;
}

function indexBoundWorkers(bindings: readonly BoundExecutionWorkerAction[]): BoundWorkerIndex {
  if (!Array.isArray(bindings) || bindings.length === 0) {
    fail("at least one host-composed bound Worker action is required; a request may never mint authority");
  }
  const index = new Map<Worker, BoundExecutionWorkerAction>();
  for (const binding of bindings) {
    const worker = binding?.worker;
    if (worker === null || typeof worker !== "object" || typeof worker.execute !== "function") {
      fail("a host-composed binding does not carry a real guarded Worker object");
    }
    if (index.has(worker)) {
      fail("the same registered Worker object appears twice in this authority's host-composed bindings");
    }
    // The binding's OWN declared kind selects the validation branch. A
    // deterministic VERIFY binding is never validated as an AI one (it has no
    // tool/model to find), and an AI binding may still never name VERIFY.
    if (isDeterministicBinding(binding)) {
      if (binding.slot !== "VERIFY") {
        fail(
          `host-composed deterministic binding names slot "${String(binding.slot)}"; the deterministic branch authorizes VERIFY only`,
        );
      }
      index.set(worker, freezeDeterministicBinding(binding));
      continue;
    }
    if (binding.executionKind !== undefined && binding.executionKind !== "ai") {
      fail(`host-composed binding declares unrecognized executionKind "${String(binding.executionKind)}"`);
    }
    if (binding.slot !== "IMPLEMENT" && binding.slot !== "REVIEW") {
      fail(`host-composed binding names slot "${String(binding.slot)}", which has no approved model configuration`);
    }
    const config = binding.config;
    if (config === null || typeof config !== "object") {
      fail("a host-composed binding carries no action configuration");
    }
    if (typeof config.tool !== "string" || config.tool.trim().length === 0) {
      fail("a host-composed binding carries no configured tool");
    }
    if (typeof config.model !== "string" || config.model.trim().length === 0) {
      fail("a host-composed binding carries no configured model");
    }
    if (config.effort !== undefined && (typeof config.effort !== "string" || config.effort.trim().length === 0)) {
      fail("a host-composed binding carries a blank configured effort");
    }
    if (typeof binding.workspaceRoot !== "string" || binding.workspaceRoot.trim().length === 0) {
      fail("a host-composed binding carries no workspace root");
    }
    index.set(
      worker,
      Object.freeze({
        worker,
        slot: binding.slot,
        config: Object.freeze({
          tool: config.tool,
          model: config.model,
          ...(config.effort === undefined ? {} : { effort: config.effort }),
          ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        }) as LoopWorkerConfig,
        workspaceRoot: binding.workspaceRoot,
      }),
    );
  }
  return index;
}

/**
 * The slot in the loop a prepared action authorizes. Deliberately NOT a
 * caller-asserted role: `roleForSlot` is the only map from slot to
 * `FactoryRole`.
 *
 * `HostSupplierSlot` stays EXACTLY the pre-existing AI pair, so every
 * existing AI-shaped signature, row projection and caller keeps its previous
 * precise type. VERIFY is a separate literal in the explicit
 * `HostExecutionSlot` union, reachable only through the deterministic
 * branch's own constructor-composed binding — never by widening the AI slot.
 */
export type HostSupplierSlot = Extract<WorkerActionKind, "IMPLEMENT" | "REVIEW">;

/** The deterministic slot. There is exactly one, and it is not an AI slot. */
export type HostDeterministicSlot = Extract<WorkerActionKind, "VERIFY">;

export type HostExecutionSlot = HostSupplierSlot | HostDeterministicSlot;

function roleForSlot(slot: WorkerActionKind): FactoryRole {
  if (slot === "IMPLEMENT") return "IMPLEMENTER";
  if (slot === "REVIEW") return "REVIEWER";
  if (slot === "VERIFY") return "VERIFIER";
  fail(`slot "${String(slot)}" has no legitimate role mapping in the existing loop`);
}

/**
 * Immutable, point-in-time facts a prepared reservation exposes through the
 * host's own synchronous `lookup`. Never a grant, capability, or ongoing
 * authority — only what `prepare()` found true at the moment it ran.
 */
export interface ApprovedPrestartFacts {
  readonly reservationId: string;
  readonly reservationVersion: number;
  readonly planId: string;
  readonly loopId: string;
  readonly iteration: number;
  /**
   * Widened to the execution slot union so a VERIFY row is reported as what
   * it genuinely is. `executionKind` below is the discriminant a reader
   * narrows on; `boundConfig`/`boundModel`-shaped facts exist only on the AI
   * kind, and a deterministic row reports its commands/limits instead.
   */
  readonly slot: HostExecutionSlot;
  readonly executionKind: "ai" | typeof DETERMINISTIC_EXECUTION_KIND;
  readonly role: FactoryRole;
  readonly workItemId: WorkItemId;
  readonly specRevision: number;
  readonly registryPrincipalId: string;
  /**
   * Absent on a PREPARED row: preparation is runless, and the genuine
   * Factory-owned run attaches only at `reserve()`.
   */
  readonly runId?: RunId;
  readonly targetRunId?: RunId;
  /**
   * The host-captured AI action configuration this reservation is bound to.
   * Present on an `"ai"` row only: a deterministic VERIFY row has no tool,
   * model or effort, and none is invented to fill this field.
   */
  readonly boundConfig?: LoopWorkerConfig;
  readonly boundWorkspaceRoot: string;
  /** Present on a deterministic row only: the ordered commands and process limits. */
  readonly boundCommands?: readonly DeterministicCommand[];
  readonly boundDeterministicBudgets?: DeterministicBudgets;
  readonly boundExecutionPolicy?: DeterministicExecutionPolicy;
  /** The trusted claim tuple captured at preparation. */
  readonly claimActionId: string;
  readonly claimAttempt: number;
  readonly ticketDigest: string;
  readonly preparedAt: number;
  readonly state: "PREPARED" | "RESERVED" | "CONSUMED" | "CANCELLED";
}

/** The synchronous, read-only lookup this adapter supplies for its own prepared rows. */
export interface PreparedReservationLookup {
  /** Point-in-time facts only; never re-verifies and never grants anything. */
  lookup(reservationId: string): ApprovedPrestartFacts | undefined;
}

/**
 * Preparation coordinates. Deliberately RUNLESS: there is no `runId` here,
 * because a prepared row must not pre-authorize a run a caller merely named —
 * the genuine Factory-owned run attaches at `reserve()`.
 *
 * `worker` is not a Worker to bind; it is a SELECTOR into this authority's
 * constructor-composed bindings, resolved by object identity. The tool,
 * model, effort and workspace root all come from that composition, never
 * from this input and never from `Worker.id`.
 */
export interface PrepareHostBindingInput {
  readonly planId: string;
  readonly loopId: string;
  readonly iteration: number;
  /**
   * Widened to the execution slot union: naming VERIFY is not itself
   * authority, it only SELECTS the deterministic branch, which then requires
   * a constructor-composed deterministic binding for the exact Worker object
   * below. A caller naming VERIFY with an AI-bound Worker is refused.
   */
  readonly slot: HostExecutionSlot;
  readonly worker: Worker;
}

type CapabilityCallback = (request: {
  readonly ticket: WorkerTicket;
  readonly ticketDigest: string;
  readonly binding: DirectLaunchBinding;
}) => Promise<unknown>;

/**
 * The SEPARATE trusted seam for deterministic local capability. It is
 * constructor-owned exactly like its AI sibling and is never the AI callback
 * reused: it is handed the deterministic ticket, so it can only be answered
 * with the deterministic evidence shape (resolved executables/workspace,
 * genuinely enforceable numeric elapsed/output/attempt capacities, scope
 * confinement and fresh identity/binding evidence). The AI callback is never
 * called with deterministic data and this one is never called with AI data.
 */
type DeterministicCapabilityCallback = (request: {
  readonly ticket: DeterministicExecutionTicket;
  readonly ticketDigest: string;
  readonly binding: DirectLaunchBinding;
}) => Promise<unknown>;

export interface SqliteDirectHostAuthorityDeps {
  readonly planning: Pick<PlanningService, "verifiedApprovedExecutionSnapshot">;
  readonly store: FactoryStore;
  readonly loops: LoopRepository;
  readonly registry: WorkerRegistry;
  readonly db: DatabaseSync;
  readonly clock: Clock;
  /** Trusted, constructor-injected host authority — never per-request caller input. */
  readonly capability: CapabilityCallback;
  /**
   * The separate trusted deterministic seam. REQUIRED to act on any VERIFY
   * binding: an authority composed with a deterministic binding but no
   * deterministic capability callback refuses at construction rather than
   * falling back to the AI validator with deterministic data.
   */
  readonly deterministicCapability?: DeterministicCapabilityCallback;
  /**
   * The complete, immutable set of host-composed Worker-object bindings this
   * authority may ever act for: each AI member already carrying its own
   * configured tool/model/effort and workspace root, and each deterministic
   * VERIFY member its own ordered commands, workspace root and process-limit
   * policy. Required: an authority with no composed binding can prepare
   * nothing, and `prepare()` may only select from this set by object
   * identity — never extend it.
   */
  readonly boundWorkers: readonly BoundExecutionWorkerAction[];
  readonly maxEvidenceAgeSeconds?: number;
  /**
   * Stable identity of THIS constructed authority instance. Required and
   * validated non-blank: there is no shared default constant, and it is
   * never read back from a persisted row — a row's `authority_id` column
   * records who wrote it, it is never itself treated as this instance's own
   * identity.
   */
  readonly authorityId: string;
}

interface Row {
  readonly reservation_id: string;
  readonly version: number;
  readonly authority_id: string;
  readonly plan_id: string;
  readonly loop_id: string;
  readonly iteration: number;
  readonly slot: string;
  readonly role: string;
  readonly work_item_id: string;
  readonly spec_revision: number;
  readonly registry_principal_id: string;
  /**
   * NULL until `reserve()` attaches the genuine Factory-owned run. Preparation
   * is runless by construction: there is no run to bind yet, and a prepared
   * row must never pre-authorize a run id a caller merely named.
   */
  readonly run_id: string | null;
  readonly target_run_id: string | null;
  readonly ticket_digest: string;
  readonly ticket_json: string;
  readonly owned_paths_json: string;
  readonly approved_criteria_json: string;
  readonly approved_dependency_ids_json: string;
  /**
   * The genuine approved item fingerprint `prepare()` compared the current
   * item/spec/criteria/dependencies against, so a later revalidation proves
   * the SAME approved shape rather than re-accepting whatever the store now
   * holds.
   */
  readonly approved_item_fingerprint: string;
  /**
   * The execution kind this row was written for. Added by the PHASE7-102
   * migration with DEFAULT 'ai', so every genuine pre-existing AI row decodes
   * as 'ai' without being rewritten, and a reader never has to infer the kind
   * from which other columns happen to be populated.
   */
  readonly execution_kind: string;
  /**
   * The host-captured AI action configuration (tool/model/effort) and the
   * workspace root its owned scope was canonicalized under — captured
   * independently of any request and compared on every later revalidation.
   *
   * NULL on a deterministic row. The legacy columns were NOT NULL, which is
   * exactly why the migration relaxes them to nullable rather than writing a
   * placeholder: there is no honest tool/model string for a command sequence,
   * and inventing one ("none", "deterministic", a real provider name) would
   * be the fabricated provider identity this phase refuses. Decoding still
   * demands a non-null tool/model for an 'ai' row, so no existing AI row is
   * weakened by the relaxation.
   */
  readonly bound_tool: string | null;
  readonly bound_model: string | null;
  readonly bound_effort: string | null;
  readonly bound_workspace_root: string;
  /**
   * Deterministic-only columns, NULL on an AI row: the ordered command
   * sequence, the process limits and the executionPolicy rationale this row
   * was prepared against. Written as JSON and re-validated on every decode,
   * never trusted as the authority on their own — `requireLiveRow` re-derives
   * all three from the genuine current approval and the constructor-composed
   * binding and compares.
   */
  readonly bound_commands_json: string | null;
  readonly bound_deterministic_budgets_json: string | null;
  readonly bound_execution_policy_json: string | null;
  /**
   * The trusted action-claim tuple captured at preparation: the canonical
   * action id, the exact attempt and the exact claim owner token. A later
   * revalidation compares the FULL tuple, so a takeover re-claim (new
   * attempt) or a different owner is refused, not just a different action.
   */
  readonly claim_action_id: string;
  readonly claim_attempt: number;
  readonly claim_owner_token: string;
  readonly prepared_at: number;
  readonly state: string;
  readonly owner_token: string | null;
  readonly consumed_binding_json: string | null;
}

function isRow(value: unknown): value is Row {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.reservation_id === "string" &&
    typeof candidate.version === "number" &&
    typeof candidate.authority_id === "string" &&
    typeof candidate.plan_id === "string" &&
    typeof candidate.loop_id === "string" &&
    typeof candidate.iteration === "number" &&
    typeof candidate.slot === "string" &&
    typeof candidate.role === "string" &&
    typeof candidate.work_item_id === "string" &&
    typeof candidate.spec_revision === "number" &&
    typeof candidate.registry_principal_id === "string" &&
    (candidate.run_id === null || typeof candidate.run_id === "string") &&
    (candidate.target_run_id === null || typeof candidate.target_run_id === "string") &&
    typeof candidate.ticket_digest === "string" &&
    typeof candidate.ticket_json === "string" &&
    typeof candidate.owned_paths_json === "string" &&
    typeof candidate.approved_criteria_json === "string" &&
    typeof candidate.approved_dependency_ids_json === "string" &&
    typeof candidate.approved_item_fingerprint === "string" &&
    typeof candidate.execution_kind === "string" &&
    (candidate.bound_tool === null || typeof candidate.bound_tool === "string") &&
    (candidate.bound_model === null || typeof candidate.bound_model === "string") &&
    (candidate.bound_effort === null || typeof candidate.bound_effort === "string") &&
    typeof candidate.bound_workspace_root === "string" &&
    (candidate.bound_commands_json === null || typeof candidate.bound_commands_json === "string") &&
    (candidate.bound_deterministic_budgets_json === null ||
      typeof candidate.bound_deterministic_budgets_json === "string") &&
    (candidate.bound_execution_policy_json === null ||
      typeof candidate.bound_execution_policy_json === "string") &&
    typeof candidate.claim_action_id === "string" &&
    typeof candidate.claim_attempt === "number" &&
    typeof candidate.claim_owner_token === "string" &&
    typeof candidate.prepared_at === "number" &&
    typeof candidate.state === "string" &&
    (candidate.owner_token === null || typeof candidate.owner_token === "string") &&
    (candidate.consumed_binding_json === null || typeof candidate.consumed_binding_json === "string")
  );
}

/**
 * The per-kind completeness check the nullable columns make necessary. An
 * 'ai' row must still carry a real tool/model and NO deterministic columns
 * (so an existing AI row decodes exactly as before and a half-migrated AI row
 * is refused rather than read as deterministic); a deterministic row must
 * carry all three deterministic columns and NO tool/model/effort at all.
 * Any other kind refuses closed rather than defaulting to 'ai'.
 */
function decodeRow(value: unknown): Row {
  if (!isRow(value)) {
    fail("persisted host_reservations row has an unexpected shape");
  }
  if (value.execution_kind === "ai") {
    if (value.bound_tool === null || value.bound_model === null) {
      fail(`reservation ${value.reservation_id} is an AI row with no persisted bound tool/model`);
    }
    if (
      value.bound_commands_json !== null ||
      value.bound_deterministic_budgets_json !== null ||
      value.bound_execution_policy_json !== null
    ) {
      fail(`reservation ${value.reservation_id} is an AI row carrying deterministic execution columns`);
    }
    return value;
  }
  if (value.execution_kind === DETERMINISTIC_EXECUTION_KIND) {
    if (value.bound_tool !== null || value.bound_model !== null || value.bound_effort !== null) {
      fail(
        `reservation ${value.reservation_id} is a deterministic row carrying an AI tool/model/effort`,
      );
    }
    if (
      value.bound_commands_json === null ||
      value.bound_deterministic_budgets_json === null ||
      value.bound_execution_policy_json === null
    ) {
      fail(`reservation ${value.reservation_id} is a deterministic row with incomplete execution columns`);
    }
    return value;
  }
  fail(`reservation ${value.reservation_id} records unrecognized execution kind "${value.execution_kind}"`);
}

/** The row's OWN persisted discriminant. Never inferred from the slot or from which columns are set. */
function rowExecutionKind(row: Row): "ai" | typeof DETERMINISTIC_EXECUTION_KIND {
  return row.execution_kind === DETERMINISTIC_EXECUTION_KIND ? DETERMINISTIC_EXECUTION_KIND : "ai";
}

/** Strictly re-validates the deterministic columns a deterministic row persisted. */
function decodeRowDeterministicFacts(row: Row): {
  readonly commands: readonly DeterministicCommand[];
  readonly budgets: DeterministicBudgets;
  readonly executionPolicy: DeterministicExecutionPolicy;
} {
  if (
    row.bound_commands_json === null ||
    row.bound_deterministic_budgets_json === null ||
    row.bound_execution_policy_json === null
  ) {
    fail(`reservation ${row.reservation_id} carries no persisted deterministic execution facts`);
  }
  const commands: unknown = JSON.parse(row.bound_commands_json);
  if (
    !Array.isArray(commands) ||
    commands.length === 0 ||
    !commands.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as DeterministicCommand).executable === "string" &&
        Array.isArray((entry as DeterministicCommand).argv) &&
        (entry as DeterministicCommand).argv.every((arg) => typeof arg === "string") &&
        typeof (entry as DeterministicCommand).cwd === "string",
    )
  ) {
    fail(`reservation ${row.reservation_id} has a malformed persisted deterministic command list`);
  }
  const budgets: unknown = JSON.parse(row.bound_deterministic_budgets_json);
  if (!isDeterministicBudgetsShape(budgets)) {
    fail(`reservation ${row.reservation_id} has malformed persisted deterministic budgets`);
  }
  const executionPolicy: unknown = JSON.parse(row.bound_execution_policy_json);
  if (
    executionPolicy === null ||
    typeof executionPolicy !== "object" ||
    typeof (executionPolicy as DeterministicExecutionPolicy).rationale !== "string" ||
    (executionPolicy as DeterministicExecutionPolicy).rationale.trim().length === 0
  ) {
    fail(`reservation ${row.reservation_id} has a malformed persisted deterministic executionPolicy`);
  }
  return {
    commands: commands as readonly DeterministicCommand[],
    budgets,
    executionPolicy: executionPolicy as DeterministicExecutionPolicy,
  };
}

function isDeterministicBudgetsShape(value: unknown): value is DeterministicBudgets {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.elapsedSeconds === "number" &&
    Number.isFinite(candidate.elapsedSeconds) &&
    candidate.elapsedSeconds > 0 &&
    Number.isSafeInteger(candidate.outputBytes) &&
    (candidate.outputBytes as number) > 0 &&
    Number.isSafeInteger(candidate.maxAttempts) &&
    (candidate.maxAttempts as number) > 0
  );
}

function sameCommandSequence(
  a: readonly DeterministicCommand[],
  b: readonly DeterministicCommand[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  // Order is significant and never normalized: a reordered sequence is a
  // different approved action, not the same one.
  return a.every((command, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      command.executable === other.executable &&
      command.cwd === other.cwd &&
      command.argv.length === other.argv.length &&
      command.argv.every((arg, argIndex) => arg === other.argv[argIndex])
    );
  });
}

function sameDeterministicBudgets(a: DeterministicBudgets, b: DeterministicBudgets): boolean {
  return (
    a.elapsedSeconds === b.elapsedSeconds &&
    a.outputBytes === b.outputBytes &&
    a.maxAttempts === b.maxAttempts
  );
}

/**
 * Narrow decoder for the two-column owned-path projection. `findActiveOwnedPaths`
 * deliberately selects only `reservation_id`/`owned_paths_json`, so a full-row
 * decoder would reject every result; this validates exactly the columns that
 * projection returns, and still fails closed on an unexpected shape.
 */
interface OwnedPathsProjection {
  readonly reservation_id: string;
  readonly owned_paths_json: string;
}

function decodeOwnedPathRows(values: readonly unknown[]): readonly OwnedPathsProjection[] {
  return values.map((value) => {
    if (value === null || typeof value !== "object") {
      fail("persisted host_reservations owned-path projection has an unexpected shape");
    }
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.reservation_id !== "string" || typeof candidate.owned_paths_json !== "string") {
      fail("persisted host_reservations owned-path projection has an unexpected shape");
    }
    return { reservation_id: candidate.reservation_id, owned_paths_json: candidate.owned_paths_json };
  });
}

function decodeCanonicalPathList(value: string, reservationId: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string" && entry.length > 0)) {
    fail(`reservation ${reservationId} has a malformed persisted owned-path list`);
  }
  return parsed as readonly string[];
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS host_reservations (
      reservation_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      authority_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      loop_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      slot TEXT NOT NULL,
      role TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      spec_revision INTEGER NOT NULL,
      registry_principal_id TEXT NOT NULL,
      run_id TEXT,
      target_run_id TEXT,
      ticket_digest TEXT NOT NULL,
      ticket_json TEXT NOT NULL,
      owned_paths_json TEXT NOT NULL,
      approved_criteria_json TEXT NOT NULL,
      approved_dependency_ids_json TEXT NOT NULL,
      approved_item_fingerprint TEXT NOT NULL,
      execution_kind TEXT NOT NULL DEFAULT 'ai',
      bound_tool TEXT,
      bound_model TEXT,
      bound_effort TEXT,
      bound_workspace_root TEXT NOT NULL,
      bound_commands_json TEXT,
      bound_deterministic_budgets_json TEXT,
      bound_execution_policy_json TEXT,
      claim_action_id TEXT NOT NULL,
      claim_attempt INTEGER NOT NULL,
      claim_owner_token TEXT NOT NULL,
      prepared_at INTEGER NOT NULL,
      state TEXT NOT NULL,
      owner_token TEXT,
      consumed_binding_json TEXT,
      UNIQUE (loop_id, iteration, slot)
    );
  `);
  migrateSchema(db);
}

/**
 * Additive, in-place migration of an EXISTING `host_reservations` table
 * written before the deterministic branch existed.
 *
 * Deliberately `ALTER TABLE ... ADD COLUMN` only — no table rebuild, no
 * copy-and-swap, no DROP:
 *
 *   - Genuine old AI rows keep their identity, their `version`, their
 *     RESERVED/CONSUMED/CANCELLED state, their `owner_token` and their
 *     `consumed_binding_json`, so durable reservations, at-most-once consume
 *     and the replay/attempt limits all survive unchanged. A rebuild would
 *     have had to re-insert every row and could lose or renumber exactly
 *     those facts.
 *   - `execution_kind` arrives with DEFAULT 'ai', so every pre-existing row
 *     reads back as the AI row it has always been, without being rewritten.
 *   - The new deterministic columns are nullable, so old rows satisfy them as
 *     NULL and `decodeRow` still demands a real tool/model for an 'ai' row.
 *
 * The legacy NOT NULL on `bound_tool`/`bound_model` is intentionally LEFT IN
 * PLACE on a pre-existing table: SQLite cannot drop a NOT NULL constraint
 * without a rebuild, and a rebuild is exactly what must not happen to live
 * reservation rows. A deterministic row therefore cannot be inserted into an
 * un-rebuilt legacy table, and `prepare()` reports that as the explicit,
 * honest refusal below rather than writing a fake tool/model to get past the
 * constraint. A fresh database created by the CREATE TABLE above has the
 * nullable columns and accepts deterministic rows immediately.
 */
function migrateSchema(db: DatabaseSync): void {
  for (const column of [
    "execution_kind TEXT NOT NULL DEFAULT 'ai'",
    "bound_commands_json TEXT",
    "bound_deterministic_budgets_json TEXT",
    "bound_execution_policy_json TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE host_reservations ADD COLUMN ${column}`);
    } catch {
      // Already present: this authority (or a previous process) migrated the
      // same database. Adding a column is the only change ever attempted, so
      // a duplicate-column error is the expected no-op and nothing else here
      // is skipped as a result.
    }
  }
}

/**
 * Whether THIS database can hold a deterministic row at all, decided from the
 * table's own current column metadata rather than assumed. A legacy table
 * whose `bound_tool`/`bound_model` are still NOT NULL cannot, and the
 * deterministic branch refuses rather than inventing values to satisfy them.
 */
function deterministicStorageRefusal(db: DatabaseSync): string | undefined {
  const columns = db.prepare(`SELECT name, "notnull" AS "notnull" FROM pragma_table_info('host_reservations')`).all() as readonly {
    readonly name?: unknown;
    readonly notnull?: unknown;
  }[];
  const byName = new Map<string, number>();
  for (const column of columns) {
    if (typeof column.name === "string" && typeof column.notnull === "number") {
      byName.set(column.name, column.notnull);
    }
  }
  for (const required of [
    "execution_kind",
    "bound_commands_json",
    "bound_deterministic_budgets_json",
    "bound_execution_policy_json",
  ]) {
    if (!byName.has(required)) {
      return `this database's host_reservations table has no ${required} column`;
    }
  }
  for (const legacy of ["bound_tool", "bound_model"]) {
    if (byName.get(legacy) === 1) {
      return `this database's host_reservations.${legacy} is still NOT NULL (a pre-deterministic table); a deterministic row would require a fabricated tool/model value, which this authority refuses to write`;
    }
  }
  return undefined;
}

interface Statements {
  readonly insert: StatementSync;
  readonly findById: StatementSync;
  readonly findActiveOwnedPaths: StatementSync;
  readonly reserve: StatementSync;
  readonly consume: StatementSync;
  readonly cancel: StatementSync;
}

function prepareStatements(db: DatabaseSync): Statements {
  return {
    // Runless by construction: `run_id` is left NULL here and attached only
    // by `reserve()` once a genuine Factory-owned run exists.
    insert: db.prepare(
      `INSERT INTO host_reservations
        (reservation_id, version, authority_id, plan_id, loop_id, iteration, slot, role, work_item_id,
         spec_revision, registry_principal_id, run_id, target_run_id, ticket_digest,
         ticket_json, owned_paths_json, approved_criteria_json, approved_dependency_ids_json,
         approved_item_fingerprint, execution_kind,
         bound_tool, bound_model, bound_effort, bound_workspace_root,
         bound_commands_json, bound_deterministic_budgets_json, bound_execution_policy_json,
         claim_action_id, claim_attempt, claim_owner_token,
         prepared_at, state, owner_token, consumed_binding_json)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', NULL, NULL)`,
    ),
    findById: db.prepare(`SELECT * FROM host_reservations WHERE reservation_id = ? AND authority_id = ?`),
    // Live owned-path overlap check across DISTINCT reservations of EVERY
    // authority sharing this SAME database that currently hold an active
    // (PREPARED or RESERVED) claim — ancestor/descendant overlap, not merely
    // an identical path or id, and never limited to this authority's own
    // rows: a foreign authority's active claim on an overlapping workspace
    // path is exactly the conflict this check exists to catch.
    findActiveOwnedPaths: db.prepare(
      `SELECT reservation_id, owned_paths_json FROM host_reservations
       WHERE reservation_id != ? AND state IN ('PREPARED', 'RESERVED')`,
    ),
    // Attaches the ALREADY-VALIDATED genuine Factory-owned run in the same
    // atomic PREPARED/version/authority CAS that reserves the row: a runless
    // prepared row and its attached run can never diverge.
    reserve: db.prepare(
      `UPDATE host_reservations SET state = 'RESERVED', version = version + 1, owner_token = ?, run_id = ?
       WHERE reservation_id = ? AND authority_id = ? AND version = ? AND state = 'PREPARED' AND run_id IS NULL`,
    ),
    consume: db.prepare(
      `UPDATE host_reservations SET state = 'CONSUMED', version = version + 1, consumed_binding_json = ?
       WHERE reservation_id = ? AND authority_id = ? AND version = ? AND state = 'RESERVED' AND owner_token = ?`,
    ),
    cancel: db.prepare(
      `UPDATE host_reservations SET state = 'CANCELLED', version = version + 1
       WHERE reservation_id = ? AND authority_id = ? AND version = ? AND state = 'RESERVED' AND owner_token = ?`,
    ),
  };
}

/**
 * Canonicalizes an owned path under the approved `workspaceRoot` into a
 * single stable, comparable platform-neutral form: backslashes normalized to
 * forward slashes, `.`/`..` segments resolved relative to the root, no
 * trailing slash (except the root itself as `""`), and an attempt to escape
 * the root refused closed rather than silently clamped — a genuinely
 * different, non-overlapping path must never be coerced into looking like it
 * overlaps the root by clamping.
 */
function canonicalizeOwnedPath(workspaceRoot: string, rawPath: string): string {
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedRaw = rawPath.replace(/\\/g, "/");
  const combined = normalizedRaw.startsWith("/") || /^[A-Za-z]:\//.test(normalizedRaw)
    ? normalizedRaw
    : `${normalizedRoot}/${normalizedRaw}`;
  const segments = combined.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (resolved.length === 0) {
        fail(`owned path "${rawPath}" escapes the approved workspace root`);
      }
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  const canonical = `/${resolved.join("/")}`;
  const rootSegments = normalizedRoot.split("/").filter((segment) => segment !== "" && segment !== ".");
  const canonicalRoot = `/${rootSegments.join("/")}`;
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}/`)) {
    fail(`owned path "${rawPath}" escapes the approved workspace root`);
  }
  return canonical.toLowerCase();
}

/** Ancestor/descendant-aware overlap on already-canonicalized paths: "a/b" and "a/b/c" overlap; "a/bc" and "a/b" do not. */
function pathsOverlap(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const aPrefix = a.endsWith("/") ? a : `${a}/`;
  const bPrefix = b.endsWith("/") ? b : `${b}/`;
  return b.startsWith(aPrefix) || a.startsWith(bPrefix);
}

function anyPathsOverlap(a: readonly string[], b: readonly string[]): string | undefined {
  const distinctB = [...new Set(b)];
  for (const pathA of a) {
    for (const pathB of distinctB) {
      if (pathsOverlap(pathA, pathB)) {
        return `${pathA} <-> ${pathB}`;
      }
    }
  }
  return undefined;
}

/**
 * A structurally independent, deeply frozen copy. Both synchronous readers
 * return this, so a caller holds no mutable alias into (and cannot mutate any
 * nested ticket/criteria/dependencies/scope/model/budgets of) what this
 * authority retained.
 */
function deepFreezeCopy<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => deepFreezeCopy(entry))) as unknown as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = deepFreezeCopy(entry);
  }
  return Object.freeze(copy) as T;
}

function rowToFacts(row: Row): ApprovedPrestartFacts {
  const kind = rowExecutionKind(row);
  // Each kind reports ONLY its own facts. A deterministic row exposes no
  // `boundConfig` at all rather than a synthesized tool/model, and an AI row
  // exposes no commands/limits.
  const kindFacts =
    kind === DETERMINISTIC_EXECUTION_KIND
      ? (() => {
          const deterministic = decodeRowDeterministicFacts(row);
          return {
            boundCommands: deterministic.commands,
            boundDeterministicBudgets: deterministic.budgets,
            boundExecutionPolicy: deterministic.executionPolicy,
          };
        })()
      : {
          boundConfig: Object.freeze({
            tool: row.bound_tool as LoopWorkerConfig["tool"],
            model: row.bound_model as string,
            ...(row.bound_effort === null ? {} : { effort: row.bound_effort }),
          }) as LoopWorkerConfig,
        };
  const facts: ApprovedPrestartFacts = {
    reservationId: row.reservation_id,
    reservationVersion: row.version,
    planId: row.plan_id,
    loopId: row.loop_id,
    iteration: row.iteration,
    slot: row.slot as HostExecutionSlot,
    executionKind: kind,
    role: row.role as FactoryRole,
    workItemId: row.work_item_id,
    specRevision: row.spec_revision,
    registryPrincipalId: row.registry_principal_id,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.target_run_id === null ? {} : { targetRunId: row.target_run_id }),
    ...kindFacts,
    boundWorkspaceRoot: row.bound_workspace_root,
    claimActionId: row.claim_action_id,
    claimAttempt: row.claim_attempt,
    ticketDigest: row.ticket_digest,
    preparedAt: row.prepared_at,
    state: row.state as ApprovedPrestartFacts["state"],
  };
  return Object.freeze(facts);
}

/**
 * Builds this authority's own retained `ApprovedPrestartRecord` strictly
 * from what `prepare()` persisted for this SAME row — never from anything a
 * current caller asserts. `ticket`/`ticketDigest` are the persisted
 * candidate and its digest; the remaining fields are the exact approved
 * facts captured at `prepare()` time (principal, role, work item, spec
 * revision, acceptance criteria, dependencies, target run, scope, model,
 * budgets) for `resolveApprovedPrestart`'s own current-snapshot comparison.
 */
function recordOf(row: Row): ApprovedExecutionPrestartRecord {
  const common = {
    ticketDigest: row.ticket_digest,
    approvedPrincipalId: row.registry_principal_id,
    approvedRole: row.role as FactoryRole,
    approvedWorkItemId: row.work_item_id,
    approvedSpecRevision: row.spec_revision,
    approvedAcceptanceCriteria: JSON.parse(row.approved_criteria_json) as readonly PrestartAcceptanceCriterion[],
    approvedDependencyWorkItemIds: JSON.parse(row.approved_dependency_ids_json) as readonly WorkItemId[],
    ...(row.target_run_id === null ? {} : { approvedTargetRunId: row.target_run_id }),
  };

  // The retained row's OWN persisted kind selects the record member, and each
  // member carries only its own approved facts: the deterministic record has
  // no `approvedModel`/`approvedBudgets` KEY at all (the accepted resolver
  // refuses a deterministic record that carries either), and the AI record is
  // completely unchanged.
  if (rowExecutionKind(row) === DETERMINISTIC_EXECUTION_KIND) {
    const ticket = JSON.parse(row.ticket_json) as DeterministicExecutionTicket;
    const deterministic = decodeRowDeterministicFacts(row);
    const record: ApprovedDeterministicPrestartRecord = {
      executionKind: DETERMINISTIC_EXECUTION_KIND,
      ticket,
      ...common,
      approvedScope: ticket.scope,
      approvedCommands: deterministic.commands,
      approvedWorkspace: row.bound_workspace_root,
      approvedDeterministicBudgets: deterministic.budgets,
      approvedExecutionPolicy: deterministic.executionPolicy,
    };
    return record;
  }

  const ticket = JSON.parse(row.ticket_json) as WorkerTicket;
  const record: ApprovedPrestartRecord = {
    ticket,
    ...common,
    approvedScope: ticket.scope,
    approvedModel: ticket.model,
    approvedBudgets: ticket.budgets,
  };
  return record;
}

function reservationId(loopId: string, iteration: number, slot: HostExecutionSlot): string {
  return `host-rsv:${loopId}:i${iteration}:${slot}`;
}

function findIteration(loop: EngineeringLoop, iteration: number): LoopIterationRecord {
  const record = loop.iterations.find((entry) => entry.iteration === iteration);
  if (record === undefined) {
    fail(`loop ${loop.id} has no iteration ${iteration}`);
  }
  return record;
}

function findTemplate(
  snapshot: ApprovedExecutionSnapshot,
  planItemKey: string,
): WorkItemTicketTemplate {
  const templates = snapshot.execution.ticketTemplates ?? [];
  const template = templates.find((entry) => entry.planItemKey === planItemKey);
  if (template === undefined) {
    fail(`approved execution config carries no ticket template for plan item "${planItemKey}"`);
  }
  return template;
}

/**
 * The genuine FULL set of approved facts for one work item, derived from the
 * PHASE7-97 snapshot's own approved items + materialization mappings +
 * approved execution config/template. Nothing here is read from the Factory
 * store or from a request: this is what the approval SAYS the item must be,
 * so the current store contents can be compared against it instead of being
 * retained as if they were the approval.
 */
interface ApprovedItemFacts {
  readonly planItemKey: string;
  /** The approved plan item itself, carrying the approved spec and criteria. */
  readonly plannedItem: PlannedWorkItem;
  /** The complete approved materialized shape, including dependency order. */
  readonly expectedShape: MaterializedItemShape;
  readonly expectedFingerprint: string;
  readonly template: WorkItemTicketTemplate;
}

/**
 * Derives the approved facts for `workItemId` the way the accepted plan
 * binding resolver does: membership from the durable materialization
 * mapping, the canonical correlation tag, the approved revision's own item,
 * every dependency resolved through the SAME mapping table (an unmaterialized
 * dependency refuses rather than being dropped), and the single canonical
 * `expectedMaterializedItemShape`. The approved ticket template for that
 * exact plan item key comes from the approved execution config.
 */
function approvedItemFacts(
  snapshot: ApprovedExecutionSnapshot,
  workItemId: WorkItemId,
): ApprovedItemFacts {
  const mapping = snapshot.materialized.find((entry) => entry.workItemId === workItemId);
  if (mapping === undefined) {
    fail(`work item ${workItemId} is not a materialized target of the approved plan`);
  }
  const expectedTag = canonicalCorrelationTag(snapshot.planId, snapshot.approvedRevision, mapping.planItemKey);
  if (mapping.correlationTag !== expectedTag) {
    fail(
      `approved materialization mapping tag "${mapping.correlationTag}" is not the canonical "${expectedTag}"`,
    );
  }
  const plannedItem = snapshot.items.find((entry) => entry.key === mapping.planItemKey);
  if (plannedItem === undefined) {
    fail(`approved revision ${snapshot.approvedRevision} has no plan item "${mapping.planItemKey}"`);
  }
  const dependencyWorkItemIds: WorkItemId[] = [];
  for (const dependencyKey of plannedItem.dependsOn) {
    const dependency = snapshot.materialized.find((entry) => entry.planItemKey === dependencyKey);
    if (dependency === undefined) {
      fail(`approved dependency "${dependencyKey}" of "${mapping.planItemKey}" is not materialized`);
    }
    dependencyWorkItemIds.push(dependency.workItemId);
  }
  const expectedShape = expectedMaterializedItemShape(
    snapshot.projectId,
    expectedTag,
    plannedItem,
    dependencyWorkItemIds,
  );
  return {
    planItemKey: mapping.planItemKey,
    plannedItem,
    expectedShape,
    expectedFingerprint: materializedItemFingerprint(expectedShape),
    template: findTemplate(snapshot, mapping.planItemKey),
  };
}

/**
 * The CURRENT materialized shape of a work item, assembled from the live
 * store exactly as the approved shape is defined — same field set, same
 * dependency ORDER (a sequence, not a set), same criterion order — so
 * `compareMaterializedItemShape` can refuse any materialization, spec,
 * content, criteria or dependency drift field-by-field with a fingerprint
 * backstop, instead of this adapter comparing a criterion count.
 *
 * Domain criteria are projected onto exactly the two fields the approved
 * shape defines (`text`, `verificationHint`); no `version`/`description` is
 * invented for a domain criterion.
 */
function currentMaterializedShape(
  item: WorkItem,
  criteria: readonly AcceptanceCriterion[],
): MaterializedItemShape {
  return {
    projectId: item.projectId,
    correlationTag: item.planVersion,
    title: item.title,
    type: item.type,
    priority: item.priority,
    specRevision: item.specRevision,
    dependencyWorkItemIds: [...item.dependencies],
    acceptanceCriteria: orderedCriteria(item, criteria).map((criterion) => ({
      text: criterion.text,
      verificationHint: criterion.verificationHint,
    })),
  };
}

/**
 * Criteria in the work item's OWN recorded `acceptanceCriteriaIds` order,
 * which is the order materialization wrote them in — `listByWorkItem` makes
 * no ordering promise, and comparing an arbitrary order against the approved
 * sequence would produce spurious drift (or, worse, hide a real reordering).
 * A criterion referenced by the item but missing from the store, or stored
 * against this item but unreferenced by it, refuses closed.
 */
function orderedCriteria(
  item: WorkItem,
  criteria: readonly AcceptanceCriterion[],
): readonly AcceptanceCriterion[] {
  if (criteria.length !== item.acceptanceCriteriaIds.length) {
    fail(
      `work item ${item.id} stores ${criteria.length} acceptance criteria but references ${item.acceptanceCriteriaIds.length}`,
    );
  }
  return item.acceptanceCriteriaIds.map((criterionId) => {
    const found = criteria.find((criterion) => criterion.id === criterionId);
    if (found === undefined) {
      fail(`acceptance criterion ${criterionId} referenced by work item ${item.id} no longer exists`);
    }
    if (found.workItemId !== item.id) {
      fail(`acceptance criterion ${criterionId} belongs to a different work item`);
    }
    return found;
  });
}

/**
 * Narrows ONE retained criterion to the genuine domain shape `prepare()`
 * persisted (`orderedCriteria`, i.e. `AcceptanceCriterion`). The retained
 * union's other arm is the legacy ticket criterion, which this authority
 * never writes, and a missing index is a length/order drift: both refuse
 * closed here rather than being widened to `unknown` or cast away.
 */
function retainedDomainCriterion(
  retained: PrestartAcceptanceCriterion | undefined,
  index: number,
): AcceptanceCriterion {
  if (retained === undefined) {
    fail(`prepared binding retains no approved criterion at position ${index + 1}`);
  }
  if (!("text" in retained) || !("workItemId" in retained)) {
    fail(
      `prepared binding's approved criterion at position ${index + 1} is not this authority's retained domain criterion shape`,
    );
  }
  return retained;
}

/**
 * Proves the genuine current item/spec/criteria/dependencies are EXACTLY the
 * approved shape, and returns the approved fingerprint to retain. Any
 * unrelated materialization/spec/content/criteria/dependency drift refuses
 * before a prepared row can be created.
 */
function requireApprovedItemShape(
  facts: ApprovedItemFacts,
  item: WorkItem,
  criteria: readonly AcceptanceCriterion[],
): string {
  const comparison = compareMaterializedItemShape(facts.expectedShape, currentMaterializedShape(item, criteria));
  if (!comparison.ok) {
    fail(`current work item is no longer the approved materialization of "${facts.planItemKey}": ${comparison.reason}`);
  }
  return facts.expectedFingerprint;
}

/**
 * The approved execution configuration for one slot, read from the approved
 * execution config's own implementer/reviewer entry. Unknown slot mappings
 * refuse; VERIFY has no approved entry at all and is already refused by
 * `roleForSlot`.
 */
function approvedSlotConfig(
  snapshot: ApprovedExecutionSnapshot,
  slot: HostSupplierSlot,
): PlannerConfig {
  if (slot === "IMPLEMENT") {
    return snapshot.execution.implementer;
  }
  if (slot === "REVIEW") {
    return snapshot.execution.reviewer;
  }
  fail(`slot "${String(slot)}" has no approved execution configuration mapping; refusing to prepare`);
}

/**
 * Matches the host-captured binding configuration AND the loop's own
 * independently captured copy against the genuine approved execution config
 * for this slot: tool, model, reasoning effort and workspace root must all
 * agree exactly. A blank or absent approved tool/model refuses rather than
 * defaulting, and an approved `effort` the binding omits (or vice versa) is a
 * mismatch, not a tolerated absence.
 */
function requireMatchingActionConfig(
  slot: HostSupplierSlot,
  bound: BoundWorkerAction,
  loopConfig: LoopWorkerConfig,
  approved: PlannerConfig,
  approvedWorkspaceRoot: string,
): void {
  if (typeof approved.tool !== "string" || approved.tool.trim().length === 0) {
    fail(`approved execution config names no tool for the ${slot} slot`);
  }
  if (typeof approved.model !== "string" || approved.model.trim().length === 0) {
    fail(`approved execution config names no model for the ${slot} slot`);
  }
  if (bound.config.tool !== approved.tool) {
    fail(`host-bound ${slot} tool "${bound.config.tool}" is not the approved "${approved.tool}"`);
  }
  if (bound.config.model !== approved.model) {
    fail(`host-bound ${slot} model "${bound.config.model}" is not the approved "${approved.model}"`);
  }
  if (bound.config.effort !== approved.effort) {
    fail(`host-bound ${slot} reasoning effort does not exactly match the approved execution configuration`);
  }
  if (loopConfig === null || typeof loopConfig !== "object") {
    fail(`loop carries no ${slot} worker configuration`);
  }
  if (loopConfig.tool !== approved.tool) {
    fail(`live loop ${slot} tool "${String(loopConfig.tool)}" is not the approved "${approved.tool}"`);
  }
  if (loopConfig.model !== approved.model) {
    fail(`live loop ${slot} model "${loopConfig.model}" is not the approved "${approved.model}"`);
  }
  if (loopConfig.effort !== approved.effort) {
    fail(`live loop ${slot} reasoning effort does not exactly match the approved execution configuration`);
  }
  if (bound.workspaceRoot !== approvedWorkspaceRoot) {
    fail("host-bound workspace root is not the approved execution configuration's workspace root");
  }
}

/**
 * The approved ticket template must itself genuinely authorize this exact
 * action configuration: the bound model must be an approved eligible model
 * AND the template's own reasoning effort/rationale and scope/budgets must be
 * present and applicable. An ineligible or unmapped model refuses closed —
 * the template's `eligibleModels` is a policy set, so membership alone is not
 * accepted as the whole check: the policy's effort must also match the
 * configured effort the host actually bound.
 */
function requireApplicableModelPolicy(
  slot: HostSupplierSlot,
  ticket: WorkerTicket,
  bound: BoundWorkerAction,
): void {
  const policy = ticket.model;
  if (!policy.eligibleModels.includes(bound.config.model)) {
    fail(`host-bound ${slot} model "${bound.config.model}" is not among the approved ticket's eligible models`);
  }
  if (typeof policy.rationale !== "string" || policy.rationale.trim().length === 0) {
    fail(`approved ${slot} ticket model policy carries no rationale; refusing to prepare an unexplained binding`);
  }
  if (bound.config.effort !== undefined && bound.config.effort !== policy.reasoningEffort) {
    fail(
      `host-bound ${slot} reasoning effort "${bound.config.effort}" is not the approved ticket policy's "${policy.reasoningEffort}"`,
    );
  }
  if (ticket.scope.owned.length === 0) {
    fail(`approved ${slot} ticket grants no owned scope; refusing to prepare a scopeless binding`);
  }
  if (ticket.budgets.maxAttempts <= 0 || ticket.budgets.elapsedSeconds <= 0) {
    fail(`approved ${slot} ticket carries no usable budgets`);
  }
}

/**
 * Re-runs the strict accepted template checks: the unknown-nested-field table
 * (consulted BEFORE the accepted parser, so a smuggled `scope.grantAll` fails
 * the whole template rather than being quietly narrowed away) and then the
 * unchanged `parseWorkerTicket`/`computeTicketDigest`.
 *
 * The allowlist is applied to the ORIGINAL template, which is the shape
 * `findUnknownTicketTemplateFields` actually describes (`TICKET_TEMPLATE_FIELDS`
 * includes `planItemKey` and has no `ticketId`). Running it on the COMPOSED
 * candidate instead would reject the legitimate composed `ticketId` on every
 * valid template, so the strict unknown-field refusal happens first, before
 * composition, and still fails the whole template on any smuggled field.
 */
function strictTicketFromTemplate(template: WorkItemTicketTemplate, ticketId: string): {
  readonly ticket: WorkerTicket;
  readonly ticketDigest: string;
} {
  const unknown = findUnknownTicketTemplateFields(template as unknown as Record<string, unknown>);
  if (unknown !== undefined) {
    fail(`approved ticket template carries unrecognized field(s): ${unknown}`);
  }
  const candidate = candidateTicketFromTemplate(template, ticketId);
  const parsed = parseWorkerTicket(candidate);
  if (!parsed.ok) {
    fail(`approved template no longer composes a valid strict WorkerTicket: ${parsed.errors.join("; ")}`);
  }
  return { ticket: parsed.value, ticketDigest: computeTicketDigest(parsed.value) };
}

/**
 * The genuine APPROVED deterministic verification facts, read strictly from
 * the verified approved execution snapshot: the ordered
 * `verificationCommands`, the approved `workspaceRoot`, and the explicit
 * `verificationExecutionPolicy` (elapsedSeconds/outputBytes/maxAttempts plus
 * rationale).
 *
 * A MISSING or MALFORMED policy refuses outright. It is optional in the
 * persisted plan shape only so legacy plans stay readable; absence grants no
 * VERIFY authority, and nothing here is defaulted, derived from a loop
 * timeout, or converted from a token/result-byte budget. Each command's `cwd`
 * is resolved to an absolute path under the approved workspace root, because
 * the approved config stores it relative to that root while the deterministic
 * ticket's `commands[].cwd` is digest-bound; a `cwd` that escapes refuses.
 */
interface ApprovedVerificationFacts {
  readonly commands: readonly DeterministicCommand[];
  readonly workspaceRoot: string;
  readonly budgets: DeterministicBudgets;
  readonly executionPolicy: DeterministicExecutionPolicy;
}

function approvedVerificationFacts(snapshot: ApprovedExecutionSnapshot): ApprovedVerificationFacts {
  const execution = snapshot.execution;
  const workspaceRoot = execution.workspaceRoot;
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim().length === 0) {
    fail("approved execution configuration names no workspace root; refusing to prepare a VERIFY binding");
  }
  const approvedCommands = execution.verificationCommands;
  if (!Array.isArray(approvedCommands) || approvedCommands.length === 0) {
    fail("approved execution configuration carries no verification commands; refusing to prepare a VERIFY binding");
  }
  const policyCandidate = execution.verificationExecutionPolicy;
  if (policyCandidate === undefined || policyCandidate === null) {
    fail(
      "approved execution configuration carries no explicit verificationExecutionPolicy; a deterministic VERIFY binding requires independently approved elapsed/output/attempt limits and will not synthesize them",
    );
  }
  const validated = validateVerificationExecutionPolicy(policyCandidate);
  if (!validated.ok) {
    fail(`approved verificationExecutionPolicy is malformed: ${validated.reason}`);
  }

  const commands = approvedCommands.map((command, index) => {
    if (command === null || typeof command !== "object") {
      fail(`approved verification command ${index + 1} is not a command object`);
    }
    if (typeof command.executable !== "string" || command.executable.trim().length === 0) {
      fail(`approved verification command ${index + 1} names no executable`);
    }
    if (!Array.isArray(command.argv) || command.argv.some((arg: unknown) => typeof arg !== "string")) {
      fail(`approved verification command ${index + 1} has a malformed argv`);
    }
    // `cwd` is optional in the approved config and defaults to the workspace
    // root itself, exactly as the existing VerificationCommandConfig defines.
    const rawCwd = command.cwd === undefined ? "." : command.cwd;
    if (typeof rawCwd !== "string" || rawCwd.trim().length === 0) {
      fail(`approved verification command ${index + 1} has a malformed cwd`);
    }
    // Containment is validated against the approved workspace, but the result is
    // discarded: the approved literal cwd is retained so that bound/approved
    // equality and the ticket digest see the cwd that was actually approved.
    canonicalizeOwnedPath(workspaceRoot, rawCwd);
    return Object.freeze({
      executable: command.executable,
      argv: Object.freeze([...command.argv]) as readonly string[],
      cwd: rawCwd,
    }) as DeterministicCommand;
  });

  return {
    commands: Object.freeze(commands) as readonly DeterministicCommand[],
    workspaceRoot,
    budgets: validated.value.budgets,
    executionPolicy: validated.value.executionPolicy,
  };
}

/**
 * Matches the independently configured host VERIFY binding against the
 * genuine approved facts AND the live loop's own independently captured
 * `verificationCommands`/`workspaceRoot`. All three must agree exactly,
 * command order included. The approved copy retains its literal `cwd`; the
 * loop's copy is compared to it semantically, with both `cwd` values
 * canonicalized against the same approved workspace, so a relative/absolute
 * spelling difference is not mistaken for drift — and a genuinely different
 * executable, argv, order, root or limit still refuses.
 */
function requireMatchingVerificationConfig(
  bound: BoundDeterministicWorkerAction,
  loop: EngineeringLoop,
  approved: ApprovedVerificationFacts,
): void {
  if (bound.workspaceRoot !== approved.workspaceRoot) {
    fail("host-bound VERIFY workspace root is not the approved execution configuration's workspace root");
  }
  if (loop.workspaceRoot !== approved.workspaceRoot) {
    fail("live loop workspace root is not the approved execution configuration's workspace root");
  }
  if (!sameCommandSequence(bound.commands, approved.commands)) {
    fail(
      "host-bound VERIFY command sequence is not exactly the approved ordered verificationCommands (order, executable, argv and cwd all significant)",
    );
  }
  const loopCommands = loop.verificationCommands;
  if (!Array.isArray(loopCommands) || loopCommands.length !== approved.commands.length) {
    fail("live loop verification command sequence does not match the approved verificationCommands");
  }
  loopCommands.forEach((command, index) => {
    const approvedCommand = approved.commands[index];
    if (approvedCommand === undefined) {
      fail(`live loop verification command ${index + 1} has no approved counterpart`);
    }
    if (command === null || typeof command !== "object") {
      fail(`live loop verification command ${index + 1} is not a command object`);
    }
    if (command.executable !== approvedCommand.executable) {
      fail(`live loop verification command ${index + 1} executable is not the approved executable`);
    }
    if (
      !Array.isArray(command.argv) ||
      command.argv.length !== approvedCommand.argv.length ||
      command.argv.some((arg: unknown, argIndex: number) => arg !== approvedCommand.argv[argIndex])
    ) {
      fail(`live loop verification command ${index + 1} argv is not the approved argv`);
    }
    const loopCwd = canonicalizeOwnedPath(approved.workspaceRoot, command.cwd === undefined ? "." : command.cwd);
    if (loopCwd !== canonicalizeOwnedPath(approved.workspaceRoot, approvedCommand.cwd)) {
      fail(`live loop verification command ${index + 1} cwd is not the approved cwd`);
    }
  });
  if (!sameDeterministicBudgets(bound.budgets, approved.budgets)) {
    fail(
      "host-bound VERIFY process limits are not the approved verificationExecutionPolicy budgets; elapsed/output/attempt capacity is never derived or negotiated here",
    );
  }
  if (bound.executionPolicy.rationale !== approved.executionPolicy.rationale) {
    fail("host-bound VERIFY executionPolicy rationale is not the approved rationale");
  }
}

/**
 * Composes and STRICTLY parses the deterministic execution ticket for a
 * VERIFY binding through the accepted
 * `parseDeterministicExecutionTicket`/`computeDeterministicExecutionTicketDigest`
 * — never the AI parser, and no parallel schema or canonicalizer.
 *
 * The common item/scope/acceptance/policy facts come from the actual verified
 * approved template for the materialized item (objective, acceptance
 * criteria, scope, control policy, result schema), NOT from a caller ticket;
 * only the command/workspace/budget/executionPolicy fields come from the
 * approved verification facts. The template's own `model`/`budgets` are
 * deliberately NOT carried over: a deterministic ticket has no model policy
 * and its budgets are the independently approved process limits.
 */
function strictDeterministicTicket(
  template: WorkItemTicketTemplate,
  ticketId: string,
  approved: ApprovedVerificationFacts,
): { readonly ticket: DeterministicExecutionTicket; readonly ticketDigest: string } {
  const unknown = findUnknownTicketTemplateFields(template as unknown as Record<string, unknown>);
  if (unknown !== undefined) {
    fail(`approved ticket template carries unrecognized field(s): ${unknown}`);
  }
  const candidate = {
    schemaVersion: DETERMINISTIC_TICKET_SCHEMA_VERSION,
    kind: DETERMINISTIC_EXECUTION_KIND,
    ticketId,
    objective: template.objective,
    acceptanceCriteria: template.acceptanceCriteria,
    scope: template.scope,
    commands: approved.commands,
    workspace: approved.workspaceRoot,
    budgets: approved.budgets,
    executionPolicy: approved.executionPolicy,
    policy: template.policy,
    resultSchema: {
      requiredFields: template.resultSchema.requiredFields,
      maxResultBytes: MAX_RESULT_BYTES,
    },
  };
  const parsed = parseDeterministicExecutionTicket(candidate);
  if (!parsed.ok) {
    fail(
      `approved template and verification policy do not compose a valid strict deterministic ticket: ${parsed.errors.join("; ")}`,
    );
  }
  return {
    ticket: parsed.value,
    ticketDigest: computeDeterministicExecutionTicketDigest(parsed.value),
  };
}

/** The active action claim for one slot, with its canonical identity proven. */
function requireActiveClaim(
  loopId: string,
  iteration: number,
  slot: HostExecutionSlot,
  iterationRecord: LoopIterationRecord,
): WorkerActionClaim {
  const claim =
    slot === "IMPLEMENT"
      ? iterationRecord.implementClaim
      : slot === "VERIFY"
        ? iterationRecord.verifyClaim
        : iterationRecord.reviewClaim;
  if (claim === undefined) {
    fail(`loop ${loopId} iteration ${iteration} has no ${slot} action claim`);
  }
  const expectedActionId = canonicalActionId(loopId, iteration, slot);
  if (claim.actionId !== expectedActionId) {
    fail(`${slot} action claim actionId is not the canonical identity for this iteration`);
  }
  if (claim.kind !== slot) {
    fail(`${slot} action claim records kind "${claim.kind}"`);
  }
  if (!Number.isSafeInteger(claim.attempt) || claim.attempt < 1) {
    fail(`${slot} action claim carries no valid attempt number`);
  }
  if (typeof claim.ownerToken !== "string" || claim.ownerToken.length === 0) {
    fail(`${slot} action claim has no owner; refusing to treat it as an active claim`);
  }
  return claim;
}

export class SqliteDirectHostAuthority
  implements
    PreparedReservationLookup,
    DirectHostAuthorityPort<DirectHostExecutionLaunchRequest, DirectHostExecutionLaunchGrant>,
    ApprovedPrestartPort<RetainedExecutionPrestartRecord>
{
  private readonly planning: SqliteDirectHostAuthorityDeps["planning"];
  private readonly store: FactoryStore;
  private readonly loops: LoopRepository;
  private readonly registry: WorkerRegistry;
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly capability: CapabilityCallback;
  /**
   * The separate trusted deterministic seam. Present only when the host
   * actually supplied one; the deterministic branch requires it and never
   * falls back to `capability` (the AI validator) with deterministic data.
   */
  private readonly deterministicCapability?: DeterministicCapabilityCallback;
  private readonly maxEvidenceAgeSeconds: number;
  private readonly statements: Statements;
  /**
   * Stable identity of THIS constructed authority instance, persisted on
   * every row it writes. Required and validated non-blank by the
   * constructor — there is no shared default constant two independently
   * constructed authorities could collide on. Reopening the same SQLite file
   * with a FRESH authority instance (new registry, new capability callback)
   * under the SAME caller-chosen identity keeps rows recognizable across
   * close/reopen, while a DIFFERENT authority identity sharing the same
   * database file can never read, reserve, consume or cancel rows it did not
   * itself write.
   */
  private readonly authorityId: string;
  /**
   * The host-composed, constructor-frozen Worker-object bindings. Keyed by
   * OBJECT IDENTITY, so neither a request nor a persisted row can introduce
   * a Worker object or re-point one at a different configuration: a reopened
   * authority is constructed with a FRESH composition and therefore requires
   * fresh object/config rebinding plus a fresh `prepare()` — a persisted row
   * is never rehydrated into a binding.
   */
  private readonly boundWorkers: BoundWorkerIndex;
  /**
   * Per-reservation record of which host-composed binding `prepare()` bound,
   * so every later async revalidation re-reads the SAME constructor-captured
   * object/config rather than re-deriving it from the row. Populated only by
   * `prepare()` in THIS process; a reopened authority starts empty, so a
   * persisted row alone can never resolve to an in-process binding.
   */
  private readonly preparedBindings = new Map<string, BoundExecutionWorkerAction>();

  constructor(deps: SqliteDirectHostAuthorityDeps) {
    if (typeof deps.authorityId !== "string" || deps.authorityId.trim().length === 0) {
      fail("authorityId is required and must be a non-blank trusted host constructor identity");
    }
    this.planning = deps.planning;
    this.store = deps.store;
    this.loops = deps.loops;
    this.registry = deps.registry;
    this.db = deps.db;
    this.clock = deps.clock;
    this.capability = deps.capability;
    this.maxEvidenceAgeSeconds = deps.maxEvidenceAgeSeconds ?? 300;
    this.authorityId = deps.authorityId;
    this.boundWorkers = indexBoundWorkers(deps.boundWorkers);
    // A deterministic binding is inert without its own genuine process
    // capability seam. Refusing HERE — at composition, not at launch — means
    // a VERIFY binding can never exist in this authority while the only
    // available validator is the AI one.
    const hasDeterministicBinding = [...this.boundWorkers.values()].some((binding) =>
      isDeterministicBinding(binding),
    );
    if (hasDeterministicBinding && typeof deps.deterministicCapability !== "function") {
      fail(
        "a host-composed deterministic VERIFY binding requires its own trusted deterministic capability callback; the AI capability validator is never called with deterministic data",
      );
    }
    if (deps.deterministicCapability !== undefined) {
      this.deterministicCapability = deps.deterministicCapability;
    }
    ensureSchema(this.db);
    this.statements = prepareStatements(this.db);
  }

  // ===========================================================================
  // Host-only preparation
  // ===========================================================================

  /**
   * Host-only async preparation. Re-verifies current approval, re-reads the
   * live loop/iteration, derives role from the slot, binds the EXACT
   * registered Worker object via `principalFor` (never from Worker.id), and
   * composes+parses the candidate ticket from the approved template using the
   * unchanged `candidateTicketFromTemplate` + strict parser/digest. Persists
   * one immutable PREPARED row per (loopId, iteration, slot); re-preparing the
   * SAME coordinates after a reopen requires a fresh call and a fresh
   * registry-object rebinding — a prior row is never reused as ongoing
   * authority.
   */
  async prepare(input: PrepareHostBindingInput): Promise<ApprovedPrestartFacts> {
    const role = roleForSlot(input.slot);

    // HOST-ONLY BINDING SELECTION. The exact guarded Worker object and its
    // configured tool/model/effort/workspace come from this authority's
    // constructor composition, resolved by OBJECT IDENTITY. A request can
    // therefore neither introduce a Worker the host never composed nor
    // re-point a composed one at a different configuration: it can only name
    // one that already exists. Nothing below reads `Worker.id` or
    // `worker.capabilities` for any authority decision.
    const bound = this.boundWorkers.get(input.worker);
    if (bound === undefined) {
      fail("this Worker object is not one of this authority's host-composed bindings; a request may never mint authority");
    }
    if (bound.slot !== input.slot) {
      fail(
        `this Worker object is host-bound to the ${bound.slot} slot and may not be rebound to ${input.slot}`,
      );
    }

    const loop = await this.loops.findById(input.loopId);
    if (loop === undefined) {
      fail(`loop ${input.loopId} does not exist`);
    }
    if (loop.cancelRequested) {
      fail(`loop ${input.loopId} has a durable cancellation request; refusing to prepare a new host binding`);
    }
    if (isTerminalLoopPhase(loop.phase)) {
      fail(`loop ${input.loopId} is in terminal phase ${loop.phase}; refusing to prepare a host binding`);
    }
    if (!ACTIVE_LOOP_PHASES.includes(loop.phase)) {
      fail(`loop ${input.loopId} phase ${loop.phase} is not an active loop phase`);
    }
    // Only the loop's CURRENT iteration may be prepared: a prepared binding for
    // a superseded iteration would authorize work the loop has already moved past.
    const currentIteration = loop.iterations.at(-1)?.iteration;
    if (currentIteration === undefined || currentIteration !== input.iteration) {
      fail(
        `loop ${input.loopId} is on iteration ${String(currentIteration)}, not the requested ${input.iteration}`,
      );
    }
    const iterationRecord = findIteration(loop, input.iteration);
    const claim = requireActiveClaim(input.loopId, input.iteration, input.slot, iterationRecord);

    // Independent target derivation (VERIFY and REVIEW): the exact
    // implementer run this SAME iteration recorded, and only if it
    // succeeded. Never a caller-named target and never "the latest run".
    // This covers only this derivation branch; other preparation, storage
    // and lifecycle seams are not claimed complete here.
    let targetRunId: RunId | undefined;
    let targetRun: Run | undefined;
    if (input.slot === "VERIFY" || input.slot === "REVIEW") {
      const implementerRunId = iterationRecord.implementerRunId;
      if (implementerRunId === undefined) {
        fail(`loop ${input.loopId} iteration ${input.iteration} has no implementer run to review`);
      }
      const implementerRun = await this.store.runs.findById(implementerRunId);
      if (implementerRun === undefined) {
        fail(`implementer run ${implementerRunId} no longer exists`);
      }
      if (implementerRun.status !== "SUCCEEDED") {
        fail(`implementer run ${implementerRunId} did not succeed; refusing to prepare a review binding`);
      }
      if (implementerRun.workItemId !== loop.workItemId) {
        fail(`implementer run ${implementerRunId} targets a different work item than this loop`);
      }
      if (implementerRun.role !== "IMPLEMENTER") {
        fail(`run ${implementerRunId} is not an IMPLEMENTER run; refusing to prepare a review binding against it`);
      }
      targetRunId = implementerRunId;
      targetRun = implementerRun;
    }

    // Registry object identity/roles ONLY — never a model, tool or provider.
    const principal = this.registry.principalFor(input.worker);
    if (!principal.roles.includes(role)) {
      fail(`registered worker principal is not trusted for role ${role}`);
    }
    const id = reservationId(input.loopId, input.iteration, input.slot);

    if (targetRun !== undefined) {
      // Independence is decided between two INDEPENDENTLY REGISTERED
      // principals, never between self-reported worker ids.
      if (targetRun.workerPrincipalId === principal.principalId) {
        fail("reviewer principal is not independent of the implementer it would review");
      }
      if (this.registry.findByPrincipalId(targetRun.workerPrincipalId) === undefined) {
        fail("the implementer run's principal is not known to this registry; cannot prove reviewer independence");
      }
    }

    // GENUINE APPROVED FACTS. Derived from the PHASE7-97 snapshot's own
    // approved items + materialization mappings + approved execution config
    // and template — not from whatever the current store happens to hold.
    const snapshot = await this.planning.verifiedApprovedExecutionSnapshot(input.planId);
    const approved = approvedItemFacts(snapshot, loop.workItemId);

    const item = await this.store.workItems.findById(loop.workItemId);
    if (item === undefined) {
      fail(`work item ${loop.workItemId} no longer exists`);
    }
    const criteria: readonly AcceptanceCriterion[] = await this.store.criteria.listByWorkItem(loop.workItemId);

    // Full-shape comparison of the CURRENT item/spec/criteria/dependencies
    // against the APPROVED shape, field-by-field with a fingerprint backstop.
    // Any unrelated materialization/spec/content/criteria/dependency drift
    // refuses here, before any prepared row exists.
    const approvedFingerprint = requireApprovedItemShape(approved, item, criteria);

    // The implementation under review must be the implementation OF THE SAME
    // approved spec this preparation just proved current. A target run recorded
    // against an earlier specRevision is a different piece of work, so a review
    // binding against it is refused rather than silently inheriting it.
    if (targetRun !== undefined && targetRun.specRevision !== item.specRevision) {
      fail(
        `implementer run ${targetRun.id} ran against specRevision ${targetRun.specRevision}, not the current approved ${item.specRevision}`,
      );
    }

    const ticketId = `${input.loopId}:i${input.iteration}:${input.slot}`;

    // Discriminated preparation. The branch is selected by the
    // constructor-captured binding's own discriminator, never by a caller
    // claim alone: VERIFY requires a deterministic bound object and the AI
    // slots require an AI bound object.
    const { ticket, ticketDigest } = (() => {
      if (isDeterministicBinding(bound)) {
        if (input.slot !== "VERIFY") {
          return fail("deterministic binding is only valid for the VERIFY slot");
        }
        const approvedFacts = approvedVerificationFacts(snapshot);
        requireMatchingVerificationConfig(bound, loop, approvedFacts);
        if (claim.attempt > approvedFacts.budgets.maxAttempts) {
          return fail("claim attempt exceeds the approved verification attempt budget");
        }
        return strictDeterministicTicket(approved.template, ticketId, approvedFacts);
      }

      if (input.slot === "VERIFY") {
        return fail("VERIFY slot requires a deterministic bound object");
      }
      const aiPrepared = strictTicketFromTemplate(approved.template, ticketId);

      // The host-captured configuration AND the loop's own independently
      // captured copy must both equal the approved execution configuration for
      // this slot; the approved ticket's model policy must then genuinely
      // authorize exactly that configuration.
      const loopWorkerConfig = input.slot === "IMPLEMENT" ? loop.implementer : loop.reviewer;
      requireMatchingActionConfig(
        input.slot,
        bound,
        loopWorkerConfig,
        approvedSlotConfig(snapshot, input.slot),
        snapshot.execution.workspaceRoot,
      );
      requireApplicableModelPolicy(input.slot, aiPrepared.ticket, bound);
      return aiPrepared;
    })();

    if (loop.workspaceRoot !== bound.workspaceRoot) {
      fail("live loop workspace root is not the host-bound approved workspace root");
    }

    const canonicalOwnedPaths = ticket.scope.owned.map((path) => canonicalizeOwnedPath(bound.workspaceRoot, path));

    const preparedAt = this.clock.now();

    let freshRow: Row;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.statements.findById.get(id, this.authorityId);
      if (existing !== undefined) {
        this.db.exec("ROLLBACK");
        fail(`reservation ${id} already prepared; reopen requires a fresh registry rebinding under new coordinates, never reuse of a persisted snapshot`);
      }
      // Stored owned paths are ALREADY canonical absolute paths, written by
      // this same preparation path under their OWN binding's workspace root.
      // They are compared directly: re-canonicalizing them under the current
      // root would throw for a genuinely disjoint root instead of correctly
      // reporting no overlap.
      const activeRows = decodeOwnedPathRows(this.statements.findActiveOwnedPaths.all(id));
      const activeCanonicalPaths = activeRows.flatMap((row) =>
        decodeCanonicalPathList(row.owned_paths_json, row.reservation_id),
      );
      const overlap = anyPathsOverlap(canonicalOwnedPaths, activeCanonicalPaths);
      if (overlap !== undefined) {
        this.db.exec("ROLLBACK");
        fail(`requested owned scope overlaps an existing active reservation's owned scope: ${overlap}`);
      }
      // Deterministic rows need the widened schema; refuse (never relax or
      // migrate) when this database cannot store them.
      if (isDeterministicBinding(bound)) {
        const storageRefusal = deterministicStorageRefusal(this.db);
        if (storageRefusal !== undefined) {
          fail(storageRefusal);
        }
      }

      this.statements.insert.run(
        id,
        this.authorityId,
        input.planId,
        input.loopId,
        input.iteration,
        input.slot,
        role,
        loop.workItemId,
        item.specRevision,
        principal.principalId,
        // run_id is fixed to NULL by the statement itself: preparation is
        // runless and the run attaches at reserve().
        targetRunId ?? null,
        ticketDigest,
        JSON.stringify(ticket),
        JSON.stringify(canonicalOwnedPaths),
        // The APPROVED criteria this preparation proved the current ones
        // equal — retained in the work item's own recorded order, as genuine
        // domain criteria with no invented version/description.
        JSON.stringify(orderedCriteria(item, criteria)),
        JSON.stringify(approved.expectedShape.dependencyWorkItemIds),
        approvedFingerprint,
        isDeterministicBinding(bound) ? DETERMINISTIC_EXECUTION_KIND : "ai",
        // Deterministic rows carry genuine NULL tool/model/effort.
        isDeterministicBinding(bound) ? null : bound.config.tool,
        isDeterministicBinding(bound) ? null : bound.config.model,
        isDeterministicBinding(bound) ? null : (bound.config.effort ?? null),
        bound.workspaceRoot,
        isDeterministicBinding(bound) ? JSON.stringify(bound.commands) : null,
        isDeterministicBinding(bound) ? JSON.stringify(bound.budgets) : null,
        isDeterministicBinding(bound) ? JSON.stringify(bound.executionPolicy) : null,
        claim.actionId,
        claim.attempt,
        claim.ownerToken,
        preparedAt,
        // state fixed to 'PREPARED' by the statement itself
      );
      freshRow = decodeRow(this.statements.findById.get(id, this.authorityId));
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing staged to roll back if BEGIN itself never completed.
      }
      throw error;
    }

    // Records WHICH host-composed binding this reservation is bound to, so
    // every later async revalidation re-reads the same constructor-captured
    // object/config instead of trusting the row's own copy of it.
    this.preparedBindings.set(id, bound);

    return rowToFacts(freshRow);
  }

  /**
   * The host-composed binding this process prepared for `reservationId`.
   *
   * Fails closed when absent: a persisted row is a RECORD, never ongoing
   * authority, so a reopened authority (or one constructed with a different
   * composition) cannot act on a row it did not itself prepare in this
   * process — it must re-compose the Worker object/config and call
   * `prepare()` again.
   */
  private requireBoundAction(reservationId: string): BoundExecutionWorkerAction {
    const bound = this.preparedBindings.get(reservationId);
    if (bound === undefined) {
      fail(
        `reservation ${reservationId} has no host-composed Worker binding in this process; reopen requires fresh object/config rebinding and a fresh preparation`,
      );
    }
    if (this.boundWorkers.get(bound.worker) !== bound) {
      fail(`reservation ${reservationId} no longer resolves to this authority's host-composed binding`);
    }
    return bound;
  }

  // ===========================================================================
  // ApprovedPrestartPort (synchronous, point-in-time)
  // ===========================================================================

  /**
   * The ONLY row either synchronous reader may expose: this authority's own
   * still-PREPARED row whose host-composed Worker/config binding genuinely
   * exists in THIS process. A retired/cancelled/consumed/already-reserved row,
   * and a persisted row with no live in-process rebinding, are both reported
   * as an entirely unknown reference — a persisted id never reconstructs
   * Worker object authority.
   */
  private eligiblePreparedRow(reference: string): Row | undefined {
    const raw = this.statements.findById.get(reference, this.authorityId);
    if (raw === undefined) {
      return undefined;
    }
    const row = decodeRow(raw);
    if (row.state !== "PREPARED") {
      return undefined;
    }
    const bound = this.preparedBindings.get(reference);
    if (bound === undefined || this.boundWorkers.get(bound.worker) !== bound) {
      return undefined;
    }
    if (bound.slot !== row.slot) {
      return undefined;
    }
    return row;
  }

  lookup(reservationId: string): ApprovedPrestartFacts | undefined {
    const row = this.eligiblePreparedRow(reservationId);
    if (row === undefined) {
      return undefined;
    }
    return deepFreezeCopy(rowToFacts(row));
  }

  /**
   * This authority's own `ApprovedPrestartPort` surface: resolves strictly
   * against its OWN persisted row for `reference` (the reservation id this
   * SAME authority issued at `prepare()`), never against anything a current
   * caller presents. Unknown reference, or a row not owned by this exact
   * authority, is reported as an entirely unknown reference (`undefined`) —
   * never silently reinterpreted as "unapproved".
   */
  resolveApprovedPrestart(reference: string): RetainedExecutionPrestartRecord | undefined {
    const row = this.eligiblePreparedRow(reference);
    if (row === undefined) {
      return undefined;
    }
    return Object.freeze({
      disposition: "approved",
      approval: deepFreezeCopy(recordOf(row)),
    }) as RetainedExecutionPrestartRecord;
  }

  // ===========================================================================
  // DirectHostAuthorityPort
  // ===========================================================================

  /**
   * The completed current pipeline every mutating/readiness path runs before
   * acting. It re-derives authority from scratch rather than trusting the row:
   *
   *   - the host-composed binding for THIS reservation, and `principalFor` on
   *     that SAME captured Worker object (object identity, not a stored id);
   *   - the live approved snapshot's own approved item facts, re-compared
   *     field-by-field (ordered criteria AND ordered dependencies, never a
   *     count) against the current store, with the prepared fingerprint as the
   *     backstop;
   *   - the strict template allowlist/parser/digest, which must still produce
   *     exactly the prepared digest;
   *   - the approved execution config, the live loop's own config copy and the
   *     persisted bound tool/model/effort/workspace, all in agreement;
   *   - the FULL persisted claim tuple (actionId/attempt/ownerToken) against
   *     the current canonical active claim, so a takeover re-claim is refused;
   *   - terminal/inactive loop, terminal action and durable cancellation,
   *     refused for a RESERVED row too — not only before reservation;
   *   - for a RESERVED/CONSUMED row, the exact attached run and target.
   */
  private async requireLiveRow(reservationId: string): Promise<Row> {
    const raw = this.statements.findById.get(reservationId, this.authorityId);
    if (raw === undefined) {
      fail(`reservation ${reservationId} is unknown to this host authority`);
    }
    const row = decodeRow(raw);
    const slot = row.slot as HostExecutionSlot;
    const role = row.role as FactoryRole;
    if (role !== roleForSlot(slot)) {
      fail(`persisted role "${row.role}" is not the only legitimate role for slot "${row.slot}"`);
    }

    // HOST-COMPOSED BINDING, not the row's own copy of it. `principalFor` is
    // called on the EXACT captured Worker object, so identity comes from the
    // registry and the object, never from `registry_principal_id` alone.
    const bound = this.requireBoundAction(reservationId);
    if (bound.slot !== slot) {
      fail(`reservation ${reservationId} resolves to a ${bound.slot}-slot binding, not ${row.slot}`);
    }
    const principal = this.registry.principalFor(bound.worker);
    if (principal.principalId !== row.registry_principal_id) {
      fail("the host-bound Worker object's registry principal is not the prepared binding's principal");
    }
    if (!principal.roles.includes(role)) {
      fail("registered worker principal is no longer trusted for this binding's role");
    }
    // The persisted execution kind must equal the captured binding's own
    // real kind; nothing is derived from the row to grant authority.
    const boundKind = isDeterministicBinding(bound) ? DETERMINISTIC_EXECUTION_KIND : "ai";
    if (rowExecutionKind(row) !== boundKind) {
      fail("host-composed binding execution kind no longer matches the persisted execution kind");
    }
    if (isDeterministicBinding(bound)) {
      const persistedFacts = decodeRowDeterministicFacts(row);
      if (!sameCommandSequence(bound.commands, persistedFacts.commands)) {
        fail("host-composed binding commands no longer match the persisted bound commands");
      }
      if (!sameDeterministicBudgets(bound.budgets, persistedFacts.budgets)) {
        fail("host-composed binding budgets no longer match the persisted bound budgets");
      }
      if (bound.executionPolicy.rationale !== persistedFacts.executionPolicy.rationale) {
        fail("host-composed binding execution policy no longer matches the persisted execution policy");
      }
    } else {
      if (bound.config.tool !== row.bound_tool || bound.config.model !== row.bound_model) {
        fail("host-composed binding tool/model no longer matches the persisted bound configuration");
      }
      if ((bound.config.effort ?? null) !== row.bound_effort) {
        fail("host-composed binding reasoning effort no longer matches the persisted bound configuration");
      }
    }
    if (bound.workspaceRoot !== row.bound_workspace_root) {
      fail("host-composed binding workspace root no longer matches the persisted bound configuration");
    }

    // Live approval, re-derived as the FULL approved fact set.
    const snapshot = await this.planning.verifiedApprovedExecutionSnapshot(row.plan_id);
    const approved = approvedItemFacts(snapshot, row.work_item_id);

    const item = await this.store.workItems.findById(row.work_item_id);
    if (item === undefined) {
      fail(`work item ${row.work_item_id} no longer exists`);
    }
    if (item.specRevision !== row.spec_revision) {
      fail("live work item specRevision has drifted from the prepared binding");
    }
    const criteria = await this.store.criteria.listByWorkItem(row.work_item_id);
    const liveFingerprint = requireApprovedItemShape(approved, item, criteria);
    if (liveFingerprint !== row.approved_item_fingerprint) {
      fail("live approved item fingerprint has drifted from the prepared binding's approved fingerprint");
    }

    // Ordered, element-by-element re-comparison of what preparation retained —
    // never a count, and never a set-membership test that would accept a
    // reordering or a duplicate.
    const approvedCriteria = JSON.parse(row.approved_criteria_json) as readonly PrestartAcceptanceCriterion[];
    const liveCriteria = orderedCriteria(item, criteria);
    if (liveCriteria.length !== approvedCriteria.length) {
      fail("live acceptance criteria no longer match the prepared binding's approved criteria");
    }
    liveCriteria.forEach((criterion, index) => {
      const retained = retainedDomainCriterion(approvedCriteria[index], index);
      if (retained.id !== criterion.id) {
        fail(`live acceptance criterion ${index + 1} is not the prepared binding's approved criterion`);
      }
      if (retained.text !== criterion.text || retained.verificationHint !== criterion.verificationHint) {
        fail(`live acceptance criterion ${criterion.id} content has drifted from the approved criterion`);
      }
    });
    const approvedDependencyIds = JSON.parse(row.approved_dependency_ids_json) as readonly WorkItemId[];
    if (
      item.dependencies.length !== approvedDependencyIds.length ||
      !item.dependencies.every((dependencyId, index) => dependencyId === approvedDependencyIds[index])
    ) {
      fail("live work item dependencies are no longer the prepared binding's approved dependency sequence");
    }

    // Strict template allowlist + accepted parser/digest must still reproduce
    // the EXACT prepared digest. The branch is chosen by the captured
    // binding's own discriminator and the result correlates the bound object
    // with its ticket kind, so no cast is needed downstream.
    const liveTicketId = `${row.loop_id}:i${row.iteration}:${row.slot}`;
    const preparedLive = (() => {
      if (isDeterministicBinding(bound)) {
        if (slot !== "VERIFY") {
          return fail("a deterministic binding is only valid for the VERIFY slot");
        }
        const approvedFacts = approvedVerificationFacts(snapshot);
        const deterministic = strictDeterministicTicket(approved.template, liveTicketId, approvedFacts);
        return {
          kind: "deterministic" as const,
          bound,
          approvedFacts,
          ticket: deterministic.ticket,
          ticketDigest: deterministic.ticketDigest,
        };
      }
      if (slot === "VERIFY") {
        return fail("VERIFY slot requires a deterministic bound object");
      }
      const ai = strictTicketFromTemplate(approved.template, liveTicketId);
      return {
        kind: "ai" as const,
        bound,
        ticket: ai.ticket,
        ticketDigest: ai.ticketDigest,
      };
    })();
    const { ticketDigest } = preparedLive;
    if (ticketDigest !== row.ticket_digest) {
      fail("live approved ticket configuration has drifted from the prepared binding");
    }

    const loop = await this.loops.findById(row.loop_id);
    if (loop === undefined) {
      fail(`loop ${row.loop_id} no longer exists`);
    }
    // Durable cancellation and a terminal/inactive loop deny AFTER RESERVED as
    // well: a reservation is not a licence to launch into a cancelled loop.
    if (loop.cancelRequested) {
      fail(`loop ${row.loop_id} has a durable cancellation request; refusing to act on this binding`);
    }
    if (isTerminalLoopPhase(loop.phase)) {
      fail(`loop ${row.loop_id} is in terminal phase ${loop.phase}; refusing to act on this binding`);
    }
    if (!ACTIVE_LOOP_PHASES.includes(loop.phase)) {
      fail(`loop ${row.loop_id} phase ${loop.phase} is not an active loop phase`);
    }
    const currentIteration = loop.iterations.at(-1)?.iteration;
    if (currentIteration !== row.iteration) {
      fail(
        `loop ${row.loop_id} has moved to iteration ${String(currentIteration)}; this binding is for ${row.iteration}`,
      );
    }
    if (loop.workspaceRoot !== row.bound_workspace_root) {
      fail("live loop workspace root is no longer the prepared binding's approved workspace root");
    }

    // The approved execution config, the loop's own independently captured
    // copy and the host-captured binding must all still agree.
    if (preparedLive.kind === "deterministic") {
      // Fresh genuine approval facts, never persisted or caller process policy.
      requireMatchingVerificationConfig(preparedLive.bound, loop, preparedLive.approvedFacts);
    } else {
      if (slot === "VERIFY") {
        fail("VERIFY slot requires a deterministic bound object");
      }
      const loopWorkerConfig = slot === "IMPLEMENT" ? loop.implementer : loop.reviewer;
      requireMatchingActionConfig(
        slot,
        preparedLive.bound,
        loopWorkerConfig,
        approvedSlotConfig(snapshot, slot),
        snapshot.execution.workspaceRoot,
      );
      requireApplicableModelPolicy(slot, preparedLive.ticket, preparedLive.bound);
    }

    // FULL claim tuple against the current canonical active claim: a takeover
    // re-claim (new attempt) or a different owner is a different action.
    const iterationRecord = findIteration(loop, row.iteration);
    const claim = requireActiveClaim(row.loop_id, row.iteration, slot, iterationRecord);
    if (claim.actionId !== row.claim_action_id) {
      fail(`${row.slot} action claim actionId no longer matches the prepared binding's claim`);
    }
    if (claim.attempt !== row.claim_attempt) {
      fail(
        `${row.slot} action claim is now attempt ${claim.attempt}, not the prepared ${row.claim_attempt}; refusing a takeover re-claim`,
      );
    }
    if (claim.ownerToken !== row.claim_owner_token) {
      fail(`${row.slot} action claim is now owned by a different owner; refusing to act for a superseded owner`);
    }
    if (preparedLive.kind === "deterministic" && claim.attempt > preparedLive.approvedFacts.budgets.maxAttempts) {
      fail("current VERIFY claim attempt exceeds the approved verification attempt budget");
    }

    // The action this binding authorizes must not already be finished.
    const slotRunId =
      slot === "IMPLEMENT"
        ? iterationRecord.implementerRunId
        : slot === "VERIFY"
          ? iterationRecord.verificationRunId
          : iterationRecord.reviewerRunId;
    if (row.run_id === null && slotRunId !== undefined) {
      fail(`loop ${row.loop_id} iteration ${row.iteration} already recorded a ${row.slot} run; this binding is superseded`);
    }

    if (slot === "VERIFY" || slot === "REVIEW") {
      if (row.target_run_id === null) {
        fail(`live ${slot} binding carries no target run`);
      }
      const implementerRunId = iterationRecord.implementerRunId;
      if (implementerRunId === undefined || implementerRunId !== row.target_run_id) {
        fail("live loop iteration no longer attaches the prepared target run to its implementer run");
      }
      const implementerRun = await this.store.runs.findById(implementerRunId);
      if (implementerRun === undefined) {
        fail(`implementer run ${implementerRunId} no longer exists`);
      }
      if (implementerRun.status !== "SUCCEEDED") {
        fail(`implementer run ${implementerRunId} no longer records SUCCEEDED; refusing to treat this review binding as live`);
      }
      if (implementerRun.role !== "IMPLEMENTER") {
        fail(`run ${implementerRunId} is no longer an IMPLEMENTER run`);
      }
      if (implementerRun.workItemId !== loop.workItemId) {
        fail(`implementer run ${implementerRunId} no longer targets this loop's work item`);
      }
      if (implementerRun.specRevision !== item.specRevision) {
        fail("the implementer run under review no longer matches the current approved specRevision");
      }
      if (implementerRun.workerPrincipalId === principal.principalId) {
        fail("live reviewer principal is no longer independent of the implementer it would review");
      }
      if (this.registry.findByPrincipalId(implementerRun.workerPrincipalId) === undefined) {
        fail("the implementer run's principal is not known to this registry; cannot prove reviewer independence");
      }
    } else if (row.target_run_id !== null) {
      fail("an IMPLEMENT binding must carry no target run");
    }

    // ATTACHED RUN. Preparation is runless, so only a reserved/consumed row
    // carries one — and then it must still be the exact genuine run reserve()
    // validated and attached, under the same item/spec/role/principal.
    if (row.run_id !== null) {
      await this.requireAttachedRun(row, principal.principalId, item.specRevision, role, claim);
    } else if (row.state !== "PREPARED") {
      fail(`reservation ${reservationId} is ${row.state} but carries no attached run`);
    }

    await this.requireDependencyReadiness(row, item, approvedDependencyIds);

    return row;
  }

  /**
   * Re-verifies the run a reservation has ATTACHED (never one a caller names):
   * it must still exist, still be RUNNING, and still be the same work
   * item/spec/role/registered principal this binding was prepared for, with
   * the exact optional target and the claim's own correlation tag.
   */
  private async requireAttachedRun(
    row: Row,
    principalId: string,
    specRevision: number,
    role: FactoryRole,
    claim: WorkerActionClaim,
  ): Promise<void> {
    const attachedRunId = row.run_id as RunId;
    const run = await this.store.runs.findById(attachedRunId);
    if (run === undefined) {
      fail(`attached run ${attachedRunId} no longer exists`);
    }
    if (run.status !== "RUNNING") {
      fail(`attached run ${attachedRunId} is ${run.status}, no longer a live run for this binding`);
    }
    if (run.workItemId !== row.work_item_id) {
      fail(`attached run ${attachedRunId} no longer targets this binding's work item`);
    }
    if (run.specRevision !== specRevision || run.specRevision !== row.spec_revision) {
      fail(`attached run ${attachedRunId} no longer records this binding's approved specRevision`);
    }
    if (run.role !== role) {
      fail(`attached run ${attachedRunId} records role ${run.role}, not this binding's ${role}`);
    }
    if (run.workerPrincipalId !== principalId) {
      fail(`attached run ${attachedRunId} belongs to a different registered principal`);
    }
    if ((run.targetRunId ?? null) !== row.target_run_id) {
      fail(`attached run ${attachedRunId} does not carry this binding's exact target run`);
    }
    // The loop's own pre-execution correlation identity, where the real
    // sequencing records one: `declaredWorkerId` is audit data, and it is
    // compared only against the claim's DERIVED canonical tag, never trusted
    // as an authority on its own.
    const expectedTag = correlationTag(claim.actionId, claim.attempt);
    if (run.declaredWorkerId !== expectedTag) {
      fail(`attached run ${attachedRunId} is not correlated to this iteration's current action attempt`);
    }
  }

  /**
   * Current dependency readiness, decided ONLY from authoritative reads this
   * adapter genuinely has: each approved dependency work item's own durable
   * status, through the existing domain `isTerminal`/status vocabulary.
   *
   * A dependency that is DONE is ready; CANCELLED or BLOCKED refuses. A
   * dependency sitting in WAITING_FOR_HUMAN is NOT granted here: resolving it
   * needs the Factory's human-authority resolver, which this adapter is not
   * injected with, so it reports that narrow blocker rather than fabricating
   * the authority to clear it.
   */
  private async requireDependencyReadiness(
    row: Row,
    item: WorkItem,
    approvedDependencyIds: readonly WorkItemId[],
  ): Promise<void> {
    for (const dependencyId of approvedDependencyIds) {
      const dependency = await this.store.workItems.findById(dependencyId);
      if (dependency === undefined) {
        fail(`approved dependency ${dependencyId} of work item ${item.id} no longer exists`);
      }
      if (dependency.status === "DONE") {
        continue;
      }
      if (dependency.status === "WAITING_FOR_HUMAN") {
        fail(
          `approved dependency ${dependencyId} is WAITING_FOR_HUMAN; this authority has no human-authority resolver and will not grant readiness for it`,
        );
      }
      fail(
        `approved dependency ${dependencyId} of reservation ${row.reservation_id} is ${dependency.status}, not DONE; refusing to act on an unready binding`,
      );
    }
  }

  private bindingOf(row: Row): DirectLaunchBinding {
    return {
      ticketDigest: row.ticket_digest,
      registryPrincipalId: row.registry_principal_id,
      workItemId: row.work_item_id,
      specRevision: row.spec_revision,
      runId: row.run_id,
      reservationId: row.reservation_id,
      reservationVersion: row.version,
    } as DirectLaunchBinding;
  }

  /**
   * Verifies the FULL `DirectLaunchBinding` tuple against this row's own
   * live/current grant — every field, not merely `reservationVersion` and
   * `ticketDigest`: a caller presenting a binding whose `registryPrincipalId`,
   * `workItemId`, `specRevision` or `runId` no longer matches this exact row
   * is presenting a foreign or retargeted binding, which must fail exactly
   * like a stale version or digest.
   */
  private matchesBindingTuple(row: Row, binding: DirectLaunchBinding): boolean {
    return (
      row.reservation_id === binding.reservationId &&
      row.version === binding.reservationVersion &&
      row.ticket_digest === binding.ticketDigest &&
      row.registry_principal_id === binding.registryPrincipalId &&
      row.work_item_id === binding.workItemId &&
      row.spec_revision === binding.specRevision &&
      row.run_id === binding.runId
    );
  }

  /**
   * Synchronous CAS-only reserve. No await crosses the SQLite transaction:
   * `requireLiveRow`'s async re-verification has already happened by the
   * time this runs, and this step's ONLY job is the atomic state
   * transition + its own-authority/own-row guarantee.
   */
  /**
   * Proves a PROPOSED run is a genuine, current, Factory-owned RUNNING run
   * that belongs to exactly this prepared binding, and returns the id that may
   * then be atomically attached. Nothing here trusts the caller beyond naming
   * a candidate: the run must be recorded on the live work item's OWN
   * `runIds`, and must then pass the UNCHANGED `requireAttachedRun`
   * verification (same item/spec/role/registered principal, exact optional
   * target, canonical current claim correlation) against a candidate view of
   * this row. No run is ever fabricated and no caller id is reserved unproven.
   */
  private async validateProposedRun(row: Row, proposedRunId: RunId): Promise<RunId> {
    if (typeof proposedRunId !== "string" || proposedRunId.length === 0) {
      fail("no candidate run was proposed for reservation; refusing to reserve a runless binding");
    }
    const item = await this.store.workItems.findById(row.work_item_id);
    if (item === undefined) {
      fail(`work item ${row.work_item_id} no longer exists`);
    }
    if (!item.runIds.includes(proposedRunId)) {
      fail(
        `run ${proposedRunId} is not recorded on work item ${row.work_item_id}; refusing to attach a run the Factory does not own for this item`,
      );
    }
    const bound = this.requireBoundAction(row.reservation_id);
    const principal = this.registry.principalFor(bound.worker);
    if (principal.principalId !== row.registry_principal_id) {
      fail("the host-bound Worker object's registry principal is not the prepared binding's principal");
    }
    const loop = await this.loops.findById(row.loop_id);
    if (loop === undefined) {
      fail(`loop ${row.loop_id} no longer exists`);
    }
    const slot = row.slot as HostExecutionSlot;
    const claim = requireActiveClaim(row.loop_id, row.iteration, slot, findIteration(loop, row.iteration));
    // The SAME verification a later revalidation applies to the persisted
    // attachment, applied here to the candidate before it can be attached.
    await this.requireAttachedRun(
      { ...row, run_id: proposedRunId },
      principal.principalId,
      item.specRevision,
      row.role as FactoryRole,
      claim,
    );
    return proposedRunId;
  }

  private reserveRow(row: Row, ownerToken: string, attachRunId: RunId): Row {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changes = (
        this.statements.reserve.run(ownerToken, attachRunId, row.reservation_id, this.authorityId, row.version) as {
          changes: number;
        }
      ).changes;
      if (changes !== 1) {
        this.db.exec("ROLLBACK");
        fail("reservation CAS failed: concurrently reserved, cancelled, consumed, or owned by a foreign authority");
      }
      const fresh = decodeRow(this.statements.findById.get(row.reservation_id, this.authorityId));
      this.db.exec("COMMIT");
      return fresh;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing staged to roll back if BEGIN itself never completed.
      }
      throw error;
    }
  }

  /** Releases only this authority's own, still-unconsumed RESERVED row — never a foreign or consumed one. */
  private releaseOwnReservation(reservationId: string, version: number, ownerToken: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.statements.cancel.run(reservationId, this.authorityId, version, ownerToken);
      this.db.exec("COMMIT");
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing staged to roll back if BEGIN itself never completed.
      }
      // Best-effort cleanup only; the original capability failure is what's reported.
    }
  }

  private async checkFreshCapability(
    ticket: WorkerTicket,
    ticketDigest: string,
    binding: DirectLaunchBinding,
  ): Promise<ValidatedDirectLaunchCapability> {
    const rawEvidence = await this.capability({ ticket, ticketDigest, binding });
    return validateDirectLaunchCapabilityEvidence(rawEvidence, {
      ticket,
      ticketDigest,
      binding,
      trustedNowMillis: this.clock.now(),
      maxEvidenceAgeSeconds: this.maxEvidenceAgeSeconds,
    });
  }

  // Deterministic (VERIFY) fresh capability check. Separate from the AI
  // checker: every fact is validated explicitly from the unknown callback
  // result; nothing is coerced, echoed from approved limits or defaulted.
  private async checkFreshDeterministicCapability(
    ticket: DeterministicExecutionTicket,
    ticketDigest: string,
    binding: DirectLaunchBinding,
  ): Promise<DirectLaunchDeterministicCapabilityEvidence> {
    if (this.deterministicCapability === undefined) {
      return fail("no deterministic launch capability source is configured");
    }

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const isNonBlank = (value: unknown): value is string =>
      typeof value === "string" && value.trim().length > 0;
    const isStringArray = (value: unknown): value is readonly string[] =>
      Array.isArray(value) && value.every((entry) => typeof entry === "string");
    const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
      a.length === b.length && a.every((entry, index) => entry === b[index]);
    const coversAll = (supported: readonly string[], required: readonly string[]): boolean =>
      required.every((entry) => supported.includes(entry));

    // Trusted clock and freshness window must themselves be sane.
    const trustedNow = this.clock.now();
    if (typeof trustedNow !== "number" || !Number.isFinite(trustedNow)) {
      return fail("trusted clock did not yield a finite time");
    }
    const maxAgeSeconds = this.maxEvidenceAgeSeconds;
    if (typeof maxAgeSeconds !== "number" || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
      return fail("maximum evidence age must be a positive finite number");
    }

    // The supplied ticket must be the strict parsed ticket and its digest must
    // equal both the actual computed digest and the full binding's digest.
    const parsedTicket = parseDeterministicExecutionTicket(ticket);
    if (!parsedTicket.ok) {
      return fail("deterministic ticket failed strict parsing");
    }
    const strictTicket = parsedTicket.value;
    const actualDigest = computeDeterministicExecutionTicketDigest(strictTicket);
    if (actualDigest !== ticketDigest || binding.ticketDigest !== ticketDigest) {
      return fail("deterministic ticket digest does not match the strict ticket and the launch binding");
    }

    const raw: unknown = await this.deterministicCapability({ ticket: strictTicket, ticketDigest, binding });
    if (!isRecord(raw)) {
      return fail("deterministic capability evidence is malformed");
    }
    if (raw.executionKind !== DETERMINISTIC_EXECUTION_KIND) {
      return fail("capability evidence is not deterministic evidence");
    }
    // Mixed evidence: AI-only facts must be absent.
    if ("model" in raw || "quota" in raw || "context" in raw) {
      return fail("deterministic capability evidence must not carry AI model/quota/context facts");
    }

    // Common identity facts must equal the supplied full binding exactly.
    if (
      raw.ticketDigest !== binding.ticketDigest ||
      raw.registryPrincipalId !== binding.registryPrincipalId ||
      raw.workItemId !== binding.workItemId ||
      raw.specRevision !== binding.specRevision ||
      raw.runId !== binding.runId ||
      raw.reservationId !== binding.reservationId ||
      raw.reservationVersion !== binding.reservationVersion
    ) {
      return fail("deterministic capability evidence does not match the launch binding");
    }
    if (!isNonBlank(raw.evidenceDigest) || !isNonBlank(raw.evidenceReference)) {
      return fail("deterministic capability evidence lacks a digest or reference");
    }

    // Freshness.
    if (typeof raw.observedAt !== "string" || typeof raw.expiresAt !== "string") {
      return fail("deterministic capability evidence timestamps are malformed");
    }
    const observed = Date.parse(raw.observedAt);
    const expires = Date.parse(raw.expiresAt);
    if (!Number.isFinite(observed) || !Number.isFinite(expires)) {
      return fail("deterministic capability evidence timestamps are not parseable");
    }
    if (observed > trustedNow) {
      return fail("deterministic capability evidence was observed in the future");
    }
    if (expires <= observed || expires <= trustedNow) {
      return fail("deterministic capability evidence has expired");
    }
    if ((trustedNow - observed) / 1000 > maxAgeSeconds) {
      return fail("deterministic capability evidence is too old");
    }

    // Scope and confinement.
    const scope = raw.scope;
    if (
      !isRecord(scope) ||
      !isStringArray(scope.owned) ||
      !isStringArray(scope.forbidden) ||
      !sameStrings(scope.owned, strictTicket.scope.owned) ||
      !sameStrings(scope.forbidden, strictTicket.scope.forbidden)
    ) {
      return fail("deterministic capability scope does not equal the ticket scope");
    }
    const confinement = raw.confinement;
    if (
      !isRecord(confinement) ||
      confinement.verified !== true ||
      !isStringArray(confinement.supportedScopeOwned) ||
      !isStringArray(confinement.supportedScopeForbidden) ||
      !coversAll(confinement.supportedScopeOwned, strictTicket.scope.owned) ||
      !coversAll(confinement.supportedScopeForbidden, strictTicket.scope.forbidden)
    ) {
      return fail("deterministic capability confinement is unverified or does not cover the ticket scope");
    }

    // Deterministic facts must pass the accepted strict ticket parser (via a
    // candidate carrying the strict ticket's common facts and the evidence's
    // own commands/workspace/budgets/policy) and then equal the ticket exactly.
    const parsedEvidenceFacts = parseDeterministicExecutionTicket({
      ...strictTicket,
      commands: raw.commands,
      workspace: raw.workspace,
      budgets: raw.budgets,
      executionPolicy: raw.executionPolicy,
    });
    if (!parsedEvidenceFacts.ok) {
      return fail("deterministic capability facts failed strict parsing");
    }
    const evidenceFacts = parsedEvidenceFacts.value;
    if (!sameCommandSequence(evidenceFacts.commands, strictTicket.commands)) {
      return fail("deterministic capability commands do not equal the ticket commands");
    }
    if (evidenceFacts.workspace !== strictTicket.workspace) {
      return fail("deterministic capability workspace does not equal the ticket workspace");
    }
    if (!sameDeterministicBudgets(evidenceFacts.budgets, strictTicket.budgets)) {
      return fail("deterministic capability budgets do not equal the ticket budgets");
    }
    if (evidenceFacts.executionPolicy.rationale !== strictTicket.executionPolicy.rationale) {
      return fail("deterministic capability execution policy does not equal the ticket policy");
    }

    // Actual observed process capacities: genuine numbers, never coerced.
    const processFacts = raw.process;
    if (!isRecord(processFacts) || processFacts.verified !== true) {
      return fail("deterministic process capability is unverified");
    }
    if (processFacts.resolvedWorkspace !== strictTicket.workspace) {
      return fail("resolved process workspace does not equal the ticket workspace");
    }
    const executables = processFacts.resolvedExecutables;
    if (
      !Array.isArray(executables) ||
      !executables.every(isNonBlank) ||
      !sameStrings(
        executables,
        strictTicket.commands.map((command) => command.executable),
      )
    ) {
      return fail("resolved executables do not equal the ordered ticket command executables");
    }
    const elapsed = processFacts.enforceableElapsedSeconds;
    if (
      typeof elapsed !== "number" ||
      !Number.isFinite(elapsed) ||
      elapsed <= 0 ||
      elapsed < strictTicket.budgets.elapsedSeconds
    ) {
      return fail("enforceable elapsed seconds are missing or below the approved budget");
    }
    const outputBytes = processFacts.enforceableOutputBytes;
    if (
      typeof outputBytes !== "number" ||
      !Number.isSafeInteger(outputBytes) ||
      outputBytes <= 0 ||
      outputBytes < strictTicket.budgets.outputBytes
    ) {
      return fail("enforceable output bytes are missing or below the approved budget");
    }
    const attempts = processFacts.enforceableAttempts;
    if (
      typeof attempts !== "number" ||
      !Number.isSafeInteger(attempts) ||
      attempts <= 0 ||
      attempts < strictTicket.budgets.maxAttempts
    ) {
      return fail("enforceable attempts are missing or below the approved budget");
    }

    // Every field has been validated above; the typed result is a deep frozen
    // copy so later mutation of the callback's object cannot change it.
    return deepFreezeCopy(raw) as unknown as DirectLaunchDeterministicCapabilityEvidence;
  }

  private async grantFor(
    kind: "ai" | typeof DETERMINISTIC_EXECUTION_KIND,
    ticketJson: string,
    ticketDigest: string,
    binding: DirectLaunchBinding,
  ): Promise<DirectHostExecutionLaunchGrant> {
    const raw: unknown = JSON.parse(ticketJson);
    if (kind === DETERMINISTIC_EXECUTION_KIND) {
      const ticket = parseDeterministicExecutionTicket(raw);
      if (!ticket.ok) {
        fail("persisted ticket no longer parses");
      }
      if ((await computeDeterministicExecutionTicketDigest(ticket.value)) !== ticketDigest) {
        fail("persisted deterministic ticket digest drifted");
      }
      const evidence = await this.checkFreshDeterministicCapability(ticket.value, ticketDigest, binding);
      return {
        executionKind: DETERMINISTIC_EXECUTION_KIND,
        ticket: ticket.value,
        ticketDigest,
        binding,
        evidence,
      };
    }
    const ticket = parseWorkerTicket(raw);
    if (!ticket.ok) {
      fail("persisted ticket no longer parses");
    }
    if ((await computeTicketDigest(ticket.value)) !== ticketDigest) {
      fail("persisted ticket digest drifted");
    }
    const validated = await this.checkFreshCapability(ticket.value, ticketDigest, binding);
    return {
      ticket: ticket.value,
      ticketDigest,
      binding,
      evidence: validated.evidence,
    };
  }

  resolveAndReserve(request: {
    readonly ticketReference: unknown;
    readonly registryPrincipalId: string;
    readonly workItemId: WorkItemId;
    readonly specRevision: number;
    readonly runId: RunId;
    readonly executionKind?: "ai";
  }): Promise<{
    readonly ticket: WorkerTicket;
    readonly ticketDigest: string;
    readonly binding: DirectLaunchBinding;
    readonly evidence: DirectLaunchCapabilityEvidence;
  }>;
  resolveAndReserve(
    request: Extract<DirectHostExecutionLaunchRequest, { readonly executionKind: typeof DETERMINISTIC_EXECUTION_KIND }>,
  ): Promise<Extract<DirectHostExecutionLaunchGrant, { readonly executionKind: typeof DETERMINISTIC_EXECUTION_KIND }>>;
  resolveAndReserve(request: DirectHostExecutionLaunchRequest): Promise<DirectHostExecutionLaunchGrant>;
  async resolveAndReserve(request: {
    readonly ticketReference: unknown;
    readonly registryPrincipalId: string;
    readonly workItemId: WorkItemId;
    readonly specRevision: number;
    readonly runId: RunId;
    readonly executionKind?: unknown;
  }): Promise<DirectHostExecutionLaunchGrant> {
    const ownReservationId = String(request.ticketReference);
    const row = await this.requireLiveRow(ownReservationId);
    const requestKind = request.executionKind;
    if (
      rowExecutionKind(row) === DETERMINISTIC_EXECUTION_KIND
        ? requestKind !== DETERMINISTIC_EXECUTION_KIND
        : requestKind !== undefined && requestKind !== "ai"
    ) {
      fail("request execution kind does not match the reservation");
    }

    if (row.registry_principal_id !== request.registryPrincipalId) {
      fail("request registryPrincipalId does not match the prepared binding");
    }
    if (row.work_item_id !== request.workItemId || row.spec_revision !== request.specRevision) {
      fail("request work item/spec does not match the prepared binding");
    }
    if (row.state !== "PREPARED") {
      fail(`reservation ${ownReservationId} is ${row.state}, not available to reserve`);
    }
    // A prepared row is runless by construction, so there is nothing to
    // compare the proposed run against yet: it must instead be PROVEN to be a
    // genuine current Factory-owned run for exactly this binding, through the
    // same attached-run verification every later revalidation uses.
    if (row.run_id !== null) {
      fail(`reservation ${ownReservationId} already carries an attached run; refusing to re-attach`);
    }
    const attachRunId = await this.validateProposedRun(row, request.runId);

    const ownerToken = `owner:${this.authorityId}:${attachRunId}`;
    const freshRow = this.reserveRow(row, ownerToken, attachRunId);

    try {
      return await this.grantFor(
        rowExecutionKind(freshRow),
        freshRow.ticket_json,
        freshRow.ticket_digest,
        this.bindingOf(freshRow),
      );
    } catch (error) {
      // Unknown/denied capability after an acquired reservation: safely
      // release only THIS now-RESERVED, unconsumed row, never leaving it
      // stranded, and never touching a foreign or already-consumed row.
      this.releaseOwnReservation(freshRow.reservation_id, freshRow.version, ownerToken);
      throw error;
    }
  }

  /**
   * Re-checks the full current context AND fresh capability against an
   * existing grant without consuming it. Revalidation plus the later SQLite
   * CAS on consume are each individually atomic; their combination is NOT
   * cross-store atomicity — a crash between this check and `atomicConsumeLaunch`
   * is possible, which is exactly why `atomicConsumeLaunch` re-verifies
   * everything itself rather than trusting this call's result.
   */
  async revalidate(grant: DirectHostExecutionLaunchGrant, _request: unknown): Promise<void> {
    const row = await this.requireLiveRow(grant.binding.reservationId);
    if (row.state !== "RESERVED") {
      fail(`reservation ${grant.binding.reservationId} is ${row.state}, not an active reservation`);
    }
    if (!this.matchesBindingTuple(row, grant.binding) || row.ticket_digest !== grant.ticketDigest) {
      fail("reservation drifted since it was granted");
    }
    if (row.owner_token === null) {
      fail("reservation has no recorded owner; refusing to revalidate");
    }
    if (rowExecutionKind(row) === DETERMINISTIC_EXECUTION_KIND) {
      if (grant.executionKind !== DETERMINISTIC_EXECUTION_KIND) {
        fail("grant execution kind does not match the reservation");
      }
      if ((await computeDeterministicExecutionTicketDigest(grant.ticket)) !== grant.ticketDigest) {
        fail("granted ticket does not match its digest");
      }
      await this.checkFreshDeterministicCapability(grant.ticket, grant.ticketDigest, grant.binding);
      return;
    }
    if (grant.executionKind !== undefined && grant.executionKind !== "ai") {
      fail("grant execution kind does not match the reservation");
    }
    if ((await computeTicketDigest(grant.ticket)) !== grant.ticketDigest) {
      fail("granted ticket does not match its digest");
    }
    await this.checkFreshCapability(grant.ticket, grant.ticketDigest, grant.binding);
  }

  /** Strictly informational: re-verifies live facts AND fresh capability, but never mutates state. */
  async checkReadiness(binding: DirectLaunchBinding): Promise<boolean> {
    const row = await this.requireLiveRow(binding.reservationId);
    if (row.state !== "RESERVED" || !this.matchesBindingTuple(row, binding)) {
      return false;
    }
    try {
      await this.grantFor(rowExecutionKind(row), row.ticket_json, row.ticket_digest, binding);
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Strictly read-only: proves a previously consumed launch is still this authority's live
   * CONSUMED row (version original+1) with fresh capability. Never mutates state.
   */
  async checkConsumedContinuation(receipt: DirectLaunchReceipt): Promise<boolean> {
    try {
      const original = receipt.binding;
      if (
        typeof receipt.consumedAt !== "string" ||
        receipt.consumedAt.trim() === "" ||
        Number.isNaN(Date.parse(receipt.consumedAt)) ||
        !Number.isSafeInteger(original.reservationVersion) ||
        original.reservationVersion <= 0
      ) {
        return false;
      }
      const row = await this.requireLiveRow(original.reservationId);
      if (row.state !== "CONSUMED" || typeof row.consumed_binding_json !== "string") {
        return false;
      }
      if (row.owner_token !== `owner:${this.authorityId}:${row.run_id}`) {
        return false;
      }
      const parsed: unknown = JSON.parse(row.consumed_binding_json);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return false;
      }
      const stored = parsed as Record<string, unknown>;
      if (
        typeof stored.reservationVersion !== "number" ||
        stored.reservationId !== original.reservationId ||
        stored.reservationVersion !== original.reservationVersion ||
        stored.ticketDigest !== original.ticketDigest ||
        stored.registryPrincipalId !== original.registryPrincipalId ||
        stored.workItemId !== original.workItemId ||
        stored.specRevision !== original.specRevision ||
        stored.runId !== original.runId
      ) {
        return false;
      }
      if (
        row.version !== stored.reservationVersion + 1 ||
        row.reservation_id !== stored.reservationId ||
        row.ticket_digest !== stored.ticketDigest ||
        row.registry_principal_id !== stored.registryPrincipalId ||
        row.work_item_id !== stored.workItemId ||
        row.spec_revision !== stored.specRevision ||
        row.run_id !== stored.runId
      ) {
        return false;
      }
      await this.grantFor(rowExecutionKind(row), row.ticket_json, row.ticket_digest, original);
      return true;
    } catch {
      return false;
    }
  }

  async atomicConsumeLaunch(binding: DirectLaunchBinding): Promise<DirectLaunchReceipt> {
    const row = await this.requireLiveRow(binding.reservationId);
    if (row.state !== "RESERVED") {
      fail(`reservation ${binding.reservationId} is ${row.state}; refusing to consume`);
    }
    // FULL tuple, not version+digest: a foreign or retargeted
    // principal/item/spec/run must fail exactly like a stale version.
    if (!this.matchesBindingTuple(row, binding)) {
      fail("binding is stale or foreign relative to the live reservation; refusing to consume");
    }
    const ownerToken = row.owner_token;
    if (ownerToken === null) {
      fail("reservation has no recorded owner; refusing to consume");
    }
    // Fresh95-validated capability is required again here, not only at the
    // initial reserve: authority may have changed between reserve and this
    // exact consume attempt.
    await this.grantFor(rowExecutionKind(row), row.ticket_json, row.ticket_digest, binding);

    const consumedBinding = this.bindingOf(row);
    const consumedBindingJson = JSON.stringify(consumedBinding);

    this.db.exec("BEGIN IMMEDIATE");
    let changes: number;
    try {
      changes = (
        this.statements.consume.run(
          consumedBindingJson,
          row.reservation_id,
          this.authorityId,
          row.version,
          ownerToken,
        ) as { changes: number }
      ).changes;
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing staged to roll back if BEGIN itself never completed.
      }
      throw error;
    }
    if (changes !== 1) {
      fail("consume CAS failed: concurrently consumed, cancelled, or reopened (at-most-once preserved)");
    }

    const consumedAt = new Date(this.clock.now()).toISOString();
    // The receipt's binding is EXACTLY the input binding tuple/version this
    // call consumed — never a freshly re-read row, whose internal `version`
    // the consume statement itself already advanced.
    return {
      binding: consumedBinding,
      consumedAt,
    } as DirectLaunchReceipt;
  }

  async cancel(binding: DirectLaunchBinding): Promise<void> {
    const raw = this.statements.findById.get(binding.reservationId, this.authorityId);
    if (raw === undefined) {
      fail(`reservation ${binding.reservationId} is unknown to this host authority`);
    }
    // Deliberately NOT gated on `requireLiveRow`: releasing this authority's
    // OWN unconsumed reservation must stay possible after the loop itself is
    // cancelled or no longer approved — a row must never be strandable
    // because the work it reserved is no longer launchable. Ownership is still
    // proven in full below.
    const row = decodeRow(raw);
    if (row.state !== "RESERVED") {
      fail(`reservation ${binding.reservationId} is ${row.state}; only an active reservation owned by this authority may be cancelled`);
    }
    if (!this.matchesBindingTuple(row, binding)) {
      fail("binding does not match the live reservation; refusing to cancel a foreign or retargeted reservation");
    }
    const ownerToken = row.owner_token;
    if (ownerToken === null) {
      fail("reservation has no recorded owner; refusing to cancel");
    }
    this.db.exec("BEGIN IMMEDIATE");
    let changes: number;
    try {
      changes = (
        this.statements.cancel.run(row.reservation_id, this.authorityId, row.version, ownerToken) as {
          changes: number;
        }
      ).changes;
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing staged to roll back if BEGIN itself never completed.
      }
      throw error;
    }
    if (changes !== 1) {
      fail("cancel CAS failed: reservation was concurrently reserved, consumed, or already cancelled");
    }
  }

  close(): void {
    this.db.close();
  }
}
