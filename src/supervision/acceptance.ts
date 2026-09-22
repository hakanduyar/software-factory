/**
 * Turning a reviewer's verdict into durable state, without a person in the loop
 * (TASK-018 Part B, AC-19 as round 7 proved it was not yet satisfied).
 *
 * WHAT THIS EXISTS BECAUSE OF. Round 7 of this very task: the reviewer finished,
 * wrote a valid CHANGES_REQUIRED verdict, the chain validated it against an
 * unchanged fingerprint, logged it and exited — by design, because consuming a
 * verdict was never its job. The verdict then sat on disk for twenty-two hours.
 * Nothing was broken; nothing was running either. Remediation began when a
 * person sent a message.
 *
 * That is precisely the failure TASK-018 was opened to remove, reproduced by the
 * task's own acceptance loop, and no amount of keeping a model awake fixes it:
 * an always-on watcher is one more process that can die between the verdict
 * landing and anybody noticing. The only thing that cannot be lost is DURABLE
 * STATE, so the verdict becomes durable state and reconciliation — which every
 * tick already performs, from a cold start, with no memory of what launched
 * what — is what consumes it.
 *
 * WHAT IS DELIBERATELY NOT HERE. This module never integrates anything and never
 * decides that a candidate may be integrated. It records what the reviewer said
 * and moves the work to the state that fact implies; ADR-0002's gate is
 * unchanged and still sits between an accepted candidate and `main`. A verdict
 * this module cannot fully establish is NEVER an approval: absence, an
 * unreadable file, a missing binding and a dead reviewer all resolve towards
 * "not accepted", because the one asymmetry worth hard-coding is that a lost
 * verdict must cost a re-review rather than an unreviewed integration.
 */


export const ACCEPTANCE_VERDICTS = ["PASS", "PASS_WITH_NON_BLOCKING_NOTES", "CHANGES_REQUIRED"] as const;

export type AcceptanceVerdict = (typeof ACCEPTANCE_VERDICTS)[number];

/**
 * Exactly what was reviewed.
 *
 * Three facts, not one, because they fail in different ways: the commit says
 * which history, the tree says which content (two commits can share a tree, and
 * an amend changes the commit without changing the work), and the fingerprint
 * covers the WORKING state including anything uncommitted. A verdict that
 * matches on commit alone is not a verdict on what would be integrated.
 */
export interface CandidateBinding {
  readonly commit: string;
  readonly tree: string;
  readonly fingerprint: string;
}

/** Where a launched review will report, and what it was bound to. */
export interface ReviewBinding {
  /** Identity of the review RUN, so two reviews of one candidate stay distinct. */
  readonly reviewId: string;
  /**
   * Where the verdict will appear. Opaque here on purpose: the domain must not
   * know that today's reviewer writes a file, because tomorrow's may not.
   */
  readonly source: string;
  readonly candidate: CandidateBinding;
  /**
   * WHO was asked, and how hard (TASK-019 AC-2).
   *
   * Recorded because a verdict is only independent if the thing that produced
   * it was the thing that was supposed to: "reviewed by gpt-5.6-luna at xhigh"
   * is a claim, and a claim with nothing durable behind it is how a cheaper
   * model's opinion quietly becomes an acceptance. It also makes the routing
   * policy auditable after the fact rather than inferable from a shell script.
   */
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  /** Which attempt at reviewing this item this is. */
  readonly attempt: number;
  /**
   * Where the WORKER proves it started, naming this run (AC-4).
   *
   * Separate from `source` because they answer different questions and fail at
   * different times: the acknowledgement says "a process exists and it is
   * mine", the source says "it reached a conclusion". Conflating them is how
   * "I intended to launch" became "it is running".
   */
  readonly ack: string;
}

/**
 * What a worker writes to prove it is the run that was launched.
 *
 * A pid alone is not identity — pids are recycled, and a pid written by the
 * LAUNCHER proves only that the launcher believed something. The worker names
 * the run id it was given and the lease it can be checked by, so adoption
 * compares a fact the worker itself asserted against the record that predates
 * it.
 */
export interface LaunchAcknowledgement {
  readonly runId: string;
  readonly pid: number;
  readonly processStartedAt: number;
  readonly machine: string;
  readonly boot: string;
  readonly at: number;
}

export interface AcceptanceOutcome {
  readonly verdict: AcceptanceVerdict;
  readonly critical: number;
  readonly high: number;
  readonly safeToCommit: boolean;
  readonly candidate: CandidateBinding;
}

/**
 * What is knowable about a review right now.
 *
 * `ABSENT` and `NO_VERDICT` are kept apart because they mean different things
 * about the reviewer: nothing has been written yet (it may still be working)
 * versus something was written and is not a verdict (it will never become one).
 * Collapsing them would make a truncated file look like a review still in
 * progress, forever.
 */
export type VerdictReading =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "NO_VERDICT"; readonly reason: string }
  | { readonly kind: "VERDICT"; readonly outcome: AcceptanceOutcome };

export interface AcceptanceVerdictSource {
  read(review: ReviewBinding): VerdictReading;
}

/** The outcome string recorded on an activity that reviewed something. */
export const NO_VERDICT_OUTCOME = "NO_VERDICT";

