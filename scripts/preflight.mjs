#!/usr/bin/env node
/**
 * MUTATION PREFLIGHT — the cheap gate that must pass before the expensive run.
 *
 * Rounds 21 and 22 each spent more than three hours to end at the chain's
 * fail-closed gate, and every cause was a broken mutation DEFINITION rather
 * than a defect in the code under test: an anchor matching twice because it
 * also matched its own description, an anchor matching nothing after the code
 * it named was rewritten, and a weakened form that did not compile. This
 * establishes those facts in minutes.
 *
 * Deterministic and offline. No model is involved, and it never writes to the
 * repository: every mutation is applied inside a scratch copy.
 *
 * Exit 0 only when EVERY selected mutation is measurable. Anything else exits
 * non-zero with the reasons, and the chain refuses to start the full run.
 *
 * WHAT IT DOES NOT ESTABLISH, said here rather than left to be discovered:
 *
 *   - The killing-test check is a HEURISTIC. Test names are often built at run
 *     time — `it(`refuses ${directive}`)` — so a literal search called sound
 *     definitions stale, and matching the literal prefix before the first
 *     interpolation fixes that at the cost of accepting some names that no
 *     longer exist. A stale `expect` can therefore still reach the full run,
 *     where it surfaces as WRONG TEST. That remains the authoritative signal;
 *     this is a filter in front of it, not a replacement for it.
 *
 *   - `--no-compile` can never report VALID for a TypeScript target, by design:
 *     an unchecked build is an unknown, and an unknown is refused. The flag is
 *     for triaging anchors quickly, not for passing the gate.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MUTATIONS } from "./mutations.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFINITIONS = "scripts/mutations.mjs";

const { classifySelection, occurrences } = await import(
  `file://${join(REPO_ROOT, "dist/src/verification/mutationPreflight.js")}`
);

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : undefined;
const selected = only === undefined ? MUTATIONS : MUTATIONS.filter((m) => m.id.includes(only));

const read = (path) => {
  try {
    return readFileSync(join(REPO_ROOT, path), "utf8");
  } catch {
    return undefined;
  }
};

const definitionText = read(DEFINITIONS);

/** `dist/tests/x.test.js` names come from `tests/x.test.ts`. */
const sourceForCompiledTest = (compiled) =>
  compiled.replace(/^dist\//, "").replace(/\.js$/, ".ts");

/**
 * ONE SCRATCH COPY, REUSED. Copying the tree per mutation would cost more than
 * the run it protects; `node_modules` is symlinked rather than duplicated.
 */
const scratch = mkdtempSync(join(tmpdir(), "sf-preflight-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
for (const entry of ["scripts", "src", "tests", "docs", ".github", "tsconfig.json", "package.json"]) {
  if (existsSync(join(REPO_ROOT, entry))) {
    cpSync(join(REPO_ROOT, entry), join(scratch, entry), { recursive: true });
  }
}
execFileSync("ln", ["-s", join(REPO_ROOT, "node_modules"), join(scratch, "node_modules")]);

const typechecks = process.argv.includes("--no-compile") ? false : true;
let compileChecks = 0;

function buildsAfter(target, mutated) {
  const path = join(scratch, target);
  const original = readFileSync(path);
  writeFileSync(path, mutated);
  try {
    if (target.endsWith(".mjs") || target.endsWith(".js")) {
      execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
      return true;
    }
    if (!typechecks) return undefined;
    compileChecks += 1;
    execFileSync("npx", ["tsc", "-p", "tsconfig.json", "--noEmit"], { cwd: scratch, stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    writeFileSync(path, original);
  }
}

const facts = selected.map((mutation) => {
  /** Every mutation edits one file in this harness; the first edit names it. */
  const [target, from, to] = mutation.edits[0];
  const source = read(target);

  let changedBytes;
  let compiles;
  if (source !== undefined && occurrences(source, from) === 1) {
    const mutated = source.replace(from, to);
    changedBytes = mutated === source ? 0 : Math.max(1, Math.abs(mutated.length - source.length));
    compiles = buildsAfter(target, mutated);
  }

  const missingTests = mutation.tests.filter((artifact) => !existsSync(join(REPO_ROOT, artifact)));
  /**
   * A NAME MAY BE BUILT AT RUN TIME. `it(`refuses ${directive}`)` produces
   * names no source file contains literally, so a plain substring search called
   * sound definitions stale. The literal PREFIX before the first interpolation
   * is what the source does contain, and a name it could produce starts with
   * one of those.
   */
  const namedTestFound = mutation.tests.some((artifact) => {
    const text = read(sourceForCompiledTest(artifact));
    if (text === undefined) return false;
    if (text.includes(mutation.expect)) return true;
    for (const [, prefix] of text.matchAll(/\bit\(`([^`$]{4,})\$\{/g)) {
      if (mutation.expect.startsWith(prefix)) return true;
    }
    return false;
  });

  return {
    id: mutation.id,
    target,
    from,
    to,
    anchorOccurrences: source === undefined ? undefined : occurrences(source, from),
    selfReferentialOccurrences:
      target === DEFINITIONS && definitionText !== undefined ? occurrences(definitionText, from) : undefined,
    changedBytes,
    compiles,
    namedTests: mutation.tests,
    missingTests,
    namedTestFound,
    expect: mutation.expect,
  };
});

const { verdicts, ok, summary } = classifySelection(facts);

for (const verdict of verdicts) {
  if (verdict.result === "INVALID") {
    console.log(`INVALID  ${verdict.id}`);
    for (const reason of verdict.reasons) console.log(`         - ${reason}`);
  }
}
console.log(`${summary} (${compileChecks} type-checks)`);
process.exit(ok ? 0 : 1);
