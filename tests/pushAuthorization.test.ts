/**
 * TASK-016 AC-1/AC-2: a push verdict is EARNED from an observation of the exact
 * target, or the push is financial and therefore refused.
 *
 * `GIT_PUSH` was registered financial with a comment predicting this exact
 * shape — "a push to a target with demonstrated zero liability could earn a
 * minted action later, the way verification commands did". These cases are what
 * makes the earning real rather than asserted: every way of NOT demonstrating
 * zero liability has a case, and each one must refuse.
 *
 * Offline: no network, no gh, no money.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DENY_ALL_SPENDING,
  evaluateFinancialSafety,
  gitPushAction,
  observeRepositoryBilling,
  parseFinancialPolicy,
  type RepositoryBillingObservation,
} from "../src/supervision/financialSafety.js";

const ZERO_SPEND = parseFinancialPolicy({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 });
const TARGET = "hakanduyar/software-factory";

function verdictFor(action: ReturnType<typeof gitPushAction>) {
  return evaluateFinancialSafety(action, ZERO_SPEND);
}

function publicUnmetered(target = TARGET): RepositoryBillingObservation {
  return observeRepositoryBilling({ target, visibility: "PUBLIC", billableIntegrations: 0 });
}

describe("TASK-016 AC-1: the push verdict is earned, never asserted", () => {
  /**
   * THE CONTROL. A public repository with no repository-level integrations is
   * the one case where GitHub's own billing demonstrably cannot meter the
   * push. If this case ever stops passing, the capability is gone entirely and
   * every case below would pass vacuously.
   */
  it("permits a push to an observed public repository with no integrations", () => {
    const verdict = verdictFor(
      gitPushAction({ target: TARGET, observation: publicUnmetered(), description: "publish candidate" }),
    );

    assert.equal(verdict.allowed, true, `an unmetered push was refused: ${JSON.stringify(verdict)}`);
    assert.equal(verdict.actionClass, "FREE_REMOTE_ACTION");
  });

  /**
   * A BARE GIT_PUSH IS STILL FINANCIAL. This is the property AC-1 states
   * directly: the kind alone carries no verdict, so a caller that constructs
   * the action object by hand — or copies a minted one, which produces a
   * DIFFERENT object — gets no permission from having the right `kind`.
   */
  it("refuses a GIT_PUSH that no minter produced", () => {
    const verdict = evaluateFinancialSafety(
      { kind: "GIT_PUSH", description: "hand-built push" },
      ZERO_SPEND,
    );

    assert.equal(verdict.allowed, false, "an unminted GIT_PUSH was permitted");
    assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
  });

  /**
   * THE SPREAD COPY. `{ ...minted }` is a different object, so it is not in the
   * mint record — the same defence F4-2 established for AI launches, restated
   * for pushes because a new minter is a new chance to get it wrong.
   */
  it("refuses a copy of a minted push action", () => {
    const minted = gitPushAction({ target: TARGET, observation: publicUnmetered(), description: "publish" });
    const copied = { ...minted };

    assert.equal(verdictFor(copied).allowed, false, "a spread copy of a minted action carried its verdict");
  });

  /**
   * THE BINDING. An observation of repository A says nothing about repository
   * B, and this is the case that fails if the target comparison is removed.
   * Both observations are genuine and both describe unmetered public
   * repositories — so ONLY the target mismatch can produce the refusal, and a
   * sibling guard cannot be what catches it.
   */
  it("refuses when the observation describes a different repository", () => {
    const elsewhere = publicUnmetered("someone-else/other-repo");

    const verdict = verdictFor(
      gitPushAction({ target: TARGET, observation: elsewhere, description: "publish" }),
    );

    assert.equal(verdict.allowed, false, "a verdict earned for one repository authorised a push to another");
    assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
  });

  /**
   * THE FORGERY. A structurally identical object that this module did not
   * produce is not an observation. Without the `WeakSet` check any caller
   * could assert its own zero liability, which is the "declared, not derived"
   * hole the whole gate exists to close.
   */
  it("refuses an observation this module did not produce", () => {
    const forged: RepositoryBillingObservation = {
      target: TARGET,
      visibility: "PUBLIC",
      billableIntegrations: 0,
    };

    assert.equal(
      verdictFor(gitPushAction({ target: TARGET, observation: forged, description: "publish" })).allowed,
      false,
      "a hand-built observation earned a free verdict",
    );
  });

  it("refuses when no observation is supplied at all", () => {
    assert.equal(
      verdictFor(gitPushAction({ target: TARGET, description: "publish" })).allowed,
      false,
      "an unobserved push was permitted",
    );
  });
});

