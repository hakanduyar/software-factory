/**
 * Deterministic routing policy (TASK-006 §9).
 *
 * Maps a class of work to the resources allowed to perform it, and refuses
 * rather than improvising when none is available.
 *
 * Two rules are absolute and are the reason this is a module rather than an
 * `if` somewhere:
 *
 * REVIEWER INDEPENDENCE (C4). A routing whose reviewer resource equals the
 * implementer's is refused. Not deprioritised — refused. If no independent
 * reviewer is available the work WAITS. An implementer that reviews its own
 * work is the single failure this Factory's constitution exists to prevent, and
 * resource pressure is not an excuse to allow it.
 *
 * NO UNSUITABLE SUBSTITUTION. Each work class carries a quality floor. A
 * cheaper resource below that floor is not a fallback, it is a different
 * (worse) answer. When the floor cannot be met the work waits. Moving is not
 * more important than moving correctly.
 */

import type { WorkerTool } from "../adapters/workers/workerModelConfig.js";
import type { FactoryRole } from "../domain/role.js";
import { planAiRunConfig, type AiRunConfigRecord } from "./modelEnforcement.js";
import { isUsable, resourceKey, type ResourceRecord } from "./resourceTypes.js";

export const WORK_CLASSES = [
  "DETERMINISTIC",
  "SIMPLE_IMPLEMENTATION",
  "NORMAL_IMPLEMENTATION",
  "HIGH_RISK_IMPLEMENTATION",
  "ARCHITECTURE_SECURITY",
  "INDEPENDENT_REVIEW",
  "DOCS",
] as const;

export type WorkClass = (typeof WORK_CLASSES)[number];

/** Work that needs no AI at all. Never blocked by a provider limit. */
export function requiresAi(workClass: WorkClass): boolean {
  return workClass !== "DETERMINISTIC";
}

export interface ResourceOption {
  readonly provider: WorkerTool;
  readonly model: string;
  readonly effort?: string;
  /** Higher is more capable. Compared against a work class's floor. */
  readonly qualityTier: number;
}

export interface RoutingPolicy {
  /** Preference order per work class. First usable option that clears the floor wins. */
  readonly eligibleByWorkClass: Readonly<Record<WorkClass, readonly ResourceOption[]>>;
  readonly minimumQualityTier: Readonly<Record<WorkClass, number>>;
}

export interface RoutingRequest {
  readonly workClass: WorkClass;
  readonly role: FactoryRole;
  /**
   * Resource keys that may NOT be selected. For `INDEPENDENT_REVIEW` this
   * carries the implementer's resource, which is what enforces C4.
   */
  readonly excludeResourceKeys?: readonly string[];
}

export type RoutingResult =
  | { readonly ok: true; readonly option: ResourceOption; readonly config: AiRunConfigRecord }
  | {
      readonly ok: false;
      /**
       * `WAITING_FOR_RESOURCE` means "correct request, nothing available now" —
       * retry later. `REFUSED` means the request itself cannot be satisfied by
       * this policy and waiting will not help.
       */
      readonly outcome: "WAITING_FOR_RESOURCE" | "REFUSED";
      readonly reason: string;
    };

/**
 * Selects a resource, or explains why the work must wait.
 *
 * `resources` is the durable resource table keyed by `resourceKey`. A resource
 * with no record is treated as unavailable, never as optimistically usable —
 * absence of evidence is not evidence of availability.
 */
