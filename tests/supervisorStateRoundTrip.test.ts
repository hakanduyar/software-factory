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

import { BILLING_MODES } from "../src/supervision/financialSafety.js";
import type { AiRunConfigRecord } from "../src/supervision/modelEnforcement.js";
import type { ResourceRecord } from "../src/supervision/resourceTypes.js";
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

const STATE_FIELDS: Record<keyof Required<SupervisorState>, true> = {
  version: true,
  financialPolicy: true,
  resources: true,
  roadmap: true,
  checkpoints: true,
  activeClaim: true,
  nextWakeAt: true,
  escalations: true,
  updatedAt: true,
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

const MAXIMAL_STATE: Required<SupervisorState> = {
  version: 9,
  financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
  resources: [MAXIMAL_RESOURCE],
  roadmap: [MAXIMAL_ROADMAP_ITEM],
  checkpoints: [MAXIMAL_CHECKPOINT],
  activeClaim: MAXIMAL_CLAIM,
  nextWakeAt: 1_600,
  escalations: [MAXIMAL_ESCALATION],
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
