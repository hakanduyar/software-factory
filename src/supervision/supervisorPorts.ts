/**
 * The narrow seams between the supervisor and everything it drives.
 *
 * These exist so the supervisor can be tested — and reasoned about — without a
 * real provider, a real model or a real clock, and so that TASK-006
 * re-implements neither TASK-004's engineering loop nor TASK-005's planner. It
 * SCHEDULES them through `WorkExecutor`; it does not know what they do.
 */

import type { Timestamp } from "../domain/time.js";
import type { AiRunConfigRecord } from "./modelEnforcement.js";
import type { Classification } from "./resourceClassifier.js";
import type { BillingMode, SupervisedAction } from "./financialSafety.js";
import type { RoadmapItem, SessionCheckpoint, SupervisorState } from "./supervisorTypes.js";
import type { CandidateBinding, LaunchAcknowledgement } from "./acceptance.js";
import type { ActivityLease } from "./activity.js";
import type {
  WorkerRunCompletionInput,
  WorkerRunEnvelope,
  WorkerRunHeartbeat,
} from "./workerRunEnvelope.js";

/**
 * Proof, checkable at runtime, that a specific action never reached a worker
 * launch (DEFECT-NO-LAUNCH-LINEAGE).
 *
 * The type alone proves nothing — any object can be shaped like this one.
 * `planBackedExecutor.ts` is the only module that can ever produce a value
 * that its own `verifyNoLaunchEvidence` accepts: minting happens through a
 * function that module never exports, closed over a registry that module
 * never exports either, so no caller — first, last, or the only one — can
 * obtain a working mint regardless of import order. Round 4 additionally
 * binds each value to the exact `WorkExecutor` instance that minted it, so
 * an arbitrary executor cannot borrow the boundary by constructing its own
 * `createPlanBackedExecutor` helper and forwarding the helper's evidence as
 * its own — that evidence stays bound to the helper, not to the executor
 * `SupervisorService` actually dispatched to. Round 5 (C5) additionally
 * binds each value to the exact `WorkOutcome` object minted alongside it, so
 * the same executor object cannot be handed authority by replacing its
 * `execute` method in place and repackaging the trusted call's evidence into
 * a new, self-authored outcome. Round 6 (C6) closes what binding evidence
 * could not: a wrapper that forwarded the trusted call's own, unmodified
 * result still let an uncertain outer execution borrow trust, because
 * `execute` remained a plain, replaceable property. `createPlanBackedExecutor`
 * now returns an object whose `execute` is a runtime-immutable own property,
 * so no wrapper — repackaging or transparent — can ever be installed in its
 * place. See the comment on `verifyNoLaunchEvidence` there for what `verify`
 * actually checks.
 */
export interface NoLaunchEvidence {
  readonly actionId: string;
  readonly reason: string;
}

export interface SupervisorRepository {
  load(): Promise<SupervisorState | undefined>;
  create(state: SupervisorState): Promise<SupervisorState>;
  /** CAS on `version`; throws ConcurrencyError when the expected version is stale. */
  compareAndSave(next: SupervisorState, expectedVersion: number): Promise<SupervisorState>;
  /**
   * The roadmap catalog version this database records (TASK-018 AC-1).
   *
   * `undefined` means NO RECORD, which every database written before TASK-018
   * is, and which `planCatalogUpgrade` reads as exactly one version rather than
   * as "whatever the rows happen to be".
   */
  readCatalogVersion(): Promise<number | undefined>;
  /**
   * Moves the state and the recorded catalog version TOGETHER (TASK-018 AC-5).
   *
   * Deliberately NOT `compareAndSave` followed by a second write. Two writes
   * have a gap between them, and a process that dies inside that gap leaves a
   * database whose rows are at one version and whose record says another — the
   * half-applied state AC-6 exists to make impossible. Implementations must
   * make this atomic and must keep the CAS semantics `compareAndSave` has.
   */
  applyCatalogUpgrade(
    next: SupervisorState,
    expectedVersion: number,
    toCatalogVersion: number,
  ): Promise<SupervisorState>;
}

/**
 * A ZERO-TOKEN availability probe.
 *
 * Implementations must not invoke a model. The real adapter uses the measured
 * commands `codex doctor --json` and `claude auth status`, both of which are
 * local/auth checks that cost nothing. Using a model to find out whether a
 * model is available is the exact anti-pattern TASK-006 exists to remove.
 */
export interface ResourceProbe {
  probe(provider: string, model: string): Promise<Classification>;
}

