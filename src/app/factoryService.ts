/**
 * Application service: the use cases the CLI (and later the HTTP API,
 * Control Room or Telegram inbox) call.
 *
 * It owns no workflow rules of its own — those live in WorkflowService and
 * the transition table's preconditions. Its job is to wire repositories,
 * runs, reviews and evidence together, and to enforce the integrity rules
 * that need more than the transition table to check:
 *
 *   - a protected human decision requires a HUMAN actor AND a TrustedHumanToken
 *     minted by the HumanIdentityGate (C1/C5);
 *   - a WORK_ITEM approval may only be recorded at the status where that gate
 *     is meaningful, and is stamped by this service with what was actually
 *     current — the caller cannot pre-record one or influence the binding;
 *   - a run's identity is the registry-issued WorkerPrincipal, never the
 *     worker's self-reported id, so reviewer independence (C4) survives a
 *     worker renaming itself;
 *   - a worker's thrown exception still leaves a FAILED run on record;
 *   - acceptance criteria are verified from a successful VERIFIER run's own
 *     recorded evidence, bound to the implementation run it examined (C3);
 *   - every multi-record write happens inside one unit of work, so a
 *     concurrency conflict can never leave accepted work half-durable.
 */

import type { AcceptanceCriterion } from "../domain/acceptanceCriterion.js";
import type { AcceptanceCriterionVerification } from "../domain/acceptanceCriterionVerification.js";
import type { Actor } from "../domain/actor.js";
import {
  GATE_DECISION_STATUS,
  derivedPlanApprovalId,
  planSubject,
  workItemSubject,
  type Approval,
  type ApprovalContext,
  type ApprovalDecision,
  type ProtectedGate,
  type SubjectRef,
} from "../domain/approval.js";
import {
  AppendOnlyViolationError,
  ApprovalIntegrityError,
  HumanIdentityError,
  NotFoundError,
  ReviewIntegrityError,
  TerminalWorkItemError,
  ValidationError,
  WorkerExecutionError,
} from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import type { ReleaseSnapshot } from "../domain/executionSnapshot.js";
import type { TrustedHumanToken } from "../domain/humanIdentity.js";
import type { ApprovalId, IdGenerator, ProjectId, RunId, WorkItemId } from "../domain/ids.js";
import type { Project } from "../domain/project.js";
import type { Review, ReviewKind, ReviewVerdict } from "../domain/review.js";
import type { FactoryRole } from "../domain/role.js";
import type { Run } from "../domain/run.js";
import { isTerminal, type WorkItemStatus } from "../domain/status.js";
import { principalSupportsRole } from "../domain/workerPrincipal.js";
import type { Priority, WorkItem, WorkItemType } from "../domain/workItem.js";
import type { Clock } from "../ports/clock.js";
import type { HumanIdentityGate } from "../ports/humanIdentityGate.js";
import {
  compareMaterializedItemShape,
  type MaterializedItemShape,
  type PlanBindingResolver,
} from "../ports/planBindingResolver.js";
import type { FactoryRepositories, FactoryStore } from "../ports/repositories.js";
import type { Worker, WorkerOutcome } from "../ports/worker.js";
import type { WorkerRegistry } from "../ports/workerRegistry.js";
import {
  DirectAdmissionRefusedError,
  type DirectHostAdmissionHandle,
  // PHASE7-102: the Factory is a deterministic-capable holder, so it names the
  // EXPLICIT execution-union channel/request seams rather than the AI aliases.
  type DirectHostExecutionAdmissionSurface,
  type DirectHostExecutionLaunchRequest,
  type TrustedTicketReference,
  type DirectLaunchModelExpectation,
  type DirectLaunchScopeExpectation,
  type DirectLaunchBudgetExpectation,
  type DirectLaunchCommandExpectation,
  type DirectLaunchDeterministicBudgetExpectation,
  type DirectLaunchExecutionPolicyExpectation,
} from "../supervision/directWorkerAdmission.js";
import { DETERMINISTIC_EXECUTION_KIND } from "../supervision/workerContract.js";
import {
  resolveApprovedPrestart,
  PrestartAdmissionRefusedError,
  type ApprovedExecutionPrestartPort,
  type PrestartTicketReference,
} from "../supervision/directWorkerPrestartAdmission.js";
import type { DirectLaunchBinding } from "../ports/worker.js";
import type { WorkerPrincipal } from "../domain/workerPrincipal.js";
import { evaluateGate, requireGate, type GateBinding, type GateStatus } from "../workflow/gateGuard.js";
import {
  resolveCurrentImplementation,
  resolveReleaseSnapshot,
  resolveSemanticReview,
  type ResolvedReview,
} from "../workflow/releaseSnapshotResolver.js";
import { assertRoleStartable } from "../workflow/rolePolicy.js";
import { WorkflowService, type TransitionCheck } from "../workflow/workflowService.js";

export interface FactoryServiceDeps {
  readonly store: FactoryStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly identityGate: HumanIdentityGate;
  readonly workerRegistry: WorkerRegistry;
  /**
   * TASK-005: supplies the live binding a PLAN-subject approval is stamped
   * with. Optional because TASK-001..004 wiring has no plans at all; when it is
   * absent, recording a PLAN approval is refused rather than recorded unbound.
   */
  readonly planBindingResolver?: PlanBindingResolver;
  /**
   * D1-85: the ONE trusted host constructor-only hook that builds this
   * Factory's shared DirectHostAdmissionSurface. Called exactly once, here in
   * the constructor, with the Factory-bound `readCurrentDirectLaunchRequest`
   * callback — the SAME callback `createDirectHostAdmissionChannel` invokes
   * on every later readiness/consume call, so drift after issuance is always
   * read fresh from live repository state, never an issuance-time snapshot.
   * The hook's returned surface is captured as the one channel this Factory
   * and its CLI adapters must share (via `sharedDirectAdmissionChannel`); it
   * is never reconstructed and never substituted by a per-run channel or a
   * caller-supplied WorkerRequest callback. Absent by default (no default
   * authority): a principal flagged `requiresDirectAdmission` with no hook
   * configured fails closed rather than falling back to any caller-supplied
   * ticket or structural revalidate callback.
   */
  readonly createDirectAdmissionChannel?: (
    readCurrentRequest: (
      binding: DirectLaunchBinding,
      issuedRequest: DirectHostExecutionLaunchRequest,
    ) => Promise<DirectHostExecutionLaunchRequest>,
  ) => DirectHostExecutionAdmissionSurface;
  /**
   * D1-93: the ONE trusted, constructor-injected prestart authority. Every
   * nonmock principal's run requires it; only the accepted A80 trusted-mock
   * identity (src/adapters/workers/mockWorker.ts) is exempt. Captured
   * privately — never re-derived, never substituted per-call — and consulted
   * in PHASE 1, after the fresh operable item/role/target/criteria reads but
   * BEFORE `runs.create`, so a missing/invalid/stale/mismatched prestart
   * authority refuses before any RUNNING row is ever durable.
   */
  readonly approvedPrestartPort?: ApprovedExecutionPrestartPort;
}

export interface CreateProjectInput {
  readonly key: string;
  readonly name: string;
}

export interface CreateWorkItemInput {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly type: WorkItemType;
  readonly priority?: Priority;
  readonly planVersion: string;
  readonly assignedRole?: FactoryRole;
  readonly dependencies?: readonly WorkItemId[];
  /** Must be non-empty: a work item with nothing to verify can never be meaningfully DONE (C2/C3). */
  readonly acceptanceCriteria: readonly { text: string; verificationHint: string }[];
}

