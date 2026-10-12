/**
 * DOMAIN / SERIALIZER PARITY GUARD for the durable supervisor state.
 *
 * This file exists because the mistake repeated itself. TASK-005 remediation
 * round 3 was caused by `ApprovalContext` gaining authority fields while the
 * SQLite parser kept an older whitelist; the field was simply deleted in
 * transit and nothing threw. During TASK-006 remediation round 3 the SAME
 * mistake was made again, one layer over: `ResourceRecord.observedBillingMode`
 * — the field that decides whether running a model is a FINANCIAL action —
 * was added to the domain type and not to `parseResource`. A supervisor that
 * had probed its providers and knew they were subscription-backed forgot that
 * the moment it restarted, and every AI action after a restart became
 * financial.
 *
 * A test caught it, which is the good news; that it was catchable only by a
 * behavioural restart test is the bad news. So the guard here is structural:
 *
 *   - each `*_FIELDS` map is typed `Record<keyof Required<T>, true>`, so
 *     adding a field to a durable domain type without listing it is a COMPILE
 *     error;
 *   - each maximal fixture is `Required<T>`, so every field this file knows
 *     about must survive `encode -> parse` or the test FAILS at runtime.
 *
 * Together, a new durable field cannot reach production without surviving a
 * real round-trip. The explicit list is deliberate over reflection: a reviewer
 * can check a list.
 *
 * Offline: no provider, no model, no money.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Activity } from "../src/supervision/activity.js";
import { BILLING_MODES } from "../src/supervision/financialSafety.js";
import type { AiRunConfigRecord } from "../src/supervision/modelEnforcement.js";
import type { ResourceRecord } from "../src/supervision/resourceTypes.js";
import { appendProvenance, type ProvenanceEntry } from "../src/supervision/provenanceChain.js";
import {
  encodeSupervisorState,
  parseSupervisorState,
} from "../src/supervision/supervisorSerialization.js";
import type {
  HumanEscalation,
  RoadmapItem,
  SessionCheckpoint,
  SupervisorActionClaim,
  SupervisorState,
} from "../src/supervision/supervisorTypes.js";
import type { WorkerRunEnvelope, WorkerRunNotification } from "../src/supervision/workerRunEnvelope.js";

// =====================================================================
// Canonical field lists — adding a domain field without touching these
// is a compile error.
// =====================================================================

const RESOURCE_FIELDS: Record<keyof Required<ResourceRecord>, true> = {
  provider: true,
  model: true,
  key: true,
  state: true,
  detectedAt: true,
  lastCheckedAt: true,
  retryAt: true,
  backoff: true,
  lastSuccessAt: true,
  observedBillingMode: true,
  diagnostic: true,
};

const ROADMAP_ITEM_FIELDS: Record<keyof Required<RoadmapItem>, true> = {
  key: true,
  title: true,
  dependsOn: true,
  status: true,
  workClass: true,
  order: true,
  attempts: true,
  unlaunchedAttempts: true,
  declaredActionKinds: true,
  implementedByResourceKey: true,
  implementedByResourceKeys: true,
  lastRunConfig: true,
  detail: true,
  humanActionRequired: true,
};

const RUN_CONFIG_FIELDS: Record<keyof Required<AiRunConfigRecord>, true> = {
  requestedProvider: true,
  requestedModel: true,
  requestedEffort: true,
  effectiveProvider: true,
  effectiveModel: true,
  effectiveEffort: true,
  verification: true,
  argvEvidence: true,
  note: true,
};

const CHECKPOINT_FIELDS: Record<keyof Required<SessionCheckpoint>, true> = {
  roadmapKey: true,
  projectId: true,
  workItemId: true,
  planId: true,
  planRevision: true,
  branch: true,
  baseCommit: true,
  actionId: true,
  resumedFromActionId: true,
  iteration: true,
  completedVerification: true,
  pendingVerification: true,
  findings: true,
  nextAction: true,
  requiredWorkClass: true,
  updatedAt: true,
};

const CLAIM_FIELDS: Record<keyof Required<SupervisorActionClaim>, true> = {
  actionId: true,
  roadmapKey: true,
  kind: true,
  resourceKey: true,
  state: true,
  ownerId: true,
  attempt: true,
  claimedAt: true,
};

const ESCALATION_FIELDS: Record<keyof Required<HumanEscalation>, true> = {
  roadmapKey: true,
  reason: true,
  humanActionRequired: true,
  detail: true,
  raisedAt: true,
  resolved: true,
};

const PROVENANCE_FIELDS: Record<keyof Required<ProvenanceEntry>, true> = {
  sequence: true,
  kind: true,
  roadmapKey: true,
  resourceKey: true,
  detail: true,
  recordedAt: true,
  previousDigest: true,
  digest: true,
};

/**
 * The LEASE's own fields, listed separately because it is a nested durable type
 * and this guard only sees what it is told about.
 *
 * `boot` was added after a reviewer showed that pid plus start-tick plus
 * machine can all match an unrelated process after a restart. A nested field
 * dropped in transit is exactly the failure this whole file exists for, and
 * `Activity.lease` being listed above says nothing about what is inside it.
 */
