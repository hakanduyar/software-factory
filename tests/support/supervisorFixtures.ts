/**
 * Deterministic TASK-006 supervisor fixtures.
 *
 * Everything here is offline and scripted: no provider is contacted, no model
 * is invoked, no money can be spent. The clock is manual so that "wait until
 * retryAt" can be tested by advancing time rather than by sleeping.
 */

import { createInMemorySupervisorRepository } from "../../src/adapters/supervision/inMemorySupervisorRepository.js";
import {
  launchAiWorkerAction,
  observeBilling,
  type BillingMode,
  type SupervisedAction,
} from "../../src/supervision/financialSafety.js";
import { createSequentialIdGenerator } from "../../src/domain/ids.js";
import type { Timestamp } from "../../src/domain/time.js";
import { DEFAULT_ROUTING_POLICY, type RoutingPolicy } from "../../src/supervision/modelRouting.js";
import type { Classification } from "../../src/supervision/resourceClassifier.js";
import { resourceKey } from "../../src/supervision/resourceTypes.js";
import { SupervisorService, type SupervisorServiceDeps } from "../../src/supervision/supervisorService.js";
export type { SupervisorServiceDeps };
import type {
  ResourceProbe,
  SupervisorRepository,
  WorkExecutionInput,
  WorkExecutor,
  WorkOutcome,
} from "../../src/supervision/supervisorPorts.js";
import { DEFAULT_ROADMAP, type RoadmapItem } from "../../src/supervision/supervisorTypes.js";

export const T0 = 1_800_000_000_000;

/**
 * Builds a launch action the way the SUPERVISOR does: from an observation bound
 * to the resource, rather than from a bare `billingMode` string.
 *
 * Round 10 (R10-FIN-1) removed the string form from the public minter, because
 * it let any caller assert that a metered resource was free. Tests that care
 * about billing semantics go through this; tests that care about the MINT
 * boundary itself still call `launchAiWorkerAction` directly, which is the
 * point of keeping the two separate.
 */
export function launchWithObservedBilling(input: {
  readonly resourceKey: string;
  readonly billingMode: BillingMode;
  readonly description: string;
  readonly reviewer?: boolean;
}): SupervisedAction {
  const separator = input.resourceKey.indexOf(":");
  const provider = separator === -1 ? input.resourceKey : input.resourceKey.slice(0, separator);
  const model = separator === -1 ? "" : input.resourceKey.slice(separator + 1);
  return launchAiWorkerAction({
    resourceKey: input.resourceKey,
    observation: observeBilling({ provider, model, billingMode: input.billingMode }),
    description: input.description,
    ...(input.reviewer === undefined ? {} : { reviewer: input.reviewer }),
  });
}

export interface ManualClock {
  now(): Timestamp;
  advance(ms: number): void;
}

export function manualClock(start: Timestamp = T0): ManualClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export interface ScriptedProbe extends ResourceProbe {
  /** How many times each resource was probed. Proves "no polling before retryAt". */
  probeCount(provider: string, model: string): number;
  totalProbes(): number;
  set(provider: string, model: string, classification: Classification): void;
}

/**
 * The default healthy classification.
 *
 * It reports `INCLUDED_SUBSCRIPTION` because the REAL probes now do: both
 * installed CLIs report subscription-backed auth, and since NEW-FIN-1 the
 * supervisor derives billing mode from that observation rather than from
 * configuration. A probe that reported no billing mode would (correctly) make
 * every AI action financial — which is what `scriptedProbe` without a mode
 * still does, and what one test relies on.
 */
export const HEALTHY_INCLUDED: Classification = {
  state: "AVAILABLE",
  reason: "scripted default",
  billingMode: "INCLUDED_SUBSCRIPTION",
};

export function scriptedProbe(initial: Record<string, Classification> = {}): ScriptedProbe {
  const states = new Map<string, Classification>(Object.entries(initial));
  const counts = new Map<string, number>();
  return {
    async probe(provider, model) {
      const key = resourceKey(provider, model);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return states.get(key) ?? HEALTHY_INCLUDED;
    },
    probeCount: (provider, model) => counts.get(resourceKey(provider, model)) ?? 0,
    totalProbes: () => [...counts.values()].reduce((sum, value) => sum + value, 0),
    set: (provider, model, classification) => {
      states.set(resourceKey(provider, model), classification);
    },
  };
}

