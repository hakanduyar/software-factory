/**
 * TASK-019 AC-5, AC-22 — a REAL process kill between a review's record and its
 * worker's acknowledgement (SF-R3 correction round 1).
 *
 * Every other proof of "parent died before ACK" in this repository is
 * simulated: `tests/supervisorLoop.test.ts` fakes the lease, the liveness
 * probe and the `deadPids` set. This file demonstrates it with genuine OS
 * processes throughout: a real `SupervisorService` runs in a real, separate
 * child process, claims the review under its OWN real PID
 * (`leaseForThisProcess`), spawns a real detached worker — and is then
 * SIGKILLed. A second, real `SupervisorService`, in THIS process with a real
 * `createProcLivenessProbe`, must resolve the run without ever spawning a
 * second reviewer process.
 *
 * TWO SCENARIOS, because they are genuinely different races:
 *
 *   - AFTER ACK (below, first test): the real detached wrapper
 *     (`createCodexReviewLauncher`) has already written its acknowledgement by
 *     the time the parent is killed. Recovery is ADOPTION of a proven worker.
 *   - BEFORE ACK (second test, SF-R3 correction round 2): the parent is killed
 *     with a durable CLAIMED record and no acknowledgement yet — the case
 *     AC-5/AC-22 actually name. Recovery must be durable AMBIGUOUS, zero
 *     duplicate launches, and — once a late ACK genuinely arrives — adoption
 *     of it with still zero duplicates. The worker's ACK is held behind a
 *     small fixture-owned gate file so the kill happens deterministically
 *     before it exists, rather than racing a real timing window.
 *
 * `SF_REVIEW_DIR` fixes where `supervisorService.ts` computes review artefact
 * paths, read ONCE at module load. This file therefore imports it (and
 * everything that reaches it) dynamically, after setting the variable — the
 * same escape hatch `supervisorReviewProductionWiring.test.ts` already uses.
 *
 * Offline throughout: the "reviewer" CLI is `true`. No provider is contacted.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { LaunchAcknowledgement } from "../src/supervision/acceptance.js";
import type { ReviewCompletionReading, ReviewLaunchRequest, ReviewLaunchResult } from "../src/supervision/supervisorPorts.js";
import type { RoadmapItem } from "../src/supervision/supervisorTypes.js";
import { anchorFor } from "../src/supervision/provenanceChain.js";
import { cleanupTempDbs, tempDbPath } from "./support/factoryFixtures.js";

const scratch = mkdtempSync(join(tmpdir(), "sf-real-kill-"));
const DIST_SRC = fileURLToPath(new URL("../src", import.meta.url));
const DIST_SUPPORT = fileURLToPath(new URL("./support", import.meta.url));

/**
 * Set ONCE, at module load, before either test's first dynamic import of
 * `supervisorService.ts` — which is what actually fixes the review directory
 * it computes paths under, for the rest of this process's life. A per-test
 * `mkdtempSync` here would be cosmetic: only the FIRST import's value is ever
 * really used, so both tests share this one directory and are kept apart by
 * distinct roadmap keys instead (SF-R3 correction round 2).
 */
const REVIEW_DIR = mkdtempSync(join(scratch, "reviews"));
process.env["SF_REVIEW_DIR"] = REVIEW_DIR;

after(() => {
  cleanupTempDbs();
  rmSync(scratch, { recursive: true, force: true });
});

