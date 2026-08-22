/**
 * Direct unit tests of the release-snapshot resolver and the preconditions
 * built on it, isolated from FactoryService so each edge case (missing run,
 * wrong role, superseded implementation, missing evidence, unverified
 * criterion) is easy to construct by hand.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AcceptanceCriterion } from "../src/domain/acceptanceCriterion.js";
import type { AcceptanceCriterionVerification } from "../src/domain/acceptanceCriterionVerification.js";
import type { Review } from "../src/domain/review.js";
import type { Run } from "../src/domain/run.js";
import {
  requireIndependentSemanticReview,
  requireReleasableSnapshot,
  requireSuccessfulImplementationRun,
  requireSuccessfulVerification,
} from "../src/workflow/preconditions.js";
import {
  resolveCurrentImplementation,
  resolveReleaseSnapshot,
  type WorkflowReadContext,
} from "../src/workflow/releaseSnapshotResolver.js";
import { FIXTURE_START_MS, workItemAt } from "./support/factoryFixtures.js";

interface Fixtures {
  runs: readonly Run[];
  reviews: readonly Review[];
  criteria: readonly AcceptanceCriterion[];
  verifications: readonly AcceptanceCriterionVerification[];
}

function contextWith(overrides: Partial<Fixtures>): WorkflowReadContext {
  const runs = overrides.runs ?? [];
  const reviews = overrides.reviews ?? [];
  const criteria = overrides.criteria ?? [];
  const verifications = overrides.verifications ?? [];
  return {
    runs: { listByWorkItem: async () => runs },
    reviews: { listByWorkItem: async () => reviews },
    criteria: { listByWorkItem: async () => criteria },
    verifications: { listByWorkItem: async () => verifications },
  };
}

function run(overrides: Partial<Run> & Pick<Run, "id" | "role" | "status" | "specRevision">): Run {
  return {
    workItemId: "wi-test",
    workerPrincipalId: "wp-x",
    declaredWorkerId: "worker-x",
    claimsAcceptanceMet: true,
    evidenceIds: [],
    startedAt: FIXTURE_START_MS,
    ...overrides,
  };
}

function review(overrides: Partial<Review> & Pick<Review, "id" | "kind" | "reviewedRunId" | "reviewerRunId">): Review {
  return {
    workItemId: "wi-test",
    specRevision: 1,
    reviewerPrincipalId: "wp-reviewer",
    implementerPrincipalId: "wp-impl",
    verdict: "PASS",
    findings: [],
    createdAt: FIXTURE_START_MS,
    ...overrides,
  };
}

const IMPL = run({ id: "run-impl", role: "IMPLEMENTER", status: "SUCCEEDED", specRevision: 1, workerPrincipalId: "wp-impl" });
const VERIFIER = run({
  id: "run-verify",
  role: "VERIFIER",
  status: "SUCCEEDED",
  specRevision: 1,
  workerPrincipalId: "wp-verify",
  targetRunId: "run-impl",
  evidenceIds: ["ev-1"],
});
const DETERMINISTIC = review({
  id: "rev-det",
  kind: "DETERMINISTIC",
  reviewedRunId: "run-impl",
  reviewerRunId: "run-verify",
  reviewerPrincipalId: "wp-verify",
});
/**
 * The REVIEWER attempt backing SEMANTIC. Round-5 HIGH 2: a semantic review is
 * only as authoritative as the run that produced it, so the resolver now
 * dereferences `reviewerRunId` — these fixtures therefore carry the real run,
 * exactly as `recordReview` requires in production.
 */
const REVIEWER = run({
  id: "run-review",
  role: "REVIEWER",
  status: "SUCCEEDED",
  specRevision: 1,
  workerPrincipalId: "wp-reviewer",
  targetRunId: "run-impl",
});
const SEMANTIC = review({
  id: "rev-sem",
  kind: "SEMANTIC",
  reviewedRunId: "run-impl",
  reviewerRunId: "run-review",
  reviewerPrincipalId: "wp-reviewer",
});
const CRITERIA: AcceptanceCriterion[] = [
  { id: "ac-1", workItemId: "wi-test", text: "A", verificationHint: "npm test" },
  { id: "ac-2", workItemId: "wi-test", text: "B", verificationHint: "npm test" },
];

function verificationsFor(implementationRunId: string, specRevision = 1): AcceptanceCriterionVerification[] {
  return CRITERIA.map((criterion, index) => ({
    id: `acv-${index}`,
    criterionId: criterion.id,
    workItemId: "wi-test",
    specRevision,
    implementationRunId,
    result: "PASSED",
    verifierPrincipalId: "wp-verify",
    verifierRunId: "run-verify",
    verifiedAt: FIXTURE_START_MS,
  }));
}

