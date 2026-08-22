/**
 * The immutable identity of "the exact plan content a human approved".
 *
 * Deliberately modelled on `src/domain/executionSnapshot.ts`, which exists
 * because the Round-2 review of TASK-001 proved that binding an approval to a
 * revision COUNTER is not enough: content can change without the counter
 * moving, and the stale approval still satisfies the gate. The same hazard
 * applies to plans — arguably more sharply, since a plan's whole purpose is to
 * be the thing execution is derived from.
 *
 * So the digest covers every field that is semantically authoritative: if it
 * can change what gets built, what "done" means, or what order things happen
 * in, it is in the hash. Fields that are pure provenance (`generatedAt`,
 * `plannerRunRef`) are deliberately NOT hashed — regenerating byte-identical
 * plan content at a different time is not a material change, and including a
 * timestamp would make an approval spuriously stale on any re-derivation.
 *
 * Field order is fixed here rather than relying on object key order, and items
 * are sorted by key, so the digest is stable across refactors and across any
 * ordering the planner happened to emit.
 */

import { createHash } from "node:crypto";

import type {
  Plan,
  PlanBudget,
  PlanExecutionConfig,
  PlannedWorkItem,
  PlannerConfig,
  PlanRevision,
} from "./planTypes.js";

/** The authoritative subset of a revision. Anything absent here is provenance, not content. */
export interface PlanDigestInput {
  readonly revision: number;
  readonly summary: string;
  readonly assumptions: readonly string[];
  readonly constraints: readonly string[];
  readonly risks: readonly string[];
  readonly items: readonly PlannedWorkItem[];
}

/**
 * Length-prefixes every variable-length field so two different structures can
 * never serialize to the same string. Without this, `["a|b"]` and `["a","b"]`
 * would collide under a naive join — a real, if unlikely, way to make two
 * different plans share one digest and therefore share one approval.
 */
function seg(value: string): string {
  return `${value.length}:${value}`;
}

function segList(values: readonly string[]): string {
  return `${values.length}[${values.map(seg).join("")}]`;
}

function canonicalItem(item: PlannedWorkItem): string {
  const criteria = item.acceptanceCriteria.map((criterion) => `${seg(criterion.text)}${seg(criterion.verificationHint)}`);
  return [
    `key:${seg(item.key)}`,
    `title:${seg(item.title)}`,
    `type:${seg(item.type)}`,
    `priority:${seg(item.priority)}`,
    `spec:${seg(item.spec)}`,
    `ac:${criteria.length}[${criteria.join("")}]`,
    // Dependencies are a SET, not a sequence: the same graph declared in a
    // different order is the same plan, so sorting here keeps the digest
    // stable without weakening it (planValidation separately rejects
    // duplicates, so sorting cannot mask one).
    `deps:${segList([...item.dependsOn].sort())}`,
  ].join("|");
}

