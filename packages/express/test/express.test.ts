import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { current, fingerprintSql, type RecordedRequest, record } from '@loupe/core';
import { loupe } from '@loupe/express';
import { type MemoryStore, memoryTransport } from '@loupe/transport-memory';
import express, { type Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
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

/** The record shows up in the transport with a delay: finalization runs off the hot path. */
async function waitForRecord(store: MemoryStore, timeoutMs = 1_000): Promise<RecordedRequest> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [first] = store.list();
    if (first) return first;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the request never reached the transport');
}

/**
 * A span of exactly the shape a driver instrumentation writes.
 *
 * `startTime` is passed explicitly: without it, spans recorded back to back in
 * a tight synchronous loop would share one start time and look like
 * `Promise.all` to the detector.
 */
function fakeQuery(sql: string, duration = 1, startTime = performance.now()): void {
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

function harness(options: Parameters<typeof loupe>[0] = {}): Harness {
  const store = memoryTransport();
  const app = express();
  const inspector = loupe({ mode: 'development', transport: store, ...options });

  app.use(express.json());
  app.use(inspector.middleware);

  app.get('/orders', async (_req, res) => {
    fakeQuery('SELECT id FROM orders WHERE user_id = 8812', 8.6);
    res.json({ orders: [1, 2] });
  });

  app.get('/n-plus-one', async (_req, res) => {
    // Waterfall: each query starts only after the previous one has finished.
    let cursor = performance.now();
    fakeQuery('SELECT id FROM orders WHERE user_id = 1', 8, cursor);
    cursor += 8;
    for (let i = 0; i < 20; i++) {
      fakeQuery(`SELECT * FROM line_items WHERE order_id = ${i}`, 3, cursor);
      cursor += 3;
    }
    res.json({ ok: true });
  });

  app.post('/login', (_req, res) => {
    res.json({ token: 'issued-token', user: 'ada' });
  });

  app.get('/boom', () => {
    throw new TypeError('handler crashed');
  });

  app.use(inspector.errorHandler);
  return { app, store };
}

describe('Express adapter', () => {
  it('a request reaches the transport along with its spans', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/orders?limit=10`);
    const recorded = await waitForRecord(store);

    expect(recorded).toMatchObject({
      method: 'GET',
      path: '/orders',
      query: 'limit=10',
      status: 200,
    });
    expect(recorded.spans.filter((span) => span.kind === 'db')).toHaveLength(1);
    expect(recorded.durationMs).toBeGreaterThan(0);
  });

  it('nests driver spans under the handler span', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/orders`);
    const recorded = await waitForRecord(store);

    const handler = recorded.spans.find((span) => span.kind === 'handler');
    const query = recorded.spans.find((span) => span.kind === 'db');

    expect(handler).toBeDefined();
    expect(query?.parentId).toBe(handler?.id);
  });

  it('does not alter the application response', async () => {
    const { app } = harness();
    const withLoupe = await serve(app);

    const plain = express();
    plain.get('/orders', (_req, res) => {
      res.json({ orders: [1, 2] });
    });
    const withoutLoupe = await serve(plain);

    const [a, b] = await Promise.all([
      fetch(`${withLoupe}/orders`),
      fetch(`${withoutLoupe}/orders`),
    ]);

    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });

  it('request context is visible inside an async handler', async () => {
    const store = memoryTransport();
    const app = express();
    const inspector = loupe({ mode: 'development', transport: store });
    app.use(inspector.middleware);

    let seenId: string | undefined;
    app.get('/async', async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seenId = current()?.id;
      res.json({ ok: true });
    });

    const base = await serve(app);
    await fetch(`${base}/async`);
    const recorded = await waitForRecord(store);

    expect(seenId).toBe(recorded.id);
  });

  it('records a handler exception without replacing the response', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    const response = await fetch(`${base}/boom`);
    const recorded = await waitForRecord(store);

    expect(response.status).toBe(500);
    expect(recorded.status).toBe(500);
    expect(recorded.error).toMatchObject({ name: 'TypeError', message: 'handler crashed' });
  });

  it('redacts headers and bodies before recording', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/login`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-jwt', 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'ada', password: 'hunter2' }),
    });
    const recorded = await waitForRecord(store);

    expect(recorded.requestHeaders['authorization']).toBe('[redacted]');
    expect(JSON.parse(recorded.requestBody?.text ?? '')).toEqual({
      login: 'ada',
      password: '[redacted]',
    });
    expect(JSON.parse(recorded.responseBody?.text ?? '')).toEqual({
      token: '[redacted]',
      user: 'ada',
    });
  });

  it('carries the N+1 finding through to the record', async () => {
    const { app, store } = harness();
    const base = await serve(app);

    await fetch(`${base}/n-plus-one`);
    const recorded = await waitForRecord(store);

    expect(recorded.findings).toHaveLength(1);
    expect(recorded.findings[0]).toMatchObject({
      detector: 'n_plus_one',
      callsite: { relative: 'src/orders.ts', line: 118 },
    });
    expect(recorded.findings[0]?.costMs).toBeGreaterThan(0);
  });

  it('disabled Loupe creates no scope and records nothing', async () => {
    const store = memoryTransport();
    const app = express();
    app.use(loupe({ enabled: false, transport: store }).middleware);

    let scopeSeen: unknown = 'never called';
    app.get('/orders', (_req, res) => {
      scopeSeen = current();
      res.json({ ok: true });
    });

    const base = await serve(app);
    const response = await fetch(`${base}/orders`);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(response.status).toBe(200);
    expect(scopeSeen).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  describe('test provenance', () => {
    it('records the test a request came from', async () => {
      const { app, store } = harness();
      const base = await serve(app);

      await fetch(`${base}/orders`, { headers: { 'x-loupe-test': 'orders.spec.ts:42' } });

      expect((await waitForRecord(store)).test).toBe('orders.spec.ts:42');
    });

    it('decodes a percent-encoded name, since header values are latin1', async () => {
      const { app, store } = harness();
      const base = await serve(app);
      const name = 'orders.spec.ts:42 \u203a creates an order';

      await fetch(`${base}/orders`, {
        headers: { 'x-loupe-test': encodeURIComponent(name) },
      });

      expect((await waitForRecord(store)).test).toBe(name);
    });

    it('keeps a name that only looks encoded', async () => {
      const { app, store } = harness();
      const base = await serve(app);

      await fetch(`${base}/orders`, { headers: { 'x-loupe-test': '50% of the time' } });

      expect((await waitForRecord(store)).test).toBe('50% of the time');
    });

    it('ordinary traffic carries no test', async () => {
      const { app, store } = harness();
      const base = await serve(app);

      await fetch(`${base}/orders`);

      expect((await waitForRecord(store)).test).toBeNull();
    });
  });
});
