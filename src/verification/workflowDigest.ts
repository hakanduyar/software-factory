/**
 * The digest of the workflow that was REVIEWED (TASK-017).
 *
 * WHAT THIS IS FOR, EXACTLY. `workflowPolicy.ts` proves things about the
 * workflow by reading it, so it holds whatever the file says at the moment it
 * runs. That is the right design — a check that read a stale copy would be
 * describing a file that is not the one GitHub runs — but it means the policy
 * alone cannot tell you the file CHANGED. A workflow edited into a different
 * still-compliant shape passes every policy and is not the artifact anybody
 * reviewed.
 *
 * So this records the bytes an independent reviewer actually saw, and a test
 * compares them. Drift between "what was reviewed" and "what ships" then shows
 * up as a failing test rather than as nothing at all.
 *
 * WHAT THIS IS NOT, and the distinction matters more than the mechanism:
 *
 *   IT IS NOT A SECURITY CONTROL. Anyone who can edit the workflow can edit
 *   this constant in the same commit, and the test will pass. It cannot be
 *   otherwise: both files are in the same repository under the same write
 *   access, so this can only ever be as trustworthy as the review of the diff
 *   that changed them. Its whole value is that the change becomes VISIBLE —
 *   a two-file diff a reviewer can see — rather than silent.
 *
 *   IT IS NOT WHAT MAKES THE ACCEPTANCE CRITERIA TRUE. The criteria are about
 *   what the workflow DOES, and a digest says nothing about behaviour: this
 *   constant would be equally satisfied by a workflow that verifies nothing.
 *   The policy checks are load-bearing for the criteria and this is not, which
 *   is why it lives in its own module with its own test and why no acceptance
 *   assertion reads it.
 *
 * That division is deliberate. A digest is cheap to add and easy to mistake for
 * proof, and this task has already produced five KNOWN-LIMITATIONS entries that
 * credited a mechanism with more than it delivered.
 */

import { createHash } from "node:crypto";

/**
 * `.github/workflows/verify.yml`, as reviewed.
 *
 * Updated for round-9 HIGH 1, which added `persist-credentials: "false"`. The
 * constant moves in the SAME COMMIT as the workflow, which is the only
 * discipline that makes it mean anything — and is exactly why this is a
 * visibility property rather than a security one.
 */
export const REVIEWED_WORKFLOW_SHA256 =
  "6b15d37f4e5f929892f04987765c9b726296debf2aea1b726f2b222c786242a5";

/** Its length in bytes, so a digest typo and a content change look different. */
export const REVIEWED_WORKFLOW_BYTES = 2718;

export function digestOf(source: string | Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}
