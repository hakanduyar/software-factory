#!/usr/bin/env node
// Finite offline source-attribution rubric (4 fixed cases). See
// docs/evaluations/source-attribution-v1.md. Reads exactly two explicit files;
// writes only JSON to stdout. No network, provider, env or file discovery.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const RUBRIC = "source-attribution";
const VERSION = 1;
const TOTAL = 4;
const MAX_BYTES = 1_000_000;
const REQUIRED = [
  ["known-answer", "calibration-color", "known"],
  ["stale", "calibration-color-from-old", "stale"],
  ["conflict", "calibration-direction", "conflict"],
  ["unsupported", "deployment-authorized", "unsupported"],
];
const LIMITS = [
  "Four fixed synthetic structured-assertion cases only; not a general evaluation framework.",
  "Cannot authenticate external provenance: it checks citations against the pinned fixture, not real-world origin.",
  "Cannot grade arbitrary freeform answers or semantics; only status, value and citation objects are compared.",
  "Says nothing about token cost, savings, model consumption, hallucination elimination or task approval; callers must still independently review actual useful tasks.",
];

class Malformed extends Error {
  constructor(code) { super(code); this.code = code; }
}
const bad = (code) => { throw new Malformed(code); };
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOnly = (o, keys) => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.hasOwn(o, x));
};
const isSha = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isId = (v) => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
const isRev = (v) => Number.isInteger(v) && v >= 1;

function parseArgs(argv) {
  if (argv.length !== 4) bad("ARGS_INVALID");
  const out = {};
  for (let i = 0; i < 4; i += 2) {
    const flag = argv[i];
    if ((flag !== "--fixture" && flag !== "--responses") || Object.hasOwn(out, flag) || !argv[i + 1]) bad("ARGS_INVALID");
    out[flag] = argv[i + 1];
  }
  return { fixture: out["--fixture"], responses: out["--responses"] };
}

function readJson(path, code) {
  let text;
  try {
    if (statSync(path).size > MAX_BYTES) bad(code + "_TOO_LARGE");
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof Malformed) throw e;
    bad(code + "_UNREADABLE");
  }
  try { return JSON.parse(text); } catch { return bad(code + "_NOT_JSON"); }
}

const citeOf = (s) => ({ sourceId: s.sourceId, revision: s.revision, contentSha256: s.contentSha256 });

function validateFixture(fx) {
  if (!isObj(fx) || fx.rubric !== RUBRIC || fx.version !== VERSION) bad("FIXTURE_IDENTITY");
  if (!Array.isArray(fx.sources) || !Array.isArray(fx.cases)) bad("FIXTURE_SHAPE");
  const sources = new Map();
  for (const s of fx.sources) {
    if (!isObj(s) || !hasOnly(s, ["sourceId", "revision", "lineageId", "current", "supersededBy", "content", "contentSha256"])) bad("FIXTURE_SOURCE_SHAPE");
    if (!isId(s.sourceId) || !isRev(s.revision) || !isId(s.lineageId) || typeof s.current !== "boolean" || typeof s.content !== "string" || !isSha(s.contentSha256)) bad("FIXTURE_SOURCE_SHAPE");
    if (sources.has(s.sourceId)) bad("FIXTURE_SOURCE_DUPLICATE");
    if (createHash("sha256").update(s.content, "utf8").digest("hex") !== s.contentSha256) bad("FIXTURE_SOURCE_HASH_MISMATCH");
    sources.set(s.sourceId, s);
  }
  for (const s of sources.values()) {
    const sb = s.supersededBy;
    if (s.current !== (sb === null)) bad("FIXTURE_LINEAGE_INCONSISTENT");
    if (sb !== null) {
      if (!isObj(sb) || !hasOnly(sb, ["sourceId", "revision"])) bad("FIXTURE_LINEAGE_INCONSISTENT");
      const t = sources.get(sb.sourceId);
      if (!t || !t.current || t.revision !== sb.revision || t.lineageId !== s.lineageId || t.revision <= s.revision) bad("FIXTURE_LINEAGE_INCONSISTENT");
    }
  }
  if (fx.cases.length !== TOTAL) bad("FIXTURE_CASE_SET");
  const cases = new Map();
  for (const c of fx.cases) {
    if (!isObj(c) || !hasOnly(c, ["caseId", "claimId", "kind", "expected"]) || !isObj(c.expected) || !hasOnly(c.expected, ["status", "value", "citations", "reason"])) bad("FIXTURE_CASE_SHAPE");
    const req = REQUIRED.find((r) => r[0] === c.caseId);
    if (!req || req[1] !== c.claimId || req[2] !== c.kind || cases.has(c.caseId)) bad("FIXTURE_CASE_SET");
    const e = c.expected;
    if ((e.status !== "SUPPORTED" && e.status !== "UNKNOWN") || (e.value !== null && typeof e.value !== "string") || typeof e.reason !== "string" || !Array.isArray(e.citations)) bad("FIXTURE_CASE_SHAPE");
    const ids = new Set();
    for (const ci of e.citations) {
      const s = isObj(ci) && hasOnly(ci, ["sourceId", "revision", "contentSha256"]) ? sources.get(ci.sourceId) : undefined;
      if (!s || s.revision !== ci.revision || s.contentSha256 !== ci.contentSha256 || ids.has(ci.sourceId)) bad("FIXTURE_CITATION_INVALID");
      ids.add(ci.sourceId);
    }
    const cur = e.citations.map((ci) => sources.get(ci.sourceId));
    const ok =
      c.kind === "known" ? e.status === "SUPPORTED" && e.value !== null && cur.length === 1 && cur[0].current
      : c.kind === "stale" ? e.status === "UNKNOWN" && e.value === null && cur.length === 1 && !cur[0].current
      : c.kind === "conflict" ? e.status === "UNKNOWN" && e.value === null && cur.length === 2 && cur.every((s) => s.current)
      : e.status === "UNKNOWN" && e.value === null && cur.length === 0;
    if (!ok) bad("FIXTURE_CASE_SEMANTICS");
    cases.set(c.caseId, c);
  }
  return { sources, cases };
}

