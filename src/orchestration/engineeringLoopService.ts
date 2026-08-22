/**
 * TASK-004 autonomous engineering loop orchestrator.
 *
 * Coordinates trusted `FactoryService` calls (never a repository directly)
 * to drive an already-approved (`READY`) `WorkItem` through IMPLEMENT ->
 * deterministic VERIFY -> independent REVIEW -> (remediate and repeat, or
 * stop at `WAITING_FOR_HUMAN`).
 *
 * REMEDIATION ROUND 1 — the crash-safe action protocol (full specification
 * in docs/tasks/TASK-004-autonomous-engineering-loop.md; the six independent
 * review findings it answers are preserved verbatim in AI-HANDOFF.md):
 *
 * 1. CLAIM BEFORE LAUNCH. Every external side effect (worker launch, review
 *    recording) is preceded by a durable claim written with a strict CAS on
 *    the single loop row. The claim carries a stable action identity
 *    (`actionId`, `attempt`, `ownerToken`) and a correlation tag that
 *    becomes the launched Worker object's `id` — which
 *    `FactoryService.runWorker` durably persists as the Run's
 *    `declaredWorkerId` in PHASE 1, before execution. The tag is
 *    orchestrator-constructed configuration; model output cannot touch it,
 *    and it is never used for a trust decision (C4 still compares registry
 *    principals) — only for idempotent correlation.
 *
 * 2. RECONCILE BEFORE DECIDING. Every drive step first reconciles the last
 *    incomplete claim against authoritative Factory state by exact tag
 *    match — never by role/latest/title/timestamp guessing: a terminal Run
 *    for the current attempt is adopted (recorded once, marked `recovered`,
 *    never re-counted, never relaunched); a RUNNING Run whose outcome
 *    cannot be proven after restart fails closed into RECOVERY_REQUIRED
 *    (never "assume it succeeded", never "launch another"); no Run at all
 *    means the crash preceded PHASE 1 and the action is relaunched exactly
 *    once under a re-claimed attempt. Review recordings reconcile through
 *    `FactoryService.listReviews` matched by the exact reviewerRunId.
 *
 * 3. SINGLE LINEARIZATION POINT. Claims, phase changes, and cancellation
 *    all CAS the same `version` counter, with NO blind retry on claim/phase
 *    writes: a durably-committed cancellation makes every stale claim
 *    attempt lose its CAS, so no new external action can begin after cancel
 *    commits (an ownership/cancel pre-flight check inside the launched
 *    Worker wrapper closes the residual gap before any process spawns).
 *    Only completion-fact writes (recording the outcome of an
 *    already-authorized launch — the loop-side analog of runWorker's
 *    PHASE 3) re-read and re-apply on a lost CAS.
 *
 * Residual, documented windows (design doc "Remediation round 1" section):
 * resuming a loop while another live process is mid-action is operator
 * misuse the protocol answers safely (back-off on a lost claim CAS;
 * RECOVERY_REQUIRED on an in-flight Run; post-hoc detection of superseded
 * non-FAILED runs) rather than perfectly — exactly-once under arbitrary
 * live-process interleaving is impossible without process fencing, which
 * TASK-004 does not pretend to have.
 */

import { createLoopWorker, type LoopWorkerFactoryOptions } from "./loopWorkerFactory.js";
import { buildImplementerInstructions, buildReviewerInstructions } from "./loopPrompts.js";
import { parseReviewVerdict } from "./reviewVerdictParser.js";
import { assertVerificationCommandsContained, createVerificationWorker } from "./verificationWorker.js";
import {
  DEFAULT_LOOP_BUDGET,
  canonicalActionId,
  correlationPrefix,
  correlationTag,
  isTerminalLoopPhase,
  openIteration,
  type EngineeringLoop,
  type ExhaustionKind,
  type LoopBudget,
  type LoopIterationRecord,
  type LoopReviewVerdict,
  type LoopWorkerConfig,
  type VerificationCommandConfig,
  type VerificationCommandResult,
  type WorkerActionClaim,
  type WorkerActionKind,
} from "./loopTypes.js";
import type { LoopRepository } from "./loopRepository.js";
import type { Workspace } from "../adapters/workers/workspace.js";
import { resolveWorkspace } from "../adapters/workers/workspace.js";
import { agent, type Actor } from "../domain/actor.js";
import { ConcurrencyError, HumanIdentityError, NotFoundError, ValidationError } from "../domain/errors.js";
import type { TrustedHumanToken } from "../domain/humanIdentity.js";
import type { IdGenerator, RunId, WorkItemId } from "../domain/ids.js";
import type { Review } from "../domain/review.js";
import type { Run } from "../domain/run.js";
import { isTerminal, type WorkItemStatus } from "../domain/status.js";
import type { FactoryService } from "../app/factoryService.js";
import type { Clock } from "../ports/clock.js";
import type { ProcessRunner } from "../ports/processRunner.js";
import type { Worker, WorkerOutcome, WorkerRequest } from "../ports/worker.js";

export interface StartLoopInput {
  readonly workItemId: WorkItemId;
  readonly actor: Actor;
  /** Bounded spec/task text handed to the implementer; see loopPrompts.ts. */
  readonly taskInstructions: string;
  readonly implementer: LoopWorkerConfig;
  readonly reviewer: LoopWorkerConfig;
  readonly verificationCommands: readonly VerificationCommandConfig[];
  readonly workspace: Workspace;
  readonly budget?: Partial<LoopBudget>;
}

export type LoopWorkerFactory = (config: LoopWorkerConfig, options: LoopWorkerFactoryOptions) => Worker;

export interface EngineeringLoopServiceDeps {
  readonly factory: FactoryService;
  readonly loops: LoopRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly processRunner: ProcessRunner;
  readonly log?: (line: string) => void;
  /**
   * Overrides how the IMPLEMENTER/REVIEWER `Worker` is constructed from its
   * `LoopWorkerConfig`. Defaults to `createLoopWorker` (real Claude Code /
   * Codex CLI adapters). Tests and `npm run demo:loop` inject deterministic
   * scripted factories instead — automated tests must never invoke a real AI
   * CLI. Whatever the factory returns is wrapped by the ownership/cancel
   * pre-flight guard, whose `id` (the correlation tag) is what
   * `runWorker` persists — so custom factories need no correlation logic.
   */
  readonly createImplementerWorker?: LoopWorkerFactory;
  readonly createReviewerWorker?: LoopWorkerFactory;
}

/** The evidence channel that carried a structured, contract-satisfying tool answer (see cliWorker.ts). */
const TRANSCRIPT_REFERENCE_SUFFIX = "/transcript";

type WorkerSlot = "implement" | "verify" | "review";

const SLOT_KIND: Record<WorkerSlot, WorkerActionKind> = { implement: "IMPLEMENT", verify: "VERIFY", review: "REVIEW" };
const SLOT_ROLE: Record<WorkerSlot, "IMPLEMENTER" | "VERIFIER" | "REVIEWER"> = {
  implement: "IMPLEMENTER",
  verify: "VERIFIER",
  review: "REVIEWER",
};

function slotClaim(iteration: LoopIterationRecord, slot: WorkerSlot): WorkerActionClaim | undefined {
  switch (slot) {
    case "implement":
      return iteration.implementClaim;
    case "verify":
      return iteration.verifyClaim;
    case "review":
      return iteration.reviewClaim;
  }
}

function slotRunId(iteration: LoopIterationRecord, slot: WorkerSlot): RunId | undefined {
  switch (slot) {
    case "implement":
      return iteration.implementerRunId;
    case "verify":
      return iteration.verificationRunId;
    case "review":
      return iteration.reviewerRunId;
  }
}

