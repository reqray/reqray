#!/usr/bin/env node
/**
 * `npx @reqray/server` — start the collector from the command line.
 *
 * Configured by environment variables, because that is what compose files and
 * process managers speak:
 *
 *   PORT         port, default 4300
 *   HOST         bind address; anything but loopback requires REQRAY_TOKEN
 *   REQRAY_TOKEN  shared secret for ingest and the panel
 *   BUFFER_SIZE  how many requests to keep: 2000 in memory, 20000 with a file
 *   REQRAY_DB     path to a SQLite file; without it requests live in memory
 *                and are gone when this process is
 *   MAX_BYTES    with REQRAY_DB: how much disk the history may take
 *   REQRAY_LOG    directory for the request log: one JSON line per request,
 *                a file per day, swept by the same retention policy
 *   REQRAY_DAYS   how many days to keep — store and log alike. Changeable
 *                from the panel, and remembered on disk
 */

import { createReqrayServer } from './index.js';

const token = process.env['REQRAY_TOKEN'];
const db = process.env['REQRAY_DB'];
const bufferSize = Number(process.env['BUFFER_SIZE']);
const maxBytes = Number(process.env['MAX_BYTES']);
const logDir = process.env['REQRAY_LOG'];
const retentionDays = Number(process.env['REQRAY_DAYS']);

const server = await createReqrayServer({
  port: Number(process.env['PORT'] ?? 4300),
  host: process.env['HOST'] ?? '127.0.0.1',
  ...(token ? { token } : {}),
  // Left unset the store picks its own: the ring keeps 2000, the history
  // keeps far more, and neither should inherit the other's number.
  ...(Number.isFinite(bufferSize) && bufferSize > 0 ? { bufferSize } : {}),
  ...(db ? { db } : {}),
  ...(Number.isFinite(maxBytes) && maxBytes > 0 ? { maxBytes } : {}),
  ...(logDir ? { logDir } : {}),
  ...(Number.isFinite(retentionDays) && retentionDays > 0 ? { retentionDays } : {}),
});

console.log(`
reqray-server is accepting batches

  storage ${db ? `SQLite at ${db} — the history outlives this process` : 'in memory — gone when this process is'}${logDir ? `\n  log     ${logDir} — one JSON line per request, a file per day` : ''}${Number.isFinite(retentionDays) && retentionDays > 0 ? `\n  keeping ${retentionDays} days, changeable from the panel` : ''}
  panel   ${server.url}/_reqray/${token ? `  (sign in: ${server.url}/auth?token=…)` : ''}
  ingest  POST ${server.url}/ingest${token ? '  (authorization: Bearer …)' : ''}
  health  ${server.url}/healthz
${token ? '' : '\n  No token set — the server listens on 127.0.0.1 only.\n'}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
