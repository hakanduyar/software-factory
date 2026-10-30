/**
 * IMPLEMENTER-only Worker that maps ONE actual Factory request onto ONE new,
 * independently admitted, supervised source job.
 *
 * Authority boundary (C1/C3/C4/C13): the outcome is execution evidence only.
 * `claimsAcceptanceMet` is always false, the outcome has no DONE/approval
 * vocabulary, and nothing here marks a source queue delivered. The reviewer
 * stays a separately registered worker.
 *
 * Host contract: exactly two injected phases.
 *   prepare(request)        MUST NOT register, reserve, consume, launch or mutate
 *                           the queue, and predicts no reservation. It
 *                           writes a NEW plan carrying
 *                           plan.history.factoryWorkerRequest and obtains a
 *                           fresh independent admission over that whole plan.
 *   executePrepared(prep)   the only call that reaches the production owner.
 * The adapter authenticates the prepared plan/admission/payload against the
 * actual request BEFORE executePrepared, and re-authenticates at handoff.
 * No callback success string is evidence: terminal facts are re-read from
 * immutable artifacts through the injected reader and checked by hash. The
 * reservation/attempt tuple exists only in the launcher's invocation.queueBinding
 * and is validated there after launch, never supplied by prepare.
 *
 * Artifact shapes are the EXISTING source-only launcher/owner ABI, unchanged:
 *   plan        SupervisedCodeSourceOnlyTask/v1 (taskId, sessionId, runDirectory,
 *               payloadPath, operatorPath/operatorSha256, protectedPins[],
 *               editablePins[], history). history.factoryWorkerRequest is the
 *               only addition: the exact four-key full-request binding.
 *   admission   IndependentSupervisedSourceOnlyAdmission/v1 over the FINAL plan.
 *               Matching JSON is not authorization: the host's independent
 *               reviewer authenticates its origin; the launcher and owner
 *               enforce live eligibility. This adapter only cross-checks it.
 *   payload     plaintext UTF-8 consumed by the launcher, pinned in protectedPins.
 *   run files   invocation.json, start.json, terminal.json, stdout.bin and
 *               stderr.bin, all created by the launcher inside runDirectory.
 * Plan, admission and payload are ordinary control files OUTSIDE the run
 * directory, which must not exist until the launcher creates it.
 */

import { createHash } from "node:crypto";

import { ValidationError } from "../../domain/errors.js";
import type { EvidenceDraft } from "../../domain/evidence.js";
import { deepFreeze } from "../../domain/freeze.js";
import type { Worker, WorkerOutcome, WorkerRequest } from "../../ports/worker.js";

export interface SourceJobArtifactRef {
  readonly path: string;
  readonly sha256: string;
}

/**
 * References only: the adapter reads and hashes the actual artifacts itself.
 * jobId comes from the external queue tuple (the plan has no jobId); sessionId/runDirectory/payload
 * are cross-checked against the plan. There is deliberately NO reservationId: the owner creates the
 * reservation (and the launcher the attempt) only after prepare, so that tuple is learned solely from
 * the launcher's immutable invocation.queueBinding after execution.
 */
export interface PreparedSourceJob {
  readonly jobId: string;
  readonly sessionId: string;
  readonly runDirectory: string;
  readonly planRef: SourceJobArtifactRef;
  readonly admissionRef: SourceJobArtifactRef;
  readonly payloadRef: SourceJobArtifactRef;
}

/** Host report of one owner execution; every ref must name an actual launcher run file. */
export interface SourceJobReceipt {
  readonly state: "TERMINAL" | "STILL_RUNNING" | "RECONCILIATION_REQUIRED";
  readonly jobId: string;
  readonly runDirectory: string;
  readonly planSha256: string;
  readonly invocationRef: SourceJobArtifactRef;
  readonly startRef?: SourceJobArtifactRef;
  readonly terminalRef: SourceJobArtifactRef;
  readonly stdoutRef: SourceJobArtifactRef;
  readonly stderrRef: SourceJobArtifactRef;
}

export interface SupervisedSourceJobHost {
  prepare(request: WorkerRequest): Promise<PreparedSourceJob>;
  executePrepared(prepared: PreparedSourceJob): Promise<SourceJobReceipt>;
}

