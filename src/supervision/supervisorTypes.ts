/**
 * Durable supervisor state (TASK-006 §7, §10, §11).
 *
 * Everything the Factory needs in order to keep going lives here, in a database
 * row — not in a conversation. That is the whole point of the task: a model
 * session becomes a disposable worker, and the Factory's memory is SQLite plus
 * Git.
 *
 * The same discipline TASK-004 and TASK-005 arrived at applies unchanged: a
 * persisted status is a CHECKPOINT, never authority; every external side effect
 * is preceded by a durable claim written with CAS; derived identities are
 * recomputed on read rather than trusted; and ambiguity fails closed.
 */

import type { Timestamp } from "../domain/time.js";
import type { AiRunConfigRecord } from "./modelEnforcement.js";
import type { WorkClass } from "./modelRouting.js";
import type { ResourceRecord } from "./resourceTypes.js";

// =====================================================================
// Roadmap queue
// =====================================================================

export const ROADMAP_STATUSES = [
  /** Dependencies not yet satisfied. */
  "PENDING",
  /** Dependencies satisfied; may be selected. */
  "ELIGIBLE",
  /** Currently claimed by an action. */
  "ACTIVE",
  /** Correct work, no usable resource right now. Not a failure. */
  "WAITING_FOR_RESOURCE",
  /** Needs something only a human can do. Not a failure either. */
  "WAITING_FOR_HUMAN_REQUIRED",
  /** A prerequisite failed, so this cannot safely proceed. */
  "BLOCKED",
  "DONE",
] as const;

export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

export const TERMINAL_ROADMAP_STATUSES: readonly RoadmapStatus[] = ["DONE"];

export interface RoadmapItem {
  /** Stable, human-meaningful key, e.g. "SERVER_FOUNDATION". Unique. */
  readonly key: string;
  readonly title: string;
  /** Keys of prerequisites. Validated acyclic and non-dangling on read. */
  readonly dependsOn: readonly string[];
  readonly status: RoadmapStatus;
  readonly workClass: WorkClass;
  /** Tie-break for selection when several items are eligible. Lower runs first. */
  readonly order: number;
  /**
   * How many action attempts this item has consumed.
   *
   * Review finding F-6 (HIGH): the remediation budget previously counted
   * `checkpoint.iteration`, but a `CHANGES_REQUIRED` outcome writes no
   * checkpoint — so the count never moved, the budget never bit, and an item
   * could remediate forever while always producing action `a1`. The counter
   * belongs to the ITEM, which exists for every attempt, rather than to a
   * checkpoint that only sometimes does.
   */
  readonly attempts?: number;
  /**
   * Action kinds this item's executor is expected to perform. Every one is put
   * through the financial gate BEFORE the executor is launched (finding F-3),
   * so the supervisor never starts work whose declared actions it would refuse.
   */
  readonly declaredActionKinds?: readonly string[];
  /**
   * The resource that last performed work on this item.
   *
   * Review finding N-2 (HIGH): implementer identity previously lived only in a
   * checkpoint for the SAME roadmap key, and a completed item's checkpoint is
   * deleted — so a dependent `INDEPENDENT_REVIEW` item had nothing to exclude
   * and happily selected the very resource that had done the implementing.
   * C4 is not a property of one item in isolation; it is a property of the
   * lineage, so the identity is recorded on the item and outlives it.
   */
  readonly implementedByResourceKey?: string;
  /**
   * EVERY resource that has implemented this item, newest first (F5-C4-1).
   *
   * The scalar above was overwritten on each run, so an item implemented by one
   * resource and later remediated by another remembered only the second — and
   * the first was free to "independently" review work it had written. Who
   * touched the work is a set that only grows.
   */
  readonly implementedByResourceKeys?: readonly string[];
  /**
   * What the last AI run on this item was CONFIGURED to be, and how well that
   * configuration was verified (review finding F4-9, HIGH).
   *
   * The configuration used to live only for the duration of one call: built,
   * handed to the executor, discarded. So an item could be marked DONE with no
   * durable evidence of which model and effort produced it, and AC-12's
   * "requested vs effective verification" had nothing to point at afterwards.
   * C8 wants intent, worker/model and result recorded; this is the model half.
   *
   * NOT AUTHORITY — review finding F5-AUDIT-1 (HIGH), and stated here rather
   * than left implicit. This is a RECORD written by the supervisor, so anyone
   * who can edit the database can write `verification: "VERIFIED_EFFECTIVE"`
   * into it. That is not a control bypass, because nothing in the supervisor
   * reads this field to make a decision — it is displayed and audited, never
   * consulted — but it does mean it is worth exactly what the database is worth.
   * Making it self-authenticating would need a key this process does not have
   * and must not have; claiming otherwise would be theatre. The invariant that
   * does hold is enforced elsewhere: a contradicted run never reaches DONE in
   * the first place.
   */
  readonly lastRunConfig?: AiRunConfigRecord;
  readonly detail?: string;
  /** Set with WAITING_FOR_HUMAN_REQUIRED: exactly what only a human can do. */
  readonly humanActionRequired?: string;
}

