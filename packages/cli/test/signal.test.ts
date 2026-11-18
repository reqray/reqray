/**
 * Ctrl+C.
 *
 * Skipped when there is no `dist` — run `pnpm build` first; CI builds before
 * it tests, which is where this one has to hold.
 *
 * The one thing that cannot be checked without a process: a signal handler,
 * an exit code, and the promise that nothing resembling a stack trace is
 * printed on the way out. Runs against the built executable, which is what a
 * person actually runs.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeCollector } from './fixtures/collector.js';
import { calmRows } from './fixtures/rows.js';

const BIN = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const built = existsSync(BIN);

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const collector of open.splice(0)) await collector.close();
});

describe.skipIf(!built)('the built executable', () => {
  it('stops on Ctrl+C, cleanly and without a stack trace', async () => {
    const panel = await fakeCollector({ rows: calmRows() });
    open.push(panel);

    const child = spawn(process.execPath, [BIN, 'watch', '--url', panel.url], {
      env: { ...process.env, COLUMNS: '100', NO_COLOR: '1' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });

    // Wait until it is actually watching, so the signal interrupts the stream
    // rather than the startup.
    const deadline = Date.now() + 5_000;
    while (panel.watchers() === 0) {
      if (Date.now() > deadline) throw new Error(`the client never connected: ${err}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    panel.push(calmRows()[0] as never);
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill('SIGINT');

    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('ctrl-c to stop');
    expect(out).toContain('/health');
  }, 15_000);
});
