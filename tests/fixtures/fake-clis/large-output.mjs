#!/usr/bin/env node
// Fake CLI fixture: writes argv[0] bytes to stdout and argv[1] bytes to stderr
// (default 2 MiB / 1 MiB), respecting backpressure, so process-runner tests can
// prove bounded capture drains a chatty child instead of deadlocking on it.
const stdoutBytes = Number(process.argv[2] ?? 2 * 1024 * 1024);
const stderrBytes = Number(process.argv[3] ?? 1 * 1024 * 1024);
const CHUNK = "x".repeat(64 * 1024);

function writeAll(stream, totalBytes) {
  return new Promise((resolveWrite) => {
    let written = 0;
    function pump() {
      let ok = true;
      while (written < totalBytes && ok) {
        const remaining = totalBytes - written;
        const piece = remaining >= CHUNK.length ? CHUNK : CHUNK.slice(0, remaining);
        written += piece.length;
        ok = stream.write(piece);
      }
      if (written >= totalBytes) {
        resolveWrite();
      } else {
        stream.once("drain", pump);
      }
    }
    pump();
  });
}

await writeAll(process.stdout, stdoutBytes);
await writeAll(process.stderr, stderrBytes);
// No process.exit() here: on a piped (non-TTY) stdout/stderr, exit() can
// truncate output that has been accepted into the stream but not yet
// flushed to the OS pipe. Falling off the end of the module lets Node
// finish flushing before it exits naturally, with no pending handles left.