/**
 * One AI resource a piece of work will launch, named by the ROLE that launches
 * it (TASK-015 AC-2).
 *
 * Roles are not aliases. A plan's planner, implementer and reviewer are three
 * different jobs that may legitimately run on three different models — and for
 * critical work C4 REQUIRES the reviewer to differ from the implementer. The
 * role travels with the identity so provenance can say which role used which
 * resource, rather than recording a set and losing who was who.
 */
/**
 * The roles a declaration may name (round-2 finding 3, CRITICAL).
 *
 * `role` was an unrestricted string, and settlement picked the first entry
 * spelled exactly `"implementer"` or fell back to the routed resource. So a
 * declaration with `"implementor"`, or none at all, recorded the WRONG resource
 * as the implementer — and the reviewer drove the consequence out: the next
 * independent review then selected the resource that had really implemented and
 * advanced. C4 broken by a typo.
 *
 * A closed set makes the misspelling a compile error where the caller is typed,
 * and `validateDeclaredRoles` makes it a refusal where it is data.
 */
export const REQUIRED_RESOURCE_ROLES = ["planner", "implementer", "reviewer"] as const;

export type RequiredResourceRole = (typeof REQUIRED_RESOURCE_ROLES)[number];

export interface RequiredResource {
  readonly role: RequiredResourceRole;
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
}

/**
 * A resource the supervisor has INDIVIDUALLY probed and gated for this action.
 *
 * Membership is the authority. There is no "same provider, therefore allowed"
 * and no inheriting permission from a sibling that passed: every member of this
 * list went through the same probe, the same billing observation and the same
 * financial gate as a single routed resource does.
 */
export interface AuthorizedResource extends Omit<RequiredResource, "role"> {
  /** A declared role, or `routed` for the resource the router itself chose. */
  readonly role: RequiredResourceRole | "routed";
  /** Observed in-process immediately before the gate, never read from a row. */
  readonly billingMode: BillingMode;
}

export interface WorkExecutionInput {
  readonly item: RoadmapItem;
  readonly actionId: string;
  /** Absent for DETERMINISTIC work, which needs no AI resource at all. */
  readonly config?: AiRunConfigRecord;
  /**
   * EVERY resource this action may launch, one entry per role (TASK-015).
   *
   * The executor declared what the work needs; the supervisor decided. An
   * executor may not launch a resource that is absent from this list, and the
   * list is exact — it is not a hint, a preference or a starting point.
   */
  readonly authorizedResources?: readonly AuthorizedResource[];
  /** Present when resuming: what a previous session got done. */
  readonly checkpoint?: SessionCheckpoint;
}

/**
 * What the executor reports back. Every variant is a fact about the work, never
 * an instruction about what the supervisor should do next — that decision
 * belongs to the supervisor, from durable state.
 */
/**
 * What the provider said it actually was, when it says anything at all.
 *
 * Review finding F4-9 (HIGH): the supervisor built a launch configuration and
 * had no way to learn what was really run, so a worker could launch a different
 * model or effort, report COMPLETED, and be believed. This is the channel for
 * that evidence. It is OPTIONAL and it is a CLAIM, not proof — an executor is
 * trusted code and could lie — but a claim that CONTRADICTS the request is
 * something the supervisor can and now does refuse to accept.
 */
export interface ReportedRunIdentity {
  /**
   * F5-ID-1: provider was not a dimension at all, so a worker could run on a
   * different provider entirely while echoing a matching model name.
   */
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
}

export type WorkOutcome =
  /** The item is finished and independently accepted. */
  | { readonly kind: "COMPLETED"; readonly detail: string; readonly reportedIdentity?: ReportedRunIdentity }
  /** Independent review found blockers; remediation is required. */
  | { readonly kind: "CHANGES_REQUIRED"; readonly findings: readonly string[] }
  /**
   * The provider failed. The raw process facts are handed back so the
   * SUPERVISOR classifies them — the executor never decides what a failure
   * means about a resource.
   */
  | {
      readonly kind: "RESOURCE_FAILURE";
      readonly process: {
        readonly terminationReason: "EXITED" | "TIMEOUT" | "CANCELLED" | "SPAWN_ERROR";
        readonly exitCode: number | null;
        readonly stdout: string;
        readonly stderr: string;
      };
      /** Only when the provider genuinely stated one. Never invented. */
      readonly retryAt?: Timestamp;
    }
  /** Progress was made, but the session must roll over (context exhausted). */
  | {
      readonly kind: "CHECKPOINT";
      readonly checkpoint: SessionCheckpoint;
      readonly detail: string;
      readonly reportedIdentity?: ReportedRunIdentity;
    }
  /** The work needs something only a human can do. */
  | {
      readonly kind: "HUMAN_REQUIRED";
      readonly action: SupervisedAction;
      readonly detail: string;
      /**
       * PRESENT ONLY when the executor's own deterministic boundary proved no
       * worker was launched for THIS action (DEFECT-NO-LAUNCH-LINEAGE).
       *
       * This field alone is not proof: `planBackedExecutor.ts`'s
       * `verifyNoLaunchEvidence` checks the value was actually minted by that
       * boundary and names this same action, and settlement trusts nothing
       * else. Its absence is the ordinary, conservative case — a real or
       * uncertain run, whose lineage must be recorded as it always has been.
       */
      readonly noLaunchEvidence?: NoLaunchEvidence;
    };

