/**
 * The autonomous completion supervisor (TASK-006 §7).
 *
 * ONE TICK, THEN EXIT. This is deliberately not a daemon loop. A tick does one
 * bounded pass — reconcile, refresh, select, act — and returns, publishing
 * `nextWakeAt` so a systemd timer or cron can wake the next one. Between ticks
 * NO PROCESS RUNS AT ALL, which is what makes waiting cost exactly zero tokens
 * and zero CPU.
 *
 * That is the shape the mandate's first rule demands: AI must never be used to
 * wait for AI. A sleeping model session that periodically asks "is the limit
 * reset yet?" is the thing this design exists to make impossible — there is no
 * loop to hold one open.
 *
 * Everything else is the protocol TASK-004 and TASK-005 paid for:
 *   - a persisted status is a CHECKPOINT, never authority;
 *   - a durable claim is written by CAS BEFORE any external side effect;
 *   - action identities are derived, never random;
 *   - ambiguity fails closed rather than being retried.
 */

import type { LaunchAcknowledgement } from "./acceptance.js";
import type { ReviewLauncher, ReviewLaunchRequest } from "./supervisorPorts.js";
import {
  bindingMismatch,
  completionDetail,
  isAccepted,
  NO_VERDICT_OUTCOME,
  type AcceptanceVerdictSource,
} from "./acceptance.js";
import {
  adoptLaunchedReview,
  canonicalActivityId,
  claimActivity,
  classifyActivity,
  completeActivity,
  crashedItemsToRequeue,
  isTerminal,
  recordReconciliation,
  RECOVERY_TO_STATUS,
  reportProgress,
  reviewsAwaitingVerdict,
  settleReview,
  unobservedCompletions,
  type Activity,
  type ActivityLease,
  type Liveness,
  type LivenessProbe,
  type TransitionVerdict,
} from "./activity.js";
import {
  CATALOG_UPGRADE_STEPS,
  planCatalogUpgrade,
  ROADMAP_CATALOG_VERSION,
  type CatalogUpgradeStep,
} from "./catalogUpgrade.js";
import { reconcileRoadmapWithCatalog, unprovenCompletion } from "./roadmapCatalog.js";
import {
  ConcurrencyError,
  ProvenanceRegressionError,
  PersistenceCorruptionError,
  SchemaIntegrityError,
  ValidationError,
} from "../domain/errors.js";
import type { IdGenerator } from "../domain/ids.js";
import type { Clock } from "../ports/clock.js";
import type { Timestamp } from "../domain/time.js";
import {
  evaluateFinancialSafety,
  launchAiWorkerAction,
  mintedResourceKey,
  observeBilling,
  parseFinancialPolicy,
  type BillingMode,
  type BillingObservation,
  type SupervisedAction,
} from "./financialSafety.js";
import {
  reconcileReportedIdentity,
  SUPPORTED_MODELS,
  type AiRunConfigRecord,
} from "./modelEnforcement.js";
import { planAiRunConfig } from "./modelEnforcement.js";
import { requiresAi, selectResource, type RoutingPolicy } from "./modelRouting.js";
import {
  anchorFor,
  appendProvenance,
  GENESIS_DIGEST,
  implementersByRoadmapKey,
  keysWithUnknownImplementer,
  verifyAgainstAnchor,
  type ProvenanceEntry,
} from "./provenanceChain.js";
import { boundedDiagnostic, classifyResourceOutcome, type Classification } from "./resourceClassifier.js";
import {
  isRetryDue,
  isUsable,
  nextBackoff,
  resourceKey,
  NO_BACKOFF,
  type ResourceRecord,
  type ResourceState,
} from "./resourceTypes.js";
import { REQUIRED_RESOURCE_ROLES } from "./supervisorPorts.js";
import type {
  AuthorizedResource,
  ReportedRunIdentity,
  RequiredResource,
  ResourceProbe,
  SupervisorRepository,
  WorkExecutor,
  WorkOutcome,
} from "./supervisorPorts.js";
import {
  canonicalActionId,
  DEFAULT_ROADMAP,
  type EscalationReason,
  type HumanEscalation,
  type ReviewRequest,
  type RoadmapItem,
  type SessionCheckpoint,
  type SupervisorActionClaim,
  type SupervisorState,
} from "./supervisorTypes.js";

export interface SupervisorServiceDeps {
  readonly repository: SupervisorRepository;
  readonly probe: ResourceProbe;
  readonly executor: WorkExecutor;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly routingPolicy: RoutingPolicy;
  /**
   * The resources this installation may use.
   *
   * `billingMode` here is a CONSTRAINT, not a declaration. Since NEW-FIN-1 the
   * mode that counts is the one the provider itself reported to the last probe;
   * this entry may only make the answer stricter ("treat this as metered even
   * though it looks included"). It cannot make an unobserved or metered
   * resource look free, because configuration is a claim and a probe is
   * evidence. See `billingModeFor`.
   */
  readonly resourceCatalog: readonly {
    readonly provider: string;
    readonly model: string;
    readonly billingMode?: BillingMode;
  }[];
  /**
   * The roadmap's DEFINITION, from code (TASK-012 AC-4).
   *
   * Injectable for the same reason `resourceCatalog` is: a test declares its
   * roadmap in code rather than smuggling one in through persisted state, which
   * is precisely the channel this task closes.
   */
  readonly roadmapCatalog?: readonly RoadmapItem[];
  /**
   * The roadmap catalog version this installation declares (TASK-018 AC-1).
   *
   * Injectable for the same reason `roadmapCatalog` is: the upgrade's refusals
   * have to be drivable without shipping a fake past in `DEFAULT_ROADMAP`.
   */
  readonly catalogVersion?: number;
  /**
   * The declared upgrade steps (TASK-018 AC-3). Defaults to the ones this build
   * ships, and to NONE when a catalog is injected — see `catalogUpgradeSteps`.
   */
  readonly catalogUpgradeSteps?: readonly CatalogUpgradeStep[];
  /**
   * How this installation finds out whether a lease holder is still running
   * (TASK-018 AC-12). Injected for the same reason the probe and clock are: a
   * test states the fact, and the production adapter reads `/proc`.
   *
   * ABSENT means liveness cannot be established, and reconciliation then
   * concludes nothing — an unknown refuses.
   */
  readonly liveness?: LivenessProbe;
  /** The interval AC-14 measures a stall against. Defaults to forty minutes. */
  readonly stallAfterMs?: number;
  /**
   * How this installation builds a lease for ITSELF (TASK-018 AC-12).
   *
   * Injected rather than imported so the supervisor keeps no dependency on
   * `/proc`, and so a test can hand it a lease whose liveness it controls. The
   * production adapter is `leaseForThisProcess`, which reads the same file the
   * probe compares against — a lease built any other way would fail its own
   * check and the holder would look dead to itself.
   */
  readonly activityLease?: (claimedAt: Timestamp) => ActivityLease | undefined;
  /**
   * Where a launched review's verdict can be read back from (TASK-018 round-7
   * gap).
   *
   * ABSENT means this installation launches no reviews. An activity that
   * records one anyway is then unconsumable, and the consumer says so rather
   * than passing over it in silence.
   */
  readonly acceptanceVerdicts?: AcceptanceVerdictSource;
  /**
   * How this installation STARTS an independent review (TASK-019 AC-2).
   *
   * Absent means this supervisor does not launch reviews, and a durable request
   * for one is then unservable — which the consumer refuses rather than
   * ignores, the same rule the probe and the lease follow. The shell chain that
   * used to do this is not a fallback: a request nobody can service must be
   * visible, not quietly deferred to something outside the repository.
   */
  readonly reviewLauncher?: ReviewLauncher;
  readonly log?: (line: string) => void;
  readonly ownerId?: string;
}

/**
 * What a write may carry ALONGSIDE an activity transition — or why it may not.
 *
 * See `commitActivityChange`. The refusal case exists because "the state I was
 * going to patch is no longer the state I read" must be an answer rather than
 * an overwrite.
 */
export type AlongsideVerdict =
  | { readonly ok: true; readonly patch: Partial<SupervisorState> }
  | { readonly ok: false; readonly problem: string };

/**
 * Whether a failed write is worth re-reading and recomputing.
 *
 * `ConcurrencyError` is the CAS losing, which IS a stale read.
 * `ProvenanceRegressionError` is raised BEFORE the CAS, when the provenance
 * being written is shorter than the stored chain — which is what a rival's
 * append makes an in-hand snapshot look like. It is only a REASON TO LOOK: the
 * caller must still prove the durable state moved before treating it as a race,
 * because a deliberate truncation raises exactly the same error.
 *
 * Deliberately narrow. Every other `SchemaIntegrityError` — a rewritten entry,
 * a broken chain, a malformed table — is a refusal about the write itself, and
 * retrying one of those is how a corruption guard turns into five attempts at
 * corrupting.
 */
/**
 * Whether somebody has ALREADY consumed this review.
 *
 * ROUND-9 REVIEW, HIGH 3. `settleReview` made a second settlement a correct
 * no-op, and the patch travelling beside it was applied anyway — so two
 * supervisors consuming one CHANGES_REQUIRED each released the item and each
 * launched remediation. Idempotence has to cover the WHOLE transition, not the
 * half of it that happens to live in the activity list.
 *
 * Observed-and-terminal is the mark, because the observation is written by
 * whoever applied the verdict, in the same write as the roadmap move it
 * accompanies. If it is there, the move has already happened.
 */
function alreadySettled(state: SupervisorState, activityId: string): boolean {
  const activity = (state.activities ?? []).find((entry) => entry.id === activityId);
  return activity !== undefined && isTerminal(activity.state) && activity.observedAt !== undefined;
}

/**
 * One answer per lease, for the life of one tick.
 *
 * Wrapping rather than caching inside the probe, because the probe is a PORT: a
 * `/proc` read that answers differently a second later is not wrong, it is
 * honest. What must not differ is two answers used inside ONE decision.
 */
function memoisedLiveness(probe: LivenessProbe): LivenessProbe {
  const seen = new Map<string, Liveness>();
  return {
    check(lease) {
      const key = JSON.stringify([lease.pid, lease.processStartedAt, lease.machine, lease.boot]);
      const already = seen.get(key);
      if (already !== undefined) {
        return already;
      }
      const answer = probe.check(lease);
      seen.set(key, answer);
      return answer;
    },
  };
}

/**
 * Where a review reports, derived rather than chosen.
 *
 * Derived from the run id, so two reviews cannot collide on one path and a
 * previous round's file cannot be mistaken for this round's answer — the
 * wrong-candidate refusal exists for the case where it happens anyway, and this
 * is the cheaper half of that guard.
 */
function reviewSourcePath(request: ReviewRequest, activityId: string): string {
  return `${reviewDirectory(request)}/${safeName(activityId)}-verdict.txt`;
}

function reviewAckPath(request: ReviewRequest, activityId: string): string {
  return `${reviewDirectory(request)}/${safeName(activityId)}-ack.json`;
}

function reviewDirectory(request: ReviewRequest): string {
  return `${REVIEW_ROOT}/${safeName(request.roadmapKey)}`;
}

/** Absolute, because a relative path means different files to different processes. */
const REVIEW_ROOT = process.env["SF_REVIEW_DIR"] ?? `${process.env["HOME"] ?? "/tmp"}/.software-factory/reviews`;

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function leaseFromAcknowledgement(ack: LaunchAcknowledgement): ActivityLease {
  return {
    pid: ack.pid,
    processStartedAt: ack.processStartedAt,
    machine: ack.machine,
    boot: ack.boot,
    claimedAt: ack.at,
  };
}

function isStaleSnapshot(error: unknown): boolean {
  return error instanceof ConcurrencyError || error instanceof ProvenanceRegressionError;
}

export type TickResult =
  | { readonly kind: "IDLE"; readonly reason: string; readonly nextWakeAt?: Timestamp }
  | { readonly kind: "ADVANCED"; readonly roadmapKey: string; readonly actionId: string; readonly detail: string }
  | {
      readonly kind: "WAITING_FOR_RESOURCE";
      readonly roadmapKey: string;
      readonly reason: string;
      readonly nextWakeAt?: Timestamp;
    }
  | {
      readonly kind: "WAITING_FOR_HUMAN";
      readonly roadmapKey: string;
      readonly reason: EscalationReason;
      readonly humanActionRequired: string;
    }
  | { readonly kind: "RECOVERY_REQUIRED"; readonly reason: string };

/** Backstop against a caller looping ticks without progress. */
const MAX_REMEDIATION_ATTEMPTS = 5;

/**
 * What one tick pass hands back: its result, and — only when the pass ran to
 * a trusted CONCLUSION — the state that vouches for the advisory wake
 * (round-12 finding 1).
 *
 * A `REFUSAL` deliberately has no field a basis could travel in. Round 11
 * kept "the newest state this tick committed" in an instance field, and the
 * reviewer measured the gap: a legitimate catalog-upgrade commit at step 0b
 * followed by a lineage refusal at step 1b left the earlier commit as the
 * basis, so the refused tick still wrote a wake. Making the basis part of the
 * outcome's SHAPE means no ordering of commits and refusals can leak one: a
 * refusal cannot carry what its type cannot express, and a conclusion cannot
 * be constructed without naming the state that vouches for it.
 */
type TickOutcome =
  | { readonly kind: "REFUSAL"; readonly result: TickResult }
  | { readonly kind: "CONCLUSION"; readonly result: TickResult; readonly wakeBasis: SupervisorState };

export class SupervisorService {
  private readonly deps: SupervisorServiceDeps;
  private readonly log: (line: string) => void;
  private readonly ownerId: string;

  constructor(deps: SupervisorServiceDeps) {
    this.deps = deps;
    // N-3 (HIGH): durable diagnostics were redacted but LOG output was not, so
    // a token in an executor's description still reached the console — and a
    // log is just durable state with a different filename. Every line goes
    // through the same redaction and bounding, at one chokepoint, so no future
    // call site can forget.
    const sink = deps.log ?? ((): void => {});
    this.log = (line: string): void => sink(boundedDiagnostic(line));
    this.ownerId = deps.ownerId ?? `supervisor:${process.pid}:${deps.ids.next("own")}`;
  }

  // =====================================================================
  // Seeding
  // =====================================================================