export interface RunWorkerInput {
  readonly workItemId: WorkItemId;
  readonly role: FactoryRole;
  readonly worker: Worker;
  readonly instructions: string;
  /** Required for VERIFIER/REVIEWER runs: the implementation run under examination. */
  readonly againstRunId?: RunId;
  /**
   * D1-85: required whenever the worker's registry-issued principal is
   * host-flagged `requiresDirectAdmission`. Only an opaque trusted-host
   * reference plus the caller's EXPECTED model/scope — both validated
   * against the host grant and current store, never trusted as authority
   * themselves (see src/supervision/directWorkerAdmission.ts composition).
   */
  readonly directTicketReference?: TrustedTicketReference;
  readonly expectedModel?: DirectLaunchModelExpectation;
  readonly expectedScope?: DirectLaunchScopeExpectation;
  /**
   * D1-93: required alongside expectedModel/expectedScope whenever the
   * worker's registry-issued principal is nonmock. Compared against the
   * trusted prestart authority's OWN retained approved facts; never derived
   * from the resolved approval itself (see
   * src/supervision/directWorkerPrestartAdmission.ts).
   */
  readonly expectedBudgets?: DirectLaunchBudgetExpectation;
  /**
   * PHASE7-102: the execution kind this run's host expectations are
   * expressed in. Absent means the unchanged "ai" shape, so every existing
   * AI callsite is unaffected. `"deterministic-execution"` switches the
   * mandatory expectation set to the deterministic one below; an unknown
   * value refuses.
   */
  readonly expectedExecutionKind?: "ai" | typeof DETERMINISTIC_EXECUTION_KIND;
  /**
   * PHASE7-102 deterministic host expectations: required together, and ONLY,
   * when `expectedExecutionKind === "deterministic-execution"`. These are
   * the caller's genuine, independently captured host configuration — the
   * actual ordered commands, the workspace root, the real process limits and
   * the executionPolicy rationale — compared against the trusted prestart
   * authority's own HUMAN-approved facts, never derived from them. No
   * model/token/provider quota participates in this branch, and none may be
   * synthesized to stand in for a missing deterministic expectation.
   */
  readonly expectedCommands?: DirectLaunchCommandExpectation;
  readonly expectedWorkspace?: string;
  readonly expectedDeterministicBudgets?: DirectLaunchDeterministicBudgetExpectation;
  readonly expectedExecutionPolicy?: DirectLaunchExecutionPolicyExpectation;
  /** @deprecated legacy compile-only compatibility; never read as admission authority. */
  readonly directTicket?: unknown;
}

/** D1-85 owned per-run expected context, never caller-visible; compared against current store state on every reader invocation. */
interface OwnedDirectLaunchContextCommon {
  readonly runId: RunId;
  readonly workItemId: WorkItemId;
  readonly principal: WorkerPrincipal;
  readonly role: FactoryRole;
  readonly ticketReference: TrustedTicketReference;
  readonly againstRunId: RunId | undefined;
  readonly expectedScope: DirectLaunchScopeExpectation;
}

/**
 * PHASE7-102: the owned expectations are discriminated by execution kind.
 * The AI member is unchanged (and is what an absent kind means); the
 * deterministic member carries the caller's independently captured ordered
 * commands/workspace/process limits/rationale and deliberately no model.
 * Both are Factory-private and re-compared against live store state on every
 * reader invocation.
 */
type OwnedDirectLaunchContext =
  | (OwnedDirectLaunchContextCommon & {
      readonly executionKind: "ai";
      readonly expectedModel: DirectLaunchModelExpectation;
    })
  | (OwnedDirectLaunchContextCommon & {
      readonly executionKind: typeof DETERMINISTIC_EXECUTION_KIND;
      readonly expectedCommands: DirectLaunchCommandExpectation;
      readonly expectedWorkspace: string;
      readonly expectedDeterministicBudgets: DirectLaunchDeterministicBudgetExpectation;
      readonly expectedExecutionPolicy: DirectLaunchExecutionPolicyExpectation;
    });

const AI_ONLY_RUN_WORKER_EXPECTATION_FIELDS: readonly string[] = [
  "expectedModel",
  "expectedBudgets",
];
const DETERMINISTIC_ONLY_RUN_WORKER_EXPECTATION_FIELDS: readonly string[] = [
  "expectedCommands",
  "expectedWorkspace",
  "expectedDeterministicBudgets",
  "expectedExecutionPolicy",
];

/**
 * PHASE7-102: resolves the caller's declared expectation kind, refusing an
 * unknown value and any MIXED shape that declares one kind while also
 * carrying the other kind's expectation keys. Presence is KEY presence, so an
 * explicitly `undefined` opposite-kind expectation is still mixed and is
 * never normalized away. A MISSING same-kind expectation is never exempted
 * here — the caller checks its own branch's complete fact set.
 */
function requireRunWorkerExecutionKind(
  input: RunWorkerInput,
): "ai" | typeof DETERMINISTIC_EXECUTION_KIND {
  const declared = input.expectedExecutionKind;
  const bag = input as unknown as Record<string, unknown>;
  if (declared === DETERMINISTIC_EXECUTION_KIND) {
    if (AI_ONLY_RUN_WORKER_EXPECTATION_FIELDS.some((field) => field in bag)) {
      throw new PrestartAdmissionRefusedError(
        "deterministic direct run declares expectedExecutionKind \"deterministic-execution\" but also carries AI-only model/token expectations",
      );
    }
    return DETERMINISTIC_EXECUTION_KIND;
  }
  if (declared === undefined || declared === "ai") {
    if (DETERMINISTIC_ONLY_RUN_WORKER_EXPECTATION_FIELDS.some((field) => field in bag)) {
      throw new PrestartAdmissionRefusedError(
        "AI direct run carries deterministic-only command/workspace/process expectations; a mixed expectation shape is refused",
      );
    }
    return "ai";
  }
  throw new PrestartAdmissionRefusedError(
    "direct provider-backed run declares an unrecognized expectedExecutionKind",
  );
}

/**
 * PHASE7-102 defect 24EAA3D4/65B88: deep-COPIES and then deep-freezes the
 * caller's independently supplied deterministic expectation fields plus
 * expectedScope, so the SAME frozen private values can be reused across the
 * pre-row snapshot, the owned context, and the current reader without
 * re-reading caller-mutable `input` across later awaits. The copies are
 * independent: the caller's own objects are never frozen and never mutated,
 * and recursion continues through an ALREADY FROZEN source object so a
 * mutable descendant of a frozen outer object is still copied and frozen.
 * Deliberately does not touch `worker`, principal, or any function/handle
 * identity.
 */
function deepFreezeDeterministicExpectationBundle<
  T extends {
    readonly expectedCommands?: unknown;
    readonly expectedScope?: unknown;
    readonly expectedDeterministicBudgets?: unknown;
    readonly expectedExecutionPolicy?: unknown;
    readonly expectedWorkspace?: string;
  },
>(bundle: T): T {
  const deepCopyFreeze = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return Object.freeze(value.map((entry) => deepCopyFreeze(entry)));
    }
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      copy[key] = deepCopyFreeze((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(copy);
  };
  return Object.freeze({
    ...bundle,
    expectedCommands: deepCopyFreeze(bundle.expectedCommands),
    expectedScope: deepCopyFreeze(bundle.expectedScope),
    expectedDeterministicBudgets: deepCopyFreeze(bundle.expectedDeterministicBudgets),
    expectedExecutionPolicy: deepCopyFreeze(bundle.expectedExecutionPolicy),
    expectedWorkspace: bundle.expectedWorkspace,
  }) as T;
}

export interface VerifyAcceptanceCriteriaInput {
  readonly workItemId: WorkItemId;
  readonly verifierRunId: RunId;
}

export interface RecordReviewInput {
  readonly workItemId: WorkItemId;
  /** The IMPLEMENTER run being reviewed. */
  readonly reviewedRunId: RunId;
  /** The run that performed this review; both principals are derived from these runs. */
  readonly reviewerRunId: RunId;
  readonly kind: ReviewKind;
  readonly verdict: ReviewVerdict;
  readonly findings?: readonly string[];
}

export interface RecordApprovalInput {
  readonly gate: ProtectedGate;
  readonly subject: SubjectRef;
  readonly decision: ApprovalDecision;
  readonly actor: Actor;
  /** Minted by FactoryService.authorizeHuman; proves the actor is really the human it claims. */
  readonly authorization: TrustedHumanToken;
  readonly note?: string;
}

export interface AdvanceOptions {
  readonly reason?: string;
  /** Required for protected human transitions such as cancellation. */
  readonly authorization?: TrustedHumanToken;
}

/**
 * See FactoryService.recordDerivedPlanApproval.
 *
 * Deliberately only IDENTIFIERS. Remediation round 1 removed the caller-supplied
 * `expectedPlanRevision`/`expectedContentDigest`: a caller that states what the
 * approval covers is a caller that can widen it. Both are now resolved from
 * durable plan state through `PlanBindingResolver`.
 */
export interface RecordDerivedPlanApprovalInput {
  readonly workItemId: WorkItemId;
  /** The human PLAN_APPROVAL this descends from; re-read by id, never trusted as an object. */
  readonly sourceApprovalId: ApprovalId;
  readonly planId: string;
}

