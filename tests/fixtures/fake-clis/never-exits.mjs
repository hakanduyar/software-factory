#!/usr/bin/env node
// Fake CLI fixture: ignores SIGTERM and never exits on its own, so
// process-runner tests can prove SIGKILL escalation actually terminates it.
// Uses a synchronous fd write (not process.stdout.write, which is async for
// a piped stream) so "started" is guaranteed to reach the pipe before
// SIGKILL can possibly arrive, however loaded the machine is.
import { writeSync } from "node:fs";

process.on("SIGTERM", () => {
  // Deliberately do nothing — only SIGKILL can stop this process.
});
writeSync(1, "started\n");
setInterval(() => {}, 1000);