  /**
   * Creates the durable state if it does not exist yet.
   *
   * The financial policy is seeded DENY. That is not a placeholder to be
   * relaxed later — it is the secure default, and §3 requires that a missing or
   * untrusted policy denies rather than permits.
   */
  async ensureInitialized(): Promise<SupervisorState> {
    const existing = await this.deps.repository.load();
    if (existing !== undefined) {
      return existing;
    }
    const now = this.deps.clock.now();
    const seeded: SupervisorState = {
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: this.deps.resourceCatalog.map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        key: resourceKey(entry.provider, entry.model),
        // Nothing is assumed usable until it has been probed. Absence of
        // evidence is not evidence of availability.
        state: "UNKNOWN_FAILURE" as ResourceState,
        detectedAt: now,
        lastCheckedAt: 0,
        backoff: NO_BACKOFF,
        diagnostic: "never probed",
      })),
      roadmap: this.roadmapCatalog().map((item) => ({ ...item, dependsOn: [...item.dependsOn] })),
      checkpoints: [],
      escalations: [],
      // A new installation starts from the published genesis with nothing
      // recorded — an empty chain verifies trivially, which is correct: there
      // is no history to vouch for yet.
      provenance: [],
      updatedAt: now,
    };
    return this.deps.repository.create(seeded);
  }

  // =====================================================================
  // The tick
  // =====================================================================

  /**
   * One bounded pass, then exit.
   *
   * The wake time is published ONCE, here, after whatever the pass did (review
   * note, round 4). Individual paths used to each set it, which meant the paths
   * that did NOT — completing an item, escalating to a human — left whatever the
   * last waiting tick had written. A timer would then wake for a resource that
   * had long since recovered. Recomputing at a single exit point makes
   * `nextWakeAt` a fact about the state rather than a residue of the path taken
   * to reach it.
   *
   * AND ONLY FROM A PASS THAT RAN TO A TRUSTED CONCLUSION (round-11 and
   * round-12, finding 1 both times). Round 11 keyed publication off "the
   * newest state this tick committed" — an instance field a successful commit
   * set. Round 12 measured the gap: a catalog-upgrade commit at step 0b
   * followed by a lineage REFUSAL at step 1b left the earlier commit as the
   * basis, and the refused tick still wrote a wake. "Committed something" and
   * "concluded without refusing" are different properties, and only the
   * second may schedule. So the basis now travels WITH the outcome: a
   * `REFUSAL` has no field a basis could ride in, no matter what legitimate
   * housekeeping was committed before the refusal fired.
   */
  /** Set for the duration of one tick; see `tick`. */
  private tickProbe: LivenessProbe | undefined;

  async tick(): Promise<TickResult> {
    let outcome: TickOutcome;
    /**
     * ONE TICK, ONE ANSWER ABOUT ONE LEASE (round-9 review, HIGH 1).
     *
     * The first version of this fix memoised inside `reconcileActivities`, and
     * a test that simply COUNTED the calls showed the probe still being asked
     * twice: `reconcileClaim` and the claim path ask as well, and they are the
     * readers whose disagreement decides whether a live owner keeps its claim.
     * Scoped to one function, the fix would have closed the case the reviewer
     * reproduced and left the neighbouring ones open — which is the exact
     * pattern the last three rounds have been about.
     *
     * The memo lasts for the tick and is dropped with it, because a `/proc`
     * read that answers differently a minute later is not wrong; two answers
     * used inside ONE decision are.
     */
    this.tickProbe = this.deps.liveness === undefined ? undefined : memoisedLiveness(this.deps.liveness);
    try {
      outcome = await this.runTick();
      this.tickProbe = undefined;
    } catch (error) {
      this.tickProbe = undefined;
      /**
       * A CORRUPT RECORD IS AN ANSWER, NOT AN EXCEPTION (round-8 HIGH).
       *
       * AC-5 requires tampering to produce a human decision. It did — as long
       * as the tampering left something the DESERIALIZER would accept. Writing
       * `prov-forged` into a digest instead failed earlier than that, in
       * parsing, and the supervisor died with a `PersistenceCorruptionError`
       * before it could decide anything. From the operator's side a crash and a
       * refusal are not the same event: one is a fault to debug, the other is a
       * verdict with an instruction attached.
       *
       * DELIBERATELY NARROW. Only failures to READ are converted. A refusal to
       * WRITE keeps propagating, because that is the repository enforcing the
       * chain and no caller should be able to mistake it for a decision — and
       * because converting it here would mask `runTick`'s own step 0.
       */
      if (!(error instanceof PersistenceCorruptionError)) {
        throw error;
      }
      this.log(`[supervisor] durable state could not be read: ${error.message}`);
      return sanitizeTickResult({
        kind: "WAITING_FOR_HUMAN",
        roadmapKey: "unknown",
        reason: "HUMAN_DECISION_REQUIRED",
        humanActionRequired: boundedDiagnostic(
          "Durable supervisor state no longer parses, so nothing about the roadmap, its provenance or its " +
            "progress can be established. Restore the supervisor database from a known-good backup. " +
            `Detail: ${error.message}`,
        ),
      });
    }
    await this.publishWake(outcome);
    return sanitizeTickResult(outcome.result);
  }

  /**
   * Records a durable blocker against one roadmap item (TASK-009).
   *
   * The item is left in a fail-closed state the scheduler will not select, and
   * everything needed to resume — why it stopped, and where to pick it up — goes
   * into durable state rather than into whatever conversation happened to be
   * open at the time.
   *
   * Routed through `escalate` rather than writing state directly, because a
   * second way to mutate durable state is a second thing to get wrong: this way
   * the text is bounded and redacted, and the write is CAS-protected, by the
   * same code every other escalation already uses.
   *
   * This can ONLY restrict (AC-7). There is deliberately no counterpart that
   * clears a blocker, marks an item DONE, edits dependencies or touches the
   * financial policy — an operator unblocks by fixing the cause and letting the
   * supervisor re-derive, not by asserting that it is fine now.
   */
  async recordBlocker(input: {
    readonly roadmapKey: string;
    readonly reason: EscalationReason;
    readonly humanActionRequired: string;
    readonly detail: string;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    const state = await this.ensureInitialized();
    if (!state.roadmap.some((item) => item.key === input.roadmapKey)) {
      // AC-3: never invent an item. A typo must fail loudly, not create a ghost
      // entry that quietly never runs.
      return {
        ok: false,
        reason: `no roadmap item named ${JSON.stringify(input.roadmapKey)}; known keys: ${state.roadmap
          .map((item) => item.key)
          .join(", ")}`,
      };
    }
    await this.escalate(
      state,
      input.roadmapKey,
      input.reason,
      input.humanActionRequired,
      input.detail,
    );
    return { ok: true };
  }

  /**
   * THE WAKE DERIVES ONLY FROM A CONCLUDED PASS'S OWN STATE (round-11 and
   * round-12, finding 1 both times).
   *
   * Round 10's version loaded state fresh from the repository, which meant it
   * published — and COMMITTED — whatever was persisted, including state the
   * tick had just REFUSED: a row whose identity IS catalogued, tampered to
   * `retryAt=1800000005000` inside a roadmap-refused state, supplied the
   * published wake, and the commit re-persisted the entire refused state.
   * Round 11's version took "the newest state this tick committed"; round 12
   * measured that a refusal FOLLOWING a legitimate commit (a catalog-upgrade
   * append, then the lineage check refusing) still published from that
   * earlier commit.
   *
   * The property that holds now: publication requires a `CONCLUSION`, and a
   * `CONCLUSION` carries the state that vouches for it. A `REFUSAL` has no
   * basis field at all, so no ordering of commits and refusals inside the
   * pass can leak a wake out of a refused tick. There is no fresh load for
   * refused rows to ride in on, and anything written concurrently after the
   * basis makes the CAS below fail, which is a skip, not an endorsement. A
   * missing wake is an advisory loss; a published one derived from refused
   * state was a removed-or-tampered resource controlling the scheduler.
   */
  private async publishWake(outcome: TickOutcome): Promise<void> {
    if (outcome.kind !== "CONCLUSION") {
      // The pass refused durable state. Nothing about it — not even a wake
      // time — is trustworthy enough to write back.
      return;
    }
    const basis = outcome.wakeBasis;
    const wake = this.computeNextWake(basis);
    if (basis.nextWakeAt === wake) {
      return;
    }
    try {
      await this.commit(basis, withWake(basis, wake));
    } catch (error) {
      /**
       * ADVISORY BOOKKEEPING, and that has to mean it CANNOT decide the tick
       * (round-8 HIGH).
       *
       * The rule was already written for `ConcurrencyError` and applied only to
       * it. With a tampered chain the repository correctly REFUSES the write,
       * and that refusal was rethrown from here — after `runTick` had already
       * decided `WAITING_FOR_HUMAN` — so the fail-closed result the whole guard
       * exists to produce never reached the caller.
       *
       * All three of these mean the same thing: the wake time could not be
       * written. None of them is this tick's verdict. A refusal to write is
       * still enforced everywhere it MATTERS — every substantive path commits
       * through `commit`, where it is not swallowed.
       */
      if (error instanceof ConcurrencyError) {
        return;
      }
      if (error instanceof SchemaIntegrityError || error instanceof PersistenceCorruptionError) {
        this.log(`[supervisor] could not publish the next wake time: ${error.message}`);
        return;
      }
      throw error;
    }
  }

  private async runTick(): Promise<TickOutcome> {
    const state = await this.ensureInitialized();

    // 0. Refuse before anything tries to WRITE. The repository will not persist
    //    a broken chain, so housekeeping would throw rather than decide.
    const broken = this.brokenChainOutcome(state);
    if (broken !== undefined) {
      return { kind: "REFUSAL", result: broken };
    }

    /**
     * 0b. THE DEFINITION COMES FROM CODE (TASK-012).
     *
     * Before anything reads `workClass` to decide whether review is required,
     * or `dependsOn` to decide what is eligible, or `status` to decide that a
     * dependency is satisfied. Those three reads are the whole attack surface
     * the reviewer demonstrated, and every one of them happens below this line.
     */
    const catalogued = await this.catalogState(state);
    if (catalogued.result !== undefined) {
      return { kind: "REFUSAL", result: catalogued.result };
    }
    /**
     * 0c. RESULTS THAT ALREADY EXIST, before anything concludes anyone died
     * (TASK-018, round-7 gap).
     *
     * Ordering is the whole point. A reviewer writes its verdict and exits
     * immediately, so by the time any supervisor looks, its owner is legitimately
     * gone — and reconciliation, asked first, would classify that activity
     * CRASHED and requeue the item as work that never produced anything. The
     * result exists; being asked in the wrong order is what loses it.
     *
     * So the artefact is read before the process is judged. This is the same
     * lesson AC-19 states about completions, applied to the one kind of work
     * whose author is guaranteed to be dead when its output is found.
     */
    /**
     * 0b-bis. REVIEWS THIS FACTORY OWNS (TASK-019).
     *
     * Before verdicts are consumed and before anything is concluded about who
     * is alive: a requested review is started if it has not been, and a started
     * one is adopted once its worker has proved it exists. Both are pure state
     * transitions over durable rows, and both are safe to repeat — which is
     * what lets a supervisor die anywhere in here and a fresh one carry on.
     */
    const reviewed = await this.reconcileReviews(catalogued.state);
    if (reviewed.refusal !== undefined) {
      return {
        kind: "REFUSAL",
        result: {
          kind: "WAITING_FOR_HUMAN",
          roadmapKey: reviewed.refusal.roadmapKey,
          reason: "HUMAN_DECISION_REQUIRED",
          humanActionRequired: reviewed.refusal.problem,
        },
      };
    }

    const consumed = await this.consumeAcceptanceVerdicts(reviewed.state);
    if (consumed.refusal !== undefined) {
      return {
        kind: "REFUSAL",
        result: {
          kind: "WAITING_FOR_HUMAN",
          roadmapKey: consumed.refusal.roadmapKey,
          reason: "HUMAN_DECISION_REQUIRED",
          humanActionRequired: consumed.refusal.problem,
        },
      };
    }

    /**
     * 0d. WORK IN FLIGHT, before anything decides what to do next (TASK-018).
     *
     * After the definition is trusted and before eligibility is computed: an
     * item whose owner crashed goes back to the queue here, so the selection
     * below sees the roadmap as it actually is rather than as a dead process
     * left it.
     */
    const inFlight = await this.reconcileActivities(consumed.state);
    if (inFlight.refusal !== undefined) {
      return {
        kind: "REFUSAL",
        result: {
          kind: "WAITING_FOR_HUMAN",
          roadmapKey: inFlight.state.roadmap[0]?.key ?? "unknown",
          reason: "HUMAN_DECISION_REQUIRED",
          humanActionRequired: inFlight.refusal,
        },
      };
    }
    const defined = inFlight.state;

    /**
     * 1a. RESOURCES RECONCILE BEFORE ANY PATH THAT CAN PUBLISH A WAKE
     * (round-8 finding 1, ordering half found in round 9).
     *
     * Round 8 made this the single chokepoint and placed it before refresh --
     * but `reconcileClaim` below can RETURN EARLY (a lost RUNNING claim), and
     * `publishWake` then computes the next wake from the raw persisted rows. The
     * reviewer measured it: an uncatalogued `rogue:ghost` row survived a
     * lost-owner early return and supplied the published wake time, so removed
     * catalog entries still controlled scheduling.
     *
     * So the chokepoint runs here, after the two tamper-refusal gates and before
     * anything else. The tamper-refusal paths above (broken chain, roadmap
     * disagreement) deliberately do NOT reconcile: those states are refused
     * precisely because WRITING to them is the hazard — and since round 11,
     * `publishWake` cannot even see them, because it derives only from a state
     * this tick committed and a refusal commits nothing.
     *
     * Filtering at each reader is how this task repeatedly left a sibling call
     * site open; reconciling once, here, means every later reader -- refresh,
     * `anyUsable`, wake, routing, declaration -- sees configuration, not rows.
     */
    const resourcesReconciled = await this.reconcileResourcesWithCatalog(defined);

    /**
     * 1b. WORK THAT REACHED A WORKER MUST HAVE LEFT LINEAGE — checked BEFORE
     * any conclusion exists to hand a wake basis over (round-13 finding 1).
     *
     * This check used to run after `reconcileClaim`, because a pending claim's
     * attempt has not launched yet and counting it would refuse an ordinary
     * crash. The reviewer measured what that ordering cost: a lost RUNNING
     * claim returns a CONCLUSION, so a state whose LINEAGE was already invalid
     * — an AI item DONE with no record of anything having run — reached a
     * conclusion through the claim path and published a wake.
     *
     * The ordering was standing in for a narrower fact: the ACTIVE claim
     * explains exactly one attempt of exactly its own item. So that attempt is
     * discounted here, in the view this check reads, and the check runs first.
     * An ordinary crash (a live claim, no other gap) passes and recovery
     * proceeds; a lineage gap the claim cannot explain — a DONE item without
     * provenance, or launched attempts beyond the claimed one — refuses the
     * whole state before any path can conclude on it. The DONE branch ignores
     * attempts entirely, so a claim never excuses a completed item.
     */
    const claimKey = resourcesReconciled.activeClaim?.roadmapKey;
    const lineageView =
      claimKey === undefined
        ? resourcesReconciled.roadmap
        : resourcesReconciled.roadmap.map((entry) =>
            entry.key === claimKey
              ? { ...entry, unlaunchedAttempts: (entry.unlaunchedAttempts ?? 0) + 1 }
              : entry,
          );
    const unproven = unprovenCompletion({
      roadmap: lineageView,
      implementedKeys: new Set(
        resourcesReconciled.provenance
          .filter((entry) => entry.kind === "IMPLEMENTED_BY")
          .map((entry) => entry.roadmapKey),
      ),
    });
    if (unproven !== undefined) {
      /**
       * A STATE refusal, not an action refusal (round-12 finding 1): lineage
       * in durable state cannot be trusted, so nothing derived from that
       * state — including its wake — may be written, and the claim it holds
       * is left exactly where it is for a human to inspect.
       */
      return { kind: "REFUSAL", result: this.unprovenRefusal(resourcesReconciled, unproven) };
    }

    // 1. Reconcile any claim left behind by a previous process.
    const reconciled = await this.reconcileClaim(resourcesReconciled);
    if (reconciled.result !== undefined) {
      // A lost RUNNING claim is an ACTION refusal inside trusted, reconciled
      // state whose lineage was just checked — the escalation was committed,
      // and that state may schedule.
      return { kind: "CONCLUSION", result: reconciled.result, wakeBasis: reconciled.state };
    }
    let current = reconciled.state;

    // 2. Refresh only resources whose retry is actually due. A resource with a
    //    known retryAt in the future is deliberately NOT probed: probing early
    //    costs something and tells us nothing new.
    // Resources were reconciled at step 1a, before any early return.
    current = await this.refreshDueResources(current);

    // 3. Recompute eligibility: from the dependency DAG, and from whether any
    //    resource has since become usable. An item parked in
    //    WAITING_FOR_RESOURCE would otherwise stay parked forever — nothing
    //    else puts it back in the queue.
    const anyUsable = current.resources.some(isUsable);
    current = await this.commit(current, {
      ...current,
      roadmap: promoteWaitingItems(recomputeEligibility(current.roadmap), anyUsable),
    });

    // 4. Choose the next item, if any is actionable now.
    const item = selectNextItem(current.roadmap);
    if (item === undefined) {
      const wake = this.computeNextWake(current);
      const settled = await this.commit(current, withWake(current, wake));
      const pending = settled.roadmap.filter((entry) => entry.status !== "DONE");
      return {
        kind: "CONCLUSION",
        result: {
          kind: "IDLE",
          reason: pending.length === 0 ? "every roadmap item is DONE" : "no roadmap item is actionable right now",
          ...(wake === undefined ? {} : { nextWakeAt: wake }),
        },
        wakeBasis: settled,
      };
    }

    return this.runItem(current, item);
  }

  // =====================================================================
  // Claim reconciliation (§12)
  // =====================================================================

  private async reconcileClaim(state: SupervisorState): Promise<{ state: SupervisorState; result?: TickResult }> {
    const claim = state.activeClaim;
    if (claim === undefined) {
      return { state };
    }
    const { activeClaim: _dropped, ...withoutClaim } = state;
    void _dropped;

    /**
     * A CLAIM IS NOT PROOF THAT ITS OWNER IS GONE — IN EITHER STATE
     * (round-3 review HIGH 1, widened by round-7 review HIGH 1).
     *
     * This function was written when the supervisor was effectively
     * single-process: a claim still outstanding at the start of a tick could
     * only mean the process that made it had died, so every one was treated as
     * abandoned. Part B made that assumption false.
     *
     * Round 3 fixed it for RUNNING and left CLAIMED exactly as it was, because
     * a CLAIMED claim "proves the external launch never happened" and a retry
     * is therefore safe. That reasoning is about the ACTION; it says nothing
     * about the PROCESS. Between taking a claim and recording the launch there
     * is a live owner holding a live lease, and this cleared the claim out from
     * under it — after which a second supervisor launched a second attempt at
     * the same work. The reviewer drove exactly that against a real database.
     *
     * The activity knows, in both states. It carries a lease whose liveness is
     * checkable, so that is consulted BEFORE anything is concluded, and a live
     * holder means this supervisor stands down: the claim is THEIRS and is left
     * exactly where it is, and the refusal names who has it (AC-13).
     */
    const probe = this.livenessProbe();
    const owner = (state.activities ?? []).find(
      (entry) => entry.id === canonicalActivityId(claim.roadmapKey, claim.kind, claim.attempt),
    );
    const holding =
      probe !== undefined && owner !== undefined && !isTerminal(owner.state) && owner.lease !== undefined
        ? { lease: owner.lease, liveness: probe.check(owner.lease) }
        : undefined;

    if (holding?.liveness === "ALIVE") {
      const held =
        `action ${claim.actionId} is held by pid ${holding.lease.pid} on ` +
        `${JSON.stringify(holding.lease.machine)}, which is still running; this supervisor is standing down`;
      this.log(`[supervisor] ${held}`);
      return {
        // The claim is NOT dropped: it belongs to the process that is still
        // working, and removing it would let a third supervisor start beside
        // them both.
        state,
        result: {
          kind: "WAITING_FOR_RESOURCE",
          roadmapKey: claim.roadmapKey,
          reason: boundedDiagnostic(held),
        },
      };
    }

    if (claim.state === "CLAIMED") {
      /**
       * AN UNKNOWABLE OWNER NEVER ARRIVES HERE, AND THAT IS WHY THERE IS NO
       * BRANCH FOR ONE (round-8 mutation run).
       *
       * A branch was written for it, refusing to clear a claim whose holder
       * could not be resolved. The mutation that disabled it SURVIVED: no test
       * could tell the difference, because `reconcileActivities` runs earlier in
       * the same tick and refuses outright for every activity whose liveness is
       * AMBIGUOUS. An unknowable owner stops the tick before the claim is ever
       * looked at; and with no probe at all, `holding` is `undefined` and the
       * branch could not fire either way. It was deleted rather than left as
       * code that reads like a guard and can never be one.
       */
      /**
       * Proves the external launch never happened: a bounded retry is safe.
       *
       * REVIEW FINDING (TASK-009, CRITICAL). "Safe to retry" was applied
       * unconditionally, so this promoted the item to ELIGIBLE even when
       * something had SINCE decided it must not run. A blocker recorded against
       * an item that happened to hold a CLAIMED action was therefore erased by
       * the next tick's housekeeping, after which the item ran and reached DONE.
       *
       * Clearing a claim says only that the ACTION did not happen. It says
       * nothing about whether the ITEM may still proceed, and conflating the two
       * let a deliberate restriction be undone by an unrelated mechanism. A
       * human-required or blocked status outranks a retry.
       */
      const item = state.roadmap.find((entry) => entry.key === claim.roadmapKey);
      const restricted = item?.status === "WAITING_FOR_HUMAN_REQUIRED" || item?.status === "BLOCKED";
      this.log(
        restricted
          ? `[supervisor] clearing an unlaunched claim ${claim.actionId}; ${claim.roadmapKey} stays ${item?.status ?? "restricted"}`
          : `[supervisor] clearing an unlaunched claim ${claim.actionId}`,
      );
      /**
       * RECORDS WHAT IT JUST PROVED (round-11 review).
       *
       * This branch exists because the launch demonstrably did not happen. That
       * fact was used and thrown away, which left `attempts` meaning "claimed"
       * rather than "ran" — and a missing-lineage check therefore could not use
       * it without refusing forever after an ordinary crash in this window.
       *
       * Written down, the ambiguity disappears: attempts that reached a worker
       * are `attempts - unlaunchedAttempts`, and lineage is required for those.
       */
      const withUnlaunched = restricted ? state.roadmap : setStatus(state.roadmap, claim.roadmapKey, "ELIGIBLE");
      const cleared = await this.commit(state, {
        ...withoutClaim,
        roadmap: countUnlaunchedAttempt(withUnlaunched, claim.roadmapKey),
      });
      return { state: cleared };
    }

    // RUNNING under an owner that is gone. Whether the external action
    // completed is unknowable, and repeating it could duplicate real work, so
    // this fails closed rather than guessing.
    const escalated = await this.escalate(
      withoutClaim,
      claim.roadmapKey,
      "RECOVERY_REQUIRED",
      `Inspect action ${claim.actionId} (${claim.kind}) and record whether it completed, then clear the recovery state.`,
      `action ${claim.actionId} was RUNNING under owner ${claim.ownerId}, which is no longer live; its outcome cannot be determined`,
    );
    return {
      state: escalated,
      result: {
        kind: "RECOVERY_REQUIRED",
        reason: `action ${claim.actionId} was left RUNNING by a lost owner; it must not be repeated blindly`,
      },
    };
  }

  // =====================================================================
  // Resource refresh (§6)
  // =====================================================================

  /**
   * Bring the persisted resource list back into agreement with the code catalog.
   *
   * Rows are OPERATIONAL STATE -- availability, backoff, the last observed
   * billing mode -- for resources this installation configured. Which resources
   * exist at all is CONFIGURATION, and configuration lives in code. When the two
   * disagree, code wins: a row for a resource the catalog no longer carries is
   * dropped, and a catalog entry with no row is seeded unprobed.
   *
   * Deliberately NOT a refusal like `reconcileRoadmapWithCatalog`. A roadmap
   * disagreement means durable state was tampered with or corrupted, and the
   * only safe answer is to stop. A resource disagreement is the ordinary
   * consequence of editing the catalog between releases, and stopping the
   * factory because someone added a model would be a guard that gets disabled.
   */
  private async reconcileResourcesWithCatalog(state: SupervisorState): Promise<SupervisorState> {
    const catalogued = new Map(
      this.deps.resourceCatalog.map((entry) => [resourceKey(entry.provider, entry.model), entry]),
    );
    const kept = state.resources.filter((record) => catalogued.has(record.key));
    const present = new Set(kept.map((record) => record.key));
    const now = this.deps.clock.now();
    /**
     * EACH LITERAL IS PINNED WITH `satisfies` (parallel structural audit,
     * round 9). The first version wrote `reason:` -- a field `ResourceRecord`
     * does not have -- and the explicit field-by-field serializer silently
     * DROPPED it on persist: the code claimed to record why, and the record
     * lost it.
     *
     * An array annotation alone was tried first and MEASURED not to bite: the
     * `reason` regression still compiled under `const added: ResourceRecord[]`,
     * because freshness does not survive the filter/map chain. `satisfies` on
     * the literal itself does perform excess-property checking, so the
     * regression is now a compile error -- and the mutation harness verifies
     * that by expecting the mutated source NOT to compile.
     */
    const added: ResourceRecord[] = [...catalogued.entries()]
      .filter(([key]) => !present.has(key))
      .map(([key, entry]) => ({
        provider: entry.provider,
        model: entry.model,
        key,
        // UNKNOWN, not AVAILABLE: a newly configured resource has never been
        // probed, and seeding it usable would let configuration assert
        // availability, which is the inversion this whole boundary exists to
        // prevent.
        state: "UNKNOWN_FAILURE" as const,
        diagnostic: "newly configured; not probed yet",
        detectedAt: now,
        lastCheckedAt: 0 as typeof now,
        backoff: NO_BACKOFF,
      } satisfies ResourceRecord));

    if (kept.length === state.resources.length && added.length === 0) {
      return state;
    }
    return this.commit(state, { ...state, resources: [...kept, ...added] });
  }

  private async refreshDueResources(state: SupervisorState): Promise<SupervisorState> {
    const now = this.deps.clock.now();
    const refreshed: ResourceRecord[] = [];
    let changed = false;

    for (const record of state.resources) {
      if (!isRetryDue(record, now)) {
        refreshed.push(record);
        continue;
      }
      /**
       * A REFRESH PROBE THAT THROWS IS A CLASSIFICATION, NOT A CRASH (round-7
       * finding 2).
       *
       * Round 3 caught the throw on the immediate pre-launch probe and left this
       * one — the scheduled refresh — uncovered, so a transport failure here
       * killed the whole tick with an uncaught error rather than producing the
       * named, controlled refusal AC-3 requires. The same defect, in the sibling
       * call site nobody looked at.
       *
       * A probe that cannot answer is treated as an UNKNOWN_FAILURE for THAT
       * resource: the ladder backs it off and the rest of the tick proceeds,
       * which is what a per-resource fault should do.
       */
      // Zero-token by contract: ResourceProbe implementations may not invoke a
      // model (see supervisorPorts.ts).
      let classification: Classification;
      try {
        classification = await this.deps.probe.probe(record.provider, record.model);
      } catch (error) {
        classification = {
          state: "UNKNOWN_FAILURE",
          reason: `probe failed for ${record.key}: ${boundedDiagnostic(
            error instanceof Error ? error.message : String(error),
          )}`,
        };
      }
      refreshed.push(this.applyClassification(record, classification, now));
      changed = true;
    }
    return changed ? this.commit(state, { ...state, resources: refreshed }) : state;
  }

  /**
   * Folds one classification into a resource record, advancing or clearing the
   * backoff ladder.
   *
   * A provider-stated reset time always wins over the ladder — that is
   * recovery preference 1 in §6. The ladder is only for the case where nothing
   * told us when to look again.
   */
  private applyClassification(record: ResourceRecord, classification: Classification, now: Timestamp): ResourceRecord {
    /**
     * THE ROW'S DIAGNOSTIC NAMES ITS RESOURCE, HERE (round-13 finding 3).
     *
     * Every row write goes through this function, and this function is handed
     * the record — the one place that always knows the key. Naming at each
     * caller left the immediate-probe path unnamed while the failure path was
     * named, which is the sibling mistake in diagnostic form. Callers pass
     * the RAW classification; the prefix is this function's job alone.
     */
    const diagnostic = boundedDiagnostic(`${record.key}: ${classification.reason}`);

    if (classification.state === "AVAILABLE") {
      return {
        provider: record.provider,
        model: record.model,
        key: record.key,
        state: "AVAILABLE",
        detectedAt: record.state === "AVAILABLE" ? record.detectedAt : now,
        lastCheckedAt: now,
        backoff: NO_BACKOFF,
        lastSuccessAt: now,
        // Observed from the provider, not declared by configuration (NEW-FIN-1).
        ...(classification.billingMode === undefined ? {} : { observedBillingMode: classification.billingMode }),
        diagnostic,
      };
    }

    // AUTH_REQUIRED is human-only: scheduling a retry would poll forever
    // against something no timer can fix.
    if (classification.state === "AUTH_REQUIRED") {
      return {
        provider: record.provider,
        model: record.model,
        key: record.key,
        state: "AUTH_REQUIRED",
        detectedAt: record.state === "AUTH_REQUIRED" ? record.detectedAt : now,
        lastCheckedAt: now,
        backoff: NO_BACKOFF,
        ...(record.lastSuccessAt === undefined ? {} : { lastSuccessAt: record.lastSuccessAt }),
        diagnostic,
      };
    }

    const backoff = nextBackoff(record.backoff);
    const retryAt = classification.retryAt ?? now + backoff.delayMs;
    return {
      provider: record.provider,
      model: record.model,
      key: record.key,
      state: classification.state,
      detectedAt: record.state === classification.state ? record.detectedAt : now,
      lastCheckedAt: now,
      retryAt,
      backoff,
      ...(record.lastSuccessAt === undefined ? {} : { lastSuccessAt: record.lastSuccessAt }),
      diagnostic,
    };
  }

  // =====================================================================
  // Running one roadmap item
  // =====================================================================

  /**
   * Probe ONE resource in this process and observe how it is paid for.
   *
   * EXTRACTED, NOT REWRITTEN (TASK-015 AC-1). The single routed resource and
   * every additional resource a plan declares go through this one function, so
   * "each member gets the same treatment" is a property of there being one
   * implementation rather than a promise about two. Every guard that was inline
   * here is still here: the in-process probe (F4-3), the durable classification,
   * the not-available wait, and the observation bound to its own resource
   * (R10-FIN-1).
   */
  private async probeAndObserve(
    state: SupervisorState,
    item: RoadmapItem,
    provider: string,
    model: string,
  ): Promise<
    | {
        readonly ok: true;
        readonly state: SupervisorState;
        readonly billingMode: BillingMode;
        readonly observation: BillingObservation;
      }
    | { readonly ok: false; readonly state: SupervisorState; readonly result: TickResult }
  > {
    const chosen = resourceKey(provider, model);
    /**
     * A PROBE THAT THROWS IS A REFUSAL, NOT AN ESCAPED EXCEPTION (TASK-015
     * round-1 finding 4).
     *
     * `createCliResourceProbe` throws `ValidationError` for a provider it has no
     * zero-token probe for — correctly, since an unknown provider must not be
     * optimistically assumed usable. Nothing caught it here, and `tick()`
     * rethrows anything that is not a persistence error, so a plan declaring
     * `rogue-provider/m` killed the tick instead of producing the named,
     * controlled, whole-action refusal AC-3 requires.
     *
     * Caught around the probe ALONE rather than around the whole method, so a
     * bug in the classification or commit below still surfaces as itself.
     */
    let confirmation: Classification;
    try {
      confirmation = await this.deps.probe.probe(provider, model);
    } catch (error) {
      const detail = boundedDiagnostic(error instanceof Error ? error.message : String(error));
      const reason = `${chosen} could not be probed before launch: ${detail}`;
      const escalated = await this.escalate(state, item.key, "RECOVERY_REQUIRED", `Investigate ${item.key}: ${reason}`, reason);
      // The ESCALATED state is what this refusal concluded in (round-13
      // finding 2): returning the pre-escalation snapshot handed callers a
      // stale wake basis — behaviourally invisible today, and a violation of
      // the TickOutcome invariant all the same.
      return { ok: false, state: escalated, result: { kind: "RECOVERY_REQUIRED", reason } };
    }
    const now = this.deps.clock.now();
    let next = await this.commit(state, {
      ...state,
      resources: state.resources.map((record) =>
        record.key === chosen ? this.applyClassification(record, confirmation, now) : record,
      ),
    });
    if (confirmation.state !== "AVAILABLE") {
      // It was usable when the schedule was computed and is not usable now.
      // That is ordinary, and it is a wait rather than a failure.
      // F5-SEC-2: `confirmation.reason` is provider text. It is NOT bounded
      // here on purpose — `setStatus` bounds what becomes durable state and
      // `sanitizeTickResult` bounds what the CLI prints, and bounding a third
      // time in the middle made both of those chokepoints untestable: a
      // delete-the-fix run showed the regression still passing with
      // `sanitizeTickResult` removed. A control that cannot be observed to
      // fail is not known to work.
      const reason = `${chosen} was not confirmed available immediately before launch: ${confirmation.reason}`;
      const waiting = await this.commit(next, {
        ...next,
        roadmap: setStatus(next.roadmap, item.key, "WAITING_FOR_RESOURCE", reason),
      });
      const wake = this.computeNextWake(waiting);
      next = await this.commit(waiting, withWake(waiting, wake));
      return {
        ok: false,
        state: next,
        result: {
          kind: "WAITING_FOR_RESOURCE",
          roadmapKey: item.key,
          reason,
          ...(wake === undefined ? {} : { nextWakeAt: wake }),
        },
      };
    }
    const billingMode = this.billingModeFor(confirmation.billingMode, provider, model);
    return {
      ok: true,
      state: next,
      billingMode,
      observation: observeBilling({ provider, model, billingMode }),
    };
  }

  /**
   * Mint the launch action for ONE resource, bind the verdict to it, and gate it.
   *
   * The routed resource and every declared one go through this. That is what
   * makes "the same gate" a fact rather than a claim: there is one place where
   * an AI launch is cleared, so a resource cannot be cleared by a weaker path
   * that someone added later for the additional ones.
   */
  private async gateAiResource(
    state: SupervisorState,
    item: RoadmapItem,
    provider: string,
    model: string,
    observation: BillingObservation | undefined,
    policy: ReturnType<typeof parseFinancialPolicy>,
    reviewer: boolean,
  ): Promise<
    | { readonly ok: true; readonly action: SupervisedAction }
    | { readonly ok: false; readonly state: SupervisorState; readonly result: TickResult }
  > {
    const launching = resourceKey(provider, model);
    const action = launchAiWorkerAction({
      resourceKey: launching,
      // Observed in this process, moments ago (F4-3), and carried as an
      // observation bound to the resource rather than as a bare string that
      // any caller could have written (R10-FIN-1).
      ...(observation === undefined ? {} : { observation }),
      description: `roadmap item ${item.key}: ${item.title}`,
      ...(reviewer ? { reviewer: true } : {}),
    });

    /**
     * F6-FIN-1: the verdict is ABOUT a specific resource, so the thing about to
     * be launched must be that resource. A cleared "included subscription"
     * verdict for one resource is not authorization to run a different one, and
     * before this check nothing compared the two.
     */
    const cleared = mintedResourceKey(action);
    if (!resourceBindingHolds(cleared, launching)) {
      const humanAction = `Investigate ${item.key}: the financial verdict was issued for ${cleared ?? "no resource"} but the launch targets ${launching}.`;
      const escalated = await this.escalate(
        state,
        item.key,
        "RECOVERY_REQUIRED",
        humanAction,
        "the cleared resource and the launched resource disagree",
      );
      return {
        ok: false,
        state: escalated,
        result: { kind: "RECOVERY_REQUIRED", reason: `resource binding mismatch on ${item.key}` },
      };
    }

    const verdict = evaluateFinancialSafety(action, policy);
    if (!verdict.allowed) {
      /**
       * THE REFUSAL NAMES THE RESOURCE (round-10 finding 2).
       *
       * With three declared resources, "the Factory has no autonomous
       * financial authority" told a human that SOMETHING would bill and not
       * WHAT: the failing resource lived only in the action's free-text
       * detail, which the verdict does not carry forward. AC-3 requires a
       * named, controlled refusal, and this call site is the one place that
       * knows the name -- both the routed and the declared paths pass through
       * here, so naming it once here names it everywhere.
       */
      const humanAction = `${verdict.humanActionRequired} Failing resource: ${launching}.`;
      const escalated = await this.escalate(
        state,
        item.key,
        reasonForClass(verdict.actionClass),
        humanAction,
        `${launching}: ${verdict.reason}`,
      );
      return {
        ok: false,
        state: escalated,
        result: {
          kind: "WAITING_FOR_HUMAN",
          roadmapKey: item.key,
          reason: reasonForClass(verdict.actionClass),
          humanActionRequired: humanAction,
        },
      };
    }
    return { ok: true, action };
  }

  private async runItem(state: SupervisorState, item: RoadmapItem): Promise<TickOutcome> {
    /**
     * Rows reaching here are already reconciled against the code catalog by
     * `reconcileResourcesWithCatalog` at the top of the tick (round-8 finding
     * 1), so there is no second filter. A duplicate one would mask a
     * reconciliation regression rather than defend against it -- the sibling
     * problem this task keeps producing.
     */
    const catalogued = new Set(
      this.deps.resourceCatalog.map((entry) => resourceKey(entry.provider, entry.model)),
    );
    const resources = new Map(state.resources.map((record) => [record.key, record]));

    /**
     * ASK WHAT THE WORK NEEDS BEFORE ROUTING ANYTHING FOR IT (round-8 finding 2).
     *
     * The declaration used to be fetched AFTER the routed resource was selected,
     * probed and gated -- so an action whose declared planner, implementer and
     * reviewer were all free was refused because the ROUTED resource, which it
     * would never launch, was USAGE_BILLED. An unused resource blocked the work,
     * and AC-2 says the supervisor authorises exactly the declared set.
     *
     * So the question is asked first. When the work declares its own resources,
     * nothing is routed for it at all: there is no routed resource to probe, to
     * gate, or to refuse on.
     */
    let declaredResources: readonly RequiredResource[] = [];
    try {
      /**
       * READ ONCE, INTO INERT DATA (round-3 finding 3).
       *
       * The declaration is data returned by the executor, and it was validated
       * and then read again -- so a property GETTER could answer `opus` to the
       * validator and `ghost-model` to the authoriser. The reviewer did exactly
       * that and the action advanced on the ghost model.
       *
       * Every field is copied into a plain frozen object here, so validation and
       * use read the same bytes. This is the same discipline `snapshotIdentity`
       * already applies to what a worker CLAIMS: a value that can change between
       * two reads is not evidence.
       */
      const raw = (await this.deps.executor.declareResources?.(deepFreeze(structuredClone({ ...item })))) ?? [];
      declaredResources = deepFreeze(
        [...raw].map((resource) => ({
          role: String(resource.role) as RequiredResource["role"],
          provider: String(resource.provider),
          model: String(resource.model),
          ...(resource.effort === undefined ? {} : { effort: String(resource.effort) }),
        })),
      );
    } catch (error) {
      // A declaration that cannot be produced is not permission to launch with
      // an empty one: the executor was asked what it needs and could not say.
      const detail = boundedDiagnostic(error instanceof Error ? error.message : String(error));
      const escalated = await this.escalate(
        state,
        item.key,
        "RECOVERY_REQUIRED",
        `Investigate ${item.key}: the executor could not state which resources its work would launch.`,
        detail,
      );
      return {
        kind: "CONCLUSION",
        result: { kind: "RECOVERY_REQUIRED", reason: `resource declaration failed for ${item.key}: ${detail}` },
        wakeBasis: escalated,
      };
    }
    const declaresOwnResources = declaredResources.length > 0;

    // ROUTE. Deterministic work needs no AI resource and therefore can never
    // be blocked by a provider limit — that is what keeps a shortage from
    // stopping the whole Factory.
    let config: ReturnType<typeof selectResource> | undefined;
    /**
     * The billing mode used by the gate, OBSERVED IN THIS PROCESS during THIS
     * tick (review finding F4-3, CRITICAL).
     *
     * Round 3 moved billing from configuration to observation, and stored the
     * observation on the resource row. The review then pointed out the obvious
     * remaining step: a row with a fresh-looking `lastCheckedAt` and
     * `observedBillingMode: INCLUDED_SUBSCRIPTION` was trusted without any probe
     * running at all — so the authority for "this costs nothing" was once again a
     * value the system itself writes. The freshness window exists to avoid
     * pointless probing, and that is fine for SCHEDULING; it is not fine as the
     * evidence for a financial decision.
     *
     * So before any AI launch the chosen resource is re-probed here. It is
     * zero-token and local (`claude auth status` / `codex doctor --json`), which
     * is exactly why this is affordable: the persisted mode is a checkpoint, the
     * in-process probe is the authority.
     */
    let confirmedBillingMode: BillingMode = "UNKNOWN";
    /** The same observation, bound to its resource, for the gate (R10-FIN-1). */
    let billingObservation: BillingObservation | undefined;
    if (requiresAi(item.workClass) && !declaresOwnResources) {
      // Only a REVIEW must avoid the implementer; an implementation may of
      // course reuse whatever resource is best.
      const lineage =
        item.workClass === "INDEPENDENT_REVIEW"
          ? this.excludedReviewerResources(state, item)
          : { excluded: [] as readonly string[], ambiguous: [] as readonly string[] };

      /**
       * F5-C4-1: an ancestor that did AI work but recorded no implementer makes
       * the lineage unknowable, and an unknowable lineage cannot be excluded
       * from. C4 is a gate, not a preference — so this waits for a human rather
       * than picking a resource that MIGHT be reviewing its own work.
       */
      if (lineage.ambiguous.length > 0) {
        const humanAction = `Record who implemented ${lineage.ambiguous.join(", ")} before ${item.key} can be independently reviewed; C4 cannot be enforced against an unknown implementer.`;
        const escalated = await this.escalate(
          state,
          item.key,
          "HUMAN_DECISION_REQUIRED",
          humanAction,
          `reviewer independence is unverifiable: no implementer recorded for ${lineage.ambiguous.join(", ")}`,
        );
        return {
          kind: "CONCLUSION",
          result: {
            kind: "WAITING_FOR_HUMAN",
            roadmapKey: item.key,
            reason: "HUMAN_DECISION_REQUIRED",
            humanActionRequired: humanAction,
          },
          wakeBasis: escalated,
        };
      }

      const excluded = lineage.excluded;
      config = selectResource(
        {
          workClass: item.workClass,
          role: item.workClass === "INDEPENDENT_REVIEW" ? "REVIEWER" : "IMPLEMENTER",
          ...(excluded.length === 0 ? {} : { excludeResourceKeys: excluded }),
        },
        this.deps.routingPolicy,
        resources,
      );
      if (!config.ok) {
        if (config.outcome === "REFUSED") {
          const escalated = await this.escalate(
            state,
            item.key,
            "RECOVERY_REQUIRED",
            `Adjust the routing policy so ${item.workClass} has an eligible resource.`,
            config.reason,
          );
          return {
            kind: "CONCLUSION",
            result: { kind: "RECOVERY_REQUIRED", reason: config.reason },
            wakeBasis: escalated,
          };
        }
        // Correct request, nothing usable now. This is NOT a failure.
        const waiting = await this.commit(state, {
          ...state,
          roadmap: setStatus(state.roadmap, item.key, "WAITING_FOR_RESOURCE", config.reason),
        });
        const wake = this.computeNextWake(waiting);
        const settled = await this.commit(waiting, withWake(waiting, wake));
        return {
          kind: "CONCLUSION",
          result: {
            kind: "WAITING_FOR_RESOURCE",
            roadmapKey: item.key,
            reason: config.reason,
            ...(wake === undefined ? {} : { nextWakeAt: wake }),
          },
          wakeBasis: settled,
        };
      }

      // F4-3: confirm the chosen resource NOW, in this process, before the gate.
      const observed = await this.probeAndObserve(state, item, config.option.provider, config.option.model);
      state = observed.state;
      if (!observed.ok) {
        return { kind: "CONCLUSION", result: observed.result, wakeBasis: observed.state };
      }
      confirmedBillingMode = observed.billingMode;
      billingObservation = observed.observation;
    }

    /**
     * DETERMINISTIC work must say what it will do (review finding F5-FIN-3).
     *
     * The review's repro: a deterministic item with NO declared action kinds ran
     * an executor that performed an external side effect, and the gate had only
     * seen `RUN_DETERMINISTIC_WORK`. Declaration was optional, so declaring
     * nothing was the way to be asked nothing.
     *
     * It is now required for this class of work, which turns the F-3 mechanism
     * from opt-in into the price of running at all. Every declared kind still
     * goes through the gate below before the executor is launched.
     *
     * WHAT THIS DOES NOT DO, and where that line has moved.
     *
     * The `WorkExecutor` this service CALLS is still an in-process function, and
     * an in-process function cannot stop code that can already call `fetch`.
     * What this closes is the version of the hole the supervisor CAN close: work
     * that never declared anything and was therefore never asked.
     *
     * Real enforcement — a separate process — is no longer "a later roadmap
     * item". `createIsolatedExecutor` implements the credential-denied form
     * (TASK-011), and since `EXECUTOR_WIRING` production wires
     * `createPlanBackedExecutor`, which runs an approved plan by launching
     * `sf plan resume` as a CHILD PROCESS rather than by calling the engineering
     * loop here. `createUnimplementedExecutor` is gone.
     *
     * That distinction is the whole of the honesty here, and it has narrowed
     * rather than disappeared: the function called in this process can now only
     * read a plan's state and start a child, so the WORK is outside — but what
     * that child does once started, this gate still cannot police.
     */
    if (!requiresAi(item.workClass) && (item.declaredActionKinds ?? []).length === 0) {
      const humanAction = `Declare the action kinds ${item.key} will perform (declaredActionKinds) before it can run; deterministic work that declares nothing cannot be gated.`;
      const escalated = await this.escalate(
        state,
        item.key,
        "HUMAN_DECISION_REQUIRED",
        humanAction,
        "deterministic work must declare its action kinds so every one can be gated before launch",
      );
      return {
        kind: "CONCLUSION",
        result: {
          kind: "WAITING_FOR_HUMAN",
          roadmapKey: item.key,
          reason: "HUMAN_DECISION_REQUIRED",
          humanActionRequired: humanAction,
        },
        wakeBasis: escalated,
      };
    }

    // FINANCIAL SAFETY GATE. Evaluated BEFORE any claim or launch, so a denied
    // action is never attempted and then undone. Note that no actor, token or
    // approval is available to pass here even if one existed.
    //
    // F-2: whether running a model costs money depends on how the chosen
    // RESOURCE is paid for, so the billing mode travels with the action rather
    // than being assumed by its verb.
    //
    // F-3: an item may DECLARE the action kinds its executor will perform, and
    // every one of them is gated here, before the executor is invoked. An
    // executor is trusted code (like a `Worker`), so this cannot police what a
    // malicious one does — but it does mean the supervisor never LAUNCHES an
    // executor whose declared work it would have refused.
    const policy = parseFinancialPolicy(state.financialPolicy);

    /**
     * The DECLARED-KINDS gate runs first, exactly where it ran before the
     * resource gate was extracted. Minting an action has no side effect, so
     * moving the mint below this loop changes nothing an observer can see —
     * and keeping this loop first preserves which refusal wins when both would.
     */
    for (const declared of item.declaredActionKinds ?? []) {
      const declaredVerdict = evaluateFinancialSafety(
        { kind: declared, description: `roadmap item ${item.key} declares action ${declared}` },
        policy,
      );
      if (!declaredVerdict.allowed) {
        const escalated = await this.escalate(
          state,
          item.key,
          reasonForClass(declaredVerdict.actionClass),
          declaredVerdict.humanActionRequired,
          declaredVerdict.reason,
        );
        return {
          kind: "CONCLUSION",
          result: {
            kind: "WAITING_FOR_HUMAN",
            roadmapKey: item.key,
            reason: reasonForClass(declaredVerdict.actionClass),
            humanActionRequired: declaredVerdict.humanActionRequired,
          },
          wakeBasis: escalated,
        };
      }
    }

    /**
     * EVERY OTHER RESOURCE THIS WORK WILL LAUNCH (TASK-015).
     *
     * The routed resource above is one of possibly several. A plan declares a
     * planner, an implementer and a reviewer, and for critical work C4 REQUIRES
     * the reviewer to differ from the implementer — so authorising one resource
     * and launching three was the gap round-3 review found in `EXECUTOR_WIRING`.
     *
     * The executor states what the work needs; the supervisor decides. Each
     * DISTINCT identity is probed and gated by the same two functions the routed
     * resource just used — no shortcut for a sibling that shares a provider, and
     * no member inheriting a verdict from another. Any refusal stops the whole
     * action here, before anything is claimed or launched: there is no partial
     * authorisation and no "run the ones that passed".
     */
    const authorized: AuthorizedResource[] = [];
    let implementerAction: SupervisedAction | undefined;
    let implementerConfig: AiRunConfigRecord | undefined;


    /**
     * A DECLARATION MUST BE UNAMBIGUOUS BEFORE IT IS AUTHORISED (round-2
     * findings 3 and 4).
     *
     * Two ways a well-formed-looking declaration used to produce a broken run:
     *
     *   - ROLES. Settlement picks the entry whose role is `implementer`. A typo,
     *     a missing implementer, or TWO of them meant lineage silently named the
     *     routed resource or the first of two — and the reviewer showed the
     *     consequence: the resource that really implemented was then chosen to
     *     review its own work. C4 broken by a spelling mistake.
     *   - MODELS. The single-resource path validates against `SUPPORTED_MODELS`
     *     when it builds a run configuration. The set path never did, and the
     *     probe is provider-level, so `claude-code/ghost-model` could be
     *     declared, probed, gated and launched. That is strictly weaker than
     *     what existed before this task, which is not an acceptable trade for a
     *     capability.
     *
     * Both refuse the WHOLE action. An ambiguous declaration cannot be repaired
     * by choosing an interpretation, and choosing one is how the C4 hole
     * happened.
     */
    /**
     * A DECLARED RESOURCE MUST BE ONE THIS INSTALLATION HAS (round-5 finding 4).
     *
     * With a catalog holding only `claude-code/opus`, a declared
     * `claude-code/sonnet` was probed, gated, authorised and launched, and no
     * resource record for it existed in durable state at all. TASK-015's frozen
     * OUT OF SCOPE says resources enter through the existing catalog, and a
     * declaration was quietly a second way in.
     *
     * `resources` is the installation's own catalog, reconciled into durable
     * state. A resource absent from it has no availability record, no backoff
     * ladder and no observed billing history — so "the same path the single
     * routed resource goes through" was never true of it.
     */
    /**
     * THE CODE-LEVEL CATALOG, NOT THE PERSISTED ROWS (round-6 finding 1).
     *
     * A declaration naming a resource this installation did not configure was
     * probed, gated, authorised and launched, because this read `state.resources`
     * -- durable state anything with database access can append to. It now uses
     * the same code-level `catalogued` set that bounds routing above, so both
     * doors are anchored in configuration rather than in rows.
     */
    const uncatalogued = declaredResources.find(
      (resource) => !catalogued.has(resourceKey(resource.provider, resource.model)),
    );
    /**
     * SHAPE FIRST, THEN INSTALLATION. A malformed role or an unknown provider is
     * a more specific and more useful diagnosis than "not in the catalog", and
     * putting the catalog check first made a `__proto__` provider refuse for the
     * wrong reason — the same defect this task keeps finding in its own tests,
     * appearing in the production message instead.
     */
    const declarationProblem =
      declaredResources.length === 0
        ? undefined
        : (describeDeclarationProblem(declaredResources) ??
          (uncatalogued === undefined
            ? undefined
            : `resource ${resourceKey(uncatalogued.provider, uncatalogued.model)} is not in this installation's resource catalog`));
    if (declarationProblem !== undefined) {
      const escalated = await this.escalate(
        state,
        item.key,
        "RECOVERY_REQUIRED",
        `Correct the resources ${item.key} declares: ${declarationProblem}`,
        declarationProblem,
      );
      return {
        kind: "CONCLUSION",
        result: {
          kind: "RECOVERY_REQUIRED",
          reason: `${item.key} declared unusable resources: ${declarationProblem}`,
        },
        wakeBasis: escalated,
      };
    }

    for (const required of declaredResources) {
      const identity = resourceIdentity(required);
      const already = authorized.find((entry) => resourceIdentity(entry) === identity);
      if (already !== undefined) {
        /**
         * DEDUPLICATED FOR PROBING, NOT FOR PROVENANCE. Two roles on the same
         * model are one resource to gate and two facts to record, so the second
         * role reuses the first's verdict and observation but keeps its own
         * name. Collapsing them would lose which role ran what.
         */
        authorized.push({ ...required, billingMode: already.billingMode });
        continue;
      }

      const observed = await this.probeAndObserve(state, item, required.provider, required.model);
      state = observed.state;
      if (!observed.ok) {
        return { kind: "CONCLUSION", result: observed.result, wakeBasis: observed.state };
      }
      const gated = await this.gateAiResource(
        state,
        item,
        required.provider,
        required.model,
        observed.observation,
        policy,
        required.role === "reviewer",
      );
      if (!gated.ok) {
        return { kind: "CONCLUSION", result: gated.result, wakeBasis: gated.state };
      }
      /**
       * THE IMPLEMENTER'S CLEARED ACTION IS THE ACTION (round-8 finding 2).
       *
       * When the work declares its own resources nothing is routed for it, so
       * there is no routed action to mint from. The implementer is what performs
       * the work, so its gated action is the one the claim, the action id and
       * provenance are built from -- which also makes them agree with the
       * lineage record, rather than naming a resource nothing launched.
       */
      if (required.role === "implementer") {
        implementerAction = gated.action;
        /**
         * AND ITS RUN CONFIGURATION, because identity reconciliation is built on
         * one. Skipping routing removed the routed `config`, and with it the
         * record `reconcileReportedIdentity` compares a worker's claim against --
         * so an unauthorised reported identity stopped being refused at all. The
         * regression was caught by the control that exists for exactly that.
         *
         * `planAiRunConfig` is the same builder routing uses, so the record has
         * the same shape and the same argv evidence discipline.
         */
        const built = planAiRunConfig({
          // Validated against SUPPORTED_MODELS above, so the narrowing is a
          // restatement of a check already made rather than a new assumption.
          provider: required.provider as keyof typeof SUPPORTED_MODELS,
          model: required.model,
          ...(required.effort === undefined ? {} : { effort: required.effort }),
          role: "IMPLEMENTER",
        });
        if (!built.ok) {
          const escalated = await this.escalate(
            state,
            item.key,
            "RECOVERY_REQUIRED",
            `Correct the implementer declared by ${item.key}: ${built.reason}`,
            built.reason,
          );
          return {
            kind: "CONCLUSION",
            result: {
              kind: "RECOVERY_REQUIRED",
              reason: `${item.key} declared an unconfigurable implementer: ${built.reason}`,
            },
            wakeBasis: escalated,
          };
        }
        implementerConfig = built.value;
      }
      authorized.push({ ...required, billingMode: observed.billingMode });
    }

    /**
     * THE SET IS EXACTLY WHAT THE WORK DECLARED (round-4 finding 2).
     *
     * The routed resource used to be added unconditionally, so a plan-backed
     * action was authorised for FOUR resources when it declared three — and the
     * extra one is never launched, because `PlanBackedExecutor` runs the plan's
     * configuration and not `input.config`. AC-2 says the supervisor authorises
     * exactly the declared set, and "exactly" is the whole point: an authorised
     * resource that nothing runs is a permission granted for no reason.
     *
     * The routed resource is STILL routed, probed, gated and recorded as the
     * action's resource — none of that changed. It is simply not presented to
     * the executor as something it may launch.
     *
     * When the work declares NOTHING, the routed resource is the set, because
     * that is the only resource such an action can use. That path is byte-for-
     * byte what it was before this task.
     */
    if (declaredResources.length === 0 && requiresAi(item.workClass) && config?.ok === true) {
      authorized.push({
        role: ROUTED_ROLE,
        provider: config.option.provider,
        model: config.option.model,
        ...(config.option.effort === undefined ? {} : { effort: config.option.effort }),
        billingMode: confirmedBillingMode,
      });
    }


    let action: SupervisedAction;
    if (requiresAi(item.workClass) && declaresOwnResources) {
      if (implementerAction === undefined) {
        // Unreachable: `describeDeclarationProblem` refuses a declaration that
        // does not name exactly one implementer, so the loop above must have
        // gated one. Stated rather than assumed, because a silent fallback here
        // would mint an action for a resource nothing launched.
        return {
          kind: "CONCLUSION",
          result: {
            kind: "RECOVERY_REQUIRED",
            reason: `${item.key} declared resources but no implementer was gated`,
          },
          wakeBasis: state,
        };
      }
      action = implementerAction;
    } else if (requiresAi(item.workClass) && config?.ok === true) {
      const gated = await this.gateAiResource(
        state,
        item,
        config.option.provider,
        config.option.model,
        billingObservation,
        policy,
        item.workClass === "INDEPENDENT_REVIEW",
      );
      if (!gated.ok) {
        return { kind: "CONCLUSION", result: gated.result, wakeBasis: gated.state };
      }
      action = gated.action;
    } else {
      // F4-4: this authorises invoking the trusted local executor, and says
      // nothing about any command line. A concrete command must be minted by
      // `verificationCommandAction` against the executable allowlist.
      action = { kind: "RUN_DETERMINISTIC_WORK", description: `roadmap item ${item.key}: ${item.title}` };
      const verdict = evaluateFinancialSafety(action, policy);
      if (!verdict.allowed) {
        const escalated = await this.escalate(
          state,
          item.key,
          reasonForClass(verdict.actionClass),
          verdict.humanActionRequired,
          verdict.reason,
        );
        return {
          kind: "CONCLUSION",
          result: {
            kind: "WAITING_FOR_HUMAN",
            roadmapKey: item.key,
            reason: reasonForClass(verdict.actionClass),
            humanActionRequired: verdict.humanActionRequired,
          },
          wakeBasis: escalated,
        };
      }
    }

    // CLAIM before the side effect. The attempt counter lives on the ITEM, so
    // every outcome advances it — including CHANGES_REQUIRED, which writes no
    // checkpoint and therefore used to leave the budget untouched (F-6).
    const attempt = (item.attempts ?? 0) + 1;
    if (attempt > MAX_REMEDIATION_ATTEMPTS) {
      const escalated = await this.escalate(
        state,
        item.key,
        "RECOVERY_REQUIRED",
        `Review roadmap item ${item.key}: it exhausted its ${MAX_REMEDIATION_ATTEMPTS}-attempt remediation budget.`,
        `remediation budget exhausted after ${attempt - 1} attempts`,
      );
      return {
        kind: "CONCLUSION",
        result: { kind: "RECOVERY_REQUIRED", reason: `remediation budget exhausted for ${item.key}` },
        wakeBasis: escalated,
      };
    }

    const actionId = canonicalActionId(item.key, action.kind, attempt);
    const claim: SupervisorActionClaim = {
      actionId,
      roadmapKey: item.key,
      kind: action.kind,
      // The durable in-flight claim names the resource that will actually
      // run: the declared implementer when there is one (round-9 note), else
      // the routed choice. A claim naming a resource nothing launches is a
      // record that is wrong while the work is still in flight.
      ...(implementerConfig !== undefined
        ? { resourceKey: resourceKey(implementerConfig.effectiveProvider, implementerConfig.effectiveModel) }
        : config?.ok === true
          ? { resourceKey: resourceKey(config.option.provider, config.option.model) }
          : {}),
      state: "CLAIMED",
      ownerId: this.ownerId,
      attempt,
      claimedAt: this.deps.clock.now(),
    };
    /**
     * THE DURABLE ACTIVITY, ALONGSIDE THE CLAIM (TASK-018 Part B, round-1
     * CRITICAL).
     *
     * The first version of Part B built `claimActivity`, `reportProgress` and
     * `completeActivity` and then called none of them from here, so a real
     * review or verification process could still die with no lease, no
     * heartbeat, no completion and nothing for reconciliation to find. The
     * mechanism existed and the Factory did not use it, which is worth less
     * than not having built it — it reads as covered.
     *
     * WHY BOTH RECORDS. `activeClaim` answers "what did this supervisor launch
     * and must it be reconciled", and it is singular by design. The activity
     * answers "is a process still working on this, and what did it end up
     * doing", survives the supervisor itself, and is one of several. Neither
     * replaces the other, and `activeClaim` is untouched.
     */
    const activityId = canonicalActivityId(item.key, action.kind, attempt);
    const probe = this.livenessProbe();
    const leaseSource = this.deps.activityLease;
    const lease = leaseSource?.(this.deps.clock.now());

    /**
     * A CONFIGURED INSTALLATION THAT CANNOT IDENTIFY ITSELF MUST NOT RUN
     * (round-2 review, CRITICAL).
     *
     * The first version guarded every activity write with
     * `lease !== undefined && probe !== undefined`, which reads as caution and
     * is the exact opposite. When `leaseForThisProcess` could not read
     * `/proc/<pid>/stat` it returned undefined, and the supervisor then ran the
     * work, completed it, and marked the item DONE with no activity, no lease
     * and nothing for reconciliation to find. Unknown liveness RAN THE WORK.
     * That is fail-open in a codebase whose whole discipline is the reverse.
     *
     * The distinction that matters is between an installation that does not
     * record activities at all — no probe and no lease source, which is how the
     * demo and most fixtures are built — and one that is configured to and
     * cannot. The first is a choice; the second is an unknown, and every
     * unknown here refuses.
     */
    /**
     * HALF-CONFIGURED IS ALSO AN UNKNOWN (round-4 review, HIGH 1).
     *
     * The first fix asked for BOTH dependencies and treated anything else as
     * "this installation does not record activities" — so supplying a real
     * liveness probe and no lease source ran the work, returned ADVANCED, and
     * marked the item DONE with zero activities. Fail-open again, one step
     * further out: I closed "configured and cannot" and left "configured by
     * halves" wide open.
     *
     * EITHER dependency present means somebody INTENDED this installation to
     * record activities. Neither is a choice; one is a misconfiguration, and a
     * misconfiguration is not a licence to run unobserved.
     */
    const intendsActivities = probe !== undefined || leaseSource !== undefined;
    const recordsActivities = probe !== undefined && leaseSource !== undefined;
    if (intendsActivities && !recordsActivities) {
      const missing = probe === undefined ? "a liveness probe" : "a lease source";
      const problem =
        `this supervisor is configured to record activities but has no ${missing}, so work on ${item.key} could ` +
        "not be reconciled by anything; refusing to run it";
      this.log(`[supervisor] ${problem}`);
      return {
        kind: "CONCLUSION",
        result: {
          kind: "WAITING_FOR_HUMAN",
          roadmapKey: item.key,
          reason: "HUMAN_DECISION_REQUIRED",
          humanActionRequired: boundedDiagnostic(problem),
        },
        wakeBasis: state,
      };
    }
    if (recordsActivities && lease === undefined) {
      const problem =
        `this supervisor cannot establish its own process identity, so it cannot take a lease on ${item.key}; ` +
        "refusing to run work that nothing could later reconcile";
      this.log(`[supervisor] ${problem}`);
      return {
        kind: "CONCLUSION",
        result: {
          kind: "WAITING_FOR_HUMAN",
          roadmapKey: item.key,
          reason: "HUMAN_DECISION_REQUIRED",
          humanActionRequired: boundedDiagnostic(problem),
        },
        wakeBasis: state,
      };
    }

    let activities = state.activities ?? [];

    if (lease !== undefined && probe !== undefined) {
      const claimedActivity = claimActivity(
        activities,
        { id: activityId, kind: action.kind, roadmapKey: item.key, lease, now: this.deps.clock.now() },
        probe,
      );
      if (!claimedActivity.ok) {
        /**
         * Something else owns this, or ownership cannot be established. Either
         * way this supervisor must not start a second one beside it — that is
         * the duplicate-owner state AC-13 exists to make impossible, and the
         * refusal names who holds it.
         */
        this.log(`[supervisor] not starting ${item.key}: ${claimedActivity.problem}`);
        return {
          kind: "CONCLUSION",
          result: {
            kind: "WAITING_FOR_RESOURCE",
            roadmapKey: item.key,
            reason: boundedDiagnostic(claimedActivity.problem),
          },
          wakeBasis: state,
        };
      }
      activities = claimedActivity.activities;
    }

    /**
     * A LOST RACE MUST STILL NAME THE WINNER (round-1 HIGH 5).
     *
     * Two supervisors evaluating the claim against the same snapshot both see a
     * free activity; one commits and the other's CAS fails. The loser used to
     * surface that as a bare `ConcurrencyError` — technically accurate, and it
     * tells an operator nothing about who is running the work, which is what
     * AC-13 requires the refusal to say.
     *
     * So a conflict is not the answer: it is the signal to look again. The
     * state is re-read and the claim re-evaluated against what actually
     * happened, and the winner's lease then produces the ordinary
     * "held by pid N on M, which is still running" refusal. Bounded, because a
     * loop that retries forever is a hang with good intentions.
     */
    let claimed: SupervisorState;
    try {
      claimed = await this.commit(state, {
        ...state,
        activeClaim: claim,
        activities,
        roadmap: setAttempts(setStatus(state.roadmap, item.key, "ACTIVE"), item.key, attempt),
      });
    } catch (error) {
      if (!(error instanceof ConcurrencyError) || lease === undefined || probe === undefined) {
        throw error;
      }
      const fresh = await this.deps.repository.load();
      const recheck =
        fresh === undefined
          ? undefined
          : claimActivity(
              fresh.activities ?? [],
              { id: activityId, kind: action.kind, roadmapKey: item.key, lease, now: this.deps.clock.now() },
              probe,
            );
      const problem =
        recheck !== undefined && !recheck.ok
          ? recheck.problem
          : `another supervisor changed ${item.key} while this one was claiming it`;
      this.log(`[supervisor] lost the race for ${item.key}: ${problem}`);
      return {
        kind: "CONCLUSION",
        result: { kind: "WAITING_FOR_RESOURCE", roadmapKey: item.key, reason: boundedDiagnostic(problem) },
        wakeBasis: state,
      };
    }

    // Second durable write: from here the launch may have happened, and the
    // activity says so too — a heartbeat before the launch is what separates
    // "claimed and never started" from "started and stopped reporting".
    /**
     * THE LAUNCH WRITE IS RETRIED TOO (round-6 review, HIGH 3).
     *
     * This used a raw commit, so another supervisor writing between the claim
     * and the heartbeat made `tick()` THROW — leaving the activity CLAIMED, the
     * claim CLAIMED and the item ACTIVE, with nothing having run and no
     * decision recorded. The retry existed and was wired only to the
     * completion; contention does not respect which write we happened to
     * harden first.
     *
     * The heartbeat and the claim's CLAIMED -> RUNNING transition travel
     * together: one without the other is a state that means nothing.
     */
    let running = claimed;
    if (lease === undefined || probe === undefined) {
      running = await this.commit(claimed, { ...claimed, activeClaim: { ...claim, state: "RUNNING" } });
    } else {
      const launched = await this.commitActivityChange(
        claimed,
        `record the launch of ${activityId}`,
        (activities) => reportProgress(activities, activityId, { at: this.deps.clock.now(), progress: 1 }, lease),
        (fresh) => {
          /**
           * The claim that is DURABLE right now, not the one read at the top of
           * the tick. If it is not ours any more, this supervisor has already
           * been displaced and must not launch — writing the old claim back
           * would displace whoever took it, which is the duplicate-owner state
           * this whole mechanism refuses.
           */
          const durable = fresh.activeClaim;
          if (durable === undefined) {
            return { ok: false, problem: `the claim on ${item.key} is no longer in durable state` };
          }
          if (durable.actionId !== claim.actionId) {
            return {
              ok: false,
              problem: `durable state now holds claim ${durable.actionId}, not ${claim.actionId}`,
            };
          }
          return { ok: true, patch: { activeClaim: { ...durable, state: "RUNNING" } } };
        },
      );
      if (!launched.recorded) {
        const problem =
          `${item.key} could not record that its work had started (${launched.problem ?? "unknown reason"}); ` +
          "refusing to launch work whose start nothing would know about";
        this.log(`[supervisor] ${problem}`);
        return {
          kind: "CONCLUSION",
          result: {
            kind: "WAITING_FOR_HUMAN",
            roadmapKey: item.key,
            reason: "HUMAN_DECISION_REQUIRED",
            humanActionRequired: boundedDiagnostic(problem),
          },
          wakeBasis: launched.state,
        };
      }
      running = launched.state;
    }

    /**
     * Resuming a checkpoint (F5-RESUME-1).
     *
     * The checkpoint was written under a PREVIOUS attempt's action id, and this
     * is a new attempt, so the two never match. `SessionCheckpoint.actionId`
     * claimed to "prevent cross-action resume" and nothing enforced it — a
     * documented guarantee the code did not provide, which is worse than no
     * guarantee.
     *
     * Continuing the same item under a new attempt IS what session rollover
     * means, so the answer is not to refuse; it is to say what actually holds.
     * The checkpoint must belong to THIS ROADMAP ITEM — that is the property
     * worth enforcing, and a mismatch is corruption rather than a rollover — and
     * it is then explicitly REBOUND to the action now running, so the record and
     * reality agree. A checkpoint that still names a1 while a2 executes is the
     * derived-identity-disagreeing-with-reality failure TASK-004 round 2
     * forbade.
     */
    const stored = running.checkpoints.find((entry) => entry.roadmapKey === item.key);
    if (stored !== undefined && stored.roadmapKey !== item.key) {
      const escalated = await this.escalate(
        running,
        item.key,
        "RECOVERY_REQUIRED",
        `Investigate ${item.key}: its checkpoint belongs to a different roadmap item.`,
        `checkpoint roadmapKey ${stored.roadmapKey} does not match ${item.key}`,
      );
      return {
        kind: "CONCLUSION",
        result: { kind: "RECOVERY_REQUIRED", reason: `checkpoint identity mismatch on ${item.key}` },
        wakeBasis: escalated,
      };
    }
    const checkpoint =
      stored === undefined ? undefined : { ...stored, actionId, resumedFromActionId: stored.actionId };

    /**
     * The executor gets a DEEP-FROZEN snapshot, and everything the supervisor
     * needs afterwards is captured BEFORE the call (review finding R7-SEC-1).
     *
     * The in-memory repository happened to return frozen state and the SQLite
     * one did not, so production had a hole the tests could not see: an executor
     * could mutate `input.item` in place and the supervisor would then settle
     * against the mutated object. Changing `item.key` from A to B marked B DONE
     * while A stayed ACTIVE; writing a token into `declaredActionKinds[0]`
     * persisted it unredacted.
     *
     * TWO LAYERS, and an honest account of what each is worth — because the
     * first version of this comment claimed "two independent fixes", the eighth
     * review showed the settlement capture was untested (it was the SAME object
     * handed to the executor), and the obvious repair then over-claimed again.
     *
     *   1. The executor's copy is deep-frozen. This is the load-bearing control:
     *      remove it and regressions fail.
     *   2. Settlement reads a SEPARATE clone the executor never received. This
     *      is defence in depth, and it is honestly NOT independently observable
     *      while layer 1 holds — a frozen object cannot be mutated, so there is
     *      nothing for the separation to protect against. Removing both
     *      together does fail (measured), which is the accurate claim: layer 2
     *      matters only if layer 1 is ever weakened.
     *
     * Stated this way because "defence in depth" is a real reason to keep code
     * and a bad excuse for asserting two controls were verified when one was.
     *
     * "The tests use a stricter substitute than production" is the same shape as
     * TASK-005 round 3, and the answer is the same: make production strict.
     */
    const settleItem = deepFreeze(structuredClone({ ...item }));
    let outcome: WorkOutcome;
    try {
      outcome = await this.deps.executor.execute(
        deepFreeze({
          // A SEPARATE clone from `settleItem` — see above.
          item: structuredClone({ ...item }),
          actionId,
          ...(implementerConfig !== undefined
            ? { config: implementerConfig }
            : config?.ok === true
              ? { config: config.config }
              : {}),
          // TASK-015: the exact set, so the executor can refuse to launch
          // anything outside it at the last point before it launches.
          ...(authorized.length === 0 ? {} : { authorizedResources: authorized }),
          ...(checkpoint === undefined ? {} : { checkpoint }),
        }),
      );
    } catch (error) {
      outcome = {
        kind: "RESOURCE_FAILURE",
        process: {
          terminationReason: "SPAWN_ERROR",
          exitCode: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        },
      };
    }

    /**
     * THE COMPLETION EVENT (AC-15), written before anything else settles.
     *
     * This is the record that makes "the result has existed for hours and
     * nobody noticed" impossible: it is durable, it names the outcome, and
     * `unobservedCompletions` reads it out of the database without anything
     * having to be told. A FAILED outcome is recorded just as a passing one is,
     * because a failure nobody noticed is the same problem.
     */
    const completion = {
      outcome: outcome.kind,
      detail: boundedDiagnostic(`${item.key} ${action.kind} attempt ${attempt}`),
      at: this.deps.clock.now(),
    };
    let finished = running;
    if (lease !== undefined && probe !== undefined) {
      const written = await this.commitActivityChange(
        running,
        `record the completion of ${activityId}`,
        (activities) =>
          completeActivity(activities, activityId, {
            state: outcome.kind === "COMPLETED" ? "COMPLETED" : "FAILED",
            completion,
            holder: lease,
          }),
      );
      if (!written.recorded) {
        /**
         * THE OUTCOME IS NOT SETTLED IF IT COULD NOT BE RECORDED (round-5
         * review, HIGH 2). Settling here would drive the item to DONE with an
         * activity still RUNNING and no completion — a completion nothing
         * durable accounts for. A human is told instead, and the outcome is
         * reported rather than applied.
         */
        const problem =
          `${item.key} ${action.kind} finished as ${outcome.kind}, and its completion could not be recorded ` +
          `(${written.problem ?? "unknown reason"}); the outcome is NOT being applied`;
        this.log(`[supervisor] ${problem}`);
        return {
          kind: "CONCLUSION",
          result: {
            kind: "WAITING_FOR_HUMAN",
            roadmapKey: item.key,
            reason: "HUMAN_DECISION_REQUIRED",
            humanActionRequired: boundedDiagnostic(problem),
          },
          wakeBasis: written.state,
        };
      }
      finished = written.state;
    }

    return this.settle(
      finished,
      // R7-SEC-1: the snapshot this function captured, never whatever the
      // executor may have left behind in the object it was handed.
      settleItem,
      actionId,
      outcome,
      implementerConfig !== undefined
        ? resourceKey(implementerConfig.effectiveProvider, implementerConfig.effectiveModel)
        : config?.ok === true
          ? resourceKey(config.option.provider, config.option.model)
          : undefined,
      implementerConfig ?? (config?.ok === true ? config.config : undefined),
      authorized,
    );
  }

  // =====================================================================
  // Settling an outcome
  // =====================================================================

  private async settle(
    state: SupervisorState,
    item: RoadmapItem,
    actionId: string,
    outcome: WorkOutcome,
    usedResourceKey: string | undefined,
    runConfig: AiRunConfigRecord | undefined,
    authorized: readonly AuthorizedResource[] = [],
  ): Promise<TickOutcome> {
    const now = this.deps.clock.now();
    const { activeClaim: _dropped, ...withoutClaim } = state;
    void _dropped;

    /**
     * F4-9: reconcile what the provider CLAIMS it ran against what was
     * requested, and record the outcome durably on the item.
     *
     * A `MISMATCH` is not a detail to note and move past. The supervisor's whole
     * contract about model enforcement is that a run happens with the model and
     * effort that were authorized; a worker that reports having used something
     * else has broken that contract, and accepting its COMPLETED would be
     * self-certification (C5) with extra steps.
     */
    // R8-ID-1: read the worker's claim exactly once, into inert data. Every
    // later use — validity, reconciliation, persistence — reads the snapshot.
    const reported = snapshotIdentity(
      outcome.kind === "COMPLETED" || outcome.kind === "CHECKPOINT" ? outcome.reportedIdentity : undefined,
    );
    /**
     * RECONCILED AGAINST THE SET, NOT THE SINGLETON (TASK-015 round-1 finding 2).
     *
     * `reconcileReportedIdentity` compares a report to ONE record. With a set,
     * an executor that ran an authorised NON-ROUTED member — a plan's reviewer,
     * say — reported the exact truth and was refused as a mismatch, which is the
     * old single-resource behaviour surviving into a multi-resource world.
     *
     * The fix is to pick the BASIS the report names, then let the existing
     * reconciliation do its unchanged job: partial evidence is still not proof,
     * a contradicted effort is still a MISMATCH, and a report naming NOTHING in
     * the set still falls through to the routed record and is refused. Only the
     * question "which record is this report about?" changed.
     *
     * `argvEvidence` is deliberately EMPTIED for a non-routed member rather than
     * carried over: the routed argv describes a different launch, and attaching
     * it to another resource would be evidence about a run that did not happen.
     */
    /**
     * EFFORT IS PART OF MEMBERSHIP HERE TOO (round-2 finding 2).
     *
     * Authorisation membership is provider/model/EFFORT, and this lookup
     * compared only provider and model — so with `routed claude-code/sonnet` and
     * `implementer claude-code/sonnet:high` both authorised, a worker reporting
     * `sonnet:high` matched the ROUTED entry, was reconciled against a record
     * that requested no effort, and was refused with "reported effort high but
     * none was requested". An authorised member, refused.
     *
     * An EXACT match wins. A report that states no effort may still match an
     * entry that names none; a report that states one only matches an entry that
     * names the same one. Anything else finds no member and falls through to the
     * routed record, which refuses — the fail-closed direction.
     */
    const member =
      reported === undefined
        ? undefined
        : authorized.find(
            (entry) =>
              entry.provider === reported.provider &&
              entry.model === reported.model &&
              entry.effort === reported.effort,
          );
    /**
     * WHAT RAN IS THE IMPLEMENTER, AND `lastRunConfig` MUST SAY SO (round-3
     * finding 4).
     *
     * `excludedReviewerResources` reads BOTH the implementer history and
     * `lastRunConfig`, and stops when they disagree — correctly, because a row
     * naming Claude while the run configuration names Codex is exactly the
     * tampering that guard exists to catch.
     *
     * Round-1 fixed the history to name the implementer and left `lastRunConfig`
     * naming the ROUTED resource, so the two now disagreed BY DESIGN. The
     * reviewer drove the consequence out: the next dependent independent review
     * reported "unknown implementer" and refused to launch at all. A C4 gate
     * that blocks every review is no better than one that permits the wrong
     * reviewer.
     *
     * So when a declaration names an implementer, THAT is the record of what
     * ran. An action that declares nothing keeps the routed record untouched,
     * with its real `argvEvidence` — the round-4 regression pins that.
     */
    const implementerMember = authorized.find((entry) => entry.role === "implementer");
    /**
     * BUILT FIELD BY FIELD, NOT SPREAD (round-4 finding 3, second half).
     *
     * Spreading `runConfig` and conditionally overriding effort LEFT THE ROUTED
     * EFFORT IN PLACE when the member declares none: routed `opus:high` plus a
     * declared implementer `opus` at the provider default produced a record
     * claiming `effectiveEffort: "high"` for a run that requested no effort at
     * all. A record that keeps a field from a different resource is a record
     * that describes a run nobody performed.
     */
    const asRecord = (entry: AuthorizedResource, why: string): AiRunConfigRecord | undefined => {
      if (runConfig === undefined) {
        return undefined;
      }
      return {
        requestedProvider: entry.provider,
        requestedModel: entry.model,
        ...(entry.effort === undefined ? {} : { requestedEffort: entry.effort }),
        effectiveProvider: entry.provider,
        effectiveModel: entry.model,
        ...(entry.effort === undefined ? {} : { effectiveEffort: entry.effort }),
        verification: runConfig.verification,
        // Never the routed argv: it describes a different launch, and attaching
        // it here would be evidence about a run that did not happen.
        argvEvidence: [],
        note: `${runConfig.note}; ${why}`,
      };
    };

    const implementerBasis =
      implementerMember === undefined
        ? runConfig
        : asRecord(implementerMember, "recorded against the declared implementer");

    const sameAsBasis = (entry: AuthorizedResource, record: AiRunConfigRecord | undefined): boolean =>
      record !== undefined &&
      entry.provider === record.effectiveProvider &&
      entry.model === record.effectiveModel &&
      entry.effort === record.effectiveEffort;

    /**
     * THE MEMBER BASIS IS BUILT FIELD BY FIELD TOO (round-9 finding 4).
     *
     * This branch SPREAD `runConfig` and overrode fields conditionally -- so
     * when the member named no effort, the implementer's effort survived the
     * spread into the member's record. That inheritance is the same defect
     * round 4 fixed in `asRecord`, in the sibling branch; and it MASKED the
     * effort-membership term: with the term deleted, a report matched the
     * effortless planner first, yet the inherited effort made reconciliation
     * appear to agree. The reviewer's compiled mutation survived on exactly
     * that. `asRecord` inherits nothing, so the mutation now dies.
     */
    const basis =
      runConfig === undefined || member === undefined || sameAsBasis(member, implementerBasis)
        ? implementerBasis
        : asRecord(member, `reconciled against the authorised ${member.role} resource`);
    const reconciled =
      basis === undefined
        ? undefined
        : reported === undefined || Object.keys(reported).length === 0
          ? basis
          : reconcileReportedIdentity(basis, reported);
    /**
     * LINEAGE IS RECORDED ONCE, HERE (round-9 HIGH).
     *
     * Rounds 8 and 9 each found paths that ran a worker and recorded nothing:
     * round 8 found `CHECKPOINT` and `RESOURCE_FAILURE`, and round 9 found
     * `HUMAN_REQUIRED`, the unverified-`COMPLETED` refusal and the
     * mismatched-identity refusal — plus `lastRunConfig` missing from the two
     * paths round 8 had just fixed.
     *
     * That is not five bugs; it is one. Recording lineage inside each outcome
     * branch means every new branch is a fresh opportunity to forget, and the
     * reviewer will keep finding the ones that did. So it happens BEFORE the
     * branches, on the single fact that decides it: a worker RAN.
     *
     * Everything below builds on `withLineage`, so a future branch cannot omit
     * it by being written — only by deliberately reaching past it.
     *
     * Both helpers are no-ops when no resource was used, so DETERMINISTIC work
     * is unaffected.
     */
    /**
     * LINEAGE MUST NAME THE RESOURCE THAT IMPLEMENTED (TASK-015 round-1
     * finding 1, CRITICAL).
     *
     * This recorded the ROUTED resource, which for a plan-backed action is
     * whatever the router happened to pick — not the model that did the work.
     * Independent review authorised planner `claude-code/sonnet`, implementer
     * `claude-code/opus` and reviewer `codex-cli/gpt-5.6-luna`, and the durable
     * record said `IMPLEMENTED_BY claude-code:sonnet`.
     *
     * That is not merely incomplete evidence. `excludedReviewerResources` reads
     * this chain to keep an implementer from reviewing its own work, so a wrong
     * name excludes an innocent resource AND LEAVES THE REAL IMPLEMENTER FREE TO
     * REVIEW ITSELF. C4 is a gate, and this turned it into a coin toss.
     *
     * The implementer ROLE is the answer when the work declared one; the routed
     * resource remains correct when it did not, which is every action that
     * declares nothing.
     */
    const implementerResourceKey =
      authorized.find((entry) => entry.role === "implementer") === undefined
        ? usedResourceKey
        : resourceKey(
            authorized.find((entry) => entry.role === "implementer")!.provider,
            authorized.find((entry) => entry.role === "implementer")!.model,
          );

    /**
     * AC-5: the WHOLE authorised set is recorded, and it is recorded in the
     * entry's DETAIL rather than as additional `IMPLEMENTED_BY` entries.
     *
     * One entry per resource would be a tidier shape and a worse record: this
     * chain means "X implemented Y", and adding the reviewer's resource to it
     * would later exclude that reviewer from reviewing anything — inventing the
     * very C4 failure the finding above describes, from the opposite direction.
     */
    const authorizedDetail =
      authorized.length === 0
        ? ""
        : `; authorised ${authorized
            .map((entry) => `${entry.role}=${entry.provider}/${entry.model}${entry.effort === undefined ? "" : `:${entry.effort}`}`)
            .join(", ")}`;

    const lineageProvenance = appendImplementerProvenance(
      state.provenance,
      item.key,
      implementerResourceKey,
      now,
      `${LINEAGE_DETAIL[outcome.kind]}${authorizedDetail}`,
    );
    const withLineage: SupervisorState = {
      ...withoutClaim,
      /**
       * TWO DIFFERENT QUESTIONS, TWO DIFFERENT RECORDS (round-4 finding 3).
       *
       * `reconciled` answers "is what the worker REPORTED consistent with what
       * it was allowed to run?" — so it must be compared against whichever
       * authorised member the report names, or an honest reviewer reporting
       * itself is refused.
       *
       * `lastRunConfig` answers "what IMPLEMENTED this item?" — and
       * `excludedReviewerResources` reads it alongside the implementer history
       * to keep an implementer from reviewing its own work. Round 3 let the
       * reconciliation basis flow into this record, so a run whose REVIEWER
       * reported itself persisted the reviewer as what ran, the two records
       * disagreed, and every dependent review was blocked again.
       *
       * They are now written from their own answers: the implementer record when
       * a declaration named one, and the reconciled record otherwise.
       */
      roadmap: setRunConfig(
        setImplementer(state.roadmap, item.key, implementerResourceKey),
        item.key,
        implementerMember === undefined ? reconciled : implementerBasis,
      ),
      provenance: lineageProvenance,
      // An anchor is written with EVERY chain, so that its absence is a
      // detectable deletion rather than a permitted state (round-9 CRITICAL).
      provenanceAnchor: anchorFor(lineageProvenance),
    };

    if (reconciled?.verification === "MISMATCH") {
      const escalated = await this.escalate(
        withLineage,
        item.key,
        "RECOVERY_REQUIRED",
        `Investigate ${item.key}: the worker reported running a different model/effort than was authorized. ${reconciled.note}`,
        reconciled.note,
      );
      return {
        kind: "CONCLUSION",
        result: {
          kind: "RECOVERY_REQUIRED",
          reason: `run configuration mismatch on ${item.key}: ${reconciled.note}`,
        },
        wakeBasis: escalated,
      };
    }

    /**
     * F6-ID-1: an AI run that reports NO identity at all cannot be accepted as
     * complete.
     *
     * `UNVERIFIED` is the honest label for "the provider did not say", and
     * marking an item DONE on that basis is the same mistake NEW-MODEL-1 made
     * with model names: an honest label for missing evidence is not a licence to
     * proceed as though the evidence existed. A worker that will not say what it
     * ran has not demonstrated that it ran what was authorized.
     *
     * NOT CLOSED by this, and said plainly: the report is an executor CLAIM, not
     * proof. Proof needs evidence bound to the launched process.
     *
     * NARROWED BY TASK-011 (EXECUTOR_ISOLATION): the executor is now a process
     * the supervisor owns and constrains, and everything it says is parsed as
     * untrusted data rather than believed. That removes the ambient capability
     * behind F5-FIN-3/F6-FIN-2 — a child holds no credential store, so it
     * cannot launch a provider at all.
     *
     * What is STILL a claim is the identity a worker reports about a run the
     * supervisor itself launched. Isolation does not make a claim true; binding
     * it to process-level evidence would, and nothing does that today.
     */
    if (outcome.kind === "COMPLETED" && runConfig !== undefined && !statesItsIdentity(reported)) {
      const humanAction = `Investigate ${item.key}: the worker reported COMPLETED without stating which provider/model it ran, so the authorized configuration cannot be confirmed.`;
      const escalated = await this.escalate(
        withLineage,
        item.key,
        "RECOVERY_REQUIRED",
        humanAction,
        "AI work completed without a reported run identity",
      );
      return {
        kind: "CONCLUSION",
        result: { kind: "RECOVERY_REQUIRED", reason: `unverified completion on ${item.key}` },
        wakeBasis: escalated,
      };
    }

    switch (outcome.kind) {
      case "COMPLETED": {
        // NEW-SEC-1: `outcome.detail` is executor text. It is sanitized once,
        // here, and the SAME sanitized value is what becomes durable state and
        // what is returned to the caller — a `TickResult` is printed by the
        // CLI, and a console is a log is durable state with a different name.
        const detail = boundedDiagnostic(outcome.detail);
        // N-2: the identity of whoever did the work outlives the item, so a
        // later review of anything depending on it can exclude them.
        const next = await this.commit(state, {
          ...withLineage,
          roadmap: recomputeEligibility(setStatus(withLineage.roadmap, item.key, "DONE", detail)),
          checkpoints: state.checkpoints.filter((entry) => entry.roadmapKey !== item.key),
          resources: markSuccess(state.resources, usedResourceKey, now),
        });
        this.log(`[supervisor] ${item.key} completed; dependents re-evaluated`);
        return {
          kind: "CONCLUSION",
          result: { kind: "ADVANCED", roadmapKey: item.key, actionId, detail },
          wakeBasis: next,
        };
      }

      case "CHANGES_REQUIRED": {
        // Remediation is ordinary progress, not an escalation: the item goes
        // back to ELIGIBLE and the next tick picks it up. No human is asked.
        const detail = boundedDiagnostic(
          `independent review returned CHANGES_REQUIRED: ${outcome.findings.join("; ")}`,
        );
        const next = await this.commit(state, {
          ...withLineage,
          roadmap: setStatus(withLineage.roadmap, item.key, "ELIGIBLE", detail),
          resources: markSuccess(state.resources, usedResourceKey, now),
        });
        return {
          kind: "CONCLUSION",
          result: { kind: "ADVANCED", roadmapKey: item.key, actionId, detail },
          wakeBasis: next,
        };
      }

      case "CHECKPOINT": {
        // What THIS supervisor was resuming, read from its own durable state.
        const previousCheckpointActionId = state.checkpoints.find(
          (entry) => entry.roadmapKey === item.key,
        )?.actionId;
        // Session rollover, NOT quota exhaustion: the resource is fine, the
        // conversation is full. Persist and continue on the next tick.
        //
        // F-5 (HIGH): `actionId` and `roadmapKey` are stamped by the SUPERVISOR
        // from the action that actually ran, overriding whatever the executor
        // supplied. Previously a checkpoint could name action a1 while the next
        // attempt ran as a2, so the record described a different action from
        // the one it belonged to — and a derived identity that disagrees with
        // reality is exactly what TASK-004 round 2 forbade.
        const detail = boundedDiagnostic(outcome.detail);
        const next = await this.commit(state, {
          ...withLineage,
          roadmap: setStatus(withLineage.roadmap, item.key, "ELIGIBLE", detail),
          // NEW-SEC-1: a checkpoint's text comes from an executor, so it is
          // bounded and redacted like every other untrusted string before it
          // becomes durable state. "Bounded checkpoint" was the design claim;
          // this is what makes it true rather than aspirational.
          checkpoints: upsertCheckpoint(state.checkpoints, {
            ...sanitizeCheckpoint({
              ...outcome.checkpoint,
              roadmapKey: item.key,
              actionId,
              updatedAt: now,
            }),
            // F6-RESUME-1: provenance is DERIVED from the checkpoint this
            // supervisor was actually resuming, never from what the executor
            // handed back — `sanitizeCheckpoint` drops the executor's copy for
            // exactly this reason. A forgeable audit trail is worse than none,
            // because it is believed.
            ...(previousCheckpointActionId === undefined || previousCheckpointActionId === actionId
              ? {}
              : { resumedFromActionId: previousCheckpointActionId }),
          }),
          resources: markSuccess(state.resources, usedResourceKey, now),
        });
        this.log(`[supervisor] ${item.key} rolled over to a new session: ${detail}`);
        return {
          kind: "CONCLUSION",
          result: { kind: "ADVANCED", roadmapKey: item.key, actionId, detail },
          wakeBasis: next,
        };
      }

      case "HUMAN_REQUIRED": {
        // Re-derived through the same gate rather than trusted from the
        // executor: an executor claiming an action is safe cannot make it so.
        const verdict = evaluateFinancialSafety(outcome.action, parseFinancialPolicy(state.financialPolicy));
        // An allowed action that still needs a person is a DECISION, not a
        // failure and not a transaction — see HUMAN_DECISION_REQUIRED.
        // NEW-SEC-1: `action.description` is executor text on this path, and
        // the returned `TickResult` is printed. Sanitized once, used for both.
        const humanAction = boundedDiagnostic(
          verdict.allowed ? `Perform: ${outcome.action.description}` : verdict.humanActionRequired,
        );
        const reason: EscalationReason = verdict.allowed
          ? "HUMAN_DECISION_REQUIRED"
          : reasonForClass(verdict.actionClass);
        const escalated = await this.escalate(withLineage, item.key, reason, humanAction, outcome.detail);
        return {
          kind: "CONCLUSION",
          result: { kind: "WAITING_FOR_HUMAN", roadmapKey: item.key, reason, humanActionRequired: humanAction },
          wakeBasis: escalated,
        };
      }

      case "RESOURCE_FAILURE": {
        // The SUPERVISOR classifies; the executor only reports facts.
        const classification = classifyOutcome(outcome);
        /**
         * THE FAILURE NAMES ITS RESOURCE, ONCE, WHERE IT IS CLASSIFIED
         * (round-11 finding 2). "provider CLI exited 1 with no recognised
         * failure signature" reached the tick result, the roadmap detail and
         * the resource diagnostic with the resource's key in NONE of them —
         * which CLI failed was the one fact an operator needed. Named here so
         * the result, roadmap and escalation sinks below inherit it. The
         * resource ROW takes the raw classification: `applyClassification`
         * prefixes the row's own key itself (round-13 finding 3), so passing
         * the named copy would print the key twice.
         */
        const named = {
          ...classification,
          reason:
            usedResourceKey === undefined
              ? classification.reason
              : `${usedResourceKey}: ${classification.reason}`,
        };
        const resources = state.resources.map((record) =>
          record.key === usedResourceKey ? this.applyClassification(record, classification, now) : record,
        );
        const waiting = await this.commit(state, {
          ...withLineage,
          resources,
          roadmap: setStatus(
            withLineage.roadmap,
            item.key,
            named.state === "AUTH_REQUIRED" ? "WAITING_FOR_HUMAN_REQUIRED" : "WAITING_FOR_RESOURCE",
            boundedDiagnostic(named.reason),
          ),
        });

        if (named.state === "AUTH_REQUIRED") {
          const escalated = await this.escalate(
            waiting,
            item.key,
            "AUTH_REQUIRED",
            `Re-authenticate the provider for ${usedResourceKey ?? "the required resource"} (for example \`claude auth login\` or \`codex login\`).`,
            named.reason,
          );
          return {
            kind: "CONCLUSION",
            result: {
              kind: "WAITING_FOR_HUMAN",
              roadmapKey: item.key,
              reason: "AUTH_REQUIRED",
              humanActionRequired: `Re-authenticate the provider for ${usedResourceKey ?? "the required resource"}.`,
            },
            wakeBasis: escalated,
          };
        }

        const wake = this.computeNextWake(waiting);
        const settled = await this.commit(waiting, withWake(waiting, wake));
        this.log(`[supervisor] ${item.key} waiting for resource: ${named.reason}`);
        return {
          kind: "CONCLUSION",
          result: {
            kind: "WAITING_FOR_RESOURCE",
            roadmapKey: item.key,
            reason: named.reason,
            ...(wake === undefined ? {} : { nextWakeAt: wake }),
          },
          wakeBasis: settled,
        };
      }
    }
  }

  // =====================================================================
  // Helpers
  // =====================================================================

  /**
   * How a resource is paid for (F-2, NEW-FIN-1, F4-3).
   *
   * `observed` is what the provider itself reported to a probe THIS PROCESS just
   * ran — the caller is responsible for that, and `runItem` re-probes
   * immediately before the gate for exactly this reason. It is deliberately a
   * parameter rather than a lookup: reading it from `state` is what made a
   * persisted row sufficient evidence for a financial decision (F4-3), and a
   * signature that cannot reach the row cannot be tempted by it.
   *
   * The catalog's declared mode may only make the answer STRICTER, never looser:
   * configuration can say "treat this as metered even though it looks included",
   * but it cannot say "trust me, this pay-as-you-go resource is free". Declaring
   * is a claim; probing is evidence.
   *
   * Absent observation is UNKNOWN, and unknown is financial.
   */
  private billingModeFor(observed: BillingMode | undefined, provider: string, model: string): BillingMode {
    const declared = this.deps.resourceCatalog.find(
      (candidate) => candidate.provider === provider && candidate.model === model,
    )?.billingMode;

    if (observed === undefined) {
      return "UNKNOWN";
    }
    if (observed === "INCLUDED_SUBSCRIPTION" && declared !== undefined && declared !== "INCLUDED_SUBSCRIPTION") {
      return declared;
    }
    return observed;
  }

  /**
   * Every resource an independent review of this item must NOT use (C4, N-2,
   * F4-6).
   *
   * That is this item's own implementer AND the implementer of everything in its
   * dependency ANCESTRY — not merely its direct dependencies. Review finding
   * F4-6 (HIGH) supplied the counter-example: A implemented by Codex, B depends
   * on A and is implemented by Claude, C independently reviews B. With Claude
   * unavailable, C was reviewed by Codex — which had implemented A, the work B
   * is built on. Reviewing your own work is not made independent by an
   * intermediate hop.
   *
   * ================================================================
   * WHAT THIS CANNOT DO — review finding R9-C4-1, stated rather than implied.
   * ================================================================
   * Implementer lineage is HISTORICAL DATA. It lives in the supervisor's
   * database, and there is no key on this machine with which to authenticate it,
   * so anything able to write that database can rewrite who built what: name a
   * real catalog resource that did not do the work, and the review it should
   * have been excluded from proceeds.
   *
   * The financial gate does not have this weakness, because F-1 made spending
   * authority impossible to express in data at all — no row can grant it, so no
   * row needs to be trusted. Lineage cannot be handled that way: "who ran this
   * last week" is inherently a recorded fact, and a recorded fact is only as
   * good as the record.
   *
   * What is done instead, in increasing order of what it costs an attacker:
   * recognition against the code-level catalog (R8-C4-1), a cross-check against
   * `lastRunConfig`, which a different code path writes at a different time
   * (R9-C4-1), and failing closed whenever any of it is missing, unrecognised or
   * contradictory. What is NOT claimed is that a determined writer of the
   * database is stopped. **The supervisor database is part of the trusted
   * computing base.**
   *
   * WHAT `STATE_INTEGRITY` ALREADY DID, since this note used to defer all of it
   * to a future task and that is no longer true: the database and its directory
   * are owner-only, verified on every open; there is an append-only hash chain
   * recording the same events as the mutable row, anchored by length and head so
   * a deletion is visible; and the roadmap's DEFINITION has moved out of the
   * mutable row into a code-level catalog (TASK-012).
   *
   * WHAT REMAINS, and is why the sentence above still stands: the chain has no
   * SECRET, so it is tamper-EVIDENT and not tamper-proof, and the PROGRESS
   * fields are still mutable. Signing, or an external witness, is
   * `CLEAN_ROOM_CI` — not a comment here.
   *
   * N-2 already said C4 is a property of the LINEAGE rather than of one item.
   * The first fix walked one edge of that lineage; this walks all of it.
   * Traversal is breadth-first with a visited set, so a cyclic or
   * self-referential roadmap terminates rather than hanging — `validateRoadmap`
   * rejects cycles on read, and a safety routine should not depend on another
   * check having already run.
   */
  private excludedReviewerResources(
    state: SupervisorState,
    item: RoadmapItem,
  ): { readonly excluded: readonly string[]; readonly ambiguous: readonly string[] } {
    const byKey = new Map(state.roadmap.map((entry) => [entry.key, entry]));
    /**
     * Every resource this installation could possibly have used (R7-C4-1),
     * taken ONLY from the wiring's catalog (R8-C4-1).
     *
     * The first version also folded in `state.resources` — which is PERSISTED,
     * and therefore writable by anything that can write the database. So a
     * forged resource row plus a matching forged implementer entry satisfied
     * "we recognise this implementer" and the review proceeded. That is the
     * whole finding of every round in one line: the check for forged lineage
     * was itself validated against forgeable data.
     *
     * The catalog is code-level configuration. It is the only trustworthy
     * answer to "what could have run here".
     */
    const knownResourceKeys = new Set(
      this.deps.resourceCatalog.map((entry) => resourceKey(entry.provider, entry.model)),
    );
    const excluded = new Set<string>();
    /**
     * Computed before the row walk because the run-configuration cross-check
     * above needs it, and that check must not depend on the mutable work class
     * to decide whether it runs.
     */
    const chainImplementersEarly = implementersByRoadmapKey(state.provenance);
    /**
     * Ancestors that DID AI work but recorded no implementer (F5-C4-1).
     *
     * The fifth review's counter-example: a DONE implementation item with no
     * `implementedByResourceKey` — from an older schema, a rerun, a hand-edited
     * row — excluded nobody, so the resource that had built it was free to
     * review it. Absence of a recorded implementer is not evidence that there
     * wasn't one. C4 is not a preference to satisfy where convenient; where the
     * lineage cannot be established the review must not proceed at all.
     */
    const ambiguous: string[] = [];
    const catalogByKey = new Map(this.roadmapCatalog().map((entry) => [entry.key, entry]));
    const visited = new Set<string>();
    const queue: string[] = [item.key];
    while (queue.length > 0) {
      const key = queue.shift() as string;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      const entry = byKey.get(key);
      if (entry === undefined) {
        // A dangling dependency key is itself unresolvable lineage.
        ambiguous.push(key);
        continue;
      }
      for (const resource of implementerHistory(entry)) {
        excluded.add(resource);
      }
      /**
       * F6-C4-2: this originally only questioned DONE ancestors, so an AI
       * ancestor that was BLOCKED, reopened, or left mid-flight recorded no
       * implementer and raised no objection — and its reviewer was free to be
       * whoever had built it. What matters is whether WORK HAPPENED, not what
       * status the item currently carries: an item that has consumed an attempt
       * has run a worker, whatever it says now.
       *
       * A never-started ancestor (no attempts, not DONE, not BLOCKED) genuinely
       * has no implementer to record, and is not ambiguous.
       */
      /**
       * INCLUDES THE ITEM UNDER REVIEW (round-4 CRITICAL).
       *
       * Recognition was applied only to ancestors, so the reviewed item's row
       * and chain could agree on a resource that is not in the code-level
       * catalog at all. That fake identity was dutifully excluded — and the
       * REAL implementer, never named anywhere, stayed eligible. The reviewer
       * had Codex review its own work through exactly that gap.
       *
       * An unrecognised implementer is not lineage; it is an unrecognised
       * string sitting where lineage should be, and it is no less suspicious
       * for being attached to the item being reviewed rather than to one of
       * its ancestors.
       */
      /**
       * `lastRunConfig` is consulted REGARDLESS of the mutable work class
       * (round-7 CRITICAL).
       *
       * It records what actually ran. Relabelling an item `DETERMINISTIC`
       * skipped the whole branch, so an ancestor whose row and chain named
       * Claude while its run configuration named Codex was never cross-checked
       * — and Codex reviewed it. A record of what ran does not stop being a
       * record because a mutable field was edited.
       */
      const runConfigResource =
        entry.lastRunConfig === undefined
          ? undefined
          : `${entry.lastRunConfig.effectiveProvider}:${entry.lastRunConfig.effectiveModel}`;
      if (runConfigResource !== undefined) {
        excluded.add(runConfigResource);
        const namedAnywhere =
          implementerHistory(entry).includes(runConfigResource) ||
          (chainImplementersEarly?.get(key) ?? []).includes(runConfigResource);
        if (!namedAnywhere && !ambiguous.includes(key)) {
          ambiguous.push(key);
        }
      }

      if (requiresAi(entry.workClass)) {
        /**
         * For the item under review, ATTEMPTS alone are not evidence that an
         * implementer exists: a review that has been attempted once has run a
         * reviewer, not an implementer. Its recorded identities are still
         * checked below — what changes is only whether SILENCE is suspicious.
         */
        const workHappened =
          key === item.key
            ? entry.status === "DONE" || entry.status === "BLOCKED"
            : entry.status === "DONE" || entry.status === "BLOCKED" || (entry.attempts ?? 0) > 0;
        const history = implementerHistory(entry);
        /**
         * R7-C4-1: a history entry that names no resource this installation
         * knows about is not lineage — it is an unrecognised string sitting
         * where lineage should be. `implementedByResourceKeys: ["not-a-resource"]`
         * previously satisfied the "we know who built this" check while
         * excluding nobody, so the real implementer was free to review its own
         * work. An unrecognised implementer is MORE suspicious than a missing
         * one, not less.
         */
        const unrecognised = history.filter((resource) => !knownResourceKeys.has(resource));
        /**
         * R9-C4-1: cross-check the history against the OTHER record of what ran.
         *
         * A forged history naming a real catalog resource passes the
         * recognition check — the ninth review had Codex implement an item,
         * rewrote the history to say Claude, and Codex then reviewed its own
         * work. Recognition proves the NAME is plausible, not that it is true.
         *
         * `lastRunConfig` is written by a different code path at a different
         * time, so a forger has to keep both consistent. That is a real increase
         * in difficulty and NOT a proof: see the trust-boundary note on
         * `excludedReviewerResources` for what this does and does not establish.
         */
        const fromRunConfig =
          entry.lastRunConfig === undefined
            ? undefined
            : `${entry.lastRunConfig.effectiveProvider}:${entry.lastRunConfig.effectiveModel}`;
        const contradicted = fromRunConfig !== undefined && !history.includes(fromRunConfig);
        /**
         * `workHappened` governs SILENCE, and nothing else.
         *
         * An empty history is only suspicious if work actually happened — a
         * never-started item genuinely has no implementer to record. But a
         * history naming something UNRECOGNISED, or contradicting the recorded
         * run configuration, is suspicious on its own terms: those are
         * assertions about who ran, and a wrong assertion does not become
         * harmless because the item has not finished.
         *
         * The first version gated all three on `workHappened`, so the reviewed
         * item — ELIGIBLE, so not "done" — could name a resource no catalog
         * knows and be waved through, while the real implementer stayed
         * eligible to review it.
         */
        const silentButShouldNotBe = workHappened && history.length === 0;
        if (silentButShouldNotBe || unrecognised.length > 0 || contradicted) {
          ambiguous.push(key);
        }
      }
      /**
       * EDGES COME FROM THE CATALOG, NOT THE ROW (round-5 finding 3).
       *
       * `dependsOn` on the persisted row is mutable, which is why an earlier
       * round defended against edits by examining EVERY key provenance mentions.
       * That defence over-reached: reviewing an ancestor excluded resources
       * because of what they implemented DOWNSTREAM, and a valid reviewer was
       * refused with WAITING_FOR_RESOURCE.
       *
       * The catalog's edges are code, not data, and `reconcileRoadmapWithCatalog`
       * already refuses a tick whose persisted roadmap disagrees with them. So
       * they are both tamper-resistant AND correctly directional: ancestors
       * only. That closes the edit-hiding attack without excluding half the
       * roadmap.
       */
      queue.push(...(catalogByKey.get(key)?.dependsOn ?? entry.dependsOn));
    }
    /**
     * The item under review contributes its OWN run evidence (round-3 finding).
     *
     * The ancestor loop deliberately skips `item.key` for the ambiguity rules,
     * which is right — an item is not its own ancestor. But its `lastRunConfig`
     * still records a resource that has already run ON IT, and choosing that
     * resource as its reviewer is the thing C4 forbids. Excluded rather than
     * escalated: over-excluding costs a routing choice, under-excluding costs
     * the gate.
     */
    const reviewed = byKey.get(item.key);
    if (reviewed?.lastRunConfig !== undefined) {
      excluded.add(
        `${reviewed.lastRunConfig.effectiveProvider}:${reviewed.lastRunConfig.effectiveModel}`,
      );
    }

    // Belt and braces: a checkpoint may still name one for an in-flight item.
    // Every implementer finding is read, not merely the first — a rolled-over
    // session can accumulate more than one.
    for (const checkpoint of state.checkpoints.filter((entry) => entry.roadmapKey === item.key)) {
      for (const finding of checkpoint.findings) {
        if (finding.startsWith("implementer:")) {
          excluded.add(finding.slice("implementer:".length));
        }
      }
    }

    /**
     * THE SECOND SOURCE (TASK-008 AC-5, AC-6).
     *
     * Everything above reads `implementedByResourceKeys`, which lives in the
     * same mutable row as the item itself — so a writer of the database edits
     * lineage and the exclusion it produces in one move. The hash chain is a
     * separate record of the same events, and this compares them.
     *
     * THREE OUTCOMES, and the middle one is the point:
     *
     *   - the chain does not verify at all -> every visited ancestor becomes
     *     ambiguous. Lineage that cannot be vouched for is not lineage, and
     *     AC-5 requires the review to wait for a human rather than proceed on
     *     unverifiable history.
     *   - the chain verifies but names an implementer the mutable row does not
     *     (or vice versa) -> ambiguous. Two records disagreeing means at least
     *     one is wrong, and nothing here can say which; picking the more
     *     convenient one is how a forged row wins.
     *   - both agree -> the exclusion stands, now with two independent records
     *     behind it.
     *
     * NOT a replacement (AC-6): the catalog recognition, the `lastRunConfig`
     * cross-check and the missing/unknown handling above all still run. A
     * second lock on the door does not mean removing the first.
     *
     * The chain is tamper-EVIDENT only. An attacker who recomputes it after
     * editing defeats this, and the module says so — what it stops is the
     * corrupted row, the partial restore, the hand-edit "just fixing one
     * field", which are the realistic cases.
     */
    /**
     * ONE verification, then read it for every ancestor (AC-10).
     *
     * `undefined` means the chain does not verify — and by the time this loop
     * runs, that CANNOT happen.
     *
     * Round-14 review measured the pair and found them masking each other:
     * removing either `brokenChainOutcome` or the per-key `undefined` branch
     * below left the whole suite green, so neither was load-bearing. That is the
     * same finding this comment already recorded about an earlier pair, and the
     * fix drifted back when `brokenChainOutcome` was added in round 4.
     *
     * They cover the same case because step 0 uses `verifyAgainstAnchor`, which
     * is strictly stronger than the structural check behind this `undefined`:
     * anything that fails the weaker one fails the stronger one first, and the
     * tick has already refused.
     *
     * So there is ONE decision — step 0 — and this is an ASSERTION of the
     * invariant it establishes, not a second opinion about it. It throws rather
     * than deciding, because reaching it would mean step 0 is broken, and a
     * caller must not be able to mistake an internal contradiction for a
     * considered verdict. Unreachable by construction, recorded as such in
     * docs/KNOWN-LIMITATIONS.md L-8.
     */
    const chainImplementers = implementersByRoadmapKey(state.provenance);
    if (chainImplementers === undefined) {
      throw new SchemaIntegrityError(
        "internal invariant violated: the reviewer-exclusion walk was reached with a chain that does not " +
          "verify, which `brokenChainOutcome` refuses before any item is selected",
      );
    }
    const unknownImplementers = keysWithUnknownImplementer(state.provenance);

    /**
     * THE CHAIN DECIDES WHAT THE CHAIN IS ASKED ABOUT (round-5 CRITICAL).
     *
     * `visited` comes from walking `dependsOn`, which lives in the MUTABLE
     * roadmap. So editing `B.dependsOn` to `[]` meant the chain entry naming
     * who implemented `A` was never consulted — the chain stayed perfectly
     * valid and was simply never asked. Mutable data decided whether immutable
     * data was read, which is the third time that exact shape has produced a
     * CRITICAL in this task.
     *
     * Every key the chain MENTIONS is examined, whatever the current edges say.
     * A dependency edit can no longer hide lineage, because the lineage record
     * itself supplies the list.
     */
    /**
     * ANCESTRY, PLUS ANYTHING THE CATALOG NO LONGER PLACES (round-5 finding 3).
     *
     * This was `visited` UNION every key provenance mentions, which excluded a
     * resource because of work it did DOWNSTREAM of the item being reviewed.
     * The reviewer measured it: reviewing ancestor A refused Codex — the only
     * available reviewer — because Codex had implemented descendant B. C4 says a
     * reviewer must not review its OWN work; it says nothing about unrelated
     * work elsewhere in the roadmap, and a gate that refuses valid reviewers is
     * a gate that gets switched off.
     *
     * The ancestry walk above now follows the CATALOG's edges, which a database
     * edit cannot change, so the union is no longer needed to defend against
     * edge tampering. What remains in it is keys the catalog does not place at
     * all — removed or renamed items, whose lineage cannot be positioned and
     * therefore must still be honoured.
     */
    const chainKeys = new Set<string>([
      ...visited,
      ...state.provenance
        .map((entry) => entry.roadmapKey)
        .filter((key) => !catalogByKey.has(key)),
    ]);
    for (const key of chainKeys) {
      const entry = byKey.get(key);
      if (entry === undefined) {
        /**
         * The chain names an item the roadmap no longer contains. That is not
         * nothing — it is a record of work on something that has since been
         * removed or renamed, and its implementer must still be excluded.
         */
        for (const resource of chainImplementers.get(key) ?? []) {
          excluded.add(resource);
        }
        if (unknownImplementers.has(key) && !ambiguous.includes(key)) {
          ambiguous.push(key);
        }
        continue;
      }
      /**
       * NO `workClass` FILTER HERE (round-3 CRITICAL).
       *
       * `workClass` lives in the MUTABLE row. Using it to decide whether to
       * consult the immutable record inverts the whole design: the reviewer
       * relabelled an item `DETERMINISTIC`, the chain entry naming its
       * implementer was skipped, and that implementer reviewed it. A record
       * consulted only when another record permits it is not a second source.
       *
       * The chain is authoritative about who did work, whatever the row now
       * says the work was.
       */
      if (unknownImplementers.has(key)) {
        // The chain asserts work happened and does not say who did it. That is
        // worse than no record, because something DID run.
        if (!ambiguous.includes(key)) {
          ambiguous.push(key);
        }
        continue;
      }
      /**
       * THE ITEM UNDER REVIEW IS NOT SKIPPED (round-2 CRITICAL).
       *
       * The first version skipped `key === item.key`, mirroring the row-based
       * loop above — but that loop already adds the item's OWN implementers to
       * the exclusion set before its ambiguity check. Skipping the item here
       * meant a chain entry saying "codex implemented B" was ignored when
       * choosing who reviews B, and the reviewer showed codex then reviewing
       * its own work with the mutable row left empty.
       *
       * Whoever implemented the item under review is exactly who must not
       * review it. That is the entire point of C4.
       */
      const fromChain = chainImplementers.get(key) ?? [];
      const fromRow = implementerHistory(entry);

      /**
       * The CHAIN's names are checked against the catalog too (round-6
       * CRITICAL).
       *
       * Recognition lived inside the row-based branch, which is gated on the
       * MUTABLE `workClass` — so relabelling an item `DETERMINISTIC` skipped it,
       * and the chain cross-check never asked whether a name was recognisable
       * at all. Two records agreeing on `not-a-catalog-resource` satisfied
       * everything and the real implementer stayed eligible.
       *
       * Agreement between two rewritable records is not recognition. The
       * catalog is code-level configuration and is the only answer to "could
       * this have run here".
       */
      const unrecognisedInChain = fromChain.filter((resource) => !knownResourceKeys.has(resource));
      if (unrecognisedInChain.length > 0 && !ambiguous.includes(key)) {
        ambiguous.push(key);
      }

      /**
       * SILENCE IS ONLY SILENCE WHEN THE WHOLE CHAIN IS EMPTY (round-1 finding).
       *
       * The first version skipped whenever THIS ITEM had no chain entry, and
       * the reviewer turned that into a one-step bypass three ways: a chain
       * holding a valid entry for a DIFFERENT roadmap key, a chain holding only
       * `RUN_CONFIGURED` events, and — the one that matters — a chain with this
       * item's entries simply deleted. All three left a populated, verifying
       * chain that said nothing about the item, and all three advanced.
       *
       * A chain that EXISTS and does not mention an item whose row names
       * implementers is not silence. It is the two records disagreeing, which
       * is precisely what this cross-check exists to catch. Deleting entries
       * must not be cheaper than editing them; tail truncation is a deletion.
       *
       * Genuine silence — an entirely empty chain — is still permitted, because
       * a database written before TASK-008 has no entries for work already done
       * and refusing every review would strand the roadmap this protects. That
       * residue is recorded in docs/KNOWN-LIMITATIONS.md rather than hidden.
       */
      /**
       * The same rule as above: an empty chain is legacy silence ONLY when no
       * anchor claims otherwise. With an anchor, an empty chain is a deletion.
       */
      /**
       * The same complete test as `brokenChainOutcome`: an empty chain is
       * silence only when NO anchor claims otherwise, in either field.
       */
      if (chainIsLegacySilence(state)) {
        continue;
      }
      if (fromChain.length === 0 && fromRow.length === 0) {
        // Neither record claims an implementer, so there is nothing to
        // disagree about and nothing to exclude.
        continue;
      }
      const disagrees =
        fromChain.some((resource) => !fromRow.includes(resource)) ||
        fromRow.some((resource) => !fromChain.includes(resource));
      if (disagrees && !ambiguous.includes(key)) {
        ambiguous.push(key);
      }
      // A resource named by EITHER record is excluded. Exclusion is the safe
      // direction: over-excluding costs a routing choice, under-excluding
      // costs C4.
      for (const resource of fromChain) {
        excluded.add(resource);
      }
    }

    return { excluded: [...excluded], ambiguous };
  }

  /**
   * The earliest moment any waiting resource is worth looking at again.
   *
   * Round 10 bounded this input by the code catalog, in the wake authority
   * itself, so an uncatalogued row in a REFUSED state could not supply the
   * published wake. Round 11 measured why identity was the WRONG property: a
   * row whose identity IS catalogued, tampered inside that same refused state,
   * still published — and the publish re-committed the refused state besides.
   * The property that actually holds now is stronger and lives where the wake
   * is COMMITTED: `publishWake` derives only from a state this tick itself
   * wrote through the repository, so refused state cannot reach this function
   * through the publish path at all, and every in-tick caller runs after step
   * 1a's reconciliation.
   *
   * The round-10 identity filter is therefore REMOVED rather than kept: on
   * every reachable input it had become a no-op, and a control that no test
   * can make fail is indistinguishable from a deleted one — keeping it would
   * decorate the function with an assurance nothing enforces.
   */
  private computeNextWake(state: SupervisorState): Timestamp | undefined {
    const candidates = state.resources
      .map((record) => record.retryAt)
      .filter((value): value is Timestamp => value !== undefined);
    return candidates.length === 0 ? undefined : Math.min(...candidates);
  }

  /**
   * A chain that does not verify makes the state UNUSABLE FOR WRITING, because
   * the repository refuses to persist it — correctly. Round-4 review then found
   * the consequence: the tick's ordinary housekeeping write threw
   * `SchemaIntegrityError`, so a supervisor whose durable history had been
   * tampered with produced a stack trace, zero executor calls, and NO recorded
   * escalation. Fail-closed has to mean the supervisor decided to stop, not
   * that it fell over on the way to deciding.
   *
   * Detected on LOAD, before anything tries to write, and reported as the
   * human-decision it is.
   */
  private roadmapCatalog(): readonly RoadmapItem[] {
    return this.deps.roadmapCatalog ?? DEFAULT_ROADMAP;
  }

  /**
   * Rebuilds the roadmap from the catalog, or refuses (TASK-012 AC-1/2/3/6).
   *
   * Returns the state every later step must use. A caller that read
   * `state.roadmap` instead would be reading exactly the row this exists to
   * distrust, so the reconciled state REPLACES it rather than sitting beside it.
   */
  /**
   * How long without progress before a LIVE owner is called STALLED (AC-14).
   *
   * Forty minutes, which is the threshold the TASK-017 watchdog used and the one
   * an operator here already reasons in. A stall is a MEASUREMENT against a
   * stated interval; without the interval, "stalled" is an opinion.
   */
  private stallAfterMs(): number {
    return this.deps.stallAfterMs ?? 40 * 60 * 1000;
  }

  /**
   * Looks at work IN FLIGHT and writes down what it finds (AC-16, AC-19, AC-20).
   *
   * RECORDS, and acts only in the one narrow way `crashedItemsToRequeue`
   * permits. A conclusion about a dead process is knowledge; freeing its lease,
   * finishing its activity or advancing its item would be decisions, and each of
   * those has a gate elsewhere.
   *
   * It never returns a refusal that stops the tick. A crashed activity is not a
   * reason to stop the Factory — it is the reason the Factory can carry on,
   * which is what separates this from the structural refusals above.
   */
  /**
   * Applies a change to the activity list and PERSISTS it, re-reading and
   * re-applying when another supervisor moved the state first.
   *
   * ROUND-4 REVIEW, HIGH 2. A rival supervisor that correctly stood down still
   * advanced the state with its own reconciliation write, and the owner's
   * completion then failed its CAS with `ConcurrencyError` — so a piece of work
   * that had actually FINISHED left no completion at all, and the activity sat
   * RUNNING for reconciliation to later call crashed. Losing the record of a
   * success is worse than losing the race.
   *
   * A conflict here is not an error, it is a stale read: the transition is
   * recomputed against what the state now says and written again. `mutate`
   * must therefore be a pure function of the CURRENT activities, and every
   * transition in `activity.ts` is exactly that, which is why they take and
   * return a list rather than editing one.
   *
   * Bounded, and it returns the unchanged state rather than throwing when it
   * runs out of attempts: the caller is on its way to `settle`, and failing to
   * record a completion must not also lose the outcome it was recording.
   */
  private async commitActivityChange(
    state: SupervisorState,
    what: string,
    mutate: (activities: readonly Activity[]) => TransitionVerdict,
    /**
     * Anything else that must move in the SAME write.
     *
     * The launch heartbeat travels with the claim's CLAIMED -> RUNNING
     * transition, and splitting them would create a state where one landed and
     * the other did not — the half-applied shape this task exists to refuse.
     *
     * IT IS A FUNCTION OF THE FRESH STATE, AND IT MAY REFUSE (round-7 review,
     * HIGH 1). It was a function of the fresh state in signature only: the
     * launch site closed over the claim it had read at the top of the tick and
     * returned it verbatim, so a retry — or a no-op transition, which skips the
     * transition entirely and applies the patch alone — wrote that stale claim
     * over whatever the durable state now held. The reviewer used it to replace
     * a rival's live claim with a dead one by reporting unchanged progress.
     *
     * Deriving from `state` is not enough on its own, because "what I expected
     * is no longer there" has to be an ANSWER rather than a silent overwrite.
     */
    alongside?: (state: SupervisorState) => AlongsideVerdict,
  ): Promise<{ readonly state: SupervisorState; readonly recorded: boolean; readonly problem?: string }> {
    let current = state;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const next = mutate(current.activities ?? []);
      if (!next.ok) {
        this.log(`[supervisor] could not ${what}: ${next.problem}`);
        return { state: current, recorded: false, problem: next.problem };
      }
      const extra = alongside?.(current);
      if (extra !== undefined && !extra.ok) {
        this.log(`[supervisor] could not ${what}: ${extra.problem}`);
        return { state: current, recorded: false, problem: extra.problem };
      }
      const patch = extra?.patch ?? {};
      if (!next.changed && Object.keys(patch).length === 0) {
        return { state: current, recorded: true };
      }
      try {
        return {
          state: await this.commit(current, {
            ...current,
            ...patch,
            ...(next.changed ? { activities: next.activities } : {}),
          }),
          recorded: true,
        };
      } catch (error) {
        if (!isStaleSnapshot(error)) {
          throw error;
        }
        const fresh = await this.deps.repository.load();
        if (fresh === undefined) {
          this.log(`[supervisor] could not ${what}: durable state disappeared`);
          return { state: current, recorded: false, problem: `durable state disappeared while trying to ${what}` };
        }
        /**
         * THE VERSION HAVING MOVED IS THE PROOF (round-7 review, HIGH 2).
         *
         * `ConcurrencyError` carries that proof in itself. The provenance
         * refusal does not: "the history I am writing is shorter than the
         * stored one" is what a rival's append looks like from here AND what a
         * deliberate truncation looks like, and they are indistinguishable from
         * the error alone. So the error only makes this WORTH re-reading, and
         * the re-read decides: a durable state that has not moved means nothing
         * raced us and the refusal was about our own write, which must not be
         * retried into.
         */
        if (fresh.version === current.version) {
          const problem =
            `refused to ${what}: ${error instanceof Error ? error.message : String(error)} — and durable state ` +
            `has not moved since it was read (version ${current.version}), so nothing raced this write`;
          this.log(`[supervisor] ${problem}`);
          return { state: current, recorded: false, problem };
        }
        this.log(`[supervisor] re-reading to ${what}: another supervisor advanced the state`);
        current = fresh;
      }
    }
    /**
     * EXHAUSTION IS REPORTED, NOT SWALLOWED (round-5 review, HIGH 2).
     *
     * The first version returned the unchanged state and the caller went on to
     * settle the outcome, so a run that had SUCCEEDED marked its item DONE
     * while the activity stayed RUNNING with no completion — a `DONE` nothing
     * durable accounts for, which is the forged-completion shape TASK-012
     * refuses on the roadmap arriving by yet another door.
     */
    const problem = `gave up trying to ${what} after repeated conflicts`;
    this.log(`[supervisor] ${problem}`);
    return { state: current, recorded: false, problem };
  }

  /**
   * Turns verdicts that already exist into durable state, exactly once.
   *
   * THE FAILURE THIS CLOSES, stated plainly because it is this task's own:
   * round 7's reviewer produced a valid CHANGES_REQUIRED verdict, the chain
   * validated it, logged it and exited — and the verdict sat on disk for
   * twenty-two hours until a person sent a message. Nothing had crashed. There
   * was simply nothing whose job it was to notice.
   *
   * Every rule below exists so that noticing cannot be lost:
   *
   *   - it runs inside the ordinary tick, so a COLD START consumes a verdict
   *     that landed while nothing was running (no notification is required, and
   *     losing one costs nothing);
   *   - it reads the binding from DURABLE state, so the process that launched
   *     the review need not exist any more;
   *   - it refuses a verdict that names a different candidate, because a
   *     verdict is only about the tree it judged;
   *   - it settles through the same compare-and-set retry as every other
   *     transition, so two supervisors converge on ONE consumption;
   *   - and it never turns absence, silence or an unreadable file into
   *     approval.
   */
  /**
   * Starts the reviews this Factory has been asked for, and adopts the ones
   * that have proved they are running (TASK-019 AC-2, AC-4, AC-5).
   *
   * THE HANDSHAKE, and why it is two writes rather than one:
   *
   *   1. the review record is committed FIRST, carrying its own identity, the
   *      candidate it is bound to, who is being asked and where the answer will
   *      appear. Only then is anything spawned. A supervisor that dies here
   *      leaves a CLAIMED review with no acknowledgement, which the next one
   *      reads as "the launch may not have happened" and resolves deliberately.
   *   2. the transition to RUNNING happens only when the WORKER says so, naming
   *      the run id that was committed before it existed. "The spawn call
   *      returned" is not evidence and is never recorded as running.
   *
   * Repeating either step is harmless: the record is derived from the request,
   * not generated, and adoption of an already-adopted worker is a no-op.
   */
  private async reconcileReviews(
    state: SupervisorState,
  ): Promise<{
    readonly state: SupervisorState;
    readonly refusal?: { readonly roadmapKey: string; readonly problem: string };
  }> {
    const requests = state.reviewRequests ?? [];
    if (requests.length === 0) {
      return { state };
    }

    const launcher = this.deps.reviewLauncher;
    if (launcher === undefined) {
      const problem =
        `${requests.length} review${requests.length === 1 ? " has" : "s have"} been requested and this supervisor ` +
        "has no way to launch one; refusing to decide anything while work waits on a review nothing can start";
      this.log(`[supervisor] ${problem}`);
      return { state, refusal: { roadmapKey: requests[0]!.roadmapKey, problem: boundedDiagnostic(problem) } };
    }

    let current = state;
    for (const request of requests) {
      const activityId = canonicalActivityId(request.roadmapKey, "REVIEW", request.attempt);
      const existing = (current.activities ?? []).find((entry) => entry.id === activityId);

      if (existing !== undefined && isTerminal(existing.state)) {
        // Settled: the verdict consumer owns what happens next.
        continue;
      }

      const plan: ReviewLaunchRequest = {
        reviewId: activityId,
        roadmapKey: request.roadmapKey,
        activityId,
        provider: request.provider,
        model: request.model,
        effort: request.effort,
        candidate: request.candidate,
        source: reviewSourcePath(request, activityId),
        ack: reviewAckPath(request, activityId),
      };

      /**
       * THE ACKNOWLEDGEMENT IS READ FIRST, ALWAYS — but only for a review that
       * has a RECORD.
       *
       * A worker that has proved it exists outranks every conclusion that could
       * be drawn about whether it was launched, including this supervisor's own
       * memory of having launched it, which after a restart it does not have.
       * What it cannot outrank is the absence of a record: an acknowledgement
       * sitting beside a review nobody ever started belongs to something else —
       * a previous attempt, a leftover file — and adopting it would mean
       * "running" for a process this Factory never launched.
       */
      const ack = existing === undefined ? undefined : launcher.acknowledgement(plan);

      if (ack === undefined && this.launchIsOutstanding(existing)) {
        if (existing === undefined) {
          const recorded = await this.recordReviewLaunch(current, request, plan);
          if (recorded.refusal !== undefined) {
            return recorded;
          }
          current = recorded.state;
        }

        /**
         * SPAWN AFTER THE RECORD IS DURABLE, never before. If this process dies
         * between the two, the record exists and says "claimed, not
         * acknowledged" — which is recoverable. The other order leaves a
         * reviewer running that nothing knows about, which is not.
         */
        const started = await launcher.launch(plan);
        if (!started.ok) {
          const problem =
            `review ${plan.reviewId} could not be started (${started.problem})` +
            (started.exhausted === true ? "; the provider is out of capacity" : "");
          this.log(`[supervisor] ${problem}`);
          /**
           * A failed START is not a failed REVIEW. The record stays CLAIMED with
           * no acknowledgement, and a later tick tries again once the launching
           * process is demonstrably gone — which is the same path a supervisor
           * that died mid-spawn takes, so there is one recovery path rather
           * than two.
           */
          continue;
        }
        this.log(`[supervisor] launched review ${plan.reviewId} (${request.model} at ${request.effort})`);
        continue;
      }

      if (ack === undefined) {
        continue;
      }
      const adopted = await this.commitActivityChange(current, `adopt review ${plan.reviewId}`, (activities) =>
        adoptLaunchedReview(activities, activityId, {
          runId: ack.runId,
          lease: leaseFromAcknowledgement(ack),
          at: this.deps.clock.now(),
        }),
      );
      if (!adopted.recorded) {
        const problem = `review ${plan.reviewId} proved it started and that could not be recorded (${adopted.problem ?? "unknown reason"})`;
        this.log(`[supervisor] ${problem}`);
        return { state: adopted.state, refusal: { roadmapKey: request.roadmapKey, problem: boundedDiagnostic(problem) } };
      }
      current = adopted.state;
    }

    return { state: current };
  }

  /**
   * Whether a launch still needs to be attempted (TASK-019 AC-5, AC-16).
   *
   * THE DANGEROUS CASE IS THE MIDDLE ONE. Between spawning a reviewer and that
   * reviewer writing its acknowledgement there is a real window — a second or
   * two, and longer on a loaded machine. A supervisor that retried on every
   * tick because it saw no acknowledgement yet would start a second reviewer
   * for a worker that was about to announce itself, which is the duplicate
   * launch AC-16 forbids and is also simply expensive.
   *
   * So "no acknowledgement" alone never justifies a relaunch. What does:
   *
   *   - no record at all, which means nothing has been started; or
   *   - a record whose LAUNCHING PROCESS is demonstrably gone. That process
   *     holds the activity's lease until a worker adopts it, so a dead lease
   *     means the launch was interrupted and no reviewer can be about to
   *     acknowledge — nothing is left that could.
   *
   * An UNKNOWN holder is neither, and refuses by doing nothing: waiting costs a
   * tick, and launching a second reviewer against a possibly-live first one
   * costs a duplicate review and a contradictory verdict.
   */
  private launchIsOutstanding(existing: Activity | undefined): boolean {
    if (existing === undefined) {
      return true;
    }
    if (existing.state !== "CLAIMED" || existing.lease === undefined) {
      return false;
    }
    const probe = this.livenessProbe();
    return probe !== undefined && probe.check(existing.lease) === "GONE";
  }

  /**
   * Writes the review record, and nothing else, in one compare-and-set.
   *
   * The activity is CLAIMED under the SUPERVISOR's lease, because at this
   * moment the supervisor is the only thing that exists: the reviewer has not
   * been spawned. Adoption replaces that lease with the worker's, which is what
   * makes "is it still running" a question about the reviewer afterwards.
   */
  private async recordReviewLaunch(
    state: SupervisorState,
    request: ReviewRequest,
    plan: ReviewLaunchRequest,
  ): Promise<{
    readonly state: SupervisorState;
    readonly refusal?: { readonly roadmapKey: string; readonly problem: string };
  }> {
    const now = this.deps.clock.now();
    const lease = this.deps.activityLease?.(now);
    const probe = this.livenessProbe();
    if (lease === undefined || probe === undefined) {
      const problem =
        `review ${plan.reviewId} cannot be recorded: this supervisor cannot ${lease === undefined ? "establish its own identity" : "check liveness"}, ` +
        "so nothing could later reconcile the reviewer it started";
      this.log(`[supervisor] ${problem}`);
      return { state, refusal: { roadmapKey: request.roadmapKey, problem: boundedDiagnostic(problem) } };
    }

    const written = await this.commitActivityChange(state, `record review ${plan.reviewId}`, (activities) => {
      const claimed = claimActivity(
        activities,
        { id: plan.activityId, kind: "REVIEW", roadmapKey: request.roadmapKey, lease, now },
        probe,
      );
      if (!claimed.ok) {
        return claimed;
      }
      return {
        ok: true,
        changed: true,
        activities: claimed.activities.map((entry) =>
          entry.id === plan.activityId
            ? {
                ...entry,
                review: {
                  reviewId: plan.reviewId,
                  source: plan.source,
                  candidate: plan.candidate,
                  provider: plan.provider,
                  model: plan.model,
                  effort: plan.effort,
                  attempt: request.attempt,
                  ack: plan.ack,
                },
              }
            : entry,
        ),
      };
    });

    if (!written.recorded) {
      const problem = `review ${plan.reviewId} could not be recorded (${written.problem ?? "unknown reason"}); nothing was started`;
      this.log(`[supervisor] ${problem}`);
      return { state: written.state, refusal: { roadmapKey: request.roadmapKey, problem: boundedDiagnostic(problem) } };
    }
    return { state: written.state };
  }

  private async consumeAcceptanceVerdicts(
    state: SupervisorState,
  ): Promise<{
    readonly state: SupervisorState;
    readonly refusal?: { readonly roadmapKey: string; readonly problem: string };
  }> {
    const awaiting = reviewsAwaitingVerdict(state.activities ?? []);
    if (awaiting.length === 0) {
      return { state };
    }

    const source = this.deps.acceptanceVerdicts;
    if (source === undefined) {
      /**
       * A RECORDED REVIEW WITH NOWHERE TO READ IT IS A MISCONFIGURATION.
       *
       * Passing over it would leave the review in flight forever while the
       * Factory cheerfully did other work — the half-configured fail-open that
       * round 4 already found once, in the lease and probe.
       */
      const problem =
        `${awaiting.length} review${awaiting.length === 1 ? " is" : "s are"} recorded as in flight, and this ` +
        "supervisor has no way to read a verdict back; refusing to decide anything while a review's result is " +
        "unreachable";
      this.log(`[supervisor] ${problem}`);
      /**
       * AND IT IS CLASSIFIED, NOT ONLY REFUSED (round-8 review, HIGH 2).
       *
       * This refusal returns BEFORE reconciliation, so returning here left the
       * reviews with no `reconciliation` at all — AC-16 asks that every
       * non-terminal activity carry a durable conclusion, and "the tick stopped
       * for execution reasons" does not exempt the activities it stopped over.
       * It is the round-6 lesson again, arriving through the door round 7 built.
       */
      const noted = await this.commitActivityChange(
        state,
        "record that a review's verdict is unreachable",
        (current) => {
          let classified = current;
          let changed = false;
          for (const entry of current.filter((candidate) => candidate.review !== undefined && !isTerminal(candidate.state))) {
            const recorded = recordReconciliation(classified, entry.id, {
              verdict: "AMBIGUOUS",
              at: this.deps.clock.now(),
              detail: boundedDiagnostic(
                `review ${JSON.stringify(entry.id)} is ${entry.state} and this supervisor has no way to read a ` +
                  "verdict back, so whether it has finished cannot be established",
              ),
            });
            if (!recorded.ok) return recorded;
            classified = recorded.activities;
            changed = changed || recorded.changed;
          }
          return { ok: true, activities: classified, changed };
        },
      );
      const unreachable = {
        roadmapKey: awaiting[0]!.roadmapKey,
        problem: boundedDiagnostic(
          noted.recorded
            ? problem
            : `${problem}. Worse: that could not be recorded durably either (${noted.problem ?? "unknown reason"})`,
        ),
      };
      return { state: noted.state, refusal: unreachable };
    }

    let current = state;
    for (const activity of awaiting) {
      const review = activity.review;
      if (review === undefined) continue;
      const reading = source.read(review);

      /**
       * A VERDICT OUTLIVES ITS AUTHOR; SILENCE DOES NOT.
       *
       * A verdict is applied whatever the reviewer is doing now — it wrote its
       * conclusion, and that conclusion does not expire. Anything SHORT of a
       * verdict is only conclusive once the reviewer is proven gone: a file
       * being written this instant parses as no verdict at all, and calling
       * that a failed review would abandon a review still in progress.
       */
      if (reading.kind !== "VERDICT") {
        const probe = this.livenessProbe();
        const gone =
          probe !== undefined && activity.lease !== undefined && probe.check(activity.lease) === "GONE";
        if (!gone) continue;

        const why =
          reading.kind === "ABSENT"
            ? "it exited without writing one"
            : `what it wrote is not a verdict (${reading.reason})`;
        const settled = await this.commitActivityChange(
          current,
          `record that review ${review.reviewId} produced no verdict`,
          (activities) =>
            settleReview(activities, activity.id, {
              state: "FAILED",
              at: this.deps.clock.now(),
              completion: {
                outcome: NO_VERDICT_OUTCOME,
                detail: boundedDiagnostic(`review ${review.reviewId} of ${review.candidate.commit}: ${why}`),
                at: this.deps.clock.now(),
              },
            }),
          (fresh) => this.releaseReviewed(fresh, activity, "ELIGIBLE", `review produced no verdict: ${why}`),
        );
        if (!settled.recorded) {
          const problem =
            `review ${review.reviewId} produced no verdict and that could not be recorded ` +
            `(${settled.problem ?? "unknown reason"})`;
          this.log(`[supervisor] ${problem}`);
          return { state: settled.state, refusal: { roadmapKey: activity.roadmapKey, problem: boundedDiagnostic(problem) } };
        }
        /**
         * NEVER A PASS. A review that produced nothing is a review that must be
         * run again; the item returns to the queue and the next round schedules
         * one. This is the single asymmetry worth hard-coding.
         */
        this.log(`[supervisor] review ${review.reviewId} produced no verdict; ${activity.roadmapKey} is claimable again`);
        current = settled.state;
        continue;
      }

      const mismatch = bindingMismatch(review.candidate, reading.outcome.candidate);
      if (mismatch !== undefined) {
        /**
         * THE WRONG CANDIDATE'S VERDICT IS NOT A WEAKER VERDICT, IT IS NONE.
         *
         * A previous round's file left on disk, a reviewer pointed at the wrong
         * tree, a candidate amended after launch: all produce a perfectly
         * well-formed verdict about something else. Applying it would be the
         * purest form of the thing C4 exists to prevent — an approval nobody
         * gave for the code that would actually be integrated.
         */
        const problem = `refusing the verdict for review ${review.reviewId}: ${mismatch}`;
        this.log(`[supervisor] ${problem}`);
        /**
         * AND THE REFUSAL IS RECORDED, not merely returned — the round-6 lesson,
         * applied to the door it arrives at here.
         *
         * This refusal stops the tick, and it will stop every tick until someone
         * looks. A fresh process reading the activity back must find the reason
         * on it; otherwise the Factory is halted by a fact that exists only in
         * one process's return value and one log line.
         */
        const noted = await this.commitActivityChange(
          current,
          `record why the verdict for ${review.reviewId} was refused`,
          (activities) =>
            recordReconciliation(activities, activity.id, {
              verdict: "AMBIGUOUS",
              at: this.deps.clock.now(),
              detail: boundedDiagnostic(problem),
            }),
        );
        return {
          state: noted.state,
          refusal: {
            roadmapKey: activity.roadmapKey,
            problem: boundedDiagnostic(
              noted.recorded
                ? problem
                : `${problem}. The refusal could not be recorded durably either (${noted.problem ?? "unknown reason"})`,
            ),
          },
        };
      }

      const accepted = isAccepted(reading.outcome);
      const at = this.deps.clock.now();
      const settled = await this.commitActivityChange(
        current,
        `consume the verdict of review ${review.reviewId}`,
        (activities) =>
          settleReview(activities, activity.id, {
            state: "COMPLETED",
            at,
            completion: {
              outcome: reading.outcome.verdict,
              detail: boundedDiagnostic(completionDetail(reading.outcome)),
              at,
            },
          }),
        (fresh) =>
          accepted
            ? this.acceptedReviewed(fresh, activity, reading.outcome.candidate.commit)
            : this.releaseReviewed(
                fresh,
                activity,
                "ELIGIBLE",
                `independent review returned ${completionDetail(reading.outcome)}`,
              ),
      );
      if (!settled.recorded) {
        const problem =
          `the verdict of review ${review.reviewId} could not be recorded (${settled.problem ?? "unknown reason"}); ` +
          "it is NOT being applied";
        this.log(`[supervisor] ${problem}`);
        return { state: settled.state, refusal: { roadmapKey: activity.roadmapKey, problem: boundedDiagnostic(problem) } };
      }
      this.log(
        `[supervisor] consumed ${reading.outcome.verdict} for ${activity.roadmapKey} (review ${review.reviewId}); ` +
          `${accepted ? "the candidate is at the integration gate" : "remediation is claimable"}`,
      );
      current = settled.state;
    }

    return { state: current };
  }

  /**
   * The roadmap half of consuming a verdict, computed against the FRESH state.
   *
   * Travels with the settlement in one write: an item left ACTIVE beside a
   * completed review is the half-applied shape AC-17 refuses, and a claim left
   * behind would have the next tick conclude its owner vanished.
   */
  private releaseReviewed(
    fresh: SupervisorState,
    activity: Activity,
    status: "ELIGIBLE",
    detail: string,
  ): AlongsideVerdict {
    if (alreadySettled(fresh, activity.id)) {
      return { ok: true, patch: {} };
    }
    return {
      ok: true,
      patch: {
        roadmap: setStatus(fresh.roadmap, activity.roadmapKey, status, boundedDiagnostic(detail)),
        ...this.withoutClaimFor(fresh, activity),
      },
    };
  }

  /**
   * An ACCEPTED candidate stops here, deliberately.
   *
   * ADR-0002 permits integration without a further human decision, and this
   * supervisor still does not perform one: it has no integration executor, and
   * inventing one inside a verdict consumer would put "may this be merged" and
   * "what did the reviewer say" in the same place. What it records is the fact
   * — reviewed, accepted, at the gate, naming the candidate — so the decision
   * is made from durable state by whatever holds that authority.
   */
  private acceptedReviewed(fresh: SupervisorState, activity: Activity, commit: string): AlongsideVerdict {
    if (alreadySettled(fresh, activity.id)) {
      return { ok: true, patch: {} };
    }
    const action =
      `Independent review accepted candidate ${commit} for ${activity.roadmapKey}. Integrate it under ADR-0002 ` +
      "after re-checking that the reviewed tree is the tree being integrated.";
    const escalation: HumanEscalation = {
      roadmapKey: activity.roadmapKey,
      reason: "HUMAN_DECISION_REQUIRED",
      humanActionRequired: boundedDiagnostic(action),
      detail: boundedDiagnostic(`review ${activity.review?.reviewId ?? activity.id} accepted ${commit}`),
      raisedAt: this.deps.clock.now(),
      resolved: false,
    };
    return {
      ok: true,
      patch: {
        roadmap: setStatus(
          fresh.roadmap,
          activity.roadmapKey,
          "WAITING_FOR_HUMAN_REQUIRED",
          boundedDiagnostic(`accepted by independent review; candidate ${commit} is at the integration gate`),
          // The status PRESUPPOSES this, and the parser enforces it: an item
          // waiting on a person that does not say what the person must do is
          // refused as corrupt. Found by writing one.
          boundedDiagnostic(action),
        ),
        escalations: [
          ...fresh.escalations.filter((entry) => entry.resolved || entry.roadmapKey !== activity.roadmapKey),
          escalation,
        ],
        ...this.withoutClaimFor(fresh, activity),
      },
    };
  }

  /** Drops the durable claim IF it is the one this activity belongs to. */
  private withoutClaimFor(fresh: SupervisorState, activity: Activity): Partial<SupervisorState> {
    const claim = fresh.activeClaim;
    if (claim === undefined) {
      return {};
    }
    return canonicalActivityId(claim.roadmapKey, claim.kind, claim.attempt) === activity.id
      ? { activeClaim: undefined }
      : {};
  }

  /**
   * Every conclusion a later observer draws, applied to a list — and NOTHING
   * else.
   *
   * Pure, and a function of the list it is given rather than of the one read at
   * the top of the tick, because it is recomputed on every retry attempt. That
   * is the whole reason it exists as a function: the two writes below used to
   * carry a list computed once, which is fine until somebody else writes first.
   */
  private classifyAll(
    activities: readonly Activity[],
    now: Timestamp,
    probe: LivenessProbe,
  ): TransitionVerdict {
    let next = activities;
    let changed = false;
    for (const activity of activities) {
      const verdict = classifyActivity(activity, { now, stallAfterMs: this.stallAfterMs() }, probe);
      if (verdict === undefined) continue;
      const recorded = recordReconciliation(next, activity.id, {
        verdict: verdict.verdict,
        at: now,
        detail: boundedDiagnostic(verdict.detail),
      });
      if (!recorded.ok) {
        this.log(`[supervisor] could not record a reconciliation verdict: ${recorded.problem}`);
        continue;
      }
      if (recorded.changed) {
        this.log(`[supervisor] ${verdict.verdict}: ${verdict.detail}`);
      }
      next = recorded.activities;
      changed = changed || recorded.changed;
    }
    return { ok: true, activities: next, changed };
  }

  /**
   * AC-20's one recovery action, recomputed against whatever the state says NOW.
   *
   * An item with an unresolved claim is left alone: `reconcileClaim` owns that
   * item and is stricter, and both mechanisms firing once produced a requeue
   * that an escalation then overrode — the right answer reached by accident,
   * through two writes that disagreed.
   */
  private requeueCrashed(
    fresh: SupervisorState,
    now: Timestamp,
    probe: LivenessProbe,
  ): Partial<SupervisorState> {
    const classified = this.classifyAll(fresh.activities ?? [], now, probe);
    const claimed = fresh.activeClaim?.roadmapKey;
    const requeue = new Set(
      crashedItemsToRequeue(classified.ok ? classified.activities : (fresh.activities ?? []), fresh.roadmap).filter(
        (key) => key !== claimed,
      ),
    );
    if (requeue.size === 0) {
      // Nothing to move, and an empty patch is what keeps an idle tick from
      // writing the roadmap back to itself forever.
      return {};
    }
    return {
      roadmap: fresh.roadmap.map((item) => {
        if (!requeue.has(item.key)) return item;
        this.log(`[supervisor] returning ${item.key} to the queue: its owner crashed`);
        /**
         * BACKWARDS, into the queue it came from, and never anywhere else. This
         * is the whole of AC-20 in one expression: a crash is a reason to try
         * again and never a reason to be further along than before.
         */
        return { ...item, status: RECOVERY_TO_STATUS };
      }),
    };
  }

  /**
   * The liveness probe for THIS tick: memoised, so every reader of one tick
   * sees the same answer about the same lease. Outside a tick it is the raw
   * dependency, which is what a direct caller should get.
   */
  private livenessProbe(): LivenessProbe | undefined {
    return this.tickProbe ?? this.deps.liveness;
  }

  private async reconcileActivities(
    state: SupervisorState,
  ): Promise<{ readonly state: SupervisorState; readonly refusal?: string }> {
    const activities = state.activities ?? [];
    if (activities.length === 0) {
      return { state };
    }
    const probe = this.livenessProbe();
    if (probe === undefined) {
      /**
       * NO PROBE, WITH WORK IN FLIGHT, IS A REFUSAL (round-3 review, HIGH 2).
       *
       * The comment here used to claim that an unknown refuses, and the code
       * returned the state unchanged and let the tick carry on — so an
       * unfinished activity sat in durable state, nothing concluded anything
       * about it, and the supervisor went and ran a DIFFERENT item to DONE. The
       * comment described the invariant; the code did the opposite of it.
       *
       * A tick that cannot establish whether anything is still working must not
       * schedule more work. It is only reached with activities present, because
       * an installation with none has nothing to be unsure about.
       */
      const unfinished = activities.filter((entry) => !isTerminal(entry.state));
      if (unfinished.length === 0) {
        return { state };
      }
      const problem =
        `${unfinished.length} activit${unfinished.length === 1 ? "y is" : "ies are"} unfinished and this supervisor ` +
        "has no way to check whether their owners are still running; refusing to schedule further work";
      this.log(`[supervisor] ${problem}`);

      /**
       * THE CLASSIFICATION IS RECORDED, NOT ONLY THE REFUSAL (round-6 review,
       * HIGH 2).
       *
       * AC-16 asks that every non-terminal activity be classified and the
       * classification RECORDED; refusing to schedule is the other half. This
       * path did the second and skipped the first, so a fresh process read the
       * activity back with `reconciliation: undefined` and learned nothing
       * about why the Factory had stopped. A refusal that leaves no durable
       * reason is the same defect as a log line standing in for a record.
       */
      /**
       * AND THE RECORD IS WRITTEN THE WAY EVERY OTHER ONE IS (round-7 review,
       * HIGH 3).
       *
       * Round 6 added the classification and wrote it with a RAW commit, so a
       * rival supervisor advancing the state in that instant turned the refusal
       * into a thrown `ConcurrencyError`: no AMBIGUOUS record, and no refusal
       * either — the exception replaced the answer. A durable classification
       * that only survives when nothing else is running is not durable, and a
       * refusal is worth least at exactly the moment it is hardest to write.
       *
       * It goes through `commitActivityChange`, which re-reads and recomputes
       * against what the state now says. The classification is recomputed with
       * it: which activities are unfinished is a property of the FRESH list, so
       * a rival that finished one must not have it re-marked AMBIGUOUS.
       */
      const blind = this.deps.clock.now();
      const written = await this.commitActivityChange(state, "record why liveness cannot be established", (current) => {
        let classified = current;
        let changed = false;
        for (const entry of current.filter((candidate) => !isTerminal(candidate.state))) {
          const recorded = recordReconciliation(classified, entry.id, {
            verdict: "AMBIGUOUS",
            at: blind,
            detail: boundedDiagnostic(
              `activity ${JSON.stringify(entry.id)} is ${entry.state} and this supervisor has no liveness probe, ` +
                "so whether its owner is still running cannot be established",
            ),
          });
          if (!recorded.ok) {
            return recorded;
          }
          classified = recorded.activities;
          changed = changed || recorded.changed;
        }
        return { ok: true, activities: classified, changed };
      });

      /**
       * FAILING TO RECORD IT IS NOT A REASON TO SAY LESS.
       *
       * The tick still refuses — that was never in doubt — but the refusal now
       * carries the fact that the classification could not be made durable, so
       * an operator reading it is not left wondering why the activity they were
       * pointed at has no verdict on it.
       */
      if (!written.recorded) {
        return {
          state: written.state,
          refusal: boundedDiagnostic(
            `${problem}. Worse: the reason could not be recorded durably either ` +
              `(${written.problem ?? "unknown reason"}), so a fresh process will find these activities ` +
              "unclassified",
          ),
        };
      }
      return { state: written.state, refusal: boundedDiagnostic(problem) };
    }

    const now = this.deps.clock.now();
    /**
     * ONE TICK, ONE ANSWER ABOUT ONE LEASE (round-9 review, HIGH 1).
     *
     * `classifyAll` and `requeueCrashed` each asked the probe, so a process that
     * exited between the two calls was LIVE to one and GONE to the other — and
     * the reviewer drove exactly that: a durable `LIVE` activity beside a
     * roadmap item requeued as crashed, written together, contradicting each
     * other. Recomputing per attempt was the round-8 fix and remains right; what
     * was wrong is that recomputing also re-OBSERVED.
     *
     * A lease is asked about once per tick and the answer is reused. It is the
     * same rule the rest of this mechanism already follows — decide from one
     * observation, and never let two readings of the same fact disagree inside a
     * single decision.
     */
    const classified = this.classifyAll(activities, now, probe);
    // Only the LIST is read here, to decide whether anything is AMBIGUOUS.
    // Whether it CHANGED is decided by the write below, which recomputes the
    // classification against whatever the state says at that moment.
    const next = classified.ok ? classified.activities : activities;

    /**
     * AMBIGUOUS REFUSES THE TICK (round-5 review, HIGH 1).
     *
     * AC-16 says so in as many words, and the round-3 fix only made the
     * NO-PROBE case refuse: with a probe that answered UNKNOWN the verdict was
     * recorded and the tick carried on and ran a different item to DONE. An
     * activity whose owner cannot be checked is exactly the case where a second
     * owner must not start, and recording that fact while proceeding is not
     * refusing — it is annotating.
     *
     * Checked AFTER the verdicts are written, so the refusal leaves a durable
     * record of WHY behind it rather than only a message in a log.
     */
    const ambiguous = next.filter((entry) => entry.reconciliation?.verdict === "AMBIGUOUS");
    if (ambiguous.length > 0) {
      /**
       * AND THIS WRITE IS RETRIED TOO (round-8 review, HIGH 1).
       *
       * Round 7 hardened the NO-PROBE path and left this one on a raw commit —
       * the same defect, one branch over, in the branch that actually runs in
       * production. A rival advancing the state here turned the refusal into a
       * thrown `ConcurrencyError`: no durable AMBIGUOUS record, and no refusal.
       * Fixing the case you reproduced and not its twin is how a defect comes
       * back wearing different clothes.
       */
      const written = await this.commitActivityChange(
        state,
        "record why work in flight cannot be established",
        (current) => this.classifyAll(current, now, probe),
      );
      const problem =
        `${ambiguous.length} activit${ambiguous.length === 1 ? "y" : "ies"} cannot be established as running or ` +
        `finished (${ambiguous.map((entry) => entry.id).join(", ")}); refusing to schedule further work`;
      this.log(`[supervisor] ${problem}`);
      return {
        state: written.state,
        refusal: boundedDiagnostic(
          written.recorded
            ? problem
            : `${problem}. Worse: the reason could not be recorded durably either ` +
                `(${written.problem ?? "unknown reason"})`,
        ),
      };
    }

    /**
     * AC-19. A completion nothing has acted on is REPORTED, every tick, until
     * something does. This is the answer to "the result has existed for hours
     * and nobody noticed": it is read out of durable state rather than waited
     * for, so a notification that was never delivered changes nothing.
     */
    for (const waiting of unobservedCompletions(next)) {
      this.log(
        `[supervisor] unobserved ${waiting.state} activity ${waiting.id}: ` +
          `${waiting.completion?.outcome ?? "no outcome"}`,
      );
    }

    /**
     * The one recovery ACTION. Its gate lives inside the function that proposes
     * it, with the reasoning, rather than here at the call site.
     *
     * AN ITEM WITH AN UNRESOLVED CLAIM IS LEFT ALONE (round-3 review, AC-20
     * "Partial"). `reconcileClaim` owns that item and is STRICTER: a RUNNING
     * claim whose owner is gone means the external action's outcome is
     * unknowable, and it escalates for a human rather than re-queueing. Both
     * mechanisms firing produced a requeue to PENDING that the escalation then
     * overrode to BLOCKED — the right answer reached by accident, through two
     * writes that disagreed.
     *
     * Precedence is explicit now: the claim decides for its own item, and this
     * re-queues everything else.
     */
    const written = await this.commitActivityChange(
      state,
      "reconcile the work in flight",
      (current) => this.classifyAll(current, now, probe),
      (fresh) => ({ ok: true, patch: this.requeueCrashed(fresh, now, probe) }),
    );
    if (!written.recorded) {
      const problem =
        `work in flight could not be reconciled (${written.problem ?? "unknown reason"}); refusing to schedule ` +
        "further work while what is running is unrecorded";
      this.log(`[supervisor] ${problem}`);
      return { state: written.state, refusal: boundedDiagnostic(problem) };
    }

    /**
     * AND THE AMBIGUITY CHECK IS MADE ON WHAT WAS ACTUALLY WRITTEN (round-9
     * review, HIGH 2).
     *
     * The check above reads the classification computed from the state as it
     * was READ. The write below it recomputes against the state as it turned
     * out to be, and a retry can therefore persist an AMBIGUOUS verdict that
     * nothing then looks at — the reviewer ran a different item to DONE in the
     * same tick that durably recorded one. Asking the question once, of the
     * snapshot, is the same "decided before it was written" mistake this
     * function keeps producing; it is now asked of the result.
     */
    const unresolved = (written.state.activities ?? []).filter(
      (entry) => entry.reconciliation?.verdict === "AMBIGUOUS" && !isTerminal(entry.state),
    );
    if (unresolved.length > 0) {
      const problem =
        `${unresolved.length} activit${unresolved.length === 1 ? "y" : "ies"} cannot be established as running or ` +
        `finished (${unresolved.map((entry) => entry.id).join(", ")}); refusing to schedule further work`;
      this.log(`[supervisor] ${problem}`);
      return { state: written.state, refusal: boundedDiagnostic(problem) };
    }
    return { state: written.state };
  }

  /**
   * The declared upgrade steps that apply to THIS installation (TASK-018 AC-3).
   *
   * An INJECTED catalog gets none. `CATALOG_UPGRADE_STEPS` describes the past of
   * `DEFAULT_ROADMAP` specifically, and applying it to a catalog someone else
   * supplied would compare their rows against a history those rows never had —
   * which is exactly the silent misreading this mechanism exists to refuse.
   */
  private catalogUpgradeSteps(): readonly CatalogUpgradeStep[] {
    if (this.deps.catalogUpgradeSteps !== undefined) {
      return this.deps.catalogUpgradeSteps;
    }
    return this.deps.roadmapCatalog === undefined ? CATALOG_UPGRADE_STEPS : [];
  }

  /**
   * Applies a declared catalog upgrade, or refuses (TASK-018 AC-1..AC-9).
   *
   * RUNS BEFORE RECONCILIATION, and that order is the whole point. After a
   * definition changes in the catalog, reconciliation is guaranteed to refuse
   * the persisted rows — correctly, because it cannot tell a legitimate release
   * from a hand edit. This is the one thing that can, because it compares the
   * rows against the version they claim to be at rather than against the
   * version this build wants them to reach.
   *
   * It writes through `applyCatalogUpgrade` rather than `commit`, because the
   * roadmap and the recorded version have to move in one transaction.
   */
  private async upgradeCatalog(
    state: SupervisorState,
  ): Promise<{ readonly state: SupervisorState; readonly result?: TickResult }> {
    /**
     * A CORRUPT VERSION RECORD IS AN ANSWER, NOT AN EXCEPTION (round-1 review).
     *
     * The same lesson as the round-8 HIGH above: a nonsense
     * `roadmap_catalog_version` made the repository throw
     * `SchemaIntegrityError`, and the supervisor produced a stack trace instead
     * of a decision. Nothing was written and no executor ran, so it was not a
     * bypass — but from an operator's side a crash and a refusal are not the
     * same event.
     *
     * DELIBERATELY NARROW, for the reason that comment gives. Only this READ is
     * converted. A refusal to WRITE keeps propagating, because that is the
     * repository enforcing its own integrity and no caller should be able to
     * mistake it for a verdict.
     */
    let recorded: number | undefined;
    try {
      recorded = await this.deps.repository.readCatalogVersion();
    } catch (error) {
      if (!(error instanceof SchemaIntegrityError)) {
        throw error;
      }
      this.log(`[supervisor] the recorded roadmap catalog version could not be read: ${error.message}`);
      return {
        state,
        result: {
          kind: "WAITING_FOR_HUMAN",
          roadmapKey: state.roadmap[0]?.key ?? "unknown",
          reason: "HUMAN_DECISION_REQUIRED",
          humanActionRequired: boundedDiagnostic(
            `${error.message}. Which catalog this database is at cannot be established, so no upgrade and no ` +
              "reconciliation can be trusted. Restore the supervisor database from a known-good backup.",
          ),
        },
      };
    }
    const verdict = planCatalogUpgrade({
      ...(recorded === undefined ? {} : { recordedVersion: recorded }),
      persisted: state.roadmap,
      buildVersion: this.deps.catalogVersion ?? ROADMAP_CATALOG_VERSION,
      steps: this.catalogUpgradeSteps(),
    });

    if (verdict.kind === "ALREADY_CURRENT") {
      return { state };
    }
    if (verdict.kind === "REFUSE") {
      /**
       * THE PROBLEM GOES FIRST, for the same reason `structuralRefusal` says so:
       * `boundedDiagnostic` truncates, and a shared preamble pushes the specific
       * finding off the end of exactly the message an operator reads. The first
       * draft of this one led with the preamble and cut the offending field name
       * in half — "workCla…" — which a test caught before a person had to.
       */
      const action =
        `${verdict.problem}. The roadmap catalog cannot be upgraded to the one this build declares, so what an ` +
        "item IS cannot be established. Run a build that declares that version, or restore from a known-good backup.";
      this.log(`[supervisor] roadmap catalog upgrade refused: ${verdict.problem}`);
      return {
        state,
        result: {
          kind: "WAITING_FOR_HUMAN",
          roadmapKey: state.roadmap[0]?.key ?? "unknown",
          reason: "HUMAN_DECISION_REQUIRED",
          humanActionRequired: boundedDiagnostic(action),
        },
      };
    }

    /**
     * The audit record is appended BEFORE the write and travels inside the same
     * transaction (AC-7). Recording it afterwards would leave a window in which
     * the definitions had moved and nothing said why — which is the state a
     * hand edit produces, and the one this record exists to distinguish from.
     */
    const appended = appendProvenance(state.provenance, {
      kind: "CATALOG_UPGRADED",
      roadmapKey: verdict.auditKey,
      detail: verdict.detail,
      recordedAt: this.deps.clock.now(),
    });
    if (!appended.ok) {
      this.log(`[supervisor] roadmap catalog upgrade could not be recorded: ${appended.reason}`);
      return {
        state,
        result: {
          kind: "WAITING_FOR_HUMAN",
          roadmapKey: state.roadmap[0]?.key ?? "unknown",
          reason: "HUMAN_DECISION_REQUIRED",
          humanActionRequired: boundedDiagnostic(
            `The roadmap catalog upgrade cannot be recorded in durable provenance (${appended.reason}), and an ` +
              "upgrade that leaves no record is indistinguishable from a hand edit. Nothing was changed.",
          ),
        },
      };
    }

    const next: SupervisorState = {
      ...state,
      version: state.version + 1,
      roadmap: verdict.roadmap,
      provenance: appended.chain,
      provenanceAnchor: anchorFor(appended.chain),
    };
    const saved = await this.deps.repository.applyCatalogUpgrade(next, state.version, verdict.to);
    this.log(`[supervisor] ${verdict.detail}`);
    return { state: saved };
  }

  private async catalogState(
    state: SupervisorState,
  ): Promise<{ readonly state: SupervisorState; readonly result?: TickResult }> {
    // The upgrade first: after a declared definition change, reconciliation
    // would otherwise refuse rows that are legitimately at the older version.
    const upgraded = await this.upgradeCatalog(state);
    if (upgraded.result !== undefined) {
      return upgraded;
    }
    state = upgraded.state;

    const verdict = reconcileRoadmapWithCatalog(state.roadmap, this.roadmapCatalog());
    if (!verdict.ok) {
      return { state, result: this.structuralRefusal(state, verdict.problem) };
    }
    if (sameRoadmap(state.roadmap, verdict.roadmap)) {
      return { state };
    }
    // The only change reconciliation can make without refusing is APPENDING
    // catalog entries this installation has not seen — an ordinary upgrade.
    return { state: await this.commit(state, { ...state, roadmap: verdict.roadmap }) };
  }

  /**
   * A DIFFERENT refusal from the catalog mismatch, and worded differently.
   *
   * Not cosmetic: `boundedDiagnostic` truncates, so a shared preamble pushes the
   * specific finding off the end of exactly the message an operator reads. The
   * problem goes first, and the instruction follows it.
   */
  private unprovenRefusal(state: SupervisorState, problem: string): TickResult {
    this.log(`[supervisor] completion without provenance: ${problem}`);
    return {
      kind: "WAITING_FOR_HUMAN",
      roadmapKey: state.roadmap[0]?.key ?? "unknown",
      reason: "HUMAN_DECISION_REQUIRED",
      humanActionRequired: boundedDiagnostic(
        `${problem}. Establish what actually ran, or restore the supervisor database from a known-good backup.`,
      ),
    };
  }

  private structuralRefusal(state: SupervisorState, problem: string): TickResult {
    const action =
      "The persisted roadmap does not match this installation's catalog, so what an item IS cannot be " +
      `established from durable state. Restore the supervisor database from a known-good backup. Detail: ${problem}`;
    this.log(`[supervisor] roadmap structure refused: ${problem}`);
    return {
      kind: "WAITING_FOR_HUMAN",
      roadmapKey: state.roadmap[0]?.key ?? "unknown",
      reason: "HUMAN_DECISION_REQUIRED",
      humanActionRequired: boundedDiagnostic(action),
    };
  }

  private brokenChainOutcome(state: SupervisorState): TickResult | undefined {
    /**
     * AN EMPTY CHAIN IS ONLY SILENCE IF NOTHING SAYS OTHERWISE (round-6
     * CRITICAL).
     *
     * The early return skipped the anchor check whenever the chain was empty,
     * so deleting the WHOLE chain — while leaving an anchor saying it had two
     * entries — read as a legacy database with no history. The reviewer then
     * had Codex review its own work.
     *
     * The anchor exists precisely to make deletion visible; letting the
     * deletion decide whether the anchor is consulted inverts it. An empty
     * chain with an anchor claiming entries is the loudest possible
     * contradiction.
     */
    /**
     * A zero-length anchor still ASSERTS SOMETHING (round-7 CRITICAL).
     *
     * The early return checked only the anchor's LENGTH, so an anchor claiming
     * zero entries but a non-genesis head — a contradiction on its face —
     * skipped verification entirely. An anchor is a claim about the whole
     * chain, and half of the claim is the head.
     */
    if (chainIsLegacySilence(state)) {
      return undefined;
    }
    const verdict = verifyAgainstAnchor(state.provenance, state.provenanceAnchor);
    if (verdict.intact) {
      return undefined;
    }
    const action =
      "Durable provenance no longer verifies, so who implemented what cannot be established and no review " +
      `can be trusted. Restore the supervisor database from a known-good backup. Detail: ${verdict.problem}`;
    this.log(`[supervisor] provenance chain is broken: ${verdict.problem}`);
    return {
      kind: "WAITING_FOR_HUMAN",
      roadmapKey: state.roadmap[0]?.key ?? "unknown",
      reason: "HUMAN_DECISION_REQUIRED",
      humanActionRequired: boundedDiagnostic(action),
    };
  }

  private async escalate(
    state: SupervisorState,
    roadmapKey: string,
    reason: EscalationReason,
    humanActionRequired: string,
    detail: string,
  ): Promise<SupervisorState> {
    const escalation: HumanEscalation = {
      roadmapKey,
      reason,
      // Bounded like every other persisted diagnostic. An action description
      // can originate outside this module, and an unbounded string that is
      // logged AND persisted is how a stray payload or transcript ends up in
      // durable state (C6/C8).
      humanActionRequired: boundedDiagnostic(humanActionRequired),
      detail: boundedDiagnostic(detail),
      raisedAt: this.deps.clock.now(),
      resolved: false,
    };
    const status = reason === "RECOVERY_REQUIRED" ? "BLOCKED" : "WAITING_FOR_HUMAN_REQUIRED";
    this.log(`[supervisor] ${roadmapKey} needs a human (${reason}): ${humanActionRequired}`);
    /**
     * SUPERSEDE, do not accumulate (TASK-009 AC-5).
     *
     * This appended unconditionally, so an item that escalates on every tick —
     * which is exactly what a permanently blocked item does — grew the
     * escalations array without bound, one entry per tick, forever. Latent in
     * TASK-006 because nothing had yet stayed blocked across many ticks.
     *
     * An OPEN escalation for the same item is a statement about the item's
     * current condition, so a newer one replaces it rather than queueing behind
     * it. Resolved escalations are history and are kept.
     */
    const superseded = state.escalations.filter(
      (entry) => entry.resolved || entry.roadmapKey !== roadmapKey,
    );
    return this.commit(state, {
      ...state,
      roadmap: setStatus(
        state.roadmap,
        roadmapKey,
        status,
        boundedDiagnostic(detail),
        boundedDiagnostic(humanActionRequired),
      ),
      escalations: [...superseded, escalation],
    });
  }

  /** Stamps version and timestamp; throws on a lost CAS rather than guessing. */
  private async commit(previous: SupervisorState, next: SupervisorState): Promise<SupervisorState> {
    const candidate: SupervisorState = {
      ...next,
      version: previous.version + 1,
      updatedAt: this.deps.clock.now(),
    };
    try {
      return await this.deps.repository.compareAndSave(candidate, previous.version);
    } catch (error) {
      if (error instanceof ConcurrencyError) {
        throw new ConcurrencyError("another supervisor tick advanced this state; re-read and retry");
      }
      throw error;
    }
  }
}