export class FactoryService {
  private readonly store: FactoryStore;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly identityGate: HumanIdentityGate;
  private readonly workerRegistry: WorkerRegistry;
  private readonly planBindingResolver: PlanBindingResolver | undefined;
  private readonly approvedPrestartPort: ApprovedExecutionPrestartPort | undefined;
  /** PHASE7-102: the captured channel is EXPLICITLY the execution-union surface. */
  private readonly directAdmissionChannel: DirectHostExecutionAdmissionSurface | undefined;
  /** D1-85 owned per-run expected context, keyed by runId; deleted at finalization. Never exposed to callers. */
  private readonly directLaunchContextByRunId = new Map<RunId, OwnedDirectLaunchContext>();
  readonly workflow: WorkflowService;

  constructor(deps: FactoryServiceDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.identityGate = deps.identityGate;
    this.workerRegistry = deps.workerRegistry;
    this.planBindingResolver = deps.planBindingResolver;
    // D1-93: captured privately, exactly once, from the constructor only —
    // never re-derived, never substituted by a per-call authority.
    this.approvedPrestartPort = deps.approvedPrestartPort;
    // D1-85: the hook is called exactly once, here, with the Factory-bound
    // reader — never a caller callback — so the channel's own captured
    // readiness/consume path always re-reads live repository state fresh,
    // not an issuance-time snapshot. No hook configured => no channel.
    this.directAdmissionChannel =
      deps.createDirectAdmissionChannel === undefined
        ? undefined
        : deps.createDirectAdmissionChannel((binding, issuedRequest) =>
            this.readCurrentDirectLaunchRequestFromIssued(binding, issuedRequest),
          );
    this.workflow = this.workflowFor(deps.store);
  }

  /**
   * D1-85 trusted sharing accessor: returns the IDENTICAL surface this
   * Factory was constructed with, for a trusted host to inject into
   * createCliWorker configuration. Undefined when no hook was configured;
   * never constructs a second channel.
   */
  get sharedDirectAdmissionChannel(): DirectHostExecutionAdmissionSurface | undefined {
    return this.directAdmissionChannel;
  }

  /** A WorkflowService reading through one specific repository set (live store or a transaction). */
  private workflowFor(repositories: FactoryRepositories): WorkflowService {
    return new WorkflowService(
      {
        approvals: repositories.approvals,
        runs: repositories.runs,
        reviews: repositories.reviews,
        criteria: repositories.criteria,
        verifications: repositories.verifications,
        identityGate: this.identityGate,
      },
      this.clock,
    );
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    return this.store.projects.save({
      id: this.ids.next("prj"),
      key: input.key,
      name: input.name,
      createdAt: this.clock.now(),
    });
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
    if (input.acceptanceCriteria.length === 0) {
      throw new ValidationError(
        "a WorkItem must declare at least one acceptance criterion (C2/C3): nothing to verify means it can never be honestly DONE",
      );
    }

    return this.store.transaction(async (repos) => {
      const project = await repos.projects.findById(input.projectId);
      if (project === undefined) {
        throw new NotFoundError("Project", input.projectId);
      }

      const id = this.ids.next("wi");
      const criteria: AcceptanceCriterion[] = [];
      for (const draft of input.acceptanceCriteria) {
        criteria.push(
          await repos.criteria.save({
            id: this.ids.next("ac"),
            workItemId: id,
            text: draft.text,
            verificationHint: draft.verificationHint,
          }),
        );
      }

      const at = this.clock.now();
      return repos.workItems.create({
        id,
        projectId: input.projectId,
        title: input.title,
        type: input.type,
        status: "IDEA",
        specRevision: 1,
        version: 1,
        priority: input.priority ?? "P2",
        planVersion: input.planVersion,
        dependencies: input.dependencies ?? [],
        acceptanceCriteriaIds: criteria.map((criterion) => criterion.id),
        ...(input.assignedRole === undefined ? {} : { assignedRole: input.assignedRole }),
        runIds: [],
        history: [],
        createdAt: at,
        updatedAt: at,
      });
    });
  }

  async getWorkItem(id: WorkItemId): Promise<WorkItem> {
    const item = await this.store.workItems.findById(id);
    if (item === undefined) {
      throw new NotFoundError("WorkItem", id);
    }
    return item;
  }

  /** Throws NotFoundError if the project does not exist. Mirrors getWorkItem. */
  async getProject(id: ProjectId): Promise<Project> {
    const project = await this.store.projects.findById(id);
    if (project === undefined) {
      throw new NotFoundError("Project", id);
    }
    return project;
  }

  /**
   * THE terminal-work-item policy (single definition, not scattered checks):
   * once a work item is DONE or CANCELLED, no operation that creates or
   * changes production workflow state — runs, evidence, reviews, criterion
   * verifications, attachment — is allowed. Reading and reporting remain
   * free. Status transitions need no extra check here: terminal statuses
   * have no outgoing edges in the transition table.
   */
  private async requireOperableWorkItem(
    repositories: Pick<FactoryRepositories, "workItems">,
    id: WorkItemId,
    operation: string,
  ): Promise<WorkItem> {
    const item = await repositories.workItems.findById(id);
    if (item === undefined) {
      throw new NotFoundError("WorkItem", id);
    }
    if (isTerminal(item.status)) {
      throw new TerminalWorkItemError(
        `${operation} is not allowed: WorkItem ${id} is ${item.status}, which is terminal — a completed item's record is closed (C7/C8)`,
      );
    }
    return item;
  }

  /** Non-throwing pre-check, mirrors WorkflowService.check. */
  async checkTransition(
    id: WorkItemId,
    to: WorkItemStatus,
    actor: Actor,
    options: AdvanceOptions = {},
  ): Promise<TransitionCheck> {
    return this.workflow.check(await this.getWorkItem(id), to, actor, options);
  }

  /**
   * Advances a work item's status. The gate check and the write happen inside
   * one unit of work, so a racing writer cannot slip between them; the loser
   * gets ConcurrencyError with nothing persisted.
   */
  async advance(
    id: WorkItemId,
    to: WorkItemStatus,
    actor: Actor,
    options: AdvanceOptions | string = {},
  ): Promise<WorkItem> {
    const opts: AdvanceOptions = typeof options === "string" ? { reason: options } : options;
    return this.store.transaction(async (repos) => {
      const item = await repos.workItems.findById(id);
      if (item === undefined) {
        throw new NotFoundError("WorkItem", id);
      }
      const next = await this.workflowFor(repos).transition(item, to, actor, opts);
      return repos.workItems.compareAndSave(next, item.version);
    });
  }

  /**
   * The only way to obtain a TrustedHumanToken. Throws HumanIdentityError if
   * `actor.kind !== "HUMAN"` or `credential` does not match the configured
   * local secret. A worker never receives this method or the credential (see
   * src/ports/worker.ts), so it cannot mint a token for itself.
   */
  authorizeHuman(actor: Actor, credential: string): TrustedHumanToken {
    return this.identityGate.authorize(actor, credential);
  }

  /**
   * Read-only re-check of the SAME trusted-human boundary `recordApproval`
   * and `WorkflowService` enforce (C1/C5): the actor must be HUMAN and must
   * present a `TrustedHumanToken` that verifies for it. Returns a reason
   * string on failure, `undefined` when the authorization holds. Exposed so
   * protected orchestration operations that are not WorkItem transitions —
   * e.g. TASK-004 loop cancellation — can require the same evidence of a
   * trusted human without reimplementing token verification or being handed a
   * reference to the identity gate/credential.
   */
  verifyHumanAuthorization(actor: Actor, authorization: TrustedHumanToken | undefined): string | undefined {
    if (actor.kind !== "HUMAN") {
      return `requires a trusted HUMAN decision, got actor kind ${actor.kind}`;
    }
    if (authorization === undefined) {
      return "requires a TrustedHumanToken; a caller-supplied HUMAN actor is not sufficient";
    }
    if (!this.identityGate.verify(authorization, actor)) {
      return `authorization token is invalid, expired, or was not issued to actor ${actor.id}`;
    }
    return undefined;
  }

  /** Registers a Worker and returns its immutable, registry-issued principal. */
  registerWorker(
    worker: Worker,
    roles?: readonly FactoryRole[],
    options?: { readonly requiresDirectAdmission?: boolean },
  ) {
    return this.workerRegistry.register(worker, {
      ...(roles === undefined ? {} : { roles }),
      ...(options?.requiresDirectAdmission === undefined
        ? {}
        : { requiresDirectAdmission: options.requiresDirectAdmission }),
    });
  }

