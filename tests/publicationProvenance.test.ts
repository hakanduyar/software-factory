/**
 * TASK-016 AC-4/AC-6: the publication record keeps the distinction that matters
 * and cannot carry a secret.
 *
 * "No checks are configured" and "checks ran and passed" must stay
 * distinguishable AFTER persistence, because a later reader has only the record
 * — the verdict that computed it is long gone. Offline: pure functions over an
 * in-memory state.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publicationDetail, withPublicationRecorded } from "../src/github/publicationProvenance.js";
import { verifyAgainstAnchor, verifyChain } from "../src/supervision/provenanceChain.js";
import type { RemoteCheckStatus, RemotePullRequest } from "../src/github/candidateBinding.js";
import type { SupervisorState } from "../src/supervision/supervisorTypes.js";

const A = "1111111111111111111111111111111111111111";
const BASE = "3333333333333333333333333333333333333333";

const PR: RemotePullRequest = {
  number: 7,
  state: "OPEN",
  headRef: "feat/executor-wiring",
  headSha: A,
  baseRef: "main",
  baseSha: BASE,
};

function emptyState(): SupervisorState {
  return {
    version: 1,
    financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
    resources: [],
    roadmap: [],
    checkpoints: [],
    escalations: [],
    provenance: [],
    updatedAt: 1_000,
  };
}

function checks(overrides: Partial<RemoteCheckStatus> = {}): RemoteCheckStatus {
  return { sha: A, conclusion: "SUCCESS", total: 3, ...overrides };
}

describe("TASK-016 AC-4: the persisted record distinguishes absent checks from passing ones", () => {
  it("records a passing run with its count and its commit", () => {
    const detail = publicationDetail({ pullRequest: PR, checks: checks() });

    assert.match(detail, /checks SUCCESS \(3\)/);
    assert.match(detail, new RegExp(A), "the record does not name the commit the checks describe");
  });

  /**
   * THE CASE THIS REPOSITORY ACTUALLY PRODUCES TODAY — it has no workflows. A
   * record that omitted the conclusion would leave a later reader unable to
   * tell this publication from a verified one.
   */
  it("records the absence of checks as its own distinct fact", () => {
    const detail = publicationDetail({
      pullRequest: PR,
      checks: checks({ conclusion: "NO_CHECKS_CONFIGURED", total: 0 }),
    });

    assert.match(detail, /NO_CHECKS_CONFIGURED/);
    assert.ok(!detail.includes("SUCCESS"), "an unverified publication reads as a successful one");
  });

  it("records an unretrieved status as neither", () => {
    const detail = publicationDetail({ pullRequest: PR, checks: undefined });

    assert.match(detail, /UNRETRIEVED/);
    assert.ok(!detail.includes("SUCCESS"), "a missing status reads as success");
    assert.ok(!detail.includes("NO_CHECKS_CONFIGURED"), "a missing status reads as a known absence");
  });

  /** The three cases must be mutually distinguishable, not merely non-empty. */
  it("produces a different record for each of the three states", () => {
    const details = new Set([
      publicationDetail({ pullRequest: PR, checks: checks() }),
      publicationDetail({ pullRequest: PR, checks: checks({ conclusion: "NO_CHECKS_CONFIGURED", total: 0 }) }),
      publicationDetail({ pullRequest: PR, checks: undefined }),
    ]);

    assert.equal(details.size, 3, "two distinct check states produced the same persisted record");
  });
});

describe("TASK-016: the publication joins the verifiable chain", () => {
  it("appends an entry that verifies and re-anchors", () => {
    const result = withPublicationRecorded(emptyState(), {
      roadmapKey: "GITHUB_ORCHESTRATION",
      pullRequest: PR,
      checks: checks(),
      recordedAt: 2_000,
    });

    assert.equal(result.ok, true, `the publication was not recorded: ${JSON.stringify(result)}`);
    if (!result.ok) return;

    const { provenance, provenanceAnchor } = result.state;
    assert.equal(provenance.length, 1);
    assert.equal(provenance[0]!.kind, "PUBLISHED_AS");
    // The commit is the identity the entry is ABOUT.
    assert.equal(provenance[0]!.resourceKey, A);
    assert.equal(verifyChain(provenance).intact, true, "the appended entry does not verify");
    assert.equal(
      verifyAgainstAnchor(provenance, provenanceAnchor).intact,
      true,
      "the chain was not re-anchored, so a later truncation would be undetectable",
    );
  });

  /**
   * A publication is recorded WITHOUT disturbing what came before: the chain is
   * append-only, and the earlier entry's digest must be unchanged.
   */
  it("leaves existing entries untouched", () => {
    const first = withPublicationRecorded(emptyState(), {
      roadmapKey: "GITHUB_ORCHESTRATION",
      pullRequest: PR,
      checks: checks(),
      recordedAt: 2_000,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const second = withPublicationRecorded(first.state, {
      roadmapKey: "GITHUB_ORCHESTRATION",
      pullRequest: { ...PR, number: 8 },
      checks: checks(),
      recordedAt: 3_000,
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;

    assert.equal(second.state.provenance.length, 2);
    assert.deepEqual(
      second.state.provenance[0],
      first.state.provenance[0],
      "appending rewrote an existing entry",
    );
    assert.equal(verifyChain(second.state.provenance).intact, true);
  });

  /**
   * AC-6: a token that somehow reached this text must not survive into durable
   * state. `appendProvenance` redacts before hashing, so what is verified is
   * what is stored — and neither carries the secret.
   */
  it("redacts a token-shaped value before it is hashed into the chain", () => {
    const leak = "ghs_0123456789abcdefghijklmnopqrstuvwxyzAB";

    const result = withPublicationRecorded(emptyState(), {
      roadmapKey: `GITHUB_ORCHESTRATION ${leak}`,
      pullRequest: PR,
      checks: checks(),
      recordedAt: 2_000,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.state);
    assert.ok(!serialized.includes(leak), "a token reached durable state through a publication record");
  });
});