// =====================================================================
// Pure helpers
// =====================================================================

function reasonForClass(actionClass: string): EscalationReason {
  switch (actionClass) {
    case "FINANCIAL_ACTION":
      return "FINANCIAL_ACTION_REQUIRED";
    case "HUMAN_CREDENTIAL_ACTION":
      return "HUMAN_CREDENTIAL_REQUIRED";
    case "PUBLICATION_ACTION":
      return "PUBLICATION_APPROVAL_REQUIRED";
    case "DESTRUCTIVE_ACTION":
      return "DESTRUCTIVE_APPROVAL_REQUIRED";
    default:
      return "RECOVERY_REQUIRED";
  }
}

/**
 * A provider-stated reset time, when the provider stated one, overrides the
 * classifier's backoff-driven default. TASK-006 never invents such a time.
 */
function classifyOutcome(outcome: Extract<WorkOutcome, { kind: "RESOURCE_FAILURE" }>): Classification {
  const base = classifyResourceOutcome({ process: outcome.process });
  return outcome.retryAt === undefined ? base : { ...base, retryAt: outcome.retryAt };
}

/**
 * Sets an item's status, redacting and bounding the text that goes with it.
 *
 * NEW-SEC-1, second occurrence. Round 3 sanitized `SessionCheckpoint` because
 * its strings come from an executor — but `WorkOutcome.detail` comes from the
 * same place and was written into `RoadmapItem.detail` verbatim on the
 * COMPLETED and CHECKPOINT paths. A credential in a worker's completion message
 * therefore still reached durable state, through a different field.
 *
 * Sanitizing here rather than at each call site is the point: this is the only
 * way item text is ever set, so no future path can forget. The supervisor's own
 * strings pass through unharmed — redaction of text containing no secret is the
 * identity function.
 */