/**
 * The REVIEW BINDING's own fields, for the same reason as the lease's.
 *
 * This one decides whether a verdict may be applied at all: drop `fingerprint`
 * in transit and a verdict for a different working tree starts matching.
 */
const ACTIVITY_REVIEW_FIELDS: Record<keyof Required<NonNullable<Activity["review"]>>, true> = {
  reviewId: true,
  source: true,
  candidate: true,
  provider: true,
  model: true,
  effort: true,
  attempt: true,
  ack: true,
};

const ACTIVITY_REVIEW_CANDIDATE_FIELDS: Record<
  keyof Required<NonNullable<Activity["review"]>["candidate"]>,
  true
> = {
  commit: true,
  tree: true,
  fingerprint: true,
};

const ACTIVITY_LEASE_FIELDS: Record<keyof Required<NonNullable<Activity["lease"]>>, true> = {
  pid: true,
  processStartedAt: true,
  machine: true,
  boot: true,
  claimedAt: true,
};

const ACTIVITY_FIELDS: Record<keyof Required<Activity>, true> = {
  id: true,
  kind: true,
  roadmapKey: true,
  state: true,
  lease: true,
  heartbeat: true,
  completion: true,
  observedAt: true,
  reconciliation: true,
  review: true,
  updatedAt: true,
};

const STATE_FIELDS: Record<keyof Required<SupervisorState>, true> = {
  version: true,
  financialPolicy: true,
  resources: true,
  roadmap: true,
  checkpoints: true,
  activities: true,
  workerRuns: true,
  workerRunNotifications: true,
  supervisor: true,
  reviewRequests: true,
  activeClaim: true,
  nextWakeAt: true,
  escalations: true,
  provenance: true,
  provenanceAnchor: true,
  updatedAt: true,
};

/**
 * DEFECT-DURABLE-WORKER-RUN-ENVELOPE's own durable record, listed the same
 * disciplined way every other type in this file is.
 *
 * `AWAITING_CONTROLLER` is the state chosen for the maximal fixture, mirroring
 * `MAXIMAL_ACTIVITY`'s choice of `COMPLETED`: it is the one state that can
 * legitimately carry every optional field at once (a lease from its adoption,
 * a heartbeat from before it settled, and a verified `terminalReason` from its
 * completion) — `reconciledAt` is included too, because `completeWorkerRun`
 * SPREADS the prior record rather than replacing it, so a run reconciled once
 * before a real completion superseded it can legitimately still carry one.
 */
const WORKER_RUN_LEASE_FIELDS: Record<keyof Required<NonNullable<WorkerRunEnvelope["wrapperLease"]>>, true> = {
  pid: true,
  processStartedAt: true,
  machine: true,
  boot: true,
  claimedAt: true,
};

const WORKER_RUN_HEARTBEAT_FIELDS: Record<keyof Required<NonNullable<WorkerRunEnvelope["heartbeat"]>>, true> = {
  lastProgressAt: true,
  at: true,
  progress: true,
};

const WORKER_RUN_ARTIFACT_FIELDS: Record<keyof Required<NonNullable<WorkerRunEnvelope["artifact"]>>, true> = {
  path: true,
  hash: true,
};