function withSlotClaim(iteration: LoopIterationRecord, slot: WorkerSlot, claim: WorkerActionClaim): LoopIterationRecord {
  switch (slot) {
    case "implement":
      return { ...iteration, implementClaim: claim };
    case "verify":
      return { ...iteration, verifyClaim: claim };
    case "review":
      return { ...iteration, reviewClaim: claim };
  }
}

function replaceLast<T>(items: readonly T[], value: T): readonly T[] {
  return [...items.slice(0, -1), value];
}

interface StepContext {
  readonly workspace: Workspace;
  readonly implementerWorker: Worker;
  readonly reviewerWorker: Worker;
  readonly ownerToken: string;
}

type StepResult = { readonly kind: "advanced"; readonly loop: EngineeringLoop } | { readonly kind: "conflict" };

type ReconcileResult =
  | { readonly kind: "clean" }
  | { readonly kind: "updated" }
  | { readonly kind: "recovery" }
  | { readonly kind: "conflict" };

const MAX_DRIVE_STEPS = 10_000;

export class EngineeringLoopService {
  private readonly factory: FactoryService;
  private readonly loops: LoopRepository;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly processRunner: ProcessRunner;
  private readonly log: (line: string) => void;
  private readonly orchestratorActor: Actor;
  private readonly createImplementerWorker: LoopWorkerFactory;
  private readonly createReviewerWorker: LoopWorkerFactory;

  constructor(deps: EngineeringLoopServiceDeps) {
    this.factory = deps.factory;
    this.loops = deps.loops;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.processRunner = deps.processRunner;
    this.log = deps.log ?? ((): void => {});
    this.orchestratorActor = agent("agent:engineering-loop", "Engineering Loop Orchestrator");
    this.createImplementerWorker = deps.createImplementerWorker ?? createLoopWorker;
    this.createReviewerWorker = deps.createReviewerWorker ?? createLoopWorker;
  }

  // =====================================================================
  // Public surface
  // =====================================================================

  async start(input: StartLoopInput): Promise<EngineeringLoop> {
    if (input.verificationCommands.length === 0) {
      throw new ValidationError("a loop must configure at least one deterministic verification command");
    }
    for (const command of input.verificationCommands) {
      if (command.id.length === 0 || command.executable.length === 0) {
        throw new ValidationError("every verification command needs a non-empty id and executable");
      }
    }
    // HIGH 4: trusted configuration still may not escape the approved
    // workspace. Checked here (fail fast, before a loop row even exists) and
    // again per command at execution time (verificationWorker.ts).
    assertVerificationCommandsContained(input.verificationCommands, input.workspace);

    const item = await this.factory.getWorkItem(input.workItemId);
    if (item.status !== "READY") {
      throw new ValidationError(
        `cannot start an autonomous loop: work item ${input.workItemId} is ${item.status}, expected READY (a plan-approved work item)`,
      );
    }

    // Friendly pre-check only — the enforcement is the repository's
    // persistence-level active-loop uniqueness constraint (PART E), which
    // makes a concurrent double-start lose at create() with ConcurrencyError.
    const existing = await this.loops.listByWorkItem(input.workItemId);
    if (existing.some((loop) => !isTerminalLoopPhase(loop.phase))) {
      throw new ValidationError(`work item ${input.workItemId} already has an active autonomous loop`);
    }

    const budget: LoopBudget = { ...DEFAULT_LOOP_BUDGET, ...(input.budget ?? {}) };
    if (budget.maxIterations < 1) {
      throw new ValidationError("budget.maxIterations must be at least 1");
    }

    const now = this.clock.now();
    const loop: EngineeringLoop = {
      id: this.ids.next("loop"),
      workItemId: input.workItemId,
      version: 1,
      phase: "READY",
      budget,
      implementer: input.implementer,
      reviewer: input.reviewer,
      verificationCommands: input.verificationCommands,
      workspaceRoot: input.workspace.root,
      taskInstructions: input.taskInstructions,
      iterations: [],
      totalRunCount: 0,
      cancelRequested: false,
      startedBy: input.actor,
      startedAt: now,
      lastTransitionAt: now,
    };
    await this.loops.create(loop);
    this.log(`[loop ${loop.id}] started for work item ${input.workItemId} by ${input.actor.displayName}`);
    return this.drive(loop.id);
  }

  async resume(loopId: string): Promise<EngineeringLoop> {
    return this.drive(loopId);
  }

  /**
   * Read-only status.
   *
   * HIGH 1 (remediation round 4): `WAITING_FOR_HUMAN` is an AUTHORITY RESULT,
   * not merely a persisted display state — no public read path may present it
   * as authoritative just because loops.db says so. A UI, Telegram layer,
   * Control Room or future orchestration client reading this would otherwise
   * treat a stale or corrupted checkpoint as a live human/release gate. So
   * when the persisted phase is `WAITING_FOR_HUMAN`, this asks the Factory
   * Core to prove the current independent-review lineage — the same
   * `resolveWaitingForHumanAuthority` resolver `drive()`/`resume()` use, never
   * a second weaker copy of those rules.
   *
   * When authority cannot currently be proven this FAILS CLOSED by returning a
   * non-authoritative `RECOVERY_REQUIRED` projection. That projection is
   * computed in memory and deliberately NOT persisted: `status` is a read
   * operation and must stay free of durable side effects (no version bump, no
   * WorkItem change, no Run/Review/Evidence, no budget consumption, no worker
   * launch). Durably demoting the invalid cached authority to
   * `RECOVERY_REQUIRED` is `resume()`/`drive()`'s job (see
   * `reconcileTerminal`/`failClosedToRecovery`) — reading the loop must never
   * be what changes it.
   */
  async status(loopId: string): Promise<EngineeringLoop> {
    const loop = await this.requireLoop(loopId);
    if (loop.phase !== "WAITING_FOR_HUMAN") {
      return loop;
    }
    const authority = await this.factory.resolveWaitingForHumanAuthority(loop.workItemId);
    if (authority.ok) {
      return loop;
    }
    return {
      ...loop,
      phase: "RECOVERY_REQUIRED",
      outcome: "RECOVERY_REQUIRED",
      failureReason: `persisted WAITING_FOR_HUMAN is not backed by current Factory authority: ${authority.reason} (reported read-only; run \`sf loop resume\` to durably record RECOVERY_REQUIRED)`,
    };
  }

