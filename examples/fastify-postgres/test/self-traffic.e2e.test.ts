/**
 * The demo fills its own panel.
 *
 * Every other e2e here runs with `DEMO_TRAFFIC=off` so the assertions are
 * about traffic the test issued. This one is the opposite: nothing is
 * requested, and the panel has to fill anyway — which is the whole promise of
 * the demo, and the thing that quietly breaks the moment the loop is wired
 * wrong.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exampleRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = `${exampleRoot}../../`;

let app: ChildProcess;
let base: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    probe.on('error', reject);
  });
}

interface Row {
  id: string;
  path: string;
  status: number;
  flag: string | null;
  test: string | null;
}

async function requests(): Promise<Row[]> {
  const response = await fetch(`${base}/_reqray/api/requests?limit=100`);
  const payload = (await response.json()) as { requests: Row[] };
  return payload.requests;
}

/**
 * Waits for the thing being asserted, not for a row count.
 *
 * A pass walks its plan in order, so "twenty rows have arrived" says nothing
 * about whether the exception at the end of it has happened yet.
 */
async function waitFor(
  what: string,
  ready: (rows: Row[]) => boolean,
  timeoutMs: number,
): Promise<Row[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: Row[] = [];
  while (Date.now() < deadline) {
    try {
      rows = await requests();
      if (ready(rows)) return rows;
    } catch {
      // Still starting: the panel is not up until the app is.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the demo did not produce ${what} on its own (${rows.length} requests seen)`);
}

const distinctPaths = (rows: Row[]) => new Set(rows.map((row) => row.path)).size;
const flagsOf = (rows: Row[]) => new Set(rows.map((row) => row.flag).filter(Boolean));

beforeAll(async () => {
  if (!existsSync(`${repoRoot}packages/register/dist/index.js`)) {
    execFileSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit', timeout: 300_000 });
  }

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['--import', '@reqray/register', 'src/index.js'], {
    cwd: exampleRoot,
    // Fast enough to finish a pass inside the test, slow enough to stay
    // sequential — the loop sends one request at a time by design.
    env: { ...process.env, PORT: String(port), DEMO_TRAFFIC_INTERVAL: '60' },
    stdio: 'ignore',
  });
}, 400_000);

afterAll(() => {
  app?.kill('SIGKILL');
});

describe('a demo that drives itself', () => {
  it('fills the panel without anyone touching a route', async () => {
    // Not one route hammered: a pass walks the whole plan.
    const rows = await waitFor('a spread of routes', (all) => distinctPaths(all) > 6, 90_000);

    expect(distinctPaths(rows)).toBeGreaterThan(6);
  });

  it('produces the findings the panel exists to show', async () => {
    const rows = await waitFor(
      'more than one kind of finding',
      // The N+1 is the flagship; the rest come from the same single pass.
      (all) => flagsOf(all).has('n_plus_one') && flagsOf(all).size > 1,
      90_000,
    );

    expect(flagsOf(rows)).toContain('n_plus_one');
    expect(flagsOf(rows).size).toBeGreaterThan(1);
  });

  it('produces an exception to group and a request marked as a test', async () => {
    const rows = await waitFor(
      'an exception and a test-issued request',
      (all) => all.some((row) => row.status >= 500) && all.some((row) => row.test),
      90_000,
    );

    expect(rows.some((row) => row.status >= 500)).toBe(true);
    expect(rows.some((row) => row.test)).toBe(true);
  });
});