export type SourceJobPathKind = "file" | "directory" | "other" | "missing";

/** Read-only filesystem facts; a missing path still reports canonical/reparse for itself and existing ancestors. */
export interface SourceJobPathFacts {
  readonly kind: SourceJobPathKind;
  /** Fully qualified and already in normalized form. */
  readonly canonical: boolean;
  /** The path or any existing ancestor is a reparse point/symlink. */
  readonly reparse: boolean;
}

export interface SourceJobArtifactReader {
  inspect(artifactPath: string): Promise<SourceJobPathFacts>;
  read(artifactPath: string): Promise<Uint8Array | string>;
}

export interface SupervisedSourceJobWorkerOptions {
  readonly id?: string;
  readonly host: SupervisedSourceJobHost;
  readonly reader: SourceJobArtifactReader;
  /** Admission-expiry clock; defaults to the system clock. */
  readonly clock?: () => Date;
}

export interface FactoryWorkerRequestBinding {
  readonly runId: string;
  readonly workItemId: string;
  readonly role: string;
  readonly requestSha256: string;
}

type Json = Record<string, unknown>;

const MAX_SUMMARY_CHARS = 600;

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursive sorted-key canonical JSON. Unsupported values are refused, never dropped. */
function canonicalize(value: unknown, where: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new ValidationError(`cannot canonicalize non-finite number at ${where}`);
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (let i = 0; i < value.length; i += 1) {
          if (!(i in value)) throw new ValidationError(`cannot canonicalize sparse array at ${where}[${i}]`);
          parts.push(canonicalize(value[i], `${where}[${i}]`));
        }
        return `[${parts.join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new ValidationError(`cannot canonicalize non-plain object at ${where}`);
      }
      const record = value as Json;
      const members = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], `${where}.${key}`)}`);
      return `{${members.join(",")}}`;
    }
    default:
      throw new ValidationError(`cannot canonicalize ${typeof value} value at ${where}`);
  }
}

/** Known optional properties that are undefined are absent; everything else must be representable. */
function normalizeRequest(request: WorkerRequest): unknown {
  if (!Array.isArray(request.acceptanceCriteria)) {
    throw new ValidationError("WorkerRequest.acceptanceCriteria must be an array");
  }
  const { recalledNote, acceptanceCriteria, ...rest } = request;
  return {
    ...rest,
    acceptanceCriteria: acceptanceCriteria.map(({ verifiedByEvidenceId, ...criterion }) =>
      verifiedByEvidenceId === undefined ? criterion : { ...criterion, verifiedByEvidenceId },
    ),
    ...(recalledNote === undefined ? {} : { recalledNote }),
  };
}

/** The one canonical serialization used by hosts (creation) and this adapter (verification). */
export function canonicalWorkerRequestJson(request: WorkerRequest): string {
  return canonicalize(normalizeRequest(request), "WorkerRequest");
}

export function hashWorkerRequest(request: WorkerRequest): string {
  return sha256Hex(Buffer.from(canonicalWorkerRequestJson(request), "utf8"));
}

/** The exact value hosts must place at plan.history.factoryWorkerRequest. */
export function buildFactoryWorkerRequestBinding(request: WorkerRequest): FactoryWorkerRequestBinding {
  return {
    runId: request.runId,
    workItemId: request.workItemId,
    role: request.role,
    requestSha256: hashWorkerRequest(request),
  };
}

function bindingMatches(actual: unknown, expected: FactoryWorkerRequestBinding): boolean {
  if (!isRecord(actual)) return false;
  const keys = Object.keys(actual).sort();
  return (
    keys.join(",") === "requestSha256,role,runId,workItemId" &&
    actual.runId === expected.runId &&
    actual.workItemId === expected.workItemId &&
    actual.role === expected.role &&
    actual.requestSha256 === expected.requestSha256
  );
}

function historyBindingMatches(artifact: Json, expected: FactoryWorkerRequestBinding): boolean {
  return isRecord(artifact.history) && bindingMatches(artifact.history.factoryWorkerRequest, expected);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRef(value: unknown): value is SourceJobArtifactRef {
  return isRecord(value) && nonEmpty(value.path) && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256);
}

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HOST_DEFAULT_REVIEWER = "/root/bounded_state_check";

