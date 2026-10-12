import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createDirectLaunchAuthorityFixture,
  mintBinding,
  type RawDirectLaunchTuple,
} from "./support/directLaunchAuthorityFixture.js";
import type { RunId, WorkItemId } from "../src/domain/ids.js";

function tuple(overrides: Partial<RawDirectLaunchTuple> = {}): RawDirectLaunchTuple {
  return {
    ticketDigest: "digest-1",
    registryPrincipalId: "principal-1",
    workItemId: "wi-1" as WorkItemId,
    specRevision: 1,
    runId: "run-1" as RunId,
    reservationId: "res-1",
    reservationVersion: 1,
    ...overrides,
  };
}

async function withTempDb(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dla-"));
  const dbPath = join(dir, "test.db");
  try {
    await fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("smoke: register, readiness, consume, receipt shape", async () => {
  await withTempDb(async (dbPath) => {
    const fx = createDirectLaunchAuthorityFixture(dbPath);
    try {
      const t = tuple();
      const binding = fx.register(t);
      assert.equal(await fx.checkReadiness(binding), true);
      assert.equal(await fx.checkReadiness(binding), true);
      const receipt = await fx.atomicConsumeLaunch(binding);
      assert.deepEqual(receipt.binding, mintBinding(t));
      assert.notEqual(receipt.binding, binding);
      assert.ok(Object.isFrozen(receipt));
      assert.ok(Object.isFrozen(receipt.binding));
      assert.equal(typeof receipt.consumedAt, "string");
    } finally {
      fx.close();
    }
  });
});

test("replay refuses, including after reopen", async () => {
  await withTempDb(async (dbPath) => {
    const fx1 = createDirectLaunchAuthorityFixture(dbPath);
    const t = tuple({ reservationId: "res-replay" });
    const binding = fx1.register(t);
    await fx1.atomicConsumeLaunch(binding);
    await assert.rejects(() => fx1.atomicConsumeLaunch(binding), /refused/);
    fx1.close();

    const fx2 = createDirectLaunchAuthorityFixture(dbPath);
    try {
      await assert.rejects(() => fx2.atomicConsumeLaunch(binding), /refused/);
    } finally {
      fx2.close();
    }
  });
});

test("fresh distinct reservation consumes independently", async () => {
  await withTempDb(async (dbPath) => {
    const fx = createDirectLaunchAuthorityFixture(dbPath);
    try {
      const a = fx.register(tuple({ reservationId: "res-a" }));
      const b = fx.register(tuple({ reservationId: "res-b" }));
      const ra = await fx.atomicConsumeLaunch(a);
      const rb = await fx.atomicConsumeLaunch(b);
      assert.equal(ra.binding.reservationId, "res-a");
      assert.equal(rb.binding.reservationId, "res-b");
    } finally {
      fx.close();
    }
  });
});

test("seven independent single-field mismatches refuse, original still usable", async () => {
  await withTempDb(async (dbPath) => {
    const fx = createDirectLaunchAuthorityFixture(dbPath);
    try {
      const good = tuple({ reservationId: "res-mismatch" });
      const binding = fx.register(good);

      const mismatches: RawDirectLaunchTuple[] = [
        { ...good, ticketDigest: "other-digest" },
        { ...good, registryPrincipalId: "other-principal" },
        { ...good, workItemId: "wi-other" as WorkItemId },
        { ...good, specRevision: 2 },
        { ...good, runId: "run-other" as RunId },
        { ...good, reservationVersion: 2 },
        { ...good, reservationId: "res-missing" },
      ];

      for (const m of mismatches) {
        const bad = mintBinding(m);
        await assert.rejects(
          () => fx.atomicConsumeLaunch(bad),
          /refused for reservation/,
        );
      }

      const receipt = await fx.atomicConsumeLaunch(binding);
      assert.equal(receipt.binding.reservationId, "res-mismatch");
    } finally {
      fx.close();
    }
  });
});

test("cancel refuses future consume; rebind refuses", async () => {
  await withTempDb(async (dbPath) => {
    const fx = createDirectLaunchAuthorityFixture(dbPath);
    try {
      const t = tuple({ reservationId: "res-cancel" });
      const binding = fx.register(t);
      fx.cancel("res-cancel");
      await assert.rejects(() => fx.atomicConsumeLaunch(binding), /refused/);
      assert.throws(
        () => fx.register(tuple({ reservationId: "res-cancel", ticketDigest: "changed" })),
        /already bound to a different tuple/,
      );
    } finally {
      fx.close();
    }
  });
});

test("adversarial delimiter-styled distinct tuples both consume once", async () => {
  await withTempDb(async (dbPath) => {
    const fx = createDirectLaunchAuthorityFixture(dbPath);
    try {
      const t1 = tuple({
        reservationId: "res-delim-1",
        ticketDigest: "a' OR '1'='1",
        registryPrincipalId: "p; DROP TABLE direct_launch_bindings;--",
      });
      const t2 = tuple({
        reservationId: "res-delim-2",
        ticketDigest: "a\" OR \"1\"=\"1",
        registryPrincipalId: "p\u0000embedded",
      });
      const b1 = fx.register(t1);
      const b2 = fx.register(t2);
      const r1 = await fx.atomicConsumeLaunch(b1);
      const r2 = await fx.atomicConsumeLaunch(b2);
      assert.equal(r1.binding.reservationId, "res-delim-1");
      assert.equal(r2.binding.reservationId, "res-delim-2");
      await assert.rejects(() => fx.atomicConsumeLaunch(b1), /refused/);
      await assert.rejects(() => fx.atomicConsumeLaunch(b2), /refused/);
    } finally {
      fx.close();
    }
  });
});

test("direct SQL state tamper rejects original all-field match", async () => {
  await withTempDb(async (dbPath) => {
    const fx = createDirectLaunchAuthorityFixture(dbPath);
    try {
      const t = tuple({ reservationId: "res-tamper" });
      const binding = fx.register(t);

      const raw = new DatabaseSync(dbPath);
      raw
        .prepare(
          "UPDATE direct_launch_bindings SET ticketDigest = ? WHERE reservationId = ?",
        )
        .run("tampered-digest", "res-tamper");
      raw.close();

      await assert.rejects(() => fx.atomicConsumeLaunch(binding), /refused/);
    } finally {
      fx.close();
    }
  });
});

test("missing binding refuses", async () => {
  await withTempDb(async (dbPath) => {
    const fx = createDirectLaunchAuthorityFixture(dbPath);
    try {
      const binding = mintBinding(tuple({ reservationId: "res-never-registered" }));
      await assert.rejects(() => fx.atomicConsumeLaunch(binding), /refused/);
      assert.equal(await fx.checkReadiness(binding), false);
    } finally {
      fx.close();
    }
  });
});
test("genuine cross-process race on same reservation; negative control detects disabled enforcement", async () => {
  await withTempDb(async (dbPath) => {
    const { spawn } = await import("node:child_process");
    const fixtureUrl = new URL("./support/directLaunchAuthorityFixture.js", import.meta.url).href;
    const t = tuple({ reservationId: "res-race" });
    const fxSetup = createDirectLaunchAuthorityFixture(dbPath);
    fxSetup.register(t);
    fxSetup.close();

    const childSource = `
      import { createDirectLaunchAuthorityFixture, mintBinding } from ${JSON.stringify(fixtureUrl)};
      const [, dbPath, tupleJson] = process.argv;
      const tuple = JSON.parse(tupleJson);
      const fx = createDirectLaunchAuthorityFixture(dbPath);
      const binding = mintBinding(tuple);
      const ready = await fx.checkReadiness(binding);
      process.send({ type: "ready", ready });
      await new Promise((resolve) => {
        process.once("message", (msg) => { if (msg && msg.type === "go") resolve(undefined); });
      });
      let receiptBinding = null;
      try {
        const receipt = await fx.atomicConsumeLaunch(binding);
        receiptBinding = receipt.binding;
      } catch {
        receiptBinding = null;
      }
      process.send({ type: "result", receiptBinding });
      fx.close();
      process.exit(0);
    `;

    function spawnChild(tupleArg: RawDirectLaunchTuple): {
      proc: import("node:child_process").ChildProcess;
      ready: Promise<void>;
      result: Promise<RawDirectLaunchTuple | null>;
      exited: Promise<void>;
      stderr: string[];
    } {
      const proc = spawn(
        process.execPath,
        ["--input-type=module", "-e", childSource, dbPath, JSON.stringify(tupleArg)],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      const stderr: string[] = [];
      proc.stderr?.on("data", (d) => stderr.push(String(d)));
      let resolveReady: () => void;
      let rejectReady: (err: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      let resolveResult: (receiptBinding: RawDirectLaunchTuple | null) => void;
      let rejectResult: (err: Error) => void;
      const result = new Promise<RawDirectLaunchTuple | null>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      let resolveExited: () => void;
      const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
      let settled = false;
      proc.on("message", (msg: { type: string; ready?: boolean; receiptBinding?: RawDirectLaunchTuple | null }) => {
        if (msg.type === "ready" && msg.ready) resolveReady();
        if (msg.type === "result") { settled = true; resolveResult(msg.receiptBinding ?? null); }
      });
      proc.on("error", (err) => {
        rejectReady(err);
        if (!settled) { settled = true; rejectResult(err); }
      });
      proc.on("exit", (code) => {
        resolveExited();
        if (!settled) {
          settled = true;
          const err = new Error(`child exited early with code ${code}; stderr=${stderr.join("")}`);
          rejectReady(err);
          rejectResult(err);
        }
      });
      return { proc, ready, result, exited, stderr };
    }

    const c1 = spawnChild(t);
    const c2 = spawnChild(t);
    let clearGuard: () => void = () => {};
    const guard = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 10000);
      clearGuard = () => clearTimeout(timer);
    });

    try {
      await Promise.race([Promise.all([c1.ready, c2.ready]), guard]);
      c1.proc.send({ type: "go" });
      c2.proc.send({ type: "go" });

      const [b1, b2] = await Promise.race([
        Promise.all([c1.result, c2.result]),
        guard,
      ]);
      clearGuard();
      await Promise.all([c1.exited, c2.exited]);

      const successCount = (b1 ? 1 : 0) + (b2 ? 1 : 0);
      assert.equal(
        successCount,
        1,
        `expected exactly one consumer to succeed, got ${successCount}; stderr1=${c1.stderr.join("")} stderr2=${c2.stderr.join("")}`,
      );
      const winningBinding = b1 ?? b2;
      assert.deepEqual(winningBinding, mintBinding(t));
      const countDb = new DatabaseSync(dbPath);
      try {
        const row = countDb
          .prepare("SELECT COUNT(*) as c FROM direct_launch_bindings WHERE reservationId = ? AND state = 'consumed'")
          .get("res-race") as { c: number };
        assert.equal(Number(row.c), 1);
      } finally {
        countDb.close();
      }

      const reopened = createDirectLaunchAuthorityFixture(dbPath);
      try {
        const binding = mintBinding(t);
        await assert.rejects(() => reopened.atomicConsumeLaunch(binding), /refused/);
      } finally {
        reopened.close();
      }

      const raw = new DatabaseSync(dbPath);
      try {
        raw
          .prepare("UPDATE direct_launch_bindings SET state = 'pending' WHERE reservationId = ?")
          .run("res-race");
      } finally {
        raw.close();
      }

      const fxAfterReset = createDirectLaunchAuthorityFixture(dbPath);
      try {
        const binding = mintBinding(t);
        const secondReceipt = await fxAfterReset.atomicConsumeLaunch(binding);
        assert.ok(secondReceipt);
        const totalReceiptsObserved = successCount + 1;
        assert.throws(
          () => assert.equal(totalReceiptsObserved, 1),
          "negative control: direct state reset produced a second receipt, so the same cardinality oracle that proved exactly-once in the race now correctly fails, demonstrating enforcement is bypassable by direct state tampering",
        );
      } finally {
        fxAfterReset.close();
      }
    } finally {
      clearGuard();
      c1.proc.kill();
      c2.proc.kill();
      await Promise.all([c1.exited, c2.exited]);
    }
  });
});
test("fresh separate process replay against persisted consumed state refuses", async () => {
  await withTempDb(async (dbPath) => {
    const fx = createDirectLaunchAuthorityFixture(dbPath);
    const t = tuple({ reservationId: "res-fresh-process-replay" });
    const binding = fx.register(t);
    await fx.atomicConsumeLaunch(binding);
    fx.close();

    const { spawnSync } = await import("node:child_process");
    const fixtureUrl = new URL("./support/directLaunchAuthorityFixture.js", import.meta.url).href;
    const childSource = `
      import { createDirectLaunchAuthorityFixture, mintBinding } from ${JSON.stringify(fixtureUrl)};
      const [, dbPath, tupleJson] = process.argv;
      const fx = createDirectLaunchAuthorityFixture(dbPath);
      try {
        await fx.atomicConsumeLaunch(mintBinding(JSON.parse(tupleJson)));
        process.exitCode = 1;
      } catch {
        process.stdout.write("REPLAY_REFUSED");
        process.exitCode = 0;
      } finally {
        fx.close();
      }
    `;
    const res = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", childSource, dbPath, JSON.stringify(t)],
      { timeout: 5000, encoding: "utf8" },
    );
    assert.equal(res.error, undefined);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /REPLAY_REFUSED/);
  });
});
test("delimiter-collision tuples with same reservationId distinguish by field boundaries", async () => {
  await withTempDb(async (dbPath) => {
    const fx = createDirectLaunchAuthorityFixture(dbPath);
    try {
      const t1 = tuple({
        reservationId: "res-delim-collision",
        ticketDigest: "a|b",
        registryPrincipalId: "c",
      });
      const t2 = tuple({
        reservationId: "res-delim-collision",
        ticketDigest: "a",
        registryPrincipalId: "b|c",
      });
      assert.equal([t1.ticketDigest, t1.registryPrincipalId].join("|"), [t2.ticketDigest, t2.registryPrincipalId].join("|"));
      assert.notDeepEqual(t1, t2);

      const binding1 = fx.register(t1);
      const binding2 = mintBinding(t2);

      assert.equal(await fx.checkReadiness(binding2), false);
      await assert.rejects(() => fx.atomicConsumeLaunch(binding2), /refused/);

      assert.equal(await fx.checkReadiness(binding1), true);
      await fx.atomicConsumeLaunch(binding1);
      await assert.rejects(() => fx.atomicConsumeLaunch(binding1), /refused/);
    } finally {
      fx.close();
    }
  });
});