export function setStatus(
  roadmap: readonly RoadmapItem[],
  key: string,
  status: RoadmapItem["status"],
  detail?: string,
  humanActionRequired?: string,
): readonly RoadmapItem[] {
  return roadmap.map((item) =>
    item.key === key
      ? {
          ...item,
          status,
          ...(detail === undefined ? {} : { detail: boundedDiagnostic(detail) }),
          ...(humanActionRequired === undefined
            ? {}
            : { humanActionRequired: boundedDiagnostic(humanActionRequired) }),
        }
      : item,
  );
}

/**
 * Whether the resource a financial verdict was issued for is the resource about
 * to be launched (F6-FIN-1).
 *
 * Extracted and exported because of review finding R7-C3-1, and the honest
 * account of what this is worth belongs here rather than in a commit message:
 *
 * In the current `runItem`, the minted resource and the launched resource are
 * both computed from the same `config.option`, so they CANNOT disagree — delete
 * the call site and every test still passes, which is precisely what the seventh
 * review found. (An earlier mutation run appeared to verify the guard, but it had
 * broken `mintedResourceKey`, which TRIPS the guard rather than removing it.
 * Mutating the wrong line proves the wrong thing.)
 *
 * So this is an INVARIANT ASSERTION, not a reachable branch: it exists to catch a
 * future refactor in which the mint and the launch stop sharing a source — which
 * is exactly the kind of drift that produced F6-FIN-1 in the first place. Tested
 * directly, as a function, because that is the only place its behaviour is
 * observable. Keeping it and being clear about its status beats deleting a cheap
 * assertion or overstating a test.
 */
