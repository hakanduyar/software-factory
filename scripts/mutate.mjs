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
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const POLICY = "src/verification/workflowPolicy.ts";
const WORKFLOW = ".github/workflows/verify.yml";
const VERIFIER = "scripts/verify.mjs";
const LIMITS = "docs/KNOWN-LIMITATIONS.md";
const FINANCIAL = "src/supervision/financialSafety.ts";
const BINDING = "src/github/candidateBinding.ts";

const T_WF = "dist/tests/workflowPolicy.test.js";
const T_HON = "dist/tests/knownLimitationsHonesty.test.js";
const T_PUSH = "dist/tests/pushAuthorization.test.js";
const T_BIND = "dist/tests/candidateBinding.test.js";

/**
 * Each mutation names the guard it removes and the test that must notice.
 *
 * `expect` is a SUBSTRING OF A TEST NAME, not of an assertion message: the
 * question is which test failed, and matching messages let a mutation look
 * killed because some other case happened to mention the same words.
 */
const MUTATIONS = [
  // ---- AC-1: only runners this repository knows to be unmetered -------------
  {
    id: "runner allowlist becomes a denylist",
    edits: [[POLICY,
      "    if (!FREE_RUNNER_LABELS.includes(runsOn)) {",
      '    if (runsOn.includes("8-cores") || runsOn.includes("64-core")) {']],
    tests: [T_WF],
    expect: "runner label nobody has heard of",
  },
  {
    id: "the SHIPPED workflow asks for a larger runner",
    edits: [[WORKFLOW, "    runs-on: ubuntu-latest", "    runs-on: ubuntu-latest-8-cores"]],
    tests: [T_WF],
    expect: "accepts the shipped workflow's runner",
  },
  // ---- AC-2: the Node pin is bound to engines, and to setup-node ------------
  {
    id: "the pin is not compared with the engines floor",
    edits: [[POLICY, "      if (actual[index]! < required[index]!) {", "      if (false as boolean) {"]],
    tests: [T_WF],
    expect: "refuses a pin below the engines floor",
  },
  {
    id: "a node-version on any action counts as the pin",
    edits: [[POLICY,
      "    .filter((step) => step.uses !== undefined && /^actions\\/setup-node@/.test(step.uses))\n",
      ""]],
    tests: [T_WF],
    expect: "node-version carried by an unrelated action",
  },
  {
    id: "the SHIPPED workflow pins a Node below the engines floor",
    edits: [[WORKFLOW, '          node-version: "22.5.0"', '          node-version: "20.0.0"']],
    tests: [T_WF],
    expect: "accepts the shipped pin against the real engines range",
  },
  // ---- AC-3/AC-4: what actually runs ---------------------------------------
  {
    id: "a condition on a step is ignored",
    edits: [[POLICY,
      '    (step) => step.condition === undefined && step.continueOnError !== "true",',
      "    () => true,"]],
    tests: [T_WF],
    expect: "condition prevents from running",
  },
  {
    id: "continue-on-error no longer disqualifies a step",
    edits: [[POLICY,
      '    (step) => step.condition === undefined && step.continueOnError !== "true",',
      "    (step) => step.condition === undefined,"]],
    tests: [T_WF],
    expect: "failure would not fail the job",
  },
  {
    id: "the SHIPPED workflow skips its verification with a condition",
    edits: [[WORKFLOW, "      - run: npm test", "      - run: npm test\n        if: ${{ false }}"]],
    tests: [T_WF],
    expect: "accepts the shipped workflow's verification command",
  },
  {
    id: "the run allowlist is dropped",
    edits: [[POLICY,
      "    if (!ALLOWED_RUN_COMMANDS.includes(command.trim())) {",
      "    void command;\n    void ALLOWED_RUN_COMMANDS;\n    if (false as boolean) {"]],
    tests: [T_WF],
    expect: "command npm install",
  },
  {
    id: "only the long spelling of npm install is refused",
    edits: [[POLICY,
      '  "install", "i", "in", "ins", "inst", "insta", "instal",\n  "isnta", "isntal", "isntall", "add",',
      '  "install",']],
    tests: [T_WF],
    expect: "refuses npm i",
  },
  // ---- AC-5: the events that actually occur --------------------------------
  {
    id: "pull_request types are ignored",
    edits: [[POLICY,
      "          for (const required of REQUIRED_PR_TYPES) {",
      "          void REQUIRED_PR_TYPES;\n          for (const required of [] as readonly string[]) {"]],
    tests: [T_WF],
    expect: "pull_request narrowed to closed",
  },
  {
    id: "a negative branch pattern is accepted",
    edits: [[POLICY, "        if (excluded.length > 0) {", "        if (false as boolean) {"]],
    tests: [T_WF],
    expect: "negative branch pattern",
  },
  {
    id: "the event key allowlist is dropped, so paths-ignore returns",
    edits: [[POLICY,
      "      if (!ALLOWED_EVENT_KEYS.includes(key)) {",
      "      void key;\n      void ALLOWED_EVENT_KEYS;\n      if (false as boolean) {"]],
    tests: [T_WF],
    expect: "paths-ignore",
  },
  // ---- AC-6: immutable pins -------------------------------------------------
  {
    id: "a tag counts as a pin",
    edits: [[POLICY,
      "const COMMIT_PIN = /^[^@\\s]+\\/[^@\\s]+@[0-9a-f]{40}$/;",
      "const COMMIT_PIN = /^[^@\\s]+\\/[^@\\s]+@\\S+$/;"]],
    tests: [T_WF],
    expect: "refuses a major tag",
  },
  {
    id: "the SHIPPED workflow pins an action to a tag",
    edits: [[WORKFLOW,
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "      - uses: actions/checkout@v7"]],
    tests: [T_WF],
    expect: "accepts the shipped workflow's pins",
  },
  // ---- AC-7: no secret, least privilege ------------------------------------
  {
    id: "secrets are scanned in raw text only, not in values",
    edits: [[POLICY,
      "  if (SECRET_REFERENCE.test(source) || allScalars(root).some((value) => SECRET_REFERENCE.test(value))) {",
      "  void allScalars;\n  if (SECRET_REFERENCE.test(source)) {"]],
    tests: [T_WF],
    expect: "secret reference found in a parsed value",
  },
  {
    id: "the job key allowlist is dropped, so job-level permissions return",
    edits: [[POLICY,
      "      if (!ALLOWED_JOB_KEYS.includes(key)) {",
      "      void key;\n      void ALLOWED_JOB_KEYS;\n      if (false as boolean) {"]],
    tests: [T_WF],
    expect: "refuses a job-level condition",
  },
  {
    id: "the SHIPPED workflow asks for write access",
    edits: [[WORKFLOW, "  contents: read", "  contents: write"]],
    tests: [T_WF],
    expect: "accepts the shipped workflow's permissions",
  },
  // ---- the checkout ---------------------------------------------------------
  {
    id: "the checkout is no longer required",
    edits: [[POLICY, "  if (checkouts.length === 0) {", "  if (false as boolean) {"]],
    tests: [T_WF],
    expect: "never checks out",
  },
  {
    id: "the checkout ordering looks at actions, not steps",
    edits: [[POLICY,
      '  if (typeof firstUses !== "string" || actionName(firstUses) !== "actions/checkout") {',
      "  void firstUses;\n  if (false as boolean) {"]],
    tests: [T_WF],
    expect: "not the first step",
  },
  {
    id: "checkout inputs are no longer constrained",
    edits: [[POLICY, "          if (!allowed.includes(key)) {", "          if (false as boolean) {"]],
    tests: [T_WF],
    expect: "repository input on checkout",
  },
  // ---- the parser's honesty -------------------------------------------------
  {
    id: "the parser reads backslashes literally",
    edits: [[POLICY,
      '  [/\\\\/, "a backslash, which this reader does not interpret"],\n',
      ""]],
    tests: [T_WF],
    expect: "refuses a hex escape",
  },
  {
    id: "duplicate keys inside a sequence-item mapping are resolved to the first",
    edits: [[POLICY,
      "        const duplicateInItem = duplicateKey(entries);\n        if (duplicateInItem !== undefined) {",
      "        const duplicateInItem = duplicateKey(entries);\n        if (false) {"]],
    tests: [T_WF],
    expect: "duplicate key inside a sequence-item mapping",
  },
  {
    id: "duplicate keys are silently resolved to the first",
    edits: [[POLICY,
      "  const duplicate = duplicateKey(entries);\n  if (duplicate !== undefined) {",
      "  const duplicate = duplicateKey(entries);\n  if (false) {"]],
    tests: [T_WF],
    expect: "same key twice",
  },
  {
    id: "the comment stripper stops tracking quotes",
    edits: [[POLICY,
      `    if (char === '"' || char === "'") {\n      quote = char;\n      continue;\n    }\n    if (char === "#" && (index === 0 || line[index - 1] === " ")) {`,
      '    if (char === "#") {']],
    tests: [T_WF],
    expect: "hash inside quotes",
  },
  {
    id: "the flow-sequence refusal is dropped",
    edits: [[POLICY, '  [/:\\s*\\[/, "a flow sequence"],\n', ""]],
    tests: [T_WF],
    expect: "refuses a flow sequence",
  },
  // ---- the deletion defence -------------------------------------------------
  {
    id: "the guarded-module manifest is emptied",
    edits: [[VERIFIER,
      '  ["src/verification/workflowPolicy.ts", "tests/workflowPolicy.test.ts", "workflowPolicy"],\n  ["docs/KNOWN-LIMITATIONS.md", "tests/knownLimitationsHonesty.test.ts", "KNOWN-LIMITATIONS"],',
      ""]],
    tests: [T_WF],
    expect: "pairs src/verification/workflowPolicy.ts",
  },
  {
    id: "the manifest is declared but nothing fails on a broken pair",
    edits: [[VERIFIER, "if (unguarded.length > 0) {", "if (false) {"]],
    tests: [T_WF],
    expect: "refuses when a guarded module has no test",
  },
  {
    id: "deletion is detected but exclusion from compilation is not",
    edits: [[VERIFIER,
      '  if (!sourceTests.includes(test)) return [[module, test, "exists but is not compiled, so it never runs"]];\n',
      ""]],
    tests: [T_WF],
    expect: "checks the filesystem AND the compiled set",
  },
  {
    id: "exclusion is detected but deletion is not",
    edits: [[VERIFIER,
      '  if (!existsSync(join(REPO_ROOT, test))) return [[module, test, "is missing"]];\n',
      ""]],
    tests: [T_WF],
    expect: "checks the filesystem AND the compiled set",
  },
  {
    id: "the manifest gate returns to a renameable label",
    edits: [[VERIFIER,
      "const unguarded = GUARDED_MODULES.flatMap(([module, test, marker]) => {",
      'const unguarded = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).name !== "software-factory" ? [] : GUARDED_MODULES.flatMap(([module, test, marker]) => {']],
    tests: [T_WF],
    expect: "nowhere names this repository",
  },
  {
    id: "a paired test need not mention the module it guards",
    edits: [[VERIFIER,
      "  if (!body.includes(marker)) {",
      "  void marker;\n  if (false) {"]],
    tests: [T_WF],
    expect: "verifier itself to check the marker",
  },
  // ---- round-6: context syntax and flow items -------------------------------
  {
    id: "a secret referenced with index syntax is accepted",
    edits: [[POLICY,
      "  const SECRET_REFERENCE = /\\bsecrets\\s*(\\.|\\[)/;",
      "  const SECRET_REFERENCE = /\\bsecrets\\./;"]],
    tests: [T_WF],
    expect: "secret referenced with index syntax",
  },
  {
    id: "a bare tag with a space after it is read as a value",
    edits: [[POLICY,
      '  [/:\\s*!/, "a tag"],',
      '  [/:\\s*!\\S/, "a tag"],']],
    tests: [T_WF],
    expect: "bare tag with a space after it",
  },
  {
    id: "a flow collection in a sequence item is read as a string",
    edits: [[POLICY,
      '  [/^\\s*-\\s*[[{]/, "a flow collection in a sequence item"],\n',
      ""]],
    tests: [T_WF],
    expect: "flow sequence used as a sequence item",
  },
  // ---- AC-9: the liability report stays honest ------------------------------
  {
    id: "existing-workflows closes regardless of the count",
    edits: [[FINANCIAL,
      '      "existing-workflows",\n      o?.configuredWorkflows === 0,',
      '      "existing-workflows",\n      true,']],
    tests: [T_PUSH],
    expect: "opens existing-workflows once the repository has any",
  },
  {
    id: "an unknown workflow count reads as zero",
    edits: [[FINANCIAL,
      '      "existing-workflows",\n      o?.configuredWorkflows === 0,',
      '      "existing-workflows",\n      (o?.configuredWorkflows ?? 0) === 0,']],
    tests: [T_PUSH],
    expect: "opens both channels when the counts could not be established",
  },
  // ---- AC-8: a pass is not an acceptance -----------------------------------
  {
    id: "green checks alone become sufficient for integration",
    edits: [[BINDING, "  if (!input.reviewAccepted) {", "  if (false as boolean) {"]],
    tests: [T_BIND],
    expect: "passing checks with no accepted review",
  },
  // ---- AC-10: the register may not overclaim --------------------------------
  {
    id: "an entry claims the clean room closes a limitation",
    edits: [[LIMITS,
      "**What would REDUCE it, and what would not close it:** `CLEAN_ROOM_CI` — a",
      "**What would close it:** `CLEAN_ROOM_CI` — a"]],
    tests: [T_HON],
    expect: "pairs no closure verb",
  },
  {
    id: "an entry overclaims in ordinary prose",
    // A UNIQUE anchor: the heading alone appears in both L-10 and L-11, so the
    // mutation was UNMEASURED rather than measured.
    edits: [[LIMITS,
      "### What the clean room changes, and what it does not (TASK-017)\n\n`.github/workflows/verify.yml` runs `npm test` on a GitHub-hosted runner from a",
      "### What the clean room changes, and what it does not (TASK-017)\n\nThe clean room eliminates this limitation entirely.\n\n`.github/workflows/verify.yml` runs `npm test` on a GitHub-hosted runner from a"]],
    tests: [T_HON],
    expect: "pairs no closure verb",
  },
];

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

const touched = [...new Set(selected.flatMap((m) => m.edits.map(([file]) => file)))].sort();
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
console.log("all touched files verified byte-for-byte against the run-start baseline");

const bad = results.filter(([, outcome]) => outcome !== "KILLED");
console.log(`SURVIVORS/UNMEASURED: ${bad.length === 0 ? "none" : JSON.stringify(bad.map(([id]) => id))}`);
process.exit(bad.length === 0 && end.fail === 0 ? 0 : 1);