  /**
   * Records a human decision at a protected gate.
   *
   * Refuses a non-HUMAN actor, refuses any actor without a token that
   * verifies for it, and — for a work item gate — refuses to record the
   * decision unless the item is actually at the status where that gate is
   * decided. That last check is what makes pre-recording impossible: there is
   * no moment at IDEA when a PLAN_APPROVAL or RELEASE_APPROVAL can be created
   * at all.
   *
   * The binding (`specRevision` for a plan, release `snapshotId` for a
   * release) is read from live state here and stamped into the approval, so a
   * caller cannot make an approval look current for something it never saw.
   */
  async recordApproval(input: RecordApprovalInput): Promise<Approval> {
    if (input.actor.kind !== "HUMAN") {
      throw new ApprovalIntegrityError(
        `Actor ${input.actor.id} of kind ${input.actor.kind} may not decide gate ${input.gate}; approvals require a HUMAN actor`,
      );
    }
    if (!this.identityGate.verify(input.authorization, input.actor)) {
      throw new HumanIdentityError(
        `authorization token is invalid, expired, or was not issued to actor ${input.actor.id}; refusing to record ${input.gate}`,
      );
    }

    return this.store.transaction(async (repos) => {
      let context: ApprovalContext | undefined;

      if (input.subject.type === "WORK_ITEM") {
        const item = await repos.workItems.findById(input.subject.id);
        if (item === undefined) {
          throw new NotFoundError("WorkItem", input.subject.id);
        }

        const requiredStatus = GATE_DECISION_STATUS[input.gate];
        if (requiredStatus !== undefined && item.status !== requiredStatus) {
          throw new ValidationError(
            `${input.gate} may only be decided while the work item is at ${requiredStatus}; it is currently ${item.status}`,
          );
        }

        context = { statusWhenDecided: item.status, specRevision: item.specRevision };

        if (input.gate === "RELEASE_APPROVAL") {
          const snapshot = await resolveReleaseSnapshot(item, repos);
          if (!snapshot.ok) {
            throw new ValidationError(
              `RELEASE_APPROVAL requires a complete release snapshot to approve, but none exists: ${snapshot.reason}`,
            );
          }
          context = { ...context, snapshotId: snapshot.value.id };
        }
      }

      if (input.subject.type === "PLAN") {
        // TASK-005. Same discipline as the WORK_ITEM branch above: the binding
        // is read from live state here and stamped into the approval, so an
        // approving caller cannot make an approval look current for a plan
        // revision it never saw. `planContentDigest` is bound in addition to
        // the revision number for the reason `snapshotId` exists — a counter
        // cannot prove the approved content is still the current content.
        if (input.gate !== "PLAN_APPROVAL") {
          throw new ValidationError(
            `a PLAN subject may only carry PLAN_APPROVAL, got ${input.gate}; release and publish are separate decisions about different subjects (C1)`,
          );
        }
        if (this.planBindingResolver === undefined) {
          throw new ValidationError(
            "refusing to record a PLAN approval: no PlanBindingResolver is configured, so the approval could not be bound to an exact plan revision and content digest",
          );
        }
        const binding = await this.planBindingResolver.resolveApprovalBinding(input.subject.id);
        if (!binding.ok) {
          throw new ValidationError(
            `PLAN_APPROVAL requires a validated plan revision currently awaiting a human decision: ${binding.reason}`,
          );
        }
        context = {
          statusWhenDecided: "PLAN_REVIEW",
          specRevision: binding.value.planRevision,
          planContentDigest: binding.value.approvalDigest,
        };
      }

      return repos.approvals.save({
        id: this.ids.next("apr"),
        gate: input.gate,
        subject: input.subject,
        decision: input.decision,
        decidedBy: input.actor,
        ...(context === undefined ? {} : { context }),
        ...(input.note === undefined ? {} : { note: input.note }),
        decidedAt: this.clock.now(),
      });
    });
  }

  /**
   * Materializes ONE human plan decision into the per-WorkItem PLAN_APPROVAL
   * the accepted transition table requires to reach READY (TASK-005 §10).
   *
   * This exists because a single human approves a whole plan once, while the
   * accepted gate is per work item — and because materialization must be
   * unattended and crash-safe, so a live `TrustedHumanToken` cannot be held
   * across it (tokens expire; workers never hold credentials).
   *
   * REMEDIATION ROUND 1 (independent review HIGH 1 + HIGH 2). The original
   * version validated the source approval and the target's STATUS, and took the
   * caller's word for everything connecting the two. Independent review used
   * that to derive one plan's approval onto unrelated work items, including work
   * items belonging to a different project, and to replay an approval that a
   * later rejection had already superseded. The rule this now enforces is:
   *
   *   ONE HUMAN PLAN APPROVAL AUTHORIZES ONLY THE EXACT EXECUTION CONTENT THE
   *   HUMAN APPROVED — and what that is, is answered by durable plan state, not
   *   by the caller.
   *
   * Four independent things must therefore hold, none of them caller-supplied:
   *
   *   1. MEMBERSHIP — `PlanBindingResolver.resolveMaterializationTarget` proves
   *      from the plan's own durable materialization mapping that this work
   *      item is one of the approved revision's targets, and reports what that
   *      target must contain.
   *   2. LINEAGE — the source approval, re-read BY ID, is a real APPROVED
   *      human PLAN_APPROVAL for this exact plan, bound to that same revision
   *      and that same approval digest.
   *   3. CURRENCY — the central gate, re-evaluated now, is still satisfied for
   *      that binding. A historical approval is audit evidence, never current
   *      authority: a later rejection, cancellation or superseding revision
   *      revokes it.
   *   4. CONTENT — what the Factory actually stored for that work item matches
   *      the approved target field for field (project, tag, title, type,
   *      priority, spec revision, dependencies, acceptance criteria).
   *
   * It is also idempotent: an identical derivation that already exists is
   * returned as-is rather than appended again, so a retried or crash-resumed
   * materialization cannot inflate the approval record.
   *
   * The result is fully auditable (C8): `derivedFromApprovalId` names the
   * human decision it descends from, and `decidedBy` is copied from that
   * decision rather than invented.
   */
  async recordDerivedPlanApproval(input: RecordDerivedPlanApprovalInput): Promise<Approval> {
    if (this.planBindingResolver === undefined) {
      throw new ValidationError(
        "refusing to derive a plan approval: no PlanBindingResolver is configured, so plan membership could not be proven",
      );
    }
    // Resolved OUTSIDE the transaction because it reads a different store (the
    // plan repository). It is authoritative because it reads durable plan state
    // only; the Factory-side checks below re-read everything they judge.
    const target = await this.planBindingResolver.resolveMaterializationTarget(input.planId, input.workItemId);
    if (!target.ok) {
      throw new ApprovalIntegrityError(
        `work item ${input.workItemId} is not covered by an approval of plan ${input.planId}: ${target.reason}`,
      );
    }
    const { planRevision, approvalDigest, planItemKey, expected } = target.value;

    try {
      return await this.deriveApprovalTransaction(input, planRevision, approvalDigest, planItemKey, expected);
    } catch (error) {
      // Lost the append-only race with a concurrent identical derivation. The
      // winner's record is the authority; both callers return the same one.
      if (error instanceof AppendOnlyViolationError) {
        const winner = await this.store.approvals.findById(
          derivedPlanApprovalId({
            planId: input.planId,
            planRevision,
            sourceApprovalId: input.sourceApprovalId,
            workItemId: input.workItemId,
            // A concurrent derivation can only have raced on the same spec
            // revision; any other value produces a different id and no clash.
            specRevision: (await this.getWorkItem(input.workItemId)).specRevision,
          }),
        );
        if (winner !== undefined) {
          return winner;
        }
      }
      throw error;
    }
  }