export function resourceBindingHolds(cleared: string | undefined, launching: string | undefined): boolean {
  return launching !== undefined && cleared === launching;
}

/**
 * Reads a worker's reported identity ONCE, into inert data (R8-ID-1).
 *
 * REVIEW FINDING R8-ID-1 (HIGH), introduced by the R7-ID-1 fix. Validating the
 * report and then reconciling it are two reads, and an object whose properties
 * are GETTERS — or a Proxy — can answer differently each time. The eighth review
 * built one returning valid strings to the validity check and `undefined` to
 * reconciliation, and the run reached DONE carrying `UNVERIFIED`. A
 * time-of-check/time-of-use gap is not fixed by checking harder.
 *
 * So the report is snapshotted here, once, into a plain object with only
 * own data properties, and every later step uses THAT. Whatever the original
 * was — accessor, Proxy, exotic — it is read exactly one time and never
 * consulted again.
 *
 * A property that is not an own data property (a getter, or an inherited value)
 * is simply not copied. It is not an error to be reported; it is a statement
 * that was never made.
 */
function snapshotIdentity(reported: ReportedRunIdentity | undefined): ReportedRunIdentity | undefined {
  if (reported === undefined || typeof reported !== "object") {
    return undefined;
  }
  const snapshot: Record<string, string> = {};
  for (const field of ["provider", "model", "effort"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(reported, field);
    if (descriptor === undefined || typeof descriptor.get === "function") {
      continue;
    }
    const value = descriptor.value;
    if (typeof value === "string" && value.trim().length > 0) {
      snapshot[field] = value;
    }
  }
  return Object.freeze(snapshot);
}

/**
 * Whether a worker actually SAID what it ran (R7-ID-1), judged on the snapshot.
 *
 * The first version of the F6-ID-1 check asked only whether a report object was
 * present, so `reportedIdentity: {}` — and an object inheriting the right values
 * from a polluted prototype — satisfied it and the item reached DONE. Presence
 * of a container is not a statement about its contents; that is the same
 * mistake as treating an absent field as agreement, arriving from the other
 * direction.
 *
 * Provider AND model are required. Effort is optional here because a run may
 * legitimately request none, and `reconcileReportedIdentity` independently
 * refuses to call such a run verified.
 */
function statesItsIdentity(snapshot: ReportedRunIdentity | undefined): boolean {
  return snapshot?.provider !== undefined && snapshot.model !== undefined;
}

/**
 * Freezes an object and everything reachable from it (R7-SEC-1).
 *
 * `Object.freeze` is shallow, so freezing a `WorkExecutionInput` while leaving
 * `item.declaredActionKinds` writable protects nothing that matters. Cycles are
 * not expected in this data — it is all plain serialisable state — but the
 * visited set costs nothing and means a future shape cannot turn this into a
 * hang.
 */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

/**
 * Redacts and bounds every human-readable string on a tick result (F5-SEC-2).
 *
 * A `TickResult` is printed by the CLI, and the fifth review found provider text
 * reaching it verbatim through the new pre-launch probe path — the same class of
 * leak as NEW-SEC-1 and F4-5, arriving through the field nobody had counted as
 * durable because it "only" goes to a console. It goes to a console, a terminal
 * scrollback, a systemd journal and whatever a timer redirects it to.
 *
 * Sanitizing at the single exit point rather than at each of the dozen `return`
 * sites is deliberate, and is the same reasoning as `setStatus`: a rule applied
 * at one chokepoint cannot be forgotten by a path added later.
 */
function sanitizeTickResult(result: TickResult): TickResult {
  switch (result.kind) {
    case "ADVANCED":
      return { ...result, detail: boundedDiagnostic(result.detail) };
    case "IDLE":
      return { ...result, reason: boundedDiagnostic(result.reason) };
    case "WAITING_FOR_RESOURCE":
      return { ...result, reason: boundedDiagnostic(result.reason) };
    case "WAITING_FOR_HUMAN":
      return { ...result, humanActionRequired: boundedDiagnostic(result.humanActionRequired) };
    case "RECOVERY_REQUIRED":
      return { ...result, reason: boundedDiagnostic(result.reason) };
  }
}

/**
 * Sets — or CLEARS — the scheduled wake time (review note, round 4).
 *
 * The spread idiom used everywhere else in this file (`...(x === undefined ? {}
 * : { x })`) is right for building a NEW object and wrong for updating an
 * existing one: spreading `{}` over `state` leaves the previous `nextWakeAt`
 * exactly where it was. So once anything had ever scheduled a wake, the state
 * advertised a wake time forever, including after every resource recovered and
 * there was nothing left to wait for. A stale schedule is a small lie that a
 * timer acts on.
 */
function withWake(state: SupervisorState, wake: Timestamp | undefined): SupervisorState {
  if (wake === undefined) {
    const { nextWakeAt: _cleared, ...rest } = state;
    void _cleared;
    return rest;
  }
  return { ...state, nextWakeAt: wake };
}

/**
 * Records the configuration an AI run was launched with, plus how well the
 * provider's reported identity confirmed it (F4-9).
 *
 * `argvEvidence` is bounded and redacted like every other externally-influenced
 * string that becomes durable state: the argv carries a workspace path and was
 * assembled from configuration, and "it is probably fine" is not the standard
 * this file uses for anything else it writes.
 */
export function setRunConfig(
  roadmap: readonly RoadmapItem[],
  key: string,
  config: AiRunConfigRecord | undefined,
): readonly RoadmapItem[] {
  if (config === undefined) {
    return roadmap;
  }
  const bounded: AiRunConfigRecord = {
    ...config,
    argvEvidence: config.argvEvidence.slice(0, MAX_ARGV_EVIDENCE_ENTRIES).map(boundedDiagnostic),
    note: boundedDiagnostic(config.note),
  };
  return roadmap.map((item) => (item.key === key ? { ...item, lastRunConfig: bounded } : item));
}

/** Bound on how many argv tokens are kept as durable evidence. */
const MAX_ARGV_EVIDENCE_ENTRIES = 64;

/**
 * Dependency-driven eligibility. An item becomes selectable exactly when every
 * prerequisite is DONE — which is the mechanism by which finishing one task
 * automatically starts the next, with no human relaying a prompt.
 *
 * Statuses a human or a resource owns (`WAITING_*`, `BLOCKED`, `ACTIVE`) are
 * never silently promoted; only `PENDING` is.
 */
export function recomputeEligibility(roadmap: readonly RoadmapItem[]): readonly RoadmapItem[] {
  const done = new Set(roadmap.filter((item) => item.status === "DONE").map((item) => item.key));
  return roadmap.map((item) => {
    if (item.status !== "PENDING") {
      return item;
    }
    return item.dependsOn.every((dependency) => done.has(dependency)) ? { ...item, status: "ELIGIBLE" } : item;
  });
}

/**
 * Returns items parked in `WAITING_FOR_RESOURCE` to the queue once SOMETHING is
 * usable again, so routing can re-decide.
 *
 * Gated on `anyUsable` rather than run unconditionally: while every resource is
 * still cooling down there is nothing to re-decide, and promoting anyway would
 * make each tick re-run routing for no reason. Routing is local and free, but a
 * tick that reports "still waiting" is clearer than one that reports "waiting"
 * after pretending to try.
 *
 * `WAITING_FOR_HUMAN_REQUIRED` and `BLOCKED` are deliberately NOT promoted: a
 * timer cannot supply a password, authorize a purchase, or resolve corruption.
 */
export function promoteWaitingItems(
  roadmap: readonly RoadmapItem[],
  anyUsable: boolean,
): readonly RoadmapItem[] {
  if (!anyUsable) {
    return roadmap;
  }
  return roadmap.map((item) => (item.status === "WAITING_FOR_RESOURCE" ? { ...item, status: "ELIGIBLE" } : item));
}

/** Lowest `order` among items that may run now. */
/**
 * The next item to run — RE-DERIVED, not read.
 *
 * REVIEW FINDING R7-DAG-1 (HIGH): this selected on the stored `ELIGIBLE` status
 * alone, so a row saying `ELIGIBLE` while its prerequisite was still `PENDING`
 * ran anyway, and dependent work completed before the work it depends on. The
 * status is written by `recomputeEligibility`, which is correct — but that makes
 * it a CACHE of a dependency computation, and this codebase has one rule about
 * that which it keeps having to relearn:
 *
 *   A PERSISTED STATUS IS A CHECKPOINT, NEVER AUTHORITY.
 *
 * So eligibility is re-derived here from the dependency graph at the moment of
 * selection. The stored status still gates which items are CANDIDATES (a human
 * or a resource owns `WAITING_*`, `BLOCKED`, `ACTIVE`, and those are not
 * silently overridden); it just no longer settles the question on its own.
 */
export function selectNextItem(roadmap: readonly RoadmapItem[]): RoadmapItem | undefined {
  const byKey = new Map(roadmap.map((item) => [item.key, item]));
  const dependenciesSatisfied = (item: RoadmapItem): boolean =>
    item.dependsOn.every((dependency) => byKey.get(dependency)?.status === "DONE");
  return [...roadmap]
    .filter((item) => item.status === "ELIGIBLE" && dependenciesSatisfied(item))
    .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1))
    .at(0);
}