const ROADMAP: readonly RoadmapItem[] = [
  { key: "A", title: "Work", dependsOn: [], status: "ACTIVE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
];
const CANDIDATE = { commit: "abc1234", tree: "def5678", fingerprint: "0123456789ab" } as const;
const ACTIVITY_ID = "A:REVIEW:r1";
/**
 * A DIFFERENT roadmap key for the before-ACK scenario (SF-R3 round 2),
 * deliberately: `SF_REVIEW_DIR`'s escape hatch above is read ONCE, at the
 * first dynamic import of `supervisorService.ts` in this file's process — so
 * the SECOND test's own `mkdtempSync`'d review directory is cosmetic; every
 * review path this file's supervisors actually compute lands under the
 * FIRST test's directory regardless. Reusing roadmap key "A" here would have
 * the second test's supervisor read the first test's leftover ack file at
 * the same path and adopt a worker that was never gated at all — which is
 * exactly the false pass this fixture measured before this key was changed.
 */
const ROADMAP_B: readonly RoadmapItem[] = [
  { key: "B", title: "Other work", dependsOn: [], status: "ACTIVE", workClass: "NORMAL_IMPLEMENTATION", order: 1 },
];
const ACTIVITY_ID_B = "B:REVIEW:r1";

/** Writes the real child "supervisor" program and returns its path. */
function writeRealSupervisorScript(options: { readonly dbPath: string; readonly workDir: string }): string {
  const script = join(options.workDir, "real-supervisor.mjs");
  writeFileSync(
    script,
    `
import { createSqliteSupervisorRepository } from ${JSON.stringify(join(DIST_SRC, "adapters/supervision/sqliteSupervisorRepository.js"))};
import { createProcLivenessProbe, leaseForThisProcess } from ${JSON.stringify(join(DIST_SRC, "adapters/supervision/procLiveness.js"))};
import { createCodexReviewLauncher } from ${JSON.stringify(join(DIST_SRC, "adapters/supervision/codexReviewLauncher.js"))};
import { createSequentialIdGenerator } from ${JSON.stringify(join(DIST_SRC, "domain/ids.js"))};
import { DEFAULT_ROUTING_POLICY } from ${JSON.stringify(join(DIST_SRC, "supervision/modelRouting.js"))};
import { SupervisorService } from ${JSON.stringify(join(DIST_SRC, "supervision/supervisorService.js"))};
import { scriptedProbe, TEST_CATALOG } from ${JSON.stringify(join(DIST_SUPPORT, "supervisorFixtures.js"))};

const repository = createSqliteSupervisorRepository(${JSON.stringify(options.dbPath)});
const probe = scriptedProbe();
for (const entry of TEST_CATALOG) {
  probe.set(entry.provider, entry.model, { state: "AVAILABLE", reason: "scripted", billingMode: "INCLUDED_SUBSCRIPTION" });
}
const launcher = createCodexReviewLauncher({
  repository: ${JSON.stringify(options.workDir)},
  packet: () => "no model is called",
  command: () => ["true"],
});
const service = new SupervisorService({
  repository,
  roadmapCatalog: ${JSON.stringify(ROADMAP)},
  probe,
  executor: { execute: async () => ({ kind: "COMPLETED", detail: "ran" }) },
  clock: { now: () => Date.now() },
  ids: createSequentialIdGenerator(),
  routingPolicy: DEFAULT_ROUTING_POLICY,
  resourceCatalog: TEST_CATALOG,
  liveness: createProcLivenessProbe(),
  activityLease: (at) => leaseForThisProcess(at),
  reviewLauncher: launcher,
  log: () => {},
});
await service.tick();
repository.close();
// Stay alive: the whole point is what a SECOND supervisor does when THIS
// process — genuinely still running, genuinely holding the claim's lease —
// is killed before the worker it just spawned has proved itself. A bare
// unsettled top-level await makes Node exit once nothing else is pending
// (it did, with exit code 13); a live timer keeps the event loop — and this
// process — genuinely running until the test kills it.
setInterval(() => {}, 60_000);
`,
    "utf8",
  );
  return script;
}

test("a real supervisor SIGKILLed AFTER its real worker's ACK resolves with no duplicate launch", async () => {
  // Dynamic imports: `SF_REVIEW_DIR` (module scope, above) is already set;
  // this process must not evaluate supervisorService.ts's module-level
  // review-directory constant before that happened.
  const { createSqliteSupervisorRepository } = await import("../src/adapters/supervision/sqliteSupervisorRepository.js");
  const { createProcLivenessProbe, leaseForThisProcess } = await import("../src/adapters/supervision/procLiveness.js");
  const { createCodexReviewLauncher } = await import("../src/adapters/supervision/codexReviewLauncher.js");
  const { createSequentialIdGenerator } = await import("../src/domain/ids.js");
  const { DEFAULT_ROUTING_POLICY } = await import("../src/supervision/modelRouting.js");
  const { SupervisorService } = await import("../src/supervision/supervisorService.js");
  const { scriptedProbe, TEST_CATALOG } = await import("./support/supervisorFixtures.js");

  const dbPath = tempDbPath();
  const seedRepo = createSqliteSupervisorRepository(dbPath);
  try {
    await seedRepo.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: ROADMAP,
      checkpoints: [],
      escalations: [],
      provenance: [],
      provenanceAnchor: anchorFor([]),
      updatedAt: 1_000,
      reviewRequests: [{
        roadmapKey: "A", attempt: 1, requestedAt: 1_000,
        provider: "codex-cli", model: "gpt-5.6-luna", effort: "xhigh",
        candidate: { ...CANDIDATE },
      }],
    });
  } finally {
    seedRepo.close();
  }

  const workDir = mkdtempSync(join(scratch, "work-"));
  const script = writeRealSupervisorScript({ dbPath, workDir });

  // Derived exactly as `reviewAckPath`/`safeName` in supervisorService.ts do,
  // so the kill can wait for the REAL worker's own proof of existence —
  // deterministic, rather than racing the launching process's spawn() await.
  const ackPath = join(REVIEW_DIR, "A", `${ACTIVITY_ID.replace(/[^A-Za-z0-9_.-]+/g, "_")}-ack.json`);

  let child: ChildProcess | undefined;
  const supervisorStderr: string[] = [];
  try {
    child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (chunk: Buffer) => supervisorStderr.push(chunk.toString("utf8")));

    // Wait for the REAL detached worker to prove it exists, independent of
    // its (about to be killed) launcher.
    const ackDeadline = Date.now() + 10_000;
    while (!existsSync(ackPath) && Date.now() < ackDeadline && child.exitCode === null) {
      await sleep(20);
    }
    assert.ok(
      existsSync(ackPath),
      `the real detached worker never wrote its own acknowledgement; supervisor exit=${child.exitCode} stderr=${supervisorStderr.join("")}`,
    );
    assert.equal(
      child.exitCode,
      null,
      `the real supervisor exited on its own before it could be killed; stderr=${supervisorStderr.join("")}`,
    );

    const exited = once(child, "exit");
    process.kill(child.pid!, "SIGKILL");
    const [, signal] = await exited;
    assert.equal(signal, "SIGKILL", "the real supervisor process was not actually killed");
    child = undefined;

    // A fresh, real SupervisorService: same database, real liveness probe,
    // and a launcher wrapped only to COUNT real launch attempts.
    let launches = 0;
    const realLauncher = createCodexReviewLauncher({
      repository: workDir,
      packet: () => "no model is called",
      command: () => ["true"],
    });
    const countingLauncher = {
      launch: async (req: ReviewLaunchRequest): Promise<ReviewLaunchResult> => {
        launches += 1;
        return realLauncher.launch(req);
      },
      acknowledgement: (req: ReviewLaunchRequest): LaunchAcknowledgement | undefined => realLauncher.acknowledgement(req),
      completion: (query: { readonly reviewId: string; readonly source: string }): ReviewCompletionReading =>
        realLauncher.completion(query),
    };

    const repository2 = createSqliteSupervisorRepository(dbPath);
    const probe2 = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe2.set(entry.provider, entry.model, { state: "AVAILABLE", reason: "scripted", billingMode: "INCLUDED_SUBSCRIPTION" });
    }
    try {
      const service2 = new SupervisorService({
        repository: repository2,
        roadmapCatalog: [...ROADMAP],
        probe: probe2,
        executor: { execute: async () => ({ kind: "COMPLETED" as const, detail: "ran" }) },
        clock: { now: () => Date.now() },
        ids: createSequentialIdGenerator(),
        routingPolicy: DEFAULT_ROUTING_POLICY,
        resourceCatalog: TEST_CATALOG,
        liveness: createProcLivenessProbe(),
        activityLease: (at: number) => leaseForThisProcess(at),
        reviewLauncher: countingLauncher,
        log: () => {},
      });

      // The real detached wrapper writes its own acknowledgement independent
      // of the killed launcher; poll (via real ticks) until it is adopted.
      let adopted: { readonly state: string; readonly lease?: { readonly pid: number } } | undefined;
      const adoptDeadline = Date.now() + 10_000;
      while (Date.now() < adoptDeadline) {
        await service2.tick();
        const state = await repository2.load();
        adopted = state?.activities?.find((a) => a.id === ACTIVITY_ID);
        if (adopted?.state === "RUNNING") break;
        await sleep(50);
      }
      assert.ok(adopted, "the fresh supervisor found no review record at all");
      assert.equal(
        adopted.state,
        "RUNNING",
        `the fresh supervisor never adopted the real worker's acknowledgement: ${JSON.stringify(adopted)}`,
      );
      assert.notEqual(adopted.lease?.pid, undefined, "adopted with no worker lease pid");
      assert.notEqual(adopted.lease?.pid, process.pid, "the fresh supervisor's OWN pid was adopted as the worker's");
      assert.equal(launches, 0, "a duplicate reviewer process was launched for a review that already had one");

      // Idempotent: a further tick neither relaunches nor re-adopts differently.
      await service2.tick();
      const again = (await repository2.load())?.activities?.find((a) => a.id === ACTIVITY_ID);
      assert.equal(again?.lease?.pid, adopted.lease?.pid);
      assert.equal(launches, 0, "a replayed tick launched another reviewer process");
    } finally {
      repository2.close();
    }
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

