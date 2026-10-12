/**
 * `WorkerRunLifecycle` against the existing `SupervisorState`/`SupervisorRepository`
 * (DEFECT-DURABLE-WORKER-RUN-ENVELOPE).
 *
 * The one and only store is the same JSON blob `compareAndSave` already
 * writes with CAS on `version`. This module adds no database, no table and no
 * second writer: it reads `state.workerRuns`, applies one pure transition from
 * `workerRunEnvelope.ts`, and writes the whole state back with the version it
 * read — retrying against freshly reloaded state on a lost CAS race, exactly
 * the `commitActivityChange` idiom `supervisorService.ts` already uses for
 * `Activity`.
 *
 * PREPARE AND ADOPT THROW ON REFUSAL, DELIBERATELY. A caller that cannot
 * durably record PREPARED must not spawn a process (AC-1); a caller that
 * cannot durably adopt RUNNING has a process already running with nothing
 * durable to show for it, which is a fact the caller must surface rather than
 * silently swallow. HEARTBEAT NEVER THROWS: a failed heartbeat write is not
 * evidence the process should be disturbed, only that this tick's liveness
 * proof did not land — the next tick tries again.
 */

import { ConcurrencyError } from "../../domain/errors.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../../ports/processRunner.js";
import type { ActivityLease } from "../../supervision/activity.js";
import { canonicalWorkerRunId, isTerminalWorkerRunState, type WorkerInvocation } from "../../supervision/workerRunEnvelope.js";
import { bootIdentity, machineIdentity, processStartTime } from "./procLiveness.js";
import { createSqliteSupervisorRepository } from "./sqliteSupervisorRepository.js";
import { readWorkerRunArtifact, workerRunArtifactPath, writeWorkerRunArtifact } from "./workerRunArtifact.js";
import type { Clock } from "../../ports/clock.js";
import type {
  SupervisorRepository,
  WorkerRunAdoptRequest,
  WorkerRunCompleteRequest,
  WorkerRunHeartbeatRequest,
  WorkerRunLifecycle,
  WorkerRunPrepareRequest,
} from "../../supervision/supervisorPorts.js";
import type { SupervisorState } from "../../supervision/supervisorTypes.js";
import {
  adoptWorkerRun,
  completeWorkerRun,
  prepareWorkerRun,
  reportWorkerRunHeartbeat,
  type WorkerRunEnvelope,
  type WorkerRunCompletionInput,
} from "../../supervision/workerRunEnvelope.js";

/** Bounded: a race that outlives this many reload-and-retry cycles is not a transient loser, it is a stuck writer. */
const MAX_CAS_ATTEMPTS = 5;

export interface ProviderMetadata {
  readonly providerSessionId?: string;
  readonly terminalReason?: "MAX_TURNS";
}
export interface ProviderInvocationConfig {
  readonly provider: string;
  readonly model: string;
  readonly maxTurns?: number;
}
export interface ProviderLifecycle {
  run(config: ProviderInvocationConfig, runner: ProcessRunner, request: ProcessRequest,
    interpret: (result: ProcessResult) => ProviderMetadata): Promise<ProcessResult>;
}
const providerScope = new AsyncLocalStorage<ProviderLifecycle>();
export function currentProviderLifecycle(): ProviderLifecycle | undefined { return providerScope.getStore(); }

/** One explicit action binding crosses the plan-resume process boundary. */
export async function withWorkerRunEnvironment<T>(operation: () => Promise<T>, env = process.env): Promise<T> {
  const encoded = env["FACTORY_WORKER_RUN_BINDING"];
  if (encoded === undefined) return operation();
  const binding = JSON.parse(encoded) as Record<string, unknown>;
  const { actionId, runId, database, artifactDir } = binding;
  if (typeof actionId !== "string" || runId !== canonicalWorkerRunId(actionId) ||
      typeof database !== "string" || typeof artifactDir !== "string") throw new Error("invalid worker action binding");
  const repository = createSqliteSupervisorRepository(database);
  try {
    return await providerScope.run(createProviderLifecycle({
      repository, clock: { now: () => Date.now() }, actionId, artifactDir,
    }), operation);
  } finally { repository.close(); }
}