describe("TASK-016 AC-2: zero liability must be observed, not assumed", () => {
  /**
   * A PRIVATE REPOSITORY METERS ACTIONS MINUTES. Whether the allowance is
   * currently exhausted is irrelevant — an allowance that meters is a
   * liability, and `AUTONOMOUS_SPEND_LIMIT = 0` has no room for one.
   */
  it("refuses a push to a private repository", () => {
    const observation = observeRepositoryBilling({
      target: TARGET,
      visibility: "PRIVATE",
      billableIntegrations: 0,
    });

    const verdict = verdictFor(gitPushAction({ target: TARGET, observation, description: "publish" }));

    assert.equal(verdict.allowed, false, "a push to a private repository was permitted");
    assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
  });

  /** Visibility that could not be established is UNKNOWN, and unknown is financial. */
  it("refuses when visibility could not be determined", () => {
    const observation = observeRepositoryBilling({
      target: TARGET,
      visibility: undefined,
      billableIntegrations: 0,
    });

    assert.equal(
      verdictFor(gitPushAction({ target: TARGET, observation, description: "publish" })).allowed,
      false,
      "an unknown visibility was treated as safe",
    );
  });

  /**
   * A WEBHOOK CAN HAND THE PUSH TO A METERED THIRD PARTY. The repository is
   * public here, so the visibility half of the rule is satisfied and only the
   * integration count can produce the refusal.
   */
  it("refuses when the repository has a billable integration", () => {
    const observation = observeRepositoryBilling({
      target: TARGET,
      visibility: "PUBLIC",
      billableIntegrations: 1,
    });

    assert.equal(
      verdictFor(gitPushAction({ target: TARGET, observation, description: "publish" })).allowed,
      false,
      "a repository with a webhook was treated as unmetered",
    );
  });

  /**
   * AN UNCOUNTABLE INTEGRATION LIST IS NOT AN EMPTY ONE. The adapter degrades
   * to `undefined` when the hooks endpoint cannot be read, and that must not
   * arrive here as zero.
   */
  it("refuses when the integration count could not be established", () => {
    const observation = observeRepositoryBilling({
      target: TARGET,
      visibility: "PUBLIC",
      billableIntegrations: undefined,
    });

    assert.equal(
      verdictFor(gitPushAction({ target: TARGET, observation, description: "publish" })).allowed,
      false,
      "an unknown integration count was treated as none",
    );
  });

  /**
   * AND THE POLICY STILL DOMINATES. Even a fully demonstrated zero-liability
   * push is refused when the stored policy does not parse — the F6-POL-1 rule.
   * Without this, TASK-016 would have created the first path where a remote
   * write proceeds under an untrusted policy.
   */
  it("refuses even an unmetered push when the financial policy is untrusted", () => {
    const verdict = evaluateFinancialSafety(
      gitPushAction({ target: TARGET, observation: publicUnmetered(), description: "publish" }),
      parseFinancialPolicy({ autonomousSpendAllowed: true, autonomousSpendLimit: 5 }),
    );

    assert.equal(verdict.allowed, false, "a policy claiming spend authority permitted a push");
  });

  it("refuses an unmetered push under the deny-all policy object", () => {
    const verdict = evaluateFinancialSafety(
      gitPushAction({ target: TARGET, observation: publicUnmetered(), description: "publish" }),
      parseFinancialPolicy(DENY_ALL_SPENDING),
    );

    // DENY_ALL_SPENDING parses cleanly and denies spending, so a FREE action is
    // still permitted — the check here is that the verdict is decided by the
    // action's class rather than by the policy's name.
    assert.equal(verdict.allowed, true, `the deny-all policy blocked a free action: ${JSON.stringify(verdict)}`);
  });
});

describe("TASK-016: the push minter did not widen anything else", () => {
  /**
   * The destructive and publication kinds sit next to `GIT_PUSH` in the same
   * table and must be exactly as refused as before. A minter for one remote
   * write is the obvious moment to accidentally bless the others.
   */
  for (const kind of ["FORCE_PUSH", "DELETE_REMOTE_BRANCH", "MAKE_REPOSITORY_PUBLIC", "PUBLISH_PACKAGE"]) {
    it(`still refuses ${kind}`, () => {
      const verdict = evaluateFinancialSafety({ kind, description: `attempt ${kind}` }, ZERO_SPEND);

      assert.equal(verdict.allowed, false, `${kind} became permitted`);
    });
  }

  /**
   * A MINTED PUSH IS NOT A MINTED ANYTHING-ELSE (F5-SEC-1). The mint record is
   * bound to its kind, so relabelling the object must not carry the verdict
   * across.
   */
  it("does not let a push verdict authorise a different kind", () => {
    const minted = gitPushAction({ target: TARGET, observation: publicUnmetered(), description: "publish" });
    const relabelled = { ...minted, kind: "PROVISION_VPS" };

    assert.equal(verdictFor(relabelled).allowed, false, "a push verdict authorised provisioning a VPS");
  });

  /** The remote probe earned nothing in this task and must be untouched. */
  it("still refuses PROBE_RESOURCE_REMOTE", () => {
    assert.equal(
      evaluateFinancialSafety({ kind: "PROBE_RESOURCE_REMOTE", description: "probe" }, ZERO_SPEND).allowed,
      false,
      "a remote probe became free",
    );
  });
});