/** The launcher creates exactly these files in the run directory; nothing else can satisfy evidence. */
const RUN_FILE = {
  invocation: "invocation.json",
  start: "start.json",
  terminal: "terminal.json",
  stdout: "stdout.bin",
  stderr: "stderr.bin",
} as const;

function runFilePath(runDirectory: string, name: string): string {
  return `${runDirectory}${runDirectory.includes("\\") ? "\\" : "/"}${name}`;
}

function refText(ref: SourceJobArtifactRef): string {
  return `${ref.path}#sha256=${ref.sha256}`;
}

function toBuffer(raw: Uint8Array | string): Buffer {
  return typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function assertOrdinaryPath(reader: SourceJobArtifactReader, label: string, artifactPath: string): Promise<SourceJobPathKind> {
  const facts = await reader.inspect(artifactPath);
  if (!facts.canonical) throw new ValidationError(`${label} path is not a canonical absolute path`);
  if (facts.reparse) throw new ValidationError(`${label} path or an ancestor is a reparse point`);
  return facts.kind;
}

/** Ordinary, canonical, non-reparse, existing file whose bytes match the pinned hash. */
async function readPinned(
  reader: SourceJobArtifactReader,
  label: string,
  ref: unknown,
): Promise<{ ref: SourceJobArtifactRef; bytes: Buffer }> {
  if (!isRef(ref)) throw new ValidationError(`${label} reference is missing or malformed`);
  if ((await assertOrdinaryPath(reader, label, ref.path)) !== "file") {
    throw new ValidationError(`${label} is not an existing ordinary file`);
  }
  const bytes = toBuffer(await reader.read(ref.path));
  if (sha256Hex(bytes) !== ref.sha256) {
    throw new ValidationError(`${label} bytes do not match the referenced sha256`);
  }
  return { ref, bytes };
}

async function assertAbsent(reader: SourceJobArtifactReader, label: string, artifactPath: string): Promise<void> {
  if ((await assertOrdinaryPath(reader, label, artifactPath)) !== "missing") {
    throw new ValidationError(`${label} already exists; one fresh not-started job is required and nothing is reused`);
  }
}

function parseUtc(label: string, value: unknown): number {
  const ms = typeof value === "string" && UTC_TIMESTAMP.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) throw new ValidationError(`${label} is not a UTC timestamp`);
  return ms;
}

function parseRecord(label: string, bytes: Buffer): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ValidationError(`${label} is not valid JSON`);
  }
  if (!isRecord(parsed)) throw new ValidationError(`${label} is not a JSON object`);
  return parsed;
}

/** Plain data derived from the authenticated plan/admission; compared again at handoff. */
interface Authenticated {
  readonly planSha256: string;
  readonly admissionSha256: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly runDirectory: string;
  readonly workingDirectory: string;
  readonly protectedPaths: readonly string[];
  readonly editablePaths: readonly string[];
  readonly environmentAllowlist: readonly string[];
  /** Canonical JSON of the exact protectedPins array that was read and hashed. */
  readonly protectedPinsJson: string;
  /** Canonical JSON of the plan's arguments and full history. */
  readonly argumentsJson: string;
  readonly historyJson: string;
}

interface Pin {
  readonly path: string;
  readonly sha256: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readPins(label: string, value: unknown): Pin[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(`prepared plan ${label} must be a non-empty array`);
  }
  const seen = new Set<string>();
  const pins: Pin[] = [];
  for (const entry of value as unknown[]) {
    if (!isRef(entry) || Object.keys(entry).sort().join(",") !== "path,sha256") {
      throw new ValidationError(`prepared plan ${label} entry is not an exact path/sha256 pin`);
    }
    if (seen.has(entry.path)) throw new ValidationError(`prepared plan ${label} repeats ${entry.path}`);
    seen.add(entry.path);
    pins.push({ path: entry.path, sha256: entry.sha256 });
  }
  return pins;
}

function strictUtf8Text(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError("prepared payload is not valid UTF-8 text");
  }
}

