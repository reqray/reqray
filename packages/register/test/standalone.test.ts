/**
 * Standalone mode: the panel with zero lines of code.
 *
 * The application here is bare `node:http` with no mention of Reqray — that is
 * the whole point being tested.
 */

import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { current, fingerprintSql, markAdapterActive, record } from '@reqray/core';
import { resetAdapterActive, resetWarnings } from '@reqray/core/testing';
import { enableStandalone, resetStandalone, standalonePanelUrl } from '@reqray/register';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeQuery(sql: string, duration: number, startTime: number): void {
  record(current(), {
    kind: 'db',
    sql,
    fingerprint: fingerprintSql(sql),
    duration,
    startTime,
    source: 'pg',
    callsite: { file: '/srv/app/src/orders.ts', relative: 'src/orders.ts', line: 7, column: 3 },
  });
}

const servers: Server[] = [];

/** A bare application: routes are an if-chain, Reqray is nowhere in it. */
async function startBareApp(): Promise<string> {
  const app = createServer((request, response) => {
    if (request.url?.startsWith('/one')) {
      fakeQuery('SELECT id FROM orders WHERE user_id = 1', 8, performance.now());
    }
    if (request.url?.startsWith('/n-plus-one')) {
      let cursor = performance.now();
      for (let i = 0; i < 20; i++) {
        fakeQuery(`SELECT * FROM line_items WHERE order_id = ${i}`, 3, cursor);
        cursor += 3;
      }
    }
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  servers.push(app);
  return `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
}

async function panelUrl(timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = standalonePanelUrl();
    if (url) return url.replace(/\/_reqray\/$/, '');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the standalone panel never came up');
}

async function waitForRows(base: string, count: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Array<Record<string, unknown>>;
    };
    if (payload.requests.length >= count) return payload.requests;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the panel never showed ${count} records`);
}

beforeEach(() => {
  resetStandalone();
  resetAdapterActive();
  resetWarnings();
});

afterEach(async () => {
  resetStandalone();
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
});

describe('standalone', () => {
  it('records a bare node:http request and brings up the panel', async () => {
    enableStandalone({ panelPort: 0 });
    const app = await startBareApp();

    await fetch(`${app}/one?limit=5`);

    const panel = await panelUrl();
    const rows = await waitForRows(panel, 1);

    expect(rows[0]).toMatchObject({
      method: 'GET',
      path: '/one',
      query: 'limit=5',
      status: 200,
      sqlCount: 1,
    });

    const detail = (await (
      await fetch(`${panel}/_reqray/api/requests/${rows[0]?.['id']}`)
    ).json()) as {
      spans: Array<{ kind: string }>;
      requestBody: unknown;
      responseBody: unknown;
    };
    expect(detail.spans.some((span) => span.kind === 'handler')).toBe(true);
    expect(detail.spans.some((span) => span.kind === 'db')).toBe(true);
    // Bodies are deliberately not captured in standalone.
    expect(detail.requestBody).toBeNull();
    expect(detail.responseBody).toBeNull();
  });

  it('turns N+1 into a finding with a code line', async () => {
    enableStandalone({ panelPort: 0 });
    const app = await startBareApp();

    await fetch(`${app}/n-plus-one`);

    const panel = await panelUrl();
    const rows = await waitForRows(panel, 1);
    expect(rows[0]?.['nPlusOne']).toBe(true);

    const detail = (await (
      await fetch(`${panel}/_reqray/api/requests/${rows[0]?.['id']}`)
    ).json()) as {
      findings: Array<{ detector: string; callsite: { relative: string } | null }>;
    };
    expect(detail.findings[0]?.detector).toBe('n_plus_one');
    expect(detail.findings[0]?.callsite?.relative).toBe('src/orders.ts');
  });

  it('panel traffic does not enter its own list', async () => {
    enableStandalone({ panelPort: 0 });
    const app = await startBareApp();

    await fetch(`${app}/one`);
    const panel = await panelUrl();
    await waitForRows(panel, 1);

    // A few panel reads must not become new records.
    await fetch(`${panel}/_reqray/api/requests`);
    await fetch(`${panel}/_reqray/api/requests`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = await waitForRows(panel, 1);
    expect(rows).toHaveLength(1);
  });

  it('does nothing when an adapter is active', async () => {
    markAdapterActive();
    enableStandalone({ panelPort: 0 });
    const app = await startBareApp();

    await fetch(`${app}/one`);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(standalonePanelUrl()).toBeNull();
  });

  it('REQRAY_STANDALONE=off disables the mode entirely', async () => {
    vi.stubEnv('REQRAY_STANDALONE', 'off');
    enableStandalone({ panelPort: 0 });
    const app = await startBareApp();

    await fetch(`${app}/one`);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(standalonePanelUrl()).toBeNull();
  });
});
