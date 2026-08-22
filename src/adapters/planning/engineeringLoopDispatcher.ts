/**
 * The real `LoopDispatcher`: a thin adapter onto the accepted TASK-004
 * `EngineeringLoopService`.
 *
 * Everything about TASK-004 that TASK-005 is allowed to touch passes through
 * this file, and it is deliberately small enough to read in one sitting. It
 * translates four planning-level operations into the loop service's own public
 * API and projects the result down to the handful of facts planning may see.
 *
 * It adds no loop logic of its own — no reconciliation, no verdict handling, no
 * phase interpretation beyond passing the phase string through. If TASK-005
 * ever needs to know more about a loop than `DispatchedLoopView` carries, that
 * is a signal to widen this projection deliberately, not to reach around it.
 */

import type { WorkItemId } from "../../domain/ids.js";
import type { LoopRepository } from "../../orchestration/loopRepository.js";
import type { EngineeringLoopService } from "../../orchestration/engineeringLoopService.js";
import { isTerminalLoopPhase, type EngineeringLoop } from "../../orchestration/loopTypes.js";
import type { DispatchedLoopView, DispatchLoopInput, LoopDispatcher } from "../../planning/loopDispatcher.js";
import type { Actor } from "../../domain/actor.js";
import type { LoopWorkerConfig, VerificationCommandConfig } from "../../orchestration/loopTypes.js";
import type { Workspace } from "../workers/workspace.js";

export interface EngineeringLoopDispatcherDeps {
  readonly service: EngineeringLoopService;
  /** Read-only use: finding an existing loop so a crash never causes a duplicate. */
  readonly loops: LoopRepository;
  readonly actor: Actor;
  readonly implementer: LoopWorkerConfig;
  readonly reviewer: LoopWorkerConfig;
  readonly verificationCommands: readonly VerificationCommandConfig[];
  readonly workspace: Workspace;
  readonly budget?: {
    readonly maxIterations?: number;
    readonly maxTotalRuns?: number;
    readonly maxWallClockMs?: number;
    readonly workerTimeoutMs?: number;
    readonly verificationTimeoutMs?: number;
  };
}

function project(loop: EngineeringLoop): DispatchedLoopView {
  return {
    loopId: loop.id,
    workItemId: loop.workItemId,
    phase: loop.phase,
    ...(loop.outcome === undefined ? {} : { outcome: loop.outcome }),
    ...(loop.failureReason === undefined ? {} : { failureReason: loop.failureReason }),
  };
}

export function createEngineeringLoopDispatcher(deps: EngineeringLoopDispatcherDeps): LoopDispatcher {
  return {
    async find(workItemId: WorkItemId): Promise<DispatchedLoopView | undefined> {
      const existing = await deps.loops.listByWorkItem(workItemId);
      // Prefer a still-active loop; otherwise report the most recent terminal
      // one, so a plan can see that this item's execution already concluded
      // rather than starting a second attempt behind the human's back.
      const active = existing.find((loop) => !isTerminalLoopPhase(loop.phase));
      const chosen = active ?? existing.at(-1);
      return chosen === undefined ? undefined : project(chosen);
    },

    async start(input: DispatchLoopInput): Promise<DispatchedLoopView> {
      const loop = await deps.service.start({
        workItemId: input.workItemId,
        actor: deps.actor,
        taskInstructions: input.taskInstructions,
        implementer: deps.implementer,
        reviewer: deps.reviewer,
        verificationCommands: deps.verificationCommands,
        workspace: deps.workspace,
        ...(deps.budget === undefined ? {} : { budget: deps.budget }),
      });
      return project(loop);
    },

    async resume(loopId: string): Promise<DispatchedLoopView> {
      return project(await deps.service.resume(loopId));
    },

    async status(loopId: string): Promise<DispatchedLoopView> {
      // Uses the loop service's own read path, which itself fails closed when a
      // cached WAITING_FOR_HUMAN is no longer backed by Factory authority
      // (TASK-004 remediation round 4). Planning inherits that guarantee rather
      // than re-deriving it.
      return project(await deps.service.status(loopId));
    },
  };
}