export function computePlanContentDigest(input: PlanDigestInput): string {
  const items = [...input.items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const canonical = [
    `revision:${input.revision}`,
    `summary:${seg(input.summary)}`,
    `assumptions:${segList(input.assumptions)}`,
    `constraints:${segList(input.constraints)}`,
    `risks:${segList(input.risks)}`,
    `items:${items.length}[${items.map(canonicalItem).join("")}]`,
  ].join("|");
  return `plan-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

// =====================================================================
// The APPROVAL digest (remediation round 1, HIGH 4)
// =====================================================================

/**
 * The revision digest above answers "is the proposed WORK unchanged?". That is
 * necessary and was never sufficient: independent review reproduced switching a
 * plan's `projectId` from A to B, and rewriting its verification commands to
 * `sh -c ...`, while the approval remained valid — because neither field lives
 * in a revision.
 *
 * So what a human approval is bound to is THIS digest, which covers every
 * persisted plan field that can change WHAT gets executed, WHERE it is created,
 * or HOW it is verified. The classification rule applied here is deliberately
 * blunt, because a subtle one is what produced the finding: persisted plan
 * CONFIGURATION is approval-authoritative and hashed; only provenance
 * (timestamps, run refs, actors), append-only audit (events, answers) and
 * mutable runtime CHECKPOINTS (phase, version, claims, mappings, counters,
 * outcome) are excluded. See docs/tasks/TASK-005-planner-task-generator.md for
 * the field-by-field table.
 *
 * `budget` and `planner` are hashed even though both are spent before approval:
 * including them costs nothing, and "this field cannot matter after approval"
 * is exactly the reasoning that left `execution` unbound.
 */
export interface PlanApprovalDigestInput {
  readonly projectId: string;
  readonly intent: string;
  readonly declaredConstraints: readonly string[];
  readonly budget: PlanBudget;
  readonly planner: PlannerConfig;
  readonly execution: PlanExecutionConfig;
  readonly revision: PlanDigestInput;
}

/** `~` for absent, `=<value>` for present: an omitted field and an empty one never collide. */
function optSeg(value: string | undefined): string {
  return value === undefined ? "~" : `=${seg(value)}`;
}

function optNum(value: number | undefined): string {
  return value === undefined ? "~" : `=${value}`;
}

function canonicalWorkerConfig(config: PlannerConfig): string {
  return [
    `tool:${seg(config.tool)}`,
    `model:${seg(config.model)}`,
    `effort:${optSeg(config.effort)}`,
    `timeoutMs:${optNum(config.timeoutMs)}`,
  ].join(",");
}

function canonicalVerificationCommand(command: PlanExecutionConfig["verificationCommands"][number]): string {
  return [
    `id:${seg(command.id)}`,
    `executable:${seg(command.executable)}`,
    // A sequence, not a set: `["-e", "x"]` and `["x", "-e"]` are different commands.
    `argv:${segList(command.argv)}`,
    `cwd:${optSeg(command.cwd)}`,
    `timeoutMs:${optNum(command.timeoutMs)}`,
  ].join(",");
}

function canonicalLoopBudget(budget: PlanExecutionConfig["loopBudget"]): string {
  if (budget === undefined) {
    return "~";
  }
  return `=${[
    `maxIterations:${optNum(budget.maxIterations)}`,
    `maxTotalRuns:${optNum(budget.maxTotalRuns)}`,
    `maxWallClockMs:${optNum(budget.maxWallClockMs)}`,
    `workerTimeoutMs:${optNum(budget.workerTimeoutMs)}`,
    `verificationTimeoutMs:${optNum(budget.verificationTimeoutMs)}`,
  ].join(",")}`;
}

function canonicalExecution(execution: PlanExecutionConfig): string {
  const commands = execution.verificationCommands.map(canonicalVerificationCommand);
  return [
    `implementer:${canonicalWorkerConfig(execution.implementer)}`,
    `reviewer:${canonicalWorkerConfig(execution.reviewer)}`,
    `commands:${commands.length}[${commands.map(seg).join("")}]`,
    `workspaceRoot:${seg(execution.workspaceRoot)}`,
    `loopBudget:${canonicalLoopBudget(execution.loopBudget)}`,
  ].join("|");
}

function canonicalBudget(budget: PlanBudget): string {
  return [
    `maxPlannerAttempts:${budget.maxPlannerAttempts}`,
    `maxClarificationCycles:${budget.maxClarificationCycles}`,
    `maxTotalPlannerRuns:${budget.maxTotalPlannerRuns}`,
    `maxWallClockMs:${optNum(budget.maxWallClockMs)}`,
  ].join(",");
}

export function computePlanApprovalDigest(input: PlanApprovalDigestInput): string {
  const canonical = [
    "papr-v1",
    `projectId:${seg(input.projectId)}`,
    `intent:${seg(input.intent)}`,
    `declaredConstraints:${segList(input.declaredConstraints)}`,
    `budget:${seg(canonicalBudget(input.budget))}`,
    `planner:${seg(canonicalWorkerConfig(input.planner))}`,
    `execution:${seg(canonicalExecution(input.execution))}`,
    // The revision digest is recomputed from live content, never read from the
    // stored `contentDigest` field: a tampered revision must change this hash.
    `revision:${seg(computePlanContentDigest(input.revision))}`,
  ].join("|");
  return `papr-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

/**
 * THE single place a plan's approval digest is derived from a live plan value.
 * Every writer and every checker calls this, so "what was approved" cannot
 * drift between the approve path and the verify path.
 */
export function approvalDigestOfPlan(plan: Plan, revision: PlanRevision): string {
  return computePlanApprovalDigest({
    projectId: plan.projectId,
    intent: plan.intent,
    declaredConstraints: plan.declaredConstraints,
    budget: plan.budget,
    planner: plan.planner,
    execution: plan.execution,
    revision: {
      revision: revision.revision,
      summary: revision.summary,
      assumptions: revision.assumptions,
      constraints: revision.constraints,
      risks: revision.risks,
      items: revision.items,
    },
  });
}

/** Recomputes a stored revision's digest, for the read-time integrity check. */
export function digestOfRevision(revision: PlanRevision): string {
  return computePlanContentDigest({
    revision: revision.revision,
    summary: revision.summary,
    assumptions: revision.assumptions,
    constraints: revision.constraints,
    risks: revision.risks,
    items: revision.items,
  });
}

/** SHA-256 hex of an arbitrary string; used for deterministic request keys. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