async function authenticatePrepared(
  reader: SourceJobArtifactReader,
  prepared: PreparedSourceJob,
  expected: FactoryWorkerRequestBinding,
  now: () => Date,
): Promise<Authenticated> {
  for (const [key, value] of Object.entries({
    jobId: prepared.jobId,
    sessionId: prepared.sessionId,
    runDirectory: prepared.runDirectory,
  })) {
    if (!nonEmpty(value)) throw new ValidationError(`prepared job ${key} is missing`);
  }

  // Control files live outside the not-yet-created run directory; they are not confined to it.
  const plan = await readPinned(reader, "prepared plan", prepared.planRef);
  const admission = await readPinned(reader, "prepared admission", prepared.admissionRef);
  const payload = await readPinned(reader, "prepared payload", prepared.payloadRef);
  const planJson = parseRecord("prepared plan", plan.bytes);
  const admissionJson = parseRecord("prepared admission", admission.bytes);

  if (planJson.schema !== "SupervisedCodeSourceOnlyTask/v1") throw new ValidationError("prepared plan schema is not SupervisedCodeSourceOnlyTask/v1");
  const { taskId, workingDirectory, operatorPath, operatorSha256, protectedPins, editablePins } = planJson;
  if (!nonEmpty(taskId) || !nonEmpty(workingDirectory) || !nonEmpty(operatorPath)) {
    throw new ValidationError("prepared plan taskId/workingDirectory/operatorPath is missing");
  }
  if (typeof operatorSha256 !== "string" || !/^[0-9a-f]{64}$/.test(operatorSha256)) {
    throw new ValidationError("prepared plan operatorSha256 is malformed");
  }
  if (planJson.sessionId !== prepared.sessionId || planJson.runDirectory !== prepared.runDirectory) {
    throw new ValidationError("prepared plan session/runDirectory does not match the prepared job");
  }
  if (planJson.payloadPath !== prepared.payloadRef.path) {
    throw new ValidationError("prepared plan payloadPath does not match the prepared payload");
  }
  const { arguments: planArguments, environmentAllowlist } = planJson;
  if (!isStringArray(planArguments) || !isStringArray(environmentAllowlist)) {
    throw new ValidationError("prepared plan arguments/environmentAllowlist are malformed");
  }
  if (!historyBindingMatches(planJson, expected)) {
    throw new ValidationError("prepared plan history.factoryWorkerRequest does not bind the actual request");
  }
  const qualificationExpiryMs = parseUtc("prepared plan qualificationExpiresUtc", planJson.qualificationExpiresUtc);

  const protectedList = readPins("protectedPins", protectedPins);
  const editableList = readPins("editablePins", editablePins);
  const payloadPin = protectedList.filter((pin) => pin.path === prepared.payloadRef.path);
  if (payloadPin.length !== 1 || payloadPin[0]?.sha256 !== prepared.payloadRef.sha256) {
    throw new ValidationError("prepared payload is not pinned exactly once in plan protectedPins");
  }
  if (!protectedList.some((pin) => pin.path === operatorPath && pin.sha256 === operatorSha256)) {
    throw new ValidationError("prepared plan operator is not pinned in protectedPins");
  }
  // A listed pin is not evidence: the operator and every runtime/protected ref must exist as an
  // ordinary file whose bytes still match. Bytes are only hashed here, never loaded or executed.
  for (const pin of protectedList) await readPinned(reader, `protected pin ${pin.path}`, pin);
  if (strictUtf8Text(payload.bytes).trim().length === 0) throw new ValidationError("prepared payload is empty");

  if (
    admissionJson.schema !== "IndependentSupervisedSourceOnlyAdmission/v1" ||
    admissionJson.decision !== "ADMIT_SOURCE_ONLY_ONCE" ||
    admissionJson.taskId !== taskId ||
    admissionJson.planSha256 !== prepared.planRef.sha256 ||
    admissionJson.operatorSha256 !== operatorSha256 ||
    admissionJson.maximumNativeProcesses !== 1 ||
    !nonEmpty(admissionJson.reviewer) ||
    admissionJson.reviewer === HOST_DEFAULT_REVIEWER
  ) {
    throw new ValidationError("admission is not an independent ADMIT_SOURCE_ONLY_ONCE over this exact final plan");
  }
  const admissionExpiryMs = parseUtc("admission expiresUtc", admissionJson.expiresUtc);
  if (now().getTime() >= admissionExpiryMs || admissionExpiryMs > qualificationExpiryMs) {
    throw new ValidationError("admission is expired or outlives the plan qualification");
  }

  // One fresh, not-started job: no run directory or run evidence may exist yet.
  await assertAbsent(reader, "run directory", prepared.runDirectory);
  for (const name of Object.values(RUN_FILE)) {
    await assertAbsent(reader, `run file ${name}`, runFilePath(prepared.runDirectory, name));
  }

  return {
    planSha256: prepared.planRef.sha256,
    admissionSha256: prepared.admissionRef.sha256,
    taskId,
    sessionId: prepared.sessionId,
    runDirectory: prepared.runDirectory,
    workingDirectory,
    protectedPaths: protectedList.map((pin) => pin.path),
    editablePaths: editableList.map((pin) => pin.path),
    environmentAllowlist,
    protectedPinsJson: canonicalize(protectedList, "plan.protectedPins"),
    argumentsJson: canonicalize(planArguments, "plan.arguments"),
    historyJson: canonicalize(planJson.history, "plan.history"),
  };
}