// =====================================================================
// BEFORE ACK — the case AC-5/AC-22 actually name (SF-R3 correction round 2)
// =====================================================================

/**
 * The REAL worker for the before-ACK scenario, held behind a gate.
 *
 * Writes its own pid to `${ack}.workerpid` first — a test convenience for
 * cleanup only, not read by any production code — then blocks on the gate
 * file before writing anything the supervisor would recognise as proof of
 * itself. Once released it writes the SAME acknowledgement shape the real
 * wrapper does (run id, its own pid, its own `/proc` start tick, machine and
 * boot identity) and then holds the process open so its pid stays live long
 * enough for the recovering supervisor to adopt it.
 */
function writeGatedWorkerScript(workDir: string): string {
  const script = join(workDir, "gated-worker.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -uo pipefail
GATE="$1"
ACK="$2"
RUN_ID="$3"
echo $$ > "$ACK.workerpid"
while [ ! -f "$GATE" ]; do sleep 0.05; done
START_TICKS=$(awk '{ n = split($0, f, ") "); print f[n] }' /proc/$$/stat | cut -d" " -f20)
MACHINE=$(cat /etc/machine-id 2>/dev/null || echo unknown)
BOOT=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
printf '{"runId":"%s","pid":%s,"processStartedAt":%s,"machine":"%s","boot":"%s","at":%s}\\n' \\
  "$RUN_ID" "$$" "$START_TICKS" "$MACHINE" "$BOOT" "$(date +%s000)" > "$ACK.tmp"
mv "$ACK.tmp" "$ACK"
sleep 300
`,
    { encoding: "utf8", mode: 0o700 },
  );
  return script;
}

/**
 * The killed parent's program: a real `SupervisorService`, spawning the gated
 * worker above INSTEAD OF the real `createCodexReviewLauncher.launch` (which
 * cannot be gated — its wrapper writes the ACK before running its `command`
 * at all). `acknowledgement`/`completion` are NOT reimplemented: they are the
 * genuine adapter's own pure reads, reused unchanged, so this fixture invents
 * exactly one thing — when the worker is allowed to prove it exists — and
 * nothing about how that proof is read.
 */
function writeGatedRealSupervisorScript(options: { readonly dbPath: string; readonly workDir: string; readonly gate: string }): string {
  const script = join(options.workDir, "real-supervisor-gated.mjs");
  const workerScript = writeGatedWorkerScript(options.workDir);
  writeFileSync(
    script,
    `
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSqliteSupervisorRepository } from ${JSON.stringify(join(DIST_SRC, "adapters/supervision/sqliteSupervisorRepository.js"))};
import { createCodexReviewLauncher } from ${JSON.stringify(join(DIST_SRC, "adapters/supervision/codexReviewLauncher.js"))};
import { createProcLivenessProbe, leaseForThisProcess } from ${JSON.stringify(join(DIST_SRC, "adapters/supervision/procLiveness.js"))};
import { createSequentialIdGenerator } from ${JSON.stringify(join(DIST_SRC, "domain/ids.js"))};
import { DEFAULT_ROUTING_POLICY } from ${JSON.stringify(join(DIST_SRC, "supervision/modelRouting.js"))};
import { SupervisorService } from ${JSON.stringify(join(DIST_SRC, "supervision/supervisorService.js"))};
import { scriptedProbe, TEST_CATALOG } from ${JSON.stringify(join(DIST_SUPPORT, "supervisorFixtures.js"))};

const repository = createSqliteSupervisorRepository(${JSON.stringify(options.dbPath)});
const probe = scriptedProbe();
for (const entry of TEST_CATALOG) {
  probe.set(entry.provider, entry.model, { state: "AVAILABLE", reason: "scripted", billingMode: "INCLUDED_SUBSCRIPTION" });
}
// Reused UNCHANGED for its pure reads only. Its own \`launch\` is never called.
const reader = createCodexReviewLauncher({
  repository: ${JSON.stringify(options.workDir)},
  packet: () => "unused",
  command: () => ["true"],
});
const gatedLauncher = {
  launch: async (request) => {
    mkdirSync(dirname(request.ack), { recursive: true });
    const child = spawn(
      "/usr/bin/env",
      ["bash", ${JSON.stringify(workerScript)}, ${JSON.stringify(options.gate)}, request.ack, request.reviewId],
      { detached: true, stdio: "ignore" },
    );
    await new Promise((resolve, reject) => { child.once("error", reject); child.once("spawn", resolve); });
    child.unref();
    return { ok: true, detail: "spawned gated worker" };
  },
  acknowledgement: (request) => reader.acknowledgement(request),
  completion: (query) => reader.completion(query),
};
const service = new SupervisorService({
  repository,
  roadmapCatalog: ${JSON.stringify(ROADMAP_B)},
  probe,
  executor: { execute: async () => ({ kind: "COMPLETED", detail: "ran" }) },
  clock: { now: () => Date.now() },
  ids: createSequentialIdGenerator(),
  routingPolicy: DEFAULT_ROUTING_POLICY,
  resourceCatalog: TEST_CATALOG,
  liveness: createProcLivenessProbe(),
  activityLease: (at) => leaseForThisProcess(at),
  reviewLauncher: gatedLauncher,
  log: () => {},
});
await service.tick();
repository.close();
// Stays alive so it can genuinely be SIGKILLed rather than having already
// exited on its own — see the sibling script above for the full reasoning.
setInterval(() => {}, 60_000);
`,
    "utf8",
  );
  return script;
}

test("a real supervisor SIGKILLed BEFORE its real worker's ACK is durably AMBIGUOUS, launches no duplicate, and adopts a late ACK", async () => {
  const { createSqliteSupervisorRepository } = await import("../src/adapters/supervision/sqliteSupervisorRepository.js");
  const { createProcLivenessProbe, leaseForThisProcess } = await import("../src/adapters/supervision/procLiveness.js");
  const { createCodexReviewLauncher } = await import("../src/adapters/supervision/codexReviewLauncher.js");
  const { createSequentialIdGenerator } = await import("../src/domain/ids.js");
  const { DEFAULT_ROUTING_POLICY } = await import("../src/supervision/modelRouting.js");
  const { SupervisorService } = await import("../src/supervision/supervisorService.js");
  const { scriptedProbe, TEST_CATALOG } = await import("./support/supervisorFixtures.js");

  const dbPath = tempDbPath();
  const seedRepo = createSqliteSupervisorRepository(dbPath);
  try {
    await seedRepo.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [],
      roadmap: ROADMAP_B,
      checkpoints: [],
      escalations: [],
      provenance: [],
      provenanceAnchor: anchorFor([]),
      updatedAt: 1_000,
      reviewRequests: [{
        roadmapKey: "B", attempt: 1, requestedAt: 1_000,
        provider: "codex-cli", model: "gpt-5.6-luna", effort: "xhigh",
        candidate: { ...CANDIDATE },
      }],
    });
  } finally {
    seedRepo.close();
  }

  const workDir = mkdtempSync(join(scratch, "work-gated-"));
  const gate = join(workDir, "release-ack.gate");
  const script = writeGatedRealSupervisorScript({ dbPath, workDir, gate });
  const ackPath = join(REVIEW_DIR, "B", `${ACTIVITY_ID_B.replace(/[^A-Za-z0-9_.-]+/g, "_")}-ack.json`);
  const workerPidPath = `${ackPath}.workerpid`;

  let child: ChildProcess | undefined;
  let workerPid: number | undefined;
  const supervisorStderr: string[] = [];
  try {
    child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (chunk: Buffer) => supervisorStderr.push(chunk.toString("utf8")));

    // Wait for the DURABLE CLAIMED record — never for the ACK, which the gate
    // keeps absent. The claim is what AC-5 says must precede the worker.
    const claimDeadline = Date.now() + 10_000;
    let claimed: { readonly state: string } | undefined;
    const poller = createSqliteSupervisorRepository(dbPath);
    try {
      while (Date.now() < claimDeadline && child.exitCode === null) {
        const state = await poller.load();
        claimed = state?.activities?.find((a) => a.id === ACTIVITY_ID_B);
        if (existsSync(workerPidPath)) {
          workerPid = Number.parseInt(readFileSync(workerPidPath, "utf8").trim(), 10);
        }
        if (claimed?.state === "CLAIMED" && workerPid !== undefined) break;
        await sleep(20);
      }
    } finally {
      poller.close();
    }
    assert.equal(
      claimed?.state, "CLAIMED",
      `the real supervisor never durably claimed the review; exit=${child.exitCode} stderr=${supervisorStderr.join("")}`,
    );
    assert.ok(Number.isInteger(workerPid), "the gated worker was not spawned before the parent was killed");
    assert.equal(child.exitCode, null, `the real supervisor exited on its own before it could be killed; stderr=${supervisorStderr.join("")}`);
    assert.equal(existsSync(ackPath), false, "the ACK existed before the gate was released; the kill would not test the before-ACK case");

    const exited = once(child, "exit");
    process.kill(child.pid!, "SIGKILL");
    const [, signal] = await exited;
    assert.equal(signal, "SIGKILL", "the real supervisor process was not actually killed");
    child = undefined;

    // The gated worker is a SEPARATE detached process; it outlives its dead
    // parent. Its pid was captured before the kill and is used only for cleanup.
    assert.equal(existsSync(ackPath), false, "the gated worker wrote its ACK despite the gate never being released");

    let launches = 0;
    const realLauncher = createCodexReviewLauncher({ repository: workDir, packet: () => "unused", command: () => ["true"] });
    const countingLauncher = {
      launch: async (req: ReviewLaunchRequest): Promise<ReviewLaunchResult> => { launches += 1; return realLauncher.launch(req); },
      acknowledgement: (req: ReviewLaunchRequest): LaunchAcknowledgement | undefined => realLauncher.acknowledgement(req),
      completion: (query: { readonly reviewId: string; readonly source: string }): ReviewCompletionReading => realLauncher.completion(query),
    };

    const repository2 = createSqliteSupervisorRepository(dbPath);
    const probe2 = scriptedProbe();
    for (const entry of TEST_CATALOG) {
      probe2.set(entry.provider, entry.model, { state: "AVAILABLE", reason: "scripted", billingMode: "INCLUDED_SUBSCRIPTION" });
    }
    try {
      const service2 = new SupervisorService({
        repository: repository2,
        roadmapCatalog: [...ROADMAP_B],
        probe: probe2,
        executor: { execute: async () => ({ kind: "COMPLETED" as const, detail: "ran" }) },
        clock: { now: () => Date.now() },
        ids: createSequentialIdGenerator(),
        routingPolicy: DEFAULT_ROUTING_POLICY,
        resourceCatalog: TEST_CATALOG,
        liveness: createProcLivenessProbe(),
        activityLease: (at: number) => leaseForThisProcess(at),
        reviewLauncher: countingLauncher,
        log: () => {},
      });

      // COLD, with the ACK genuinely absent: the tick must refuse a duplicate
      // launch and record durable AMBIGUOUS — not adopt, not relaunch.
      const result = await service2.tick();
      assert.match(JSON.stringify(result), /automatic relaunch is refused/, JSON.stringify(result));
      const afterKill = (await repository2.load())?.activities?.find((a) => a.id === ACTIVITY_ID_B);
      assert.equal(afterKill?.state, "CLAIMED", "the pre-ACK claim was resolved as something other than durably ambiguous");
      assert.equal(afterKill?.reconciliation?.verdict, "AMBIGUOUS");
      assert.equal(launches, 0, "a duplicate reviewer process was launched while the ACK was genuinely absent");

      // A further cold tick, still with the ACK absent, changes nothing.
      await service2.tick();
      const stillAmbiguous = (await repository2.load())?.activities?.find((a) => a.id === ACTIVITY_ID_B);
      assert.equal(stillAmbiguous?.state, "CLAIMED");
      assert.equal(launches, 0, "a replayed tick launched a reviewer process while the ACK was absent");

      // NOW release the gate: the real detached worker — which has been
      // running the whole time, independent of its dead parent — writes its
      // genuine ACK.
      writeFileSync(gate, "release", "utf8");
      let adopted: { readonly state: string; readonly lease?: { readonly pid: number } } | undefined;
      const adoptDeadline = Date.now() + 10_000;
      while (Date.now() < adoptDeadline) {
        await service2.tick();
        adopted = (await repository2.load())?.activities?.find((a) => a.id === ACTIVITY_ID_B);
        if (adopted?.state === "RUNNING") break;
        await sleep(50);
      }
      assert.equal(adopted?.state, "RUNNING", `the fresh supervisor never adopted the late ACK: ${JSON.stringify(adopted)}`);
      assert.notEqual(adopted?.lease?.pid, undefined, "adopted with no worker lease pid");
      assert.equal(launches, 0, "a duplicate reviewer process was launched for a review whose late ACK just arrived");

      await service2.tick();
      const again = (await repository2.load())?.activities?.find((a) => a.id === ACTIVITY_ID_B);
      assert.equal(again?.lease?.pid, adopted?.lease?.pid);
      assert.equal(launches, 0, "a replayed tick after adoption launched another reviewer process");
    } finally {
      repository2.close();
    }
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
    if (workerPid !== undefined) {
      try { process.kill(workerPid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});