export interface ScriptedExecutor extends WorkExecutor {
  /** Every execution the supervisor actually launched, in order. */
  calls(): readonly WorkExecutionInput[];
  callsFor(roadmapKey: string): readonly WorkExecutionInput[];
}

/**
 * Returns queued outcomes per roadmap key; the last one repeats. An absent key
 * completes immediately, which keeps unrelated roadmap items out of the way.
 */
/**
 * Reports the identity a well-behaved executor would report: exactly the
 * configuration it was handed.
 *
 * Round 6 (F6-ID-1): an AI run that reports NO identity can no longer be
 * accepted as complete — `UNVERIFIED` is an honest label for missing evidence,
 * not a licence to mark work done. So the scripted executor now behaves like a
 * cooperating one. Tests that need a LYING or SILENT executor override this
 * deliberately, which is the point: silence is now a distinguishable behaviour
 * rather than the default everything accidentally relied on.
 */
function reportedIdentityFor(input: WorkExecutionInput): Record<string, never> | { readonly reportedIdentity: {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
} } {
  if (input.config === undefined) {
    return {};
  }
  return {
    reportedIdentity: {
      provider: input.config.requestedProvider,
      model: input.config.requestedModel,
      ...(input.config.requestedEffort === undefined ? {} : { effort: input.config.requestedEffort }),
    },
  };
}

export function scriptedExecutor(script: Record<string, readonly WorkOutcome[]> = {}): ScriptedExecutor {
  const recorded: WorkExecutionInput[] = [];
  const cursors = new Map<string, number>();
  return {
    async execute(input) {
      recorded.push(input);
      const queue = script[input.item.key];
      if (queue === undefined || queue.length === 0) {
        return {
          kind: "COMPLETED",
          detail: `scripted completion of ${input.item.key}`,
          ...reportedIdentityFor(input),
        };
      }
      const index = Math.min(cursors.get(input.item.key) ?? 0, queue.length - 1);
      cursors.set(input.item.key, index + 1);
      const outcome = queue[index]!;
      // A scripted COMPLETED is a cooperating executor unless the script says
      // otherwise, so fill in the identity it would have reported.
      return outcome.kind === "COMPLETED" && outcome.reportedIdentity === undefined
        ? { ...outcome, ...reportedIdentityFor(input) }
        : outcome;
    },
    calls: () => recorded,
    callsFor: (roadmapKey) => recorded.filter((call) => call.item.key === roadmapKey),
  };
}

export interface TestSupervisor {
  readonly service: SupervisorService;
  readonly repository: SupervisorRepository;
  readonly probe: ScriptedProbe;
  readonly executor: ScriptedExecutor;
  readonly clock: ManualClock;
  /**
   * This installation's ROADMAP CATALOG (TASK-012 AC-4).
   *
   * A live array the service holds by reference, so `seedRoadmap` can declare a
   * test's roadmap in CODE — which is the whole point of the task: a roadmap
   * that arrives only through persisted state is exactly what the supervisor
   * now refuses. Production passes `DEFAULT_ROADMAP` and never mutates it.
   */
  readonly catalog: RoadmapItem[];
}

export interface NewSupervisorOptions {
  readonly roadmap?: readonly RoadmapItem[];
  readonly probe?: ScriptedProbe;
  readonly executor?: ScriptedExecutor;
  readonly clock?: ManualClock;
  readonly repository?: SupervisorRepository;
  readonly routingPolicy?: RoutingPolicy;
  readonly resourceCatalog?: SupervisorServiceDeps["resourceCatalog"];
  readonly ownerId?: string;
  /** Captures log output so tests can assert on it (used by the N-3 / NEW-SEC-1 checks). */
  readonly log?: (line: string) => void;
}

/**
 * Declares how each test resource is paid for. Required since finding F-2: an
 * undeclared resource is UNKNOWN, and using it is a financial action — which is
 * exactly the behaviour a separate test now pins down.
 */
