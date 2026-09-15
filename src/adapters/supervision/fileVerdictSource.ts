/**
 * Reads an independent reviewer's verdict off the filesystem (TASK-018 Part B).
 *
 * The adapter half of `AcceptanceVerdictSource`: the domain knows that a review
 * reports SOMEWHERE and refuses to know more than that, and this is the
 * somewhere today's reviewer actually writes — a file, produced by a process
 * that has already exited by the time anything looks.
 *
 * Everything here fails towards "no verdict". A missing file, a directory, an
 * unreadable path, bytes that do not parse: each is reported as what it is, and
 * none of them can become an approval, because the only thing downstream does
 * with a non-verdict is schedule another review.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  parseAcceptanceVerdict,
  type AcceptanceVerdictSource,
  type ReviewBinding,
  type VerdictReading,
} from "../../supervision/acceptance.js";

/**
 * The most of a reviewer's output that is read.
 *
 * A verdict is a handful of tagged lines; anything beyond this is transcript.
 * Bounded because the path is read on EVERY tick, and an unbounded read of a
 * file something else is still appending to is how a supervisor loop turns into
 * a memory problem.
 */
const MAX_VERDICT_BYTES = 256 * 1024;

export function createFileVerdictSource(): AcceptanceVerdictSource {
  return {
    read(review: ReviewBinding): VerdictReading {
      const path = review.source;
      /**
       * RELATIVE PATHS ARE REFUSED, NOT RESOLVED.
       *
       * Resolving one would make the verdict depend on the supervisor's working
       * directory — so the same durable state would read a different file from a
       * different cwd, and "which review is this" would stop being a property of
       * the record. The launcher knows its absolute path; nothing here guesses.
       */
      if (!isAbsolute(path)) {
        return { kind: "NO_VERDICT", reason: `verdict source ${JSON.stringify(path)} is not an absolute path` };
      }

      let size: number;
      try {
        const stats = statSync(path);
        if (!stats.isFile()) {
          return { kind: "NO_VERDICT", reason: `verdict source ${JSON.stringify(path)} is not a regular file` };
        }
        size = stats.size;
      } catch (error) {
        // ENOENT is the ordinary case: the reviewer has not written yet.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { kind: "ABSENT" };
        }
        return {
          kind: "NO_VERDICT",
          reason: `verdict source ${JSON.stringify(path)} could not be read: ${(error as Error).message}`,
        };
      }

      if (size === 0) {
        // Created but not yet written: still absent, and still not a failure.
        return { kind: "ABSENT" };
      }
      if (size > MAX_VERDICT_BYTES) {
        return {
          kind: "NO_VERDICT",
          reason: `verdict source ${JSON.stringify(path)} is ${size} bytes, larger than a verdict can be`,
        };
      }

      try {
        return parseAcceptanceVerdict(readFileSync(path, "utf8"));
      } catch (error) {
        return {
          kind: "NO_VERDICT",
          reason: `verdict source ${JSON.stringify(path)} could not be read: ${(error as Error).message}`,
        };
      }
    },
  };
}
