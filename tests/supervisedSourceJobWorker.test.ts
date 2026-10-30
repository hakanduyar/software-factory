import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { createInMemoryStore } from "../src/adapters/memory/inMemoryStore.js";
import { createLocalHumanIdentityGate } from "../src/adapters/security/localHumanIdentityGate.js";
import { createLocalWorkerRegistry } from "../src/adapters/security/localWorkerRegistry.js";
import {
  buildFactoryWorkerRequestBinding,
  createSupervisedSourceJobWorker,
  hashWorkerRequest,
  type PreparedSourceJob,
  type SourceJobPathFacts,
  type SourceJobReceipt,
} from "../src/adapters/workers/supervisedSourceJobWorker.js";
import { FactoryService } from "../src/app/factoryService.js";
import type { WorkerRequest } from "../src/ports/worker.js";

// All fixtures are offline. An in-memory file map stands in for the control files and the
// run directory, and models the EXISTING launcher/owner ABI (plan, native admission,
// plaintext payload, invocation, start, stdout/stderr, terminal), not an invented schema.
// Plan/admission/payload are control files OUTSIDE the run directory, which does not exist
// until the launcher (modelled by executePrepared) creates it.

type Json = Record<string, unknown>;
const sha = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

const CONTROL = "C:\\ctl\\bridge";
const RUN = `${CONTROL}\\native-run-1`;
const PLAN_PATH = `${CONTROL}\\native-plan.json`;
const ADMISSION_PATH = `${CONTROL}\\independent-native-admission.json`;
const PAYLOAD_PATH = `${CONTROL}\\payload-final.txt`;
const OPERATOR_PATH = "C:\\src\\owner\\scripts\\orchestration\\invoke-supervised-source-job.ps1";
const OPERATOR_SHA = sha("operator");
const SESSION = "79681cd4-861e-4313-83da-0a0c11b11c08";
const NOW = "2026-10-30T16:00:00Z";
const QUALIFICATION_EXPIRES = "2026-10-30T17:16:55Z";
const PAYLOAD_TEXT = "Implement the bridge.\r\nüñï text payload, not JSON.\n";
const EDITABLE = [
  "C:\\src\\worker\\src\\adapters\\workers\\supervisedSourceJobWorker.ts",
  "C:\\src\\worker\\tests\\supervisedSourceJobWorker.test.ts",
];
const ENV_ALLOWLIST = ["PATH", "SystemRoot", "TEMP", "USERPROFILE"];
const ARGUMENTS = ["--print", "--verbose", "--output-format", "stream-json", "--model", "claude-sonnet-5-5", "--session-id", SESSION];
const RUN_FILES = ["invocation.json", "start.json", "terminal.json", "stdout.bin", "stderr.bin"];

const DROP = Symbol("drop");
type Edit = readonly [path: string, value: unknown];

function applyEdits(target: Json, edits: readonly Edit[] = []): void {
  for (const [dotted, value] of edits) {
    const keys = dotted.split(".");
    const last = keys.pop() as string;
    let cursor = target;
    for (const key of keys) cursor = cursor[key] as Json;
    if (value === DROP) delete cursor[last];
    else cursor[last] = value;
  }
}

const request: WorkerRequest = {
  runId: "run-1" as never,
  workItemId: "wi-1" as never,
  role: "IMPLEMENTER",
  title: "Title",
  instructions: "do\nit ünï",
  acceptanceCriteria: [
    { id: "ac-1" as never, workItemId: "wi-1" as never, text: "a", verificationHint: "npm test" },
  ],
};

interface Scenario {
  binding?: Record<string, unknown>;
  plan?: readonly Edit[];
  prepared?: readonly Edit[];
  admission?: readonly Edit[];
  invocation?: readonly Edit[];
  start?: readonly Edit[];
  terminal?: readonly Edit[];
  receipt?: readonly Edit[];
  payload?: Buffer;
  stdout?: string;
  stderr?: string;
  /** Paths that already exist before prepare (a run file implies its run directory exists). */
  existing?: readonly string[];
  reparse?: readonly string[];
  noncanonical?: readonly string[];
  skipStart?: boolean;
  state?: SourceJobReceipt["state"];
  /** The nth read of this path returns different bytes (immutable artifact changed between reads). */
  tamperOnRead?: { path: string; nth: number };
  /** Protected artifacts that are pinned in the plan but absent from the reader. */
  missing?: readonly string[];
  /** Protected artifacts whose actual bytes differ from the pinned hash. */
  drifted?: readonly string[];
  /** Protected artifacts that exist but are directories, not ordinary files. */
  directories?: readonly string[];
  /** Distinguishes two otherwise identical launches so each gets its own reservation/attempt. */
  launchNonce?: string;
  now?: string;
  onPrepare?: (request: WorkerRequest) => Promise<void>;
}