export function selectResource(
  request: RoutingRequest,
  policy: RoutingPolicy,
  resources: ReadonlyMap<string, ResourceRecord>,
): RoutingResult {
  const options = policy.eligibleByWorkClass[request.workClass];
  if (options === undefined || options.length === 0) {
    return { ok: false, outcome: "REFUSED", reason: `no resource is eligible for work class ${request.workClass}` };
  }
  const floor = policy.minimumQualityTier[request.workClass] ?? 0;
  const excluded = new Set(request.excludeResourceKeys ?? []);

  const belowFloor: string[] = [];
  const excludedForIndependence: string[] = [];
  const unavailable: string[] = [];

  for (const option of options) {
    const key = resourceKey(option.provider, option.model);

    if (option.qualityTier < floor) {
      // Deliberately NOT a fallback: running high-risk work on an
      // under-qualified model is a silent downgrade.
      belowFloor.push(key);
      continue;
    }
    if (excluded.has(key)) {
      excludedForIndependence.push(key);
      continue;
    }
    const record = resources.get(key);
    if (record === undefined || !isUsable(record)) {
      unavailable.push(`${key}(${record?.state ?? "UNKNOWN"})`);
      continue;
    }

    const config = planAiRunConfig({
      provider: option.provider,
      model: option.model,
      ...(option.effort === undefined ? {} : { effort: option.effort }),
      role: request.role,
    });
    if (!config.ok) {
      // A configuration the installed CLI cannot honour is not usable, and we
      // do not downgrade it to make it fit.
      unavailable.push(`${key}(unconfigurable: ${config.reason})`);
      continue;
    }
    return { ok: true, option, config: config.value };
  }

  const detail = [
    unavailable.length === 0 ? undefined : `unavailable: ${unavailable.join(", ")}`,
    excludedForIndependence.length === 0
      ? undefined
      : `excluded to preserve reviewer independence: ${excludedForIndependence.join(", ")}`,
    belowFloor.length === 0 ? undefined : `below the quality floor (${floor}): ${belowFloor.join(", ")}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ");

  return {
    ok: false,
    outcome: "WAITING_FOR_RESOURCE",
    reason: `no eligible resource for ${request.workClass}: ${detail}`,
  };
}

/**
 * The shipped default policy.
 *
 * Model identifiers here are configuration, not architecture: C9 forbids any
 * core object requiring a specific vendor, and this table is the one place a
 * vendor name legitimately appears. Quality tiers are relative and exist only
 * to express "do not run architecture work on the cheap model".
 */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  eligibleByWorkClass: {
    DETERMINISTIC: [],
    SIMPLE_IMPLEMENTATION: [
      { provider: "claude-code", model: "sonnet", qualityTier: 2 },
      { provider: "codex-cli", model: "gpt-5.6-luna", effort: "medium", qualityTier: 3 },
    ],
    NORMAL_IMPLEMENTATION: [
      { provider: "claude-code", model: "sonnet", qualityTier: 2 },
      { provider: "codex-cli", model: "gpt-5.6-luna", effort: "high", qualityTier: 3 },
    ],
    HIGH_RISK_IMPLEMENTATION: [
      { provider: "claude-code", model: "opus", effort: "high", qualityTier: 4 },
      { provider: "codex-cli", model: "gpt-5.6-luna", effort: "xhigh", qualityTier: 4 },
    ],
    ARCHITECTURE_SECURITY: [
      { provider: "claude-code", model: "opus", effort: "xhigh", qualityTier: 5 },
      { provider: "codex-cli", model: "gpt-5.6-luna", effort: "xhigh", qualityTier: 5 },
    ],
    INDEPENDENT_REVIEW: [
      { provider: "codex-cli", model: "gpt-5.6-luna", effort: "xhigh", qualityTier: 5 },
      { provider: "claude-code", model: "opus", effort: "xhigh", qualityTier: 5 },
    ],
    DOCS: [
      { provider: "claude-code", model: "sonnet", qualityTier: 1 },
      { provider: "codex-cli", model: "gpt-5.6-luna", effort: "low", qualityTier: 1 },
    ],
  },
  minimumQualityTier: {
    DETERMINISTIC: 0,
    SIMPLE_IMPLEMENTATION: 2,
    NORMAL_IMPLEMENTATION: 2,
    HIGH_RISK_IMPLEMENTATION: 4,
    ARCHITECTURE_SECURITY: 5,
    INDEPENDENT_REVIEW: 5,
    DOCS: 1,
  },
};