  private async deriveApprovalTransaction(
    input: RecordDerivedPlanApprovalInput,
    planRevision: number,
    approvalDigest: string,
    planItemKey: string,
    expected: MaterializedItemShape,
  ): Promise<Approval> {
    return this.store.transaction(async (repos) => {
      const source = await repos.approvals.findById(input.sourceApprovalId);
      if (source === undefined) {
        throw new NotFoundError("Approval", input.sourceApprovalId);
      }
      if (source.gate !== "PLAN_APPROVAL") {
        throw new ApprovalIntegrityError(
          `approval ${source.id} is a ${source.gate}, not a PLAN_APPROVAL; it cannot authorize planned work items`,
        );
      }
      if (source.subject.type !== "PLAN" || source.subject.id !== input.planId) {
        throw new ApprovalIntegrityError(
          `approval ${source.id} decides ${source.subject.type} ${source.subject.id}, not PLAN ${input.planId}`,
        );
      }
      if (source.decision !== "APPROVED") {
        throw new ApprovalIntegrityError(`approval ${source.id} is ${source.decision}; a rejected plan authorizes nothing`);
      }
      if (source.decidedBy.kind !== "HUMAN") {
        throw new ApprovalIntegrityError(
          `approval ${source.id} was decided by actor kind ${source.decidedBy.kind}; only a human decision can authorize planned work (C1)`,
        );
      }
      if (source.context?.specRevision !== planRevision) {
        throw new ApprovalIntegrityError(
          `approval ${source.id} was granted for plan revision ${String(source.context?.specRevision)}, not the approved ${planRevision}`,
        );
      }
      if (source.context?.planContentDigest !== approvalDigest) {
        throw new ApprovalIntegrityError(
          `approval ${source.id} was granted for plan content ${String(source.context?.planContentDigest)}, not the approved ${approvalDigest}; approved content may not change without a new human decision`,
        );
      }

      // CURRENCY. The same central gate every other protected operation asks,
      // re-evaluated now against the same binding — so a superseded decision
      // stays in the audit trail without still being able to authorize work.
      const gate = await evaluateGate(repos.approvals, "PLAN_APPROVAL", planSubject(input.planId), {
        specRevision: planRevision,
        planContentDigest: approvalDigest,
      });
      if (!gate.satisfied) {
        throw new ApprovalIntegrityError(
          `approval ${source.id} is no longer the current decision for PLAN ${input.planId}: ${gate.reason}`,
        );
      }

      const item = await this.requireOperableWorkItem(repos, input.workItemId, "recordDerivedPlanApproval");
      if (item.status !== "PLAN_REVIEW") {
        throw new ValidationError(
          `PLAN_APPROVAL may only be decided while the work item is at PLAN_REVIEW; ${item.id} is currently ${item.status}`,
        );
      }

      // CONTENT. What was actually stored, compared against what was approved.
      const criteria = await repos.criteria.listByWorkItem(item.id);
      const actual: MaterializedItemShape = {
        projectId: item.projectId,
        correlationTag: item.planVersion,
        title: item.title,
        type: item.type,
        priority: item.priority,
        specRevision: item.specRevision,
        dependencyWorkItemIds: [...item.dependencies],
        acceptanceCriteria: criteria.map((criterion) => ({
          text: criterion.text,
          verificationHint: criterion.verificationHint,
        })),
      };
      const comparison = compareMaterializedItemShape(expected, actual);
      if (!comparison.ok) {
        throw new ApprovalIntegrityError(
          `work item ${item.id} is not the approved content of plan ${input.planId} item "${planItemKey}": ${comparison.reason}`,
        );
      }

      // IDEMPOTENCE. The id IS the identity of this derivation (see
      // `derivedPlanApprovalId`), so an identical derivation already on record
      // is the answer, not a reason to append another — and the append-only
      // store, not a check-then-act read, is what settles a concurrent race.
      const derivedId = derivedPlanApprovalId({
        planId: input.planId,
        planRevision,
        sourceApprovalId: source.id,
        workItemId: item.id,
        specRevision: item.specRevision,
      });
      const existing = await repos.approvals.findById(derivedId);
      if (existing !== undefined) {
        return existing;
      }

      return repos.approvals.save({
        id: derivedId,
        gate: "PLAN_APPROVAL",
        subject: workItemSubject(item.id),
        decision: "APPROVED",
        decidedBy: source.decidedBy,
        context: {
          statusWhenDecided: item.status,
          specRevision: item.specRevision,
          derivedFromApprovalId: source.id,
          planId: input.planId,
          planRevision,
        },
        note: `derived from plan approval ${source.id} for ${input.planId} revision ${planRevision} item "${planItemKey}"`,
        decidedAt: this.clock.now(),
      });
    });
  }

  async gateStatus(gate: ProtectedGate, subject: SubjectRef, expected: GateBinding = {}): Promise<GateStatus> {
    return evaluateGate(this.store.approvals, gate, subject, expected);
  }

  /**
   * Read-only, like listRuns/listReviews. Added for TASK-005: re-deriving that
   * a specific recorded approval is still a real, human, correctly-bound
   * decision needs more than "is the latest one satisfied" — see
   * PlanningService.verifyApprovalAuthority.
   */
  async listApprovals(subject: SubjectRef): Promise<readonly Approval[]> {
    return this.store.approvals.listBySubject(subject);
  }

  /**
   * Guard for protected operations that are not workflow transitions, i.e.
   * PUBLISH_APPROVAL and CONSTITUTION_CHANGE.
   */
  async assertGateSatisfied(gate: ProtectedGate, subject: SubjectRef, expected: GateBinding = {}): Promise<Approval> {
    return requireGate(this.store.approvals, gate, subject, expected);
  }

  /** The current release candidate, if the work item has one. */
  async releaseSnapshot(workItemId: WorkItemId): Promise<ReleaseSnapshot | undefined> {
    const item = await this.getWorkItem(workItemId);
    const resolved = await resolveReleaseSnapshot(item, this.store);
    return resolved.ok ? resolved.value : undefined;
  }

  /**
   * Executes one worker run in three phases (remediation of the Round-5
   * CRITICAL race, where the worker executed before any durable record of
   * the attempt existed and the old generation stayed releasable mid-flight):
   *
   * PHASE 1 — START, atomic: validate the item is operable, that the role
   * may start in the current workflow state (src/workflow/rolePolicy.ts) and
   * that the target run exists, then create the Run as RUNNING and attach it
   * to the work item under CAS, committing before any external call. From
   * this commit on, the RUNNING attempt is the lineage head: the release
   * snapshot is unresolvable and DONE/RELEASE_APPROVAL are refused. If this
   * transaction fails, Worker.execute() is never invoked and nothing is
   * durable.
   *
   * PHASE 2 — EXECUTE, outside any transaction: the external worker runs.
   * Success, returned failure and thrown exception all proceed to PHASE 3.
   *
   * PHASE 3 — FINALIZE, atomic: persist evidence and complete that exact
   * run (the repository refuses unless it is still RUNNING). This phase
   * touches only the run and evidence tables — never the work item — so a
   * concurrent item change cannot orphan the audit record: an authorized
   * execution's true outcome is always recorded, even if a human cancelled
   * the item mid-flight (completing the audit record of already-authorized
   * work is not new production state).
   *
   * Serialization with release: either DONE commits first (PHASE 1's CAS
   * fails, no execution), or PHASE 1 commits first (the RUNNING head makes
   * DONE unreleasable). There is no interleaving where both succeed.
   *
   * Note what this never does: change the work item's status.
   */
  /**
   * D1-85 trusted current-reader. Rereads live repository state for THIS
   * runId/workItemId — never a caller callback — reruns the same operability
   * and target checks runWorker itself enforces, and reconstructs the exact
   * principal/item/spec/role/criteria/dependencies this run is attached to.
   * Used both at issuance and (via the channel's own captured callback) at
   * every later readiness/consume call, so drift after issuance is caught.
   */
  private async readCurrentDirectLaunchRequest(
    context: OwnedDirectLaunchContext,
  ): Promise<DirectHostExecutionLaunchRequest> {
    const { runId, workItemId, principal, role, ticketReference, againstRunId } = context;
    const item = await this.store.workItems.findById(workItemId);
    if (item === undefined || isTerminal(item.status)) {
      throw new DirectAdmissionRefusedError(`WorkItem ${workItemId} is missing or terminal at admission check`);
    }
    assertRoleStartable(role, item.status);
    if (!item.runIds.includes(runId)) {
      throw new DirectAdmissionRefusedError(`Run ${runId} is not attached to WorkItem ${workItemId}.runIds`);
    }
    const run = await this.store.runs.findById(runId);
    if (
      run === undefined ||
      run.workItemId !== workItemId ||
      run.status !== "RUNNING" ||
      run.role !== role ||
      run.workerPrincipalId !== principal.principalId ||
      run.specRevision !== item.specRevision ||
      run.targetRunId !== againstRunId
    ) {
      throw new DirectAdmissionRefusedError(
        `Run ${runId} is not the live owned RUNNING attempt matching principal/role/spec/target for ${workItemId}`,
      );
    }
    if (againstRunId !== undefined) {
      const target = await this.store.runs.findById(againstRunId);
      if (target === undefined || target.workItemId !== workItemId) {
        throw new DirectAdmissionRefusedError(`Target run ${againstRunId} for WorkItem ${workItemId} no longer exists`);
      }
    }
    for (const dependencyId of item.dependencies) {
      const dependency = await this.store.workItems.findById(dependencyId);
      if (dependency === undefined) {
        throw new DirectAdmissionRefusedError(`Dependency ${dependencyId} for WorkItem ${workItemId} is missing`);
      }
      if (dependency.status === "DONE") {
        continue;
      }
      if (dependency.status === "WAITING_FOR_HUMAN") {
        const authority = await this.resolveWaitingForHumanAuthority(dependency.id);
        if (authority.ok) {
          continue;
        }
      }
      throw new DirectAdmissionRefusedError(
        `Dependency ${dependencyId} for WorkItem ${workItemId} is not currently ready`,
      );
    }
    const criteria = await this.store.criteria.listByWorkItem(workItemId);
    // PHASE7-102: the live linkage/criteria/dependency facts above are shared;
    // the kind-specific expectations come from THIS run's owned context, so a
    // deterministic run returns commands/workspace/process budgets/rationale
    // and never touches `expectedModel`, while an AI run is byte-for-byte
    // unchanged.
    const common = {
      ticketReference,
      registryPrincipalId: principal.principalId,
      workItemId: item.id,
      specRevision: item.specRevision,
      runId,
      role,
      acceptanceCriteria: criteria,
      dependencyWorkItemIds: item.dependencies,
      scope: context.expectedScope,
    };
    if (context.executionKind === DETERMINISTIC_EXECUTION_KIND) {
      return {
        ...common,
        executionKind: DETERMINISTIC_EXECUTION_KIND,
        commands: context.expectedCommands,
        workspace: context.expectedWorkspace,
        budgets: context.expectedDeterministicBudgets,
        executionPolicy: context.expectedExecutionPolicy,
      };
    }
    return {
      ...common,
      executionKind: "ai",
      model: context.expectedModel,
    };
  }

