/**
 * Reading a GitHub Actions workflow strictly enough to make claims about it
 * (TASK-017).
 *
 * WHY THERE IS STRUCTURE HERE AT ALL. The criteria say things like "the workflow
 * pins a standard runner" and "every action is pinned to a commit". Those are
 * claims about STRUCTURE, and checking them with substring searches would be
 * checking the text rather than the meaning — `runs-on: ubuntu-latest` inside a
 * comment would satisfy a grep and satisfy nothing else.
 *
 * YAML SYNTAX IS NOT INTERPRETED HERE ANY MORE. It was, for eight review rounds,
 * and roughly half the CRITICALs found in that time were MISREADS: the reader
 * reporting structure the file does not have. The owner's decision after round 8
 * was to move the trust boundary rather than relax the criteria, so
 * `workflowDocument.ts` delegates syntax to a standards-compliant YAML 1.2
 * parser and normalises the result, and this module reasons only about the
 * normalised structure.
 *
 * WHAT REMAINS OURS IS THE SEMANTIC ALLOWLIST, and it stays CLOSED. Parsing a
 * file correctly says nothing about whether its contents are acceptable: a
 * perfectly-parsed `continue-on-error` still makes a failure harmless. So every
 * key, event, runner, action input and command this workflow may contain is
 * written down, and anything unlisted is REFUSED rather than ignored. That is
 * the same bargain as before, now made in the one place it belongs — this can be
 * wrong only by refusing a workflow it could have accepted, which fails visibly.
 */

import {
  get,
  parseWorkflow,
  type ParseResult,
  type YamlMap,
  type YamlNode,
  type YamlSeq,
} from "./workflowDocument.js";

/**
 * Re-exported so callers have one import for "read this workflow and judge it",
 * and so the eight rounds of reproductions keep testing through the same door
 * they always did. The DEFINITIONS live in `workflowDocument.ts`; this is the
 * seam, not a second implementation.
 */
export { get, parseWorkflow };
export type { ParseResult, YamlMap, YamlNode, YamlSeq };

export type PolicyVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function refuse(reason: string): PolicyVerdict {
  return { ok: false, reason };
}

/**
 * AN EXPRESSION IS NOT A VALUE THIS POLICY CAN EVALUATE (round-7 review).
 *
 * Three rounds of secret bypasses were three ways of spelling one:
 * `secrets.NAME`, `secrets['NAME']`, `toJSON(secrets)`, and `github.token` which
 * names no secret at all while being one. Matching spellings is the losing game
 * a closed policy exists to stop playing.
 *
 * THIS MOVED WHEN THE PARSER DID, and the move matters. `${{ ... }}` used to be
 * refused as unreadable SYNTAX; to a real YAML parser it is an ordinary string,
 * so the refusal has to be made here, as a statement about what this workflow
 * may MEAN. It is checked over the parsed structure — keys and values, at every
 * depth — so an escape that spelled it `"\x24{{"` is decoded by the parser
 * before this sees it, which is the whole reason for the new boundary.
 */
