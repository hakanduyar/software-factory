/**
 * Deterministic, scripted `Worker`s for TASK-004's offline demo
 * (`npm run demo:loop`) and automated tests. No network, no AI provider —
 * plays the same role `src/adapters/workers/mockWorker.ts` plays for
 * TASK-001, extended with the ability to script a *sequence* of outcomes
 * across successive calls: a real CLI adapter's output is fixed per Worker
 * construction (controlled only by a fixed environment variable), which
 * cannot vary per remediation iteration the way a stateful scripted closure
 * can — see engineeringLoopService.ts's `LoopWorkerFactory` injection point,
 * which is what lets these stand in for `createLoopWorker` in tests/demo.
 */

import type { EvidenceDraft } from "../domain/evidence.js";
import type { Worker, WorkerOutcome, WorkerRequest } from "../ports/worker.js";
import type { LoopReviewVerdict, LoopWorkerConfig } from "./loopTypes.js";
import type { LoopWorkerFactory } from "./engineeringLoopService.js";
import type { LoopWorkerFactoryOptions } from "./loopWorkerFactory.js";

export interface ScriptedImplementerOptions {
  readonly id?: string;
  /** Outcome per successive call, indexed by call count; the last entry repeats once exhausted. */
  readonly outcomes?: readonly ("SUCCEEDED" | "FAILED")[];
}

export function createScriptedImplementerWorker(options: ScriptedImplementerOptions = {}): Worker {
  const outcomes = options.outcomes ?? ["SUCCEEDED"];
  let calls = 0;
  return {
    id: options.id ?? "scripted-implementer",
    capabilities: { roles: ["IMPLEMENTER"], deterministic: true },
    async execute(request: WorkerRequest): Promise<WorkerOutcome> {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)]!;
      calls += 1;
      const evidence: EvidenceDraft[] = [
        {
          kind: "NOTE",
          summary: `scripted implementer attempt ${calls}: ${outcome}`,
          reference: `scripted://implementer/${request.runId}`,
        },
      ];
      return {
        status: outcome,
        summary: `[scripted-implementer] ${outcome} on attempt ${calls}`,
        evidence,
        claimsAcceptanceMet: outcome === "SUCCEEDED",
      };
    },
  };
}

export interface ScriptedReviewerOptions {
  readonly id?: string;
  /** Verdict per successive call, indexed by call count; the last entry repeats once exhausted. */
  readonly verdicts?: readonly LoopReviewVerdict[];
  readonly findings?: readonly string[];
  /** Process-level outcome — simulate a crashed/non-zero reviewer process. Default SUCCEEDED. */
  readonly outcome?: "SUCCEEDED" | "FAILED";
}

export function createScriptedReviewerWorker(options: ScriptedReviewerOptions = {}): Worker {
  const verdicts = options.verdicts ?? ["PASS"];
  const findings = options.findings ?? [];
  const outcome = options.outcome ?? "SUCCEEDED";
  let calls = 0;
  return {
    id: options.id ?? "scripted-reviewer",
    capabilities: { roles: ["REVIEWER"], deterministic: true },
    async execute(request: WorkerRequest): Promise<WorkerOutcome> {
      const verdict = verdicts[Math.min(calls, verdicts.length - 1)]!;
      calls += 1;
      const findingsBlock = findings.length === 0 ? "- none" : findings.map((finding) => `- ${finding}`).join("\n");
      const message = `FACTORY_REVIEW_VERDICT: ${verdict}\nFACTORY_REVIEW_FINDINGS:\n${findingsBlock}`;
      const evidence: EvidenceDraft[] = [
        { kind: "NOTE", summary: message, reference: `scripted://reviewer/${request.runId}/transcript` },
      ];
      return {
        status: outcome,
        summary: outcome === "SUCCEEDED" ? `[scripted-reviewer] ${message}` : "[scripted-reviewer] FAILED (simulated execution failure)",
        evidence,
        claimsAcceptanceMet: outcome === "SUCCEEDED" && verdict === "PASS",
      };
    },
  };
}

/** Wraps a single, already-constructed Worker as a `LoopWorkerFactory` that always returns it (see engineeringLoopService.ts). */
export function asLoopWorkerFactory(worker: Worker): LoopWorkerFactory {
  return (_config: LoopWorkerConfig, _options: LoopWorkerFactoryOptions): Worker => worker;
}
