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
  deriveActionClass,
  describePushLiability,
  evaluateFinancialSafety,
  createPullRequestAction,
  observePushLiability,
  parseFinancialPolicy,
  type PushLiabilityObservation,
} from "../src/supervision/financialSafety.js";

const ZERO_SPEND = parseFinancialPolicy({ autonomousSpendAllowed: false, autonomousSpendLimit: 0 });
const TARGET = "hakanduyar/software-factory";

function verdictFor(action: ReturnType<typeof createPullRequestAction>) {
  return evaluateFinancialSafety(action, ZERO_SPEND);
}

/** Every OBSERVABLE channel closed — the best a target can look. */
function publicUnmetered(
  target = TARGET,
  overrides: Partial<Parameters<typeof observePushLiability>[0]> = {},
): PushLiabilityObservation {
  return observePushLiability({
    target,
    visibility: "PUBLIC",
    ownerType: "USER",
    repositoryWebhooks: 0,
    configuredWorkflows: 0,
    candidateAddsWorkflows: false,
    ...overrides,
  });
}

/** The channels `describePushLiability` reports as OPEN for an observation. */
function openChannels(observation: PushLiabilityObservation | undefined): readonly string[] {
  return describePushLiability(observation)
    .filter((entry) => !entry.closed)
    .map((entry) => entry.name);
}

