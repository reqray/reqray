import { current, fingerprintSql, type RecordedRequest, record } from '@loupe/core';
import { loupe } from '@loupe/fastify';
import { type MemoryStore, memoryTransport } from '@loupe/transport-memory';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function serve(app: FastifyInstance): Promise<string> {
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${app.addresses()[0]?.port}`;
}

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
 * A span of exactly the shape a driver instrumentation writes. `startTime` is
 * passed explicitly so that the run looks like a waterfall and not like
 * `Promise.all`: spans recorded in a tight synchronous loop would otherwise
 * share one start time.
 */
function fakeQuery(sql: string, duration = 1, startTime = performance.now()): void {
  record(current(), {
    kind: 'db',
    sql,
    fingerprint: fingerprintSql(sql),
    duration,
    startTime,
    source: 'prisma',
    callsite: { file: '/srv/app/src/orders.ts', relative: 'src/orders.ts', line: 118, column: 3 },
  });
}

async function harness(options: Record<string, unknown> = {}): Promise<{
  app: FastifyInstance;
  store: MemoryStore;
}> {
  const store = memoryTransport();
  const app = Fastify();
  await app.register(loupe, { mode: 'development', transport: store, ...options });

  app.get('/orders', async () => {
    fakeQuery('SELECT id FROM orders WHERE user_id = 8812', 8.6);
    return { orders: [1, 2] };
  });

  app.get('/n-plus-one', async () => {
    let cursor = performance.now();
    fakeQuery('SELECT id FROM orders WHERE user_id = 1', 8, cursor);
    cursor += 8;
    for (let i = 0; i < 20; i++) {
      fakeQuery(`SELECT * FROM line_items WHERE order_id = ${i}`, 3, cursor);
      cursor += 3;
    }
    return { ok: true };
  });

  app.post('/login', async () => ({ token: 'issued-token', user: 'ada' }));

  app.get('/boom', async () => {
    throw new TypeError('handler crashed');
  });

  return { app, store };
}

describe('Fastify adapter', () => {
  it('a request reaches the transport along with its spans', async () => {
    const { app, store } = await harness();
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
  });

  it('context travels from the onRequest hook to the handler', async () => {
    const store = memoryTransport();
    const app = Fastify();
    await app.register(loupe, { mode: 'development', transport: store });

    let seenId: string | undefined;
    app.get('/async', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seenId = current()?.id;
      return { ok: true };
    });

    const base = await serve(app);
    await fetch(`${base}/async`);
    const recorded = await waitForRecord(store);

    expect(seenId).toBe(recorded.id);
  });

  it('does not mix up concurrent requests', async () => {
    const { app, store } = await harness();
    const base = await serve(app);

    await Promise.all([
      fetch(`${base}/orders?n=1`),
      fetch(`${base}/orders?n=2`),
      fetch(`${base}/orders?n=3`),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const recorded = store.list();
    expect(recorded).toHaveLength(3);
    expect(new Set(recorded.map((request) => request.id)).size).toBe(3);
    for (const request of recorded) {
      expect(request.spans.filter((span) => span.kind === 'db')).toHaveLength(1);
    }
  });

  it('does not alter the application response', async () => {
    const { app } = await harness();
    const withLoupe = await serve(app);

    const plain = Fastify();
    plain.get('/orders', async () => ({ orders: [1, 2] }));
    const withoutLoupe = await serve(plain);

    const [a, b] = await Promise.all([
      fetch(`${withLoupe}/orders`),
      fetch(`${withoutLoupe}/orders`),
    ]);

    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });

  it('records a handler exception without replacing the response', async () => {
    const { app, store } = await harness();
    const base = await serve(app);

    const response = await fetch(`${base}/boom`);
    const recorded = await waitForRecord(store);

    expect(response.status).toBe(500);
    expect(recorded.status).toBe(500);
    expect(recorded.error).toMatchObject({ name: 'TypeError', message: 'handler crashed' });
  });

  it('redacts headers and bodies before recording', async () => {
    const { app, store } = await harness();
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
    // Fastify hands over the response body already serialized — parsing and
    // redaction happen during finalization, off the hot path.
    expect(JSON.parse(recorded.responseBody?.text ?? '')).toEqual({
      token: '[redacted]',
      user: 'ada',
    });
  });

  it('carries the N+1 finding through to the record', async () => {
    const { app, store } = await harness();
    const base = await serve(app);

    await fetch(`${base}/n-plus-one`);
    const recorded = await waitForRecord(store);

    expect(recorded.findings).toHaveLength(1);
    expect(recorded.findings[0]?.hint).toContain('include');
  });

  it('disabled Loupe creates no scope and records nothing', async () => {
    const store = memoryTransport();
    const app = Fastify();
    await app.register(loupe, { enabled: false, transport: store });

    let scopeSeen: unknown = 'never called';
    app.get('/orders', async () => {
      scopeSeen = current();
      return { ok: true };
    });

    const base = await serve(app);
    const response = await fetch(`${base}/orders`);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(response.status).toBe(200);
    expect(scopeSeen).toBeUndefined();
    expect(store.list()).toEqual([]);
  });
});

describe('panel in Fastify', () => {
  it('responds itself without entering its own list', async () => {
    const { app, store } = await harness();
    const base = await serve(app);

    await fetch(`${base}/orders`);
    await waitForRecord(store);

    const response = await fetch(`${base}/_loupe/api/requests`);
    const payload = (await response.json()) as { requests: Array<{ path: string }> };
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(response.status).toBe(200);
    expect(payload.requests.map((row) => row.path)).toEqual(['/orders']);
    expect(store.list()).toHaveLength(1);
  });

  it('application routes keep working next to the panel', async () => {
    const { app } = await harness();
    const base = await serve(app);

    const response = await fetch(`${base}/orders`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ orders: [1, 2] });
  });

  it('replays a request without polluting the list', async () => {
    const { app, store } = await harness();
    const base = await serve(app);

    await fetch(`${base}/orders`);
    await waitForRecord(store);

    const comparison = (await fetch(`${base}/_loupe/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: store.list()[0]?.id,
        method: 'GET',
        path: '/orders',
        headers: {},
      }),
    }).then((r) => r.json())) as { replay: { status: number; sqlCount: number }; partial: boolean };

    expect(comparison.partial).toBe(false);
    expect(comparison.replay).toMatchObject({ status: 200, sqlCount: 1 });
    expect(store.list()).toHaveLength(1);
  });
});
