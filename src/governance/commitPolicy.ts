/**
 * COMMIT ATTRIBUTION POLICY — a deterministic regression guard.
 *
 * New commits may not carry AI attribution trailers. The canonical author of
 * this repository's history is Hakan Duyar <iamhakanduyar@gmail.com>; the tools
 * used to produce a change are not co-authors of it.
 *
 * HISTORY IS NOT REWRITTEN. Thirteen commits between `1b32854` (2026-08-22) and
 * `8f0c240` (2026-08-29) carry `Co-Authored-By: Claude`. Those are published and
 * are left exactly as they are — rewriting published history to tidy a
 * governance record would destroy the record it is meant to preserve, and would
 * be a far larger violation than the one it erased. They are recorded as a
 * historical deviation in docs/governance/COMMIT-ATTRIBUTION-POLICY.md and
 * bounded by the baseline below.
 *
 * The rule therefore applies from a BASELINE forward, not retroactively.
 */

/**
 * The last commit permitted to carry a historical trailer.
 *
 * Everything reachable from this commit is history and is exempt. Everything
 * after it is new work and is governed. Written as a full SHA because an
 * abbreviation can become ambiguous as a repository grows.
 */
export const ATTRIBUTION_BASELINE = "8f0c2403157d8217c749838b51f00b1a35b1f02b";

/**
 * Names that make a trailer an AI attribution.
 *
 * Matched case-insensitively against the trailer VALUE, so
 * `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` is caught by both the
 * name and the address. The list is deliberately about identities rather than a
 * single exact string: the defect is attributing authorship to a tool, and a
 * different spelling of the same tool is the same defect.
 */
const ATTRIBUTION_MARKERS = [
  "claude",
  "anthropic",
  "codex",
  "openai",
  "copilot",
  "chatgpt",
] as const;

/** A trailer line, however it is spaced or capitalised. */
const TRAILER = /^[ \t]*co[-\s]?authored[-\s]?by[ \t]*:(?<value>.*)$/i;

export interface CommitUnderTest {
  readonly sha: string;
  readonly message: string;
}

export interface AttributionViolation {
  readonly sha: string;
  readonly line: string;
  readonly marker: string;
}

/**
 * Every AI attribution trailer in the given commits.
 *
 * Pure, so the rule can be tested exhaustively without creating commits. The
 * caller decides which commits are in scope; this decides what a violation is.
 */
export function findAttributionTrailers(
  commits: readonly CommitUnderTest[],
): readonly AttributionViolation[] {
  const violations: AttributionViolation[] = [];
  for (const commit of commits) {
    for (const rawLine of commit.message.split("\n")) {
      const match = TRAILER.exec(rawLine);
      if (match === null) {
        continue;
      }
      const value = (match.groups?.["value"] ?? "").toLowerCase();
      const marker = ATTRIBUTION_MARKERS.find((candidate) => value.includes(candidate));
      if (marker !== undefined) {
        violations.push({ sha: commit.sha, line: rawLine.trim(), marker });
      }
    }
  }
  return violations;
}

/**
 * The message a caller should print. Separated from the detection so a test can
 * assert the REASON rather than merely that something was rejected — the defect
 * that has cost this repository the most review rounds.
 */
export function describeViolations(violations: readonly AttributionViolation[]): string {
  const lines = violations.map(
    (violation) => `  ${violation.sha.slice(0, 10)}  ${violation.line}   (matched "${violation.marker}")`,
  );
  return (
    `commit attribution policy: ${violations.length} new commit trailer(s) attribute authorship to a tool.\n` +
    `${lines.join("\n")}\n` +
    `The canonical author of this repository is Hakan Duyar <iamhakanduyar@gmail.com>. ` +
    `Amend the offending commit message rather than rewriting published history.`
  );
}