/**
 * Every resource that has ever implemented an item, newest first.
 *
 * REVIEW FINDING F5-C4-1 (HIGH): `implementedByResourceKey` was overwritten on
 * each run, so an item implemented by Claude and later remediated by Codex
 * remembered only Codex — and Claude was free to "independently" review work it
 * had written. C4 is about who touched the work, and that is a set that only
 * ever grows. The scalar field is kept as the MOST RECENT implementer for
 * display and compatibility; the history is what the exclusion reads.
 */
export function implementerHistory(item: RoadmapItem): readonly string[] {
  const history = item.implementedByResourceKeys ?? [];
  if (item.implementedByResourceKey !== undefined && !history.includes(item.implementedByResourceKey)) {
    return [item.implementedByResourceKey, ...history];
  }
  return history;
}

/**
 * Records which resource performed work on an item (N-2, F5-C4-1), so a later
 * independent review of it — or of anything depending on it — can exclude that
 * resource even after the item's checkpoint has been discarded.
 *
 * APPEND-ONLY. A rerun adds to the history rather than replacing it.
 */
export function setImplementer(
  roadmap: readonly RoadmapItem[],
  key: string,
  resourceKeyValue: string | undefined,
): readonly RoadmapItem[] {
  if (resourceKeyValue === undefined) {
    return roadmap;
  }
  return roadmap.map((item) => {
    if (item.key !== key) {
      return item;
    }
    const history = implementerHistory(item);
    return {
      ...item,
      implementedByResourceKey: resourceKeyValue,
      /**
       * NOT truncated (F6-C4-1). The previous version kept the newest 32 and
       * dropped the oldest, which is precisely the wrong end: an evicted
       * implementer silently stops being excluded, so a long-lived item quietly
       * regains the ability to review its own earliest work. "Append-only with
       * eviction" is not append-only.
       *
       * Unbounded growth is not a real risk here — an item's attempts are capped
       * by MAX_REMEDIATION_ATTEMPTS and the resource catalog is a handful of
       * entries, so the set is small by construction. If that ever changes, the
       * fix is to fail closed on overflow, never to forget.
       */
      implementedByResourceKeys: history.includes(resourceKeyValue)
        ? history
        : [resourceKeyValue, ...history],
    };
  });
}