const WORKER_RUN_FIELDS: Record<keyof Required<WorkerRunEnvelope>, true> = {
  invocations: true,
  runId: true,
  actionId: true,
  roadmapKey: true,
  attempt: true,
  provider: true,
  model: true,
  effort: true,
  maxTurns: true,
  state: true,
  wrapperLease: true,
  childPid: true,
  factorySessionId: true,
  providerSessionId: true,
  terminalReason: true,
  preparedAt: true,
  heartbeat: true,
  startedAt: true,
  finishedAt: true,
  reconciledAt: true,
  exitCode: true,
  signal: true,
  artifact: true,
  detail: true,
  updatedAt: true,
};

const WORKER_RUN_NOTIFICATION_FIELDS: Record<keyof Required<WorkerRunNotification>, true> = {
  key: true,
  runId: true,
  roadmapKey: true,
  kind: true,
  detail: true,
  createdAt: true,
};

// =====================================================================
// Maximal fixtures — every listed field semantically present
// =====================================================================

const MAXIMAL_RESOURCE: Required<ResourceRecord> = {
  provider: "claude-code",
  model: "opus",
  key: "claude-code:opus",
  state: "RATE_LIMITED",
  detectedAt: 1_000,
  lastCheckedAt: 1_100,
  retryAt: 1_600,
  backoff: { attempt: 2, delayMs: 900_000 },
  lastSuccessAt: 900,
  observedBillingMode: "INCLUDED_SUBSCRIPTION",
  diagnostic: "usage limit reached",
};

const MAXIMAL_RUN_CONFIG: Required<AiRunConfigRecord> = {
  requestedProvider: "claude-code",
  requestedModel: "opus",
  requestedEffort: "high",
  effectiveProvider: "claude-code",
  effectiveModel: "opus",
  effectiveEffort: "high",
  verification: "VERIFIED_EFFECTIVE",
  argvEvidence: ["claude", "--model", "opus", "--effort", "high"],
  note: "the provider reported an identity matching every requested dimension",
};

const MAXIMAL_ROADMAP_ITEM: Required<RoadmapItem> = {
  key: "LOCAL_24_7_RUNTIME",
  title: "Reliable restartable WSL2 runtime",
  dependsOn: [],
  status: "WAITING_FOR_HUMAN_REQUIRED",
  workClass: "ARCHITECTURE_SECURITY",
  order: 1,
  attempts: 3,
  unlaunchedAttempts: 1,
  declaredActionKinds: ["RUN_DETERMINISTIC_WORK", "WRITE_LOCAL_FILE"],
  implementedByResourceKey: "codex-cli:gpt-5.6-luna",
  implementedByResourceKeys: ["codex-cli:gpt-5.6-luna", "claude-code:opus"],
  lastRunConfig: MAXIMAL_RUN_CONFIG,
  detail: "waiting on an operator decision",
  humanActionRequired: "approve the plan",
};

const MAXIMAL_CHECKPOINT: Required<SessionCheckpoint> = {
  roadmapKey: "LOCAL_24_7_RUNTIME",
  projectId: "prj-0001",
  workItemId: "wi-0001",
  planId: "plan-0001",
  planRevision: 4,
  branch: "feat/local-runtime",
  baseCommit: "abc1234",
  actionId: "LOCAL_24_7_RUNTIME:LAUNCH_AI_WORKER:a3",
  resumedFromActionId: "LOCAL_24_7_RUNTIME:LAUNCH_AI_WORKER:a2",
  iteration: 2,
  completedVerification: ["typecheck", "build"],
  pendingVerification: ["npm test"],
  findings: ["restart recovery untested"],
  nextAction: "run the verification suite",
  requiredWorkClass: "ARCHITECTURE_SECURITY",
  updatedAt: 1_200,
};

const MAXIMAL_CLAIM: Required<SupervisorActionClaim> = {
  actionId: "LOCAL_24_7_RUNTIME:LAUNCH_AI_WORKER:a3",
  roadmapKey: "LOCAL_24_7_RUNTIME",
  kind: "LAUNCH_AI_WORKER",
  resourceKey: "claude-code:opus",
  state: "RUNNING",
  ownerId: "supervisor:1234:own-1",
  attempt: 3,
  claimedAt: 1_150,
};

const MAXIMAL_ESCALATION: Required<HumanEscalation> = {
  roadmapKey: "LOCAL_24_7_RUNTIME",
  reason: "HUMAN_DECISION_REQUIRED",
  humanActionRequired: "author and approve a plan",
  detail: "C1 reserves this decision for a human",
  raisedAt: 1_180,
  resolved: false,
};