// =====================================================================
// Session rollover (§10)
// =====================================================================

/**
 * What a NEW process needs to resume work an old one was doing.
 *
 * Deliberately bounded and structured. A raw conversation transcript is never
 * the authoritative memory — if resuming required the previous chat, the
 * Factory would still be hostage to a session, which is the thing being fixed.
 */
export interface SessionCheckpoint {
  readonly roadmapKey: string;
  readonly projectId?: string;
  readonly workItemId?: string;
  readonly planId?: string;
  readonly planRevision?: number;
  readonly branch?: string;
  readonly baseCommit?: string;
  /**
   * The action currently working from this checkpoint.
   *
   * F5-RESUME-1: this used to be documented as "prevents cross-action resume",
   * which was not true and could not be — a rollover BY DEFINITION continues
   * under a new attempt, so the ids never match and nothing checked them. What
   * actually holds is stated instead: the checkpoint must belong to this
   * roadmap item, and on resume it is REBOUND to the action now running so the
   * record and reality agree.
   */
  readonly actionId: string;
  /** The action that wrote it, kept so a rollover chain stays auditable (C8). */
  readonly resumedFromActionId?: string;
  readonly iteration: number;
  readonly completedVerification: readonly string[];
  readonly pendingVerification: readonly string[];
  readonly findings: readonly string[];
  /** The next deterministic step, in the Factory's own vocabulary. */
  readonly nextAction: string;
  readonly requiredWorkClass: WorkClass;
  readonly updatedAt: Timestamp;
}

// =====================================================================
// Action claims (§12)
// =====================================================================

export const ACTION_STATES = [
  /** Written before anything external happens. Proves no launch occurred. */
  "CLAIMED",
  /** Written immediately before the external launch. Outcome may be unknown. */
  "RUNNING",
] as const;

export type ActionState = (typeof ACTION_STATES)[number];

/**
 * A durable claim on ONE external action.
 *
 * Two states for the same reason TASK-005's planner lease has two: `CLAIMED`
 * proves nothing external happened and a retry is safe, while `RUNNING` under a
 * dead owner is unknowable and must fail closed rather than be repeated.
 */
export interface SupervisorActionClaim {
  /** Canonical, derived — never random (the TASK-004 round-2 lesson). */
  readonly actionId: string;
  readonly roadmapKey: string;
  readonly kind: string;
  readonly resourceKey?: string;
  readonly state: ActionState;
  /** Identity of the supervisor process instance holding the claim. */
  readonly ownerId: string;
  readonly attempt: number;
  readonly claimedAt: Timestamp;
}

/** THE only legitimate way an action id comes into existence. */
export function canonicalActionId(roadmapKey: string, kind: string, attempt: number): string {
  return `${roadmapKey}:${kind}:a${attempt}`;
}

