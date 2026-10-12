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
import type { DirectHostAdmissionSurface, DirectHostLaunchRequest } from "../../supervision/directWorkerAdmission.js";

/**
 * The evidence channel carrying a structured, contract-satisfying tool answer
 * (see `cliWorker.ts`). Same constant, same meaning, as the accepted TASK-004
 * reviewer-verdict path uses.
 */
const TRANSCRIPT_REFERENCE_SUFFIX = "/transcript";

/**
 * The structured truncation signal `cliWorker` emits alongside a cut
 * `/transcript` entry (see cliWorker.ts). Checking this — not the shape or
 * length of the transcript text itself — is what makes the fail-closed
 * decision independent of WHERE a cut landed. A cut transcript may still
 * happen to contain a complete, well-formed `FACTORY_PLAN_V1` block before
 * the cut point (e.g. oversized trailing padding, or a discarded second
 * fenced block that would otherwise have made the input ambiguous under
 * AC-2). Accepting it anyway would make acceptance depend on truncation
 * position, exactly the boundary defect this guards against: the Factory
 * has no way to know what the model actually wrote after the cut, so any
 * truncation of the authoritative transcript is treated as untrustworthy,
 * never as a lucky truncation.
 */
const TRANSCRIPT_TRUNCATED_REFERENCE_SUFFIX = "/transcript-truncated";

/**
 * `cliWorker`'s OS-level truncation signal (see `ProcessResult.stdoutTruncated`/
 * `stderrTruncated`), emitted unconditionally whenever the process runner
 * itself discarded bytes past its own capture cap — independent of, and
 * emitted regardless of, whether an adapter's structured-output parse of the
 * (already-cut) captured buffer happened to succeed cleanly.
 *
 * A parse succeeding here proves only that the CAPTURED PREFIX was
 * well-formed; it says nothing about what the model actually produced after
 * the cut. The Factory has no way to know that, so — the same reasoning as
 * `TRANSCRIPT_TRUNCATED_REFERENCE_SUFFIX` above, at a different layer — a
 * planner must never accept a captured prefix of unknown full output as an
 * authoritative plan.
 */
const OUTPUT_BOUNDS_REFERENCE_SUFFIX = "/output-bounds";

/**
 * `cliWorker`'s signal (see `CliReportedResult.streamCorrupted`) that an
 * adapter's own structured-output scan hit at least one line violating that
 * tool's own output contract (malformed/truncated JSONL). `extractCodex/
 * ClaudeFinalMessage` silently ignore such a line and keep the last line that
 * DID parse — correct for their own informational purpose, but a planner
 * cannot tell whether the corruption hid a later, different, authoritative
 * message. Raw stream corruption must fail closed, not silently resolve to
 * an earlier valid-looking message.
 */
const STREAM_CORRUPTED_REFERENCE_SUFFIX = "/stream-corrupted";

/**
 * `cliWorker`'s default 4000-char evidence bound (chosen for short reviewer
 * verdict/finding text) truncates a real planner answer long before its
 * closing ` ```json ` fence: the strict parser (plannerOutputContract.ts) then
 * sees no complete fenced block at all and fails closed with a message
 * indistinguishable from a genuine contract violation. A fenced JSON plan
 * with several work items routinely exceeds 4000 characters while still
 * being well inside the parser's own field-length bounds, so this is a
 * boundary mismatch, not a defect in the parser or in truncation itself.
 *
 * This bound is deliberately generous but still finite and still truncates:
 * an oversized or runaway planner answer is bounded here and therefore still
 * fails the parser's exact-fence check closed, exactly as a short malformed
 * answer does. It does not change the accepted 4000-char default used by the
 * implementer/reviewer paths (engineeringLoopService.ts), whose reported text
 * is short verdict/finding lines, not a serialized structured document.
 */
const PLANNER_MAX_EVIDENCE_CHARS = 100_000;

/**
 * Constructor-trusted source of a mandatory direct-admission request/channel
 * pair. Captured once at construction; `plan()` refuses before building any
 * prompt or worker when this is absent from `CliPlannerWorkerDeps`. The
 * prepared request is validated here against THIS constructor's own
 * configured identities/model/effort before it is issued on `channel` -- it
 * never grants authority itself, it only carries the caller's request to the
 * same channel that validates and binds it.
 */
export interface CliPlannerAdmissionSource {
  readonly channel: DirectHostAdmissionSurface;
  readonly prepareRequest: (request: PlannerRequest) => Promise<DirectHostLaunchRequest>;
}

export interface CliPlannerWorkerDeps {
  readonly tool: WorkerTool;
  readonly model: string;
  readonly effort?: string;
  readonly timeoutMs?: number;
  readonly workspace: Workspace;
  readonly processRunner: ProcessRunner;
  /** Overridable so tests can substitute a fake factory without launching a CLI. */
  readonly createWorker?: (
    config: LoopWorkerConfig,
    workspace: Workspace,
    processRunner: ProcessRunner,
    directAdmissionChannel: DirectHostAdmissionSurface,
  ) => Worker;
  /** Mandatory at plan execution; see CliPlannerAdmissionSource doc above. */
  readonly admissionSource?: CliPlannerAdmissionSource;
}

