/**
 * Reading the shipped workflow, with YAML interpretation delegated to a
 * standards-compliant parser (TASK-017, owner decision after round 8).
 *
 * WHY THIS MODULE EXISTS. Eight review rounds found repeated CRITICAL defects in
 * a hand-written YAML reader, and roughly half were MISREADS — the reader
 * confidently reporting structure the file does not have. Escaped scalars
 * hiding `!**`, `secrets\x2e`, unterminated quotes, non-breaking-space
 * indentation, duplicate keys resolved to the first, flow collections read as
 * strings, a quote inside a plain scalar suppressing a comment, a valueless key
 * read as an empty mapping. Each fix was correct and each was a patch, and the
 * findings did not converge.
 *
 * The owner's decision was not to relax the criteria but to move the trust
 * boundary: YAML 1.2 syntax is now interpreted by `yaml` (a maintained,
 * standards-compliant, dependency-free parser pinned in the lockfile), and this
 * module's only job is to NORMALISE its output into the small structural model
 * the policy layer reasons over.
 *
 * THE NORMALISATION IS CLOSED, and that is the part that stays ours. A real
 * parser produces far more than this model admits — numbers, booleans, nulls,
 * dates, anchors, aliases, explicit tags, multiple documents — and silently
 * coercing any of them would reintroduce exactly the misreads the change is
 * meant to end. So anything outside the model REFUSES, with the parser's own
 * account of what it saw.
 *
 * WHAT THIS IS NOT. It is not a claim that every workflow GitHub accepts is
 * handled. It is a claim that what this reader reports is what the parser read,
 * and that anything it cannot represent faithfully is refused rather than
 * approximated.
 */

import { isAlias, isMap, isPair, isScalar, isSeq, parseAllDocuments, type Node } from "yaml";

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

function refuse(reason: string): ParseResult {
  return { ok: false, reason };
}

/**
 * Structure this model cannot represent, refused rather than coerced.
 *
 * A parser hands back a richer world than the policy layer reasons about, and
 * every coercion is a chance to report something the file does not say. `1.0`
 * and `1` are different strings and the same number; `no` is a string in YAML
 * 1.2 and a boolean in 1.1; a null is not an empty mapping — that last one was
 * a round-8 CRITICAL, where `permissions:` with nothing under it was read as an
 * explicit least-privilege block.
 */
function normalise(node: unknown, path: string): { readonly ok: true; readonly value: YamlNode } | { readonly ok: false; readonly reason: string } {
  if (isAlias(node)) {
    return { ok: false, reason: `${path} uses an alias; this reader does not resolve aliases` };
  }
  const anchor = (node as { anchor?: string } | null)?.anchor;
  if (typeof anchor === "string" && anchor.length > 0) {
    return { ok: false, reason: `${path} carries the anchor &${anchor}; this reader does not resolve anchors` };
  }
  const tag = (node as { tag?: string } | null)?.tag;
  if (typeof tag === "string" && tag.length > 0) {
    return { ok: false, reason: `${path} carries the explicit tag ${tag}; this reader does not interpret tags` };
  }

  if (isScalar(node)) {
    const value = node.value;
    if (typeof value !== "string") {
      /**
       * A NULL IS NOT AN EMPTY MAPPING, and a number is not its own spelling.
       * `permissions:` with nothing under it is null, and reading it as `{}`
       * reported an explicit permissions block that is not in the file.
       */
      return {
        ok: false,
        reason: `${path} is ${value === null ? "null" : typeof value}; this reader represents only string scalars`,
      };
    }
    return { ok: true, value };
  }

  if (isSeq(node)) {
    const items: YamlNode[] = [];
    for (const [index, item] of node.items.entries()) {
      const normalised = normalise(item, `${path}[${index}]`);
      if (!normalised.ok) return normalised;
      items.push(normalised.value);
    }
    return { ok: true, value: { kind: "seq", items } };
  }

  if (isMap(node)) {
    const entries: (readonly [string, YamlNode])[] = [];
    for (const pair of node.items) {
      if (!isPair(pair)) {
        return { ok: false, reason: `${path} holds an entry that is not a key/value pair` };
      }
      const key = pair.key;
      if (!isScalar(key) || typeof key.value !== "string") {
        return { ok: false, reason: `${path} has a key that is not a plain string` };
      }
      const child = `${path}.${key.value}`;
      if (pair.value === null || pair.value === undefined) {
        return { ok: false, reason: `${child} has no value` };
      }
      const normalised = normalise(pair.value, child);
      if (!normalised.ok) return normalised;
      entries.push([key.value, normalised.value]);
    }
    return { ok: true, value: { kind: "map", entries } };
  }

  return { ok: false, reason: `${path} is a construct this reader does not represent` };
}

export function parseWorkflow(source: string): ParseResult {
  let documents;
  try {
    /**
     * `uniqueKeys` makes a duplicate key an ERROR rather than a silent
     * last-wins or first-wins resolution. Implementations disagree about
     * duplicates and GitHub's is not necessarily this one, so the honest answer
     * is to refuse rather than pick a winner — a round-4 and round-5 finding,
     * now enforced by the parser instead of by hand.
     */
    documents = parseAllDocuments(source, { uniqueKeys: true, version: "1.2" });
  } catch (error) {
    return refuse(`the workflow could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (documents.length === 0) {
    return refuse("the workflow is empty");
  }
  /**
   * ONE DOCUMENT. A stream of several is valid YAML and is not a workflow, and
   * checking only the first would judge a file by a fraction of itself.
   */
  if (documents.length > 1) {
    return refuse(`the file holds ${documents.length} YAML documents; a workflow is one`);
  }

  const document = documents[0]!;
  /**
   * PARSE FAILURE REFUSES. It never means "absent, therefore allowed" — the
   * direction that turns "we could not tell" into "it is fine", which is the
   * failure this whole area keeps producing.
   */
  if (document.errors.length > 0) {
    return refuse(`the workflow is not valid YAML: ${document.errors[0]?.message ?? "unknown error"}`);
  }
  if (document.warnings.length > 0) {
    return refuse(`the workflow parsed with warnings: ${document.warnings[0]?.message ?? "unknown warning"}`);
  }

  const contents = document.contents as Node | null;
  if (contents === null) {
    return refuse("the workflow is empty");
  }

  const normalised = normalise(contents, "the workflow");
  if (!normalised.ok) {
    return refuse(normalised.reason);
  }
  const root = normalised.value;
  if (typeof root === "string" || root.kind !== "map") {
    return refuse("the workflow's top level is not a mapping");
  }
  return { ok: true, root };
}

/** The value for `key`, or `undefined`. Keys are unique by construction above. */
export function get(node: YamlNode | undefined, key: string): YamlNode | undefined {
  if (node === undefined || typeof node === "string" || node.kind !== "map") return undefined;
  for (const [entryKey, value] of node.entries) {
    if (entryKey === key) return value;
  }
  return undefined;
}