const RUNTIME_PATH = "C:\\Users\\u\\npm\\claude-code\\bin\\claude.exe";
const QUEUE_CORE_PATH = "C:\\src\\owner\\scripts\\orchestration\\source-job-queue.ps1";
const PROTECTED = [RUNTIME_PATH, OPERATOR_PATH, PAYLOAD_PATH, QUEUE_CORE_PATH];

/** Real bytes for every pinned protected artifact except the payload (which the scenario controls). */
const protectedBytes = (path: string): Buffer => Buffer.from(path === OPERATOR_PATH ? "operator" : `protected bytes of ${path}`);

const HISTORY_BASE = {
  label: "RETAINED_CONTEXT_NOT_AUTHENTICATED_FACTORY_CONTINUITY",
  brokenParentRefusal: "ARTIFACT_MISMATCH preserved, not bypassed or declared valid",
  observedNativeChildren: [
    { sourceResult: "NO_EDIT", outputTokens: 4854 },
    { sourceResult: "PR105 delivered", outputTokens: 10151 },
  ],
  lastVerifiedSubtotal: 246766,
  chainContinuityGrant: false,
  globalTotal: null,
  operationalReceipt: false,
  unknownUsagePreserved: true,
  subtotalIsNotGlobal: true,
  factoryClaim: false,
  bridgeScope: {
    qualification: "GENUINE_20261030T161655Z",
    sourceOnly: true,
    binding: "INLINE_COMPLETE_REQUEST_SHA256_TWO_PHASE",
    runtimeAdoption: false,
  },
};

const isNormalized = (path: string): boolean =>
  /^[A-Za-z]:\\/.test(path) && !/(^|\\)\.\.?(\\|$)/.test(path) && !path.includes("\\\\") && !path.endsWith("\\");

