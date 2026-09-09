#!/usr/bin/env node
/**
 * The mutation harness, checked in so its results can be REPLAYED.
 *
 * WHY THIS EXISTS. Every task in this repository reports "N of N mutations
 * killed, zero survivors", and until now that number arrived in a commit
 * message from a harness that lived in a scratch directory. The TASK-017
 * round-4 reviewer put it plainly: the claim "cannot be independently replayed
 * from repository contents". That is a fair objection to evidence, and the
 * answer is not a better-worded claim — it is a harness anyone can run.
 *
 * WHAT IT DOES. For each mutation: apply it to the working tree, REBUILD, run
 * the named tests, and record whether the intended test failed BY NAME. Then
 * restore the file and verify it matches its run-start SHA-256 byte for byte.
 * Any mismatch aborts immediately rather than continuing against a tree that is
 * no longer the one being measured.
 *
 * THE THREE OUTCOMES, and why they are distinguished:
 *
 *   KILLED      the mutation compiled AND the named test failed. Only this
 *               counts as a guard being load-bearing.
 *   SURVIVED    it compiled and nothing failed. A guard nothing can tell from
 *               its absence.
 *   UNMEASURED  it did not compile, or its anchor was not found exactly once.
 *               NOT a pass. Reported separately because the failure mode this
 *               harness exists to prevent is counting an unmeasured mutation as
 *               a killed one — which happened repeatedly before the distinction
 *               was made explicit.
 *
 * WRONG TEST is reported too: something failed, but not the test the mutation
 * was aimed at. That is a real finding — usually a sibling guard masking the
 * one under test — and it is not a kill.
 *
 * Usage: `node scripts/mutate.mjs [--only <substring>]`
 * Requires a built tree; it rebuilds as it goes.
 */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  constants as FS,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

import {
  MUTATIONS,
  POLICY,
  WORKFLOW,
  VERIFIER,
  DOCUMENT,
  DIGEST,
  MANIFEST,
  LIMITS,
  FINANCIAL,
  BINDING,
  T_WF,
  T_HON,
  T_PUSH,
  T_BIND,
  T_DIG,
  T_E2E,
  T_REC,
  T_WS,
  WORKSPACE,
  VERIFIER_MUT,
} from "./mutations.mjs";


/**
 * Each mutation names the guard it removes and the test that must notice.
 *
 * `expect` is a SUBSTRING OF A TEST NAME, not of an assertion message: the
 * question is which test failed, and matching messages let a mutation look
 * killed because some other case happened to mention the same words.
 */

function sha256(path) {
  return createHash("sha256").update(readFileSync(join(REPO_ROOT, path))).digest("hex");
}