const VERDICT_LINE = /^VERDICT:[ \t]*(.+?)[ \t]*$/gm;
const SAFE_LINE = /^Safe to commit:[ \t]*(.+?)[ \t]*$/gm;
const COUNT_LINE = /^FACTORY_ACCEPTANCE_COUNTS:[ \t]*CRITICAL=(\d+)[ \t]+HIGH=(\d+)[ \t]*$/gm;
const BINDING_LINE = /^FACTORY_ACCEPTANCE_CANDIDATE:[ \t]*([0-9a-f]{7,40})[ \t]+([0-9a-f]{7,64})[ \t]+([0-9a-f]{7,64})[ \t]*$/gm;

function onlyMatch(pattern: RegExp, text: string): RegExpExecArray | undefined {
  pattern.lastIndex = 0;
  const first = pattern.exec(text);
  if (first === null) {
    return undefined;
  }
  /**
   * A SECOND TAG IS AMBIGUITY, AND AMBIGUITY IS NOT A VERDICT.
   *
   * Two `VERDICT:` lines that agree are still two, and the reviewer's prose
   * quoting the format it was asked for is exactly how a discussion of PASS
   * becomes a PASS. The repository already made this choice once, in
   * `reviewVerdictParser`; it is made the same way here rather than differently.
   */
  const second = pattern.exec(text);
  pattern.lastIndex = 0;
  return second === null ? first : undefined;
}

/**
 * Reads a verdict out of whatever the reviewer wrote, or refuses to.
 *
 * Strict by construction: every field is a whole-line tag, appearing exactly
 * once. The candidate binding is REQUIRED, because a verdict that does not say
 * what it is about cannot be checked against what would be integrated, and an
 * uncheckable approval is the one thing this mechanism must never manufacture.
 */
export function parseAcceptanceVerdict(text: string): VerdictReading {
  if (text.trim().length === 0) {
    return { kind: "ABSENT" };
  }

  const verdictMatch = onlyMatch(VERDICT_LINE, text);
  if (verdictMatch === undefined) {
    return { kind: "NO_VERDICT", reason: "no single `VERDICT:` line" };
  }
  const named = verdictMatch[1] ?? "";
  const verdict = ACCEPTANCE_VERDICTS.find((candidate) => candidate === named);
  if (verdict === undefined) {
    return { kind: "NO_VERDICT", reason: `${JSON.stringify(named)} is not a recognised verdict` };
  }

  const safeMatch = onlyMatch(SAFE_LINE, text);
  if (safeMatch === undefined) {
    return { kind: "NO_VERDICT", reason: "no single `Safe to commit:` line" };
  }
  const safeWord = safeMatch[1] ?? "";
  if (safeWord !== "YES" && safeWord !== "NO") {
    return { kind: "NO_VERDICT", reason: `${JSON.stringify(safeWord)} is neither YES nor NO` };
  }

  const countMatch = onlyMatch(COUNT_LINE, text);
  if (countMatch === undefined) {
    return { kind: "NO_VERDICT", reason: "no single `FACTORY_ACCEPTANCE_COUNTS:` line" };
  }

  const bindingMatch = onlyMatch(BINDING_LINE, text);
  if (bindingMatch === undefined) {
    return { kind: "NO_VERDICT", reason: "no single `FACTORY_ACCEPTANCE_CANDIDATE:` line" };
  }

  return {
    kind: "VERDICT",
    outcome: {
      verdict,
      critical: Number(countMatch[1]),
      high: Number(countMatch[2]),
      safeToCommit: safeWord === "YES",
      candidate: {
        commit: bindingMatch[1]!,
        tree: bindingMatch[2]!,
        fingerprint: bindingMatch[3]!,
      },
    },
  };
}

/**
 * Whether a verdict clears ADR-0002's bar. All five conditions, and any one of
 * them missing means it does not.
 */
export function isAccepted(outcome: AcceptanceOutcome): boolean {
  return (
    (outcome.verdict === "PASS" || outcome.verdict === "PASS_WITH_NON_BLOCKING_NOTES") &&
    outcome.critical === 0 &&
    outcome.high === 0 &&
    outcome.safeToCommit
  );
}

/** Why a verdict may not be applied to the review that was launched. */
export function bindingMismatch(expected: CandidateBinding, found: CandidateBinding): string | undefined {
  if (expected.commit !== found.commit) {
    return `verdict names commit ${found.commit}, but this review was launched for ${expected.commit}`;
  }
  if (expected.tree !== found.tree) {
    return `verdict names tree ${found.tree}, but this review was launched for ${expected.tree}`;
  }
  if (expected.fingerprint !== found.fingerprint) {
    return `verdict names fingerprint ${found.fingerprint}, but this review was launched for ${expected.fingerprint}`;
  }
  return undefined;
}

/** How the recorded completion reads, for the one place that writes it. */
export function completionDetail(outcome: AcceptanceOutcome): string {
  return (
    `${outcome.verdict}; CRITICAL=${outcome.critical} HIGH=${outcome.high} ` +
    `safe-to-commit=${outcome.safeToCommit ? "YES" : "NO"}; candidate ${outcome.candidate.commit}`
  );
}