function fixture(scenario: Scenario = {}) {
  const files = new Map<string, Buffer>();
  const directories = new Set<string>();
  const calls = { prepare: 0, execute: 0 };
  const reads = new Map<string, number>();
  const launched: { preparedKeys?: string[]; reservationId?: string; attemptId?: string } = {};
  let history: Json = {};

  for (const existing of scenario.existing ?? []) {
    directories.add(RUN);
    if (existing !== RUN) files.set(existing, Buffer.from("{}"));
  }

  const put = (path: string, value: unknown) => {
    const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    files.set(path, bytes);
    return { path, sha256: sha(bytes) };
  };

  const reader = {
    async inspect(path: string): Promise<SourceJobPathFacts> {
      return {
        kind: files.has(path) ? "file" : directories.has(path) ? "directory" : "missing",
        canonical: isNormalized(path) && !(scenario.noncanonical ?? []).includes(path),
        reparse: (scenario.reparse ?? []).some((root) => path === root || path.startsWith(`${root}\\`)),
      };
    },
    async read(path: string) {
      const count = (reads.get(path) ?? 0) + 1;
      reads.set(path, count);
      if (scenario.tamperOnRead?.path === path && scenario.tamperOnRead.nth === count) return Buffer.from("tampered");
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`missing ${path}`);
      return bytes;
    },
  };

  const host = {
    async prepare(req: WorkerRequest): Promise<PreparedSourceJob> {
      calls.prepare += 1;
      await scenario.onPrepare?.(req);
      history = { ...HISTORY_BASE, factoryWorkerRequest: scenario.binding ?? { ...buildFactoryWorkerRequestBinding(req) } };
      const payloadBytes = scenario.payload ?? Buffer.from(PAYLOAD_TEXT, "utf8");
      files.set(PAYLOAD_PATH, payloadBytes);
      const pinFor = (path: string) => ({
        path,
        sha256: path === PAYLOAD_PATH ? sha(payloadBytes) : sha(protectedBytes(path)),
      });
      // The pinned operator/runtime artifacts exist in the reader unless the scenario removes or alters them.
      for (const path of PROTECTED) {
        if (path === PAYLOAD_PATH) continue;
        if ((scenario.missing ?? []).includes(path)) continue;
        if ((scenario.directories ?? []).includes(path)) directories.add(path);
        else files.set(path, (scenario.drifted ?? []).includes(path) ? Buffer.from("drifted") : protectedBytes(path));
      }
      const plan: Json = {
        schema: "SupervisedCodeSourceOnlyTask/v1",
        taskId: "FACTORY_SUPERVISED_WORKER_BRIDGE_1",
        sourceWorktree: "C:\\src\\worker",
        workingDirectory: "C:\\src\\factory",
        sessionId: SESSION,
        payloadPath: PAYLOAD_PATH,
        runDirectory: RUN,
        qualificationPath: `${CONTROL}\\qualification\\fresh-settings-provenance.json`,
        qualificationExpiresUtc: QUALIFICATION_EXPIRES,
        usageValidatorPath: `${CONTROL}\\validator.ps1`,
        arguments: [...ARGUMENTS],
        environmentAllowlist: [...ENV_ALLOWLIST],
        protectedPins: PROTECTED.map(pinFor),
        editablePins: EDITABLE.map((path) => ({ path, sha256: sha("") })),
        history: structuredClone(history),
        limits: { paidFallback: false, nativeProcesses: 1, factoryClaims: 0, automaticRetries: 0 },
        operatorPath: OPERATOR_PATH,
        operatorSha256: OPERATOR_SHA,
        queueCore: pinFor(QUEUE_CORE_PATH),
        queueIndexPath: `${CONTROL}\\index.json`,
        queueDependencyJobIds: [],
      };
      applyEdits(plan, scenario.plan);
      const planRef = put(PLAN_PATH, plan);
      const admission: Json = {
        schema: "IndependentSupervisedSourceOnlyAdmission/v1",
        decision: "ADMIT_SOURCE_ONLY_ONCE",
        taskId: "FACTORY_SUPERVISED_WORKER_BRIDGE_1",
        reviewer: "/root/monitor_config_readonly",
        planSha256: planRef.sha256,
        operatorSha256: OPERATOR_SHA,
        maximumNativeProcesses: 1,
        expiresUtc: QUALIFICATION_EXPIRES,
        reviewedAdminSha256: sha("admin"),
        scopeSha256: sha("scope"),
        freshUsageRequired: true,
      };
      applyEdits(admission, scenario.admission);
      const admissionRef = put(ADMISSION_PATH, admission);
      const preparedJob: Json = {
        jobId: "factory-supervised-worker-bridge-1",
        sessionId: SESSION,
        runDirectory: RUN,
        planRef,
        admissionRef,
        payloadRef: { path: PAYLOAD_PATH, sha256: sha(payloadBytes) },
      };
      applyEdits(preparedJob, scenario.prepared);
      return preparedJob as unknown as PreparedSourceJob;
    },
    async executePrepared(prepared: PreparedSourceJob): Promise<SourceJobReceipt> {
      calls.execute += 1;
      directories.add(RUN);
      // The owner reserves after REGISTER and the launcher consumes it; only now does the tuple exist.
      launched.preparedKeys = Object.keys(prepared).sort();
      launched.reservationId = `ores-${sha(`${prepared.jobId}|${scenario.launchNonce ?? "n1"}`).slice(0, 32)}`;
      launched.attemptId = `attempt-${sha(`attempt|${scenario.launchNonce ?? "n1"}`).slice(0, 32)}`;
      const stdoutText = scenario.stdout ?? '{"type":"result","subtype":"success"}\n';
      const stderrText = scenario.stderr ?? "";
      const stdoutRef = put(`${RUN}\\stdout.bin`, stdoutText);
      const stderrRef = put(`${RUN}\\stderr.bin`, stderrText);

      const invocation: Json = {
        schema: "SupervisedSourceOnlyInvocation/v1",
        planSha256: prepared.planRef.sha256,
        admissionSha256: prepared.admissionRef.sha256,
        usageReceiptSha256: sha("usage"),
        arguments: [...ARGUMENTS],
        workingDirectory: "C:\\src\\factory",
        environmentNames: [...ENV_ALLOWLIST],
        history: structuredClone(history),
        factoryClaim: false,
        operationalReceipt: false,
        continuityGrant: false,
        queueBinding: {
          schema: "SourceJobQueueBinding/v1",
          jobId: prepared.jobId,
          reservationId: launched.reservationId,
          attemptId: launched.attemptId,
          consumedUtc: "2026-10-30T16:20:36.1185864Z",
          runDirectory: RUN,
        },
      };
      applyEdits(invocation, scenario.invocation);
      const start: Json = {
        schema: "SupervisedSourceOnlyStart/v1",
        pid: 4624,
        sessionId: SESSION,
        startUtc: "2026-10-30T16:20:37.0633303Z",
        observedUtc: "2026-10-30T16:20:37.0739458Z",
        noFactoryClaim: true,
      };
      applyEdits(start, scenario.start);
      const terminal: Json = {
        schema: "SupervisedSourceOnlyTerminal/v1",
        providerStarted: true,
        pid: 4624,
        sessionId: SESSION,
        startUtc: "2026-10-30T16:20:37.0633303Z",
        endUtc: "2026-10-30T16:23:52.1755307Z",
        exitCode: 0,
        errorType: null,
        rawDrained: true,
        stdoutSha256: stdoutRef.sha256,
        stdoutBytes: Buffer.byteLength(stdoutText),
        stderrSha256: stderrRef.sha256,
        stderrBytes: Buffer.byteLength(stderrText),
        editableAfter: EDITABLE.map((path) => ({ path, sha256: sha(`edited ${path}`) })),
        protectedPostPins: PROTECTED.map((path) => ({ path, unchanged: true })),
        history: structuredClone(history),
        globalUsage: "UNKNOWN",
        taskAcceptance: "NOT_EVALUATED",
        factoryClaim: false,
        operationalCompletion: false,
        successorAuthority: false,
      };
      applyEdits(terminal, scenario.terminal);

      const invocationRef = put(`${RUN}\\invocation.json`, invocation);
      const startRef = put(`${RUN}\\start.json`, start);
      const terminalRef = put(`${RUN}\\terminal.json`, terminal);
      const receipt: Json = {
        state: scenario.state ?? "TERMINAL",
        jobId: prepared.jobId,
        runDirectory: RUN,
        planSha256: prepared.planRef.sha256,
        invocationRef,
        ...(scenario.skipStart === true ? {} : { startRef }),
        terminalRef,
        stdoutRef,
        stderrRef,
      };
      applyEdits(receipt, scenario.receipt);
      return receipt as unknown as SourceJobReceipt;
    },
  };

  return {
    worker: createSupervisedSourceJobWorker({ host, reader, clock: () => new Date(scenario.now ?? NOW) }),
    calls,
    launched,
  };
}

