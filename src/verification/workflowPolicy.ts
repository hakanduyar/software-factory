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

/** Constructs this parser deliberately does not implement, and will not guess at. */
const UNSUPPORTED: readonly (readonly [RegExp, string])[] = [
  [/\t/, "a tab, which YAML forbids for indentation"],
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
  [/:\s*!\S/, "a tag"],
  [/^\s*-\s+!\S/, "a tag"],
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
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || line[index - 1] === " ")) {
      return line.slice(0, index);
    }
  }
  return line;
}

function scalar(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
      (text.startsWith("'") && text.endsWith("'") && text.length >= 2)) {
    return text.slice(1, -1);
  }
  return text;
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
          entries.push([head.key, scalar(head.value)]);
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
            entries.push([entry.key, scalar(entry.value)]);
            index += 1;
          } else {
            const nested = parseBlock(lines, index + 1, indent + 4);
            if ("reason" in nested) return nested;
            entries.push([entry.key, nested.node]);
            index = nested.next;
          }
        }
        items.push({ kind: "map", entries });
        continue;
      }
      items.push(scalar(inline));
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
      entries.push([entry.key, scalar(entry.value)]);
      index += 1;
      continue;
    }
    const nested = parseBlock(lines, index + 1, indent + 2);
    if ("reason" in nested) return nested;
    entries.push([entry.key, nested.node]);
    index = nested.next;
  }
  return { node: { kind: "map", entries }, next: index };
}

function parseEntry(text: string): { readonly key: string; readonly value?: string } | undefined {
  const colon = findKeyColon(text);
  if (colon === undefined) return undefined;
  const key = scalar(text.slice(0, colon).trim());
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
const COMMIT_PIN = /^[^@\s]+\/[^@\s]+@[0-9a-f]{40}$/;

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
export function checkTriggers(root: YamlMap): PolicyVerdict {
  const on = get(root, "on");
  const declared = mapKeys(on);
  for (const required of ["pull_request", "push"]) {
    if (!declared.includes(required)) {
      return refuse(`the workflow does not trigger on ${required}, so it would produce no evidence for one`);
    }
  }
  return { ok: true };
}

/** AC-7. No secret is referenced, and no permission beyond reading contents. */
export function checkPermissions(root: YamlMap, source: string): PolicyVerdict {
  if (/secrets\./.test(source)) {
    return refuse("the workflow references a secret; a verification run needs none");
  }
  const permissions = get(root, "permissions");
  if (permissions === undefined) {
    return refuse("the workflow declares no permissions block, so it inherits whatever the repository grants");
  }
  if (typeof permissions === "string") {
    return refuse(`permissions is ${JSON.stringify(permissions)} rather than an explicit least-privilege mapping`);
  }
  for (const [scope, value] of permissions.kind === "map" ? permissions.entries : []) {
    if (scope !== "contents") {
      return refuse(`the workflow grants ${JSON.stringify(scope)}, which a verification run does not need`);
    }
    if (value !== "read") {
      return refuse(`the workflow grants contents: ${JSON.stringify(String(value))} rather than read`);
    }
  }
  return { ok: true };
}

/** Every `run:` command in the workflow, in order. */
export function runCommands(root: YamlMap): readonly string[] {
  return steps(root)
    .map((step) => get(step, "run"))
    .filter((value): value is string => typeof value === "string");
}

/** AC-3. Installed from the lockfile, never resolved afresh. */
export function checkInstall(root: YamlMap): PolicyVerdict {
  const commands = runCommands(root);
  if (commands.some((command) => /\bnpm\s+install\b/.test(command))) {
    return refuse("the workflow runs `npm install`, which may resolve differently than the lockfile records");
  }
  if (!commands.some((command) => /\bnpm\s+ci\b/.test(command))) {
    return refuse("the workflow never runs `npm ci`, so its dependencies are not the lockfile's");
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
  const commands = runCommands(root);
  for (const command of commands) {
    if (/\bnode\s+--test\b/.test(command) || /(^|\s)(npx\s+)?tsc\b/.test(command) || /\bverify\.mjs\b/.test(command)) {
      return refuse(
        `the workflow runs ${JSON.stringify(command)} directly, which is a second definition of "verified"`,
      );
    }
  }
  if (!commands.some((command) => /\bnpm\s+test\b/.test(command))) {
    return refuse("the workflow never runs `npm test`, so it does not run this repository's verification");
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
  const pinned = steps(root)
    .map((step) => get(get(step, "with"), "node-version"))
    .filter((value): value is string => typeof value === "string");
  if (pinned.length === 0) {
    return refuse("the workflow pins no Node version, so it would use whatever the runner image ships");
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