/** Uses the existing state CAS; every provider launch has its own ordered intent and ACK. */
export function createProviderLifecycle(deps: WorkerRunLifecycleDeps & {
  readonly actionId: string; readonly artifactDir: string; readonly heartbeatIntervalMs?: number;
}): ProviderLifecycle {
  const runId = canonicalWorkerRunId(deps.actionId);
  const lifecycle = createWorkerRunLifecycle(deps);
  async function update(change: (run: WorkerRunEnvelope) => WorkerRunEnvelope): Promise<WorkerRunEnvelope> {
    for (let retry = 0; retry < MAX_CAS_ATTEMPTS; retry += 1) {
      const state = await loadOrThrow(deps.repository);
      const run = state.workerRuns?.find((entry) => entry.runId === runId && entry.actionId === deps.actionId);
      if (run === undefined) throw new Error("provider launch has no canonical PREPARED action");
      const next = change(run);
      try {
        await deps.repository.compareAndSave({ ...state, version: state.version + 1,
          workerRuns: state.workerRuns!.map((entry) => entry.runId === runId ? next : entry) }, state.version);
        return next;
      } catch (error) { if (!(error instanceof ConcurrencyError)) throw error; }
    }
    throw new Error("provider lifecycle CAS exhausted");
  }
  function identity(pid: number): ActivityLease {
    const processStartedAt = processStartTime(pid);
    const boot = bootIdentity();
    if (processStartedAt === undefined || boot === undefined) throw new Error("provider ACK identity unavailable");
    return { pid, processStartedAt, boot, machine: machineIdentity(), claimedAt: deps.clock.now() };
  }
  return {
    async run(config, runner, request, interpret) {
      const prepared = await update((run) => {
        if (isTerminalWorkerRunState(run.state) || run.invocations?.some((entry) =>
          entry.finishedAt === undefined || entry.terminalReason === "MAX_TURNS")) {
          throw new Error("provider launch refused: action awaits settlement or controller");
        }
        const invocation: WorkerInvocation = { ...config, sequence: (run.invocations?.length ?? 0) + 1,
          preparedAt: deps.clock.now() };
        return { ...run, invocations: [...(run.invocations ?? []), invocation], updatedAt: deps.clock.now() };
      });
      const sequence = prepared.invocations!.length;
      const wrapperLease = identity(process.pid);
      const abort = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      let finished = false;
      let progress = prepared.heartbeat?.progress ?? 0;
      let ack: Promise<void> = Promise.resolve();
      let ackError: unknown;
      let acknowledged = false;
      let heartbeatPending = Promise.resolve();
      let result: ProcessResult;
      try {
        result = await runner.run({ ...request, signal: abort.signal,
          onOutput(bytes) { progress += bytes; request.onOutput?.(bytes); },
          onSpawn({ pid }) {
            // Capture the real provider start tick synchronously, before a fast exit can reap it.
            try {
              const lease = identity(pid);
              ack = update((run) => {
                const child = run.invocations?.[sequence - 1];
                if (isTerminalWorkerRunState(run.state) || child === undefined || child.lease !== undefined)
                  throw new Error("provider ACK refused");
                return { ...run, state: "RUNNING", wrapperLease: run.wrapperLease ?? wrapperLease,
                  childPid: run.childPid ?? pid, startedAt: run.startedAt ?? lease.claimedAt,
                  invocations: run.invocations!.map((entry) => entry.sequence === sequence ? { ...entry, lease } : entry),
                  updatedAt: deps.clock.now() };
              }).then(() => {
                acknowledged = true;
                if (!finished) {
                  timer = setInterval(() => {
                    heartbeatPending = heartbeatPending.then(async () => {
                      await lifecycle.heartbeat({ runId, holder: wrapperLease,
                        heartbeat: { at: deps.clock.now(), progress } });
                    }).catch(() => {});
                  }, deps.heartbeatIntervalMs ?? 5000);
                  timer.unref();
                }
              }).catch((error: unknown) => { ackError = error; abort.abort(); });
              request.onSpawn?.({ pid });
            } catch (error) { ackError = error; abort.abort(); }
          },
        });
      } catch (error) {
        result = { terminationReason: "SPAWN_ERROR", exitCode: null, signal: null, stdout: "", stderr: "",
          stdoutTruncated: false, stderrTruncated: false, startedAt: deps.clock.now(),
          finishedAt: deps.clock.now(), durationMs: 0, spawnError: "provider runner threw" };
        ackError = error;
      } finally {
        finished = true;
        await ack;
        if (timer !== undefined) clearInterval(timer);
        await heartbeatPending;
      }
      const metadata = interpret(result);
      const settled = await update((run) => {
        if (isTerminalWorkerRunState(run.state)) throw new Error("provider result raced a terminal reconciliation");
        return { ...run, invocations: run.invocations!.map((entry) => entry.sequence === sequence
          ? { ...entry, ...metadata, finishedAt: result.finishedAt, exitCode: result.exitCode,
              signal: result.signal, terminationReason: result.terminationReason } : entry),
          updatedAt: result.finishedAt };
      });
      if (metadata.terminalReason === "MAX_TURNS") {
        const detail = "provider reported structured MAX_TURNS; controller decision required";
        const artifact = writeWorkerRunArtifact(workerRunArtifactPath(deps.artifactDir, runId), {
          runId, actionId: deps.actionId, ...metadata, exitCode: result.exitCode, signal: result.signal,
          terminationReason: result.terminationReason, detail, at: result.finishedAt,
        });
        await lifecycle.complete({ runId, input: { state: "AWAITING_CONTROLLER", ...metadata,
          exitCode: result.exitCode, signal: result.signal, artifact, detail, at: result.finishedAt } });
      }
      if (ackError !== undefined) throw new Error("provider ACK/result failed; action must not continue", { cause: ackError });
      if (!acknowledged && result.terminationReason !== "SPAWN_ERROR") throw new Error("provider result without ACK");
      // Keep the reference live through settlement; no invocation can overwrite a sibling.
      if (settled.invocations?.length !== sequence) throw new Error("provider invocation ordering changed");
      return result;
    },
  };
}

