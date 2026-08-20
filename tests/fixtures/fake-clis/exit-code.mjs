#!/usr/bin/env node
// Fake CLI fixture: exits with the code given as argv[0] (default 0), printing
// a marker to stdout/stderr first so tests can confirm output was still captured.
// Uses synchronous fd writes (not process.stdout.write, async for a piped
// stream on POSIX) so the markers are guaranteed to reach the pipe before
// process.exit() runs, regardless of machine load.
import { writeSync } from "node:fs";

const code = Number(process.argv[2] ?? "0");
writeSync(1, `exiting with ${code}\n`);
writeSync(2, `stderr marker ${code}\n`);
process.exit(code);