  /**
   * D1-85 bound callback passed once into the constructor hook. Looks up
   * THIS run's owned expected context (never the issued snapshot) and
   * re-derives the current request from live store state, refusing if the
   * owned context is gone (already finalized) or current linkage drifted
   * from the original attached run/target/principal/role/spec.
   */
  private readonly readCurrentDirectLaunchRequestFromIssued = async (
    _binding: DirectLaunchBinding,
    issuedRequest: DirectHostExecutionLaunchRequest,
  ): Promise<DirectHostExecutionLaunchRequest> => {
    const context = this.directLaunchContextByRunId.get(issuedRequest.runId);
    if (context === undefined) {
      throw new DirectAdmissionRefusedError(
        `no owned direct-launch context for run ${issuedRequest.runId}; it was never issued or was already finalized`,
      );
    }
    return this.readCurrentDirectLaunchRequest(context);
  };

  async runWorker(input: RunWorkerInput): Promise<{ run: Run; evidence: readonly Evidence[] }> {
    // PHASE7-102 defect 24EAA3D4/65B88: for a DETERMINISTIC call only,
    // capture the execution kind and take independent deep copies of the
    // caller's expectation objects BEFORE any async admission work, so
    // nested caller mutation during later awaits cannot change the admitted
    // facts. Every later reference (pre-row snapshot, owned context, current
    // reader) reuses this SAME captured kind and frozen bundle rather than
    // re-reading caller-mutable `input`. An ordinary AI call is left exactly
    // as it was: nothing is copied and no caller object is frozen.
    const capturedExecutionKind =
      input.expectedExecutionKind === DETERMINISTIC_EXECUTION_KIND
        ? requireRunWorkerExecutionKind(input)
        : undefined;
    const input_ =
      capturedExecutionKind === DETERMINISTIC_EXECUTION_KIND
        ? ({
            ...input,
            ...deepFreezeDeterministicExpectationBundle({
              expectedCommands: input.expectedCommands,
              expectedScope: input.expectedScope,
              expectedDeterministicBudgets: input.expectedDeterministicBudgets,
              expectedExecutionPolicy: input.expectedExecutionPolicy,
              ...(input.expectedWorkspace === undefined ? {} : { expectedWorkspace: input.expectedWorkspace }),
            }),
          } as RunWorkerInput)
        : input;
    const deterministicExpectations = input_;
    // Trusted identity: whatever the worker says about itself is ignored.
    const principal = this.workerRegistry.principalFor(input.worker);
    if (!principalSupportsRole(principal, input.role)) {
      throw new NotFoundError("Worker capable of role", `${principal.principalId}:${input.role}`);
    }
    if ((input.role === "VERIFIER" || input.role === "REVIEWER") && input.againstRunId === undefined) {
      throw new ValidationError(`a ${input.role} run must name the implementation run it examines (againstRunId)`);
    }
    // D1-85 mandatory same-channel admission gate: host-issued
    // (registration-time), never self-declared by the Worker object. No
    // caller full ticket or structural revalidate callback grants authority
    // here — only the ONE trusted host-constructed channel this Factory was
    // constructed with. Missing channel or missing trusted reference fails
    // closed before any RUNNING row is ever durable.
    if (principal.requiresDirectAdmission) {
      if (this.directAdmissionChannel === undefined) {
        throw new DirectAdmissionRefusedError(
          "direct provider-backed run requires a trusted host-constructed admission channel; none is configured",
        );
      }
      if (input.directTicketReference === undefined) {
        throw new DirectAdmissionRefusedError(
          "direct provider-backed run requires a trusted ticketReference; none was supplied",
        );
      }
      // D1-93: mandatory trusted PRE-ROW prestart admission for every
      // nonmock principal; only the accepted A80 trusted-mock identity is
      // exempt (that branch never reaches here, since only a mock worker can
      // have requiresDirectAdmission === false). Never derive the expected
      // model/scope/budgets from the resolved approval — the caller's
      // genuine current request is what gets compared against it.
      if (this.approvedPrestartPort === undefined) {
        throw new PrestartAdmissionRefusedError(
          "direct provider-backed run requires a trusted constructor-injected approved-prestart authority; none is configured",
        );
      }
      // PHASE7-102: the expectation set is strictly discriminated by the
      // caller's declared execution kind BEFORE any RUNNING row exists. An
      // unknown kind, or a kind declared while the OTHER kind's expectation
      // keys are also present (key presence, so an explicit `undefined`
      // still counts as mixed), refuses closed rather than being narrowed
      // into whichever branch happens to validate.
      const expectedKind = capturedExecutionKind ?? requireRunWorkerExecutionKind(input);
      if (deterministicExpectations.expectedScope === undefined) {
        throw new PrestartAdmissionRefusedError(
          "direct provider-backed run requires the caller's actual expectedScope; it may not be omitted",
        );
      }
      if (expectedKind === DETERMINISTIC_EXECUTION_KIND) {
        // No model/token/provider expectation participates here, and none is
        // synthesized to stand in for a missing deterministic one: the
        // caller's independently captured commands/workspace/process
        // budgets/rationale must each be present in full.
        if (
          deterministicExpectations.expectedCommands === undefined ||
          deterministicExpectations.expectedWorkspace === undefined ||
          deterministicExpectations.expectedDeterministicBudgets === undefined ||
          deterministicExpectations.expectedExecutionPolicy === undefined
        ) {
          throw new PrestartAdmissionRefusedError(
            "deterministic direct run requires the caller's actual expectedCommands, expectedWorkspace, expectedDeterministicBudgets and expectedExecutionPolicy; none may be omitted",
          );
        }
      } else if (input.expectedModel === undefined || input.expectedBudgets === undefined) {
        throw new PrestartAdmissionRefusedError(
          "direct provider-backed run requires the caller's actual expectedModel, expectedScope and expectedBudgets; none may be omitted",
        );
      }
    }

    const runId = this.ids.next("run");

    // PHASE 1 — durable, authoritative start.
    const started = await this.store.transaction(async (repos) => {
      const item = await this.requireOperableWorkItem(repos, input.workItemId, "runWorker");
      assertRoleStartable(input.role, item.status);

      if (input.againstRunId !== undefined) {
        const target = await repos.runs.findById(input.againstRunId);
        if (target === undefined || target.workItemId !== item.id) {
          throw new NotFoundError("Target run for work item", `${input.againstRunId}@${item.id}`);
        }
      }

      const criteria = await repos.criteria.listByWorkItem(item.id);

      // D1-93: fresh operable item/role/target/criteria reads are above;
      // this call happens strictly BEFORE runs.create below, so a
      // missing/invalid/stale/mismatched prestart authority refuses before
      // any RUNNING row is ever durable. Uses the registry-issued principal
      // and the requested role/againstRunId — never anything the worker
      // self-reports.
      if (principal.requiresDirectAdmission) {
        // PHASE7-102: the kind was already strictly discriminated above, and
        // the branch-specific snapshot carries ONLY that kind's expectation
        // keys, so the prestart authority's own mixed-shape guard sees a
        // clean shape. Every expectation is the caller's actual current
        // request; nothing here is derived from the retained approval.
        const expectedKind = capturedExecutionKind ?? requireRunWorkerExecutionKind(input);
        const commonSnapshot = {
          item: { id: item.id, specRevision: item.specRevision, dependencies: item.dependencies },
          role: input.role,
          principal,
          criteria,
          ...(input.againstRunId !== undefined ? { targetRunId: input.againstRunId } : {}),
          requestedScope: deterministicExpectations.expectedScope!,
        };
        resolveApprovedPrestart(
          this.approvedPrestartPort!,
          input.directTicketReference as string as PrestartTicketReference,
          expectedKind === DETERMINISTIC_EXECUTION_KIND
            ? {
                ...commonSnapshot,
                executionKind: DETERMINISTIC_EXECUTION_KIND,
                requestedCommands: deterministicExpectations.expectedCommands!,
                requestedWorkspace: deterministicExpectations.expectedWorkspace!,
                requestedDeterministicBudgets: deterministicExpectations.expectedDeterministicBudgets!,
                requestedExecutionPolicy: deterministicExpectations.expectedExecutionPolicy!,
              }
            : {
                ...commonSnapshot,
                requestedModel: input.expectedModel!,
                requestedBudgets: input.expectedBudgets!,
              },
        );
      }

      const pending: Run = {
        id: runId,
        workItemId: item.id,
        specRevision: item.specRevision,
        role: input.role,
        workerPrincipalId: principal.principalId,
        declaredWorkerId: input.worker.id,
        status: "RUNNING",
        ...(input.againstRunId === undefined ? {} : { targetRunId: input.againstRunId }),
        claimsAcceptanceMet: false,
        evidenceIds: [],
        startedAt: this.clock.now(),
      };
      await repos.runs.create(pending);
      await repos.workItems.compareAndSave(
        { ...item, runIds: [...item.runIds, runId], version: item.version + 1, updatedAt: this.clock.now() },
        item.version,
      );
      return { item, criteria };
    });

    // D1-85: after PHASE 1 commits (the attached RUNNING row now exists),
    // issue the opaque admission handle through the ONE trusted channel.
    // readCurrentRequest is bound to THIS runId/workItemId and re-reads live
    // repository state (never a caller callback on WorkerRequest), so the
    // same reader the channel invokes at readiness/consume time rechecks
    // principal/item/spec/role/criteria/dependencies/run linkage fresh, not
    // the issued snapshot. Issuance failure here throws before Worker.execute
    // is invoked; PHASE 3 still finalizes the already-durable RUNNING row as
    // FAILED (owned settlement), never silently orphaning it.
    let directAdmissionHandle: DirectHostAdmissionHandle | undefined;
    let outcome: WorkerOutcome | undefined;
    let thrown: unknown;
    try {
      if (principal.requiresDirectAdmission) {
        const channel = this.directAdmissionChannel;
        const ticketReference = input.directTicketReference;
        if (channel === undefined || ticketReference === undefined) {
          throw new DirectAdmissionRefusedError(
            "direct provider-backed run requires both a trusted admission channel and ticketReference at issuance",
          );
        }
        // PHASE7-102: capture the COMPLETE branch-specific expectation set
        // this run was admitted with, immutably and Factory-privately. The
        // deterministic member carries no model/token/provider expectation at
        // all; neither member is ever derived from the retained approval.
        const expectedKind = capturedExecutionKind ?? requireRunWorkerExecutionKind(input);
        const commonContext = {
          runId,
          workItemId: input.workItemId,
          principal,
          role: input.role,
          ticketReference,
          againstRunId: input.againstRunId,
          expectedScope: deterministicExpectations.expectedScope as DirectLaunchScopeExpectation,
        };
        const context: OwnedDirectLaunchContext = Object.freeze(
          expectedKind === DETERMINISTIC_EXECUTION_KIND
            ? {
                ...commonContext,
                executionKind: DETERMINISTIC_EXECUTION_KIND,
                expectedCommands: deterministicExpectations.expectedCommands as DirectLaunchCommandExpectation,
                expectedWorkspace: deterministicExpectations.expectedWorkspace as string,
                expectedDeterministicBudgets:
                  deterministicExpectations.expectedDeterministicBudgets as DirectLaunchDeterministicBudgetExpectation,
                expectedExecutionPolicy:
                  deterministicExpectations.expectedExecutionPolicy as DirectLaunchExecutionPolicyExpectation,
              }
            : {
                ...commonContext,
                executionKind: "ai" as const,
                expectedModel: input.expectedModel as DirectLaunchModelExpectation,
              },
        );
        this.directLaunchContextByRunId.set(runId, context);
        const request = await this.readCurrentDirectLaunchRequest(context);
        directAdmissionHandle = await channel.issue(request);
        const ready = await channel.checkReadiness(directAdmissionHandle).catch(() => false);
        if (!ready) {
          throw new DirectAdmissionRefusedError(`admission channel reports run ${runId} is not ready after issuance`);
        }
      }

      // PHASE 2 — external execution, no transaction held open.
      outcome = await input.worker.execute({
        runId,
        workItemId: started.item.id,
        role: input.role,
        title: started.item.title,
        instructions: input.instructions,
        acceptanceCriteria: started.criteria,
        ...(directAdmissionHandle === undefined ? {} : { directAdmissionHandle }),
      });
    } catch (error) {
      thrown = error;
    }

    // Owned cancellation (A84): a denial here never leaves the live handle
    // reserved past this run's own finalization. Only ever cancels the
    // handle this exact runWorker call issued; never another authority's.
    if (directAdmissionHandle !== undefined && thrown !== undefined) {
      const channel = this.directAdmissionChannel;
      if (channel !== undefined) {
        await channel.cancel(directAdmissionHandle).catch(() => undefined);
      }
    }
    // Owned context is scoped to this run's admission lifecycle only; delete
    // it at finalization regardless of outcome so a later run with a reused
    // id can never read a stale context, and the channel callback correctly
    // refuses once this run is no longer live.
    this.directLaunchContextByRunId.delete(runId);

    const failureSummary =
      thrown === undefined
        ? undefined
        : `worker ${input.worker.id} threw while performing role ${input.role}: ${
            thrown instanceof Error ? thrown.message : String(thrown)
          }`;

    // PHASE 3 — finalize the exact run created in PHASE 1.
    const committed = await this.store.transaction(async (repos) => {
      const drafts =
        failureSummary === undefined
          ? (outcome?.evidence ?? [])
          : [
              {
                kind: "NOTE" as const,
                summary: failureSummary,
                reference: `mock://error/${runId}`,
              },
            ];

      const evidence: Evidence[] = [];
      for (const draft of drafts) {
        evidence.push(
          await repos.evidence.save({
            ...draft,
            id: this.ids.next("ev"),
            workItemId: started.item.id,
            runId,
            createdAt: this.clock.now(),
          }),
        );
      }

      const run = await repos.runs.complete(runId, {
        status: failureSummary === undefined ? (outcome?.status ?? "FAILED") : "FAILED",
        summary: failureSummary ?? outcome?.summary ?? "",
        claimsAcceptanceMet: failureSummary === undefined && (outcome?.claimsAcceptanceMet ?? false),
        evidenceIds: evidence.map((entry) => entry.id),
        finishedAt: this.clock.now(),
      });

      return { run, evidence };
    });

    if (failureSummary !== undefined) {
      throw new WorkerExecutionError(failureSummary, thrown);
    }
    return committed;
  }