/** Recover provider evidence before a wrapper exit can certify a conflicting outcome. */
export function completionFromWorkerRunEvidence(
  run: WorkerRunEnvelope, artifactDir: string,
): WorkerRunCompletionInput | undefined {
  const path = workerRunArtifactPath(artifactDir, run.runId);
  const reading = readWorkerRunArtifact(path, run.runId, run.actionId, run.artifact?.hash);
  if (reading.kind === "UNUSABLE") throw new Error(reading.reason);
  const maxTurns = run.invocations?.find(child => child.terminalReason === "MAX_TURNS");
  if (maxTurns !== undefined && reading.kind === "NONE") {
    if (maxTurns.finishedAt === undefined || maxTurns.exitCode === undefined ||
        maxTurns.signal === undefined || maxTurns.terminationReason === undefined)
      throw new Error("incomplete durable MAX_TURNS result; controller required");
    const detail = "provider reported structured MAX_TURNS; controller decision required";
    const metadata = { terminalReason: "MAX_TURNS" as const,
      ...(maxTurns.providerSessionId === undefined ? {} : {providerSessionId:maxTurns.providerSessionId}) };
    const artifact = writeWorkerRunArtifact(path, {runId:run.runId, actionId:run.actionId,
      ...metadata, exitCode:maxTurns.exitCode, signal:maxTurns.signal,
      terminationReason:maxTurns.terminationReason, detail, at:maxTurns.finishedAt});
    return {state:"AWAITING_CONTROLLER", ...metadata, exitCode:maxTurns.exitCode,
      signal:maxTurns.signal, artifact, detail, at:maxTurns.finishedAt};
  }
  if (reading.kind !== "FOUND") return undefined;
  const {data} = reading;
  if (maxTurns !== undefined && data.terminalReason !== "MAX_TURNS")
    throw new Error("terminal artifact conflicts with durable MAX_TURNS; controller required");
  // A wrapper artifact cannot establish that an action-bound provider exited.
  if (run.invocations?.some(child => child.finishedAt === undefined)) return undefined;
  return {state:data.terminalReason === "MAX_TURNS" ? "AWAITING_CONTROLLER" :
      data.terminationReason === "EXITED" && data.exitCode === 0 ? "COMPLETED" : "FAILED",
    exitCode:data.exitCode, signal:data.signal, artifact:{path,hash:reading.hash},
    ...(data.providerSessionId === undefined ? {} : {providerSessionId:data.providerSessionId}),
    ...(data.terminalReason === undefined ? {} : {terminalReason:data.terminalReason}),
    detail:data.detail, at:data.at};
}
export interface WorkerRunLifecycleDeps {
  readonly repository: SupervisorRepository;
  readonly clock: Clock;
}

async function loadOrThrow(repository: SupervisorRepository): Promise<SupervisorState> {
  const state = await repository.load();
  if (state === undefined) {
    throw new Error("no supervisor state exists; cannot durably record a worker run against it");
  }
  return state;
}

