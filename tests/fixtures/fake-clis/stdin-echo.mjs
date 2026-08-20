#!/usr/bin/env node
// Fake CLI fixture: reads all of stdin and echoes its exact content, prefixed,
// so process-runner tests can confirm `input` is delivered byte-for-byte.
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  process.stdout.write(`received:${Buffer.concat(chunks).toString("utf8")}`);
  // No process.exit(): see echo-args.mjs for why.
});
