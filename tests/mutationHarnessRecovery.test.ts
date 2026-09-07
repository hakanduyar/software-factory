/**
 * THE MUTATION HARNESS MUST NOT LEAVE A DISABLED GUARD BEHIND (TASK-017).
 *
 * `scripts/mutate.mjs` restores every edit in a `finally`, and a `finally` does
 * not run on a SIGKILL. That has corrupted evidence twice in this task, both
 * times silently:
 *
 *   - a run of mine was killed and left `} else if (false) {` in
 *     `scripts/verify.mjs`, disabling the required-module compilation clause,
 *     with `npm test` passing green over it;
 *   - a run inside an independent review was killed and left
 *     `const looksLikeRepository = false;` — which switches off the whole
 *     deliverable requirement — in the frozen candidate's worktree.
 *
 * Neither announced itself. A measurement harness whose failure mode is "the
 * tree now quietly proves less" is worse than none, because its output still
 * reads like evidence.
 *
 * These cases run the REAL `scripts/mutate.mjs` in a fixture directory. The
 * recovery check is the first thing in it that touches the filesystem, so the
 * harness exits before building anything and the cases cost milliseconds.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const created: string[] = [];

after(() => {
  for (const root of created) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A tree holding the real harness and one file it could have been mutating. */
function fixture(): { root: string; victim: string } {
  const root = mkdtempSync(join(tmpdir(), "sf-mutate-"));
  created.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(REPO_ROOT, "scripts/mutate.mjs"), join(root, "scripts/mutate.mjs"));
  const victim = join(root, "scripts/verify.mjs");
  writeFileSync(victim, 'const looksLikeRepository = existsSync(join(REPO_ROOT, ".git"));\n');
  return { root, victim };
}

function journal(root: string, files: Record<string, string>): void {
  writeFileSync(
    join(root, ".mutation-journal.json"),
    JSON.stringify({
      startedAt: new Date().toISOString(),
      files: Object.fromEntries(
        Object.entries(files).map(([path, content]) => [path, Buffer.from(content).toString("base64")]),
      ),
    }),
  );
}

