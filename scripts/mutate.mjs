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
const DOCUMENT = "src/verification/workflowDocument.ts";
const DIGEST = "src/verification/workflowDigest.ts";
const MANIFEST = "src/verification/guardedModules.ts";
const LIMITS = "docs/KNOWN-LIMITATIONS.md";
const FINANCIAL = "src/supervision/financialSafety.ts";
const BINDING = "src/github/candidateBinding.ts";

const T_WF = "dist/tests/workflowPolicy.test.js";
const T_HON = "dist/tests/knownLimitationsHonesty.test.js";
const T_PUSH = "dist/tests/pushAuthorization.test.js";
const T_BIND = "dist/tests/candidateBinding.test.js";
const T_DIG = "dist/tests/workflowDigest.test.js";
const T_E2E = "dist/tests/verificationHarnessEndToEnd.test.js";

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
      '  "install", "i", "in", "ins", "inst", "insta", "instal",\n  "isnt", "isnta", "isntal", "isntall", "add",',
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
      "      if (!allowedForEvent.includes(key)) {\n        return refuse(\n          `${event} uses ${JSON.stringify(key)}, which can stop the workflow running and is not reasoned about for this event`,\n        );\n      }",
      "      void key;\n      void allowedForEvent;"]],
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
    id: "an alias is resolved instead of refused",
    edits: [[DOCUMENT, "  if (isAlias(node)) {", "  if (isAlias(node) && false) {"]],
    tests: [T_WF],
    expect: "refuses an alias",
  },
  {
    id: "an anchor is carried through instead of refused",
    edits: [[DOCUMENT,
      "  const anchor = (node as { anchor?: string } | null)?.anchor;",
      "  const anchor = undefined as string | undefined;"]],
    tests: [T_WF],
    expect: "refuses an anchor",
  },
  {
    id: "duplicate keys are resolved instead of refused",
    edits: [[DOCUMENT, "uniqueKeys: true", "uniqueKeys: false"]],
    tests: [T_WF],
    expect: "refuses a duplicate key",
  },
  {
    id: "a parse error is ignored, so a malformed file reads as fine",
    edits: [[DOCUMENT, "  if (document.errors.length > 0) {", "  if (false) {"]],
    tests: [T_WF],
    expect: "refuses an unterminated quote",
  },
  {
    id: "a stream of documents is judged by whichever comes first",
    edits: [[DOCUMENT, "  if (documents.length > 1) {", "  if (false) {"]],
    tests: [T_WF],
    expect: "refuses MORE THAN ONE DOCUMENT",
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
    tests: [T_E2E],
    expect: "refuses a declared test that has been deleted",
  },
  /**
   * BOTH PAIR CLAUSES, AGAINST THE RUNNING VERIFIER. These were the last two
   * mutations here still killed by a regex over the verifier's source text,
   * and the second SURVIVED once a round-15 comment happened to contain the
   * token that regex matched. A test that reads source text checks that
   * somebody typed something, not that anything happens.
   */
  {
    id: "a declared test may be deleted without the pair reporting it",
    edits: [[VERIFIER,
      '  if (!existsSync(join(REPO_ROOT, test))) return [[module, test, "is missing"]];\n',
      ""]],
    tests: [T_E2E],
    expect: "refuses a declared test that has been deleted",
  },
  {
    id: "deletion is detected but exclusion from compilation is not",
    edits: [[VERIFIER,
      '  if (!sourceTests.includes(test)) return [[module, test, "exists but is not compiled, so it never runs"]];\n',
      ""]],
    tests: [T_E2E],
    expect: "refuses a declared test that exists but is excluded from compilation",
  },
  {
    id: "a paired test need not mention the module it guards",
    edits: [[VERIFIER, "  if (!body.includes(marker)) {", "  void marker;\n  if (false) {"]],
    tests: [T_E2E],
    expect: "refuses a declared test that never mentions the module it guards",
  },
  {
    id: "the workflow guard loses its anchor",
    edits: [[MANIFEST,
      '    marker: "workflowPolicy",\n    anchor: ".github/workflows/verify.yml",\n',
      '    marker: "workflowPolicy",\n']],
    tests: [T_WF],
    expect: "anchors the workflow guard",
  },
  // ---- round-15: presence is not execution ---------------------------------
  /**
   * Six rounds attacked this guard. Each mutation switches off one clause and
   * must be killed BY A NAMED END-TO-END CASE, because round 15 walked straight
   * through evidence that was only a regex over the verifier's source text.
   *
   * `scripts/verify.mjs` is not in `tsconfig.json`, so `if (false)` here is
   * ordinary dead code rather than the TypeScript narrowing trap that sent six
   * mutations UNMEASURED in an earlier round.
   */
  {
    id: "a shortfall in the required deliverable set is not refused",
    edits: [[VERIFIER,
      "  if (shortfalls.length > 0) {",
      "  if (false) {"]],
    tests: [T_E2E],
    expect: "refuses a shrunk manifest that keeps its path but drops the deliverable",
  },
  {
    id: "the required set names nothing, so nothing can be missing",
    edits: [[VERIFIER,
      'const REQUIRED_GUARDS = [\n  { module: "src/verification/workflowPolicy.ts", test: "tests/workflowPolicy.test.ts" },\n  { module: "src/verification/workflowDocument.ts", test: "tests/workflowPolicy.test.ts" },\n  { module: "src/verification/workflowDigest.ts", test: "tests/workflowDigest.test.ts" },\n];',
      "const REQUIRED_GUARDS = [];"]],
    tests: [T_E2E],
    expect: "refuses a shrunk manifest that keeps its path but drops the deliverable",
  },
  {
    id: "a required module need not be present",
    edits: [[VERIFIER,
      "    if (!existsSync(join(REPO_ROOT, module))) {",
      "    if (false) {"]],
    tests: [T_E2E],
    expect: "refuses a single deleted required module, with every other clause satisfied",
  },
  {
    id: "a required module need not be compiled",
    edits: [[VERIFIER,
      "    } else if (!allSources.includes(module)) {",
      "    } else if (false) {"]],
    tests: [T_E2E],
    expect: "refuses required modules that exist but are excluded from compilation",
  },
  {
    id: "the manifest need not pair a required module with its named test",
    edits: [[VERIFIER,
      "    if (!guarded.some((entry) => entry.module === module && entry.test === test)) {",
      "    if (false) {"]],
    tests: [T_E2E],
    expect: "refuses a manifest that relabels required pairs onto one trivial test",
  },
  {
    id: "an unloadable manifest is diagnosed as an empty one",
    edits: [[VERIFIER,
      "    manifest === undefined",
      "    false"]],
    tests: [T_E2E],
    expect: "refuses a stale manifest on a tree that is not a repository",
  },
  {
    id: "a pair may be declared twice",
    edits: [[VERIFIER,
      "if (duplicatePairs.length > 0) {",
      "if (false) {"]],
    tests: [T_E2E],
    expect: "refuses a manifest that declares the same pair twice",
  },
  // ---- round-16: presence is not detection --------------------------------
  /**
   * THE CANARY. Each required test is run against a build of its module with
   * every export replaced, and must FAIL. These three switch off the clauses
   * that make that a refusal rather than a remark.
   */
  {
    id: "a test that detects nothing is not refused",
    edits: [[VERIFIER,
      "  if (undetected.length > 0) {",
      "  if (false) {"]],
    tests: [T_E2E],
    expect: "refuses a required test that does not exercise the module it guards",
  },
  // ---- round-18: the canary must not measure its own generator -----------
  {
    id: "the replacement is generated for identifiers only",
    edits: [[VERIFIER,
      "        const alias = name === \"default\" ? \"default\" : JSON.stringify(name);\n        return `const ${local} = ${value};\\nexport { ${local} as ${alias} };`;",
      "        return name === \"default\"\n          ? `const ${local} = ${value};\\nexport default ${local};`\n          : `const ${local} = ${value};\\nexport const ${name} = ${local};`;"]],
    tests: [T_E2E],
    expect: "accepts a repository whose module exports a name that is not an identifier",
  },
  /**
   * THE SELF-CHECK'S OTHER HALF. No FIXTURE can reach either arm — only a
   * defect in this verifier's own generator triggers them — so the generator is
   * what the mutations break, and the healthy-repository controls catch it.
   */
  {
    id: "the replacement need not offer every export the module did",
    edits: [[VERIFIER,
      "      ...names.map((name, index) => {",
      "      ...names.slice(1).map((name, index) => {"]],
    tests: [T_E2E],
    expect: "accepts a repository whose deliverable is present, compiled and executed",
  },
  {
    id: "an abandoned replacement in the output is inherited",
    edits: [[VERIFIER,
      "  if (abandoned.length > 0) {",
      "  if (false) {"]],
    tests: [T_E2E],
    expect: "refuses output that still holds an abandoned canary replacement",
  },
  {
    id: "the paired test runs through a worker that outlives the timeout",
    edits: [[VERIFIER,
      "    const run = spawnSync(process.execPath, [artifact], {",
      "    const run = spawnSync(process.execPath, [\"--test\", artifact], {"]],
    tests: [T_E2E],
    expect: "refuses a required test that cannot be measured against a replaced module",
  },
  {
    id: "a test need not pass against its own module first",
    edits: [[VERIFIER,
      '    if (baseline.outcome !== "passed") {',
      "    if (false) {"]],
    tests: [T_E2E],
    expect: "refuses a required test that does not pass against its own module",
  },
  {
    id: "a run that could not be measured counts as detection",
    edits: [[VERIFIER,
      '    } else if (substituted.outcome !== "failed") {',
      "    } else if (false) {"]],
    tests: [T_E2E],
    expect: "refuses a required test that cannot be measured against a replaced module",
  },
  {
    id: "a run that never completed is read as an ordinary failure",
    edits: [[VERIFIER,
      '    if (run.error !== undefined || run.status === null) {',
      "    if (false) {"]],
    tests: [T_E2E],
    expect: "refuses a required test that cannot be measured against a replaced module",
  },
  {
    id: "a module with no exports is treated as guardable",
    edits: [[VERIFIER,
      "    if (names.length === 0) {",
      "    if (false) {"]],
    tests: [T_E2E],
    expect: "refuses required modules that export nothing at run time",
  },
  {
    id: "the canary run's outcome is not consulted",
    edits: [[VERIFIER,
      '    if (substituted.outcome === "passed") {',
      "    if (false) {"]],
    tests: [T_E2E],
    expect: "refuses a required test that does not exercise the module it guards",
  },
  /**
   * THE OTHER DIRECTION, and it is the one that matters most here: a canary
   * that refused EVERY repository would satisfy the cases above while breaking
   * the complete fixture, which is how the first attempt at this guard was
   * caught.
   */
  {
    id: "the canary refuses even a test that does detect the change",
    edits: [[VERIFIER,
      '    if (substituted.outcome === "passed") {',
      '    if (substituted.outcome !== "this is never an outcome") {']],
    tests: [T_E2E],
    expect: "accepts a repository whose deliverable is present, compiled and executed",
  },
  {
    id: "the workflow anchor is no longer required",
    edits: [[VERIFIER,
      "  if (!existsSync(join(REPO_ROOT, REQUIRED_ANCHOR))) {",
      "  if (false) {"]],
    tests: [T_E2E],
    expect: "refuses a missing workflow even when the manifest stops anchoring it",
  },
  {
    id: "a repository is no longer recognised, so nothing is ever owed",
    edits: [[VERIFIER,
      'const looksLikeRepository = existsSync(join(REPO_ROOT, ".git"));',
      "const looksLikeRepository = false;"]],
    tests: [T_E2E],
    expect: "refuses a shrunk manifest that keeps its path but drops the deliverable",
  },
  /**
   * THE OTHER DIRECTION. Requiring the deliverable of EVERY tree would pass
   * every refusal case above while breaking the synthetic fixtures that are not
   * repositories — which is how this round's first remediation attempt was
   * caught.
   */
  {
    id: "the deliverable is required of trees that are not repositories",
    edits: [[VERIFIER,
      'const looksLikeRepository = existsSync(join(REPO_ROOT, ".git"));',
      "const looksLikeRepository = true;"]],
    tests: [T_E2E],
    expect: "still accepts a non-repository fixture, which owes no deliverable",
  },
  {
    id: "an empty manifest is accepted",
    edits: [[VERIFIER,
      "if (existsSync(join(REPO_ROOT, MANIFEST_SOURCE)) && guarded.length === 0) {",
      "if (false) {"]],
    tests: [T_E2E],
    expect: "refuses a manifest emptied of every entry, where no other guard can fire",
  },
  // ---- round-14: the required deliverable set ------------------------------
  /**
   * Five rounds of deletion attacks produced this guard, and round 14 defeated
   * its predecessor twice — once by shrinking the manifest it read, once by
   * breaking the git query it asked. Each mutation below switches off one clause
   * and must be killed BY A NAMED END-TO-END CASE, because the previous round's
   * evidence was a regex over the verifier's source text and a mutation walked
   * straight through it.
   *
   * `scripts/verify.mjs` is not in `tsconfig.json`, so `if (false)` here is
   * ordinary dead code rather than the TypeScript narrowing trap that sent six
   * mutations UNMEASURED in an earlier round.
   */
  /**
   * THE OTHER DIRECTION. Requiring the deliverable of EVERY tree would also pass
   * every refusal case above while breaking the synthetic fixtures that are not
   * repositories — which is how the first attempt at this round was caught.
   */
  // ---- round-7: the closed grammar ----------------------------------------
  {
    id: "the reader asks for YAML 1.1, where `on` is a boolean",
    edits: [[DOCUMENT, 'uniqueKeys: true, version: "1.2"', 'uniqueKeys: true, version: "1.1"']],
    tests: [T_WF],
    expect: "reads `on` as a key",
  },
  {
    id: "a non-string scalar is coerced to its spelling",
    edits: [[DOCUMENT,
      "      return {\n        ok: false,\n        reason: `${path} is ${value === null ? \"null\" : typeof value}; this reader represents only string scalars`,\n      };",
      "      return { ok: true, value: String(value) };"]],
    tests: [T_WF],
    expect: "refuses a boolean",
  },
  {
    id: "an explicit tag is accepted instead of refused",
    edits: [[DOCUMENT,
      "  const tag = (node as { tag?: string } | null)?.tag;",
      "  const tag = undefined as string | undefined;"]],
    tests: [T_WF],
    expect: "refuses an explicit tag",
  },
  {
    id: "expressions are no longer refused",
    edits: [[POLICY,
      "  for (const value of allScalars(root)) {",
      "  for (const value of allScalars(root).slice(0, 0)) {"]],
    tests: [T_WF],
    expect: "refuses a dotted secret",
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
    tests: [T_E2E],
    expect: "refuses a deleted module whose entry still anchors a present artifact",
  },
  // ---- round-8: comment boundary, null values, local actions ---------------
  {
    id: "a top level that is not a mapping is accepted",
    edits: [[DOCUMENT,
      '  if (typeof root === "string" || root.kind !== "map") {\n    return refuse("the workflow\'s top level is not a mapping");\n  }\n  return { ok: true, root };',
      "  return { ok: true, root: root as YamlMap };"]],
    tests: [T_WF],
    expect: "refuses a top level that is not a mapping",
  },
  {
    id: "a key with no value is an empty mapping again",
    edits: [[DOCUMENT,
      "        return { ok: false, reason: `${child} has no value` };",
      "        entries.push([key.value, { kind: \"map\", entries: [] }]); continue;"]],
    tests: [T_WF],
    expect: "refuses a flow mapping entry with no value",
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
  // ---- the parser boundary and the digest --------------------------------
  {
    id: "a branch list is filtered instead of refused",
    edits: [[POLICY, "    if (typeof item !== \"string\") return undefined;", "    if (typeof item !== \"string\") continue;"]],
    tests: [T_WF],
    expect: "refuses a branch list whose items are not all patterns",
  },
  {
    id: "a non-string action name removes itself from the pin check",
    edits: [[POLICY, "    if (typeof value !== \"string\") return undefined;", "    if (typeof value !== \"string\") continue;"]],
    tests: [T_WF],
    expect: "refuses a step naming an action as something other than a string",
  },
  {
    id: "the shape gate names keys without checking their types",
    edits: [[POLICY,
      '        if (key !== "with" && typeof value !== "string") {',
      '        if (key !== "with" && typeof value !== "string" && false) {']],
    tests: [T_WF],
    expect: "refuses a non-string step value at the shape gate",
  },
  {
    id: "an action input need not be a single string",
    edits: [[POLICY,
      '          if (typeof value !== "string") {',
      '          if (typeof value !== "string" && key === "\\u0000never") {']],
    tests: [T_WF],
    expect: "refuses an action input that is not a single string",
  },
  {
    id: "the digest is not actually compared",
    edits: [[DIGEST,
      '  return createHash("sha256").update(source).digest("hex");',
      '  return createHash("sha256").update(source).digest("hex").slice(0, 0) + REVIEWED_WORKFLOW_SHA256;']],
    tests: [T_DIG],
    expect: "rejects a workflow that differs by one byte",
  },
  {
    id: "the reviewed digest records the wrong bytes",
    edits: [[DIGEST, "  \"6b15d37f", "  \"000000ec"]],
    tests: [T_DIG],
    expect: "matches the reviewed digest",
  },
  // ---- round-9 review ------------------------------------------------------
  {
    id: "the checkout's credential persistence is not checked",
    edits: [[POLICY,
      "    if (persist === undefined) {",
      '    if (persist === "\\u0000never") {']],
    tests: [T_WF],
    expect: "refuses a checkout that does not mention persist-credentials",
  },
  {
    id: "the SHIPPED workflow persists the job's token",
    edits: [[WORKFLOW,
      '          persist-credentials: "false"',
      '          persist-credentials: "true"']],
    tests: [T_WF],
    expect: "accepts the shipped workflow, which now sets it explicitly",
  },
  {
    id: "push regains the activity types it does not have",
    edits: [[POLICY,
      '  push: ["branches"],',
      '  push: ["branches", "types"],']],
    tests: [T_WF],
    expect: "refuses types on push",
  },
  {
    id: "a scalar event configuration is skipped at the shape gate",
    edits: [[POLICY,
      '    if (typeof config === "string") {\n      return refuse(`the filters for ${event} are ${JSON.stringify(config)} rather than a mapping`);\n    }',
      '    if (typeof config === "string") {\n      continue;\n    }']],
    tests: [T_WF],
    expect: "refuses a scalar event configuration at the shape gate",
  },
  {
    id: "a scalar event configuration is skipped at the trigger check",
    edits: [[POLICY,
      '    if (typeof config === "string") {\n      return refuse(`${event} is configured as ${JSON.stringify(config)} rather than a mapping of filters`);\n    }',
      '    if (typeof config === "string") {\n      continue;\n    }']],
    tests: [T_WF],
    expect: "refuses a scalar event configuration at the trigger check too",
  },
  {
    id: "a mapping key skips the anchor and tag gate",
    edits: [[DOCUMENT,
      "      const keyGated = nodeGate(key, `${path}'s key ${JSON.stringify(key.value)}`);",
      "      const keyGated = undefined as string | undefined;"]],
    tests: [T_WF],
    expect: "refuses a tagged key",
  },
  {
    id: "any pinned action is accepted, whoever wrote it",
    edits: [[POLICY,
      '        if (typeof uses !== "string" || !ALLOWED_ACTIONS.includes(actionName(uses))) {',
      '        if (typeof uses !== "string") {']],
    tests: [T_WF],
    expect: "refuses an action nobody has reasoned about",
  },
  {
    id: "a step may be both an action and a command",
    edits: [[POLICY,
      "      if (uses !== undefined && run !== undefined) {",
      '      if (uses !== undefined && run !== undefined && run === "\\u0000never") {']],
    tests: [T_WF],
    expect: "refuses a step declaring both uses: and run:",
  },
  {
    id: "the workflow name has no type",
    edits: [[POLICY,
      '    if (key === "name" && typeof value !== "string") {',
      '    if (key === "\\u0000never" && typeof value !== "string") {']],
    tests: [T_WF],
    expect: "refuses a workflow name that is not a single string",
  },
  // ---- round-10 review -----------------------------------------------------
  {
    id: "a sequence event configuration is skipped by the trigger check",
    edits: [[POLICY,
      '    if (config.kind !== "map") {\n      return refuse(`${event} is configured as a sequence rather than a mapping of filters`);\n    }',
      '    if (config.kind !== "map") {\n      continue;\n    }']],
    tests: [T_WF],
    expect: "refuses an empty sequence as an event configuration",
  },
  {
    id: "the trigger check stops validating per-event filters",
    edits: [[POLICY,
      "      if (!allowedForEvent.includes(key)) {\n        return refuse(\n          `${event} declares ${JSON.stringify(key)}, which is not a filter this policy reasons about for that event`,\n        );\n      }",
      "      void key;\n      void allowedForEvent;"]],
    tests: [T_WF],
    expect: "refuses types on push at the trigger check",
  },
  {
    id: "the two action allowlists may name different sets",
    edits: [[POLICY,
      'export const ALLOWED_WITH_KEYS: Readonly<Record<string, readonly string[]>> = {',
      'export const ALLOWED_WITH_KEYS: Readonly<Record<string, readonly string[]>> = {\n  "evil/tool": [],']],
    tests: [T_WF],
    expect: "models the inputs of exactly the actions it admits",
  },
  // ---- round-11 review -----------------------------------------------------
  {
    id: "the shortest isnt alias goes missing again",
    edits: [[POLICY,
      '  "isnt", "isnta", "isntal", "isntall", "add",',
      '  "isnta", "isntal", "isntall", "add",']],
    tests: [T_WF],
    expect: "covers every alias npm documents",
  },
  {
    id: "only the long spelling reaches the install guard",
    edits: [[POLICY,
      "    if (isNpmSubcommand(command, INSTALL_ALIASES)) {",
      '    if (isNpmSubcommand(command, ["install"])) {']],
    tests: [T_WF],
    expect: "refuses npm isnt at checkInstall itself",
  },
  {
    id: "a different alias goes missing",
    edits: [[POLICY,
      '  "isnt", "isnta", "isntal", "isntall", "add",',
      '  "isnt", "isnta", "isntal", "isntall",']],
    tests: [T_WF],
    expect: "covers every alias npm documents",
  },
  // ---- round-12 review -----------------------------------------------------
  {
    id: "a declared anchor need not exist, so deleting the workflow removes its guard",
    edits: [[VERIFIER,
      "      .filter(({ anchor }) => anchor !== undefined && !existsSync(join(REPO_ROOT, anchor)))",
      "      .filter(() => false)"]],
    tests: [T_E2E],
    expect: "refuses a manifest that anchors an artifact the tree does not contain",
  },
  {
    id: "the Node pin may come after the commands it is meant to pin",
    edits: [[POLICY,
      "  if (firstRun !== -1 && firstPin > firstRun) {",
      "  if (firstRun !== -1 && firstPin > firstRun && firstRun < 0) {"]],
    tests: [T_WF],
    expect: "refuses a setup-node placed after the commands",
  },
  {
    id: "a metered larger runner joins the free list",
    edits: [[POLICY,
      'export const FREE_RUNNER_LABELS: readonly string[] = ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"];',
      'export const FREE_RUNNER_LABELS: readonly string[] = ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04", "ubuntu-latest-8-cores"];']],
    tests: [T_WF],
    expect: "is exactly the three runners this repository has reasoned about",
  },
  // ---- round-13 review -----------------------------------------------------
  {
    id: "a tag directive is read and discarded rather than refused",
    edits: [[DOCUMENT,
      "  if (custom.length > 0) {",
      "  if (false) {"]],
    tests: [T_WF],
    expect: "refuses the shipped workflow behind a %TAG directive",
  },
  {
    id: "only NEW tag handles are refused, so a default may be redefined",
    edits: [[DOCUMENT,
      "DEFAULT_TAG_HANDLES[handle] !== prefix",
      "DEFAULT_TAG_HANDLES[handle] === undefined && prefix.length >= 0"]],
    tests: [T_WF],
    expect: "refuses %TAG !! tag:example.com,2020:",
  },
  {
    id: "the YAML version is requested but not asserted",
    edits: [[DOCUMENT,
      '  if (effectiveVersion !== "1.2") {',
      '  const forced: string | undefined = effectiveVersion;\n  if (forced !== "1.2" && forced === "\\u0000never") {']],
    tests: [T_WF],
    expect: "refuses a document that declares YAML 1.1",
  },
  {
    id: "the verification guard lists spellings instead of allowing npm",
    edits: [[POLICY,
      '    const executable = trimmed.split(/\\s+/)[0] ?? "";\n    if (executable !== "npm") {',
      '    const executable = trimmed.split(/\\s+/)[0] ?? "";\n    void executable;\n    if (/\\bnode\\s+--test\\b/.test(trimmed) || /(^|\\s)(npx\\s+)?tsc\\b/.test(trimmed)) {']],
    tests: [T_WF],
    expect: "refuses a tool invoked by a direct executable path",
  },
  {
    id: "checkInstall reads past a run it cannot parse",
    edits: [[POLICY,
      "  if (stepValues(root, \"run\") === undefined) {\n    return refuse(\"a step gives run: something other than a single command, so the install cannot be judged\");\n  }",
      "  void 0;"]],
    tests: [T_WF],
    expect: "checkInstall refuses a run: it cannot read, on its own",
  },
  {
    id: "checkVerificationCommand reads past a run it cannot parse",
    edits: [[POLICY,
      "  if (stepValues(root, \"run\") === undefined) {\n    return refuse(\"a step gives run: something other than a single command, so the verification cannot be judged\");\n  }",
      "  void 0;"]],
    tests: [T_WF],
    expect: "checkVerificationCommand refuses a run: it cannot read, on its own",
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
