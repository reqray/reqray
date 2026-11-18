/**
 * Contract tests for the panel API.
 *
 * The adapter mounts the panel inside the application, so it is checked the
 * way a browser will see it: with real HTTP requests against a live app.
 */

import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { current, fingerprintSql, record } from '@reqray/core';
import { reqray } from '@reqray/express';
import { type MemoryStore, memoryTransport } from '@reqray/store-memory';
import express, { type Express } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  vi.unstubAllEnvs();
});

async function serve(app: Express): Promise<string> {
  const server = app.listen(0);
  await once(server, 'listening');
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        // Without this, close() waits out every keep-alive socket fetch left
        // open, which adds seconds per test file.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function waitFor(store: MemoryStore, count: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (store.list().length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the transport never received ${count} records`);
}

function fakeQuery(sql: string, duration: number, startTime: number): void {
  record(current(), {
    kind: 'db',
    sql,
    fingerprint: fingerprintSql(sql),
    duration,
    startTime,
    source: 'pg',
    callsite: { file: '/srv/app/src/orders.ts', relative: 'src/orders.ts', line: 118, column: 3 },
  });
}

interface Harness {
  readonly app: Express;
  readonly store: MemoryStore;
}

function harness(options: Parameters<typeof reqray>[0] = {}): Harness {
  const store = memoryTransport();
  const app = express();
  const inspector = reqray({ mode: 'development', transport: store, ...options });

  app.use(express.json());
  app.use(inspector.middleware);

  app.get('/orders', (_req, res) => {
    fakeQuery('SELECT id FROM orders WHERE user_id = 1', 8, performance.now());
    res.json({ orders: [1, 2] });
  });

  app.get('/n-plus-one', (_req, res) => {
    let cursor = performance.now();
    for (let i = 0; i < 20; i++) {
      fakeQuery(`SELECT * FROM line_items WHERE order_id = ${i}`, 3, cursor);
      cursor += 3;
    }
    res.json({ ok: true });
  });

  app.post('/echo', (req, res) => {
    res.json({ received: req.body });
  });

  app.get('/boom', () => {
    throw new TypeError('handler crashed');
  });

  app.use(inspector.errorHandler);
  return { app, store };
}