  /**
   * Records a review.
   *
   * Both principals are read from the two Runs involved, never from the
   * caller. C4 compares registry-issued principal ids, so a worker cannot
   * become independent of itself by changing its declared id or role.
   */
  async recordReview(input: RecordReviewInput): Promise<Review> {
    return this.store.transaction(async (repos) => {
      const item = await this.requireOperableWorkItem(repos, input.workItemId, "recordReview");

      const reviewedRun = await repos.runs.findById(input.reviewedRunId);
      if (reviewedRun === undefined || reviewedRun.workItemId !== input.workItemId) {
        throw new NotFoundError("Run for work item", `${input.reviewedRunId}@${input.workItemId}`);
      }

      const reviewerRun = await repos.runs.findById(input.reviewerRunId);
      if (reviewerRun === undefined || reviewerRun.workItemId !== input.workItemId) {
        throw new NotFoundError("Reviewer run for work item", `${input.reviewerRunId}@${input.workItemId}`);
      }
      if (reviewerRun.status !== "SUCCEEDED") {
        throw new ValidationError(`reviewer run ${reviewerRun.id} did not succeed; cannot record a review from it`);
      }
      if (reviewerRun.targetRunId !== reviewedRun.id) {
        throw new ValidationError(
          `reviewer run ${reviewerRun.id} examined ${String(reviewerRun.targetRunId)}, not the run being reviewed (${reviewedRun.id})`,
        );
      }
      if (input.kind === "SEMANTIC" && reviewerRun.role !== "REVIEWER") {
        throw new ValidationError(`a SEMANTIC review must be backed by a REVIEWER-role run, got ${reviewerRun.role}`);
      }
      if (input.kind === "SEMANTIC" && reviewerRun.workerPrincipalId === reviewedRun.workerPrincipalId) {
        throw new ReviewIntegrityError(
          `reviewer run ${reviewerRun.id} was executed by the same worker principal as the implementation run ${reviewedRun.id}; a worker may not be the sole semantic reviewer of its own work (C4)`,
        );
      }

      return repos.reviews.save({
        id: this.ids.next("rev"),
        workItemId: input.workItemId,
        specRevision: item.specRevision,
        reviewedRunId: input.reviewedRunId,
        reviewerRunId: input.reviewerRunId,
        kind: input.kind,
        reviewerPrincipalId: reviewerRun.workerPrincipalId,
        implementerPrincipalId: reviewedRun.workerPrincipalId,
        verdict: input.verdict,
        findings: input.findings ?? [],
        createdAt: this.clock.now(),
      });
    });
  }

