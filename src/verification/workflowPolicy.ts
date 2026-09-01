/**
 * Reading a GitHub Actions workflow strictly enough to make claims about it
 * (TASK-017).
 *
 * WHY THERE IS A PARSER HERE AT ALL. The criteria say things like "the workflow
 * pins a standard runner" and "every action is pinned to a commit". Those are
 * claims about STRUCTURE, and checking them with substring searches would be
 * checking the text rather than the meaning — `runs-on: ubuntu-latest` inside a
 * comment would satisfy a grep and satisfy nothing else. This repository has no
 * runtime dependencies and adding a YAML library to check one file would be
 * introducing infrastructure the task does not require.
 *
 * SO IT PARSES A SUBSET, AND REFUSES EVERYTHING ELSE. The subset is block
 * mappings, block sequences and plain or quoted scalars, with `#` comments and
 * two-space indentation. Anchors, aliases, tags, flow collections, block
 * scalars, multiple documents and tabs are REJECTED rather than approximated.
 *
 * That refusal is the whole design. A parser that guessed at a construct it did
 * not implement would report structure that is not there, and every check built
 * on it would inherit the guess — the "control true of the mechanism and false
 * of the system" failure, one layer down. A parser that stops instead can be
 * wrong only by refusing a file it could have read, which fails visibly and
 * fails safe.
 */

export type YamlNode = string | YamlMap | YamlSeq;

export interface YamlMap {
  readonly kind: "map";
  readonly entries: readonly (readonly [string, YamlNode])[];
}

export interface YamlSeq {
  readonly kind: "seq";
  readonly items: readonly YamlNode[];
}

export type ParseResult =
  | { readonly ok: true; readonly root: YamlMap }
  | { readonly ok: false; readonly reason: string };

export type PolicyVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function refuse(reason: string): PolicyVerdict {
  return { ok: false, reason };
}

/**
 * Constructs this parser deliberately does not implement, and will not guess at.
 *
 * REDUNDANT FOR THE VERDICT SINCE THE GRAMMAR CLOSED, AND SAID SO PLAINLY.
 * `PLAIN_SCALAR` refuses most of these on its own — mutation showed that
 * removing an individual entry changes no outcome. They are kept for the
 * DIAGNOSTIC: "line 3 uses a flow sequence" sends a reader somewhere, and "not
 * admitted by the grammar" does not. The cases assert those exact reasons, so
 * the entries are load-bearing for the thing they are actually for rather than
 * decoration nobody can tell from its absence.
 */