export const TEST_CATALOG = [
  { provider: "claude-code", model: "opus", billingMode: "INCLUDED_SUBSCRIPTION" as const },
  { provider: "claude-code", model: "sonnet", billingMode: "INCLUDED_SUBSCRIPTION" as const },
  { provider: "codex-cli", model: "gpt-5.6-luna", billingMode: "INCLUDED_SUBSCRIPTION" as const },
];

/** The same resources with no declared billing — using them must be refused. */
export const UNDECLARED_CATALOG = [
  { provider: "claude-code", model: "sonnet" },
  { provider: "codex-cli", model: "gpt-5.6-luna" },
];

/** A two-item roadmap where B depends on A — the minimum shape for "next task follows". */
export const TWO_ITEM_ROADMAP: readonly RoadmapItem[] = [
  { key: "A", title: "First item", dependsOn: [], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
  { key: "B", title: "Second item", dependsOn: ["A"], status: "PENDING", workClass: "NORMAL_IMPLEMENTATION", order: 2 },
];

export function newSupervisor(options: NewSupervisorOptions = {}): TestSupervisor {
  const clock = options.clock ?? manualClock();
  const repository = options.repository ?? createInMemorySupervisorRepository();
  const probe = options.probe ?? scriptedProbe();
  const executor = options.executor ?? scriptedExecutor();

  const catalog: RoadmapItem[] = [...(options.roadmap ?? DEFAULT_ROADMAP)];
  const deps: SupervisorServiceDeps = {
    repository,
    roadmapCatalog: catalog,
    probe,
    executor,
    clock: { now: () => clock.now() },
    ids: createSequentialIdGenerator(),
    routingPolicy: options.routingPolicy ?? DEFAULT_ROUTING_POLICY,
    resourceCatalog: options.resourceCatalog ?? TEST_CATALOG,
    ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
    ...(options.log === undefined ? {} : { log: options.log }),
  };
  return { service: new SupervisorService(deps), repository, probe, executor, clock, catalog };
}

/** Seeds state, then replaces the roadmap with the supplied one. */
export async function seedRoadmap(
  supervisor: TestSupervisor,
  roadmap: readonly RoadmapItem[],
): Promise<void> {
  // DECLARED in the catalog as well as persisted. A roadmap that exists only in
  // the database is the tampered case TASK-012 refuses, so a fixture that seeded
  // one without declaring it would be testing the refusal, not the scenario.
  supervisor.catalog.splice(0, supervisor.catalog.length, ...roadmap.map((item) => ({ ...item })));
  const state = await supervisor.service.ensureInitialized();
  await supervisor.repository.compareAndSave({ ...state, version: state.version + 1, roadmap }, state.version);
}

/**
 * Declares whatever roadmap is currently persisted, without changing it.
 *
 * For a test that sets up state by writing the repository directly and whose
 * subject is something else entirely — a backoff ladder, a claim, a probe. The
 * roadmap it wrote is a legitimate one that simply was not declared, and this
 * says so in one place a reader can see.
 *
 * A test that means to TAMPER with a definition does not call this. That is the
 * whole distinction, and it is why this is an explicit call rather than
 * something the fixture does silently on every write.
 */
export async function declarePersisted(supervisor: TestSupervisor): Promise<void> {
  const state = await supervisor.repository.load();
  if (state === undefined) return;
  supervisor.catalog.splice(0, supervisor.catalog.length, ...state.roadmap.map((item) => ({ ...item })));
}

/**
 * Persists a roadmap WITHOUT declaring it — the tampering TASK-012 exists for.
 *
 * Separate from `seedRoadmap` so that every use is a visible choice: a test that
 * wants a legitimate roadmap says so, and a test that wants a forged one says
 * that instead.
 */
export async function tamperRoadmap(
  supervisor: TestSupervisor,
  roadmap: readonly RoadmapItem[],
): Promise<void> {
  const state = await supervisor.service.ensureInitialized();
  await supervisor.repository.compareAndSave({ ...state, version: state.version + 1, roadmap }, state.version);
}
