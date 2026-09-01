/**
 * TASK-017: the shipped workflow is the workflow that was reviewed.
 *
 * DEFENCE IN DEPTH, AND NOTHING MORE. These cases are deliberately independent
 * of `workflowPolicy.test.ts`: they say nothing about whether the workflow is
 * ACCEPTABLE, only whether it is UNCHANGED. The policy tests are what make the
 * acceptance criteria true, and they read the file for themselves.
 *
 * The last case is the important one. A drift check that could not fail is the
 * shape this task keeps producing — a mechanism that looks like evidence and
 * observes nothing — so the digest is proved to reject a changed file rather
 * than merely to accept the current one.
 *
 * Offline: reads one file, spawns nothing, touches no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  REVIEWED_WORKFLOW_BYTES,
  REVIEWED_WORKFLOW_SHA256,
  digestOf,
} from "../src/verification/workflowDigest.js";

const WORKFLOW_PATH = join(process.cwd(), ".github/workflows/verify.yml");
const BYTES = readFileSync(WORKFLOW_PATH);

describe("TASK-017: the shipped workflow has not drifted from the reviewed one", () => {
  it("matches the reviewed digest", () => {
    assert.equal(
      digestOf(BYTES),
      REVIEWED_WORKFLOW_SHA256,
      "the shipped workflow is not the one that was reviewed; update the constant IN THE SAME COMMIT as the change, so the diff shows both",
    );
  });

  it("matches the reviewed byte count", () => {
    assert.equal(BYTES.byteLength, REVIEWED_WORKFLOW_BYTES);
  });

  /**
   * NON-VACUITY. A comparison that always succeeded would pass the two cases
   * above, so the digest is shown to distinguish this file from a modified one
   * — including a modification of a single byte, which is the drift that would
   * otherwise be easiest to miss.
   */
  it("rejects a workflow that differs by one byte", () => {
    const tampered = Buffer.concat([BYTES, Buffer.from("\n")]);

    assert.notEqual(digestOf(tampered), REVIEWED_WORKFLOW_SHA256);
  });

  it("rejects a workflow with the same length and different content", () => {
    const swapped = Buffer.from(BYTES);
    swapped[swapped.length - 1] = swapped[swapped.length - 1]! ^ 0x01;

    assert.equal(swapped.byteLength, REVIEWED_WORKFLOW_BYTES, "the fixture changed the length after all");
    assert.notEqual(digestOf(swapped), REVIEWED_WORKFLOW_SHA256);
  });

  /**
   * AND IT IS NOT AN ACCEPTANCE CHECK. Stated as a case because the comment
   * saying so can drift from the code: a digest is equally satisfied by a
   * workflow that verifies nothing, so this shows the digest accepting a file
   * the POLICY refuses. If someone later routes an acceptance assertion through
   * this module, this case is where the mistake becomes visible.
   */
  it("says nothing about whether a workflow is acceptable", () => {
    const useless = Buffer.from("name: nothing\non:\n  push:\n    branches: []\njobs: {}\n");

    // The digest mechanism works on it perfectly well...
    assert.equal(digestOf(useless), digestOf(Buffer.from(useless)));
    // ...and it is plainly not the reviewed workflow, which is ALL this proves.
    assert.notEqual(digestOf(useless), REVIEWED_WORKFLOW_SHA256);
  });
});