function build() {
  const result = spawnSync("./node_modules/.bin/tsc", ["-p", "tsconfig.json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function runTests(files) {
  const result = spawnSync("node", ["--test", ...files], { cwd: REPO_ROOT, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const failed = output
    .split("\n")
    .filter((line) => line.trim().startsWith("not ok "))
    .map((line) => line.trim().slice("not ok ".length));
  const count = (label) => {
    const match = new RegExp(`^# ${label} (\\d+)$`, "m").exec(output);
    return match === null ? -1 : Number(match[1]);
  };
  return { pass: count("pass"), fail: count("fail"), failed };
}

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : undefined;
const selected = only === undefined ? MUTATIONS : MUTATIONS.filter((m) => m.id.includes(only));

/**
 * AN EMPTY SELECTION MEASURES NOTHING (round-19 review, non-blocking note).
 *
 * `--only <something that matches nothing>` ran zero mutations and still
 * printed a summary. It failed closed in this checkout only because the
 * baseline test set was then empty and the run collapsed elsewhere, which is
 * luck rather than a guard.
 */
if (selected.length === 0) {
  console.error(
    `ABORT: no mutation matches ${JSON.stringify(only)}. A run that measures nothing must not report a result.`,
  );
  process.exit(2);
}

const touched = [...new Set(selected.flatMap((m) => m.edits.map(([file]) => file)))].sort();

/**
 * AN INTERRUPTED RUN MUST NOT LEAVE A DISABLED GUARD BEHIND.
 *
 * Every mutation is restored in a `finally`, and a `finally` does not run on a
 * SIGKILL. This has now corrupted evidence twice, and both times silently:
 *
 *   - a run of mine was killed mid-flight and left `} else if (false) {` in
 *     `scripts/verify.mjs`, disabling the required-module compilation clause.
 *     `npm test` then passed green over it.
 *   - a run inside an INDEPENDENT REVIEW was killed and left
 *     `const looksLikeRepository = false;`, which disables the entire
 *     deliverable requirement, in the frozen review candidate's worktree.
 *
 * Both were found by looking. Nothing made them announce themselves, and a
 * measurement harness whose failure mode is "the tree now silently proves less"
 * is worse than no harness, because its output still reads like evidence.
 *
 * So the restore data is written to disk BEFORE the first edit and removed only
 * after the last one is undone. A journal found at startup means the previous
 * run did not finish: the recorded bytes are put back and this run REFUSES.
 * It refuses rather than continuing because an interrupted run is exactly the
 * situation in which nobody should be told a number.
 */
const JOURNAL = join(REPO_ROOT, ".mutation-journal.json");

/**
 * THE JOURNAL IS ALSO THE LOCK (round-19 review, HIGH 3).
 *
 * Two runs started at once both passed a plain `existsSync` check, mutated the
 * same files, and reported `UNMEASURED` and `SURVIVED` respectively — while both
 * printed restored-tree success lines. Neither number meant anything, and a
 * killed peer would have been left with no recovery coverage at all.
 *
 * Ownership is therefore taken with `openSync(..., "wx")`, which creates the
 * file or fails, atomically, with no window between the test and the create. It
 * is claimed HERE, before the baseline build, because that build takes minutes
 * and is exactly the window the reviewer drove two runs through.
 */
const ROOT_REAL = realpathSync(REPO_ROOT);
/** A bind mount over an in-tree file changes this, which is how it is caught. */
const ROOT_DEV = statSync(ROOT_REAL).dev;

/** A recorded path this run is willing to write. Everything else refuses. */
function containedTarget(file) {
  if (typeof file !== "string" || file.length === 0 || file.includes("\0")) return undefined;
  if (isAbsolute(file)) return undefined;
  const normalised = normalize(file);
  if (normalised !== file) return undefined;
  if (normalised === ".." || normalised.startsWith("../")) return undefined;

  const target = join(REPO_ROOT, normalised);
  const rel = relative(ROOT_REAL, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;

  /**
   * THE PATH MUST NOT LEAD OUT THROUGH A LINK. `../outside` was the reviewer's
   * first reproduction and an in-repository SYMLINK was the second: the name
   * stayed inside the tree and the bytes landed on its external target. So the
   * containing directory is resolved, and the entry itself must be an ordinary
   * file if it exists at all — never a symlink, directory, FIFO or device.
   */
  let parentReal;
  try {
    parentReal = realpathSync(dirname(target));
  } catch {
    return undefined;
  }
  const parentRel = relative(ROOT_REAL, parentReal);
  if (parentRel.startsWith("..") || isAbsolute(parentRel)) return undefined;

  /**
   * `lstat`, NOT `existsSync` (round-21 review, CRITICAL 2).
   *
   * A DANGLING symlink is not "absent": `existsSync` follows it and reports
   * false, so the whole check below was skipped, and the write then followed
   * the link and created a file outside the repository. `lstat` describes the
   * link itself and is therefore the right question.
   */
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    stats = undefined;
  }
  if (stats !== undefined) {
    if (!stats.isFile()) return undefined;

    /**
     * A HARDLINK IS A SECOND NAME FOR SOMEBODY ELSE'S FILE (round-20 CRITICAL).
     *
     * `lstat` reports a hardlink as an ordinary regular file, because that is
     * what it is — the escape is that the INODE may also be named outside this
     * repository, and a write follows the inode, not the name. The reviewer
     * linked an external file into the tree and the recovery path wrote
     * straight through it.
     *
     * There is no way to ask "is this inode also named elsewhere?" without
     * walking the filesystem, so the link count answers instead: a file this
     * harness recorded is a file it read from the repository, and that has
     * exactly one name. More than one is refused rather than investigated.
     *
     * It closes the round-20 HIGH about conflicting entries too: two in-tree
     * names for one inode cannot both be recorded if neither can be recorded.
     */
    if (stats.nlink !== 1) return undefined;
  }

  /**
   * RESOLVED, SO TWO NAMES FOR ONE FILE ARE ONE NAME (round-20 remediation,
   * found by a surviving mutation).
   *
   * The duplicate check below compared the JOINED paths, which made it blind to
   * aliases: with a symlinked directory, `scripts/verify.mjs` and
   * `linkdir/verify.mjs` pass every containment test above, name the same file,
   * and compared unequal — so both were written, in order, and the last one
   * won. Returning the path through the RESOLVED parent collapses the alias
   * here, so there is one identity per file and the duplicate check sees it.
   *
   * The first fixture for this missed it, because it used `./scripts/verify.mjs`
   * as the second name — which the normalisation check above rejects first. The
   * mutation survived, and the survivor was the finding.
   */
  return join(parentReal, basename(normalised));
}

/** Strictly base64, verified by round-trip rather than by `Buffer`'s tolerance. */
function decodeStrictBase64(encoded) {
  if (typeof encoded !== "string") return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  return bytes.toString("base64") === encoded ? bytes : undefined;
}

function refuseJournal(reason) {
  console.error(
    `ABORT: ${JOURNAL} ${reason}\n` +
      "Nothing was written. A journal this run cannot fully trust is not a journal it may act on, and an " +
      "interrupted run must never be mistaken for a measured one.",
  );
  process.exit(2);
}

let ownership;
try {
  ownership = openSync(JOURNAL, "wx");
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  ownership = undefined;
}

if (ownership === undefined) {
  let saved;
  try {
    saved = JSON.parse(readFileSync(JOURNAL, "utf8"));
  } catch {
    saved = undefined;
  }
  if (
    saved === null ||
    typeof saved !== "object" ||
    Array.isArray(saved) ||
    typeof saved.files !== "object" ||
    saved.files === null ||
    Array.isArray(saved.files)
  ) {
    refuseJournal("exists but does not hold a readable record of what a previous run touched.");
  }

  const entries = Object.entries(saved.files);

  /**
   * IS THE OWNER STILL ALIVE? ASKED FIRST, AND FOR EVERY JOURNAL (round-20
   * review, HIGH 3).
   *
   * This check used to sit inside the `entries.length === 0` branch, so it only
   * ever ran for a journal that had recorded nothing. The moment a real run
   * populated its journal — which is the whole of its working life — a second
   * process skipped the liveness question entirely, restored the FIRST run's
   * files underneath it and deleted its journal. The reviewer reproduced it and
   * the victim reported a false `SURVIVED`.
   *
   * A live owner means a concurrent run, never a crash, so nothing is touched
   * and nothing is removed.
   */
  const owner = typeof saved.owner === "number" ? saved.owner : undefined;
  let ownerAlive = false;
  if (owner !== undefined) {
    try {
      process.kill(owner, 0);
      ownerAlive = true;
    } catch {
      ownerAlive = false;
    }
  }
  if (ownerAlive) {
    refuseJournal(`is held by a running mutation process (pid ${owner}). Only one run may own this repository.`);
  }

  if (entries.length === 0) {
    rmSync(JOURNAL, { force: true });
    console.error(
      "ABORT: a previous mutation run was interrupted before it recorded anything, so nothing was mutated.\n" +
        "Its ownership file has been cleared. Run again to measure.",
    );
    process.exit(2);
  }

  /**
   * VALIDATE EVERY ENTRY BEFORE WRITING ANY (round-19 CRITICAL, and HIGH 2).
   *
   * The first version validated nothing and wrote as it went, so a journal
   * naming `../outside` modified a file outside the repository, and a value of
   * `%%%not-base64%%%` was decoded by `Buffer`'s tolerant parser and written
   * over the real one — after which the journal was deleted, destroying the
   * only record of what had been touched. Two phases, and the second only runs
   * if the first accepted everything.
   */
  const plan = [];
  const claimed = new Set();
  for (const [file, encoded] of entries) {
    const target = containedTarget(file);
    if (target !== undefined) {
      /**
       * ONE RECORD PER FILE (round-20 review, HIGH 4). Two names for one file
       * with different recorded bytes are a contradiction, and acting on it
       * wrote both values in turn and then reported success.
       */
      if (claimed.has(target)) {
        refuseJournal(`records ${JSON.stringify(file)} more than once, with no single original to put back.`);
      }
      claimed.add(target);
    }
    if (target === undefined) {
      refuseJournal(`records ${JSON.stringify(file)}, which is not an ordinary file inside this repository.`);
    }
    const original = decodeStrictBase64(encoded);
    if (original === undefined) {
      refuseJournal(`records unreadable content for ${JSON.stringify(file)}.`);
    }
    plan.push([file, target, original]);
  }

  const repaired = [];
  for (const [file, target, original] of plan) {
    let current;
    try {
      current = readFileSync(target);
    } catch {
      current = undefined;
    }
    if (current === undefined || !current.equals(original)) {
      /**
       * VALIDATED AGAIN AT THE MOMENT OF WRITING (round-21 review, CRITICAL 2).
       *
       * Every check above describes a NAME, and a name can stop meaning what it
       * meant. The reviewer showed three ways: a dangling symlink the existence
       * check skipped, a bind mount over an in-tree file that satisfies
       * `realpath`, `lstat` and `nlink` while pointing elsewhere, and a plain
       * TOCTOU swap between validation and write.
       *
       * So the write goes through a descriptor opened with `O_NOFOLLOW` — which
       * refuses outright if the final component became a link — and the
       * DESCRIPTOR is then interrogated: same device as the repository root,
       * still an ordinary file, still one name. A bind mount changes the
       * device; that is what catches it. Nothing is truncated until all of that
       * holds, so a refusal here costs the file nothing.
       */
      let fd;
      try {
        fd = openSync(target, FS.O_WRONLY | FS.O_CREAT | FS.O_NOFOLLOW, 0o644);
      } catch (error) {
        refuseJournal(
          `records ${JSON.stringify(file)}, which could not be opened as an ordinary file ` +
            `(${error?.code ?? "unknown"}).`,
        );
      }
      /**
       * THE OPENED FILE NAMES ITSELF (round-22 review, CRITICAL 3).
       *
       * `O_NOFOLLOW` protects only the FINAL component. The reviewer swapped a
       * validated PARENT for a symlink or a same-device bind mount between
       * `realpathSync(dirname(target))` and the open, and the descriptor then
       * passed the device, type and link-count checks while pointing outside
       * the repository.
       *
       * Every one of those checks describes a name resolved separately from the
       * open. `/proc/self/fd/N` does not: it resolves the file THIS descriptor
       * actually refers to, so there is no second resolution to race. If that
       * path is not inside the repository, the swap happened and this refuses.
       */
      let openedPath;
      try {
        openedPath = realpathSync(`/proc/self/fd/${fd}`);
      } catch {
        openedPath = undefined;
      }
      const openedRel = openedPath === undefined ? ".." : relative(ROOT_REAL, openedPath);
      const opened = fstatSync(fd);
      if (
        openedPath === undefined ||
        openedRel === "" ||
        openedRel.startsWith("..") ||
        isAbsolute(openedRel) ||
        opened.dev !== ROOT_DEV ||
        !opened.isFile() ||
        opened.nlink !== 1
      ) {
        closeSync(fd);
        refuseJournal(
          `records ${JSON.stringify(file)}, which is not the ordinary in-repository file it claimed to be ` +
            `at the moment of writing (the descriptor resolves to ${JSON.stringify(openedPath ?? "nothing")}).`,
        );
      }
      ftruncateSync(fd, 0);
      writeSync(fd, original, 0, original.length, 0);
      closeSync(fd);
      repaired.push(file);
    }
  }

  /** Removed only now: every recorded file has been put back. */
  rmSync(JOURNAL, { force: true });
  console.error(
    "ABORT: a previous mutation run was interrupted before it could restore the tree.\n" +
      (repaired.length > 0
        ? `Put back from the journal: ${repaired.join(", ")}.\n`
        : "Every recorded file was already intact.\n") +
      "Run again to measure. This run refuses so an interrupted run can never be mistaken for a measured one.",
  );
  process.exit(2);
}

/** Ownership is held from here on; the contents arrive after the baseline. */
writeFileSync(ownership, JSON.stringify({ owner: process.pid, startedAt: new Date().toISOString(), files: {} }));
closeSync(ownership);

const baseline = new Map(touched.map((file) => [file, readFileSync(join(REPO_ROOT, file))]));
const hashes = new Map(touched.map((file) => [file, sha256(file)]));
for (const file of touched) {
  console.log(`baseline ${file}: ${hashes.get(file).slice(0, 16)}`);
}

const first = build();
if (!first.ok) {
  console.error("BASELINE BUILD FAILED\n" + first.output.slice(0, 800));
  process.exit(1);
}
const allTests = [...new Set(selected.flatMap((m) => m.tests))];
const start = runTests(allTests);
console.log(`baseline: pass=${start.pass} fail=${start.fail}`);
if (start.fail !== 0) {
  console.error("BASELINE NOT GREEN");
  process.exit(1);
}

/**
 * Written only now: everything above can still exit without having touched a
 * file, and a journal left by a run that mutated nothing would refuse the next
 * one for no reason.
 */
writeFileSync(
  JOURNAL,
  JSON.stringify(
    {
      owner: process.pid,
      startedAt: new Date().toISOString(),
      note: "A previous mutation run was interrupted. scripts/mutate.mjs restores these on its next start.",
      files: Object.fromEntries([...baseline].map(([file, bytes]) => [file, bytes.toString("base64")])),
    },
    null,
    2,
  ),
);

const results = [];
for (const mutation of selected) {
  let applied = true;
  try {
    for (const [file, from, to] of mutation.edits) {
      const path = join(REPO_ROOT, file);
      const text = readFileSync(path, "utf8");
      const occurrences = text.split(from).length - 1;
      if (occurrences !== 1) {
        console.log(`${mutation.id}: UNMEASURED (anchor x${occurrences})`);
        results.push([mutation.id, "UNMEASURED"]);
        applied = false;
        break;
      }
      writeFileSync(path, text.replace(from, to));
    }
    if (applied) {
      const built = build();
      if (!built.ok) {
        console.log(`${mutation.id}: UNMEASURED (does not compile)`);
        for (const line of built.output.split("\n").filter((l) => l.includes(": error TS")).slice(0, 2)) {
          console.log(`      ${line}`);
        }
        results.push([mutation.id, "UNMEASURED"]);
      } else {
        const run = runTests(mutation.tests);
        const hit = run.failed.filter((name) => name.includes(mutation.expect));
        if (run.fail > 0 && hit.length > 0) {
          console.log(`${mutation.id}: KILLED (${hit[0]})`);
          results.push([mutation.id, "KILLED"]);
        } else if (run.fail > 0) {
          console.log(`${mutation.id}: WRONG TEST -> ${run.failed.slice(0, 2).join(" | ")}`);
          results.push([mutation.id, "WRONG TEST"]);
        } else {
          console.log(`${mutation.id}: *** SURVIVED *** pass=${run.pass}`);
          results.push([mutation.id, "SURVIVED"]);
        }
      }
    }
  } finally {
    for (const [file] of mutation.edits) {
      writeFileSync(join(REPO_ROOT, file), baseline.get(file));
    }
    for (const [file] of mutation.edits) {
      if (sha256(file) !== hashes.get(file)) {
        console.error(`ABORT: ${file} did not restore to its baseline hash`);
        process.exit(2);
      }
    }
  }
}

/**
 * OWNERSHIP IS KEPT UNTIL THE CLOSING EVIDENCE IS IN (round-21 review, HIGH 1).
 *
 * This used to delete the journal here, before the restored build, the full
 * test run and the final byte checks — so a second run could start during that
 * window and mutate the same files underneath the first. The reviewer drove
 * exactly that race.
 *
 * The entries are cleared, because nothing is outstanding once every `finally`
 * has run and there is nothing left to put back. The OWNERSHIP stays, so a
 * concurrent run still refuses; and if this process dies during the closing
 * checks, the next run finds an empty journal with a dead owner, clears it and
 * refuses — which is the correct outcome for a run that never finished.
 */
writeFileSync(JOURNAL, JSON.stringify({ owner: process.pid, startedAt: new Date().toISOString(), files: {} }));

const restored = build();
if (!restored.ok) {
  console.error("ABORT: restored tree does not compile");
  process.exit(2);
}
const end = runTests(allTests);
console.log(`restored: pass=${end.pass} fail=${end.fail}`);

for (const file of touched) {
  if (sha256(file) !== hashes.get(file)) {
    console.error(`ABORT: ${file} final hash differs`);
    process.exit(2);
  }
}

/**
 * OWNERSHIP OUTLIVES THE LAST CHECK (round-22 review, HIGH 4).
 *
 * The journal was removed before this loop, so a second run could take the lock
 * during the final byte verification; killing the first process then left
 * incomplete closing evidence with nobody owning it. It is released here, after
 * the last thing that can fail.
 */
rmSync(JOURNAL, { force: true });
console.log("all touched files verified byte-for-byte against the run-start baseline");

const bad = results.filter(([, outcome]) => outcome !== "KILLED");
console.log(`SURVIVORS/UNMEASURED: ${bad.length === 0 ? "none" : JSON.stringify(bad.map(([id]) => id))}`);
process.exit(bad.length === 0 && end.fail === 0 ? 0 : 1);
