/**
 * The real `PlannerWorker`: a thin adapter onto the accepted TASK-003 CLI
 * worker adapters (Claude Code / Codex CLI), reached through TASK-004's
 * `createLoopWorker` factory.
 *
 * Two things are worth stating plainly.
 *
 * FIRST, this reuses the accepted worker-execution layer rather than launching
 * a process itself. Non-interactive invocation, stdin closure, bounded
 * timeouts, workspace containment, environment allow-listing and output
 * redaction are all properties of that layer, already reviewed and tested. A
 * second process-launching path would have to re-earn every one of them.
 *
 * SECOND, the accepted `Worker` contract wants a `WorkerRequest`, whose
 * `runId`/`workItemId` exist to tie a run to Factory records. Planning has no
 * WorkItem yet — that is the entire point of TASK-005 — so this adapter passes
 * the plan's own derived correlation identities in those slots. That is safe
 * precisely because `Worker.execute` never touches the Factory: it receives
 * text and returns text. Nothing here creates a Run, a WorkItem or an Evidence
 * record, and the planner's output remains untrusted until the deterministic
 * contract parser accepts it.
 *
 * The planner is expected to be a READ-ONLY consultation of the workspace. It
 * is given the `PLANNER` role and no instruction to modify anything; callers
 * should configure the underlying tool's sandbox accordingly. A planner action
 * that mutated the workspace would also break the crash-recovery reasoning in
 * `PlanningService.stepPlanner`, which is safe to retry only because planning
 * has no durable side effect.
 */

import type { ProcessRunner } from "../../ports/processRunner.js";
import type { Worker } from "../../ports/worker.js";
import { createLoopWorker } from "../../orchestration/loopWorkerFactory.js";
import type { LoopWorkerConfig } from "../../orchestration/loopTypes.js";
import { buildPlannerPrompt } from "../../planning/planPrompts.js";
import type { PlannerOutcome, PlannerRequest, PlannerWorker } from "../../planning/plannerWorker.js";
import type { Workspace } from "../workers/workspace.js";
import type { WorkerTool } from "../workers/workerModelConfig.js";

/**
 * The evidence channel carrying a structured, contract-satisfying tool answer
 * (see `cliWorker.ts`). Same constant, same meaning, as the accepted TASK-004
 * reviewer-verdict path uses.
 */
const TRANSCRIPT_REFERENCE_SUFFIX = "/transcript";

export interface CliPlannerWorkerDeps {
  readonly tool: WorkerTool;
  readonly model: string;
  readonly effort?: string;
  readonly timeoutMs?: number;
  readonly workspace: Workspace;
  readonly processRunner: ProcessRunner;
  /** Overridable so tests can substitute a fake factory without launching a CLI. */
  readonly createWorker?: (config: LoopWorkerConfig, workspace: Workspace, processRunner: ProcessRunner) => Worker;
}

function defaultCreateWorker(config: LoopWorkerConfig, workspace: Workspace, processRunner: ProcessRunner): Worker {
  return createLoopWorker(config, {
    workspace,
    processRunner,
    roles: ["PLANNER"],
    ...(config.timeoutMs === undefined ? {} : { defaultTimeoutMs: config.timeoutMs }),
  });
}

export function createCliPlannerWorker(deps: CliPlannerWorkerDeps): PlannerWorker {
  const config: LoopWorkerConfig = {
    tool: deps.tool,
    model: deps.model,
    ...(deps.effort === undefined ? {} : { effort: deps.effort }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  };
  const create = deps.createWorker ?? defaultCreateWorker;

  return {
    id: `cli-planner:${deps.tool}`,
    async plan(request: PlannerRequest): Promise<PlannerOutcome> {
      const worker = create(config, deps.workspace, deps.processRunner);
      const prompt = buildPlannerPrompt({
        projectKey: request.projectKey,
        intent: request.intent,
        constraints: request.constraints,
        answeredQuestions: request.answeredQuestions,
        projectRules: request.projectRules,
        revision: request.revision,
        attempt: request.attempt,
        ...(request.previousRejection === undefined ? {} : { previousRejection: request.previousRejection }),
      });

      const outcome = await worker.execute({
        // Correlation identities, not Factory ids: nothing in the worker layer
        // resolves these against the store (see module docs).
        runId: request.correlationTag,
        workItemId: request.planId,
        role: "PLANNER",
        title: `Plan revision ${request.revision} for ${request.planId}`,
        instructions: prompt,
        acceptanceCriteria: [],
      });

      // ONE structured channel, exactly as TASK-004's reviewer-verdict parser
      // consumes only `/transcript` evidence.
      //
      // REMEDIATION ROUND 1, HIGH 6: this used to pool the transcript evidence
      // AND the run summary. But `cliWorker.buildSummary` already embeds the
      // first 200 characters of that same transcript, so a valid planner answer
      // — whose contract marker is on the first line — arrived carrying two
      // markers and was correctly refused by the parser's ambiguity check. The
      // production planner path could therefore never succeed.
      //
      // The fix is the boundary, not the parser. A bounded diagnostic summary
      // is not a second result channel: it is a lossy copy of the first, and
      // pooling a channel with a truncated copy of itself is what manufactured
      // the ambiguity. `/raw-output` is excluded for the accepted TASK-004
      // reason — output from a tool that violated its own structured contract
      // is a diagnostic, never an authoritative answer.
      const transcripts = outcome.evidence
        .filter((entry) => entry.reference.endsWith(TRANSCRIPT_REFERENCE_SUFFIX))
        .map((entry) => entry.summary)
        .filter((text) => text.length > 0);

      return {
        status: outcome.status,
        // Joined, not concatenated-with-fallbacks: if a tool ever emits more
        // than one structured transcript, the parser must SEE both and refuse,
        // rather than this adapter quietly picking one.
        rawOutput: transcripts.join("\n"),
        summary: `[${deps.tool}] planner ${outcome.status} for ${request.correlationTag}`,
      };
    },
  };
}