export function createWorkerRunLifecycle(deps: WorkerRunLifecycleDeps): WorkerRunLifecycle {
  return {
    async read(runId) {
      const state = await loadOrThrow(deps.repository);
      const run = state.workerRuns?.find((entry) => entry.runId === runId);
      if (run === undefined) throw new Error("missing worker run");
      return run;
    },
    async prepare(request: WorkerRunPrepareRequest): Promise<WorkerRunEnvelope> {
      let lastConflict: unknown;
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const state = await loadOrThrow(deps.repository);
        const before = state.workerRuns ?? [];
        const verdict = prepareWorkerRun(before, { ...request, now: deps.clock.now() });
        if (!verdict.ok) {
          throw new Error(verdict.problem);
        }
        try {
          await deps.repository.compareAndSave(
            { ...state, workerRuns: verdict.runs, version: state.version + 1 },
            state.version,
          );
          return verdict.run;
        } catch (error) {
          if (error instanceof ConcurrencyError) {
            lastConflict = error;
            continue;
          }
          throw error;
        }
      }
      throw new Error(
        `could not durably record worker run ${JSON.stringify(request.actionId)} as PREPARED after ${MAX_CAS_ATTEMPTS} attempts` +
          (lastConflict instanceof Error ? `: ${lastConflict.message}` : ""),
      );
    },

    async adopt(request: WorkerRunAdoptRequest): Promise<void> {
      let lastConflict: unknown;
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const state = await loadOrThrow(deps.repository);
        const before = state.workerRuns ?? [];
        const verdict = adoptWorkerRun(before, request.runId, {
          lease: request.lease,
          at: deps.clock.now(),
          ...(request.childPid === undefined ? {} : { childPid: request.childPid }),
          ...(request.providerSessionId === undefined ? {} : { providerSessionId: request.providerSessionId }),
        });
        if (!verdict.ok) {
          throw new Error(verdict.problem);
        }
        if (verdict.runs === before) {
          // Idempotent re-adoption from the same holder: nothing to persist.
          return;
        }
        try {
          await deps.repository.compareAndSave(
            { ...state, workerRuns: verdict.runs, version: state.version + 1 },
            state.version,
          );
          return;
        } catch (error) {
          if (error instanceof ConcurrencyError) {
            lastConflict = error;
            continue;
          }
          throw error;
        }
      }
      throw new Error(
        `could not durably adopt worker run ${JSON.stringify(request.runId)} as RUNNING after ${MAX_CAS_ATTEMPTS} attempts` +
          (lastConflict instanceof Error ? `: ${lastConflict.message}` : ""),
      );
    },

    async heartbeat(request: WorkerRunHeartbeatRequest): Promise<{ readonly recorded: boolean }> {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        let state: SupervisorState;
        try {
          state = await loadOrThrow(deps.repository);
        } catch {
          return { recorded: false };
        }
        const before = state.workerRuns ?? [];
        const verdict = reportWorkerRunHeartbeat(before, request.runId, request.heartbeat, request.holder);
        if (!verdict.ok) {
          // Not this holder's lease any more, or the run already finished: a
          // heartbeat write failing here reports on the CHILD, not on this
          // module, and must never disturb the process it describes.
          return { recorded: false };
        }
        if (!verdict.changed) {
          return { recorded: true };
        }
        try {
          await deps.repository.compareAndSave(
            { ...state, workerRuns: verdict.runs, version: state.version + 1 },
            state.version,
          );
          return { recorded: true };
        } catch (error) {
          if (error instanceof ConcurrencyError) continue;
          return { recorded: false };
        }
      }
      return { recorded: false };
    },

    async complete(request: WorkerRunCompleteRequest): Promise<void> {
      let lastConflict: unknown;
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const state = await loadOrThrow(deps.repository);
        const before = state.workerRuns ?? [];
        const run = before.find(entry => entry.runId === request.runId);
        if (run?.invocations?.some(child => child.finishedAt === undefined))
          throw new Error("provider invocation remains unsettled; refusing wrapper completion");
        if (run?.invocations?.some(child => child.terminalReason === "MAX_TURNS") &&
            request.input.state !== "AWAITING_CONTROLLER")
          throw new Error("durable MAX_TURNS requires controller settlement");
        const verdict = completeWorkerRun(before, request.runId, request.input);
        if (!verdict.ok) {
          throw new Error(verdict.problem);
        }
        if (!verdict.changed) {
          return;
        }
        try {
          await deps.repository.compareAndSave(
            { ...state, workerRuns: verdict.runs, version: state.version + 1 },
            state.version,
          );
          return;
        } catch (error) {
          if (error instanceof ConcurrencyError) {
            lastConflict = error;
            continue;
          }
          throw error;
        }
      }
      throw new Error(
        `could not durably record a terminal outcome for worker run ${JSON.stringify(request.runId)} after ${MAX_CAS_ATTEMPTS} attempts` +
          (lastConflict instanceof Error ? `: ${lastConflict.message}` : ""),
      );
    },
  };
}
