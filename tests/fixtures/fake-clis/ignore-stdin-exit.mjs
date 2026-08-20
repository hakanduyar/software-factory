#!/usr/bin/env node
// Fake CLI fixture: exits immediately without ever reading stdin, so
// process-runner tests can prove writing `input` to a child that closes
// its read end early (a hostile-but-legal case) never crashes or hangs the
// runner. Synchronous fd write so "done" reaches the pipe before exit.
import { writeSync } from "node:fs";

writeSync(1, "done\n");
process.exit(0);
