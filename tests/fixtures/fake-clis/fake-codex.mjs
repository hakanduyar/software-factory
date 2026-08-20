#!/usr/bin/env node
// Fake `codex` CLI: mimics the real `codex exec --json` contract verified in
// docs/tasks/TASK-003-worker-runner.md, so codexCliAdapter can be tested
// offline. Debug info (argv/cwd/env) goes to stderr as a side channel so it
// never interferes with the stdout JSONL the adapter actually parses.
// Controlled via env vars: FAKE_CODEX_MODE=success|fail, FAKE_CODEX_MESSAGE,
// FAKE_CODEX_SLEEP_MS.
const mode = process.env.FAKE_CODEX_MODE ?? "success";
const message = process.env.FAKE_CODEX_MESSAGE ?? "OK";
const sleepMs = Number(process.env.FAKE_CODEX_SLEEP_MS ?? "0");

process.stderr.write(`ARGV:${JSON.stringify(process.argv.slice(2))}\n`);
process.stderr.write(`CWD:${process.cwd()}\n`);
process.stderr.write(`ENV:${JSON.stringify(process.env)}\n`);

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main() {
  if (sleepMs > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, sleepMs));
  }
  emit({ type: "thread.started", thread_id: "fake-thread-0" });
  emit({ type: "turn.started" });
  if (mode === "fail") {
    emit({ type: "error", status: 400, error: { type: "invalid_request_error", message } });
    process.exitCode = 1;
    return;
  }
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: message } });
  emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
}

await main();
// No process.exit(): let Node flush stdio and exit naturally with process.exitCode.