const EXPRESSION = /\$\{\{/;

export function checkNoExpressions(root: YamlMap): PolicyVerdict {
  for (const value of allScalars(root)) {
    if (EXPRESSION.test(value)) {
      return refuse(
        `the workflow contains the expression ${JSON.stringify(value)}, whose value this policy cannot determine`,
      );
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------- navigation

function seqItems(node: YamlNode | undefined): readonly YamlNode[] {
  return node !== undefined && typeof node !== "string" && node.kind === "seq" ? node.items : [];
}

function mapKeys(node: YamlNode | undefined): readonly string[] {
  return node !== undefined && typeof node !== "string" && node.kind === "map"
    ? node.entries.map(([key]) => key)
    : [];
}

/**
 * Every step's value for `key`, or `undefined` if any step gives it a value
 * that is not a single string.
 *
 * The same refusal-rather-than-filter rule as `stringList`, at the site where
 * dropping was worst: `checkActionPins` treats an empty list as "no actions to
 * pin, nothing to check", so a `uses:` that was a sequence rather than a string
 * removed itself from the pin check and reported success.
 */
function stepValues(root: YamlMap, key: string): readonly string[] | undefined {
  const values: string[] = [];
  for (const step of steps(root)) {
    const value = get(step, key);
    if (value === undefined) continue;
    if (typeof value !== "string") return undefined;
    values.push(value);
  }
  return values;
}

/** Every step of every job, flattened, because the criteria are about all of them. */
export function steps(root: YamlMap): readonly YamlNode[] {
  const jobs = get(root, "jobs");
  const collected: YamlNode[] = [];
  if (jobs === undefined || typeof jobs === "string" || jobs.kind !== "map") return collected;
  for (const [, job] of jobs.entries) {
    collected.push(...seqItems(get(job, "steps")));
  }
  return collected;
}


// ------------------------------------------------------------------- schema

/**
 * WHAT THIS WORKFLOW IS ALLOWED TO CONTAIN (round-2 review).
 *
 * The parser refuses YAML constructs it does not implement. The policies did
 * not extend that courtesy to WORKFLOW FEATURES, and the round-2 review walked
 * straight through the gap: `jobs.verify.if: ${{ false }}` skips the job,
 * `jobs.verify.continue-on-error: true` makes its failure harmless,
 * `jobs.verify.permissions: contents: write` overrides the root block,
 * `paths-ignore: ["**"]` stops the workflow running at all, and a negative
 * branch pattern after `**` excludes everything it just included. Each is
 * documented GitHub behaviour. Each passed every check.
 *
 * Fixing them individually is a losing game — six were found after four were
 * fixed — so this is an ALLOWLIST. A key nobody here has reasoned about is
 * refused, which is the same bargain the parser makes: this can be wrong only
 * by refusing a workflow it could have accepted, which fails visibly.
 *
 * Adding a key here is a deliberate act that says "I have thought about what
 * this does to the guarantees". That is the point.
 */
const ALLOWED_ROOT_KEYS: readonly string[] = ["name", "on", "permissions", "jobs"];
const ALLOWED_EVENTS: readonly string[] = ["pull_request", "push"];
/**
 * PER EVENT, not one list shared by all of them (round-9 review, HIGH 2).
 *
 * A single list allowed `types` on `push`, which has no activity types in
 * GitHub's model, so a filter reasoned about only for `pull_request` passed on
 * an event where it means nothing. An allowlist shared between things that do
 * not share a vocabulary is not closed over either of them — it is closed over
 * their union, which is strictly larger.
 */
const ALLOWED_EVENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  pull_request: ["branches", "types"],
  push: ["branches"],
};
/**
 * The actions this workflow may run, BY IDENTITY (round-9 review, HIGH 4).
 *
 * `checkActionPins` proved every `uses:` named a commit, and a pin says WHICH
 * VERSION runs while saying nothing about WHOSE CODE it is —
 * `evil/tool@<40 hex>` satisfied it completely, and the allowlist that was
 * supposed to be closed had no opinion about action identity at all.
 *
 * These are the two actions this repository has reasoned about, and they are
 * exactly the two whose inputs `ALLOWED_WITH_KEYS` constrains. That agreement
 * is the point: an action nobody has modelled has no modelled inputs either, so
 * admitting one would leave its configuration unexamined as well.
 */
export const ALLOWED_ACTIONS: readonly string[] = ["actions/checkout", "actions/setup-node"];
/**
 * NO `if`, NO `continue-on-error`, NO `permissions` at job level, and nothing
 * that changes where or how the job runs.
 */
const ALLOWED_JOB_KEYS: readonly string[] = ["runs-on", "steps"];
/**
 * EXACTLY ONE JOB (round-7 review, HIGH 4).
 *
 * `steps()` concatenates the steps of every job, so a second job with no
 * checkout and no Node pin passed every check on the strength of the first
 * job's. GitHub gives each job its own workspace, so that reading was simply
 * wrong. One job is what this workflow needs, and one job is what it may have.
 */
const MAX_JOBS = 1;
/** NO `if`, NO `continue-on-error`, NO `env`, NO `working-directory`. */
const ALLOWED_STEP_KEYS: readonly string[] = ["name", "uses", "run", "with"];
/**
 * `with` inputs, per action. `actions/checkout` accepts `repository` and `ref`,
 * which would let the clean room verify somebody else's code entirely — the
 * round-2 reviewer repointed it and every check stayed green.
 */
export const ALLOWED_WITH_KEYS: Readonly<Record<string, readonly string[]>> = {
  "actions/checkout": ["persist-credentials"],
  "actions/setup-node": ["node-version"],
};
/** The only commands this workflow may run. */
const ALLOWED_RUN_COMMANDS: readonly string[] = ["npm ci", "npm test"];

function actionName(uses: string): string {
  return uses.split("@")[0] ?? uses;
}

export function checkWorkflowShape(root: YamlMap): PolicyVerdict {
  for (const [key, value] of root.entries) {
    if (!ALLOWED_ROOT_KEYS.includes(key)) {
      return refuse(`the workflow declares ${JSON.stringify(key)}, which this policy does not reason about`);
    }
    /**
     * `name` HAS A TYPE TOO (round-9 review, non-blocking note). `name:
     * [verify, extra]` passed every check because the root allowlist asked
     * only which keys appeared. The same half-check as the step keys, at the
     * level above them.
     */
    if (key === "name" && typeof value !== "string") {
      return refuse("the workflow's name is not a single string");
    }
  }

  const on = get(root, "on");
  if (on === undefined || typeof on === "string" || on.kind !== "map") {
    return refuse("the workflow's triggers are not a mapping of event to filters");
  }
  for (const [event, config] of on.entries) {
    if (!ALLOWED_EVENTS.includes(event)) {
      return refuse(`the workflow triggers on ${JSON.stringify(event)}, which this policy does not reason about`);
    }
    /**
     * A SCALAR IS NOT A FILTER BLOCK, AND SKIPPING IT WAS FAILING OPEN
     * (round-9 review, HIGH 2).
     *
     * `pull_request: anything` was waved through here and again in
     * `checkTriggers`, so a workflow GitHub would reject outright passed every
     * check this repository makes. Approving a workflow that cannot run is the
     * same defect as approving one that runs wrongly: either way the evidence
     * the criteria demand never appears.
     */
    if (typeof config === "string") {
      return refuse(`the filters for ${event} are ${JSON.stringify(config)} rather than a mapping`);
    }
    if (config.kind !== "map") {
      return refuse(`the filters for ${event} are not a mapping`);
    }
    const allowedForEvent = ALLOWED_EVENT_KEYS[event] ?? [];
    for (const [key] of config.entries) {
      if (!allowedForEvent.includes(key)) {
        return refuse(
          `${event} uses ${JSON.stringify(key)}, which can stop the workflow running and is not reasoned about for this event`,
        );
      }
    }
  }

  const jobs = get(root, "jobs");
  if (jobs === undefined || typeof jobs === "string" || jobs.kind !== "map" || jobs.entries.length === 0) {
    return refuse("the workflow declares no jobs");
  }
  if (jobs.entries.length > MAX_JOBS) {
    return refuse(
      `the workflow declares ${jobs.entries.length} jobs; each has its own workspace, and these checks describe one`,
    );
  }
  for (const [name, job] of jobs.entries) {
    if (typeof job === "string" || job.kind !== "map") {
      return refuse(`job ${JSON.stringify(name)} is not a mapping`);
    }
    for (const [key] of job.entries) {
      if (!ALLOWED_JOB_KEYS.includes(key)) {
        return refuse(
          `job ${JSON.stringify(name)} declares ${JSON.stringify(key)}, which can change whether or how it runs`,
        );
      }
    }
    const jobSteps = get(job, "steps");
    if (jobSteps === undefined || typeof jobSteps === "string" || jobSteps.kind !== "seq" || jobSteps.items.length === 0) {
      return refuse(`job ${JSON.stringify(name)} declares no steps`);
    }
    for (const step of jobSteps.items) {
      if (typeof step === "string" || step.kind !== "map") {
        return refuse(`job ${JSON.stringify(name)} has a step that is not a mapping`);
      }
      for (const [key, value] of step.entries) {
        if (!ALLOWED_STEP_KEYS.includes(key)) {
          return refuse(
            `a step in job ${JSON.stringify(name)} declares ${JSON.stringify(key)}, which can change whether it runs or whether its failure counts`,
          );
        }
        /**
         * AND IT MUST BE THE SHAPE THE POLICIES READ IT AS. Allowing the KEY
         * while ignoring its TYPE let a non-string `run:` or `uses:` through
         * here and be dropped by the string filters downstream, so a step
         * escaped the command allowlist and the pin check by not being a
         * string at all. Naming a key is half of a shape check.
         */
        if (key !== "with" && typeof value !== "string") {
          return refuse(
            `a step in job ${JSON.stringify(name)} gives ${JSON.stringify(key)} a value that is not a single string`,
          );
        }
      }
      const uses = get(step, "uses");
      const run = get(step, "run");
      /**
       * A STEP IS AN ACTION OR A COMMAND, NOT BOTH (round-9 review,
       * non-blocking note). GitHub runs one or the other, and a step declaring
       * both meant the run allowlist and the action allowlist each judged half
       * a step while believing they had judged it.
       */
      if (uses !== undefined && run !== undefined) {
        return refuse(`a step in job ${JSON.stringify(name)} declares both uses: and run:`);
      }
      if (uses !== undefined && run === undefined) {
        /**
         * A PIN SAYS WHICH VERSION, NOT WHOSE CODE (round-9 review, HIGH 4).
         * Checked here rather than in `checkActionPins`, because "may this
         * action appear at all" is a question about what the workflow may
         * CONTAIN, which is what this gate is for.
         */
        if (typeof uses !== "string" || !ALLOWED_ACTIONS.includes(actionName(uses))) {
          return refuse(
            `a step in job ${JSON.stringify(name)} uses ${JSON.stringify(typeof uses === "string" ? actionName(uses) : uses)}, which is not an action this policy reasons about`,
          );
        }
      }
      const withBlock = get(step, "with");
      if (withBlock !== undefined) {
        if (typeof uses !== "string") {
          return refuse(`a step in job ${JSON.stringify(name)} passes inputs without naming an action`);
        }
        const allowed = ALLOWED_WITH_KEYS[actionName(uses)];
        if (allowed === undefined) {
          return refuse(`${JSON.stringify(actionName(uses))} is not an action this policy reasons about`);
        }
        if (typeof withBlock === "string" || withBlock.kind !== "map") {
          return refuse(`the inputs to ${JSON.stringify(uses)} are not a mapping`);
        }
        for (const [key, value] of withBlock.entries) {
          if (!allowed.includes(key)) {
            return refuse(
              `${JSON.stringify(actionName(uses))} is given ${JSON.stringify(key)}, which can change what is checked out or how it runs`,
            );
          }
          if (typeof value !== "string") {
            return refuse(
              `${JSON.stringify(actionName(uses))} is given ${JSON.stringify(key)} as something other than a single string`,
            );
          }
        }
      }
    }
  }
  return { ok: true };
}

/**
 * The clean room must check out THIS repository, and it must do so first.
 *
 * The round-2 reviewer replaced `actions/checkout` with a second pinned
 * `setup-node` and every check stayed green — a workflow that verifies nothing
 * because nothing was fetched. Requiring the action is not enough on its own:
 * `with: repository:` would point it at somebody else's code, which the shape
 * allowlist above now refuses.
 */
export function checkCheckout(root: YamlMap): PolicyVerdict {
  const uses = steps(root)
    .map((step) => get(step, "uses"))
    .filter((value): value is string => typeof value === "string");
  const checkouts = uses.filter((value) => actionName(value) === "actions/checkout");
  if (checkouts.length === 0) {
    return refuse("the workflow never checks out the repository, so it would verify whatever the runner already had");
  }
  if (checkouts.length > 1) {
    return refuse("the workflow checks out more than once, so what is verified is ambiguous");
  }
  /**
   * THE FIRST STEP, not the first ACTION (round-3 review, HIGH 3). Filtering to
   * `uses:` steps meant a `run:` step before the checkout was invisible, so
   * `- run: npm test` could execute against whatever the runner already had
   * and the ordering check saw nothing wrong.
   */
  const firstStep = steps(root)[0];
  const firstUses = firstStep === undefined ? undefined : get(firstStep, "uses");
  if (typeof firstUses !== "string" || actionName(firstUses) !== "actions/checkout") {
    return refuse("the checkout is not the first step, so an earlier step could act on an unfetched tree");
  }
  return { ok: true };
}

/**
 * AC-3. The clean room inherits NO REPOSITORY-LOCAL GIT CONFIGURATION
 * (round-9 review, HIGH 1).
 *
 * The criterion says this in as many words, and nothing checked it. The pinned
 * `actions/checkout` defaults `persist-credentials` to true, which writes the
 * job's token into `.git/config` as an `http.extraheader` — so every later step
 * runs against a checkout carrying a credential, and `npm test` executes
 * repository code with that credential sitting in the tree it was handed.
 *
 * `permissions: contents: read` bounds what the token can DO, and bounding a
 * credential is not the same as not having one: AC-3 is about what the room
 * inherits, not about how much damage the inheritance would allow.
 *
 * REQUIRED EXPLICITLY, not merely "not set to true". A default is a decision
 * somebody else gets to change — the action's next release could flip it — and
 * the whole point of pinning is that what runs here does not change without a
 * change here. Writing it out means the file states the property it relies on.
 */
export function checkCheckoutCredentials(root: YamlMap): PolicyVerdict {
  for (const step of steps(root)) {
    const uses = get(step, "uses");
    if (typeof uses !== "string" || actionName(uses) !== "actions/checkout") continue;
    const persist = get(get(step, "with"), "persist-credentials");
    if (persist === undefined) {
      return refuse(
        "the checkout does not set persist-credentials, so it defaults to leaving the job's token in the repository's git configuration",
      );
    }
    if (persist !== "false") {
      return refuse(
        `the checkout sets persist-credentials: ${JSON.stringify(String(persist))}, so the job's token is written into the repository's git configuration`,
      );
    }
  }
  return { ok: true };
}

/**
 * Every command is on the allowlist, exactly.
 *
 * `command npm install` defeated a check that looked for commands STARTING
 * with npm, and `./node_modules/.bin/tsc -p tsconfig.json` defeated one that
 * looked for `tsc` as a word. Both are shell-execution details, and modelling
 * shell parsing would be another guessing machine. The set of commands this
 * workflow legitimately runs is two, so it is written down.
 */
export function checkRunAllowlist(root: YamlMap): PolicyVerdict {
  if (stepValues(root, "run") === undefined) {
    return refuse("a step gives run: something other than a single command, so the allowlist cannot judge it");
  }
  for (const command of declaredRunCommands(root)) {
    if (!ALLOWED_RUN_COMMANDS.includes(command.trim())) {
      return refuse(
        `the workflow runs ${JSON.stringify(command.trim())}, which is not one of the commands this policy allows`,
      );
    }
  }
  return { ok: true };
}

// ------------------------------------------------------------------- policies

/**
 * AC-1. Runners GitHub does not meter for a public repository.
 *
 * An ALLOWLIST, not a denylist of known-expensive labels: a label nobody
 * anticipated is unknown, and unknown is refused. The failure to prefer is
 * refusing a runner that would have been free, not accepting one that bills.
 */
export const FREE_RUNNER_LABELS: readonly string[] = ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"];

export function checkRunners(root: YamlMap): PolicyVerdict {
  const jobs = get(root, "jobs");
  if (jobs === undefined || typeof jobs === "string" || jobs.kind !== "map" || jobs.entries.length === 0) {
    return refuse("the workflow declares no jobs");
  }
  for (const [name, job] of jobs.entries) {
    const runsOn = get(job, "runs-on");
    if (typeof runsOn !== "string") {
      return refuse(`job ${JSON.stringify(name)} does not name a single runner label`);
    }
    if (!FREE_RUNNER_LABELS.includes(runsOn)) {
      return refuse(
        `job ${JSON.stringify(name)} runs on ${JSON.stringify(runsOn)}, which is not a runner this repository knows to be unmetered`,
      );
    }
  }
  return { ok: true };
}

/** AC-6. Every action pinned to an immutable commit, never a tag or branch. */
/**
 * `{owner}/{repo}@{40-hex}`, and nothing that merely looks like it.
 *
 * A LOCAL ACTION PATH IS NOT A PIN (round-8 review, HIGH 3).
 * `./.github/actions/evil@aaa…` satisfied the old shape while GitHub resolves
 * it from the repository rather than from a pinned commit — the `@` and the hex
 * are decoration on a path. Owner and repo may not contain `.` segments or
 * slashes, so the shape is stated instead of approximated.
 */
const COMMIT_PIN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?@[0-9a-f]{40}$/;

export function checkActionPins(root: YamlMap): PolicyVerdict {
  const used = stepValues(root, "uses");
  if (used === undefined) {
    return refuse("a step names an action as something other than a single string, so it cannot be checked for a pin");
  }
  if (used.length === 0) {
    // Not an error: a workflow using no actions has nothing to pin. Said out
    // loud so a reader does not mistake "nothing to check" for "checked".
    return { ok: true };
  }
  for (const uses of used) {
    if (!COMMIT_PIN.test(uses)) {
      return refuse(`${JSON.stringify(uses)} is not pinned to a 40-character commit id`);
    }
  }
  return { ok: true };
}

/** AC-5. The events a human-created pull request raises, plus branch pushes. */
/**
 * The activity types a pull request must still trigger on.
 *
 * `opened` and `synchronize` are creation and update — the two moments a
 * candidate appears or changes. A workflow narrowed to `closed` is documented
 * as valid and produces no evidence for either.
 */
const REQUIRED_PR_TYPES: readonly string[] = ["opened", "synchronize"];

/**
 * A LIST OF STRINGS, or nothing — never the strings out of a list that also
 * held something else.
 *
 * This replaced `items.filter(item => typeof item === "string")`, and the
 * difference is the whole point of the new boundary. Under the hand-written
 * reader a nested `- ["!**"]` was refused as unreadable SYNTAX, so the filter
 * was never reached. A standards parser reads it correctly — as a sequence
 * inside a sequence — and the filter then THREW IT AWAY and reported on the
 * remainder, so `["**", ["!**"]]` was judged as `["**"]` and passed.
 *
 * That is the same defect the parser replacement was meant to end, one layer up:
 * discarding what you cannot interpret and describing the rest is a misread, not
 * a check. So a list this policy cannot read as patterns is REFUSED.
 */
function stringList(node: YamlNode | undefined): readonly string[] | undefined {
  if (node === undefined || typeof node === "string" || node.kind !== "seq") return undefined;
  const values: string[] = [];
  for (const item of node.items) {
    if (typeof item !== "string") return undefined;
    values.push(item);
  }
  return values;
}

export function checkTriggers(root: YamlMap): PolicyVerdict {
  const on = get(root, "on");
  const declared = mapKeys(on);
  for (const required of ["pull_request", "push"]) {
    if (!declared.includes(required)) {
      return refuse(`the workflow does not trigger on ${required}, so it would produce no evidence for one`);
    }
  }

  /**
   * AN EVENT NAME IS NOT A TRIGGER (round-1 review, HIGH 3). `types` narrows
   * which activity fires the workflow and `branches-ignore` can exclude
   * everything, so a workflow can name both events and run for neither.
   */
  for (const event of ["pull_request", "push"]) {
    const config = get(on, event);
    if (config === undefined) {
      continue;
    }
    /**
     * A SCALAR CONFIG IS REFUSED, NOT SKIPPED (round-9 review, HIGH 2). This
     * `continue` and the one in `checkWorkflowShape` were the same waiver
     * written twice, so `push: anything` passed both. Two independent checks
     * that skip identically are one check.
     */
    if (typeof config === "string") {
      return refuse(`${event} is configured as ${JSON.stringify(config)} rather than a mapping of filters`);
    }
    /**
     * A SEQUENCE IS NOT A FILTER BLOCK EITHER (round-10 review, HIGH).
     *
     * Round 9 found this check skipping SCALAR configs and I fixed the scalar
     * case, leaving `if (config.kind === "map")` with no else — so `push: []`
     * and `push: [anything]` still fell straight through to `return ok`. I
     * fixed the reported spelling of the bug rather than the bug, which is the
     * specific hazard of writing a fix against a reproduction.
     */
    if (config.kind !== "map") {
      return refuse(`${event} is configured as a sequence rather than a mapping of filters`);
    }
    /**
     * AND THE PER-EVENT VOCABULARY IS CHECKED HERE TOO, not only at the shape
     * gate. `push: {types: [...]}` was refused by `checkWorkflowShape` and
     * waved through by this function, so the trigger guard was closed only for
     * as long as something else happened to run first. Two checks are worth
     * having only if each is independently sound; otherwise they are one check
     * and a comment claiming there are two.
     */
    const allowedForEvent = ALLOWED_EVENT_KEYS[event] ?? [];
    for (const [key] of config.entries) {
      if (!allowedForEvent.includes(key)) {
        return refuse(
          `${event} declares ${JSON.stringify(key)}, which is not a filter this policy reasons about for that event`,
        );
      }
    }
    {
      const ignored = get(config, "branches-ignore");
      if (ignored !== undefined) {
        return refuse(
          `${event} uses branches-ignore, which can exclude every branch this evidence is needed for`,
        );
      }
      const branches = get(config, "branches");
      if (branches !== undefined) {
        const listed = stringList(branches);
        if (listed === undefined) {
          return refuse(`${event} declares branches this policy cannot read as a list of patterns`);
        }
        const patterns = listed;
        if (!patterns.includes("**")) {
          return refuse(
            `${event} is limited to ${JSON.stringify(patterns)}, so a candidate on another branch produces no evidence`,
          );
        }
        /**
         * A NEGATIVE PATTERN UNDOES THE WILDCARD IT FOLLOWS (round-2 review,
         * HIGH 4). GitHub documents a later `!` pattern as excluding earlier
         * matches, so `["**", "!**"]` names every branch and then removes every
         * branch — and a check that only asked whether `**` was PRESENT found
         * it present and was satisfied.
         */
        const excluded = patterns.filter((pattern) => pattern.startsWith("!"));
        if (excluded.length > 0) {
          return refuse(
            `${event} excludes ${JSON.stringify(excluded)}, which can remove the branches the wildcard just included`,
          );
        }
      }
      if (event === "pull_request") {
        const types = get(config, "types");
        if (types !== undefined) {
          const declaredTypes = stringList(types);
          if (declaredTypes === undefined) {
            return refuse("pull_request declares types this policy cannot read as a list of activity names");
          }
          for (const required of REQUIRED_PR_TYPES) {
            if (!declaredTypes.includes(required)) {
              return refuse(
                `pull_request does not trigger on ${required}, so a ${required === "opened" ? "new" : "updated"} pull request produces no evidence`,
              );
            }
          }
        }
      }
    }
  }
  return { ok: true };
}

/** AC-7. No secret is referenced, and no permission beyond reading contents. */
/** Every scalar the parsed document holds, wherever it sits. */
function allScalars(node: YamlNode): readonly string[] {
  if (typeof node === "string") return [node];
  if (node.kind === "seq") return node.items.flatMap(allScalars);
  return node.entries.flatMap(([key, value]) => [key, ...allScalars(value)]);
}

export function checkPermissions(root: YamlMap, source: string): PolicyVerdict {
  /**
   * THE RAW TEXT AND THE PARSED VALUES, because they can disagree (round-3
   * review, CRITICAL 2). The raw scan alone missed `secrets\x2eSENSITIVE`; the
   * escape refusal above now stops that spelling reaching here at all, and this
   * checks the values as well so the two are independent.
   */
  /**
   * EVERY WAY OF NAMING THE CONTEXT (round-6 review, CRITICAL 1).
   * `secrets.NAME` was matched and `secrets['NAME']` was not — GitHub supports
   * index syntax for context access, so the two are the same reference spelled
   * differently.
   */
  const SECRET_REFERENCE = /\bsecrets\s*(\.|\[)/;
  if (SECRET_REFERENCE.test(source) || allScalars(root).some((value) => SECRET_REFERENCE.test(value))) {
    return refuse("the workflow references a secret; a verification run needs none");
  }
  const permissions = get(root, "permissions");
  if (permissions === undefined) {
    return refuse("the workflow declares no permissions block, so it inherits whatever the repository grants");
  }
  if (typeof permissions === "string") {
    return refuse(`permissions is ${JSON.stringify(permissions)} rather than an explicit least-privilege mapping`);
  }
  /**
   * A SEQUENCE IS NOT A MAPPING (round-1 review, non-blocking note). The loop
   * below iterated an empty list for a sequence and returned ok, so a
   * `permissions:` written as a list passed while granting nothing legible.
   */
  if (permissions.kind !== "map") {
    return refuse("permissions is a sequence rather than a mapping of scope to access");
  }
  for (const [scope, value] of permissions.entries) {
    if (scope !== "contents") {
      return refuse(`the workflow grants ${JSON.stringify(scope)}, which a verification run does not need`);
    }
    if (value !== "read") {
      return refuse(`the workflow grants contents: ${JSON.stringify(String(value))} rather than read`);
    }
  }
  return { ok: true };
}

/**
 * A step, read as the thing that either RUNS OR DOES NOT (round-1 review,
 * CRITICAL 1).
 *
 * The first version collected `run:` strings and nothing else, so a step
 * carrying `if: ${{ false }}` — which GitHub documents as preventing the step
 * from running at all — satisfied every command check while executing nothing.
 * `continue-on-error: true` was the same defect pointing the other way: the
 * step runs, fails, and the job passes anyway.
 *
 * So the shape a policy needs is not "which commands appear" but "which
 * commands run, unconditionally, and whose failure fails the job".
 */
export interface WorkflowStep {
  readonly uses: string | undefined;
  readonly run: string | undefined;
  /** Present at all means conditional, which means it may not run. */
  readonly condition: string | undefined;
  readonly continueOnError: string | undefined;
  readonly withNodeVersion: string | undefined;
}

export function workflowSteps(root: YamlMap): readonly WorkflowStep[] {
  return steps(root).map((step) => {
    const uses = get(step, "uses");
    const run = get(step, "run");
    const condition = get(step, "if");
    const continueOnError = get(step, "continue-on-error");
    const nodeVersion = get(get(step, "with"), "node-version");
    return {
      uses: typeof uses === "string" ? uses : undefined,
      run: typeof run === "string" ? run : undefined,
      condition: typeof condition === "string" ? condition : undefined,
      continueOnError: typeof continueOnError === "string" ? continueOnError : undefined,
      withNodeVersion: typeof nodeVersion === "string" ? nodeVersion : undefined,
    };
  });
}

/**
 * Steps that genuinely run and whose failure fails the job.
 *
 * A CONDITION OF ANY KIND disqualifies a step, rather than this trying to
 * evaluate the expression. `${{ false }}` is obvious; `${{ github.event_name
 * == 'schedule' }}` is not, and a checker that decided which conditions were
 * "safe" would be evaluating GitHub's expression language — which is exactly
 * the guessing the parser refuses to do. A verification step has no business
 * being conditional, so requiring none costs nothing real.
 */
export function loadBearingSteps(root: YamlMap): readonly WorkflowStep[] {
  return workflowSteps(root).filter(
    (step) => step.condition === undefined && step.continueOnError !== "true",
  );
}

/** Commands from steps that actually run and whose failure counts. */
export function runCommands(root: YamlMap): readonly string[] {
  return loadBearingSteps(root)
    .map((step) => step.run)
    .filter((value): value is string => typeof value === "string");
}

/** Every `run:` command, including ones that would not execute. */
export function declaredRunCommands(root: YamlMap): readonly string[] {
  return workflowSteps(root)
    .map((step) => step.run)
    .filter((value): value is string => typeof value === "string");
}

/**
 * AC-3/AC-4 rest on this: a step whose failure does not fail the job is not
 * verification, whatever it runs.
 */
export function checkStepExecution(root: YamlMap): PolicyVerdict {
  for (const step of workflowSteps(root)) {
    if (step.continueOnError === "true") {
      return refuse(
        `a step declares continue-on-error: true, so its failure would not fail the job`,
      );
    }
  }
  return { ok: true };
}

/** AC-3. Installed from the lockfile, never resolved afresh. */
/**
 * Every spelling npm accepts for `install` (round-1 review, HIGH 4).
 *
 * `npm i` is an official alias and slipped straight past a check written for
 * the long form. npm also accepts a family of typo-tolerant abbreviations, so
 * the list is taken from its documented aliases rather than guessed at.
 */
/**
 * `isnt` WAS MISSING (round-11 review, HIGH).
 *
 * The list ran `isnta`, `isntal`, `isntall` and skipped the shortest of the
 * three, which is the sort of omission that survives a reading because the
 * neighbours look complete. `npm help install` is the authority and gives:
 * add, i, in, ins, inst, insta, instal, isnt, isnta, isntal, isntall.
 *
 * `tests/workflowPolicy.test.ts` now transcribes that list INDEPENDENTLY and
 * asserts this one covers it. Two transcriptions of the same source disagree
 * loudly; the previous test iterated THIS constant, so an alias missing from it
 * was missing from its own coverage too and the case passed vacuously.
 */
export const INSTALL_ALIASES: readonly string[] = [
  "install", "i", "in", "ins", "inst", "insta", "instal",
  "isnt", "isnta", "isntal", "isntall", "add",
];

function isNpmSubcommand(command: string, subcommands: readonly string[]): boolean {
  const match = /^npm\s+([a-z-]+)\b/.exec(command.trim());
  return match !== null && subcommands.includes(match[1] ?? "");
}

export function checkInstall(root: YamlMap): PolicyVerdict {
  /**
   * A COMMAND THIS GUARD CANNOT READ IS REFUSED HERE (round-13 review, note).
   *
   * `declaredRunCommands` drops a non-string `run:`, so `run: [evil]` beside a
   * valid `npm ci` left this check returning ok. `checkWorkflowShape` and
   * `checkRunAllowlist` both refuse it, so there was no full-policy survivor —
   * but "refused by a sibling" is not "this guard holds", and that distinction
   * has been the finding in three of the last five rounds.
   */
  if (stepValues(root, "run") === undefined) {
    return refuse("a step gives run: something other than a single command, so the install cannot be judged");
  }
  /**
   * DECLARED commands, not merely load-bearing ones: a conditional
   * `npm install` is still an `npm install` in the file, and AC-3 forbids it
   * outright rather than forbidding it only when it runs.
   */
  for (const command of declaredRunCommands(root)) {
    if (isNpmSubcommand(command, INSTALL_ALIASES)) {
      return refuse(
        `the workflow runs ${JSON.stringify(command.trim())}, which may resolve differently than the lockfile records`,
      );
    }
  }
  /**
   * And the install must be EXACT and load-bearing. `echo npm ci` contains the
   * words and installs nothing, which is why this compares the whole command
   * rather than searching inside it.
   */
  if (!runCommands(root).some((command) => command.trim() === "npm ci")) {
    return refuse(
      "no step runs exactly `npm ci` unconditionally, so the dependencies are not provably the lockfile's",
    );
  }
  return { ok: true };
}

/**
 * AC-4. The verification CI runs is the verification developers run.
 *
 * A second definition of "verified" is the defect this exists to prevent, so
 * invoking the underlying tools directly is refused even though it would
 * "work" — precisely because it would work while meaning something else.
 */
export function checkVerificationCommand(root: YamlMap): PolicyVerdict {
  /** The same refusal as `checkInstall`, and for the same reason. */
  if (stepValues(root, "run") === undefined) {
    return refuse("a step gives run: something other than a single command, so the verification cannot be judged");
  }
  for (const command of declaredRunCommands(root)) {
    if (/\bnode\s+--test\b/.test(command) || /(^|\s)(npx\s+)?tsc\b/.test(command) || /\bverify\.mjs\b/.test(command)) {
      return refuse(
        `the workflow runs ${JSON.stringify(command.trim())} directly, which is a second definition of "verified"`,
      );
    }
  }
  /**
   * EXACT, UNCONDITIONAL, AND FAILING THE JOB (round-1 review, CRITICAL 1).
   *
   * `npm test` under `if: ${{ false }}` never runs; under
   * `continue-on-error: true` it runs and its failure is ignored; `echo npm
   * test` merely contains the words. None of the three verifies anything, and
   * all three satisfied the previous substring search.
   */
  if (!runCommands(root).some((command) => command.trim() === "npm test")) {
    return refuse(
      "no step runs exactly `npm test` unconditionally with its failure counting, so nothing is verified",
    );
  }
  return { ok: true };
}

/**
 * AC-2. The Node version is pinned, and satisfies `engines.node`.
 *
 * Only the `>=` form is understood, because that is what this repository
 * declares; any other range refuses rather than being approximated, for the
 * same reason the parser refuses constructs it does not implement.
 */
export function checkNodePin(root: YamlMap, enginesRange: string | undefined): PolicyVerdict {
  /**
   * THE PIN MUST BE ON `setup-node` (round-1 review, HIGH 2).
   *
   * `with: node-version:` on any other action configures that action and does
   * nothing to the runner's Node. The previous version accepted the key
   * wherever it appeared, so moving it to an unrelated pinned action left the
   * runner's Node unpinned while every check passed.
   */
  /**
   * LOAD-BEARING setup-node steps only (round-2 review, CRITICAL 1). A
   * `setup-node` under `if: ${{ false }}` pins nothing, and the previous
   * version counted it.
   */
  const pinned = loadBearingSteps(root)
    .filter((step) => step.uses !== undefined && /^actions\/setup-node@/.test(step.uses))
    .map((step) => step.withNodeVersion)
    .filter((value): value is string => typeof value === "string");
  if (pinned.length === 0) {
    return refuse(
      "no actions/setup-node step pins a node-version, so the runner would use whatever its image ships",
    );
  }
  /**
   * AND IT MUST PIN BEFORE ANYTHING USES NODE (round-12 review, HIGH 2).
   *
   * `setup-node` placed after `npm ci` and `npm test` pins nothing that matters:
   * both commands have already run on whatever Node the runner image ships, and
   * the step then helpfully installs the right version for the steps that no
   * longer exist. Every check passed on such a workflow, because this function
   * asked only whether a pinning step EXISTED.
   *
   * The same defect `checkCheckout` had in round 3, in the same shape: presence
   * where the question was ORDER. Fixed the same way, by looking at the step
   * sequence rather than at a filtered subset of it.
   */
  const ordered = loadBearingSteps(root);
  const firstPin = ordered.findIndex(
    (step) => step.uses !== undefined && /^actions\/setup-node@/.test(step.uses) && step.withNodeVersion !== undefined,
  );
  const firstRun = ordered.findIndex((step) => step.run !== undefined);
  if (firstRun !== -1 && firstPin > firstRun) {
    return refuse(
      `the workflow runs ${JSON.stringify(ordered[firstRun]?.run?.trim() ?? "")} before actions/setup-node pins a version, so it would use whatever Node the runner image ships`,
    );
  }
  if (enginesRange === undefined) {
    return refuse("package.json declares no engines.node, so the pin cannot be checked against anything");
  }
  const floor = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(enginesRange.trim());
  if (floor === null) {
    return refuse(`engines.node is ${JSON.stringify(enginesRange)}, a range form this check does not implement`);
  }
  const required: readonly number[] = [Number(floor[1]), Number(floor[2]), Number(floor[3])];
  for (const version of pinned) {
    const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
    if (parts === null) {
      return refuse(`the pinned Node version ${JSON.stringify(version)} is not an exact x.y.z version`);
    }
    const actual: readonly number[] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    for (let index = 0; index < 3; index += 1) {
      if (actual[index]! > required[index]!) break;
      if (actual[index]! < required[index]!) {
        return refuse(
          `the workflow pins Node ${version} but package.json requires ${enginesRange}`,
        );
      }
    }
  }
  return { ok: true };
}
