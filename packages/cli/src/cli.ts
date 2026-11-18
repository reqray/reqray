#!/usr/bin/env node
/**
 * `reqray` — the executable.
 *
 * Nothing but the wiring: the signal that Ctrl+C sends, the streams, and the
 * exit code. Everything a test needs is in `app.ts`, one import away.
 */

import { run } from './app.js';

const controller = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Ctrl+C ends the stream and the process with it: instantly, quietly, and
    // without a stack trace on the way out.
    controller.abort();
    process.exit(0);
  });
}

const code = await run(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  signal: controller.signal,
});

process.exitCode = code;
