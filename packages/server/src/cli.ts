#!/usr/bin/env node
/**
 * `npx @loupe/server` — start the collector from the command line.
 *
 * Configured by environment variables, because that is what compose files and
 * process managers speak:
 *
 *   PORT         port, default 4300
 *   HOST         bind address; anything but loopback requires LOUPE_TOKEN
 *   LOUPE_TOKEN  shared secret for ingest and the panel
 *   BUFFER_SIZE  how many requests to keep, default 2000
 */

import { createLoupeServer } from './index.js';

const token = process.env['LOUPE_TOKEN'];

const server = await createLoupeServer({
  port: Number(process.env['PORT'] ?? 4300),
  host: process.env['HOST'] ?? '127.0.0.1',
  ...(token ? { token } : {}),
  bufferSize: Number(process.env['BUFFER_SIZE'] ?? 2000),
});

console.log(`
loupe-server is accepting batches

  panel   ${server.url}/_loupe/${token ? `  (sign in: ${server.url}/auth?token=…)` : ''}
  ingest  POST ${server.url}/ingest${token ? '  (authorization: Bearer …)' : ''}
  health  ${server.url}/healthz
${token ? '' : '\n  No token set — the server listens on 127.0.0.1 only.\n'}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
