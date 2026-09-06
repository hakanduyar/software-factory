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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    assert.match(output, /cannot be read/, output);
  });

  /**
   * NON-VACUITY. Without this, "refuse whenever the file exists" would satisfy
   * every case above — including refusing every ordinary run.
   */
  it("does not refuse when no journal is present", () => {
    const { root } = fixture();
    assert.equal(existsSync(join(root, ".mutation-journal.json")), false);

    const { output } = runHarness(root);

    assert.doesNotMatch(
      output,
      /interrupted before it could restore the tree|cannot be read/,
      `a tree with no journal was treated as interrupted:\n${output}`,
    );
  });
});
