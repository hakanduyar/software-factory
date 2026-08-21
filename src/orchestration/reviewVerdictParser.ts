/**
 * Strict, fail-closed reviewer-verdict parser (TASK-004 §6/§9/§10).
 *
 * A REVIEWER worker is asked (see loopPrompts.ts) to put a single,
 * machine-parseable tag as the first line of its response:
 *
 *   FACTORY_REVIEW_VERDICT: PASS
 *   FACTORY_REVIEW_FINDINGS:
 *   - <finding>
 *
 * This module never treats the bare substring "PASS" anywhere in prose as a
 * verdict — only an exact, whole-line `FACTORY_REVIEW_VERDICT:` tag counts,
 * so incidental prose ("tests PASS but the verdict below is what counts")
 * cannot be mistaken for one. Zero tags, more than one tag (even if all
 * equal — ambiguity, not merely conflict, is refused), or a tag whose value
 * is not one of the three recognized verdicts are all rejected. This
 * function is pure (no I/O) and is never itself responsible for deciding
 * whether the underlying worker run succeeded — the caller (see
 * engineeringLoopService.ts) must only invoke it for a reviewer run whose
 * process-level status was SUCCEEDED; a FAILED run's output must never
 * reach this parser at all, so "PASS" printed by a crashed process can never
 * become approval.
 */

import { LOOP_REVIEW_VERDICTS, type LoopReviewVerdict } from "./loopTypes.js";

export type ParsedReviewVerdict =
  | { readonly ok: true; readonly verdict: LoopReviewVerdict; readonly findings: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const VERDICT_TAG_PATTERN = /^FACTORY_REVIEW_VERDICT:[ \t]*(.+?)[ \t]*$/gm;
const FINDINGS_HEADER_PATTERN = /^FACTORY_REVIEW_FINDINGS:[ \t]*$/m;

function extractFindings(text: string): readonly string[] {
  const headerMatch = FINDINGS_HEADER_PATTERN.exec(text);
  if (headerMatch === null) {
    return [];
  }
  const after = text.slice(headerMatch.index + headerMatch[0].length);
  const findings: string[] = [];
  for (const rawLine of after.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (!line.startsWith("-")) {
      break; // findings block ends at the first non-bullet, non-blank line
    }
    const item = line.slice(1).trim();
    if (item.length > 0 && item.toLowerCase() !== "none") {
      findings.push(item);
    }
  }
  return findings;
}

/**
 * Parses a strict verdict tag out of one or more candidate source texts
 * (e.g. every Evidence.summary recorded for the reviewer run, then
 * Run.summary as a fallback — see engineeringLoopService.ts). All matches
 * across every source text are pooled before the ambiguity check runs, so a
 * verdict cannot be smuggled past ambiguity detection by splitting it across
 * two evidence entries.
 */
export function parseReviewVerdict(sourceTexts: readonly string[]): ParsedReviewVerdict {
  const matches: string[] = [];
  let findings: readonly string[] = [];

  for (const text of sourceTexts) {
    if (text.length === 0) {
      continue;
    }
    VERDICT_TAG_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = VERDICT_TAG_PATTERN.exec(text)) !== null) {
      matches.push(match[1]!);
    }
    if (matches.length === 1 && findings.length === 0) {
      findings = extractFindings(text);
    }
  }

  if (matches.length === 0) {
    return { ok: false, reason: "no FACTORY_REVIEW_VERDICT tag found in reviewer output" };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `ambiguous reviewer output: ${matches.length} FACTORY_REVIEW_VERDICT tags found (${matches.join(", ")})`,
    };
  }

  const candidate = matches[0]!;
  if (!(LOOP_REVIEW_VERDICTS as readonly string[]).includes(candidate)) {
    return {
      ok: false,
      reason: `invalid FACTORY_REVIEW_VERDICT value "${candidate}"; must be one of ${LOOP_REVIEW_VERDICTS.join(", ")}`,
    };
  }

  return { ok: true, verdict: candidate as LoopReviewVerdict, findings };
}