function defaultCreateWorker(
  config: LoopWorkerConfig,
  workspace: Workspace,
  processRunner: ProcessRunner,
  directAdmissionChannel: DirectHostAdmissionSurface,
): Worker {
  return createLoopWorker(config, {
    workspace,
    processRunner,
    roles: ["PLANNER"],
    maxEvidenceChars: PLANNER_MAX_EVIDENCE_CHARS,
    directAdmissionChannel,
    ...(config.timeoutMs === undefined ? {} : { defaultTimeoutMs: config.timeoutMs }),
  });
}

type PlannerOutcomeExecuteResult = Awaited<ReturnType<Worker["execute"]>>;

export function createCliPlannerWorker(deps: CliPlannerWorkerDeps): PlannerWorker {
  const config: LoopWorkerConfig = {
    tool: deps.tool,
    model: deps.model,
    ...(deps.effort === undefined ? {} : { effort: deps.effort }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  };
  const create = deps.createWorker ?? defaultCreateWorker;
  const admissionSource = deps.admissionSource;
  // Captured once, here, so that a later mutation of a retained `deps` or
  // `admissionSource` alias during the `await` below cannot change which
  // channel/prepareRequest/model/effort this run validates against or issues
  // on. Everything downstream reads these locals, never `deps.*` again.
  const channel = admissionSource?.channel;
  const prepareRequest = admissionSource?.prepareRequest;
  const configuredModel = config.model;
  const configuredEffort = config.effort;

  return {
    id: `cli-planner:${deps.tool}`,
    async plan(request: PlannerRequest): Promise<PlannerOutcome> {
      if (admissionSource === undefined || channel === undefined || prepareRequest === undefined) {
        throw new Error(
          `cli planner worker for ${request.correlationTag} has no constructor-trusted admissionSource; refusing before any worker or process is constructed`,
        );
      }

      const directRequest = await prepareRequest(request);
      if (directRequest.role !== "PLANNER") {
        throw new Error(`prepared admission request role must be PLANNER, got ${String(directRequest.role)}`);
      }
      if (String(directRequest.workItemId) !== request.planId) {
        throw new Error("prepared admission request workItemId must equal the planner request's planId");
      }
      if (String(directRequest.runId) !== request.correlationTag) {
        throw new Error("prepared admission request runId must equal the planner request's correlationTag");
      }
      if (directRequest.specRevision !== request.revision) {
        throw new Error("prepared admission request specRevision must equal the planner request's revision");
      }
      if (!directRequest.model.eligibleModels.includes(configuredModel)) {
        throw new Error(`prepared admission request does not make configured model ${configuredModel} eligible`);
      }
      if (configuredEffort !== undefined && directRequest.model.reasoningEffort !== configuredEffort) {
        throw new Error(
          `prepared admission request reasoningEffort ${directRequest.model.reasoningEffort} does not match configured effort ${configuredEffort}`,
        );
      }

      const handle = await channel.issue(directRequest);
      let worker: Worker;
      try {
        worker = create(config, deps.workspace, deps.processRunner, channel);
      } catch (error) {
        await channel.cancel(handle).catch(() => undefined);
        throw error;
      }

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

      let outcome: PlannerOutcomeExecuteResult;
      try {
        outcome = await worker.execute({
          // Correlation identities, not Factory ids: nothing in the worker layer
          // resolves these against the store (see module docs). Admission
          // authority is owned entirely by this constructor's admissionSource
          // above; these ids are never resolved against it, only carried
          // alongside the already-issued handle.
          runId: request.correlationTag,
          workItemId: request.planId,
          role: "PLANNER",
          title: `Plan revision ${request.revision} for ${request.planId}`,
          instructions: prompt,
          acceptanceCriteria: [],
          directAdmissionHandle: handle,
        });
      } catch (error) {
        await channel.cancel(handle).catch(() => undefined);
        throw error;
      }

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
      const transcriptTruncated = outcome.evidence.some((entry) =>
        entry.reference.endsWith(TRANSCRIPT_TRUNCATED_REFERENCE_SUFFIX),
      );
      const processOutputTruncated = outcome.evidence.some((entry) =>
        entry.reference.endsWith(OUTPUT_BOUNDS_REFERENCE_SUFFIX),
      );
      const streamCorrupted = outcome.evidence.some((entry) =>
        entry.reference.endsWith(STREAM_CORRUPTED_REFERENCE_SUFFIX),
      );
      if (transcriptTruncated || processOutputTruncated || streamCorrupted) {
        // Fail closed BEFORE the transcript ever reaches parsePlannerOutput:
        // an untrustworthy captured/parsed answer is never a plan, no matter
        // what prefix happens to parse cleanly (see each constant's doc
        // comment above for which integrity gap this closes).
        const reasons = [
          ...(transcriptTruncated ? ["the evidence transcript was truncated"] : []),
          ...(processOutputTruncated ? ["the underlying process output was truncated"] : []),
          ...(streamCorrupted ? ["the tool's structured output stream was corrupted"] : []),
        ].join("; ");
        return {
          status: "FAILED",
          rawOutput: "",
          summary: `[${deps.tool}] planner output cannot be trusted as an authoritative plan for ${request.correlationTag}: ${reasons}`,
        };
      }

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