describe("resolveCurrentImplementation", () => {
  it("fails with no runs at all", async () => {
    const result = await resolveCurrentImplementation(workItemAt("IMPLEMENTING"), contextWith({}));
    assert.equal(result.ok, false);
  });

  it("ignores FAILED runs and runs of other roles", async () => {
    const ctx = contextWith({
      runs: [
        run({ id: "r1", role: "IMPLEMENTER", status: "FAILED", specRevision: 1 }),
        run({ id: "r2", role: "VERIFIER", status: "SUCCEEDED", specRevision: 1 }),
      ],
    });
    assert.equal((await resolveCurrentImplementation(workItemAt("IMPLEMENTING"), ctx)).ok, false);
  });

  it("ignores runs from a superseded spec revision", async () => {
    const ctx = contextWith({ runs: [IMPL] });
    const item = workItemAt("IMPLEMENTING", "wi-test", { specRevision: 2 });
    assert.equal((await resolveCurrentImplementation(item, ctx)).ok, false);
  });

  it("picks the most recent implementer attempt when it succeeded", async () => {
    const newer = run({ id: "run-impl-2", role: "IMPLEMENTER", status: "SUCCEEDED", specRevision: 1 });
    const ctx = contextWith({ runs: [IMPL, newer] });
    const result = await resolveCurrentImplementation(workItemAt("IMPLEMENTING"), ctx);
    assert.ok(result.ok);
    assert.equal(result.value.id, "run-impl-2");
  });

  it("fails when the lineage head is a FAILED attempt, even though an older run SUCCEEDED", async () => {
    const failedHead = run({ id: "run-impl-2", role: "IMPLEMENTER", status: "FAILED", specRevision: 1 });
    const ctx = contextWith({ runs: [IMPL, failedHead] });
    const result = await resolveCurrentImplementation(workItemAt("IMPLEMENTING"), ctx);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /run-impl-2 is FAILED/);
    }
  });

  it("fails when the lineage head is still RUNNING", async () => {
    const runningHead = run({ id: "run-impl-2", role: "IMPLEMENTER", status: "RUNNING", specRevision: 1 });
    const ctx = contextWith({ runs: [IMPL, runningHead] });
    assert.equal((await resolveCurrentImplementation(workItemAt("IMPLEMENTING"), ctx)).ok, false);
  });
});

describe("requireSuccessfulImplementationRun", () => {
  it("fails with no implementation and succeeds with one", async () => {
    assert.equal((await requireSuccessfulImplementationRun(workItemAt("IMPLEMENTING"), contextWith({}))).satisfied, false);
    const ctx = contextWith({ runs: [IMPL] });
    assert.equal((await requireSuccessfulImplementationRun(workItemAt("IMPLEMENTING"), ctx)).satisfied, true);
  });
});

describe("requireSuccessfulVerification", () => {
  it("fails when the verifier run targets a different implementation", async () => {
    const strayVerifier = { ...VERIFIER, targetRunId: "run-somewhere-else" };
    const ctx = contextWith({ runs: [IMPL, strayVerifier], reviews: [DETERMINISTIC] });
    const result = await requireSuccessfulVerification(workItemAt("VERIFYING"), ctx);
    assert.equal(result.satisfied, false);
    assert.match(result.reason, /no VERIFIER run targeting/);
  });

  it("fails when the verifier run left no evidence", async () => {
    const ctx = contextWith({ runs: [IMPL, { ...VERIFIER, evidenceIds: [] }], reviews: [DETERMINISTIC] });
    const result = await requireSuccessfulVerification(workItemAt("VERIFYING"), ctx);
    assert.equal(result.satisfied, false);
    assert.match(result.reason, /no evidence/);
  });

  it("fails when no passing deterministic review exists", async () => {
    const ctx = contextWith({ runs: [IMPL, VERIFIER] });
    assert.equal((await requireSuccessfulVerification(workItemAt("VERIFYING"), ctx)).satisfied, false);
  });

  it("fails when the deterministic review did not pass", async () => {
    const ctx = contextWith({ runs: [IMPL, VERIFIER], reviews: [{ ...DETERMINISTIC, verdict: "FAIL" }] });
    assert.equal((await requireSuccessfulVerification(workItemAt("VERIFYING"), ctx)).satisfied, false);
  });

  it("succeeds with an evidenced verifier run and a passing deterministic review of that run", async () => {
    const ctx = contextWith({ runs: [IMPL, VERIFIER], reviews: [DETERMINISTIC] });
    assert.equal((await requireSuccessfulVerification(workItemAt("VERIFYING"), ctx)).satisfied, true);
  });
});

