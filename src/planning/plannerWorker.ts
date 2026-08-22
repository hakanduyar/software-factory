/**
 * Provider-neutral planner contract (C9).
 *
 * Nothing here names Claude, Codex, Gemini, OpenCode or Ollama; an adapter
 * wraps whatever tool it likes as long as it satisfies this interface, and the
 * planning layer selects one purely from injected configuration.
 *
 * Why this is a separate port rather than the accepted `src/ports/worker.ts`:
 * a `WorkerRequest` requires a `runId` and a `workItemId`, and
 * `FactoryService.runWorker` requires an existing, operable WorkItem to attach
 * the Run to. Planning happens strictly BEFORE any WorkItem exists — that is
 * the whole point of TASK-005 — so reusing that path would mean inventing a
 * placeholder WorkItem before a human approved anything, which is precisely
 * the authority inversion this task exists to prevent. Planner actions are
 * audited in the plan's own append-only event log instead.
 *
 * Deliberate omissions, mirroring `Worker`: a `PlannerOutcome` carries no
 * phase, no approval, no verdict and no work items. It carries TEXT, which a
 * deterministic parser (plannerOutputContract.ts) may or may not accept. The
 * planner has no vocabulary for advancing a plan or opening a gate.
 */

import type { Timestamp } from "../domain/time.js";

export interface PlannerQuestionAnswer {
  readonly question: string;
  readonly answer: string;
}

/**
 * Everything the planner is given — and, by construction, nothing else. No
 * secrets, no credentials, no unrestricted machine context, no repository dump:
 * the planning service assembles this from durable plan fields only.
 */
export interface PlannerRequest {
  readonly planId: string;
  /** The revision this attempt is trying to produce. */
  readonly revision: number;
  /** 1-based attempt counter within this revision (parse failures consume attempts). */
  readonly attempt: number;
  /** Stable, derived identity of this planner action; recorded for audit. */
  readonly correlationTag: string;
  readonly projectKey: string;
  /** The original human goal, verbatim. */
  readonly intent: string;
  readonly constraints: readonly string[];
  /** Previously answered clarifications, so the planner does not ask twice. */
  readonly answeredQuestions: readonly PlannerQuestionAnswer[];
  /** Curated, bounded project rules/invariants the plan must respect. */
  readonly projectRules: readonly string[];
  /** The exact output contract the planner must satisfy; see plannerOutputContract.ts. */
  readonly outputContract: string;
  /**
   * Why the previous attempt at this revision was rejected, when there was one,
   * so a retry can correct itself instead of repeating the same mistake.
   * Rendering it into a prompt is the adapter's job — this port carries data,
   * not prose.
   */
  readonly previousRejection?: string;
}

export interface PlannerOutcome {
  /** Process-level result only. A FAILED planner's output never reaches the parser. */
  readonly status: "SUCCEEDED" | "FAILED";
  /** Untrusted text. Only the deterministic contract parser may interpret it. */
  readonly rawOutput: string;
  /** Short, bounded, human-readable note for the audit log. Never a transcript, never a secret. */
  readonly summary: string;
  readonly startedAt?: Timestamp;
  readonly finishedAt?: Timestamp;
}

export interface PlannerWorker {
  /** Self-reported identity: audit data only, never an authority. */
  readonly id: string;
  plan(request: PlannerRequest): Promise<PlannerOutcome>;
}