  /**
   * Durably records cancellation intent, then finalizes. The intent write is
   * a fact (bounded re-read-and-reapply on a lost CAS): from the caller's
   * perspective cancellation is durable as soon as this method's first write
   * lands, and every claim attempt with a stale version thereafter loses its
   * CAS — no new external action can begin (PART F).
   *
   * HIGH 1 (remediation round 3): cancelling a loop is an explicit HUMAN
   * governance operation, held to the SAME trusted-human boundary as WorkItem
   * cancellation and every protected approval (C1/C5). A caller-constructed
   * `{ kind: "HUMAN" }` object, an AGENT/SYSTEM actor, or a forged, expired or
   * mismatched token is refused BEFORE any durable state is read or written —
   * no phase change, no version bump, no worker-suppression side effect. The
   * `TrustedHumanToken` is verified by the Factory Core against the same
   * `HumanIdentityGate` that mints it (the loop never receives the credential
   * or a reference to the gate — the accepted TASK-001 trust model), so this
   * reuses one authoritative boundary rather than inventing a weaker one.
   *
   * HIGH 1 (remediation round 5): authentication and authority are SEPARATE
   * invariants. Verifying the trusted human answers "who may cancel?"; it says
   * nothing about whether a cached terminal `WAITING_FOR_HUMAN` row is still
   * backed by current Factory authority. The terminal early return below
   * therefore revalidates that one phase through the same shared path
   * `drive()`/`resume()` use, so no public entry point can present an
   * unbacked WAITING_FOR_HUMAN — not even to a properly authenticated human.
   * The other terminal phases (CANCELLED/EXHAUSTED/FAILED/RECOVERY_REQUIRED)
   * claim no current authority, so their existing no-op semantics are kept
   * exactly as they were.
   */
  async cancel(loopId: string, actor: Actor, authorization?: TrustedHumanToken): Promise<EngineeringLoop> {
    const problem = this.factory.verifyHumanAuthorization(actor, authorization);
    if (problem !== undefined) {
      throw new HumanIdentityError(`refusing to cancel loop ${loopId}: ${problem}`);
    }

    let loop = await this.requireLoop(loopId);
    if (isTerminalLoopPhase(loop.phase)) {
      return loop.phase === "WAITING_FOR_HUMAN" ? this.reconcileWaitingAuthority(loop) : loop;
    }
    this.log(`[loop ${loop.id}] cancellation requested by ${actor.displayName}`);
    loop = await this.factSave(loopId, (fresh) =>
      isTerminalLoopPhase(fresh.phase) || fresh.cancelRequested ? null : { cancelRequested: true },
    );
    if (isTerminalLoopPhase(loop.phase)) {
      // The loop reached a terminal phase concurrently; same rule as above.
      return loop.phase === "WAITING_FOR_HUMAN" ? this.reconcileWaitingAuthority(loop) : loop;
    }
    return this.finalize(loopId, { phase: "CANCELLED", outcome: "CANCELLED" });
  }

  // =====================================================================
  // Drive loop
  // =====================================================================

