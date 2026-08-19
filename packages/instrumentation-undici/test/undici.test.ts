import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type HttpSpan, RequestScope, resolveOptions, runInScope } from '@loupe/core';
import { instrumentUndici } from '@loupe/instrumentation-undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const options = resolveOptions({ mode: 'development' });
const instrumentation = instrumentUndici();

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/boom') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"crashed"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

afterEach(() => {
  instrumentation.unapply?.({});
});

function makeScope(): RequestScope {
  return new RequestScope({ id: 'r1', method: 'GET', path: '/orders', options });
}

const httpSpans = (scope: RequestScope): HttpSpan[] =>
  scope.spans.filter((span): span is HttpSpan => span.kind === 'http');

/** The span is written by the channel handler — it lands one tick after the response. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('undici instrumentation', () => {
  it('records a span for the built-in fetch', async () => {
    instrumentation.apply({});
    const scope = makeScope();

    const response = await runInScope(scope, () => fetch(`${base}/api/charges`));
    expect(await response.json()).toEqual({ ok: true });
    await settle();

    const [span] = httpSpans(scope);
    expect(span).toMatchObject({
      kind: 'http',
      method: 'GET',
      url: `${base}/api/charges`,
      statusCode: 200,
      error: null,
    });
    expect(span?.duration).toBeGreaterThan(0);
  });

  it('callsite points to the fetch call line', async () => {
    // The channel is published from the dispatcher where the user frame is
    // gone, so the callsite comes from the `fetch` wrapper — it captures the
    // stack while the frame still exists and hands it down, the way the pg
    // pool wrapper does.
    instrumentation.apply({});
    const scope = makeScope();

    await runInScope(scope, async () => {
      const response = await fetch(`${base}/api/charges`);
      await response.text();
    });
    await settle();

    const callsite = httpSpans(scope)[0]?.callsite;
    expect(callsite?.file).toContain('undici.test.ts');
    expect(callsite?.line).toBeGreaterThan(0);
  });

  it('preserves the status of an error response', async () => {
    instrumentation.apply({});
    const scope = makeScope();

    await runInScope(scope, async () => {
      const response = await fetch(`${base}/boom`);
      await response.text();
    });
    await settle();

    expect(httpSpans(scope)[0]?.statusCode).toBe(500);
  });

  it('records a span with an error when the connection fails', async () => {
    // A port nobody listens on: a server is opened and immediately closed.
    // A hardcoded low port would not do — port 1 and friends are on the fetch
    // spec's blocked-port list and never reach the network.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/unreachable`;
    await new Promise<void>((resolve) => {
      closed.close(() => resolve());
    });

    instrumentation.apply({});
    const scope = makeScope();

    await runInScope(scope, async () => {
      await expect(fetch(deadUrl)).rejects.toThrow();
    });
    await settle();

    const [span] = httpSpans(scope);
    expect(span).toBeDefined();
    expect(span?.error).not.toBeNull();
    expect(span?.statusCode).toBeNull();
  });

  it('a call outside a request records nothing and does not crash', async () => {
    instrumentation.apply({});

    const response = await fetch(`${base}/api/charges`);
    expect(response.status).toBe(200);
    await response.text();
    await settle();
  });

  it('a repeated apply does not record twice', async () => {
    instrumentation.apply({});
    instrumentation.apply({});
    instrumentUndici().apply({});

    const scope = makeScope();
    await runInScope(scope, async () => {
      const response = await fetch(`${base}/api/charges`);
      await response.text();
    });
    await settle();

    expect(httpSpans(scope)).toHaveLength(1);
  });

  it('after unapply no spans are recorded', async () => {
    instrumentation.apply({});
    instrumentation.unapply?.({});

    const scope = makeScope();
    await runInScope(scope, async () => {
      const response = await fetch(`${base}/api/charges`);
      await response.text();
    });
    await settle();

    expect(httpSpans(scope)).toHaveLength(0);
  });
});
