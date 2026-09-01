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
const MANIFEST = "src/verification/guardedModules.ts";
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
    edits: [[WORKFLOW, "      - run: npm test", "      - run: npm test\n        if: success()"]],
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
      "@[0-9a-f]{40}$/;",
      "@\\S+$/;"]],
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
    expect: "secret named in a plain value with no expression",
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
      '  [/\\\\/, "a backslash"],\n',
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
      "  const opener = line[valueStart];",
      "  const opener = undefined as string | undefined;"]],
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
    edits: [[MANIFEST,
      '  {\n    module: "src/verification/workflowPolicy.ts",\n    test: "tests/workflowPolicy.test.ts",\n    marker: "workflowPolicy",\n    anchor: ".github/workflows/verify.yml",\n  },\n',
      ""]],
    tests: [T_WF],
    expect: "declares the pair src/verification/workflowPolicy.ts",
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
    id: "a paired test need not mention the module it guards",
    edits: [[VERIFIER, "  if (!body.includes(marker)) {", "  void marker;\n  if (false) {"]],
    tests: [T_WF],
    expect: "verifier itself to check the marker",
  },
  {
    id: "the workflow guard loses its anchor",
    edits: [[MANIFEST,
      '    anchor: ".github/workflows/verify.yml",\n',
      ""]],
    tests: [T_WF],
    expect: "anchors the workflow guard",
  },
  {
    id: "an empty manifest is accepted",
    edits: [[VERIFIER,
      'if (guarded.length === 0 && existsSync(join(REPO_ROOT, "src/verification/workflowPolicy.ts"))) {',
      "if (false) {"]],
    tests: [T_WF],
    expect: "empty manifest while the modules it describes",
  },
  // ---- round-7: the closed grammar ----------------------------------------
  {
    id: "the scalar grammar opens up again",
    edits: [[POLICY,
      "  return PLAIN_SCALAR.test(text) ? text : undefined;",
      "  void PLAIN_SCALAR;\n  return text;"]],
    tests: [T_WF],
    expect: "refuses a reserved indicator",
  },
  {
    id: "a doubled quote is read with its own syntax intact",
    edits: [[POLICY,
      "      if (inner.includes(quote)) return undefined;",
      "      if (false) return undefined;"]],
    tests: [T_WF],
    expect: "doubled quote",
  },
  {
    id: "a key-looking value is admitted",
    edits: [[POLICY,
      "  if (/:\\s/.test(text)) return undefined;",
      "  if (false) return undefined;"]],
    tests: [T_WF],
    expect: "key-looking value",
  },
  {
    id: "expressions are evaluated rather than refused",
    edits: [[POLICY,
      '  [/\\$\\{\\{/, "a ${{ }} expression"],\n',
      ""]],
    tests: [T_WF],
    expect: "serialised secrets context",
  },
  {
    id: "a second job rides on the first job's checkout",
    edits: [[POLICY,
      "  if (jobs.entries.length > MAX_JOBS) {",
      "  void MAX_JOBS;\n  if (false as boolean) {"]],
    tests: [T_WF],
    expect: "declaring more than one job",
  },
  {
    id: "a coordinated deletion leaves the workflow unvalidated",
    edits: [[VERIFIER,
      "  if (anchored && !existsSync(join(REPO_ROOT, module))) {",
      "  void anchored;\n  if (false) {"]],
    tests: [T_WF],
    expect: "acts on the anchor",
  },
  // ---- round-8: comment boundary, null values, local actions ---------------
  {
    id: "the whole-line comment check is skipped",
    edits: [[POLICY,
      '  if (line[indent] === "#") return "";',
      '  if (false) return "";']],
    tests: [T_WF],
    expect: "still parses the shipped workflow",
  },
  {
    id: "a key with no value is an empty mapping again",
    edits: [[POLICY,
      "    const next = lines[index + 1];\n    if (next === undefined || next.indent <= indent) {",
      "    const next = lines[index + 1];\n    void next;\n    if (false as boolean) {"]],
    tests: [T_WF],
    expect: "no value",
  },
  {
    id: "a local action path counts as a pinned commit",
    edits: [[POLICY,
      "const COMMIT_PIN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?@[0-9a-f]{40}$/;",
      "const COMMIT_PIN = /^[^@\\s]+\\/[^@\\s]+@[0-9a-f]{40}$/;"]],
    tests: [T_WF],
    expect: "local action path",
  },
  {
    id: "an entry overclaims with a synonym",
    edits: [[LIMITS,
      "### What the clean room changes, and what it does not (TASK-017)\n\n`.github/workflows/verify.yml` runs `npm test` on a GitHub-hosted runner from a",
      "### What the clean room changes, and what it does not (TASK-017)\n\nThe clean room ends this limitation entirely.\n\n`.github/workflows/verify.yml` runs `npm test` on a GitHub-hosted runner from a"]],
    tests: [T_HON],
    expect: "pairs no closure verb",
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
