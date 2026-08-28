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

import { reconcileRoadmapWithCatalog, unprovenCompletion } from "./roadmapCatalog.js";
import {
  ConcurrencyError,
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
import { reconcileReportedIdentity, type AiRunConfigRecord } from "./modelEnforcement.js";
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
import type {
  ReportedRunIdentity,
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
  readonly log?: (line: string) => void;
  readonly ownerId?: string;
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
   */
  async tick(): Promise<TickResult> {
    let result: TickResult;
    try {
      result = await this.runTick();
    } catch (error) {
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
    await this.publishWake();
    return sanitizeTickResult(result);
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

  private async publishWake(): Promise<void> {
    let state: SupervisorState | undefined;
    try {
      state = await this.deps.repository.load();
    } catch (error) {
      // Same rule, one step earlier: state too corrupt to READ is not this
      // tick's verdict either, and `runTick` has already produced one.
      if (!(error instanceof PersistenceCorruptionError)) {
        throw error;
      }
      return;
    }
    if (state === undefined) {
      return;
    }
    const wake = this.computeNextWake(state);
    if (state.nextWakeAt === wake) {
      return;
    }
    try {
      await this.commit(state, withWake(state, wake));
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

  private async runTick(): Promise<TickResult> {
    const state = await this.ensureInitialized();

    // 0. Refuse before anything tries to WRITE. The repository will not persist
    //    a broken chain, so housekeeping would throw rather than decide.
    const broken = this.brokenChainOutcome(state);
    if (broken !== undefined) {
      return broken;
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
      return catalogued.result;
    }
    const defined = catalogued.state;

    // 1. Reconcile any claim left behind by a previous process.
    const reconciled = await this.reconcileClaim(defined);
    if (reconciled.result !== undefined) {
      return reconciled.result;
    }
    let current = reconciled.state;

    /**
     * 1b. WORK THAT REACHED A WORKER MUST HAVE LEFT LINEAGE (round-11 review).
     *
     * AFTER reconciliation, deliberately. The signal is
     * `attempts - unlaunchedAttempts`, and it is reconciliation that proves an
     * attempt never launched — asking before it runs would refuse an item whose
     * pending claim is about to be cleared as never-launched, which is an
     * ordinary crash rather than a deletion.
     *
     * Before step 3, equally deliberately: eligibility and selection are what
     * lineage protects, and both happen below.
     */
    const unproven = unprovenCompletion({
      roadmap: current.roadmap,
      implementedKeys: new Set(
        current.provenance.filter((entry) => entry.kind === "IMPLEMENTED_BY").map((entry) => entry.roadmapKey),
      ),
    });
    if (unproven !== undefined) {
      return this.unprovenRefusal(current, unproven);
    }

    // 2. Refresh only resources whose retry is actually due. A resource with a
    //    known retryAt in the future is deliberately NOT probed: probing early
    //    costs something and tells us nothing new.
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
        kind: "IDLE",
        reason: pending.length === 0 ? "every roadmap item is DONE" : "no roadmap item is actionable right now",
        ...(wake === undefined ? {} : { nextWakeAt: wake }),
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

    if (claim.state === "CLAIMED") {
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

  private async refreshDueResources(state: SupervisorState): Promise<SupervisorState> {
    const now = this.deps.clock.now();
    const refreshed: ResourceRecord[] = [];
    let changed = false;

    for (const record of state.resources) {
      if (!isRetryDue(record, now)) {
        refreshed.push(record);
        continue;
      }
      // Zero-token by contract: ResourceProbe implementations may not invoke a
      // model (see supervisorPorts.ts).
      const classification = await this.deps.probe.probe(record.provider, record.model);
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
    const diagnostic = boundedDiagnostic(classification.reason);

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

  private async runItem(state: SupervisorState, item: RoadmapItem): Promise<TickResult> {
    const resources = new Map(state.resources.map((record) => [record.key, record]));

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
    if (requiresAi(item.workClass)) {
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
        void escalated;
        return {
          kind: "WAITING_FOR_HUMAN",
          roadmapKey: item.key,
          reason: "HUMAN_DECISION_REQUIRED",
          humanActionRequired: humanAction,
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
          void escalated;
          return { kind: "RECOVERY_REQUIRED", reason: config.reason };
        }
        // Correct request, nothing usable now. This is NOT a failure.
        const waiting = await this.commit(state, {
          ...state,
          roadmap: setStatus(state.roadmap, item.key, "WAITING_FOR_RESOURCE", config.reason),
        });
        const wake = this.computeNextWake(waiting);
        const settled = await this.commit(waiting, withWake(waiting, wake));
        void settled;
        return {
          kind: "WAITING_FOR_RESOURCE",
          roadmapKey: item.key,
          reason: config.reason,
          ...(wake === undefined ? {} : { nextWakeAt: wake }),
        };
      }

      // F4-3: confirm the chosen resource NOW, in this process, before the gate.
      const chosen = resourceKey(config.option.provider, config.option.model);
      const confirmation = await this.deps.probe.probe(config.option.provider, config.option.model);
      const now = this.deps.clock.now();
      state = await this.commit(state, {
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
        const waiting = await this.commit(state, {
          ...state,
          roadmap: setStatus(state.roadmap, item.key, "WAITING_FOR_RESOURCE", reason),
        });
        const wake = this.computeNextWake(waiting);
        state = await this.commit(waiting, withWake(waiting, wake));
        return {
          kind: "WAITING_FOR_RESOURCE",
          roadmapKey: item.key,
          reason,
          ...(wake === undefined ? {} : { nextWakeAt: wake }),
        };
      }
      confirmedBillingMode = this.billingModeFor(
        confirmation.billingMode,
        config.option.provider,
        config.option.model,
      );
      billingObservation = observeBilling({
        provider: config.option.provider,
        model: config.option.model,
        billingMode: confirmedBillingMode,
      });
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
     * The executor this service calls TODAY is in-process, and an in-process
     * function cannot stop code that can already call `fetch`. What this closes
     * is the version of the hole the supervisor CAN close: work that never
     * declared anything and was therefore never asked.
     *
     * Real enforcement — a separate process with restricted credentials — is no
     * longer "a later roadmap item": `createIsolatedExecutor` implements it
     * (TASK-011, on this branch). It is not yet WIRED, because `EXECUTOR_WIRING`
     * depends on both `EXECUTOR_ISOLATION` and `STATE_INTEGRITY` being accepted
     * and integrated first, so production still uses the explicitly named
     * `createUnimplementedExecutor`.
     *
     * That distinction is the whole of the honesty here: the mechanism exists,
     * this path does not use it yet, and this note will be wrong the day the
     * wiring lands if nobody updates it again.
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
      void escalated;
      return {
        kind: "WAITING_FOR_HUMAN",
        roadmapKey: item.key,
        reason: "HUMAN_DECISION_REQUIRED",
        humanActionRequired: humanAction,
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
    const action: SupervisedAction = requiresAi(item.workClass)
      ? launchAiWorkerAction({
          resourceKey: config?.ok === true ? resourceKey(config.option.provider, config.option.model) : "unknown",
          // Observed in this process, moments ago (F4-3), and carried as an
          // observation bound to the resource rather than as a bare string that
          // any caller could have written (R10-FIN-1).
          ...(billingObservation === undefined ? {} : { observation: billingObservation }),
          description: `roadmap item ${item.key}: ${item.title}`,
          ...(item.workClass === "INDEPENDENT_REVIEW" ? { reviewer: true } : {}),
        })
      : // F4-4: this authorises invoking the trusted local executor, and says
        // nothing about any command line. A concrete command must be minted by
        // `verificationCommandAction` against the executable allowlist.
        { kind: "RUN_DETERMINISTIC_WORK", description: `roadmap item ${item.key}: ${item.title}` };

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
        void escalated;
        return {
          kind: "WAITING_FOR_HUMAN",
          roadmapKey: item.key,
          reason: reasonForClass(declaredVerdict.actionClass),
          humanActionRequired: declaredVerdict.humanActionRequired,
        };
      }
    }

    /**
     * F6-FIN-1: the verdict is ABOUT a specific resource, so the thing about to
     * be launched must be that resource. A cleared "included subscription"
     * verdict for one resource is not authorization to run a different one, and
     * before this check nothing compared the two.
     */
    if (requiresAi(item.workClass)) {
      const launching = config?.ok === true ? resourceKey(config.option.provider, config.option.model) : undefined;
      const cleared = mintedResourceKey(action);
      if (!resourceBindingHolds(cleared, launching)) {
        const humanAction = `Investigate ${item.key}: the financial verdict was issued for ${cleared ?? "no resource"} but the launch targets ${launching ?? "no resource"}.`;
        const escalated = await this.escalate(
          state,
          item.key,
          "RECOVERY_REQUIRED",
          humanAction,
          "the cleared resource and the launched resource disagree",
        );
        void escalated;
        return { kind: "RECOVERY_REQUIRED", reason: `resource binding mismatch on ${item.key}` };
      }
    }

    const verdict = evaluateFinancialSafety(action, policy);
    if (!verdict.allowed) {
      const escalated = await this.escalate(
        state,
        item.key,
        reasonForClass(verdict.actionClass),
        verdict.humanActionRequired,
        verdict.reason,
      );
      void escalated;
      return {
        kind: "WAITING_FOR_HUMAN",
        roadmapKey: item.key,
        reason: reasonForClass(verdict.actionClass),
        humanActionRequired: verdict.humanActionRequired,
      };
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
      void escalated;
      return { kind: "RECOVERY_REQUIRED", reason: `remediation budget exhausted for ${item.key}` };
    }

    const actionId = canonicalActionId(item.key, action.kind, attempt);
    const claim: SupervisorActionClaim = {
      actionId,
      roadmapKey: item.key,
      kind: action.kind,
      ...(config?.ok === true ? { resourceKey: resourceKey(config.option.provider, config.option.model) } : {}),
      state: "CLAIMED",
      ownerId: this.ownerId,
      attempt,
      claimedAt: this.deps.clock.now(),
    };
    const claimed = await this.commit(state, {
      ...state,
      activeClaim: claim,
      roadmap: setAttempts(setStatus(state.roadmap, item.key, "ACTIVE"), item.key, attempt),
    });

    // Second durable write: from here the launch may have happened.
    const running = await this.commit(claimed, {
      ...claimed,
      activeClaim: { ...claim, state: "RUNNING" },
    });

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
      void escalated;
      return { kind: "RECOVERY_REQUIRED", reason: `checkpoint identity mismatch on ${item.key}` };
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
          ...(config?.ok === true ? { config: config.config } : {}),
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

    return this.settle(
      running,
      // R7-SEC-1: the snapshot this function captured, never whatever the
      // executor may have left behind in the object it was handed.
      settleItem,
      actionId,
      outcome,
      config?.ok === true ? resourceKey(config.option.provider, config.option.model) : undefined,
      config?.ok === true ? config.config : undefined,
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
  ): Promise<TickResult> {
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
    const reconciled =
      runConfig === undefined
        ? undefined
        : reported === undefined || Object.keys(reported).length === 0
          ? runConfig
          : reconcileReportedIdentity(runConfig, reported);
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
    const lineageProvenance = appendImplementerProvenance(
      state.provenance,
      item.key,
      usedResourceKey,
      now,
      LINEAGE_DETAIL[outcome.kind],
    );
    const withLineage: SupervisorState = {
      ...withoutClaim,
      roadmap: setRunConfig(setImplementer(state.roadmap, item.key, usedResourceKey), item.key, reconciled),
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
      void escalated;
      return {
        kind: "RECOVERY_REQUIRED",
        reason: `run configuration mismatch on ${item.key}: ${reconciled.note}`,
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
      void escalated;
      return { kind: "RECOVERY_REQUIRED", reason: `unverified completion on ${item.key}` };
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
        void next;
        this.log(`[supervisor] ${item.key} completed; dependents re-evaluated`);
        return { kind: "ADVANCED", roadmapKey: item.key, actionId, detail };
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
        void next;
        return { kind: "ADVANCED", roadmapKey: item.key, actionId, detail };
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
        void next;
        this.log(`[supervisor] ${item.key} rolled over to a new session: ${detail}`);
        return { kind: "ADVANCED", roadmapKey: item.key, actionId, detail };
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
        void escalated;
        return { kind: "WAITING_FOR_HUMAN", roadmapKey: item.key, reason, humanActionRequired: humanAction };
      }

      case "RESOURCE_FAILURE": {
        // The SUPERVISOR classifies; the executor only reports facts.
        const classification = classifyOutcome(outcome);
        const resources = state.resources.map((record) =>
          record.key === usedResourceKey ? this.applyClassification(record, classification, now) : record,
        );
        const waiting = await this.commit(state, {
          ...withLineage,
          resources,
          roadmap: setStatus(
            withLineage.roadmap,
            item.key,
            classification.state === "AUTH_REQUIRED" ? "WAITING_FOR_HUMAN_REQUIRED" : "WAITING_FOR_RESOURCE",
            boundedDiagnostic(classification.reason),
          ),
        });

        if (classification.state === "AUTH_REQUIRED") {
          const escalated = await this.escalate(
            waiting,
            item.key,
            "AUTH_REQUIRED",
            `Re-authenticate the provider for ${usedResourceKey ?? "the required resource"} (for example \`claude auth login\` or \`codex login\`).`,
            classification.reason,
          );
          void escalated;
          return {
            kind: "WAITING_FOR_HUMAN",
            roadmapKey: item.key,
            reason: "AUTH_REQUIRED",
            humanActionRequired: `Re-authenticate the provider for ${usedResourceKey ?? "the required resource"}.`,
          };
        }

        const wake = this.computeNextWake(waiting);
        const settled = await this.commit(waiting, withWake(waiting, wake));
        void settled;
        this.log(`[supervisor] ${item.key} waiting for resource: ${classification.reason}`);
        return {
          kind: "WAITING_FOR_RESOURCE",
          roadmapKey: item.key,
          reason: classification.reason,
          ...(wake === undefined ? {} : { nextWakeAt: wake }),
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
      queue.push(...entry.dependsOn);
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
     * `undefined` means the chain does not verify, and it is the ONLY signal
     * this loop acts on for AC-5 — deliberately one mechanism rather than two.
     * An earlier version had a separate "chain broken" branch above this loop
     * as well; mutation testing showed the two masking each other, so removing
     * either left the behaviour intact and neither was load-bearing. Two
     * guards that cover exactly the same case are not defence in depth, they
     * are a test that passes for the wrong reason.
     */
    const chainImplementers = implementersByRoadmapKey(state.provenance);
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
    const chainKeys = new Set<string>([
      ...visited,
      ...state.provenance.map((entry) => entry.roadmapKey),
    ]);
    for (const key of chainKeys) {
      const entry = byKey.get(key);
      if (entry === undefined) {
        /**
         * The chain names an item the roadmap no longer contains. That is not
         * nothing — it is a record of work on something that has since been
         * removed or renamed, and its implementer must still be excluded.
         */
        for (const resource of chainImplementers?.get(key) ?? []) {
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
      if (chainImplementers === undefined) {
        // AC-5: the record cannot be vouched for, so the lineage it describes
        // is not lineage. The review waits for a human rather than proceeding
        // on history nobody can verify.
        if (!ambiguous.includes(key)) {
          ambiguous.push(key);
        }
        continue;
      }
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

  /** The earliest moment any waiting resource is worth looking at again. */
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
  private async catalogState(
    state: SupervisorState,
  ): Promise<{ readonly state: SupervisorState; readonly result?: TickResult }> {
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