describe('panel API', () => {
  it('serves the row list and the summary', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/orders?limit=10`);
    await waitFor(store, 1);

    const response = await fetch(`${base}/_reqray/api/requests`);
    const payload = (await response.json()) as {
      requests: Array<Record<string, unknown>>;
      summary: Record<string, number>;
    };

    expect(response.status).toBe(200);
    expect(payload.requests).toHaveLength(1);
    expect(payload.requests[0]).toMatchObject({
      method: 'GET',
      path: '/orders',
      query: 'limit=10',
      status: 200,
      sqlCount: 1,
      nPlusOne: false,
    });
    expect(payload.summary).toMatchObject({ shown: 1, total: 1 });
  });

  it("the panel's own requests do not enter the list", async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/orders`);
    await waitFor(store, 1);
    await fetch(`${base}/_reqray/api/requests`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(store.list()).toHaveLength(1);
  });

  it('filters by substring, method, and status', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/orders`);
    await fetch(`${base}/boom`);
    await waitFor(store, 2);

    const byPath = await fetch(`${base}/_reqray/api/requests?q=boom`).then((r) => r.json());
    const byStatus = await fetch(`${base}/_reqray/api/requests?status=5`).then((r) => r.json());
    const byMethod = await fetch(`${base}/_reqray/api/requests?method=POST`).then((r) => r.json());

    expect((byPath as { requests: unknown[] }).requests).toHaveLength(1);
    expect((byStatus as { requests: unknown[] }).requests).toHaveLength(1);
    expect((byMethod as { requests: unknown[] }).requests).toHaveLength(0);
  });

  it('serves request detail with spans and findings', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/n-plus-one`);
    await waitFor(store, 1);

    const id = store.list()[0]?.id;
    const detail = (await fetch(`${base}/_reqray/api/requests/${id}`).then((r) => r.json())) as {
      spans: unknown[];
      findings: Array<{ detector: string }>;
    };

    expect(detail.spans.length).toBeGreaterThan(20);
    expect(detail.findings[0]?.detector).toBe('n_plus_one');
  });

  it('EXPLAIN without a recorded executor explains why', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/orders`);
    await waitFor(store, 1);
    const record = store.list()[0];
    const spanId = record?.spans.find((span) => span.kind === 'db')?.id;

    const response = await fetch(`${base}/_reqray/api/explain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: record?.id, spanId }),
    });

    // The fake span has no clientId — the honest message, not a 500.
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('executor');
  });

  it('EXPLAIN is disabled by an option and responds 403', async () => {
    const { app, store } = harness({ explain: false });
    const base = await serve(app);

    await fetch(`${base}/orders`);
    await waitFor(store, 1);

    const response = await fetch(`${base}/_reqray/api/explain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: store.list()[0]?.id, spanId: 1 }),
    });

    expect(response.status).toBe(403);
  });

  it('responds to an unknown id with 404, not emptiness', async () => {
    const { app } = harness();
    const base = await serve(app);

    const response = await fetch(`${base}/_reqray/api/requests/no-such-id`);

    expect(response.status).toBe(404);
  });

  it('pins a request, and says so in the row', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/orders`);
    await waitFor(store, 1);
    const id = store.list()[0]?.id;

    const pin = await fetch(`${base}/_reqray/api/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, pinned: true }),
    });

    expect(pin.status).toBe(200);
    expect(await pin.json()).toMatchObject({ id, pinned: true });

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Array<{ id: string; pinned: boolean }>;
    };
    expect(list.requests[0]).toMatchObject({ id, pinned: true });
  });

  it('refuses to pin a request that is gone, with a reason', async () => {
    const { app } = harness();
    const base = await serve(app);

    const response = await fetch(`${base}/_reqray/api/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'no-such-id', pinned: true }),
    });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('could not pin');
  });

  it('clears the buffer', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/orders`);
    await waitFor(store, 1);

    await fetch(`${base}/_reqray/api/requests`, { method: 'DELETE' });

    expect(store.list()).toEqual([]);
  });

  it('groups exceptions by normalized stack', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/boom`);
    await fetch(`${base}/boom`);
    await waitFor(store, 2);

    const payload = (await fetch(`${base}/_reqray/api/exceptions`).then((r) => r.json())) as {
      groups: Array<{ type: string; count: number; frames: unknown[]; buckets: number[] }>;
    };

    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0]).toMatchObject({ type: 'TypeError', count: 2 });
    expect(payload.groups[0]?.buckets).toHaveLength(12);
  });

  it('the live feed delivers new requests', async () => {
    const { app } = harness();
    const base = await serve(app);

    const controller = new AbortController();
    const stream = await fetch(`${base}/_reqray/api/stream`, { signal: controller.signal });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');

    const reader = stream.body?.getReader();
    if (!reader) throw new Error('the stream never opened');

    await fetch(`${base}/orders`);

    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('data:')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    controller.abort();

    expect(received).toContain('"path":"/orders"');
  });

  it('responds 404 to an unknown panel endpoint', async () => {
    const { app } = harness();
    const base = await serve(app);

    expect((await fetch(`${base}/_reqray/api/no-such-thing`)).status).toBe(404);
  });

  it('mounts at a custom path', async () => {
    const { app } = harness({ panel: { path: '/__debug' } });
    const base = await serve(app);

    expect((await fetch(`${base}/__debug/api/requests`)).status).toBe(200);
    expect((await fetch(`${base}/_reqray/api/requests`)).status).toBe(404);
  });

  it('does not let anyone past the gate', async () => {
    // HTTP header values are limited to Latin-1, hence the ASCII token.
    const { app } = harness({
      panel: { gate: (ctx) => ctx.headers['x-reqray-token'] === 'let-me-in' },
    });
    const base = await serve(app);

    expect((await fetch(`${base}/_reqray/api/requests`)).status).toBe(403);
    expect(
      (await fetch(`${base}/_reqray/api/requests`, { headers: { 'x-reqray-token': 'let-me-in' } }))
        .status,
    ).toBe(200);
  });
});

