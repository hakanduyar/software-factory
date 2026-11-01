#!/usr/bin/env node
// Offline per-task usage evidence export to a caller-owned local directory.
// Reads one pinned sanitized input file, selects ONE native run identity
// (runId, attempt, ticketSha256) and writes one deterministic Markdown note.
// No network, provider, environment or file discovery. The input is sanitized
// historical reference data, not authentication, acceptance or dispatch
// authority; the supplied SHA-256 protects bytes only.
//
// Persistence posture (see src/adapters/obsidian/acceptedResultNotePersistence.ts):
// caller-owned existing ordinary absolute directory, single writer,
// create-exclusive no-follow, identical readback is EXISTING, changed content
// for the same identity is CONFLICT, never overwrite or delete. No claim of
// safety against an adversary concurrently replacing the directory.
import { createHash } from "node:crypto";
import { constants as fsc } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const SCHEMA = "SanitizedAcceptedWorkAttributionInputs/v1";
const MAX_INPUT_BYTES = 1_000_000;
const MAX_STRING = 2000;
const NOFOLLOW = fsc.O_NOFOLLOW ?? 0;
const FLAGS = ["--input", "--input-sha256", "--run-id", "--attempt", "--ticket-sha256", "--owned-directory"];
const RUN_KEYS = [
  "payloadSha256", "effort", "runId", "startAcknowledged", "attempt", "terminalReason",
  "monetaryCost", "ticketSha256", "exitCode", "sdkReportedOutputTokens", "terminalRef",
  "evidenceGroup", "model", "contribution", "requestFileSha256", "capturedCanonicalRequestSha256",
];

class Refusal extends Error {
  constructor(code, exitCode = 2) { super(code); this.code = code; this.exitCode = exitCode; }
}
const refuse = (code, exitCode) => { throw new Refusal(code, exitCode); };
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isSha = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isStr = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_STRING;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exactKeys = (o, keys) => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.hasOwn(o, x));
};

function parseArgs(argv) {
  if (argv.length !== FLAGS.length * 2) refuse("ARGS_INVALID");
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!FLAGS.includes(flag) || Object.hasOwn(out, flag) || typeof value !== "string" || value === "") refuse("ARGS_INVALID");
    out[flag] = value;
  }
  if (!path.isAbsolute(out["--input"])) refuse("ARGS_INVALID");
  if (!isSha(out["--input-sha256"]) || !isSha(out["--ticket-sha256"])) refuse("ARGS_INVALID");
  if (!/^[1-9][0-9]{0,8}$/.test(out["--attempt"])) refuse("ARGS_INVALID");
  if (out["--run-id"].length > MAX_STRING) refuse("ARGS_INVALID");
  return {
    input: out["--input"],
    inputSha256: out["--input-sha256"],
    runId: out["--run-id"],
    attempt: Number(out["--attempt"]),
    ticketSha256: out["--ticket-sha256"],
    ownedDirectory: out["--owned-directory"],
  };
}

async function readOrdinary(file, code, limit) {
  let st;
  try { st = await lstat(file); } catch { return refuse(code + "_UNREADABLE"); }
  if (!st.isFile()) refuse(code + "_NOT_ORDINARY");
  let handle;
  try {
    handle = await open(file, fsc.O_RDONLY | NOFOLLOW);
    const hst = await handle.stat();
    if (!hst.isFile()) refuse(code + "_NOT_ORDINARY");
    if (limit !== undefined && hst.size > limit) refuse(code + "_TOO_LARGE");
    return await handle.readFile();
  } catch (e) {
    if (e instanceof Refusal) throw e;
    return refuse(code + "_UNREADABLE");
  } finally {
    if (handle) await handle.close();
  }
}

function validateRun(r) {
  if (!isObj(r) || !exactKeys(r, RUN_KEYS)) refuse("INPUT_RUN_SHAPE");
  const ok =
    isStr(r.runId) && Number.isSafeInteger(r.attempt) && r.attempt >= 1 &&
    isSha(r.ticketSha256) && isSha(r.payloadSha256) && isSha(r.requestFileSha256) &&
    isSha(r.capturedCanonicalRequestSha256) &&
    isStr(r.effort) && isStr(r.model) && isStr(r.terminalReason) && isStr(r.evidenceGroup) &&
    isStr(r.contribution) && typeof r.startAcknowledged === "boolean" &&
    Number.isSafeInteger(r.exitCode) && r.monetaryCost === "UNKNOWN" &&
    (r.sdkReportedOutputTokens === null || (Number.isSafeInteger(r.sdkReportedOutputTokens) && r.sdkReportedOutputTokens >= 0)) &&
    isObj(r.terminalRef) && exactKeys(r.terminalRef, ["locator", "sha256"]) &&
    isStr(r.terminalRef.locator) && isSha(r.terminalRef.sha256);
  if (!ok) refuse("INPUT_RUN_SHAPE");
}

const canonical = (v) =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v);

function selectRun(doc, sel) {
  if (!isObj(doc) || doc.schema !== SCHEMA || !Array.isArray(doc.nativeRuns)) refuse("INPUT_SCHEMA");
  doc.nativeRuns.forEach(validateRun);
  const matches = doc.nativeRuns.filter(
    (r) => r.runId === sel.runId && r.attempt === sel.attempt && r.ticketSha256 === sel.ticketSha256,
  );
  if (matches.length === 0) refuse("SELECTOR_NOT_FOUND");
  const first = canonical(matches[0]);
  if (matches.some((m) => canonical(m) !== first)) refuse("SELECTOR_CONFLICT");
  return matches[0];
}