/**
 * Appends the SECOND record of who implemented an item (TASK-008 AC-1, AC-6).
 *
 * Written at the same moment as `setImplementer`, from the same value, so the
 * two records agree unless something later edits one of them — which is
 * precisely the event the chain exists to make visible.
 *
 * OVERFLOW THROWS (round-1 review finding). The first version returned the old
 * chain unchanged and called that fail-closed, which it was not: the caller
 * committed the completion anyway, so the mutable row gained an implementer,
 * the chain did not, and the two records silently diverged. "The cross-check
 * will notice later" is not a response — it makes the NEXT review wait for a
 * human because of a bookkeeping failure here, and loses the record of what
 * actually ran.
 *
 * Dropping the oldest entry to make room is not an option either: that discards
 * exactly the provenance an attacker most wants gone. So the write refuses, the
 * tick fails, and an operator sees why.
 */
export class ProvenanceOverflowError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ProvenanceOverflowError";
  }
}

/**
 * Whether an empty chain is genuine LEGACY SILENCE rather than a deletion.
 *
 * ONE implementation, because there were two (round-8 test-integrity note). The
 * same three-part test was written out in `brokenChainOutcome` and again inside
 * the reviewer-exclusion loop, and a reviewer's mutation of either copy left
 * every test green — each was masked by the other. Two copies of a rule are two
 * rules that can disagree, and a duplicated guard cannot be proven load-bearing
 * because there is always another one behind it.
 *
 * A database written before TASK-008 has no entries for work already done, and
 * refusing every review on that basis would strand the roadmap this protects. So
 * an empty chain is permitted — but ONLY when no anchor says otherwise, in
 * either field: an anchor claiming entries, or claiming none while naming a
 * non-genesis head, is a contradiction and the loudest evidence of deletion
 * there is. That residue is recorded in docs/KNOWN-LIMITATIONS.md.
 */
