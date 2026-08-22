/**
 * The narrow seam between TASK-005 planning and the accepted TASK-004
 * autonomous engineering loop.
 *
 * TASK-005 implements NO second engineering loop. It never touches
 * implement/verify/review/remediate state, never reconciles worker actions,
 * never interprets a reviewer verdict. It decides only WHICH approved work item
 * is eligible to run next, and hands that item to TASK-004.
 *
 * This port exists so that boundary is structural rather than a matter of
 * discipline: the planning service is typed against these four operations, so
 * there is no reachable API through which it could drive a loop's internals
 * even by mistake. It also keeps tests honest — a scripted dispatcher stands in
 * for the real one, so planning tests never launch a real AI CLI.
 *
 * The `find` operation is what makes dispatch idempotent across crashes:
 * combined with TASK-004's database-level one-active-loop-per-work-item
 * constraint, "look before starting" plus "starting twice is refused by the
 * database" means a duplicate loop cannot exist even if both checks race.
 */

import type { WorkItemId } from "../domain/ids.js";

/** The only loop facts planning is allowed to see. Deliberately not the whole EngineeringLoop. */
export interface DispatchedLoopView {
  readonly loopId: string;
  readonly workItemId: WorkItemId;
  /** TASK-004 `LoopPhase`, as a string — planning treats it as opaque except for the checks below. */
  readonly phase: string;
  readonly outcome?: string;
  readonly failureReason?: string;
}

export interface DispatchLoopInput {
  readonly workItemId: WorkItemId;
  /** Bounded spec/task text handed to the implementer. */
  readonly taskInstructions: string;
}

export interface LoopDispatcher {
  /**
   * The existing loop for this work item, if any — active or terminal. Used to
   * adopt rather than duplicate after a crash between claiming and starting.
   */
  find(workItemId: WorkItemId): Promise<DispatchedLoopView | undefined>;
  start(input: DispatchLoopInput): Promise<DispatchedLoopView>;
  resume(loopId: string): Promise<DispatchedLoopView>;
  /** Read-only; must not manufacture authority (TASK-004 round-4 discipline). */
  status(loopId: string): Promise<DispatchedLoopView>;
}

/** TASK-004 phases that mean the loop finished its work and a human must now decide. */
export const LOOP_PHASE_EXECUTION_FINISHED = "WAITING_FOR_HUMAN";

/** TASK-004 phases that mean downstream work must not proceed. */
export const LOOP_PHASES_BLOCKING: readonly string[] = ["EXHAUSTED", "FAILED", "RECOVERY_REQUIRED", "CANCELLED"];