const UNSUPPORTED: readonly (readonly [RegExp, string])[] = [
  [/\t/, "a tab, which YAML forbids for indentation"],
  /**
   * AN ESCAPE SEQUENCE IS A SCALAR THIS READER CANNOT SEE (round-3 review,
   * CRITICALs 1 and 2).
   *
   * YAML decodes escapes inside double quotes, so `"\\x21**"` is `!**` — a
   * negative branch pattern that excludes every branch — and
   * `"${{ secrets\\x2eSENSITIVE }}"` is a secret reference. Both passed every
   * check, because the reader kept the bytes and the checks looked at the
   * bytes.
   *
   * Refused rather than decoded. A partial decoder that handled `\\x` but not
   * `\\u` would reproduce this defect with a different spelling, and this
   * repository's workflow has no need of an escape.
   */
  /**
   * ANY BACKSLASH, not only the escapes this reader recognised (round-4
   * review). Matching valid escape FORMS meant `"\\q"` — which YAML rejects
   * outright — sailed through as a literal, so the reader accepted a file no
   * YAML parser would. The rule is now the simple one: this workflow has no
   * need of a backslash, so a backslash is refused.
   */
  [/\\/, "a backslash"],
  /**
   * AN EXPRESSION IS NOT A VALUE THIS READER CAN EVALUATE (round-7 review).
   *
   * Three rounds of secret bypasses were three ways of spelling one:
   * `secrets.NAME`, `secrets['NAME']`, `toJSON(secrets)`, and `github.token`
   * which names no secret at all while being one. Matching spellings is the
   * losing game the closed grammar exists to stop playing. This workflow needs
   * no expression, so an expression is refused and the class closes.
   */
  [/\$\{\{/, "a ${{ }} expression"],
  /**
   * Non-ASCII whitespace. `trimStart()` treats U+00A0 and friends as space and
   * YAML does not, so indentation written with them computes a depth the file
   * does not have.
   */
  [/^[ ]*[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/, "non-ASCII whitespace in indentation"],
  [/^\s*---/, "a document marker, so the file may hold more than one document"],
  // An anchor can sit at the start of a line, after a key, or after a dash.
  // The first version matched only the line-initial form, so `base: &a 1` was
  // parsed as the plain scalar "&a 1" — a construct read as something it is
  // not, which is exactly what this list exists to prevent. My own test caught
  // it, which is why the negative cases are here.
  [/^\s*&\S/, "an anchor"],
  [/:\s*&\S/, "an anchor"],
  [/^\s*-\s+&\S/, "an anchor"],
  [/^\s*\*\S/, "an alias"],
  [/:\s*\*\S/, "an alias"],
  [/^\s*-\s+\*\S/, "an alias"],
  /**
   * A BARE `!` IS STILL A TAG (round-6 review). Requiring a non-space after it
   * missed `! ${{ ... }}` — which YAML strips and this reader kept, so the
   * value it reported was not the value GitHub would see.
   */
  [/:\s*!/, "a tag"],
  [/^\s*-\s+!/, "a tag"],
  /**
   * A FLOW COLLECTION IS A FLOW COLLECTION WHEREVER IT SITS (round-6 review).
   * The list caught `key: [...]` and not `- [...]`, so a nested sequence was
   * reported as the STRING `["!**"]` and the trigger check saw nothing wrong.
   */
  [/^\s*-\s*[[{]/, "a flow collection in a sequence item"],
  [/:\s*[|>][-+0-9]*\s*$/, "a block scalar"],
  [/:\s*\{/, "a flow mapping"],
  [/:\s*\[/, "a flow sequence"],
];

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly number: number;
}

/** Strips comments and blank lines, and refuses anything outside the subset. */
function scan(source: string): { readonly ok: true; readonly lines: readonly Line[] } | { readonly ok: false; readonly reason: string } {
  const lines: Line[] = [];
  const raw = source.split("\n");
  for (let index = 0; index < raw.length; index += 1) {
    const original = raw[index] ?? "";
    const number = index + 1;
    for (const [pattern, what] of UNSUPPORTED) {
      if (pattern.test(original)) {
        return { ok: false, reason: `line ${number} uses ${what}, which this reader does not implement` };
      }
    }
    const withoutComment = stripComment(original);
    if (withoutComment.trim().length === 0) {
      continue;
    }
    const indent = withoutComment.length - withoutComment.trimStart().length;
    if (indent % 2 !== 0) {
      return { ok: false, reason: `line ${number} is indented ${indent} spaces; this reader requires multiples of two` };
    }
    lines.push({ indent, text: withoutComment.trim(), number });
  }
  return { ok: true, lines };
}

/**
 * Removes a trailing comment without eating a `#` inside a quoted scalar.
 *
 * Written out rather than done with a regex because "the `#` that starts a
 * comment" is a question about quoting state, and a regex that ignores quoting
 * would silently truncate a value.
 */
function stripComment(line: string): string {
/**
   * QUOTING APPLIES ONLY TO A VALUE THAT OPENS WITH A QUOTE (round-8 review,
   * CRITICAL 1).
   *
   * The previous version began quoting at any `"` or `'` anywhere on the line,
   * so `name: foo "bar # baz` kept its comment while YAML reads `foo "bar` —
   * a quote inside a PLAIN scalar suppresses nothing.
   *
   * THE ORDER BELOW MATTERS, and getting it wrong broke the build once: a
   * whole-line comment is decided FIRST, because
   * `# things a local run might have: no mount` contains a colon, and computing
   * the value boundary before checking for a leading `#` protected that `#`
   * from being stripped at all.
   */
  const indent = line.length - line.trimStart().length;
  if (line[indent] === "#") return "";

  const colon = line.indexOf(": ", indent);
  const valueStart = colon === -1 ? indent : colon + 2;
  const opener = line[valueStart];

  if (opener === '"' || opener === "'") {
    const close = line.indexOf(opener, valueStart + 1);
    // Unterminated: left intact so `scalar()` refuses it with its own reason.
    if (close === -1) return line;
    const hash = line.indexOf(" #", close);
    return hash === -1 ? line : line.slice(0, hash);
  }

  const hash = line.indexOf(" #", Math.max(valueStart - 1, indent));
  return hash === -1 ? line : line.slice(0, hash);
}

/**
 * What a PLAIN scalar may contain, stated as what is ADMITTED.
 *
 * Printable ASCII minus the characters YAML gives structural meaning, and it
 * may not BEGIN with an indicator. `@` and a backtick are reserved by the spec;
 * `|` and `>` open block scalars; `&`, `*`, `!`, `%` are anchors, aliases, tags
 * and directives; `[`, `]`, `{`, `}`, `,` are flow; `#` starts a comment; `-`,
 * `?` and `:` open block structures. `${{` is refused separately because an
 * expression is not a value this reader can evaluate.
 */
const PLAIN_SCALAR = /^[A-Za-z0-9_/.+=~^$][A-Za-z0-9_/.+=~^$ ()'"@:;,!?&*|<>[\]{}\\#$-]*$/;

function scalar(text: string): string | undefined {
  for (const quote of ['"', "'"]) {
    if (text.startsWith(quote)) {
      if (text.length < 2 || !text.endsWith(quote)) return undefined;
      const inner = text.slice(1, -1);
      /**
       * A DOUBLED QUOTE IS AN ESCAPE THIS READER DOES NOT IMPLEMENT. YAML reads
       * `'a''b'` as `a'b`; reporting `a''b` is a misread, and implementing the
       * rule invites the next escape nobody thought about.
       */
      if (inner.includes(quote)) return undefined;
      return inner;
    }
  }
  if (text.length === 0) return text;
  /**
   * A KEY-LOOKING VALUE IS NOT A VALUE. `foo: bar` in value position is a
   * mapping to YAML and a string to the old reader.
   */
  if (/:\s/.test(text)) return undefined;
  return PLAIN_SCALAR.test(text) ? text : undefined;
}

/**
 * Parses one block at `indent`, returning the node and the index after it.
 *
 * Deliberately simple and deliberately strict: anything that is neither a
 * `key:` entry nor a `- ` item at the expected indentation ends the block, and
 * a block that turns out to mix the two is refused by the caller.
 */
function parseBlock(
  lines: readonly Line[],
  start: number,
  indent: number,
): { readonly node: YamlNode; readonly next: number } | { readonly reason: string } {
  const first = lines[start];
  if (first === undefined) {
    return { reason: `expected a value at indentation ${indent} but the file ended` };
  }
  if (first.text.startsWith("- ") || first.text === "-") {
    const items: YamlNode[] = [];
    let index = start;
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.indent !== indent || !(line.text.startsWith("- ") || line.text === "-")) {
        break;
      }
      const inline = line.text === "-" ? "" : line.text.slice(2).trim();
      if (inline.length === 0) {
        const nested = parseBlock(lines, index + 1, indent + 2);
        if ("reason" in nested) return nested;
        items.push(nested.node);
        index = nested.next;
        continue;
      }
      if (inline.includes(": ") || inline.endsWith(":")) {
        // A mapping that begins on the dash line. Its remaining entries are
        // indented two further, which is what `- uses:` + `  with:` looks like.
        const entries: (readonly [string, YamlNode])[] = [];
        const head = parseEntry(inline);
        if (head === undefined) {
          return { reason: `line ${line.number} is not a mapping entry this reader understands` };
        }
        if (head.value !== undefined) {
          const headValue = scalar(head.value);
          if (headValue === undefined) {
            return { reason: `line ${line.number} has an unterminated quoted scalar` };
          }
          entries.push([head.key, headValue]);
          index += 1;
        } else {
          const nested = parseBlock(lines, index + 1, indent + 4);
          if ("reason" in nested) return nested;
          entries.push([head.key, nested.node]);
          index = nested.next;
        }
        while (index < lines.length) {
          const cont = lines[index]!;
          if (cont.indent !== indent + 2) break;
          const entry = parseEntry(cont.text);
          if (entry === undefined) {
            return { reason: `line ${cont.number} is not a mapping entry this reader understands` };
          }
          if (entry.value !== undefined) {
            const entryValue = scalar(entry.value);
            if (entryValue === undefined) {
              return { reason: `line ${cont.number} has an unterminated quoted scalar` };
            }
            entries.push([entry.key, entryValue]);
            index += 1;
          } else {
            const nested = parseBlock(lines, index + 1, indent + 4);
            if ("reason" in nested) return nested;
            entries.push([entry.key, nested.node]);
            index = nested.next;
          }
        }
        /**
         * THE SAME CHECK AS THE ORDINARY MAPPING PATH (round-5 review,
         * CRITICAL 1). I added duplicate detection to one of the two places
         * mappings are built, so `- run: npm ci` / `  run: npm install` was
         * read as the first value and the second silently vanished.
         */
        const duplicateInItem = duplicateKey(entries);
        if (duplicateInItem !== undefined) {
          return { reason: `line ${line.number} declares ${JSON.stringify(duplicateInItem)} more than once` };
        }
        items.push({ kind: "map", entries });
        continue;
      }
      const item = scalar(inline);
      if (item === undefined) {
        return { reason: `line ${line.number} has an unterminated quoted scalar` };
      }
      items.push(item);
      index += 1;
    }
    return { node: { kind: "seq", items }, next: index };
  }

  const entries: (readonly [string, YamlNode])[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      return { reason: `line ${line.number} is indented deeper than its block without a parent key` };
    }
    const entry = parseEntry(line.text);
    if (entry === undefined) {
      return { reason: `line ${line.number} is not a mapping entry this reader understands` };
    }
    if (entry.value !== undefined) {
      const value = scalar(entry.value);
      if (value === undefined) {
        return { reason: `line ${line.number} has an unterminated quoted scalar` };
      }
      entries.push([entry.key, value]);
      index += 1;
      continue;
    }
    /**
     * A KEY WITH NOTHING UNDER IT IS NULL, NOT AN EMPTY MAPPING (round-8
     * review, CRITICAL 2).
     *
     * `permissions:` followed by a sibling key produced `{kind: "map", entries:
     * []}`, so `checkPermissions` iterated nothing and reported an explicit
     * least-privilege block that is not there. YAML calls that null, and a null
     * where a mapping is required is a different thing rather than an empty one.
     *
     * Refused rather than modelled: this reader has no null, and inventing one
     * would give every policy a new case to get wrong.
     */
    const next = lines[index + 1];
    if (next === undefined || next.indent <= indent) {
      return { reason: `line ${line.number} declares ${JSON.stringify(entry.key)} with no value` };
    }
    const nested = parseBlock(lines, index + 1, indent + 2);
    if ("reason" in nested) return nested;
    entries.push([entry.key, nested.node]);
    index = nested.next;
  }
  const duplicate = duplicateKey(entries);
  if (duplicate !== undefined) {
    return { reason: `the mapping declares ${JSON.stringify(duplicate)} more than once` };
  }
  return { node: { kind: "map", entries }, next: index };
}

/**
 * A KEY DECLARED TWICE IS NOT A QUESTION THIS READER MAY ANSWER (round-4
 * review, CRITICAL 1).
 *
 * `get()` returned the FIRST match, so a second `permissions:` granting write
 * was reported as read-only — a confident wrong answer rather than a missing
 * refusal, which is the worse failure. YAML implementations disagree about
 * duplicates and GitHub's is not this one, so the honest move is to refuse
 * rather than pick a winner.
 */
function duplicateKey(entries: readonly (readonly [string, YamlNode])[]): string | undefined {
  const seen = new Set<string>();
  for (const [key] of entries) {
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return undefined;
}

function parseEntry(text: string): { readonly key: string; readonly value?: string } | undefined {
  const colon = findKeyColon(text);
  if (colon === undefined) return undefined;
  const key = scalar(text.slice(0, colon).trim());
  if (key === undefined) return undefined;
  const rest = text.slice(colon + 1).trim();
  if (key.length === 0) return undefined;
  return rest.length === 0 ? { key } : { key, value: rest };
}

/** The colon that separates key from value, ignoring colons inside quotes. */
function findKeyColon(text: string): number | undefined {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ":" && (index + 1 === text.length || text[index + 1] === " ")) {
      return index;
    }
  }
  return undefined;
}

export function parseWorkflow(source: string): ParseResult {
  const scanned = scan(source);
  if (!scanned.ok) return { ok: false, reason: scanned.reason };
  if (scanned.lines.length === 0) return { ok: false, reason: "the workflow is empty" };
  const parsed = parseBlock(scanned.lines, 0, 0);
  if ("reason" in parsed) return { ok: false, reason: parsed.reason };
  if (parsed.next !== scanned.lines.length) {
    const line = scanned.lines[parsed.next];
    return { ok: false, reason: `line ${line?.number ?? "?"} was not consumed; the document is not a single mapping` };
  }
  if (typeof parsed.node === "string" || parsed.node.kind !== "map") {
    return { ok: false, reason: "the workflow's top level is not a mapping" };
  }
  return { ok: true, root: parsed.node };
}

// ---------------------------------------------------------------- navigation

export function get(node: YamlNode | undefined, key: string): YamlNode | undefined {
  if (node === undefined || typeof node === "string" || node.kind !== "map") return undefined;
  for (const [entryKey, value] of node.entries) {
    if (entryKey === key) return value;
  }
  return undefined;
}

function seqItems(node: YamlNode | undefined): readonly YamlNode[] {
  return node !== undefined && typeof node !== "string" && node.kind === "seq" ? node.items : [];
}

function mapKeys(node: YamlNode | undefined): readonly string[] {
  return node !== undefined && typeof node !== "string" && node.kind === "map"
    ? node.entries.map(([key]) => key)
    : [];
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
const ALLOWED_EVENT_KEYS: readonly string[] = ["branches", "types"];
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
const ALLOWED_WITH_KEYS: Readonly<Record<string, readonly string[]>> = {
  "actions/checkout": ["persist-credentials"],
  "actions/setup-node": ["node-version"],
};
/** The only commands this workflow may run. */
const ALLOWED_RUN_COMMANDS: readonly string[] = ["npm ci", "npm test"];

function actionName(uses: string): string {
  return uses.split("@")[0] ?? uses;
}

export function checkWorkflowShape(root: YamlMap): PolicyVerdict {
  for (const [key] of root.entries) {
    if (!ALLOWED_ROOT_KEYS.includes(key)) {
      return refuse(`the workflow declares ${JSON.stringify(key)}, which this policy does not reason about`);
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
    if (config === undefined || typeof config === "string") continue;
    if (config.kind !== "map") {
      return refuse(`the filters for ${event} are not a mapping`);
    }
    for (const [key] of config.entries) {
      if (!ALLOWED_EVENT_KEYS.includes(key)) {
        return refuse(
          `${event} uses ${JSON.stringify(key)}, which can stop the workflow running and is not reasoned about here`,
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
      for (const [key] of step.entries) {
        if (!ALLOWED_STEP_KEYS.includes(key)) {
          return refuse(
            `a step in job ${JSON.stringify(name)} declares ${JSON.stringify(key)}, which can change whether it runs or whether its failure counts`,
          );
        }
      }
      const uses = get(step, "uses");
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
        for (const [key] of withBlock.entries) {
          if (!allowed.includes(key)) {
            return refuse(
              `${JSON.stringify(actionName(uses))} is given ${JSON.stringify(key)}, which can change what is checked out or how it runs`,
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
 * Every command is on the allowlist, exactly.
 *
 * `command npm install` defeated a check that looked for commands STARTING
 * with npm, and `./node_modules/.bin/tsc -p tsconfig.json` defeated one that
 * looked for `tsc` as a word. Both are shell-execution details, and modelling
 * shell parsing would be another guessing machine. The set of commands this
 * workflow legitimately runs is two, so it is written down.
 */
export function checkRunAllowlist(root: YamlMap): PolicyVerdict {
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
  const used = steps(root)
    .map((step) => get(step, "uses"))
    .filter((value): value is string => typeof value === "string");
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
    if (config === undefined || typeof config === "string") {
      continue;
    }
    if (config.kind === "map") {
      const ignored = get(config, "branches-ignore");
      if (ignored !== undefined) {
        return refuse(
          `${event} uses branches-ignore, which can exclude every branch this evidence is needed for`,
        );
      }
      const branches = get(config, "branches");
      if (branches !== undefined) {
        const patterns = branches !== undefined && typeof branches !== "string" && branches.kind === "seq"
          ? branches.items.filter((item): item is string => typeof item === "string")
          : [];
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
          const declaredTypes = typeof types !== "string" && types.kind === "seq"
            ? types.items.filter((item): item is string => typeof item === "string")
            : [];
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
const INSTALL_ALIASES: readonly string[] = [
  "install", "i", "in", "ins", "inst", "insta", "instal",
  "isnta", "isntal", "isntall", "add",
];

function isNpmSubcommand(command: string, subcommands: readonly string[]): boolean {
  const match = /^npm\s+([a-z-]+)\b/.exec(command.trim());
  return match !== null && subcommands.includes(match[1] ?? "");
}

export function checkInstall(root: YamlMap): PolicyVerdict {
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
