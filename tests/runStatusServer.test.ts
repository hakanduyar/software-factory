import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import {
  createRunStatusServer,
  listenRunStatusServer,
} from "../src/adapters/http/runStatusServer.js";
import { createInMemoryStore } from "../src/adapters/memory/inMemoryStore.js";
import type { Run } from "../src/domain/run.js";

function getRunStatus(
  port: number,
  runId: string,
): Promise<{ status: number | undefined; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/runs/${runId}`,
        method: "GET",
        headers: { Host: `127.0.0.1:${port}` },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        response.on("end", () => {
          resolve({ status: response.statusCode, headers: response.headers, body });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("run status server returns the run lifecycle as JSON", async () => {
  const store = createInMemoryStore();
  const run: Run = {
    id: "run137",
    workItemId: "work137",
    specRevision: 1,
    role: "IMPLEMENTER",
    workerPrincipalId: "test-principal",
    declaredWorkerId: "test-worker",
    status: "RUNNING",
    summary: "private-test-sentinel",
    targetRunId: "private-target",
    claimsAcceptanceMet: false,
    evidenceIds: ["private-evidence"],
    startedAt: 1700000000000,
  };
  await store.runs.create(run);

  const server = createRunStatusServer({ runs: store.runs });
  const address = await listenRunStatusServer(server, 0);
  try {
    assert.equal(address.address, "127.0.0.1");

    const running = await getRunStatus(address.port, "run137");
    assert.equal(running.status, 200);
    assert.equal(running.headers["content-type"], "application/json");
    assert.equal(running.headers["cache-control"], "no-store");
    assert.deepStrictEqual(JSON.parse(running.body), {
      id: "run137",
      workItemId: "work137",
      role: "IMPLEMENTER",
      status: "RUNNING",
      startedAt: 1700000000000,
    });

    await store.runs.complete("run137", {
      status: "SUCCEEDED",
      summary: "private-completed",
      claimsAcceptanceMet: true,
      evidenceIds: ["private-evidence"],
      finishedAt: 1700000001000,
    });

    const completed = await getRunStatus(address.port, "run137");
    assert.equal(completed.status, 200);
    assert.equal(completed.headers["content-type"], "application/json");
    assert.equal(completed.headers["cache-control"], "no-store");
    assert.deepStrictEqual(JSON.parse(completed.body), {
      id: "run137",
      workItemId: "work137",
      role: "IMPLEMENTER",
      status: "SUCCEEDED",
      startedAt: 1700000000000,
      finishedAt: 1700000001000,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

function sendRawRequest(
  port: number,
  method: string,
  path: string,
  headers: http.OutgoingHttpHeaders | string[],
): Promise<{ status: number | undefined; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        response.on("end", () => {
          resolve({ status: response.statusCode, headers: response.headers, body });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("run status server rejects malformed requests and untrusted origins", async () => {
  const store = createInMemoryStore();
  const run: Run = {
    id: "run137",
    workItemId: "work137",
    specRevision: 1,
    role: "IMPLEMENTER",
    workerPrincipalId: "test-principal",
    declaredWorkerId: "test-worker",
    status: "RUNNING",
    summary: "private-test-sentinel",
    targetRunId: "private-target",
    claimsAcceptanceMet: false,
    evidenceIds: ["private-evidence"],
    startedAt: 1700000000000,
  };
  await store.runs.create(run);
  const baseline = await store.runs.findById("run137");

  const server = createRunStatusServer({ runs: store.runs });
  const address = await listenRunStatusServer(server, 0);
  const exactHost = `127.0.0.1:${address.port}`;

  try {
    const notFound = await sendRawRequest(address.port, "GET", "/runs/unknown", {
      Host: exactHost,
    });
    assert.equal(notFound.status, 404);
    assert.equal(notFound.headers["content-type"], "application/json");
    assert.equal(notFound.headers["cache-control"], "no-store");
    assert.equal(notFound.headers["access-control-allow-origin"], undefined);

    const unrelated = await sendRawRequest(address.port, "GET", "/unrelated", {
      Host: exactHost,
    });
    assert.equal(unrelated.status, 404);

    const malformedPercent = await sendRawRequest(address.port, "GET", "/runs/%zz", {
      Host: exactHost,
    });
    assert.equal(malformedPercent.status, 400);

    const invalidUtf8 = await sendRawRequest(address.port, "GET", "/runs/%FF", {
      Host: exactHost,
    });
    assert.equal(invalidUtf8.status, 400);

    const withQuery = await sendRawRequest(address.port, "GET", "/runs/run137?x=1", {
      Host: exactHost,
    });
    assert.equal(withQuery.status, 400);

    const withFragment = await sendRawRequest(address.port, "GET", "/runs/run137#x", {
      Host: exactHost,
    });
    assert.equal(withFragment.status, 400);

    const absoluteForm = await sendRawRequest(
      address.port,
      "GET",
      `http://127.0.0.1:${address.port}/runs/run137`,
      { Host: exactHost },
    );
    assert.equal(absoluteForm.status, 400);

    const wrongMethod = await sendRawRequest(address.port, "POST", "/runs/run137", {
      Host: exactHost,
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers["allow"], "GET");
    assert.equal(wrongMethod.headers["content-type"], "application/json");
    assert.equal(wrongMethod.headers["cache-control"], "no-store");

    const foreignHost = await sendRawRequest(address.port, "GET", "/runs/run137", {
      Host: `127.0.0.1:${address.port + 1}`,
    });
    assert.equal(foreignHost.status, 403);
    assert.equal(foreignHost.body.includes("run137"), false);
    assert.equal(foreignHost.body.includes("private"), false);

    const untrustedOrigin = await sendRawRequest(address.port, "GET", "/runs/run137", {
      Host: exactHost,
      Origin: "https://example.invalid",
    });
    assert.equal(untrustedOrigin.status, 403);
    assert.equal(untrustedOrigin.body.includes("run137"), false);
    assert.equal(untrustedOrigin.body.includes("private"), false);

    const emptyOrigin = await sendRawRequest(address.port, "GET", "/runs/run137", {
      Host: exactHost,
      Origin: "",
    });
    assert.equal(emptyOrigin.status, 403);
    assert.equal(emptyOrigin.body.includes("run137"), false);
    assert.equal(emptyOrigin.body.includes("private"), false);

    const duplicateHost = await sendRawRequest(address.port, "GET", "/runs/run137", [
      "Host",
      exactHost,
      "Host",
      exactHost,
    ]);
    assert.equal(duplicateHost.status, 403);
    assert.equal(duplicateHost.body.includes("run137"), false);
    assert.equal(duplicateHost.body.includes("private"), false);

    const afterAll = await store.runs.findById("run137");
    assert.deepStrictEqual(afterAll, baseline);

    for (const response of [
      notFound,
      unrelated,
      malformedPercent,
      invalidUtf8,
      withQuery,
      withFragment,
      absoluteForm,
      wrongMethod,
      foreignHost,
      untrustedOrigin,
      emptyOrigin,
      duplicateHost,
    ]) {
      assert.equal(response.headers["content-type"], "application/json");
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["access-control-allow-origin"], undefined);
      assert.doesNotThrow(() => JSON.parse(response.body));
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("run status server returns a generic error for repository failures", async () => {
  const server = createRunStatusServer({
    runs: {
      findById: async () => {
        throw new Error("private-repository-secret-sentinel");
      },
    },
  });
  const address = await listenRunStatusServer(server, 0);
  try {
    const response = await getRunStatus(address.port, "run137");
    assert.equal(response.status, 500);
    assert.equal(response.headers["content-type"], "application/json");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    const parsed = JSON.parse(response.body);
    assert.equal(typeof parsed, "object");
    assert.equal(response.body.includes("private-repository-secret-sentinel"), false);
    assert.equal(response.body.toLowerCase().includes("stack"), false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("run status server rejects invalid ports before listening", async () => {
  for (const port of [-1, 65536, 1.5, NaN]) {
    const server = createRunStatusServer({
      runs: {
        findById: async () => undefined,
      },
    });
    await assert.rejects(listenRunStatusServer(server, port));
    assert.equal(server.listening, false);
    assert.equal(server.address(), null);
  }
});