/** Whether two roadmaps are the same list, item for item and field for field. */
function sameRoadmap(a: readonly RoadmapItem[], b: readonly RoadmapItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index];
      return other !== undefined && JSON.stringify(item) === JSON.stringify(other);
    })
  );
}

export function chainIsLegacySilence(state: {
  readonly provenance: readonly ProvenanceEntry[];
  readonly provenanceAnchor?: { readonly length: number; readonly headDigest: string };
}): boolean {
  if (state.provenance.length !== 0) {
    return false;
  }
  const anchor = state.provenanceAnchor;
  if (anchor !== undefined && !(anchor.length === 0 && anchor.headDigest === GENESIS_DIGEST)) {
    return false;
  }
  /**
   * WHY AN EMPTY CHAIN IS STILL SILENCE HERE, and what changed under it.
   *
   * This comment used to say that after deleting the implementer history, the
   * `lastRunConfig`, the chain and the anchor, what remained was byte-for-byte a
   * database where the work never happened — and that keying on `attempts` would
   * strand an item after an ordinary crash before launch.
   *
   * BOTH HALVES ARE NOW FALSE, and the correction is elsewhere in this file.
   * Round-11 review pointed out that `attempts` survives that deletion, and its
   * answer to the crash objection was better than the objection: claim
   * reconciliation ALREADY proves a launch never happened, so it records
   * `unlaunchedAttempts`. `attempts - unlaunchedAttempts` is the number that
   * reached a worker, and `unprovenCompletion` refuses an item that has more
   * than zero of those and no lineage.
   *
   * So the deletion case is caught — by that check, not by this function. What
   * this one still answers is narrower and unchanged: given an EMPTY chain with
   * no anchor and nothing else contradicting it, is that legacy silence? Yes,
   * because a database written before provenance existed looks exactly like
   * that, and refusing every such installation would strand the roadmap this
   * protects.
   *
   * The remaining floor is recorded in docs/KNOWN-LIMITATIONS.md L-4: an
   * attacker who deletes the progress counters as well leaves state genuinely
   * consistent with work never having happened, and no keyless scheme can tell
   * those apart.
   */
  return true;
}

/**
 * What the chain records about HOW a run ended.
 *
 * Keyed by outcome so hoisting the recording out of the branches does not cost
 * the description each branch used to write. A `Record` rather than a switch so
 * that a new `WorkOutcome` variant fails to COMPILE until someone says what it
 * means for lineage.
 */
/** The role name for the resource the ROUTER chose, as opposed to a plan's. */
const ROUTED_ROLE = "routed";

/**
 * What is wrong with a declaration, or `undefined` when nothing is.
 *
 * Returns the FIRST problem rather than all of them: an operator fixes one and
 * re-runs, and a list invites fixing the easy one and re-reading the rest as
 * advisory. Every branch here refuses the whole action.
 */
function describeDeclarationProblem(declared: readonly RequiredResource[]): string | undefined {
  for (const resource of declared) {
    /**
     * EVERY PROBLEM NAMES THE DECLARED RESOURCE IT IS ABOUT (round-11
     * finding 2). Three declared resources, one refusal: `role "reviewr" is
     * not one of ...` told the operator WHAT was wrong and not WHICH row to
     * fix. Built before any field is validated, so it is available to every
     * branch — bounded per field, because each field is executor text.
     */
    const identity = `declared ${boundedDiagnostic(String(resource.role))} ${boundedDiagnostic(String(resource.provider))}/${boundedDiagnostic(String(resource.model))}${
      resource.effort === undefined ? "" : `:${boundedDiagnostic(String(resource.effort))}`
    }`;
    if (!(REQUIRED_RESOURCE_ROLES as readonly string[]).includes(resource.role)) {
      return `${identity}: role ${JSON.stringify(boundedDiagnostic(String(resource.role)))} is not one of ${REQUIRED_RESOURCE_ROLES.join(", ")}`;
    }
    /**
     * `Object.hasOwn` RATHER THAN INDEXING (round-3 finding 3).
     *
     * A declared provider of `__proto__` resolved to `Object.prototype` through
     * the index, and the next line then threw
     * `models.includes is not a function` — an uncontrolled TypeError out of a
     * validator whose entire job is to produce controlled refusals. Only OWN
     * properties of the table are providers.
     */
    if (!Object.hasOwn(SUPPORTED_MODELS, resource.provider)) {
      return `${identity}: provider ${JSON.stringify(boundedDiagnostic(resource.provider))} is not a provider this build can launch`;
    }
    /**
     * ONE VALIDATOR FOR "CAN THIS BUILD LAUNCH IT" (round-9 finding 2).
     *
     * The previous version kept a PARALLEL validator here: its own
     * `SUPPORTED_MODELS` lookup plus the CODEX effort list applied to EVERY
     * provider. Two validators for one question is the sibling pattern in
     * validation form, and the reviewer found its predicted divergence:
     * `claude-code/opus:max` -- which the installed CLI documents and
     * `planAiRunConfig` accepts -- was refused on the declared path only.
     *
     * `planAiRunConfig` is the validator routing already uses (inside
     * `selectResource`), so declared and routed resources now answer the same
     * question in the same place. The record is DISCARDED: this is validation;
     * the implementer's real record is built at gating time.
     */
    const probe = planAiRunConfig({
      provider: resource.provider as keyof typeof SUPPORTED_MODELS,
      model: resource.model,
      ...(resource.effort === undefined ? {} : { effort: resource.effort }),
      role:
        resource.role === "planner" ? "PLANNER" : resource.role === "implementer" ? "IMPLEMENTER" : "REVIEWER",
    });
    if (!probe.ok) {
      return `${identity}: cannot be launched by this build: ${probe.reason}`;
    }
  }

  /**
   * EXACTLY ONE IMPLEMENTER. Zero means lineage would fall back to the routed
   * resource and record a resource that did not implement; two means it would
   * silently take the first. Both are the C4 defect, and neither is repairable
   * by picking.
   */
  const implementers = declared.filter((resource) => resource.role === "implementer");
  if (implementers.length !== 1) {
    return `a declaration must name exactly one implementer, found ${implementers.length}`;
  }
  return undefined;
}

/** Identity for deduplication: same provider, model and effort is one resource. */
function resourceIdentity(resource: { readonly provider: string; readonly model: string; readonly effort?: string }): string {
  return `${resource.provider} ${resource.model} ${resource.effort ?? ""}`;
}

const LINEAGE_DETAIL: Record<WorkOutcome["kind"], string> = {
  COMPLETED: "completed",
  CHANGES_REQUIRED: "changes required",
  CHECKPOINT: "checkpointed",
  RESOURCE_FAILURE: "resource failure",
  HUMAN_REQUIRED: "stopped for a human",
};

export function appendImplementerProvenance(
  chain: readonly ProvenanceEntry[],
  roadmapKey: string,
  resourceKeyValue: string | undefined,
  recordedAt: Timestamp,
  detail: string,
): readonly ProvenanceEntry[] {
  if (resourceKeyValue === undefined) {
    return chain;
  }
  const result = appendProvenance(chain, {
    kind: "IMPLEMENTED_BY",
    roadmapKey,
    resourceKey: resourceKeyValue,
    detail,
    recordedAt,
  });
  if (!result.ok) {
    throw new ProvenanceOverflowError(
      `cannot record provenance for ${roadmapKey}: ${result.reason}. ` +
        "Refusing to complete the item with only half its records written.",
    );
  }
  return result.chain;
}

/** Records that one claimed attempt provably never reached a worker. */
export function countUnlaunchedAttempt(
  roadmap: readonly RoadmapItem[],
  key: string,
): readonly RoadmapItem[] {
  return roadmap.map((item) =>
    item.key === key ? { ...item, unlaunchedAttempts: (item.unlaunchedAttempts ?? 0) + 1 } : item,
  );
}

/** Records how many action attempts an item has consumed (F-6). */
export function setAttempts(
  roadmap: readonly RoadmapItem[],
  key: string,
  attempts: number,
): readonly RoadmapItem[] {
  return roadmap.map((item) => (item.key === key ? { ...item, attempts } : item));
}

function markSuccess(
  resources: readonly ResourceRecord[],
  key: string | undefined,
  now: Timestamp,
): readonly ResourceRecord[] {
  if (key === undefined) {
    return resources;
  }
  return resources.map((record) =>
    record.key === key
      ? { ...record, state: "AVAILABLE" as ResourceState, lastCheckedAt: now, lastSuccessAt: now, backoff: NO_BACKOFF }
      : record,
  );
}

/** Bound on how many entries a checkpoint list may carry into durable state. */
const MAX_CHECKPOINT_ENTRIES = 50;

/**
 * Redacts and bounds EVERY executor-supplied string on a checkpoint (NEW-SEC-1,
 * F4-5). Only `roadmapKey`, `actionId` and `updatedAt` are exempt, and only
 * because the supervisor overwrites them with its own values at the call site.
 *
 * Review finding F4-5 (HIGH) is the third instance of this same hole in two
 * rounds: round 3 sanitized the list and prose fields, missed `projectId`,
 * `workItemId` and `planId`, and a token placed in those reached durable state.
 * Whitelisting the fields to clean is how you keep missing one, so the list is
 * now written to be exhaustive against the type, and
 * `supervisorStateRoundTrip.test.ts` fails to COMPILE if `SessionCheckpoint`
 * gains a field that is not accounted for here.
 */
function sanitizeCheckpoint(checkpoint: SessionCheckpoint): SessionCheckpoint {
  const list = (values: readonly string[]): readonly string[] =>
    values.slice(0, MAX_CHECKPOINT_ENTRIES).map(boundedDiagnostic);
  const text = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : boundedDiagnostic(value);

  /**
   * R8-SEC-1 (HIGH): CONSTRUCTED, never spread.
   *
   * Every previous version started from `...checkpoint`, which meant the
   * function cleaned the fields it knew about and copied everything else
   * through untouched. A checkpoint carrying `secret: "sk-ant-..."` — a
   * property `SessionCheckpoint` does not declare and the parser silently
   * ignores — was written verbatim into the SQLite JSON. Sanitizing a
   * SUPERSET by naming the members of a subset cannot work, and this is the
   * fourth time a variant of that has been found.
   *
   * So the result is built field by field from the declared type. An undeclared
   * property has nowhere to land, and a NEW declared field is a compile error
   * here rather than a silent passthrough.
   *
   * `resumedFromActionId` is deliberately absent: it is DERIVED by the
   * supervisor from the checkpoint being resumed and re-stamped at the call
   * site (F6-RESUME-1), so an executor's copy must never survive.
   */
  const sanitized: Record<string, unknown> = {
    roadmapKey: checkpoint.roadmapKey,
    actionId: checkpoint.actionId,
    iteration: checkpoint.iteration,
    requiredWorkClass: checkpoint.requiredWorkClass,
    updatedAt: checkpoint.updatedAt,
    completedVerification: list(checkpoint.completedVerification),
    pendingVerification: list(checkpoint.pendingVerification),
    findings: list(checkpoint.findings),
    nextAction: boundedDiagnostic(checkpoint.nextAction),
  };
  for (const [field, value] of [
    ["projectId", text(checkpoint.projectId)],
    ["workItemId", text(checkpoint.workItemId)],
    ["planId", text(checkpoint.planId)],
    ["branch", text(checkpoint.branch)],
    ["baseCommit", text(checkpoint.baseCommit)],
    ["planRevision", checkpoint.planRevision],
  ] as const) {
    if (value !== undefined) {
      sanitized[field] = value;
    }
  }
  return sanitized as unknown as SessionCheckpoint;
}

function upsertCheckpoint(
  checkpoints: readonly SessionCheckpoint[],
  checkpoint: SessionCheckpoint,
): readonly SessionCheckpoint[] {
  const others = checkpoints.filter((entry) => entry.roadmapKey !== checkpoint.roadmapKey);
  return [...others, checkpoint];
}

/** Validates the roadmap DAG. Cycles and dangling references are corruption. */
export function validateRoadmap(roadmap: readonly RoadmapItem[]): void {
  const keys = new Set<string>();
  for (const item of roadmap) {
    if (keys.has(item.key)) {
      throw new ValidationError(`roadmap key "${item.key}" appears more than once`);
    }
    keys.add(item.key);
  }
  for (const item of roadmap) {
    for (const dependency of item.dependsOn) {
      if (!keys.has(dependency)) {
        throw new ValidationError(`roadmap item "${item.key}" depends on unknown "${dependency}"`);
      }
      if (dependency === item.key) {
        throw new ValidationError(`roadmap item "${item.key}" depends on itself`);
      }
    }
  }
  // Kahn's algorithm: anything left over is in a cycle.
  const remaining = new Map(roadmap.map((item) => [item.key, [...item.dependsOn]]));
  let progressed = true;
  while (progressed && remaining.size > 0) {
    progressed = false;
    for (const [key, deps] of [...remaining]) {
      if (deps.every((dependency) => !remaining.has(dependency))) {
        remaining.delete(key);
        progressed = true;
      }
    }
  }
  if (remaining.size > 0) {
    throw new ValidationError(`roadmap contains a dependency cycle involving: ${[...remaining.keys()].sort().join(", ")}`);
  }
}