/**
 * A REAL chained entry, not a hand-written literal: its digest must be the one
 * `computeDigest` produces, or the round-trip would be proving that an invalid
 * chain survives serialization — which is true but useless.
 */
const MAXIMAL_PROVENANCE: Required<ProvenanceEntry> = (() => {
  const appended = appendProvenance([], {
    kind: "IMPLEMENTED_BY",
    roadmapKey: "LOCAL_24_7_RUNTIME",
    resourceKey: "claude-code:opus",
    detail: "completed",
    recordedAt: 1_190,
  });
  assert.equal(appended.ok, true);
  if (!appended.ok) throw new Error("unreachable");
  return appended.chain[0] as Required<ProvenanceEntry>;
})();

/**
 * The supervisor's own lease, listed separately for the same reason the
 * activity's is: a nested field dropped in transit is how two supervisors end
 * up believing nobody owns the Factory.
 */
const SUPERVISOR_FIELDS: Record<keyof Required<NonNullable<SupervisorState["supervisor"]>>, true> = {
  lease: true,
  ownerId: true,
  acquiredAt: true,
  renewedAt: true,
};

/**
 * A TERMINAL activity, because that is the only shape carrying every field at
 * once: a completion and an observation exist only once the work has finished,
 * and the parser refuses both on an unfinished one.
 */
const MAXIMAL_ACTIVITY: Required<Activity> = {
  id: "LOCAL_24_7_RUNTIME:REVIEW:r2",
  kind: "REVIEW",
  roadmapKey: "LOCAL_24_7_RUNTIME",
  state: "COMPLETED",
  lease: { pid: 4242, processStartedAt: 99_000, machine: "wsl-ubuntu", boot: "boot-1234", claimedAt: 1_150 },
  heartbeat: { at: 1_180, progress: 7 },
  completion: { outcome: "PASS", detail: "verdict recorded", at: 1_190 },
  observedAt: 1_195,
  reconciliation: { verdict: "LIVE", at: 1_185, detail: "owner was running" },
  review: {
    reviewId: "r2",
    source: "/home/factory/.sf/review-r2-lastmsg.txt",
    candidate: { commit: "339ae83", tree: "3fd1ecb", fingerprint: "e3bb12ea62ef" },
    provider: "codex-cli",
    model: "gpt-5.6-luna",
    effort: "xhigh",
    attempt: 2,
    ack: "/home/factory/.sf/review-r2-ack.json",
  },
  updatedAt: 1_190,
};

/**
 * The maximal WorkerRunEnvelope fixture: `AWAITING_CONTROLLER`, chosen for the
 * reason given at `WORKER_RUN_LEASE_FIELDS` above.
 */
const MAXIMAL_WORKER_RUN: Required<WorkerRunEnvelope> = {
  invocations: [{ sequence: 1, provider: "claude-code", model: "opus", maxTurns: 40, preparedAt: 1120,
    lease: { pid: 5252, processStartedAt: 88001, machine: "wsl-ubuntu", boot: "boot-1234", claimedAt: 1150 },
    finishedAt: 1200, exitCode: 0, signal: null, terminationReason: "EXITED",
    providerSessionId: "sess-max-turns", terminalReason: "MAX_TURNS" }],
  runId: "LOCAL_24_7_RUNTIME:LAUNCH_AI_WORKER:a3:wr1",
  actionId: "LOCAL_24_7_RUNTIME:LAUNCH_AI_WORKER:a3",
  roadmapKey: "LOCAL_24_7_RUNTIME",
  attempt: 3,
  provider: "claude-code",
  model: "opus",
  effort: "high",
  maxTurns: 40,
  state: "AWAITING_CONTROLLER",
  wrapperLease: { pid: 5151, processStartedAt: 88_000, machine: "wsl-ubuntu", boot: "boot-1234", claimedAt: 1_140 },
  childPid: 5252,
  factorySessionId: "LOCAL_24_7_RUNTIME:LAUNCH_AI_WORKER:a3:wr1",
  providerSessionId: "sess-max-turns",
  terminalReason: "MAX_TURNS",
  preparedAt: 1_120,
  heartbeat: { at: 1_180, progress: 9, lastProgressAt: 1170 },
  startedAt: 1_150,
  finishedAt: 1_200,
  reconciledAt: 1_190,
  exitCode: 0,
  signal: null,
  artifact: { path: "/home/factory/.factory/worker-runs/LOCAL_24_7_RUNTIME%3ALAUNCH_AI_WORKER%3Aa3%3Awr1.json", hash: "a".repeat(64) },
  detail: "structured terminal_reason=max_turns",
  updatedAt: 1_200,
};