describe("TASK-016 AC-1/AC-2: a push cannot currently be demonstrated free", () => {
  /**
   * THE FINDING, PINNED AS A TEST (round-2 CRITICAL 2).
   *
   * Two rounds were spent trying to earn a free push verdict from observation.
   * The reviewer showed that a GitHub App can subscribe to push events
   * independently of both webhook scopes, and the Factory's credentials cannot
   * enumerate installations — so a metered channel exists that this process
   * cannot inspect. Minting `costKnownZero` while admitting that would be the
   * declared-not-derived mistake the gate exists to prevent.
   *
   * So even a PERFECT target refuses, and the refusal is reasoned: the detail
   * names every channel closed by observation and the one that remains open.
   */
  it("refuses even a fully observed, otherwise unmetered target", () => {
    const action = createPullRequestAction({
      target: TARGET,
      observation: publicUnmetered(),
      description: "publish candidate",
    });

    const verdict = verdictFor(action);

    assert.equal(verdict.allowed, false, "a push was minted free despite an unobservable metered channel");
    assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
    assert.match(action.detail ?? "", /github-app-subscriptions/, "the refusal does not name the open channel");
  });

  /**
   * AND THE REPORT IS REAL, not a constant. Everything observable is reported
   * CLOSED for a perfect target — which is what makes the refusal informative
   * rather than a wall, and what would let a future observable App signal flip
   * the verdict without a new branch.
   */
  it("reports every observable channel as closed for a perfect target", () => {
    const channels = describePushLiability(publicUnmetered());

    const open = channels.filter((entry) => !entry.closed).map((entry) => entry.name);
    assert.deepEqual(open, ["github-app-subscriptions"], `unexpected open channels: ${open.join(", ")}`);
  });

  /**
   * THE CONTROL THAT KEEPS THE MACHINERY HONEST. The gate can still say FREE
   * for a remote action — so the refusal above is a statement about pushes,
   * not an artefact of a gate that refuses everything.
   */
  it("still classifies a genuinely free remote action as free", () => {
    assert.equal(
      deriveActionClass({
        costKnownZero: true,
        requiresPaymentMethod: false,
        canIncurUsageCharges: false,
        changesBillingConfiguration: false,
        requiresHumanCredential: false,
        makesPublic: false,
        irreversibleDataLoss: false,
        remote: true,
      }),
      "FREE_REMOTE_ACTION",
    );
  });

  /**
   * A BARE GIT_PUSH IS STILL FINANCIAL. This is the property AC-1 states
   * directly: the kind alone carries no verdict, so a caller that constructs
   * the action object by hand — or copies a minted one, which produces a
   * DIFFERENT object — gets no permission from having the right `kind`.
   */
  it("refuses a CREATE_PULL_REQUEST that no minter produced", () => {
    const verdict = evaluateFinancialSafety(
      { kind: "CREATE_PULL_REQUEST", description: "hand-built creation" },
      ZERO_SPEND,
    );

    assert.equal(verdict.allowed, false, "an unminted CREATE_PULL_REQUEST was permitted");
    assert.equal(verdict.actionClass, "FINANCIAL_ACTION");
  });

  /**
   * THE SPREAD COPY. `{ ...minted }` is a different object, so it is not in the
   * mint record — the same defence F4-2 established for AI launches, restated
   * for pushes because a new minter is a new chance to get it wrong.
   */
  it("refuses a copy of a minted push action", () => {
    const minted = createPullRequestAction({ target: TARGET, observation: publicUnmetered(), description: "publish" });
    const copied = { ...minted };

    assert.equal(verdictFor(copied).allowed, false, "a spread copy of a minted action carried its verdict");
  });

  /**
   * AN UNTRUSTED OBSERVATION IS NO OBSERVATION, and that is asserted on the
   * REPORT rather than on the verdict.
   *
   * Every push refuses now, so `allowed === false` proves nothing about these
   * three guards — it would hold with the binding, the `WeakSet` check and the
   * observation itself all deleted. What must remain true is that a
   * mismatched, forged or absent observation contributes NOTHING: the report
   * shows the observable channels as UNKNOWN rather than as the reassuring
   * values the object claimed.
   */
  const untrusted: readonly (readonly [string, PushLiabilityObservation | undefined])[] = [
    // Genuine, but about another repository.
    ["an observation describing a different repository", publicUnmetered("someone-else/other-repo")],
    // Structurally perfect, but this module did not produce it.
    [
      "an observation this module did not produce",
      {
        target: TARGET,
        visibility: "PUBLIC",
        ownerType: "USER",
        repositoryWebhooks: 0,
        configuredWorkflows: 0,
        candidateAddsWorkflows: false,
          },
    ],
    ["no observation at all", undefined],
  ];

  for (const [label, observation] of untrusted) {
    it(`ignores ${label} entirely`, () => {
      const action = createPullRequestAction({
        target: TARGET,
        ...(observation === undefined ? {} : { observation }),
        description: "publish",
      });

      assert.equal(verdictFor(action).allowed, false, `${label} earned a free verdict`);
      // The claimed-good values must not appear: the observation was discarded.
      assert.match(action.detail ?? "", /visibility UNKNOWN/, `${label} contributed its claimed visibility`);
      assert.match(action.detail ?? "", /owner UNKNOWN/, `${label} contributed its claimed owner type`);
      assert.ok(
        !/webhooks 0/.test(action.detail ?? ""),
        `${label} contributed its claimed webhook count`,
      );
    });
  }

  /** The control: a TRUSTED observation does reach the report. */
  it("uses an observation that is genuine and names the right target", () => {
    const action = createPullRequestAction({ target: TARGET, observation: publicUnmetered(), description: "publish" });

    assert.match(action.detail ?? "", /visibility PUBLIC/, "a genuine observation was discarded");
    assert.match(action.detail ?? "", /owner USER/);
  });
});

