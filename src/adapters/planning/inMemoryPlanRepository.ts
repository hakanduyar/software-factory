/**
 * In-memory PlanRepository (TASK-005), for tests and the offline demo.
 *
 * Enforces exactly the same two invariants the SQLite adapter enforces with
 * database constraints — id uniqueness and at-most-one-ACTIVE-plan per request
 * key — so a test that passes here is testing the same rules production runs
 * under, and `deepFreeze`s every stored value so a retained caller reference
 * cannot mutate persisted state.
 */

import { ConcurrencyError } from "../../domain/errors.js";
import { deepFreeze } from "../../domain/freeze.js";
import type { ProjectId } from "../../domain/ids.js";
import type { PlanRepository } from "../../planning/planRepository.js";
import { ACTIVE_PLAN_PHASES, type Plan } from "../../planning/planTypes.js";

function isActive(plan: Plan): boolean {
  return (ACTIVE_PLAN_PHASES as readonly string[]).includes(plan.phase);
}

export function createInMemoryPlanRepository(): PlanRepository {
  const plans = new Map<string, Plan>();

  return {
    async create(plan: Plan): Promise<Plan> {
      if (plans.has(plan.id)) {
        throw new ConcurrencyError(`Plan ${plan.id} already exists`);
      }
      if (isActive(plan)) {
        for (const existing of plans.values()) {
          if (existing.requestKey === plan.requestKey && isActive(existing)) {
            throw new ConcurrencyError(`an active Plan already exists for request ${plan.requestKey}`);
          }
        }
      }
      const frozen = deepFreeze(plan);
      plans.set(frozen.id, frozen);
      return frozen;
    },

    async compareAndSave(plan: Plan, expectedVersion: number): Promise<Plan> {
      const current = plans.get(plan.id);
      const currentVersion = current === undefined ? 0 : current.version;
      if (currentVersion !== expectedVersion) {
        throw new ConcurrencyError(
          `Plan ${plan.id} version conflict: expected current version ${expectedVersion}, found ${currentVersion}`,
        );
      }
      const frozen = deepFreeze(plan);
      plans.set(frozen.id, frozen);
      return frozen;
    },

    async findById(id: string): Promise<Plan | undefined> {
      return plans.get(id);
    },

    async findActiveByRequestKey(requestKey: string): Promise<Plan | undefined> {
      for (const plan of plans.values()) {
        if (plan.requestKey === requestKey && isActive(plan)) {
          return plan;
        }
      }
      return undefined;
    },

    async listByProject(projectId: ProjectId): Promise<readonly Plan[]> {
      return [...plans.values()].filter((plan) => plan.projectId === projectId);
    },
  };
}