// =====================================================================
// Human escalation (§3.5)
// =====================================================================

export const ESCALATION_REASONS = [
  "FINANCIAL_ACTION_REQUIRED",
  "HUMAN_CREDENTIAL_REQUIRED",
  "PUBLICATION_APPROVAL_REQUIRED",
  "DESTRUCTIVE_APPROVAL_REQUIRED",
  "AUTH_REQUIRED",
  /**
   * The action itself is free and safe, but the WORK needs a human judgement —
   * authoring a plan, for instance (C1/C2 reserve that decision for a human).
   *
   * This exists because the first live run of the CLI reported "a human must
   * personally perform this transaction" for an item that merely needed a plan.
   * The gate was right to refuse (an unregistered action kind is financial by
   * the uncertainty rule), but telling an operator to make a PAYMENT when they
   * need to write a document is a wrong answer even when the refusal is right.
   */
  "HUMAN_DECISION_REQUIRED",
  "RECOVERY_REQUIRED",
] as const;

export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export interface HumanEscalation {
  readonly roadmapKey: string;
  readonly reason: EscalationReason;
  /** Exactly what the human must do, and why software cannot. */
  readonly humanActionRequired: string;
  readonly detail: string;
  readonly raisedAt: Timestamp;
  readonly resolved: boolean;
}

// =====================================================================
// The durable state blob
// =====================================================================

export interface SupervisorState {
  /** Optimistic-concurrency token AND linearization point for every claim. */
  readonly version: number;
  /**
   * Stored raw and parsed strictly at every point of use. Kept as `unknown`
   * deliberately: a policy that fails to parse must DENY, and typing it as a
   * valid policy here would quietly assert it always is one.
   */
  readonly financialPolicy: unknown;
  readonly resources: readonly ResourceRecord[];
  readonly roadmap: readonly RoadmapItem[];
  readonly checkpoints: readonly SessionCheckpoint[];
  readonly activeClaim?: SupervisorActionClaim;
  /** When the next tick is worth running. Absent means "nothing scheduled". */
  readonly nextWakeAt?: Timestamp;
  readonly escalations: readonly HumanEscalation[];
  readonly updatedAt: Timestamp;
}

/**
 * The roadmap the completion mandate names, as QUEUE ENTRIES — not frozen
 * specifications. Each still goes through TASK-005 planning and independent
 * review before any of it is implemented; this table only decides what becomes
 * eligible next, and in what order.
 */
