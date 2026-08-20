#!/usr/bin/env node
// Fake `claude` CLI: mimics claudeCodeAdapter's confirmed real-CLI contract
// (`-p ... --output-format json`, one JSON result object with a `.result`
// field — see that adapter's file header for the verification detail), so
// the adapter can be tested offline. Debug info goes to stderr as a side
// channel. Controlled via env vars: FAKE_CLAUDE_MODE=success|fail,
// FAKE_CLAUDE_MESSAGE.
const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
const message = process.env.FAKE_CLAUDE_MESSAGE ?? "OK";

process.stderr.write(`ARGV:${JSON.stringify(process.argv.slice(2))}\n`);
process.stderr.write(`CWD:${process.cwd()}\n`);
process.stderr.write(`ENV:${JSON.stringify(process.env)}\n`);

if (mode === "fail") {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error", result: message }));
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: message }));
  process.exitCode = 0;
}