describe('request replay', () => {
  it('re-runs the request and compares the metrics', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/n-plus-one`);
    await waitFor(store, 1);
    const original = store.list()[0];

    const comparison = (await fetch(`${base}/_reqray/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: original?.id, method: 'GET', path: '/n-plus-one', headers: {} }),
    }).then((r) => r.json())) as {
      original: { sqlCount: number; nPlusOne: boolean };
      replay: { status: number; sqlCount: number };
      partial: boolean;
    };

    expect(comparison.partial).toBe(false);
    expect(comparison.original.sqlCount).toBe(20);
    expect(comparison.original.nPlusOne).toBe(true);
    expect(comparison.replay.status).toBe(200);
    expect(comparison.replay.sqlCount).toBe(20);
  });

  it('the replay does not enter the request list', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/orders`);
    await waitFor(store, 1);
    const original = store.list()[0];

    await fetch(`${base}/_reqray/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: original?.id, method: 'GET', path: '/orders', headers: {} }),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(store.list()).toHaveLength(1);
  });

  it('replays a modified request with a body', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 1 }),
    });
    await waitFor(store, 1);

    const comparison = (await fetch(`${base}/_reqray/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: store.list()[0]?.id,
        method: 'POST',
        path: '/echo',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 2 }),
      }),
    }).then((r) => r.json())) as { replay: { status: number } };

    expect(comparison.replay.status).toBe(200);
  });

  it('is forbidden outside local development and explains why', async () => {
    vi.stubEnv('NODE_ENV', 'staging');
    const { app, store } = harness({ panel: { gate: 'open' } });
    const base = await serve(app);

    await fetch(`${base}/orders`);
    await waitFor(store, 1);

    const response = await fetch(`${base}/_reqray/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: store.list()[0]?.id }),
    });
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(payload.error).toContain('replay: true');
  });
});

describe('panel static serving', () => {
  it('serves the built dashboard at the panel root', async () => {
    const { app } = harness();
    const base = await serve(app);

    const response = await fetch(`${base}/_reqray/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<div id="root">');
  });

  it('finds the dashboard from the CommonJS build, as a require()-ing app loads it', () => {
    // Its own process: the test runner loads the sources as ESM, and the bug
    // this guards against only exists in the built `.cjs`.
    const script = `
      const express = require('express');
      const { reqray } = require('./dist/index.cjs');
      const app = express();
      app.use(reqray({ enabled: true }).middleware);
      const server = app.listen(0, '127.0.0.1', async () => {
        const page = await fetch('http://127.0.0.1:' + server.address().port + '/_reqray/');
        console.log(page.status);
        server.close();
        process.exit(0);
      });`;
    const stdout = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      timeout: 30_000,
    });

    expect(stdout.trim().split('\n').at(-1)).toBe('200');
  });

  it('serves assets with a hash in the name', async () => {
    const { app } = harness();
    const base = await serve(app);

    const html = await fetch(`${base}/_reqray/`).then((r) => r.text());
    const asset = /assets\/(index-[\w-]+\.js)/.exec(html)?.[1];
    expect(asset).toBeDefined();

    const response = await fetch(`${base}/_reqray/assets/${asset}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
  });

  it('an unknown panel path serves index.html — screens are state, not routes', async () => {
    const { app } = harness();
    const base = await serve(app);

    const response = await fetch(`${base}/_reqray/exceptions`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });

  it('escaping the assets directory does not work', async () => {
    const { app } = harness();
    const base = await serve(app);
    const port = Number(new URL(base).port);

    // `fetch` normalizes `..` before sending, so the traversal is checked
    // with a raw request — exactly the way an attacker would send it.
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          'GET /_reqray/../../package.json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
        );
      });
      let received = '';
      socket.on('data', (chunk) => {
        received += chunk.toString('utf8');
      });
      socket.on('end', () => resolve(received));
      socket.on('error', reject);
    });

    expect(raw).not.toContain('"@reqray/example');
    expect(raw).not.toContain('"devDependencies"');
  });

  it('does not intercept application routes', async () => {
    const { app } = harness();
    const base = await serve(app);

    const response = await fetch(`${base}/orders`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ orders: [1, 2] });
  });
});