function validateResponses(rs, sources) {
  if (!isObj(rs) || !hasOnly(rs, ["responses"]) || !Array.isArray(rs.responses)) bad("RESPONSES_SHAPE");
  const byCase = new Map();
  for (const r of rs.responses) {
    if (!isObj(r) || !hasOnly(r, ["caseId", "claimId", "status", "value", "citations"])) bad("RESPONSE_SHAPE");
    const req = REQUIRED.find((x) => x[0] === r.caseId);
    if (!req) bad("RESPONSE_UNKNOWN_CASE");
    if (r.claimId !== req[1]) bad("RESPONSE_CLAIM_MISMATCH");
    if (byCase.has(r.caseId)) bad("RESPONSE_DUPLICATE_CASE");
    if (r.status !== "SUPPORTED" && r.status !== "UNKNOWN") bad("RESPONSE_STATUS_INVALID");
    if (r.value !== null && typeof r.value !== "string") bad("RESPONSE_VALUE_INVALID");
    if (!Array.isArray(r.citations)) bad("RESPONSE_CITATIONS_INVALID");
    const seen = new Set();
    for (const c of r.citations) {
      if (!isObj(c) || !hasOnly(c, ["sourceId", "revision", "contentSha256"]) || !isId(c.sourceId) || !isRev(c.revision) || !isSha(c.contentSha256)) bad("RESPONSE_CITATION_SHAPE");
      if (!sources.has(c.sourceId)) bad("RESPONSE_UNKNOWN_SOURCE");
      if (seen.has(c.sourceId)) bad("RESPONSE_DUPLICATE_CITATION");
      seen.add(c.sourceId);
    }
    byCase.set(r.caseId, r);
  }
  if (byCase.size !== TOTAL) bad("RESPONSE_MISSING_CASE");
  return byCase;
}

function evaluateCase(c, r, sources) {
  const reasons = new Set();
  const e = c.expected;
  if (r.status !== e.status) reasons.add("STATUS_MISMATCH");
  if (r.value !== e.value) reasons.add("VALUE_MISMATCH");
  const want = new Map(e.citations.map((x) => [x.sourceId, x]));
  for (const x of r.citations) {
    const w = want.get(x.sourceId);
    if (!w) { reasons.add("CITATION_UNEXPECTED"); continue; }
    if (x.revision !== w.revision) reasons.add("CITATION_REVISION_MISMATCH");
    if (x.contentSha256 !== sources.get(x.sourceId).contentSha256) reasons.add("CITATION_HASH_MISMATCH");
  }
  const got = new Set(r.citations.map((x) => x.sourceId));
  for (const id of want.keys()) if (!got.has(id)) reasons.add("CITATION_MISSING");
  const sorted = [...reasons].sort();
  return { caseId: c.caseId, claimId: c.claimId, result: sorted.length ? "FAIL" : "PASS", reasonCodes: sorted.length ? sorted : ["OK"] };
}

function report(extra) {
  return { rubric: RUBRIC, version: VERSION, total: TOTAL, limits: LIMITS, ...extra };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { sources, cases } = validateFixture(readJson(args.fixture, "FIXTURE"));
    const byCase = validateResponses(readJson(args.responses, "RESPONSES"), sources);
    const results = REQUIRED.map(([id]) => evaluateCase(cases.get(id), byCase.get(id), sources));
    const passed = results.filter((r) => r.result === "PASS").length;
    process.stdout.write(JSON.stringify(report({ outcome: passed === TOTAL ? "PASS" : "FAIL", passed, failed: TOTAL - passed, cases: results }), null, 2) + "\n");
    process.exitCode = passed === TOTAL ? 0 : 1;
  } catch (e) {
    const code = e instanceof Malformed ? e.code : "INTERNAL_ERROR";
    process.stdout.write(JSON.stringify(report({ outcome: "MALFORMED", errorCode: code, passed: 0, failed: 0, cases: [] }), null, 2) + "\n");
    process.exitCode = 2;
  }
}

main();