describe("requireIndependentSemanticReview", () => {
  it("fails when the semantic reviewer is the same principal as the implementer", async () => {
    // C4 modelled where it actually lives: on the RUN records. The reviewer
    // attempt was executed by the implementer's principal.
    const selfReviewRun = { ...REVIEWER, workerPrincipalId: "wp-impl" };
    const selfReview = { ...SEMANTIC, reviewerPrincipalId: "wp-impl" };
    const ctx = contextWith({ runs: [IMPL, VERIFIER, selfReviewRun], reviews: [DETERMINISTIC, selfReview] });
    assert.equal((await requireIndependentSemanticReview(workItemAt("REVIEW"), ctx)).satisfied, false);
  });

  it("fails when the semantic review is of a different implementation run", async () => {
    const otherReview = { ...SEMANTIC, reviewedRunId: "run-other" };
    const ctx = contextWith({ runs: [IMPL, VERIFIER, REVIEWER], reviews: [DETERMINISTIC, otherReview] });
    assert.equal((await requireIndependentSemanticReview(workItemAt("REVIEW"), ctx)).satisfied, false);
  });

  it("fails when the semantic review names a reviewer run that does not exist (round-5 HIGH 2)", async () => {
    const danglingReview = { ...SEMANTIC, reviewerRunId: "run-never-existed" };
    const ctx = contextWith({ runs: [IMPL, VERIFIER, REVIEWER], reviews: [DETERMINISTIC, danglingReview] });
    assert.equal((await requireIndependentSemanticReview(workItemAt("REVIEW"), ctx)).satisfied, false);
  });

  it("succeeds with an independent passing semantic review of the current implementation", async () => {
    const ctx = contextWith({ runs: [IMPL, VERIFIER, REVIEWER], reviews: [DETERMINISTIC, SEMANTIC] });
    assert.equal((await requireIndependentSemanticReview(workItemAt("REVIEW"), ctx)).satisfied, true);
  });
});

describe("requireReleasableSnapshot", () => {
  const fullContext = (over: Partial<Fixtures> = {}): WorkflowReadContext =>
    contextWith({
      runs: [IMPL, VERIFIER, REVIEWER],
      reviews: [DETERMINISTIC, SEMANTIC],
      criteria: CRITERIA,
      verifications: verificationsFor("run-impl"),
      ...over,
    });

  it("fails when a criterion has no verification", async () => {
    const ctx = fullContext({ verifications: verificationsFor("run-impl").slice(0, 1) });
    const result = await requireReleasableSnapshot(workItemAt("WAITING_FOR_HUMAN"), ctx);
    assert.equal(result.satisfied, false);
    assert.match(result.reason, /ac-2/);
  });

  it("fails when a criterion verification FAILED", async () => {
    const failing = verificationsFor("run-impl").map((entry, index) =>
      index === 1 ? { ...entry, result: "FAILED" as const } : entry,
    );
    assert.equal((await requireReleasableSnapshot(workItemAt("WAITING_FOR_HUMAN"), fullContext({ verifications: failing }))).satisfied, false);
  });

  it("fails when verifications attest a different implementation run", async () => {
    const ctx = fullContext({ verifications: verificationsFor("run-impl-OLD") });
    assert.equal((await requireReleasableSnapshot(workItemAt("WAITING_FOR_HUMAN"), ctx)).satisfied, false);
  });

  it("fails when there are no acceptance criteria at all", async () => {
    assert.equal((await requireReleasableSnapshot(workItemAt("WAITING_FOR_HUMAN"), fullContext({ criteria: [] }))).satisfied, false);
  });

  it("succeeds when every component names the current implementation", async () => {
    assert.equal((await requireReleasableSnapshot(workItemAt("WAITING_FOR_HUMAN"), fullContext())).satisfied, true);
  });
});

describe("release snapshot identity", () => {
  const base = (): WorkflowReadContext =>
    contextWith({
      runs: [IMPL, VERIFIER, REVIEWER],
      reviews: [DETERMINISTIC, SEMANTIC],
      criteria: CRITERIA,
      verifications: verificationsFor("run-impl"),
    });

  it("is stable for unchanged state", async () => {
    const item = workItemAt("WAITING_FOR_HUMAN");
    const first = await resolveReleaseSnapshot(item, base());
    const second = await resolveReleaseSnapshot(item, base());
    assert.ok(first.ok && second.ok);
    assert.equal(first.value.id, second.value.id);
  });

  it("changes when a new implementation run appears, orphaning all prior proof", async () => {
    const item = workItemAt("WAITING_FOR_HUMAN");
    const before = await resolveReleaseSnapshot(item, base());
    assert.ok(before.ok);

    const newer = run({ id: "run-impl-2", role: "IMPLEMENTER", status: "SUCCEEDED", specRevision: 1 });
    const after = await resolveReleaseSnapshot(
      item,
      contextWith({
        runs: [IMPL, VERIFIER, REVIEWER, newer],
        reviews: [DETERMINISTIC, SEMANTIC],
        criteria: CRITERIA,
        verifications: verificationsFor("run-impl"),
      }),
    );
    assert.equal(after.ok, false, "prior verification and review no longer describe the current implementation");
  });
});