  /**
   * Creates one AcceptanceCriterionVerification per acceptance criterion,
   * derived from a successful VERIFIER run's own recorded Evidence — never
   * from the worker's `claimsAcceptanceMet` flag — and bound to the exact
   * implementation run that verifier examined.
   */
  async verifyAcceptanceCriteria(
    input: VerifyAcceptanceCriteriaInput,
  ): Promise<readonly AcceptanceCriterionVerification[]> {
    return this.store.transaction(async (repos) => {
      const item = await this.requireOperableWorkItem(repos, input.workItemId, "verifyAcceptanceCriteria");

      const run = await repos.runs.findById(input.verifierRunId);
      if (run === undefined || run.workItemId !== input.workItemId) {
        throw new NotFoundError("Run for work item", `${input.verifierRunId}@${input.workItemId}`);
      }
      if (run.role !== "VERIFIER") {
        throw new ValidationError(`run ${run.id} is not a VERIFIER run`);
      }
      if (run.status !== "SUCCEEDED") {
        throw new ValidationError(`run ${run.id} did not succeed; cannot verify acceptance criteria from it`);
      }
      if (run.specRevision !== item.specRevision) {
        throw new ValidationError(`run ${run.id} is stale for current spec revision ${item.specRevision}`);
      }

      const implementation = await resolveCurrentImplementation(item, repos);
      if (!implementation.ok) {
        throw new ValidationError(implementation.reason);
      }
      if (run.targetRunId !== implementation.value.id) {
        throw new ValidationError(
          `verifier run ${run.id} examined ${String(run.targetRunId)}, which is not the current implementation run ${implementation.value.id}`,
        );
      }

      const criteria = await repos.criteria.listByWorkItem(item.id);
      const runEvidence = (await repos.evidence.listByWorkItem(item.id)).filter(
        (evidence) => evidence.runId === run.id,
      );

      const records: AcceptanceCriterionVerification[] = [];
      for (const criterion of criteria) {
        const proof = runEvidence.find((evidence) => evidence.criterionId === criterion.id);
        records.push(
          await repos.verifications.save({
            id: this.ids.next("acv"),
            criterionId: criterion.id,
            workItemId: item.id,
            specRevision: item.specRevision,
            implementationRunId: implementation.value.id,
            result: proof === undefined ? "FAILED" : "PASSED",
            verifierPrincipalId: run.workerPrincipalId,
            verifierRunId: run.id,
            ...(proof === undefined ? {} : { evidenceId: proof.id }),
            verifiedAt: this.clock.now(),
          }),
        );
      }
      return records;
    });
  }

  async listEvidence(workItemId: WorkItemId): Promise<readonly Evidence[]> {
    return this.store.evidence.listByWorkItem(workItemId);
  }

  async listRuns(workItemId: WorkItemId): Promise<readonly Run[]> {
    return this.store.runs.listByWorkItem(workItemId);
  }

  /**
   * Read-only, like listRuns/listEvidence. Added in TASK-004 remediation
   * round 1: crash reconciliation must recover an already-recorded Review
   * from authoritative Factory state (matched by its reviewerRunId) instead
   * of recording a duplicate; no public read for reviews existed before.
   */
  async listReviews(workItemId: WorkItemId): Promise<readonly Review[]> {
    return this.store.reviews.listByWorkItem(workItemId);
  }

  /**
   * Read-only re-derivation of the authority that guards
   * REVIEW -> WAITING_FOR_HUMAN, from live authoritative records — the SAME
   * lineage the `requireIndependentSemanticReview` precondition enforces
   * (current implementation at the current spec revision, its current passing
   * deterministic verification with evidence, and an independent, passing
   * semantic review of that exact implementation by a distinct principal; a
   * newer attempt or blocking review supersedes any of it).
   *
   * Added in TASK-004 remediation round 3 (independent review HIGH 2): a
   * loop's persisted `phase = WAITING_FOR_HUMAN` / cached `lastVerdict = PASS`
   * is orchestration checkpoint state, never authority. Before the loop
   * exposes or accepts a WAITING_FOR_HUMAN outcome from a reloaded row, it
   * asks the Factory Core to prove that authority currently holds — composing
   * the existing accepted resolver rather than reimplementing any of its
   * rules. `ok: false` means fail closed (the WorkItem may be genuinely
   * absent, or the referenced lineage may be stale/missing/superseded).
   */
  async resolveWaitingForHumanAuthority(
    workItemId: WorkItemId,
  ): Promise<{ ok: true; value: ResolvedReview } | { ok: false; reason: string }> {
    const item = await this.store.workItems.findById(workItemId);
    if (item === undefined) {
      return { ok: false, reason: `work item ${workItemId} does not exist` };
    }
    if (item.status !== "WAITING_FOR_HUMAN" && item.status !== "REVIEW") {
      return {
        ok: false,
        reason: `work item ${workItemId} is ${item.status}, not at REVIEW/WAITING_FOR_HUMAN where an independent passing review is the current authority`,
      };
    }
    const resolved = await resolveSemanticReview(item, this.store);
    return resolved.ok ? { ok: true, value: resolved.value } : { ok: false, reason: resolved.reason };
  }

  /**
   * Read-only, like listRuns/listReviews. Added for TASK-005: crash
   * reconciliation of a materialization claim must find whether the WorkItem
   * creation actually committed, by matching the exact `planVersion`
   * correlation tag against authoritative Factory state — never by guessing
   * from titles or timestamps.
   */
  async listWorkItemsByProject(projectId: ProjectId): Promise<readonly WorkItem[]> {
    return this.store.workItems.listByProject(projectId);
  }

  async listCriteria(workItemId: WorkItemId): Promise<readonly AcceptanceCriterion[]> {
    return this.store.criteria.listByWorkItem(workItemId);
  }

  async listVerifications(workItemId: WorkItemId): Promise<readonly AcceptanceCriterionVerification[]> {
    return this.store.verifications.listByWorkItem(workItemId);
  }

  workItemSubject(id: WorkItemId): SubjectRef {
    return workItemSubject(id);
  }
}