const MAXIMAL_WORKER_RUN_NOTIFICATION: Required<WorkerRunNotification> = {
  key: "LOCAL_24_7_RUNTIME:LAUNCH_AI_WORKER:a3:wr1:MAX_TURNS",
  runId: "LOCAL_24_7_RUNTIME:LAUNCH_AI_WORKER:a3:wr1",
  roadmapKey: "LOCAL_24_7_RUNTIME",
  kind: "MAX_TURNS",
  detail: "structured terminal_reason=max_turns",
  createdAt: 1_200,
};

const MAXIMAL_STATE: Required<SupervisorState> = {
  version: 9,
  financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
  resources: [MAXIMAL_RESOURCE],
  roadmap: [MAXIMAL_ROADMAP_ITEM],
  checkpoints: [MAXIMAL_CHECKPOINT],
  activities: [MAXIMAL_ACTIVITY],
  workerRuns: [MAXIMAL_WORKER_RUN],
  workerRunNotifications: [MAXIMAL_WORKER_RUN_NOTIFICATION],
  activeClaim: MAXIMAL_CLAIM,
  nextWakeAt: 1_600,
  escalations: [MAXIMAL_ESCALATION],
  provenance: [MAXIMAL_PROVENANCE],
  provenanceAnchor: { length: 1, headDigest: MAXIMAL_PROVENANCE.digest },
  reviewRequests: [
    {
      roadmapKey: "LOCAL_24_7_RUNTIME",
      candidate: { commit: "339ae83", tree: "3fd1ecb", fingerprint: "e3bb12ea62ef" },
      attempt: 3,
      requestedAt: 1_160,
      provider: "codex-cli",
      model: "gpt-5.6-luna",
      effort: "xhigh",
    },
  ],
  supervisor: {
    lease: { pid: 8181, processStartedAt: 120_000, machine: "wsl-ubuntu", boot: "boot-1234", claimedAt: 1_150 },
    ownerId: "sf-supervisor",
    acquiredAt: 1_150,
    renewedAt: 1_190,
  },
  updatedAt: 1_200,
};

function roundTrip(state: SupervisorState): SupervisorState {
  return parseSupervisorState(encodeSupervisorState(state), { version: state.version });
}

// =====================================================================

