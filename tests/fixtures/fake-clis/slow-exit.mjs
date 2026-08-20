#!/usr/bin/env node
// Fake CLI fixture: waits argv[0] ms, then exits with code argv[1] (default 0).
// Used to race natural exit against timeout/cancellation, and to give
// persistence tests a window in which to observe a RUNNING run mid-flight.
// Synchronous fd writes so output is never lost to the exit race.
import { writeSync } from "node:fs";

const delayMs = Number(process.argv[2] ?? "100");
const code = Number(process.argv[3] ?? "0");
writeSync(1, "waiting\n");
setTimeout(() => {
  writeSync(1, "done\n");
  process.exit(code);
}, delayMs);