/**
 * Starting an independent review, and proving it started (TASK-019 AC-2, AC-4).
 *
 * A PORT, and deliberately a narrow one. The supervisor decides THAT a review
 * should happen, who should do it and against which candidate; it must not know
 * that today that means a CLI, a file of prompt text and a subprocess. What it
 * needs back is exactly two things: whether the attempt to start was made, and
 * — separately, later — whether the thing that started is the run it asked for.
 *
 * The two are separate calls because they are separate facts, and every
 * generation of this machinery that collapsed them ended up recording "running"
 * for a process that did not exist.
 */
export interface ReviewLaunchRequest {
  readonly reviewId: string;
  readonly roadmapKey: string;
  readonly activityId: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly candidate: CandidateBinding;
  /** Where the verdict is expected to appear. */
  readonly source: string;
  /** Where the worker must acknowledge, naming `reviewId`. */
  readonly ack: string;
}

export type ReviewLaunchResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly problem: string; readonly exhausted?: boolean };

/**
 * Enough to FIND a recorded review's outcome, and nothing more.
 *
 * Deliberately not the whole launch request: observing a completion is a
 * read-only question about a review that already exists, and the two callers
 * have different objects in hand — `reconcileReviews` holds a
 * `ReviewLaunchRequest`, `consumeAcceptanceVerdicts` holds the durable
 * `ReviewBinding`. Both structurally satisfy this, so neither has to rebuild the
 * other's shape and invent fields to do it.
 */
export interface ReviewCompletionQuery {
  readonly reviewId: string;
  readonly source: string;
}

/**
 * What a COMPLETED reviewer process left behind (SF-R3, TASK-019 AC-15/AC-20).
 *
 * EVIDENCE, not a second workflow database. It answers one question the
 * supervisor could not answer before — "did the process that was launched finish,
 * and how?" — and it answers it from something the worker itself published after
 * exiting. Everything here is bounded and redacted before it crosses into state
 * or a log (C6).
 */
export interface ReviewCompletionEvidence {
  /** The run this belongs to. A different run id is foreign, never adopted. */
  readonly runId: string;
  /** The reviewer CLI's own exit status. */
  readonly exitCode: number;
  /** Bounded, redacted process output. May be empty; empty is not success. */
  readonly failure: string;
  /**
   * Present ONLY when the provider's own structured output reported a failure
   * (measured: claude-code's `is_error: true`). A provider that says it failed
   * has failed even if it exited zero and its text says PASS.
   */
  readonly providerError?: string;
  /** Whether a structured final message was published as a verdict candidate. */
  readonly verdictPublished: boolean;
  readonly at: Timestamp;
}

export type ReviewCompletionReading =
  /** Nothing has been published. The reviewer may still be working. */
  | { readonly kind: "NONE" }
  /**
   * Something is there and cannot be used: torn, malformed, or naming another
   * run. Never success, and never permission to launch a second worker.
   */
  | { readonly kind: "UNUSABLE"; readonly reason: string }
  | { readonly kind: "COMPLETED"; readonly evidence: ReviewCompletionEvidence };