// Untrusted text is rendered inert: only a small safe alphabet is kept; every
// other code point (Markdown, HTML, URL, control, newline, non-ASCII) becomes
// a numeric character reference, so no link, tag, heading or frontmatter forms.
function inert(s) {
  let out = "";
  for (const ch of s) {
    out += /^[A-Za-z0-9 ,_();=+-]$/.test(ch) ? ch : `&#x${ch.codePointAt(0).toString(16).toUpperCase()};`;
  }
  return out;
}

function buildNote(run, inputSha256, noteId) {
  const tokens = run.sdkReportedOutputTokens === null ? "UNKNOWN" : String(run.sdkReportedOutputTokens);
  return [
    "# Task usage evidence",
    "",
    "## Selected native run identity",
    `- Run ID: ${inert(run.runId)}`,
    `- Attempt: ${run.attempt}`,
    `- Ticket SHA-256: ${run.ticketSha256}`,
    `- Note identity SHA-256: ${noteId}`,
    "",
    "## Input",
    `- Schema: ${SCHEMA}`,
    `- Input SHA-256: ${inputSha256}`,
    "- The input is sanitized historical reference data; the SHA-256 protects bytes only.",
    "",
    "## Run record",
    `- Terminal reason: ${inert(run.terminalReason)}`,
    `- Exit code: ${run.exitCode}`,
    `- Start acknowledged: ${run.startAcknowledged}`,
    `- Model: ${inert(run.model)}`,
    `- Effort: ${inert(run.effort)}`,
    `- Evidence group: ${inert(run.evidenceGroup)}`,
    `- Payload SHA-256: ${run.payloadSha256}`,
    `- Request file SHA-256: ${run.requestFileSha256}`,
    `- Captured canonical request SHA-256: ${run.capturedCanonicalRequestSha256} (separately labelled; not asserted byte-identical to the request file hash)`,
    `- Terminal reference locator: ${inert(run.terminalRef.locator)}`,
    `- Terminal reference SHA-256: ${run.terminalRef.sha256}`,
    `- Historical contribution label (caller-supplied inert text from the pinned input): ${inert(run.contribution)}`,
    "",
    "## Usage",
    `- SDK-reported output tokens: ${tokens}`,
    "- Billed tokens: UNKNOWN (SDK-reported output tokens are not total billed tokens)",
    `- Monetary cost: ${run.monetaryCost}`,
    "",
    "## Limits",
    "- Covers this single run identity only; not a global ledger, a monetary total or a comparison.",
    "- Not an acceptance, authentication, provider completion, remote sync or acknowledgement record.",
    "",
  ].join("\n");
}

async function persist(ownedDirectory, noteId, expected) {
  if (!path.isAbsolute(ownedDirectory) || path.resolve(ownedDirectory) !== ownedDirectory) refuse("INVALID_DIRECTORY");
  let root;
  try {
    const st = await lstat(ownedDirectory);
    if (st.isSymbolicLink() || !st.isDirectory()) refuse("INVALID_DIRECTORY");
    root = await realpath(ownedDirectory);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    return refuse("INVALID_DIRECTORY");
  }
  const file = path.join(root, `${noteId}.md`);
  const digest = sha256(expected);
  const result = (status) => ({ status, path: file, sha256: digest, bytes: expected.length });

  let created = false;
  try {
    const handle = await open(file, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | NOFOLLOW, 0o600);
    created = true;
    try { await handle.writeFile(expected); } finally { await handle.close(); }
  } catch (e) {
    if (!created && e && e.code === "EEXIST") {
      let actual;
      try { actual = await readOrdinary(file, "DESTINATION"); } catch { return refuse("INVALID_DESTINATION"); }
      if (!actual.equals(expected)) refuse("CONFLICT", 1);
      return result("EXISTING");
    }
    return refuse("IO_FAILURE", 1);
  }
  let actual;
  try { actual = await readOrdinary(file, "DESTINATION"); } catch { return refuse("IO_FAILURE", 1); }
  if (!actual.equals(expected)) refuse("READBACK_MISMATCH", 1);
  return result("CREATED");
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const bytes = await readOrdinary(args.input, "INPUT", MAX_INPUT_BYTES);
    if (sha256(bytes) !== args.inputSha256) refuse("INPUT_HASH_MISMATCH");
    let doc;
    try { doc = JSON.parse(bytes.toString("utf8")); } catch { refuse("INPUT_NOT_JSON"); }
    const run = selectRun(doc, args);
    const noteId = sha256(Buffer.from(JSON.stringify([run.runId, run.attempt, run.ticketSha256]), "utf8"));
    const note = Buffer.from(buildNote(run, args.inputSha256, noteId), "utf8");
    const result = await persist(args.ownedDirectory, noteId, note);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (e) {
    const code = e instanceof Refusal ? e.code : "INTERNAL_ERROR";
    process.stdout.write(JSON.stringify({ status: "REFUSED", code }, null, 2) + "\n");
    process.exitCode = e instanceof Refusal ? e.exitCode : 2;
  }
}

await main();
