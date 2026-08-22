/**
 * Deterministic, scripted planning collaborators for TASK-005's offline demo
 * (`npm run demo:plan`) and for automated tests.
 *
 * Plays the same role `scriptedLoopWorkers.ts` plays for TASK-004: no network,
 * no AI provider, and a *sequence* of outcomes across successive calls, so a
 * scenario can script "reject the first output, then produce a valid plan" or
 * "ask a question, then plan once answered" — which a fixed adapter cannot do.
 *
 * Automated tests must never invoke a real AI CLI, and nothing in this module
 * can: it returns canned strings.
 */

import type { WorkItemId } from "../domain/ids.js";
import type { DispatchedLoopView, DispatchLoopInput, LoopDispatcher } from "./loopDispatcher.js";
import { PLAN_MARKER } from "./plannerOutputContract.js";
import type { PlannerOutcome, PlannerRequest, PlannerWorker } from "./plannerWorker.js";

/** Convenience shape for building a valid planner response body in tests/demos. */
export interface ScriptedPlanBody {
  readonly summary: string;
  readonly assumptions?: readonly string[];
  readonly constraints?: readonly string[];
  readonly risks?: readonly string[];
  readonly blockingQuestions?: readonly { readonly id: string; readonly question: string; readonly why: string }[];
  readonly items?: readonly {
    readonly key: string;
    readonly title: string;
    readonly type?: string;
    readonly priority?: string;
    readonly spec: string;
    readonly acceptanceCriteria?: readonly { readonly text: string; readonly verificationHint: string }[];
    readonly dependsOn?: readonly string[];
  }[];
}

