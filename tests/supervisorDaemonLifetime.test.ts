/** TASK-019 AC-9/18/20: idle ownership must survive a real Node event loop. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

const waiterModule = new URL("../src/cli/supervisor.js", import.meta.url).href;
const loopModule = new URL("../src/supervision/supervisorLoop.js", import.meta.url).href;
const repositoryModule = new URL("../src/adapters/supervision/inMemorySupervisorRepository.js", import.meta.url).href;

type Mode = "idle" | "callback" | "signal" | "legacy-control";

function childProgram(mode: Mode): string {
  return `
    import { createSupervisorWaiter } from ${JSON.stringify(waiterModule)};
    import { runSupervisorLoop } from ${JSON.stringify(loopModule)};
    import { createInMemorySupervisorRepository } from ${JSON.stringify(repositoryModule)};
    const mode = ${JSON.stringify(mode)};
    const repository = createInMemorySupervisorRepository();
    await repository.create({
      version: 1,
      financialPolicy: { autonomousSpendAllowed: false, autonomousSpendLimit: 0 },
      resources: [], roadmap: [], checkpoints: [], escalations: [], provenance: [],
      updatedAt: Date.now(),
    });
    let ticks = 0;
    let stopAt = Infinity;
    // Always supply the callback in the idle case too, so timer cleanup is
    // tested for normal expiry as well as interrupted waits.
    const waiter = createSupervisorWaiter(() => Date.now() >= stopAt);
    try {
      const outcome = await runSupervisorLoop({
        repository,
        service: { tick: async () => {
          ticks += 1;
          console.log('TICK ' + ticks);
          if (mode === 'callback') stopAt = Date.now() + 30;
        } },
        clock: { now: () => Date.now() },
        sleep: async (ms) => {
          let pending;
          if (mode === 'legacy-control') {
            // The original production sleep. This control proves the test
            // harness itself cannot accidentally keep the child alive.
            pending = new Promise((resolve) => {
              const timer = setTimeout(resolve, ms);
              timer.unref();
              const poll = setInterval(() => {
                if (waiter.stopping()) {
                  clearInterval(poll);
                  clearTimeout(timer);
                  resolve();
                }
              }, 250);
              poll.unref();
            });
          } else {
            pending = waiter.sleep(ms);
          }
          console.log('WAITING');
          await pending;
        },
        liveness: { check: () => 'ALIVE' },
        lease: (at) => ({ pid: process.pid, processStartedAt: 1,
          machine: 'fixture', boot: 'fixture', claimedAt: at }),
        ownerId: 'lifetime-fixture',
        intervalMs: mode === 'idle' || mode === 'legacy-control' ? 30 : 30000,
        maxTicks: 4,
      }, waiter.stopping);
      console.log('RESULT ' + JSON.stringify({ outcome, ticks,
        leaseReleased: (await repository.load()).supervisor === undefined }));
    } finally {
      waiter.dispose();
    }
    console.log('TIMERS ' + process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length);
  `;
}

interface ChildResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly sentSignal: boolean;
}

function runChild(mode: Mode, signal?: NodeJS.Signals): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childProgram(mode)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let sentSignal = false;
    const guard = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5000);
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (signal !== undefined && !sentSignal && stdout.includes("WAITING")) {
        sentSignal = true;
        child.kill(signal);
      }
    });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.once("error", (error) => { clearTimeout(guard); reject(error); });
    child.once("close", (code, closedBy) => {
      clearTimeout(guard);
      resolve({ stdout, stderr, code, signal: closedBy, timedOut, sentSignal });
    });
  });
}

function completed(result: ChildResult, ticks: number): void {
  const diagnostic = JSON.stringify(result);
  assert.equal(result.timedOut, false, diagnostic);
  assert.equal(result.signal, null, diagnostic);
  assert.equal(result.code, 0, diagnostic);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
  assert.ok(line, diagnostic);
  assert.deepEqual(JSON.parse(line.slice(7)), {
    outcome: { kind: "STOPPED", ticks }, ticks, leaseReleased: true,
  });
  assert.match(result.stdout, /TIMERS 0/, "a settled sleep left a timer behind: " + diagnostic);
}

describe("the supervisor owns its idle process lifetime", () => {
  it("survives several real idle ticks and exits cleanly at maxTicks", async () => {
    completed(await runChild("idle"), 4);
  });

  it("the old unref sleep exits early in the same child harness", async () => {
    const result = await runChild("legacy-control");
    assert.equal(result.timedOut, false, JSON.stringify(result));
    assert.match(result.stdout, /TICK 1/);
    assert.doesNotMatch(result.stdout, /TICK 2|RESULT /);
    assert.notEqual(result.code, 0, JSON.stringify(result));
  });

  it("SIGTERM wakes a long sleep and releases ownership without another tick", async () => {
    const result = await runChild("signal", "SIGTERM");
    assert.equal(result.sentSignal, true, JSON.stringify(result));
    completed(result, 1);
  });

  it("SIGINT also wakes a long sleep cleanly", async () => {
    const result = await runChild("signal", "SIGINT");
    assert.equal(result.sentSignal, true, JSON.stringify(result));
    completed(result, 1);
  });

  it("the supplied stopping callback wakes a long sleep and clears the poll", async () => {
    completed(await runChild("callback"), 1);
  });
});