describe("TASK-016 AC-2: zero liability must be observed, not assumed", () => {
  /**
   * ONE CASE PER MECHANISM by which a push to GitHub can start something
   * billable. Each fixture satisfies EVERY other condition, so only the named
   * one can produce the refusal — a sibling guard cannot be what catches it.
   *
   * The `configuredWorkflows` and `candidateAddsWorkflows` cases exist because
   * of round-1 CRITICAL 2: GitHub bills LARGER RUNNERS even on public
   * repositories, so "public" alone never established zero liability. With no
   * workflows on the target and none introduced by the push, no Actions run can
   * start at all — and runner size cannot bill a run that cannot exist.
   */
  /**
   * ASSERTED ON THE CHANNEL REPORT, NOT THE VERDICT.
   *
   * Every push refuses now, so a test asserting `allowed === false` would pass
   * no matter what these observations said — the vacuous-guard trap. What must
   * remain true is that each mechanism is reported OPEN when present, because
   * that report is what a human acts on and what a future observable App
   * signal would combine with.
   */
  const mechanisms = [
    ["a private repository", { visibility: "PRIVATE" as const }, "actions-metering"],
    ["a visibility that could not be read", { visibility: undefined }, "actions-metering"],
    ["an organisation owner, whose org-scoped webhooks this token cannot enumerate", { ownerType: "ORGANIZATION" as const }, "organisation-webhooks"],
    ["an owner type that could not be read", { ownerType: undefined }, "organisation-webhooks"],
    ["a repository webhook", { repositoryWebhooks: 1 }, "repository-webhooks"],
    ["a webhook count that could not be read", { repositoryWebhooks: undefined }, "repository-webhooks"],
    ["a configured workflow, which a larger runner could bill", { configuredWorkflows: 1 }, "existing-workflows"],
    ["a workflow count that could not be read", { configuredWorkflows: undefined }, "existing-workflows"],
    ["a candidate that introduces a workflow", { candidateAddsWorkflows: true }, "introduced-workflows"],
    ["an unknown answer about introduced workflows", { candidateAddsWorkflows: undefined }, "introduced-workflows"],
  ] as const;

  for (const [label, override, channel] of mechanisms) {
    it(`reports ${channel} open for ${label}`, () => {
      const observation = publicUnmetered(TARGET, override);

      const open = openChannels(observation);

      assert.ok(open.includes(channel), `${label} did not open ${channel}; open: ${open.join(", ")}`);
      // And the push still refuses, which it would anyway — asserted so the
      // pair reads as "this mechanism is why", not "everything refuses".
      assert.equal(
        verdictFor(createPullRequestAction({ target: TARGET, observation, description: "publish" })).allowed,
        false,
      );
    });
  }

  /**
   * The report must DISCRIMINATE: a perfect target opens exactly one channel,
   * so any mechanism above adds to that rather than being lost in noise.
   */
  it("opens only the unobservable channel when everything observable is closed", () => {
    assert.deepEqual(openChannels(publicUnmetered()), ["github-app-subscriptions"]);
  });

  /** An absent observation opens EVERYTHING — unknown is not partial credit. */
  it("opens every channel when there is no observation at all", () => {
    assert.equal(openChannels(undefined).length, describePushLiability(undefined).length);
  });

  /**
   * AND THE POLICY STILL DOMINATES. Even a fully demonstrated zero-liability
   * push is refused when the stored policy does not parse — the F6-POL-1 rule.
   * Without this, TASK-016 would have created the first path where a remote
   * write proceeds under an untrusted policy.
   */
  it("refuses even an unmetered push when the financial policy is untrusted", () => {
    const verdict = evaluateFinancialSafety(
      createPullRequestAction({ target: TARGET, observation: publicUnmetered(), description: "publish" }),
      parseFinancialPolicy({ autonomousSpendAllowed: true, autonomousSpendLimit: 5 }),
    );

    assert.equal(verdict.allowed, false, "a policy claiming spend authority permitted a push");
  });

  /**
   * The verdict is decided by the ACTION's class, not by the policy's name —
   * shown by the pair: a push refuses under a cleanly-parsing deny-all policy
   * (because the action is financial), while a genuinely free action is still
   * permitted under that same policy.
   */
  it("decides by the action's class, not by the policy's name", () => {
    const policy = parseFinancialPolicy(DENY_ALL_SPENDING);

    const push = evaluateFinancialSafety(
      createPullRequestAction({ target: TARGET, observation: publicUnmetered(), description: "publish" }),
      policy,
    );
    const free = evaluateFinancialSafety({ kind: "GIT_FETCH", description: "fetch" }, policy);

    assert.equal(push.allowed, false, "a push is financial and must refuse");
    assert.equal(free.allowed, true, `the deny-all policy blocked a free action: ${JSON.stringify(free)}`);
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
    const minted = createPullRequestAction({ target: TARGET, observation: publicUnmetered(), description: "publish" });
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