function runHarness(root: string): { status: number; output: string } {
  const result = spawnSync(process.execPath, ["scripts/mutate.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("TASK-017: an interrupted mutation run cannot be mistaken for a measured one", () => {
  const ORIGINAL = 'const looksLikeRepository = existsSync(join(REPO_ROOT, ".git"));\n';

  /**
   * THE SECOND REAL INCIDENT, REPRODUCED. The review's own harness was killed
   * while this exact edit was applied, and the guard it disables is the one
   * that requires the deliverable to exist at all.
   */
  it("puts back a file a killed run left mutated, and refuses", () => {
    const { root, victim } = fixture();
    journal(root, { "scripts/verify.mjs": ORIGINAL });
    writeFileSync(victim, "const looksLikeRepository = false;\n");

    const { status, output } = runHarness(root);

    assert.notEqual(status, 0, `an interrupted run was allowed to continue:\n${output}`);
    assert.match(output, /interrupted before it could restore the tree/, output);
    assert.match(output, /scripts\/verify\.mjs/, `the repair did not name the file it put back:\n${output}`);
    assert.equal(readFileSync(victim, "utf8"), ORIGINAL, "the mutated file was not put back");
  });

  /**
   * REFUSING IS THE POINT, not repairing. A journal whose files happen to be
   * intact still means the previous run did not finish, and a number produced
   * after that is a number about a tree nobody checked.
   */
  it("refuses even when every recorded file is already intact", () => {
    const { root, victim } = fixture();
    journal(root, { "scripts/verify.mjs": ORIGINAL });

    const { status, output } = runHarness(root);

    assert.notEqual(status, 0, `an interrupted run with an intact tree was allowed to continue:\n${output}`);
    assert.match(output, /already intact/, output);
    assert.equal(readFileSync(victim, "utf8"), ORIGINAL, "an intact file was rewritten");
  });

  /** An unreadable journal is the same situation and must not be shrugged off. */
  it("refuses a journal it cannot read rather than assuming the tree is clean", () => {
    const { root } = fixture();
    writeFileSync(join(root, ".mutation-journal.json"), "{ this is not json");

    const { status, output } = runHarness(root);

    assert.notEqual(status, 0, `an unreadable journal was ignored:\n${output}`);
    assert.match(output, /does not hold a readable record/, output);
    assert.match(output, /Nothing was written/, output);
  });

  /**
   * NON-VACUITY, STRENGTHENED (round-19 review, non-blocking note 2).
   *
   * This used to assert only that two refusal messages were ABSENT, which an
   * unconditional refusal carrying a third message would have satisfied. It now
   * requires the run to reach the ownership file it creates for itself — proof
   * that it went past the recovery check rather than merely failing elsewhere.
   */
  it("does not refuse when no journal is present, and takes ownership instead", () => {
    const { root } = fixture();
    assert.equal(existsSync(join(root, ".mutation-journal.json")), false);

    const { output } = runHarness(root);

    assert.doesNotMatch(
      output,
      /interrupted before it could restore the tree|does not hold a readable record|is held by a running/,
      `a tree with no journal was treated as interrupted:\n${output}`,
    );
    assert.equal(
      existsSync(join(root, ".mutation-journal.json")),
      true,
      "the run never reached the point of claiming ownership, so this proves nothing about the recovery check",
    );
  });

  /**
   * ROUND-19 CRITICAL. The journal names the files to write, and it had no
   * containment: `../outside` put the recorded bytes into a file OUTSIDE the
   * repository. Nothing outside the tree may be written, and because the
   * journal is refused rather than acted on, it must survive untouched.
   */
  it("refuses a journal that names a path outside the repository", () => {
    const { root } = fixture();
    const outside = join(root, "..", `sf-outside-${process.pid}.txt`);
    writeFileSync(outside, "untouched\n");
    created.push(outside);
    journal(root, { [`../${basename(outside)}`]: "PWNED\n" });

    const { status, output } = runHarness(root);

    assert.notEqual(status, 0, `a path outside the repository was accepted:\n${output}`);
    assert.match(output, /not an ordinary file inside this repository/, output);
    assert.equal(readFileSync(outside, "utf8"), "untouched\n", "a file outside the repository was written");
    assert.equal(
      existsSync(join(root, ".mutation-journal.json")),
      true,
      "the journal was deleted even though nothing was restored",
    );
  });

  /** The same escape by a different route: an in-tree name, an external target. */
  it("refuses a recorded path that is a symlink", () => {
    const { root } = fixture();
    const outside = join(root, "..", `sf-linked-${process.pid}.txt`);
    writeFileSync(outside, "untouched\n");
    created.push(outside);
    symlinkSync(outside, join(root, "scripts/linked.mjs"));
    journal(root, { "scripts/linked.mjs": "PWNED\n" });

    const { status, output } = runHarness(root);

    assert.notEqual(status, 0, `a symlinked target was accepted:\n${output}`);
    assert.match(output, /not an ordinary file inside this repository/, output);
    assert.equal(readFileSync(outside, "utf8"), "untouched\n", "the symlink's target was written through");
  });

  /**
   * ROUND-19 HIGH 2. `Buffer.from(x, "base64")` decodes almost anything, so a
   * corrupt value was written over the real file — and the journal was then
   * deleted, destroying the only record of what had been touched.
   */
  it("refuses unreadable content without writing it, and keeps the journal", () => {
    const { root, victim } = fixture();
    const before = readFileSync(victim, "utf8");
    writeFileSync(
      join(root, ".mutation-journal.json"),
      JSON.stringify({ owner: 1, startedAt: "x", files: { "scripts/verify.mjs": "%%%not-base64%%%" } }),
    );

    const { status, output } = runHarness(root);

    assert.notEqual(status, 0, `undecodable content was accepted:\n${output}`);
    assert.match(output, /records unreadable content/, output);
    assert.equal(readFileSync(victim, "utf8"), before, "the victim file was overwritten with corrupt bytes");
    assert.equal(existsSync(join(root, ".mutation-journal.json")), true, "the journal was deleted after refusing");
  });

  /** `typeof [] === "object"`, which the first schema check accepted. */
  it("refuses a journal whose files are an array rather than a record", () => {
    const { root } = fixture();
    writeFileSync(
      join(root, ".mutation-journal.json"),
      JSON.stringify({ owner: 1, startedAt: "x", files: [] }),
    );

    const { status, output } = runHarness(root);

    assert.notEqual(status, 0, `files: [] was accepted as a record:\n${output}`);
    assert.match(output, /does not hold a readable record/, output);
  });

  /**
   * ROUND-19 HIGH 3. Two runs started at once both passed a plain existsSync
   * check and mutated the same files, reporting UNMEASURED and SURVIVED while
   * both printed restored-tree success lines. Ownership is now taken with an
   * atomic create, so a live owner is refused.
   */
  it("refuses to start while a live process owns the journal", () => {
    const { root } = fixture();
    writeFileSync(
      join(root, ".mutation-journal.json"),
      JSON.stringify({ owner: process.pid, startedAt: "x", files: {} }),
    );

    const { status, output } = runHarness(root);

    assert.notEqual(status, 0, `a second concurrent run was allowed to start:\n${output}`);
    assert.match(output, new RegExp(`held by a running mutation process \\(pid ${process.pid}\\)`), output);
    assert.equal(existsSync(join(root, ".mutation-journal.json")), true, "the live owner's journal was removed");
  });

  /**
   * A run killed BEFORE it recorded anything mutated nothing, so there is
   * nothing to put back — but it still refuses, and clears its own stale
   * ownership so the next invocation is not blocked forever.
   */
  it("clears stale ownership from a dead process, and still refuses", () => {
    const { root } = fixture();
    writeFileSync(
      join(root, ".mutation-journal.json"),
      JSON.stringify({ owner: 2147483646, startedAt: "x", files: {} }),
    );

    const { status, output } = runHarness(root);

    assert.notEqual(status, 0, `a stale ownership file was treated as runnable:\n${output}`);
    assert.match(output, /interrupted before it recorded anything/, output);
  });
});