/** Renders a body as a contract-satisfying planner response (marker + one fenced json block). */
export function renderPlannerResponse(body: ScriptedPlanBody): string {
  const payload = {
    summary: body.summary,
    assumptions: body.assumptions ?? [],
    constraints: body.constraints ?? [],
    risks: body.risks ?? [],
    blockingQuestions: body.blockingQuestions ?? [],
    items: (body.items ?? []).map((item) => ({
      key: item.key,
      title: item.title,
      type: item.type ?? "FEATURE",
      priority: item.priority ?? "P2",
      spec: item.spec,
      acceptanceCriteria: item.acceptanceCriteria ?? [{ text: `${item.title} behaves as specified`, verificationHint: "npm test" }],
      dependsOn: item.dependsOn ?? [],
    })),
  };
  return [
    "Here is the plan I propose for your review.",
    "",
    PLAN_MARKER,
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

export interface ScriptedPlannerOptions {
  readonly id?: string;
  /** Raw output per successive call, indexed by call count; the last entry repeats once exhausted. */
  readonly outputs: readonly string[];
  /** Process-level status per call; defaults to SUCCEEDED for every call. */
  readonly statuses?: readonly ("SUCCEEDED" | "FAILED")[];
}

export function createScriptedPlannerWorker(options: ScriptedPlannerOptions): PlannerWorker {
  let calls = 0;
  return {
    id: options.id ?? "scripted-planner",
    async plan(request: PlannerRequest): Promise<PlannerOutcome> {
      const index = Math.min(calls, options.outputs.length - 1);
      const rawOutput = options.outputs[index] ?? "";
      const status = options.statuses === undefined ? "SUCCEEDED" : (options.statuses[Math.min(calls, options.statuses.length - 1)] ?? "SUCCEEDED");
      calls += 1;
      return {
        status,
        rawOutput: status === "SUCCEEDED" ? rawOutput : "",
        summary: `[scripted-planner] call ${calls} for ${request.correlationTag}: ${status}`,
      };
    },
  };
}

export interface ScriptedLoopBehaviour {
  /** The phase the loop reports once started. Defaults to WAITING_FOR_HUMAN. */
  readonly phase?: string;
  readonly outcome?: string;
  readonly failureReason?: string;
}

export interface ScriptedDispatcherOptions {
  /** Per-work-item behaviour; anything unlisted uses `defaultBehaviour`. */
  readonly behaviours?: Readonly<Record<string, ScriptedLoopBehaviour>>;
  readonly defaultBehaviour?: ScriptedLoopBehaviour;
  readonly log?: (line: string) => void;
}

export interface ScriptedDispatcher extends LoopDispatcher {
  /** Test hook: how many loops were actually started (never adopted). Proves no duplicate dispatch. */
  startCount(): number;
  /** Test hook: force a work item's loop into a new phase, simulating TASK-004 progress. */
  setPhase(workItemId: WorkItemId, behaviour: ScriptedLoopBehaviour): void;
}

/**
 * A stand-in for the accepted `EngineeringLoopService` that records what it was
 * asked to do. It enforces the same one-loop-per-work-item rule the real
 * TASK-004 repository enforces with a database constraint, so a test that
 * proves "no duplicate dispatch" here is proving it against the same rule
 * production runs under.
 */
export function createScriptedDispatcher(options: ScriptedDispatcherOptions = {}): ScriptedDispatcher {
  const loops = new Map<WorkItemId, DispatchedLoopView>();
  const byLoopId = new Map<string, WorkItemId>();
  const log = options.log ?? ((): void => {});
  let started = 0;
  let counter = 0;

  function behaviourFor(workItemId: WorkItemId): ScriptedLoopBehaviour {
    return options.behaviours?.[workItemId] ?? options.defaultBehaviour ?? { phase: "WAITING_FOR_HUMAN", outcome: "WAITING_FOR_HUMAN" };
  }

  function view(workItemId: WorkItemId, loopId: string, behaviour: ScriptedLoopBehaviour): DispatchedLoopView {
    return {
      loopId,
      workItemId,
      phase: behaviour.phase ?? "WAITING_FOR_HUMAN",
      ...(behaviour.outcome === undefined ? {} : { outcome: behaviour.outcome }),
      ...(behaviour.failureReason === undefined ? {} : { failureReason: behaviour.failureReason }),
    };
  }

  return {
    async find(workItemId: WorkItemId): Promise<DispatchedLoopView | undefined> {
      return loops.get(workItemId);
    },
    async start(input: DispatchLoopInput): Promise<DispatchedLoopView> {
      const existing = loops.get(input.workItemId);
      if (existing !== undefined) {
        // Mirrors the real repository's active-loop uniqueness constraint.
        throw new Error(`a loop already exists for work item ${input.workItemId}`);
      }
      counter += 1;
      started += 1;
      const loopId = `loop-${String(counter).padStart(4, "0")}`;
      const created = view(input.workItemId, loopId, behaviourFor(input.workItemId));
      loops.set(input.workItemId, created);
      byLoopId.set(loopId, input.workItemId);
      log(`[scripted-dispatcher] started ${loopId} for ${input.workItemId} -> ${created.phase}`);
      return created;
    },
    async resume(loopId: string): Promise<DispatchedLoopView> {
      const workItemId = byLoopId.get(loopId);
      const existing = workItemId === undefined ? undefined : loops.get(workItemId);
      if (existing === undefined) {
        throw new Error(`no scripted loop ${loopId}`);
      }
      return existing;
    },
    async status(loopId: string): Promise<DispatchedLoopView> {
      const workItemId = byLoopId.get(loopId);
      const existing = workItemId === undefined ? undefined : loops.get(workItemId);
      if (existing === undefined) {
        throw new Error(`no scripted loop ${loopId}`);
      }
      return existing;
    },
    startCount(): number {
      return started;
    },
    setPhase(workItemId: WorkItemId, behaviour: ScriptedLoopBehaviour): void {
      const existing = loops.get(workItemId);
      if (existing === undefined) {
        return;
      }
      loops.set(workItemId, view(workItemId, existing.loopId, behaviour));
    },
  };
}
