#!/usr/bin/env node
// Fake CLI fixture: reports exactly what it was invoked with, so process-runner
// tests can assert argv/cwd/env/stdin plumbing without touching a real CLI.
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  process.stdout.write(
    JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      env: process.env,
      stdin,
    }),
  );
  // No process.exit(): falling off the end lets Node flush the write to the
  // (async, on POSIX pipes) stdout stream before the process actually exits.
});