function bounded(text: string): string {
  return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS)}...`;
}

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isUtc(value: unknown): value is string {
  return typeof value === "string" && UTC_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sameCanonical(value: unknown, canonical: string): boolean {
  try {
    return canonicalize(value, "value") === canonical;
  } catch {
    return false;
  }
}

function allFalse(record: Json, keys: readonly string[]): boolean {
  return keys.every((key) => record[key] === false);
}

/** The exact path set: no subset, no duplicate, no extra entry, exact key shape per entry. */
function coversExactly(
  entries: unknown,
  expectedPaths: readonly string[],
  keys: string,
  valid: (entry: Json) => boolean,
): boolean {
  if (!Array.isArray(entries) || entries.length !== expectedPaths.length) return false;
  const seen = new Set<string>();
  for (const entry of entries as unknown[]) {
    if (!isRecord(entry) || Object.keys(entry).sort().join(",") !== keys || !valid(entry)) return false;
    if (typeof entry.path !== "string" || seen.has(entry.path)) return false;
    seen.add(entry.path);
  }
  return expectedPaths.every((expectedPath) => seen.has(expectedPath));
}

async function mapTerminal(
  reader: SourceJobArtifactReader,
  prepared: PreparedSourceJob,
  auth: Authenticated,
  receipt: SourceJobReceipt,
): Promise<WorkerOutcome> {
  const reasons: string[] = [];
  const evidence: EvidenceDraft[] = [];
  const note = (label: string, ref: SourceJobArtifactRef): void => {
    evidence.push({
      kind: "NOTE",
      summary: `supervised source-job ${label} record (sha256 ${ref.sha256.slice(0, 12)})`,
      reference: refText(ref),
    });
  };
  note("binding plan", prepared.planRef);
  note("admission", prepared.admissionRef);
  note("payload", prepared.payloadRef);

  // Only the launcher's actual run filenames inside the run directory can satisfy run evidence.
  const load = async (label: string, name: string, ref: unknown): Promise<Buffer | undefined> => {
    try {
      if (!isRef(ref) || ref.path !== runFilePath(auth.runDirectory, name)) {
        throw new ValidationError(`${label} reference is not the actual run file ${name}`);
      }
      const read = await readPinned(reader, label, ref);
      note(label, read.ref);
      return read.bytes;
    } catch (error) {
      reasons.push(messageOf(error, `${label} unreadable`));
      return undefined;
    }
  };
  const record = (label: string, bytes: Buffer | undefined): Json | undefined => {
    if (bytes === undefined) return undefined;
    try {
      return parseRecord(label, bytes);
    } catch (error) {
      reasons.push(messageOf(error, `${label} unparseable`));
      return undefined;
    }
  };

  if (
    receipt.jobId !== prepared.jobId ||
    receipt.runDirectory !== auth.runDirectory ||
    receipt.planSha256 !== auth.planSha256
  ) {
    reasons.push("receipt job/run-directory/plan does not match the prepared job");
  }

  const invocation = record("invocation", await load("invocation", RUN_FILE.invocation, receipt.invocationRef));
  const start =
    receipt.startRef === undefined ? undefined : record("start", await load("start", RUN_FILE.start, receipt.startRef));
  const terminal = record("terminal", await load("terminal", RUN_FILE.terminal, receipt.terminalRef));
  const stdout = await load("stdout", RUN_FILE.stdout, receipt.stdoutRef);
  const stderr = await load("stderr", RUN_FILE.stderr, receipt.stderrRef);

  if (invocation !== undefined) {
    const binding = invocation.queueBinding;
    if (invocation.schema !== "SupervisedSourceOnlyInvocation/v1") reasons.push("invocation schema drift");
    if (invocation.planSha256 !== auth.planSha256 || invocation.admissionSha256 !== auth.admissionSha256) {
      reasons.push("invocation plan/admission sha does not match the admitted pair");
    }
    if (!isSha(invocation.usageReceiptSha256)) reasons.push("invocation usage receipt sha is malformed");
    if (!sameCanonical(invocation.arguments, auth.argumentsJson) || invocation.workingDirectory !== auth.workingDirectory) {
      reasons.push("invocation arguments/workingDirectory differ from the admitted plan");
    }
    if (
      !isStringArray(invocation.environmentNames) ||
      !invocation.environmentNames.every((name) => auth.environmentAllowlist.includes(name))
    ) {
      reasons.push("invocation environment names exceed the admitted allowlist");
    }
    if (!sameCanonical(invocation.history, auth.historyJson)) reasons.push("invocation history differs from the admitted plan history");
    if (!allFalse(invocation, ["factoryClaim", "operationalReceipt", "continuityGrant"])) {
      reasons.push("invocation trust flags are not all explicitly false");
    }
    if (
      !isRecord(binding) ||
      Object.keys(binding).sort().join(",") !== "attemptId,consumedUtc,jobId,reservationId,runDirectory,schema" ||
      binding.schema !== "SourceJobQueueBinding/v1" ||
      binding.jobId !== prepared.jobId ||
      !nonEmpty(binding.reservationId) ||
      !nonEmpty(binding.attemptId) ||
      !isUtc(binding.consumedUtc) ||
      binding.runDirectory !== auth.runDirectory
    ) {
      reasons.push("invocation queueBinding does not match the prepared job");
    }
  }

  if (terminal !== undefined) {
    if (terminal.schema !== "SupervisedSourceOnlyTerminal/v1") reasons.push("terminal schema drift");
    if (terminal.providerStarted !== true) reasons.push("provider was not started");
    if (terminal.errorType !== null) reasons.push(`launcher recorded an error (${String(terminal.errorType)})`);
    if (terminal.exitCode !== 0) reasons.push(`exit code ${String(terminal.exitCode)} is not 0`);
    if (terminal.rawDrained !== true) reasons.push("raw output was not drained");
    if (terminal.sessionId !== auth.sessionId) reasons.push("terminal session does not match the plan");
    if (!sameCanonical(terminal.history, auth.historyJson)) reasons.push("terminal history differs from the admitted plan history");
    if (terminal.globalUsage !== "UNKNOWN" || terminal.taskAcceptance !== "NOT_EVALUATED") {
      reasons.push("terminal usage/acceptance is not UNKNOWN/NOT_EVALUATED");
    }
    if (!allFalse(terminal, ["factoryClaim", "operationalCompletion", "successorAuthority"])) {
      reasons.push("terminal trust flags are not all explicitly false");
    }
    if (!coversExactly(terminal.protectedPostPins, auth.protectedPaths, "path,unchanged", (entry) => entry.unchanged === true)) {
      reasons.push("protectedPostPins do not exactly cover the plan protectedPins as unchanged");
    }
    if (!coversExactly(terminal.editableAfter, auth.editablePaths, "path,sha256", (entry) => isSha(entry.sha256))) {
      reasons.push("editableAfter does not exactly cover the plan editablePins with typed hashes");
    }
    if (stdout !== undefined && (sha256Hex(stdout) !== terminal.stdoutSha256 || stdout.length !== terminal.stdoutBytes)) {
      reasons.push("stdout bytes/hash do not match the terminal record");
    }
    if (stderr !== undefined && (sha256Hex(stderr) !== terminal.stderrSha256 || stderr.length !== terminal.stderrBytes)) {
      reasons.push("stderr bytes/hash do not match the terminal record");
    }

    if (terminal.providerStarted === true) {
      if (start === undefined) {
        reasons.push("no verified start record for a started provider");
      } else {
        if (
          start.schema !== "SupervisedSourceOnlyStart/v1" ||
          start.sessionId !== auth.sessionId ||
          !isPid(start.pid) ||
          !isUtc(start.startUtc) ||
          !isUtc(start.observedUtc) ||
          start.noFactoryClaim !== true ||
          Date.parse(start.observedUtc) < Date.parse(start.startUtc)
        ) {
          reasons.push("start record is malformed or does not match the plan session");
        }
        if (terminal.pid !== start.pid || terminal.startUtc !== start.startUtc) {
          reasons.push("terminal pid/startUtc does not match the start record");
        }
      }
      if (!isUtc(terminal.endUtc) || !isUtc(terminal.startUtc) || Date.parse(terminal.endUtc) < Date.parse(terminal.startUtc)) {
        reasons.push("terminal start/end time is malformed");
      }
    }
  }

  if (reasons.length > 0) {
    return {
      status: "FAILED",
      summary: bounded(`supervised source job ${prepared.jobId} not accepted as executed: ${reasons.join("; ")}; usage: UNKNOWN`),
      evidence,
      claimsAcceptanceMet: false,
    };
  }
  return {
    status: "SUCCEEDED",
    summary: bounded(`supervised source job ${prepared.jobId} exited 0 (execution only; acceptance NOT_EVALUATED); usage: UNKNOWN`),
    evidence,
    claimsAcceptanceMet: false,
  };
}

export function createSupervisedSourceJobWorker(options: SupervisedSourceJobWorkerOptions): Worker {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.host?.prepare !== "function" ||
    typeof options.host?.executePrepared !== "function" ||
    typeof options.reader?.read !== "function" ||
    typeof options.reader?.inspect !== "function"
  ) {
    throw new ValidationError("supervised source-job worker requires an injected host (prepare/executePrepared) and artifact reader (inspect/read)");
  }
  const { host, reader } = options;
  const now = options.clock ?? ((): Date => new Date());

  return {
    id: options.id ?? "supervised-source-job-worker",
    capabilities: { roles: ["IMPLEMENTER"], deterministic: false },
    async execute(request: WorkerRequest): Promise<WorkerOutcome> {
      if (request.role !== "IMPLEMENTER") {
        throw new ValidationError(`supervised source-job worker is IMPLEMENTER-only, got ${String(request.role)}`);
      }
      const expected = buildFactoryWorkerRequestBinding(request);
      const frozenRequest = deepFreeze(JSON.parse(canonicalWorkerRequestJson(request)) as WorkerRequest);

      const returned = await host.prepare(frozenRequest);
      const prepared = deepFreeze(JSON.parse(canonicalize(returned, "prepared")) as PreparedSourceJob);
      const auth = await authenticatePrepared(reader, prepared, expected, now);

      // Handoff recheck: the host's object, every referenced artifact and the fresh-run facts must be unchanged.
      if (canonicalize(returned, "prepared") !== canonicalize(prepared, "prepared")) {
        throw new ValidationError("prepared references changed before execution handoff");
      }
      const recheck = await authenticatePrepared(reader, prepared, expected, now);
      if (canonicalize(recheck, "authenticated") !== canonicalize(auth, "authenticated")) {
        throw new ValidationError("authenticated plan facts changed before execution handoff");
      }

      const receipt = await host.executePrepared(prepared);
      if (!isRecord(receipt) || receipt.state !== "TERMINAL") {
        throw new ValidationError(
          `source job did not reach a resolved terminal (${isRecord(receipt) ? String(receipt.state) : "no receipt"}); host must resolve terminal/reconciliation before an outcome — no retry or synthetic terminal`,
        );
      }
      return mapTerminal(reader, prepared, auth, receipt);
    },
  };
}