describe("supervised source-job worker", () => {
  it("maps a matching terminal to execution-only SUCCEEDED with real artifact references", async () => {
    const { worker, calls } = fixture();
    const outcome = await worker.execute(request);
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(outcome.claimsAcceptanceMet, false);
    assert.deepEqual([calls.prepare, calls.execute], [1, 1]);
    assert.match(outcome.summary, /usage: UNKNOWN/);
    assert.match(outcome.summary, /NOT_EVALUATED/);
    for (const file of ["native-plan.json", "independent-native-admission.json", "payload-final.txt", ...RUN_FILES]) {
      assert.ok(outcome.evidence.some((e) => e.kind === "NOTE" && e.reference.includes(`\\${file}#sha256=`)), file);
    }
    assert.ok(outcome.evidence.every((e) => /#sha256=[0-9a-f]{64}$/.test(e.reference)));
  });

  it("prepares without any reservation and accepts only the tuple the launch itself created", async () => {
    const first = fixture({ launchNonce: "a" });
    const second = fixture({ launchNonce: "b" });
    for (const run of [first, second]) {
      const outcome = await run.worker.execute(request);
      assert.equal(outcome.status, "SUCCEEDED");
      assert.equal(outcome.claimsAcceptanceMet, false);
      assert.deepEqual(run.calls, { prepare: 1, execute: 1 });
      // prepare predicted nothing: the prepared job handed to the owner carries no reservation.
      assert.ok(!run.launched.preparedKeys?.includes("reservationId"));
      assert.match(run.launched.reservationId ?? "", /^ores-[0-9a-f]{32}$/);
    }
    assert.notEqual(first.launched.reservationId, second.launched.reservationId);
    assert.notEqual(first.launched.attemptId, second.launched.attemptId);
  });

  it("hashes the complete request canonically", () => {
    const reordered = { ...request, acceptanceCriteria: [{ verificationHint: "npm test", text: "a", workItemId: "wi-1", id: "ac-1" }] } as unknown as WorkerRequest;
    assert.equal(hashWorkerRequest(request), hashWorkerRequest(reordered));
    // An explicit undefined optional is "absent" for hashing; cast because exactOptionalPropertyTypes forbids the literal.
    assert.equal(hashWorkerRequest({ ...request, recalledNote: undefined } as unknown as WorkerRequest), hashWorkerRequest(request));
    assert.notEqual(hashWorkerRequest({ ...request, instructions: "do\r\nit" }), hashWorkerRequest(request));
    const withEvidence = { ...request, acceptanceCriteria: [{ ...request.acceptanceCriteria[0]!, verifiedByEvidenceId: "ev-1" as never }] };
    assert.notEqual(hashWorkerRequest(withEvidence), hashWorkerRequest(request));
    assert.throws(() => hashWorkerRequest({ ...request, extra: Number.NaN } as unknown as WorkerRequest));
  });

  it("refuses before executePrepared on role, request, plan, admission, payload, path and freshness drift", async () => {
    const roleCase = fixture();
    await assert.rejects(roleCase.worker.execute({ ...request, role: "REVIEWER" }));
    assert.deepEqual([roleCase.calls.prepare, roleCase.calls.execute], [0, 0]);

    const binding = buildFactoryWorkerRequestBinding(request);
    const stale = "0".repeat(64);
    const cases: Array<[string, Scenario]> = [
      ["wrong run", { binding: { ...binding, runId: "run-other" } }],
      ["wrong work item", { binding: { ...binding, workItemId: "wi-other" } }],
      ["wrong role", { binding: { ...binding, role: "REVIEWER" } }],
      ["wrong request hash", { binding: { ...binding, requestSha256: "1".repeat(64) } }],
      ["extra binding key", { binding: { ...binding, extra: 1 } }],
      ["binding absent from plan history", { plan: [["history.factoryWorkerRequest", DROP]] }],
      ["plan schema", { plan: [["schema", "SupervisedCodeSourceOnlyTask/v0"]] }],
      ["plan task missing", { plan: [["taskId", DROP]] }],
      ["plan session", { plan: [["sessionId", "other-session"]] }],
      ["plan run directory", { plan: [["runDirectory", `${CONTROL}\\native-run-2`]] }],
      ["plan payload path", { plan: [["payloadPath", `${CONTROL}\\other.txt`]] }],
      ["payload pin hash", { plan: [["protectedPins.2.sha256", "1".repeat(64)]] }],
      ["payload not pinned", { plan: [["protectedPins.2.path", `${CONTROL}\\elsewhere.txt`]] }],
      ["duplicate pin coverage", { plan: [["protectedPins.3.path", PAYLOAD_PATH]] }],
      ["malformed pin", { plan: [["protectedPins.0.extra", 1]] }],
      ["no editable pins", { plan: [["editablePins", []]] }],
      ["operator not pinned", { plan: [["protectedPins.1.sha256", "1".repeat(64)]] }],
      ["operator sha drift", { plan: [["operatorSha256", sha("other-operator")]] }],
      ["qualification expiry malformed", { plan: [["qualificationExpiresUtc", "tomorrow"]] }],
      ["old ADMITTED decision", { admission: [["decision", "ADMITTED"]] }],
      ["admission schema", { admission: [["schema", "SourceJobAdmission/v0"]] }],
      ["admission task", { admission: [["taskId", "OTHER_TASK"]] }],
      ["admission stale plan", { admission: [["planSha256", stale]] }],
      ["admission operator", { admission: [["operatorSha256", sha("other-operator")]] }],
      ["admission default reviewer", { admission: [["reviewer", "/root/bounded_state_check"]] }],
      ["admission two processes", { admission: [["maximumNativeProcesses", 2]] }],
      ["admission outlives qualification", { admission: [["expiresUtc", "2026-10-30T18:00:00Z"]] }],
      ["admission expired", { now: "2026-10-30T17:20:00Z" }],
      ["payload not UTF-8", { payload: Buffer.from([0xff, 0xfe, 0x00]) }],
      ["payload empty", { payload: Buffer.from("  \n") }],
      ["control ancestor reparse", { reparse: [CONTROL] }],
      ["payload reparse", { reparse: [PAYLOAD_PATH] }],
      ["run directory reparse", { reparse: [RUN] }],
      ["admission path not canonical", { noncanonical: [ADMISSION_PATH] }],
      ["run directory not canonical", { noncanonical: [RUN] }],
      ["operator bytes missing", { missing: [OPERATOR_PATH] }],
      ["operator bytes drifted", { drifted: [OPERATOR_PATH] }],
      ["operator not an ordinary file", { directories: [OPERATOR_PATH] }],
      ["operator reparse", { reparse: [OPERATOR_PATH] }],
      ["runtime ref missing", { missing: [RUNTIME_PATH] }],
      ["runtime ref drifted", { drifted: [RUNTIME_PATH] }],
      ["runtime ref not an ordinary file", { directories: [RUNTIME_PATH] }],
      ["runtime ref reparse", { reparse: [RUNTIME_PATH] }],
      ["queue core missing", { missing: [QUEUE_CORE_PATH] }],
      ["runtime ref changed before handoff", { tamperOnRead: { path: RUNTIME_PATH, nth: 2 } }],
      ["operator changed before handoff", { tamperOnRead: { path: OPERATOR_PATH, nth: 2 } }],
      ["prepared session drift", { prepared: [["sessionId", "other-session"]] }],
      ["prepared plan path missing", { prepared: [["planRef.path", `${CONTROL}\\nowhere.json`]] }],
      ["run directory pre-exists", { existing: [RUN] }],
      ...RUN_FILES.map((file): [string, Scenario] => [`${file} pre-exists`, { existing: [`${RUN}\\${file}`] }]),
      ["refs changed before handoff", { tamperOnRead: { path: PLAN_PATH, nth: 2 } }],
    ];
    for (const [label, scenario] of cases) {
      const { worker, calls } = fixture(scenario);
      await assert.rejects(worker.execute(request), label);
      assert.equal(calls.prepare, 1, label);
      assert.equal(calls.execute, 0, label);
    }
  });

  it("keeps every terminal/invocation/start/receipt drift nonaccepted without retry", async () => {
    const stale = "0".repeat(64);
    const cases: Array<[string, Scenario, RegExp]> = [
      ["terminal schema", { terminal: [["schema", "SupervisedSourceOnlyTerminal/v0"]] }, /terminal schema/],
      ["historical terminal binding", { terminal: [["history.factoryWorkerRequest.runId", "run-old"]] }, /terminal history/],
      ["terminal session", { terminal: [["sessionId", "other-session"]] }, /terminal session/],
      ["terminal pid", { terminal: [["pid", 1]] }, /pid\/startUtc/],
      ["terminal startUtc", { terminal: [["startUtc", "2026-10-30T16:20:38.0000000Z"]] }, /pid\/startUtc/],
      ["end before start", { terminal: [["endUtc", "2026-10-30T16:00:00Z"]] }, /start\/end time/],
      ["exit code", { terminal: [["exitCode", 2]] }, /exit code 2/],
      ["error type", { terminal: [["errorType", "System.IO.IOException"]] }, /launcher recorded an error/],
      ["undrained", { terminal: [["rawDrained", false]] }, /not drained/],
      [
        "not started",
        { terminal: [["providerStarted", false], ["pid", null], ["exitCode", null]], skipStart: true },
        /provider was not started/,
      ],
      ["started without start record", { skipStart: true }, /no verified start record/],
      ["stdout hash", { terminal: [["stdoutSha256", stale]] }, /stdout bytes\/hash/],
      ["stdout length", { terminal: [["stdoutBytes", 1]] }, /stdout bytes\/hash/],
      ["stderr hash", { terminal: [["stderrSha256", stale]] }, /stderr bytes\/hash/],
      ["stderr not empty", { stderr: "boom", terminal: [["stderrBytes", 0], ["stderrSha256", sha("")]] }, /stderr bytes\/hash/],
      [
        "protected pins subset",
        { terminal: [["protectedPostPins", [{ path: PROTECTED[0], unchanged: true }]]] },
        /protectedPostPins/,
      ],
      ["protected pins duplicate", { terminal: [["protectedPostPins.3.path", PROTECTED[0]]] }, /protectedPostPins/],
      ["protected pin changed", { terminal: [["protectedPostPins.1.unchanged", false]] }, /protectedPostPins/],
      ["protected pin extra key", { terminal: [["protectedPostPins.0.sha256", "x"]] }, /protectedPostPins/],
      ["editable subset", { terminal: [["editableAfter", [{ path: EDITABLE[0], sha256: sha("x") }]]] }, /editableAfter/],
      ["editable hash untyped", { terminal: [["editableAfter.0.sha256", "not-a-hash"]] }, /editableAfter/],
      ["global usage", { terminal: [["globalUsage", "KNOWN"]] }, /UNKNOWN\/NOT_EVALUATED/],
      ["task acceptance", { terminal: [["taskAcceptance", "ACCEPTED"]] }, /UNKNOWN\/NOT_EVALUATED/],
      ["terminal claim true", { terminal: [["factoryClaim", true]] }, /terminal trust flags/],
      ["terminal flag omitted", { terminal: [["operationalCompletion", DROP]] }, /terminal trust flags/],
      ["successor authority", { terminal: [["successorAuthority", true]] }, /terminal trust flags/],
      ["invocation schema", { invocation: [["schema", "SupervisedSourceOnlyInvocation/v0"]] }, /invocation schema/],
      ["invocation plan sha", { invocation: [["planSha256", stale]] }, /plan\/admission sha/],
      ["invocation admission sha", { invocation: [["admissionSha256", stale]] }, /plan\/admission sha/],
      ["invocation usage sha", { invocation: [["usageReceiptSha256", "nope"]] }, /usage receipt/],
      ["invocation arguments", { invocation: [["arguments.0", "--other"]] }, /arguments/],
      ["invocation environment", { invocation: [["environmentNames", ["PATH", "SECRET_TOKEN"]]] }, /environment names/],
      ["invocation history", { invocation: [["history.label", "other"]] }, /invocation history/],
      ["invocation flag true", { invocation: [["factoryClaim", true]] }, /invocation trust flags/],
      ["invocation flag omitted", { invocation: [["continuityGrant", DROP]] }, /invocation trust flags/],
      ["queue job", { invocation: [["queueBinding.jobId", "other-job"]] }, /queueBinding/],
      ["queue reservation missing", { invocation: [["queueBinding.reservationId", DROP]] }, /queueBinding/],
      ["queue reservation empty", { invocation: [["queueBinding.reservationId", ""]] }, /queueBinding/],
      ["queue reservation not a string", { invocation: [["queueBinding.reservationId", 7]] }, /queueBinding/],
      ["queue attempt empty", { invocation: [["queueBinding.attemptId", ""]] }, /queueBinding/],
      ["queue consumedUtc invalid", { invocation: [["queueBinding.consumedUtc", "yesterday"]] }, /queueBinding/],
      ["queue run directory", { invocation: [["queueBinding.runDirectory", `${CONTROL}\\native-run-2`]] }, /queueBinding/],
      ["queue schema", { invocation: [["queueBinding.schema", "SourceJobQueueBinding/v0"]] }, /queueBinding/],
      ["queue extra key", { invocation: [["queueBinding.extra", 1]] }, /queueBinding/],
      ["queue attempt missing", { invocation: [["queueBinding.attemptId", DROP]] }, /queueBinding/],
      ["start schema", { start: [["schema", "SupervisedSourceOnlyStart/v0"]] }, /start record/],
      ["start session", { start: [["sessionId", "other-session"]] }, /start record/],
      ["start pid", { start: [["pid", 0]] }, /start record/],
      ["start time malformed", { start: [["startUtc", "yesterday"]] }, /start record/],
      ["start observed before start", { start: [["observedUtc", "2026-10-30T16:20:36Z"]] }, /start record/],
      ["start no-claim flag omitted", { start: [["noFactoryClaim", DROP]] }, /start record/],
      ["stdout is not the run file", { receipt: [["stdoutRef.path", `${RUN}\\raw.log`]] }, /actual run file stdout\.bin/],
      ["terminal outside run directory", { receipt: [["terminalRef.path", `${CONTROL}\\terminal.json`]] }, /actual run file terminal\.json/],
      ["receipt job", { receipt: [["jobId", "other-job"]] }, /receipt job/],
    ];
    for (const [label, scenario, reason] of cases) {
      const { worker, calls } = fixture(scenario);
      const outcome = await worker.execute(request);
      assert.equal(outcome.status, "FAILED", label);
      assert.equal(outcome.claimsAcceptanceMet, false, label);
      assert.match(outcome.summary, reason, label);
      assert.match(outcome.summary, /usage: UNKNOWN/, label);
      assert.ok(outcome.evidence.length >= 3, label);
      assert.deepEqual([calls.prepare, calls.execute], [1, 1], label);
    }
  });

  it("rejects unresolved owner states instead of synthesizing a terminal", async () => {
    for (const state of ["STILL_RUNNING", "RECONCILIATION_REQUIRED"] as const) {
      const { worker, calls } = fixture({ state });
      await assert.rejects(worker.execute(request), /host must resolve/);
      assert.equal(calls.execute, 1);
    }
  });

  it("runs through FactoryService: RUNNING is durable before the host call and no authority is created", async () => {
    const clock = { now: () => "2026-10-30T00:00:00.000Z" as never };
    let n = 0;
    const ids = { next: (prefix: string) => `${prefix}-${(n += 1)}` as never };
    const store = createInMemoryStore();
    const service = new FactoryService({
      store,
      clock,
      ids,
      identityGate: createLocalHumanIdentityGate({ credential: "test-credential-1", clock }),
      workerRegistry: createLocalWorkerRegistry(clock),
    });

    const project = await service.createProject({ key: "SF", name: "Factory" });
    const created = await service.createWorkItem({
      projectId: project.id,
      title: "Task",
      type: "TASK" as never,
      planVersion: "p1",
      acceptanceCriteria: [{ text: "works", verificationHint: "npm test" }],
    });
    // Seed the status directly: this test is about the worker seam, not the approval workflow.
    await store.workItems.compareAndSave(
      { ...created, status: "IMPLEMENTING" as never, version: created.version + 1 },
      created.version,
    );

    const observed: { runId?: string; status?: string; runCount?: number } = {};
    const { worker, calls } = fixture({
      onPrepare: async (req) => {
        const run = await store.runs.findById(req.runId);
        observed.runId = req.runId;
        // A missing run leaves status absent (the RUNNING assertion then fails); nothing is fabricated.
        if (run !== undefined) observed.status = run.status;
        observed.runCount = (await store.runs.listByWorkItem(req.workItemId)).length;
      },
    });
    service.registerWorker(worker);

    const result = await service.runWorker({ workItemId: created.id, role: "IMPLEMENTER", worker, instructions: "implement" });

    assert.equal(observed.status, "RUNNING");
    assert.equal(observed.runCount, 1);
    assert.equal(result.run.id, observed.runId);
    assert.equal(result.run.status, "SUCCEEDED");
    assert.equal(result.run.claimsAcceptanceMet, false);
    assert.equal(calls.prepare, 1);
    assert.equal((await service.getWorkItem(created.id)).status, "IMPLEMENTING");
    assert.deepEqual(await service.listApprovals(service.workItemSubject(created.id)), []);
    assert.ok(result.evidence.every((e) => e.kind === "NOTE" && e.criterionId === undefined));
  });
});