  private async drive(loopId: string): Promise<EngineeringLoop> {
    const ownerToken = this.ids.next("own");
    try {
      let loop = await this.requireLoop(loopId);

      if (isTerminalLoopPhase(loop.phase)) {
        return this.reconcileTerminal(loop);
      }

      const workspace = resolveWorkspace(loop.workspaceRoot);
      const ctx: StepContext = {
        workspace,
        implementerWorker: this.createImplementerWorker(loop.implementer, {
          workspace,
          processRunner: this.processRunner,
          roles: ["IMPLEMENTER"],
        }),
        reviewerWorker: this.createReviewerWorker(loop.reviewer, {
          workspace,
          processRunner: this.processRunner,
          roles: ["REVIEWER"],
        }),
        ownerToken,
      };
      if ((ctx.implementerWorker as unknown) === (ctx.reviewerWorker as unknown)) {
        throw new Error("internal: implementer and reviewer must be distinct Worker objects");
      }

      let steps = 0;
      while (true) {
        if (++steps > MAX_DRIVE_STEPS) {
          throw new Error(`internal: loop ${loopId} exceeded ${MAX_DRIVE_STEPS} drive steps without terminating`);
        }

        loop = await this.requireLoop(loopId);
        if (isTerminalLoopPhase(loop.phase)) {
          return this.reconcileTerminal(loop);
        }
        if (loop.cancelRequested) {
          loop = await this.finalize(loopId, { phase: "CANCELLED", outcome: "CANCELLED" });
          continue;
        }

        // PART B: reconcile persisted claims against authoritative Factory
        // state BEFORE budgets or any new claim — a completed-but-
        // uncheckpointed action must be adopted (and counted exactly once)
        // before the budget can be evaluated or anything new launches.
        const reconciled = await this.reconcile(loop, ownerToken);
        if (reconciled.kind === "conflict") {
          const handled = await this.handleConflict(loopId);
          if (handled.action === "return") return handled.loop;
          continue;
        }
        if (reconciled.kind === "recovery" || reconciled.kind === "updated") {
          continue;
        }

        const exceeded = this.budgetExceeded(loop);
        if (exceeded !== undefined) {
          loop = await this.finalize(loopId, {
            phase: "EXHAUSTED",
            outcome: "EXHAUSTED",
            failureReason: exceeded.reason,
            exhaustionKind: exceeded.kind,
          });
          continue;
        }

        const step = await this.runOneStep(loop, ctx);
        if (step.kind === "conflict") {
          const handled = await this.handleConflict(loopId);
          if (handled.action === "return") return handled.loop;
          continue;
        }
        loop = step.loop;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[loop ${loopId}] FAILED: ${message}`);
      let current: EngineeringLoop;
      try {
        current = await this.requireLoop(loopId);
        if (!isTerminalLoopPhase(current.phase)) {
          current = await this.finalize(loopId, { phase: "FAILED", outcome: "FAILED", failureReason: message }, { skipBlock: true });
        }
      } catch {
        // The loop store itself is unavailable (the closest analog of a real
        // process death): propagate the original failure rather than
        // fabricating any state or touching the WorkItem.
        throw error;
      }
      if (current.phase === "FAILED" || current.phase === "EXHAUSTED" || current.phase === "RECOVERY_REQUIRED") {
        await this.tryBlockWorkItem(current.workItemId, message);
      }
      return current;
    }
  }

  /** A lost claim/phase CAS: cancellation and terminality are handled; anything else means another live process is driving — back off. */
  private async handleConflict(loopId: string): Promise<{ action: "continue" } | { action: "return"; loop: EngineeringLoop }> {
    const fresh = await this.requireLoop(loopId);
    if (isTerminalLoopPhase(fresh.phase)) {
      return { action: "return", loop: fresh };
    }
    if (fresh.cancelRequested) {
      return { action: "continue" };
    }
    this.log(`[loop ${loopId}] lost a coordination race; another process appears to be driving this loop — backing off`);
    return { action: "return", loop: fresh };
  }

  private budgetExceeded(loop: EngineeringLoop): { reason: string; kind: ExhaustionKind } | undefined {
    if (loop.budget.maxWallClockMs !== undefined && this.clock.now() - loop.startedAt > loop.budget.maxWallClockMs) {
      return { reason: `wall-clock budget of ${loop.budget.maxWallClockMs}ms exceeded`, kind: "WALL_CLOCK" };
    }
    if (loop.budget.maxTotalRuns !== undefined && loop.totalRunCount >= loop.budget.maxTotalRuns) {
      return { reason: `maximum total run count of ${loop.budget.maxTotalRuns} reached`, kind: "TOTAL_RUNS" };
    }
    return undefined;
  }

  // =====================================================================
  // Reconciliation (PART B/C): claims vs authoritative Factory state
  // =====================================================================

  private async reconcile(loop: EngineeringLoop, ownerToken: string): Promise<ReconcileResult> {
    const last = loop.iterations.at(-1);
    if (last === undefined) {
      return { kind: "clean" };
    }

    // Fetched once and reused for every slot below: both the completed-slot
    // consistency check and the incomplete-slot lookup read the same
    // authoritative snapshot.
    const allRuns = await this.factory.listRuns(loop.workItemId);

    for (const slot of ["implement", "verify", "review"] as const) {
      const claim = slotClaim(last, slot);
      if (claim === undefined) {
        continue;
      }

      const completedRunId = slotRunId(last, slot);
      if (completedRunId !== undefined) {
        // HIGH 2 defense in depth (remediation round 2): loopSerialization.ts
        // already rejects a claim whose actionId/correlationTag was forged to
        // reference a different action's identity — but a row could instead
        // be corrupted by pointing an ALREADY-COMPLETED slot's runId field
        // directly at an arbitrary existing Run, bypassing the claim
        // entirely. Re-verify, on every reconciliation pass, that whatever
        // Run a completed slot names still genuinely carries this exact
        // claim's canonical correlation tag — never just trust a stored id.
        const run = allRuns.find((candidate) => candidate.id === completedRunId);
        if (run === undefined || run.declaredWorkerId !== claim.correlationTag) {
          await this.recoveryRequired(
            loop.id,
            `${slot} run ${completedRunId} does not carry the expected correlation tag ${claim.correlationTag} for action ${claim.actionId} — the stored completion is inconsistent with its own claim`,
          );
          return { kind: "recovery" };
        }
        continue;
      }

      const prefix = correlationPrefix(claim.actionId);
      const matching = allRuns.filter((run) => run.declaredWorkerId.startsWith(prefix));
      const current = matching.filter((run) => run.declaredWorkerId === claim.correlationTag);
      const stale = matching.filter((run) => run.declaredWorkerId !== claim.correlationTag);

      // A superseded attempt that is RUNNING or SUCCEEDED means external work
      // may have been duplicated — detected, fail closed, never silently
      // adopted or continued (design doc: post-hoc double-launch detection).
      const dangerousStale = stale.filter((run) => run.status !== "FAILED");
      if (dangerousStale.length > 0) {
        await this.recoveryRequired(
          loop.id,
          `superseded attempt run(s) ${dangerousStale.map((run) => run.id).join(", ")} of action ${claim.actionId} have unprovable or successful outcomes; possible duplicated external work`,
        );
        return { kind: "recovery" };
      }
      if (current.length > 1) {
        await this.recoveryRequired(loop.id, `multiple runs carry correlation tag ${claim.correlationTag}; the store is not in a state this protocol can have produced`);
        return { kind: "recovery" };
      }

      const run = current[0];
      if (run !== undefined) {
        if (run.role !== SLOT_ROLE[slot]) {
          await this.recoveryRequired(loop.id, `run ${run.id} carries tag ${claim.correlationTag} but role ${run.role}, expected ${SLOT_ROLE[slot]}`);
          return { kind: "recovery" };
        }
        if (run.status === "RUNNING") {
          // PART Q: the child process is gone or unobservable; its outcome
          // cannot be proven. Do not invent evidence, do not relaunch.
          await this.recoveryRequired(
            loop.id,
            `run ${run.id} (action ${claim.actionId}) is durably RUNNING but its outcome cannot be proven after restart; operator action required`,
          );
          return { kind: "recovery" };
        }
        this.log(`[loop ${loop.id}] reconciliation adopted completed ${slot} run ${run.id} (${run.status}) — no relaunch`);
        await this.recordWorkerCompletion(loop.id, last.iteration, slot, claim.actionId, claim.attempt, run, {
          recovered: true,
          supersededRunIds: stale.map((entry) => entry.id),
        });
        return { kind: "updated" };
      }

      // No Run for the current attempt: PHASE 1 never committed.
      if (claim.ownerToken === ownerToken) {
        return { kind: "clean" }; // our own fresh claim; the step will launch it
      }
      // Crashed-owner takeover (PART D: non-expiring claim + explicit crash
      // reconciliation): re-claim under a new attempt/tag so a pathological
      // still-alive prior owner is detectable post-hoc, then launch exactly
      // once. The pre-flight guard aborts the prior owner's launch if it
      // wakes after this commit.
      const attempt = claim.attempt + 1;
      const reclaimed: WorkerActionClaim = {
        ...claim,
        attempt,
        ownerToken,
        claimedAt: this.clock.now(),
        correlationTag: correlationTag(claim.actionId, attempt),
        ...(stale.length === 0 && (claim.supersededRunIds === undefined || claim.supersededRunIds.length === 0)
          ? {}
          : { supersededRunIds: [...new Set([...(claim.supersededRunIds ?? []), ...stale.map((entry) => entry.id)])] }),
      };
      this.log(`[loop ${loop.id}] taking over unlaunched ${slot} action ${claim.actionId} from a previous owner (attempt ${attempt})`);
      try {
        await this.strictSave(loop, { iterations: replaceLast(loop.iterations, withSlotClaim(last, slot, reclaimed)) });
      } catch (error) {
        if (error instanceof ConcurrencyError) return { kind: "conflict" };
        throw error;
      }
      return { kind: "updated" };
    }

    return { kind: "clean" };
  }

  /**
   * Terminal-phase housekeeping a crash may have left unfinished (PART B
   * window 7), plus the HIGH 2 (round 3) authority re-derivation for a
   * reloaded WAITING_FOR_HUMAN loop. Returns the loop to expose — unchanged
   * when it is legitimately authoritative, or the demoted RECOVERY_REQUIRED
   * loop when a persisted WAITING_FOR_HUMAN can no longer prove current
   * Factory authority.
   */
  private async reconcileTerminal(loop: EngineeringLoop): Promise<EngineeringLoop> {
    if (loop.phase === "WAITING_FOR_HUMAN") {
      return this.reconcileWaitingAuthority(loop);
    }
    if (loop.phase === "EXHAUSTED" || loop.phase === "FAILED" || loop.phase === "RECOVERY_REQUIRED") {
      await this.tryBlockWorkItem(loop.workItemId, loop.failureReason ?? loop.phase);
    }
    return loop;
  }

  /**
   * THE single durable answer to "may this persisted WAITING_FOR_HUMAN be
   * exposed as authoritative?" — shared by every mutating entry point that can
   * surface a terminal loop (`drive()`/`resume()` via `reconcileTerminal`, and
   * `cancel()`); `status()` asks the same Factory resolver but keeps its
   * read-only projection instead of writing.
   *
   * A persisted `phase = WAITING_FOR_HUMAN` (and the cached PASS verdict on the
   * last iteration) is orchestration checkpoint state, NEVER authority. Before
   * exposing it as a valid current outcome, the Factory Core must prove the
   * independent-review lineage still holds RIGHT NOW — current implementation
   * at the current spec revision, its current passing deterministic
   * verification, and an independent passing semantic review of that exact
   * implementation backed by a real, current, successful reviewer run. A
   * missing WorkItem, a superseded implementation/verifier/reviewer generation,
   * a newer blocking review, or a non-independent reviewer all fail closed. No
   * new worker/model work is launched on this path.
   */
  private async reconcileWaitingAuthority(loop: EngineeringLoop): Promise<EngineeringLoop> {
    const authority = await this.factory.resolveWaitingForHumanAuthority(loop.workItemId);
    if (authority.ok) {
      return loop;
    }
    return this.failClosedToRecovery(
      loop,
      `persisted WAITING_FOR_HUMAN is not backed by current Factory authority: ${authority.reason}`,
    );
  }

  /**
   * Fail-closed demotion to RECOVERY_REQUIRED (HIGH 2, round 3) from the
   * authority-bearing REVIEWING/WAITING_FOR_HUMAN states — the one place that
   * may move a WAITING_FOR_HUMAN loop out of its terminal phase, because it is
   * recovering from a state whose durable authority can no longer be proven
   * (`finalize`, by contrast, refuses to touch any terminal loop). Never
   * overrides an unrelated terminal outcome (CANCELLED/EXHAUSTED/FAILED). The
   * WorkItem is moved to BLOCKED for human attention, exactly like every other
   * recovery/exhaustion path.
   */
  private async failClosedToRecovery(loop: EngineeringLoop, reason: string): Promise<EngineeringLoop> {
    this.log(`[loop ${loop.id}] RECOVERY_REQUIRED: ${reason}`);
    const demoted = await this.factSave(loop.id, (fresh) => {
      if (fresh.phase !== "REVIEWING" && fresh.phase !== "WAITING_FOR_HUMAN") {
        return null;
      }
      return { phase: "RECOVERY_REQUIRED", outcome: "RECOVERY_REQUIRED", failureReason: reason };
    });
    await this.tryBlockWorkItem(demoted.workItemId, reason);
    return demoted;
  }

  // =====================================================================
  // Steps
  // =====================================================================

  private async runOneStep(loop: EngineeringLoop, ctx: StepContext): Promise<StepResult> {
    switch (loop.phase) {
      case "READY":
        return this.stepReady(loop);
      case "IMPLEMENTING":
        return this.stepImplementing(loop, ctx);
      case "VERIFYING":
        return this.stepVerifying(loop, ctx);
      case "REVIEWING":
        return this.stepReviewing(loop, ctx);
      default:
        return { kind: "advanced", loop };
    }
  }

  private async stepReady(loop: EngineeringLoop): Promise<StepResult> {
    const item = await this.factory.getWorkItem(loop.workItemId);
    if (item.status === "READY") {
      await this.factory.advance(loop.workItemId, "IMPLEMENTING", this.orchestratorActor, {
        reason: "autonomous engineering loop started",
      });
    } else if (item.status !== "IMPLEMENTING") {
      throw new Error(`unexpected work item status ${item.status} while starting the loop (expected READY or IMPLEMENTING)`);
    }
    return this.strictStep(loop, { phase: "IMPLEMENTING", iterations: [openIteration(1)] });
  }

  private async stepImplementing(loop: EngineeringLoop, ctx: StepContext): Promise<StepResult> {
    const last = loop.iterations.at(-1);
    if (last === undefined) {
      throw new Error(`internal: loop ${loop.id} is IMPLEMENTING with no open iteration`);
    }

    if (last.implementerOutcome === "SUCCEEDED") {
      const item = await this.factory.getWorkItem(loop.workItemId);
      if (item.status === "IMPLEMENTING") {
        await this.factory.advance(loop.workItemId, "VERIFYING", this.orchestratorActor);
      } else if (item.status !== "VERIFYING") {
        throw new Error(`unexpected work item status ${item.status} while advancing IMPLEMENTING -> VERIFYING`);
      }
      return this.strictStep(loop, { phase: "VERIFYING" });
    }
    if (last.implementerOutcome === "FAILED") {
      return this.remediateOrExhaust(loop, "IMPLEMENTING", `implementer run ${last.implementerRunId ?? "?"} failed to execute`);
    }

    const claimed = await this.claimIfNeeded(loop, last, "implement", ctx.ownerToken);
    if (claimed.kind === "conflict") return claimed;
    const { loop: claimedLoop, claim } = claimed;

    const previous = claimedLoop.iterations.at(-2);
    const iterationNumber = claimedLoop.iterations.at(-1)!.iteration;
    this.log(
      `[loop ${loop.id}] iteration ${iterationNumber}: running IMPLEMENTER (${loop.implementer.tool}/${loop.implementer.model})`,
    );
    const updated = await this.launchClaimedWorker(claimedLoop, iterationNumber, "implement", claim, {
      worker: ctx.implementerWorker,
      instructions: buildImplementerInstructions(claimedLoop, iterationNumber, previous),
    });
    return { kind: "advanced", loop: updated };
  }

  private async stepVerifying(loop: EngineeringLoop, ctx: StepContext): Promise<StepResult> {
    const last = loop.iterations.at(-1);
    if (last === undefined) {
      throw new Error(`internal: loop ${loop.id} is VERIFYING with no open iteration`);
    }

    if (last.verificationPassed === true) {
      const item = await this.factory.getWorkItem(loop.workItemId);
      if (item.status === "VERIFYING") {
        await this.factory.advance(loop.workItemId, "REVIEW", this.orchestratorActor);
      } else if (item.status !== "REVIEW") {
        throw new Error(`unexpected work item status ${item.status} while advancing VERIFYING -> REVIEW`);
      }
      return this.strictStep(loop, { phase: "REVIEWING" });
    }
    if (last.verificationPassed === false) {
      return this.remediateOrExhaust(loop, "VERIFYING", `deterministic verification failed (review ${last.verificationReviewId ?? "?"})`);
    }

    if (last.verificationRunId !== undefined) {
      // Completed verify run, deterministic review not yet recorded.
      const run = await this.requireRun(loop.workItemId, last.verificationRunId);
      if (run.status === "FAILED") {
        // The harness itself did not complete — a configuration/environment
        // problem no remediation attempt can fix; fail the loop closed
        // rather than burning model calls retrying it.
        throw new Error(`verification harness failed to execute (run ${run.id}); the loop cannot proceed safely`);
      }

      const claimed = await this.claimReviewRecordIfNeeded(loop, last, "deterministic", ctx.ownerToken);
      if (claimed.kind === "conflict") return claimed;
      const freshLast = claimed.loop.iterations.at(-1)!;

      const results = freshLast.verificationCommandResults;
      const allPassed = results !== undefined ? results.length > 0 && results.every((result) => result.passed) : run.claimsAcceptanceMet;
      const findings =
        results !== undefined
          ? results.filter((result) => !result.passed).map((result) => `${result.commandId}: ${result.terminationReason}`)
          : allPassed
            ? []
            : [`verification failed; see run ${run.id} evidence`];

      const reviews = await this.factory.listReviews(loop.workItemId);
      const existing = reviews.find((review) => review.kind === "DETERMINISTIC" && review.reviewerRunId === run.id);
      const reviewId =
        existing !== undefined
          ? (this.log(`[loop ${loop.id}] reconciliation adopted deterministic review ${existing.id} — no duplicate recording`), existing.id)
          : (
              await this.factory.recordReview({
                workItemId: loop.workItemId,
                reviewedRunId: freshLast.implementerRunId!,
                reviewerRunId: run.id,
                kind: "DETERMINISTIC",
                verdict: allPassed ? "PASS" : "FAIL",
                findings,
              })
            ).id;

      const updated = await this.factSave(loop.id, (fresh) => {
        const iteration = fresh.iterations.at(-1);
        if (iteration === undefined || iteration.iteration !== freshLast.iteration || iteration.verificationReviewId !== undefined) {
          return null;
        }
        return {
          iterations: replaceLast(fresh.iterations, { ...iteration, verificationReviewId: reviewId, verificationPassed: allPassed }),
        };
      });
      return { kind: "advanced", loop: updated };
    }

    const claimed = await this.claimIfNeeded(loop, last, "verify", ctx.ownerToken);
    if (claimed.kind === "conflict") return claimed;
    const { loop: claimedLoop, claim } = claimed;

    const collected: VerificationCommandResult[] = [];
    const verificationWorker = createVerificationWorker({
      commands: claimedLoop.verificationCommands,
      workspace: ctx.workspace,
      processRunner: this.processRunner,
      ...(claimedLoop.budget.verificationTimeoutMs === undefined ? {} : { defaultTimeoutMs: claimedLoop.budget.verificationTimeoutMs }),
      onCommandResult: (result) => collected.push(result),
    });
    const iterationNumber = claimedLoop.iterations.at(-1)!.iteration;
    this.log(
      `[loop ${loop.id}] iteration ${iterationNumber}: running deterministic verification (${claimedLoop.verificationCommands.length} command(s))`,
    );
    const updated = await this.launchClaimedWorker(claimedLoop, iterationNumber, "verify", claim, {
      worker: verificationWorker,
      instructions: "Run the configured deterministic verification commands and record their results.",
      againstRunId: claimedLoop.iterations.at(-1)!.implementerRunId!,
      commandResults: collected,
    });
    return { kind: "advanced", loop: updated };
  }

  private async stepReviewing(loop: EngineeringLoop, ctx: StepContext): Promise<StepResult> {
    const last = loop.iterations.at(-1);
    if (last === undefined) {
      throw new Error(`internal: loop ${loop.id} is REVIEWING with no open iteration`);
    }

    if (last.reviewVerdict === "PASS" || last.reviewVerdict === "PASS_WITH_NON_BLOCKING_NOTES") {
      // PART L: the loop's own verdict field is never what authorizes this
      // transition — factory.advance re-derives the independent semantic
      // review from authoritative Factory records (requireIndependentSemanticReview)
      // and refuses if they disagree.
      const item = await this.factory.getWorkItem(loop.workItemId);
      if (item.status === "REVIEW") {
        await this.factory.advance(loop.workItemId, "WAITING_FOR_HUMAN", this.orchestratorActor);
      } else if (item.status === "WAITING_FOR_HUMAN") {
        // HIGH 2 (round 3): the WorkItem already advanced (through the same
        // precondition) before this loop's phase caught up — a legitimate
        // crash-reconciliation window. The cached PASS verdict + the item's
        // current status are NOT sufficient authority on their own: re-derive
        // the current independent-review lineage before accepting. If it can
        // no longer be proven (a superseded implementation, a stale/missing
        // review, a non-independent reviewer), fail closed rather than exposing
        // an unauthorized WAITING_FOR_HUMAN.
        const authority = await this.factory.resolveWaitingForHumanAuthority(loop.workItemId);
        if (!authority.ok) {
          return {
            kind: "advanced",
            loop: await this.failClosedToRecovery(
              loop,
              `cached PASS at WAITING_FOR_HUMAN is not backed by current Factory authority: ${authority.reason}`,
            ),
          };
        }
      } else {
        throw new Error(`unexpected work item status ${item.status} while advancing REVIEW -> WAITING_FOR_HUMAN`);
      }
      return this.strictStep(loop, { phase: "WAITING_FOR_HUMAN", outcome: "WAITING_FOR_HUMAN" });
    }
    if (last.reviewVerdict === "CHANGES_REQUIRED") {
      return this.remediateOrExhaust(loop, "REVIEW", `reviewer requested changes (review ${last.reviewRecordId ?? "?"})`);
    }
    if (last.reviewParseError !== undefined) {
      return this.remediateOrExhaust(loop, "REVIEW", `reviewer output could not be parsed: ${last.reviewParseError}`);
    }

    if (last.reviewerRunId !== undefined) {
      return this.recordSemanticVerdict(loop, last, ctx);
    }

    const claimed = await this.claimIfNeeded(loop, last, "review", ctx.ownerToken);
    if (claimed.kind === "conflict") return claimed;
    const { loop: claimedLoop, claim } = claimed;

    const iterationNumber = claimedLoop.iterations.at(-1)!.iteration;
    this.log(`[loop ${loop.id}] iteration ${iterationNumber}: running REVIEWER (${loop.reviewer.tool}/${loop.reviewer.model})`);
    const updated = await this.launchClaimedWorker(claimedLoop, iterationNumber, "review", claim, {
      worker: ctx.reviewerWorker,
      instructions: buildReviewerInstructions(claimedLoop, claimedLoop.iterations.at(-1)!),
      againstRunId: claimedLoop.iterations.at(-1)!.implementerRunId!,
    });
    return { kind: "advanced", loop: updated };
  }

  /** Parse the reviewer's structured output and record (or adopt) the semantic Review. */
  private async recordSemanticVerdict(loop: EngineeringLoop, last: LoopIterationRecord, ctx: StepContext): Promise<StepResult> {
    const reviewerRunId = last.reviewerRunId!;
    const run = await this.requireRun(loop.workItemId, reviewerRunId);

    // A FAILED process is an execution failure, never approval — the verdict
    // parser is never even reached for it.
    if (run.status === "FAILED") {
      const updated = await this.factSave(loop.id, (fresh) => {
        const iteration = fresh.iterations.at(-1);
        if (iteration === undefined || iteration.iteration !== last.iteration || iteration.reviewParseError !== undefined) return null;
        return {
          iterations: replaceLast(fresh.iterations, {
            ...iteration,
            reviewParseError: "reviewer run did not complete successfully; treated as an execution failure, never approval",
          }),
        };
      });
      return this.remediateOrExhaust(updated, "REVIEW", `reviewer run ${reviewerRunId} failed to execute`);
    }

    // HIGH 3 / PART I: verdicts are parsed ONLY from the structured
    // `/transcript` evidence channel — the one the CLI adapter produced from
    // a contract-satisfying structured parse. Raw stdout fallback evidence
    // (`/raw-output`) and Run.summary are diagnostics, never verdict input.
    const evidence = await this.factory.listEvidence(loop.workItemId);
    const sources = evidence
      .filter((entry) => entry.runId === reviewerRunId && entry.reference.endsWith(TRANSCRIPT_REFERENCE_SUFFIX))
      .map((entry) => entry.summary);
    const parsed =
      sources.length === 0
        ? ({ ok: false, reason: "no structured reviewer output available; raw process output is never eligible for verdict parsing" } as const)
        : parseReviewVerdict(sources);

    if (!parsed.ok) {
      const updated = await this.factSave(loop.id, (fresh) => {
        const iteration = fresh.iterations.at(-1);
        if (iteration === undefined || iteration.iteration !== last.iteration || iteration.reviewParseError !== undefined) return null;
        return { iterations: replaceLast(fresh.iterations, { ...iteration, reviewParseError: parsed.reason }) };
      });
      return this.remediateOrExhaust(updated, "REVIEW", `reviewer output could not be parsed: ${parsed.reason}`);
    }

    const claimed = await this.claimReviewRecordIfNeeded(loop, last, "semantic", ctx.ownerToken);
    if (claimed.kind === "conflict") return claimed;

    const reviews = await this.factory.listReviews(loop.workItemId);
    const existing = reviews.find((review) => review.kind === "SEMANTIC" && review.reviewerRunId === reviewerRunId);
    let verdict: LoopReviewVerdict;
    let findings: readonly string[];
    let reviewRecordId: string;
    if (existing !== undefined) {
      // Factory state is authoritative (PART L): adopt the recorded Review.
      this.log(`[loop ${loop.id}] reconciliation adopted semantic review ${existing.id} — no duplicate recording`);
      verdict = this.adoptLoopVerdict(existing, parsed.verdict);
      findings = existing.findings;
      reviewRecordId = existing.id;
    } else {
      verdict = parsed.verdict;
      findings = parsed.findings;
      const recorded = await this.factory.recordReview({
        workItemId: loop.workItemId,
        reviewedRunId: last.implementerRunId!,
        reviewerRunId,
        kind: "SEMANTIC",
        verdict: parsed.verdict === "CHANGES_REQUIRED" ? "CHANGES_REQUESTED" : "PASS",
        findings: parsed.findings,
      });
      reviewRecordId = recorded.id;
    }

    const updated = await this.factSave(loop.id, (fresh) => {
      const iteration = fresh.iterations.at(-1);
      if (iteration === undefined || iteration.iteration !== last.iteration || iteration.reviewVerdict !== undefined) return null;
      return {
        iterations: replaceLast(fresh.iterations, { ...iteration, reviewVerdict: verdict, reviewRecordId, reviewFindings: findings }),
      };
    });
    return { kind: "advanced", loop: updated };
  }

  /** Maps an already-recorded domain Review verdict back onto the loop's richer verdict enum, fail closed. */
  private adoptLoopVerdict(existing: Review, parsedVerdict: LoopReviewVerdict): LoopReviewVerdict {
    if (existing.verdict === "PASS") {
      return parsedVerdict === "PASS_WITH_NON_BLOCKING_NOTES" ? "PASS_WITH_NON_BLOCKING_NOTES" : "PASS";
    }
    return "CHANGES_REQUIRED";
  }

  // =====================================================================
  // Claiming and launching
  // =====================================================================

  private async claimIfNeeded(
    loop: EngineeringLoop,
    last: LoopIterationRecord,
    slot: WorkerSlot,
    ownerToken: string,
  ): Promise<{ kind: "conflict" } | { kind: "claimed"; loop: EngineeringLoop; claim: WorkerActionClaim }> {
    const existing = slotClaim(last, slot);
    if (existing !== undefined) {
      // Reconcile guaranteed ownership before the step runs; a foreign claim
      // here means we raced someone between reconcile and step — back off.
      if (existing.ownerToken !== ownerToken) {
        return { kind: "conflict" };
      }
      return { kind: "claimed", loop, claim: existing };
    }

    // HIGH 2 (remediation round 2): actionId is derived, never a random
    // token — see canonicalActionId's doc comment. It is not persisted-then-
    // trusted; loopSerialization.ts recomputes and requires this exact value
    // on every read.
    const actionId = canonicalActionId(loop.id, last.iteration, SLOT_KIND[slot]);
    const claim: WorkerActionClaim = {
      actionId,
      kind: SLOT_KIND[slot],
      attempt: 1,
      ownerToken,
      claimedAt: this.clock.now(),
      correlationTag: correlationTag(actionId, 1),
    };
    try {
      const saved = await this.strictSave(loop, { iterations: replaceLast(loop.iterations, withSlotClaim(last, slot, claim)) });
      return { kind: "claimed", loop: saved, claim };
    } catch (error) {
      if (error instanceof ConcurrencyError) return { kind: "conflict" };
      throw error;
    }
  }

  private async claimReviewRecordIfNeeded(
    loop: EngineeringLoop,
    last: LoopIterationRecord,
    which: "deterministic" | "semantic",
    ownerToken: string,
  ): Promise<{ kind: "conflict" } | { kind: "claimed"; loop: EngineeringLoop }> {
    const existing = which === "deterministic" ? last.deterministicReviewClaim : last.semanticReviewClaim;
    if (existing !== undefined && existing.ownerToken === ownerToken) {
      return { kind: "claimed", loop };
    }
    // Absent, or held by a previous (crashed) owner: (re-)claim it. The
    // subsequent listReviews check is what makes the recording idempotent.
    const claim = { ownerToken, claimedAt: this.clock.now() };
    const patch: Partial<LoopIterationRecord> =
      which === "deterministic" ? { deterministicReviewClaim: claim } : { semanticReviewClaim: claim };
    try {
      const saved = await this.strictSave(loop, { iterations: replaceLast(loop.iterations, { ...last, ...patch }) });
      return { kind: "claimed", loop: saved };
    } catch (error) {
      if (error instanceof ConcurrencyError) return { kind: "conflict" };
      throw error;
    }
  }

  private async launchClaimedWorker(
    loop: EngineeringLoop,
    iterationNumber: number,
    slot: WorkerSlot,
    claim: WorkerActionClaim,
    input: {
      readonly worker: Worker;
      readonly instructions: string;
      readonly againstRunId?: RunId;
      readonly commandResults?: VerificationCommandResult[];
    },
  ): Promise<EngineeringLoop> {
    const guarded = this.guardedWorker(input.worker, loop.id, iterationNumber, slot, claim);
    this.factory.registerWorker(guarded);

    let run: Run;
    try {
      const result = await this.factory.runWorker({
        workItemId: loop.workItemId,
        role: SLOT_ROLE[slot],
        worker: guarded,
        instructions: input.instructions,
        ...(input.againstRunId === undefined ? {} : { againstRunId: input.againstRunId }),
      });
      run = result.run;
    } catch (error) {
      // A thrown WorkerExecutionError still left an honest FAILED run in
      // PHASE 3 — recover it by its exact correlation tag, never by guessing
      // at the latest run (PART C).
      const runs = await this.factory.listRuns(loop.workItemId);
      const matches = runs.filter((candidate) => candidate.declaredWorkerId === claim.correlationTag);
      if (matches.length !== 1) {
        throw error; // nothing durably recorded for this action — a genuine orchestration failure
      }
      run = matches[0]!;
    }

    return this.recordWorkerCompletion(loop.id, iterationNumber, slot, claim.actionId, claim.attempt, run, {
      recovered: false,
      ...(input.commandResults === undefined ? {} : { commandResults: input.commandResults }),
    });
  }

  /**
   * The pre-flight guard (PART F): re-reads durable loop state at the last
   * possible moment before any external process could start. A
   * durably-committed cancellation, a terminal loop, or lost action
   * ownership aborts with an honest FAILED outcome — no process is spawned,
   * so the Run record finalizes as an aborted attempt with zero external
   * side effects.
   */
  private guardedWorker(inner: Worker, loopId: string, iterationNumber: number, slot: WorkerSlot, claim: WorkerActionClaim): Worker {
    const loops = this.loops;
    const abort = (request: WorkerRequest, reason: string): WorkerOutcome => ({
      status: "FAILED",
      summary: `aborted before any external process started: ${reason}`,
      evidence: [
        {
          kind: "NOTE",
          summary: `aborted before any external process started: ${reason}`,
          reference: `sf-loop://aborted/${request.runId}`,
        },
      ],
      claimsAcceptanceMet: false,
    });

    return {
      id: claim.correlationTag,
      capabilities: inner.capabilities,
      async execute(request: WorkerRequest): Promise<WorkerOutcome> {
        const current = await loops.findById(loopId);
        if (current === undefined) {
          return abort(request, "loop record no longer exists");
        }
        if (isTerminalLoopPhase(current.phase)) {
          return abort(request, `loop is ${current.phase}`);
        }
        if (current.cancelRequested) {
          return abort(request, "cancellation was durably requested");
        }
        const iteration = current.iterations.find((entry) => entry.iteration === iterationNumber);
        const liveClaim = iteration === undefined ? undefined : slotClaim(iteration, slot);
        if (
          liveClaim === undefined ||
          liveClaim.actionId !== claim.actionId ||
          liveClaim.attempt !== claim.attempt ||
          liveClaim.ownerToken !== claim.ownerToken
        ) {
          return abort(request, "action ownership was lost to another process");
        }
        return inner.execute(request);
      },
    };
  }

  /**
   * Completion is a FACT about an already-authorized launch (the loop-side
   * analog of runWorker's PHASE 3): recorded with bounded re-read-and-merge,
   * exactly once per action attempt, even onto a loop that went CANCELLED or
   * RECOVERY_REQUIRED mid-flight. A run from a superseded attempt is
   * appended to the claim's audit list instead — never counted as the
   * current attempt's result, never incrementing budgets (PART O).
   */
  private async recordWorkerCompletion(
    loopId: string,
    iterationNumber: number,
    slot: WorkerSlot,
    actionId: string,
    attempt: number,
    run: Run,
    options: { readonly recovered: boolean; readonly commandResults?: readonly VerificationCommandResult[]; readonly supersededRunIds?: readonly RunId[] },
  ): Promise<EngineeringLoop> {
    const outcome: "SUCCEEDED" | "FAILED" = run.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED";
    return this.factSave(loopId, (fresh) => {
      const index = fresh.iterations.findIndex((entry) => entry.iteration === iterationNumber);
      if (index === -1) return null;
      const iteration = fresh.iterations[index]!;
      const claim = slotClaim(iteration, slot);
      if (claim === undefined || claim.actionId !== actionId) {
        return null;
      }

      if (claim.attempt !== attempt) {
        // We were superseded mid-flight; preserve the run for audit only.
        if (claim.supersededRunIds?.includes(run.id) === true) return null;
        const updatedClaim: WorkerActionClaim = { ...claim, supersededRunIds: [...(claim.supersededRunIds ?? []), run.id] };
        const iterations = [...fresh.iterations];
        iterations[index] = withSlotClaim(iteration, slot, updatedClaim);
        return { iterations };
      }

      if (slotRunId(iteration, slot) !== undefined) {
        return null; // already recorded (e.g. adopted by a concurrent reconciler)
      }

      const superseded = [...new Set([...(claim.supersededRunIds ?? []), ...(options.supersededRunIds ?? [])])];
      const updatedClaim: WorkerActionClaim = {
        ...claim,
        ...(options.recovered ? { recovered: true } : {}),
        ...(superseded.length === 0 ? {} : { supersededRunIds: superseded }),
      };
      let updatedIteration = withSlotClaim(iteration, slot, updatedClaim);
      switch (slot) {
        case "implement":
          updatedIteration = { ...updatedIteration, implementerRunId: run.id, implementerOutcome: outcome };
          break;
        case "verify":
          updatedIteration = {
            ...updatedIteration,
            verificationRunId: run.id,
            ...(options.commandResults === undefined || options.commandResults.length === 0
              ? {}
              : { verificationCommandResults: options.commandResults }),
          };
          break;
        case "review":
          updatedIteration = { ...updatedIteration, reviewerRunId: run.id };
          break;
      }
      const iterations = [...fresh.iterations];
      iterations[index] = updatedIteration;
      return { iterations, totalRunCount: fresh.totalRunCount + 1 };
    });
  }

  // =====================================================================
  // Remediation / terminal transitions
  // =====================================================================

  private async remediateOrExhaust(loop: EngineeringLoop, fromStatus: WorkItemStatus, reason: string): Promise<StepResult> {
    if (loop.iterations.length >= loop.budget.maxIterations) {
      const finalized = await this.finalize(loop.id, {
        phase: "EXHAUSTED",
        outcome: "EXHAUSTED",
        failureReason: reason,
        exhaustionKind: "ITERATIONS",
      });
      return { kind: "advanced", loop: finalized };
    }

    if (fromStatus !== "IMPLEMENTING") {
      const item = await this.factory.getWorkItem(loop.workItemId);
      if (item.status === fromStatus) {
        await this.factory.advance(loop.workItemId, "IMPLEMENTING", this.orchestratorActor, { reason });
      } else if (item.status !== "IMPLEMENTING") {
        throw new Error(`unexpected work item status ${item.status} while remediating from ${fromStatus}`);
      }
    }

    const nextIteration = loop.iterations.length + 1;
    this.log(`[loop ${loop.id}] remediating (${reason}) — opening iteration ${nextIteration}/${loop.budget.maxIterations}`);
    return this.strictStep(loop, { phase: "IMPLEMENTING", iterations: [...loop.iterations, openIteration(nextIteration)] });
  }

  private async recoveryRequired(loopId: string, reason: string): Promise<EngineeringLoop> {
    this.log(`[loop ${loopId}] RECOVERY_REQUIRED: ${reason}`);
    const loop = await this.finalize(loopId, { phase: "RECOVERY_REQUIRED", outcome: "RECOVERY_REQUIRED", failureReason: reason });
    await this.tryBlockWorkItem(loop.workItemId, reason);
    return loop;
  }

  /**
   * Moves the loop to a terminal phase with bounded retries; an already-
   * terminal loop wins (first finalization is authoritative). EXHAUSTED also
   * performs the courtesy WorkItem BLOCKED transition.
   */
  private async finalize(
    loopId: string,
    patch: Partial<Pick<EngineeringLoop, "phase" | "outcome" | "failureReason" | "exhaustionKind">>,
    options: { readonly skipBlock?: boolean } = {},
  ): Promise<EngineeringLoop> {
    const finalized = await this.factSave(loopId, (fresh) => (isTerminalLoopPhase(fresh.phase) ? null : patch));
    if (finalized.phase === "EXHAUSTED" && options.skipBlock !== true) {
      this.log(`[loop ${loopId}] EXHAUSTED: ${finalized.failureReason ?? ""}`);
      await this.tryBlockWorkItem(finalized.workItemId, finalized.failureReason ?? "budget exhausted");
    }
    if (finalized.phase === "CANCELLED") {
      this.log(`[loop ${loopId}] CANCELLED`);
    }
    return finalized;
  }

  private async tryBlockWorkItem(workItemId: WorkItemId, reason: string): Promise<void> {
    try {
      const item = await this.factory.getWorkItem(workItemId);
      if (item.status !== "BLOCKED" && !isTerminal(item.status)) {
        await this.factory.advance(workItemId, "BLOCKED", this.orchestratorActor, {
          reason: `autonomous loop stopped: ${reason}`,
        });
      }
    } catch (error) {
      this.log(`[warn] could not move work item ${workItemId} to BLOCKED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // =====================================================================
  // Persistence discipline
  // =====================================================================

  /**
   * Single CAS, no retry: for claims and phase transitions, a lost race must
   * surface (the winner may have been a cancellation) — never be blindly
   * re-applied. This is the linearization discipline HIGH 6 demanded.
   */
  private async strictSave(loop: EngineeringLoop, patch: Partial<Omit<EngineeringLoop, "id" | "workItemId" | "version">>): Promise<EngineeringLoop> {
    const next: EngineeringLoop = { ...loop, ...patch, version: loop.version + 1, lastTransitionAt: this.clock.now() };
    return this.loops.compareAndSave(next, loop.version);
  }

  private async strictStep(loop: EngineeringLoop, patch: Partial<Omit<EngineeringLoop, "id" | "workItemId" | "version">>): Promise<StepResult> {
    try {
      return { kind: "advanced", loop: await this.strictSave(loop, patch) };
    } catch (error) {
      if (error instanceof ConcurrencyError) return { kind: "conflict" };
      throw error;
    }
  }

  /**
   * Bounded re-read-and-merge for FACTS (completions, cancellation intent,
   * terminal outcomes): `mutate` receives the fresh row and returns the
   * fields to change, or null for "already recorded / no longer applicable".
   * Only fields the specific fact owns are ever touched, so re-applying on a
   * fresh row is always safe — this is deliberately NOT available to claims.
   */
  private async factSave(
    loopId: string,
    mutate: (fresh: EngineeringLoop) => Partial<Omit<EngineeringLoop, "id" | "workItemId" | "version">> | null,
  ): Promise<EngineeringLoop> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const fresh = await this.requireLoop(loopId);
      const patch = mutate(fresh);
      if (patch === null) {
        return fresh;
      }
      try {
        return await this.strictSave(fresh, patch);
      } catch (error) {
        if (!(error instanceof ConcurrencyError) || attempt === 9) {
          throw error;
        }
      }
    }
    throw new Error("unreachable");
  }

  private async requireRun(workItemId: WorkItemId, runId: RunId): Promise<Run> {
    const runs = await this.factory.listRuns(workItemId);
    const run = runs.find((candidate) => candidate.id === runId);
    if (run === undefined) {
      throw new Error(`internal: run ${runId} not found for work item ${workItemId}`);
    }
    return run;
  }

  private async requireLoop(id: string): Promise<EngineeringLoop> {
    const loop = await this.loops.findById(id);
    if (loop === undefined) {
      throw new NotFoundError("EngineeringLoop", id);
    }
    return loop;
  }
}

export type { LoopIterationRecord };
