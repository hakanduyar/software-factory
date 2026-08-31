/**
 * What the Factory durably records about a publication (TASK-016 AC-4/AC-6).
 *
 * The provenance chain already exists, is append-only, hash-linked and anchored
 * against truncation, and is the register that answers "what actually happened
 * to this roadmap item". A publication is that kind of fact, so it goes there
 * rather than into a second lifecycle store — the mandate's "do not invent
 * parallel lifecycle storage" applied literally.
 *
 * WHAT THE RECORD MUST PRESERVE. AC-4 requires that "checks ran and succeeded"
 * and "there are no checks" stay distinguishable in the PERSISTED record, not
 * merely in a verdict some process returned and then discarded. So the check
 * conclusion is written verbatim, and the commit it describes is written beside
 * it — a conclusion without its sha would be exactly the unbound evidence this
 * task exists to refuse.
 *
 * Secret safety comes free and is worth stating: `appendProvenance` bounds and
 * redacts `detail` and `resourceKey` BEFORE hashing, so a token that somehow
 * reached this text could not survive into the chain (AC-6).
 */

import { anchorFor, appendProvenance, type ProvenanceEntry } from "../supervision/provenanceChain.js";
import type { RemoteCheckStatus, RemotePullRequest } from "./candidateBinding.js";
import type { SupervisorState } from "../supervision/supervisorTypes.js";

/**
 * The human-readable fact, built in one place so every caller records the same
 * shape.
 *
 * States the check conclusion even when it is `NO_CHECKS_CONFIGURED`: a record
 * that omitted it would leave a later reader unable to tell an unverified
 * publication from a verified one, which is the failure AC-4 names.
 */
export function publicationDetail(input: {
  readonly pullRequest: RemotePullRequest;
  readonly checks: RemoteCheckStatus | undefined;
}): string {
  const checks =
    input.checks === undefined
      ? "checks UNRETRIEVED"
      : `checks ${input.checks.conclusion} (${input.checks.total}) for ${input.checks.sha}`;
  return `published as pull request #${input.pullRequest.number} at ${input.pullRequest.headSha}; ${checks}`;
}

export type PublicationRecordResult =
  | { readonly ok: true; readonly state: SupervisorState }
  | { readonly ok: false; readonly reason: string };

/**
 * Returns the next STATE with the publication appended and the chain
 * re-anchored.
 *
 * Deliberately returns state rather than writing it: the caller owns the
 * compare-and-save, so this stays a pure function testable without a database,
 * and no second place in the codebase can write supervisor state.
 */
export function withPublicationRecorded(
  state: SupervisorState,
  input: {
    readonly roadmapKey: string;
    readonly pullRequest: RemotePullRequest;
    readonly checks: RemoteCheckStatus | undefined;
    readonly recordedAt: number;
  },
): PublicationRecordResult {
  const appended = appendProvenance(state.provenance, {
    kind: "PUBLISHED_AS",
    roadmapKey: input.roadmapKey,
    // The COMMIT is the identity, so it is the entry's `resourceKey` — the
    // field the chain reserves for "the thing this entry is about". A pull
    // request number here would record a label instead.
    resourceKey: input.pullRequest.headSha,
    detail: publicationDetail({ pullRequest: input.pullRequest, checks: input.checks }),
    recordedAt: input.recordedAt,
  });
  if (!appended.ok) {
    return { ok: false, reason: appended.reason };
  }
  const chain: readonly ProvenanceEntry[] = appended.chain;
  return {
    ok: true,
    state: {
      ...state,
      provenance: chain,
      // An anchor is written with EVERY chain, so its absence stays a
      // detectable deletion rather than a permitted state.
      provenanceAnchor: anchorFor(chain),
    },
  };
}