describe("TASK-006: every durable supervisor field survives serialization", () => {
  it("lists every field of every durable type (compile-time guard)", () => {
    // The value assertions are trivial; the TYPE annotations above are the
    // test. If a domain type gains a field and this file is not updated, the
    // build fails before this ever runs.
    for (const map of [
      RESOURCE_FIELDS,
      ROADMAP_ITEM_FIELDS,
      RUN_CONFIG_FIELDS,
      CHECKPOINT_FIELDS,
      CLAIM_FIELDS,
      ESCALATION_FIELDS,
      PROVENANCE_FIELDS,
      ACTIVITY_LEASE_FIELDS,
      ACTIVITY_REVIEW_FIELDS,
      ACTIVITY_REVIEW_CANDIDATE_FIELDS,
      ACTIVITY_FIELDS,
      SUPERVISOR_FIELDS,
      WORKER_RUN_LEASE_FIELDS,
      WORKER_RUN_HEARTBEAT_FIELDS,
      WORKER_RUN_ARTIFACT_FIELDS,
      WORKER_RUN_FIELDS,
      WORKER_RUN_NOTIFICATION_FIELDS,
      STATE_FIELDS,
    ]) {
      assert.ok(Object.keys(map).length > 0);
      assert.ok(Object.values(map).every((flag) => flag === true));
    }
  });

  it("round-trips a maximal state with no field lost", () => {
    const parsed = roundTrip(MAXIMAL_STATE);
    assert.deepEqual(parsed, MAXIMAL_STATE);
  });

  for (const field of Object.keys(RESOURCE_FIELDS)) {
    it(`preserves ResourceRecord.${field}`, () => {
      const parsed = roundTrip(MAXIMAL_STATE);
      const resource = parsed.resources[0];
      assert.ok(resource !== undefined);
      assert.deepEqual(
        (resource as unknown as Record<string, unknown>)[field],
        (MAXIMAL_RESOURCE as unknown as Record<string, unknown>)[field],
        `${field} did not survive the round-trip`,
      );
    });
  }

  for (const field of Object.keys(ROADMAP_ITEM_FIELDS)) {
    it(`preserves RoadmapItem.${field}`, () => {
      const parsed = roundTrip(MAXIMAL_STATE);
      const item = parsed.roadmap[0];
      assert.ok(item !== undefined);
      assert.deepEqual(
        (item as unknown as Record<string, unknown>)[field],
        (MAXIMAL_ROADMAP_ITEM as unknown as Record<string, unknown>)[field],
        `${field} did not survive the round-trip`,
      );
    });
  }

  for (const field of Object.keys(CHECKPOINT_FIELDS)) {
    it(`preserves SessionCheckpoint.${field}`, () => {
      const parsed = roundTrip(MAXIMAL_STATE);
      const checkpoint = parsed.checkpoints[0];
      assert.ok(checkpoint !== undefined);
      assert.deepEqual(
        (checkpoint as unknown as Record<string, unknown>)[field],
        (MAXIMAL_CHECKPOINT as unknown as Record<string, unknown>)[field],
        `${field} did not survive the round-trip`,
      );
    });
  }

  for (const field of Object.keys(RUN_CONFIG_FIELDS)) {
    it(`preserves RoadmapItem.lastRunConfig.${field}`, () => {
      const parsed = roundTrip(MAXIMAL_STATE);
      const config = parsed.roadmap[0]?.lastRunConfig;
      assert.ok(config !== undefined, "the run configuration survived at all");
      assert.deepEqual(
        (config as unknown as Record<string, unknown>)[field],
        (MAXIMAL_RUN_CONFIG as unknown as Record<string, unknown>)[field],
        `${field} did not survive the round-trip`,
      );
    });
  }

  for (const field of Object.keys(WORKER_RUN_FIELDS)) {
    it(`preserves WorkerRunEnvelope.${field}`, () => {
      const parsed = roundTrip(MAXIMAL_STATE);
      const run = (parsed.workerRuns ?? [])[0];
      assert.ok(run !== undefined);
      assert.deepEqual(
        (run as unknown as Record<string, unknown>)[field],
        (MAXIMAL_WORKER_RUN as unknown as Record<string, unknown>)[field],
        `${field} did not survive the round-trip`,
      );
    });
  }

  for (const field of Object.keys(WORKER_RUN_NOTIFICATION_FIELDS)) {
    it(`preserves WorkerRunNotification.${field}`, () => {
      const parsed = roundTrip(MAXIMAL_STATE);
      const notification = (parsed.workerRunNotifications ?? [])[0];
      assert.ok(notification !== undefined);
      assert.deepEqual(
        (notification as unknown as Record<string, unknown>)[field],
        (MAXIMAL_WORKER_RUN_NOTIFICATION as unknown as Record<string, unknown>)[field],
        `${field} did not survive the round-trip`,
      );
    });
  }

  it("loads a database written before DEFECT-DURABLE-WORKER-RUN-ENVELOPE existed (AC-12)", () => {
    const { workerRuns: _wr, workerRunNotifications: _wrn, ...withoutWorkerRuns } = MAXIMAL_STATE;
    const parsed = roundTrip(withoutWorkerRuns);
    assert.equal(parsed.workerRuns, undefined);
    assert.equal(parsed.workerRunNotifications, undefined);
    assert.ok(!Object.hasOwn(parsed, "workerRuns"));
    assert.ok(!Object.hasOwn(parsed, "workerRunNotifications"));
  });

  it("refuses a worker run whose id is not canonically derived from its actionId", () => {
    const tampered = encodeSupervisorState(MAXIMAL_STATE).replace(
      '"runId":"LOCAL_24_7_RUNTIME:LAUNCH_AI_WORKER:a3:wr1"',
      '"runId":"some-other-id"',
    );
    assert.notEqual(tampered, encodeSupervisorState(MAXIMAL_STATE), "the replacement must actually apply");
    assert.throws(() => parseSupervisorState(tampered, { version: MAXIMAL_STATE.version }));
  });

  it("refuses a PREPARED worker run carrying a wrapperLease (the two-phase handshake, checked on read)", () => {
    const prepared: WorkerRunEnvelope = {
      runId: MAXIMAL_WORKER_RUN.runId,
      actionId: MAXIMAL_WORKER_RUN.actionId,
      roadmapKey: MAXIMAL_WORKER_RUN.roadmapKey,
      attempt: MAXIMAL_WORKER_RUN.attempt,
      provider: MAXIMAL_WORKER_RUN.provider,
      model: MAXIMAL_WORKER_RUN.model,
      state: "PREPARED",
      wrapperLease: MAXIMAL_WORKER_RUN.wrapperLease,
      preparedAt: MAXIMAL_WORKER_RUN.preparedAt,
      updatedAt: MAXIMAL_WORKER_RUN.updatedAt,
    };
    const state: SupervisorState = { ...MAXIMAL_STATE, workerRuns: [prepared] };
    assert.throws(() => roundTrip(state));
  });

  it("refuses a terminalReason recorded on anything other than AWAITING_CONTROLLER (AC-6)", () => {
    const tampered = encodeSupervisorState(MAXIMAL_STATE).replace(
      '"state":"AWAITING_CONTROLLER"',
      '"state":"COMPLETED"',
    );
    assert.notEqual(tampered, encodeSupervisorState(MAXIMAL_STATE), "the replacement must actually apply");
    assert.throws(() => parseSupervisorState(tampered, { version: MAXIMAL_STATE.version }));
  });

  it("refuses a worker-run notification whose key is not the canonical (runId, kind) derivation", () => {
    const tampered = encodeSupervisorState(MAXIMAL_STATE).replace(
      '"key":"LOCAL_24_7_RUNTIME:LAUNCH_AI_WORKER:a3:wr1:MAX_TURNS"',
      '"key":"some-other-key"',
    );
    assert.notEqual(tampered, encodeSupervisorState(MAXIMAL_STATE), "the replacement must actually apply");
    assert.throws(() => parseSupervisorState(tampered, { version: MAXIMAL_STATE.version }));
  });

  it("rejects a run configuration claiming an unknown verification status", () => {
    const encoded = encodeSupervisorState(MAXIMAL_STATE).replace(
      '"verification":"VERIFIED_EFFECTIVE"',
      '"verification":"TOTALLY_VERIFIED"',
    );
    assert.notEqual(encoded, encodeSupervisorState(MAXIMAL_STATE), "the replacement must actually apply");
    assert.throws(() => parseSupervisorState(encoded, { version: MAXIMAL_STATE.version }));
  });

  it("preserves every billing mode, not just the one the fixture happens to use", () => {
    for (const mode of BILLING_MODES) {
      const parsed = roundTrip({
        ...MAXIMAL_STATE,
        resources: [{ ...MAXIMAL_RESOURCE, observedBillingMode: mode }],
      });
      assert.equal(parsed.resources[0]?.observedBillingMode, mode);
    }
  });

  it("rejects an observed billing mode that is not a known mode", () => {
    const encoded = encodeSupervisorState(MAXIMAL_STATE).replace(
      '"observedBillingMode":"INCLUDED_SUBSCRIPTION"',
      '"observedBillingMode":"FREE_FOREVER_TRUST_ME"',
    );
    assert.notEqual(encoded, encodeSupervisorState(MAXIMAL_STATE), "the replacement must actually apply");
    assert.throws(() => parseSupervisorState(encoded, { version: MAXIMAL_STATE.version }));
  });

  it("treats an absent observed billing mode as absent, not as a default", () => {
    const { observedBillingMode: _omitted, ...withoutMode } = MAXIMAL_RESOURCE;
    const parsed = roundTrip({ ...MAXIMAL_STATE, resources: [withoutMode] });
    assert.equal(parsed.resources[0]?.observedBillingMode, undefined);
    assert.ok(!Object.hasOwn(parsed.resources[0] as object, "observedBillingMode"));
  });
});
