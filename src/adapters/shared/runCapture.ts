/**
 * Single-read capture for caller-supplied Run/RunCompletion objects, shared
 * by every FactoryStore adapter.
 *
 * A hostile object with getters/proxies can answer differently on successive
 * reads — validate clean, persist dirty (a real Round-4 review finding).
 * Reading every field exactly once into a plain value before any validation
 * neutralises that: from the returned copy onward, nothing re-reads the
 * caller's object. Both the in-memory and SQLite adapters call these so the
 * two adapters cannot silently diverge on this guarantee.
 */

import type { Run } from "../../domain/run.js";
import type { RunCompletion } from "../../ports/repositories.js";

export function captureRun(run: Run): Run {
  const id = String(run.id);
  const workItemId = String(run.workItemId);
  const specRevision = Number(run.specRevision);
  const role = run.role;
  const workerPrincipalId = String(run.workerPrincipalId);
  const declaredWorkerId = String(run.declaredWorkerId);
  const status = run.status;
  const summary = run.summary;
  const targetRunId = run.targetRunId;
  const claimsAcceptanceMet = run.claimsAcceptanceMet === true;
  const evidenceIds = [...run.evidenceIds].map(String);
  const startedAt = Number(run.startedAt);
  const finishedAt = run.finishedAt;
  return {
    id,
    workItemId,
    specRevision,
    role,
    workerPrincipalId,
    declaredWorkerId,
    status,
    ...(summary === undefined ? {} : { summary: String(summary) }),
    ...(targetRunId === undefined ? {} : { targetRunId: String(targetRunId) }),
    claimsAcceptanceMet,
    evidenceIds,
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt: Number(finishedAt) }),
  };
}

/** Same single-read capture for a completion object. Only completion fields exist here. */
export function captureCompletion(completion: RunCompletion): RunCompletion {
  const status = completion.status;
  const summary = String(completion.summary);
  const claimsAcceptanceMet = completion.claimsAcceptanceMet === true;
  const evidenceIds = [...completion.evidenceIds].map(String);
  const finishedAt = Number(completion.finishedAt);
  return { status, summary, claimsAcceptanceMet, evidenceIds, finishedAt };
}