export interface ReviewLauncher {
  /**
   * Starts the reviewer. Returning `ok` means the attempt was MADE — never that
   * the reviewer is running, which only `acknowledgement` can establish.
   *
   * `exhausted` distinguishes the provider refusing for quota reasons from
   * anything else: a quota refusal is a durable waiting state and a retry
   * later, not a failure of the review (AC-15).
   */
  launch(request: ReviewLaunchRequest): Promise<ReviewLaunchResult>;
  /** What the worker itself wrote, if anything. Absent means no proof yet. */
  acknowledgement(request: ReviewLaunchRequest): LaunchAcknowledgement | undefined;
  /**
   * What the finished process left behind. READ-ONLY, and required rather than
   * optional: a launcher that cannot report a completion leaves a CLI which
   * launched and then failed looking exactly like one still working, which is
   * the immediate-retry loop SF-R3 closes. A half-configured seam is the
   * fail-open this service already refuses elsewhere.
   */
  completion(query: ReviewCompletionQuery): ReviewCompletionReading;
}

// =====================================================================
// Worker-run lifecycle (DEFECT-DURABLE-WORKER-RUN-ENVELOPE)
// =====================================================================

/**
 * The narrow durable seam a launcher of an external Claude/Codex process
 * writes through, so "record PREPARED before spawn", "adopt RUNNING only from
 * the child's own ACK" and "settle a terminal artifact" are each a single CAS
 * write against the SAME `SupervisorState.workerRuns` the reconciliation tick
 * and the read-only CLI read — never a second store.
 *
 * A PORT, deliberately, for the same reason `PlanAdvancer` is one method wide:
 * `childPlanAdvancer.ts` needs to durably record a launch's lifecycle, not to
 * hold a `SupervisorRepository` and reimplement its own CAS-retry loop, and a
 * test needs to script every refusal without a database.
 */
export interface WorkerRunPrepareRequest {
  readonly actionId: string;
  readonly roadmapKey: string;
  readonly attempt: number;
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
  readonly maxTurns?: number;
  readonly factorySessionId?: string;
}

export interface WorkerRunAdoptRequest {
  readonly runId: string;
  readonly lease: ActivityLease;
  readonly childPid?: number;
  readonly providerSessionId?: string;
}

export interface WorkerRunHeartbeatRequest {
  readonly runId: string;
  readonly heartbeat: WorkerRunHeartbeat;
  readonly holder: ActivityLease;
}

export interface WorkerRunCompleteRequest {
  readonly runId: string;
  readonly input: WorkerRunCompletionInput;
}

export interface WorkerRunLifecycle {
  read(runId: string): Promise<WorkerRunEnvelope>;
  /**
   * Durably records PREPARED, via CAS, before anything is spawned (AC-1).
   *
   * THROWS on any refusal — a domain refusal (already prepared, already
   * finished) or CAS exhaustion under contention alike. The caller must never
   * spawn a process when this throws: a write that never durably happened is
   * a launch that must never happen either.
   */
  prepare(request: WorkerRunPrepareRequest): Promise<WorkerRunEnvelope>;
  /**
   * Durably adopts RUNNING from the child's own OS-level ACK (AC-2, AC-3).
   *
   * THROWS on a refusal: a different identity for the same run is AMBIGUOUS
   * and refused, never treated as a second worker.
   */
  adopt(request: WorkerRunAdoptRequest): Promise<void>;
  /**
   * Best-effort durable heartbeat, independent of model output (AC-4).
   *
   * Never throws: a write that could not be recorded this tick must not be
   * allowed to affect the child process it is merely reporting on. A caller
   * that wants to know whether the write landed reads the return value.
   */
  heartbeat(request: WorkerRunHeartbeatRequest): Promise<{ readonly recorded: boolean }>;
  /**
   * Durably records the terminal outcome (AC-5, AC-6).
   *
   * THROWS on a refusal (a disagreeing prior completion already recorded) —
   * that is a genuine contradiction in durable state, not a transient
   * conflict to retry past.
   */
  complete(request: WorkerRunCompleteRequest): Promise<void>;
}

export interface WorkExecutor {
  /**
   * What this work will launch, stated BEFORE anything launches (TASK-015 AC-2).
   *
   * The supervisor cannot know a plan's worker configuration — the plan is the
   * executor's business — so it asks. It then authorises exactly this set, or
   * refuses the whole action. Declaring is not permission: an executor that
   * under-declares does not thereby gain the right to launch the rest, because
   * the executor re-checks what it is about to run against
   * `input.authorizedResources` at the last point before launch.
   *
   * OPTIONAL, and its absence is today's behaviour exactly: an executor that
   * declares nothing gets the single routed resource and nothing changes.
   */
  declareResources?(item: RoadmapItem): Promise<readonly RequiredResource[]>;
  execute(input: WorkExecutionInput): Promise<WorkOutcome>;
}
