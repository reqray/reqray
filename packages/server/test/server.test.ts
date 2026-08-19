/**
 * The collector is tested over real HTTP — the contract is the wire, not the
 * internals. The last block drives it through `@loupe/transport-http`: the
 * pair must speak the same protocol without either test faking the other side.
 */

import { type RecordedRequest, resetWarnings } from '@loupe/core';
import { createLoupeServer, type LoupeServer } from '@loupe/server';
import { httpTransport } from '@loupe/transport-http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function record(id: string, path = '/orders'): RecordedRequest {
  return {
    id,
    method: 'GET',
    path,
    query: null,
    status: 200,
    durationMs: 12,
    startedAt: Date.now(),
    spans: [],
    findings: [],
    requestHeaders: {},
    responseHeaders: {},
    requestBody: null,
    responseBody: null,
    logs: [],
    error: null,
    droppedSpans: 0,
    droppedLogs: 0,
  };
}

async function ingest(server: LoupeServer, records: RecordedRequest[], token?: string) {
  return fetch(`${server.url}/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ requests: records }),
  });
}

const servers: LoupeServer[] = [];

async function start(options: Parameters<typeof createLoupeServer>[0] = {}) {
  const server = await createLoupeServer({ port: 0, ...options });
  servers.push(server);
  return server;
}

beforeEach(() => resetWarnings());

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe('ingest and panel', () => {
  it('an accepted batch is visible in the list and in the detail', async () => {
    const server = await start();

    const response = await ingest(server, [record('a'), record('b', '/users')]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 2 });

    const list = (await (await fetch(`${server.url}/_loupe/api/requests`)).json()) as {
      requests: Array<{ id: string }>;
    };
    expect(list.requests.map((row) => row.id)).toEqual(['b', 'a']);

    const detail = (await (await fetch(`${server.url}/_loupe/api/requests/a`)).json()) as {
      path: string;
    };
    expect(detail.path).toBe('/orders');
  });

  it('malformed records are dropped, the rest are accepted', async () => {
    const server = await start();

    const response = await ingest(server, [
      record('ok'),
      { id: 42, garbage: true } as unknown as RecordedRequest,
    ]);

    expect(await response.json()).toEqual({ accepted: 1 });
    expect(server.store.list().map((r) => r.id)).toEqual(['ok']);
  });

  it('broken JSON is a 400, not a crashed collector', async () => {
    const server = await start();

    const response = await fetch(`${server.url}/ingest`, {
      method: 'POST',
      body: '{oops',
    });

    expect(response.status).toBe(400);
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
  });

  it('the live feed delivers a record accepted after connecting', async () => {
    const server = await start();

    const stream = await fetch(`${server.url}/_loupe/api/stream`);
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('no stream body');

    await ingest(server, [record('live')]);

    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('data:')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    expect(text).toContain('"id":"live"');
  });

  it('replay on the collector is forbidden', async () => {
    const server = await start();
    await ingest(server, [record('a')]);

    const response = await fetch(`${server.url}/_loupe/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'a' }),
    });

    expect(response.status).toBe(403);
  });

  it('the root leads to the panel, health responds', async () => {
    const server = await start();

    const root = await fetch(`${server.url}/`, { redirect: 'manual' });
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/_loupe/');

    expect(((await (await fetch(`${server.url}/healthz`)).json()) as { ok: boolean }).ok).toBe(
      true,
    );
  });
});

describe('token', () => {
  it('ingest without a token or with a wrong one is 401, with the right one 200', async () => {
    const server = await start({ token: 'staging-secret' });

    expect((await ingest(server, [record('a')])).status).toBe(401);
    expect((await ingest(server, [record('a')], 'wrong')).status).toBe(401);
    expect((await ingest(server, [record('a')], 'staging-secret')).status).toBe(200);
  });

  it('the panel is closed without a session and opens via /auth', async () => {
    const server = await start({ token: 'staging-secret' });

    expect((await fetch(`${server.url}/_loupe/api/requests`)).status).toBe(403);
    expect((await fetch(`${server.url}/auth?token=wrong`)).status).toBe(403);

    const auth = await fetch(`${server.url}/auth?token=staging-secret`, { redirect: 'manual' });
    expect(auth.status).toBe(302);
    const cookie = auth.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toBeTruthy();

    const list = await fetch(`${server.url}/_loupe/api/requests`, {
      headers: { cookie: cookie ?? '' },
    });
    expect(list.status).toBe(200);
  });

  it('the x-loupe-token header opens the panel without a cookie — for curl', async () => {
    const server = await start({ token: 'staging-secret' });

    const list = await fetch(`${server.url}/_loupe/api/requests`, {
      headers: { 'x-loupe-token': 'staging-secret' },
    });
    expect(list.status).toBe(200);
  });

  it('listening on a non-loopback host without a token is not allowed', async () => {
    await expect(createLoupeServer({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/token/);
  });
});

describe('together with transport-http', () => {
  it("records from the transport reach the collector's panel", async () => {
    const server = await start({ token: 'staging-secret' });
    const transport = httpTransport({
      url: server.url,
      token: 'staging-secret',
      batchSize: 2,
      flushIntervalMs: 60_000,
    });

    transport.send(record('one'));
    transport.send(record('two'));
    transport.send(record('tail'));
    await transport.flush();
    await transport.close();

    const list = (await (
      await fetch(`${server.url}/_loupe/api/requests`, {
        headers: { 'x-loupe-token': 'staging-secret' },
      })
    ).json()) as { requests: Array<{ id: string }> };

    expect(list.requests.map((row) => row.id).sort()).toEqual(['one', 'tail', 'two']);
  });
});