export const DEFAULT_ROADMAP: readonly RoadmapItem[] = [
  // AMENDED: the runtime is the existing always-on Windows PC + WSL2 Ubuntu.
  // A dedicated VPS is NOT required and NOT authorized, so the first milestone
  // is making the machine we already own a reliable Factory host rather than
  // buying one. Paid infrastructure of any kind is outside this roadmap.
  { key: "LOCAL_24_7_RUNTIME", title: "Reliable restartable WSL2 runtime on the existing PC", dependsOn: [], status: "PENDING", workClass: "ARCHITECTURE_SECURITY", order: 1 },
  { key: "SUPERVISOR_SERVICE", title: "Supervisor startup, scheduling and restart recovery", dependsOn: ["LOCAL_24_7_RUNTIME"], status: "PENDING", workClass: "HIGH_RISK_IMPLEMENTATION", order: 2 },
  /**
   * The one architectural gap TASK-006 could not close from inside itself
   * (findings F5-FIN-3 and F6-FIN-2).
   *
   * The financial gate authorises a LAUNCH. It cannot police what trusted
   * in-process executor code does afterwards, because an in-process function
   * cannot restrain code that can already call `fetch` — the same boundary
   * TASK-003's `Worker` has. Closing it means the executor must run WITHOUT the
   * capability: its own process, its own credentials, only the operations the
   * supervisor hands it. That is real work with real design choices, so it is a
   * tracked roadmap item rather than a paragraph of reassurance, and it sits
   * before anything is wired to actually execute autonomous work.
   */
  { key: "EXECUTOR_ISOLATION", title: "Run executors in a restricted process with no ambient network or billing capability", dependsOn: ["SUPERVISOR_SERVICE"], status: "PENDING", workClass: "ARCHITECTURE_SECURITY", order: 3 },
  /**
   * The second thing TASK-006 cannot close from inside itself (finding
   * R9-C4-1).
   *
   * Implementer lineage and audit records are historical FACTS, so they live in
   * the database — and there is no key on this machine to authenticate them
   * with. Anything able to write that database can rewrite who built what, and
   * a review that should have been excluded then proceeds. The supervisor
   * raises the cost (catalog recognition, a cross-check against a field written
   * by a different path, fail-closed on anything missing or contradictory) but
   * cannot make the record self-proving.
   *
   * So the supervisor database is part of the trusted computing base, and making
   * that defensible — restrictive file permissions, an append-only signed audit
   * log, provenance held outside the mutable row — is real work with real design
   * choices. It blocks EXECUTOR_WIRING alongside isolation, because C4 evidence
   * matters most once the Factory is actually executing work.
   */
  { key: "STATE_INTEGRITY", title: "Protect supervisor state and provenance against tampering (permissions, append-only audit)", dependsOn: ["SUPERVISOR_SERVICE"], status: "PENDING", workClass: "ARCHITECTURE_SECURITY", order: 4 },
  // Isolation comes BEFORE wiring: nothing should be wired to execute
  // autonomous work until the thing executing it can be constrained.
  { key: "EXECUTOR_WIRING", title: "Wire the roadmap queue to TASK-005 planning and the TASK-004 loop", dependsOn: ["EXECUTOR_ISOLATION", "STATE_INTEGRITY"], status: "PENDING", workClass: "HIGH_RISK_IMPLEMENTATION", order: 5 },
  { key: "GITHUB_ORCHESTRATION", title: "GitHub Issues/Projects/PR orchestration (zero-cost tier only)", dependsOn: ["EXECUTOR_WIRING"], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 6 },
  { key: "CLEAN_ROOM_CI", title: "Strategic clean-environment CI within the included allowance", dependsOn: ["GITHUB_ORCHESTRATION"], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 7 },
  { key: "TELEGRAM_CONTROL_PLANE", title: "Telegram control plane", dependsOn: ["SUPERVISOR_SERVICE"], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 8 },
  { key: "N8N_INTEGRATION_BUS", title: "n8n integration bus", dependsOn: ["SUPERVISOR_SERVICE"], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 9 },
  { key: "CONTROL_ROOM", title: "Control Room operational visibility", dependsOn: ["GITHUB_ORCHESTRATION"], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 10 },
  { key: "MEASURED_MODEL_ROUTER", title: "Benchmark-driven model router", dependsOn: ["EXECUTOR_WIRING"], status: "PENDING", workClass: "HIGH_RISK_IMPLEMENTATION", order: 11 },
  { key: "BACKUP_RECOVERY", title: "Backup and disaster recovery on existing storage", dependsOn: ["LOCAL_24_7_RUNTIME"], status: "PENDING", workClass: "HIGH_RISK_IMPLEMENTATION", order: 12 },
  { key: "RELEASE_HARDENING", title: "Public-release separation and hardening", dependsOn: ["CONTROL_ROOM", "BACKUP_RECOVERY"], status: "PENDING", workClass: "ARCHITECTURE_SECURITY", order: 13 },
  { key: "END_TO_END_ACCEPTANCE", title: "Final end-to-end autonomous acceptance", dependsOn: ["RELEASE_HARDENING", "MEASURED_MODEL_ROUTER", "TELEGRAM_CONTROL_PLANE", "N8N_INTEGRATION_BUS", "CLEAN_ROOM_CI"], status: "PENDING", workClass: "ARCHITECTURE_SECURITY", order: 14 },
];
