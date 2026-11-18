/**
 * The collector is tested over real HTTP — the contract is the wire, not the
 * internals. The last block drives it through `@reqray/transport-http`: the
 * pair must speak the same protocol without either test faking the other side.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RecordedRequest, timingOf, weightOf } from '@reqray/core';
import { resetWarnings } from '@reqray/core/testing';
import { createReqrayServer, type ReqrayServer } from '@reqray/server';
import { httpTransport } from '@reqray/transport-http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function record(id: string, path = '/orders'): RecordedRequest {
  const base = {
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
    test: null,
  };
  return {
    ...base,
    timing: timingOf(base.spans, base.durationMs),
    host: null,
    weight: weightOf(base),
    cost: null,
  };
}

async function ingest(server: ReqrayServer, records: RecordedRequest[], token?: string) {
  return fetch(`${server.url}/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ requests: records }),
  });
}

const servers: ReqrayServer[] = [];

async function start(options: Parameters<typeof createReqrayServer>[0] = {}) {
  const server = await createReqrayServer({ port: 0, ...options });
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

    const list = (await (await fetch(`${server.url}/_reqray/api/requests`)).json()) as {
      requests: Array<{ id: string }>;
    };
    expect(list.requests.map((row) => row.id)).toEqual(['b', 'a']);

    const detail = (await (await fetch(`${server.url}/_reqray/api/requests/a`)).json()) as {
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
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });

    expect(response.status).toBe(400);
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
  });

  it('with no token, takes nothing a web page could have sent', async () => {
    // A collector without a token listens on loopback, and any page open in
    // a browser on that machine can post there. What a page cannot do without
    // a preflight is say `application/json`, or arrive under a local name
    // once its own domain has been re-pointed at 127.0.0.1.
    const server = await start();
    const body = JSON.stringify({ requests: [record('forged')] });

    const asForm = await fetch(`${server.url}/ingest`, { method: 'POST', body });
    expect(asForm.status).toBe(415);

    const rebound = await new Promise<number>((resolve, reject) => {
      httpRequest(
        `${server.url}/_reqray/api/requests`,
        { headers: { host: 'attacker.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      )
        .on('error', reject)
        .end();
    });
    expect(rebound).toBe(403);

    expect(server.store.list()).toHaveLength(0);
  });

  it('tells an agent to come back later instead of taking more than it can hold', async () => {
    const server = await start();
    const headers = { 'content-type': 'application/json' };

    // Eight batches on their way in, none of them finished.
    const pending = Array.from({ length: 8 }, () => {
      const upload = httpRequest(`${server.url}/ingest`, { method: 'POST', headers });
      upload.on('error', () => undefined);
      upload.write('{"requests":[');
      return upload;
    });
    try {
      let busy: Response | undefined;
      for (let attempt = 0; attempt < 50 && busy?.status !== 429; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        busy = await fetch(`${server.url}/ingest`, { method: 'POST', headers, body: '{}' });
      }

      expect(busy?.status).toBe(429);
      expect(busy?.headers.get('retry-after')).toBe('1');
    } finally {
      for (const upload of pending) upload.destroy();
    }

    // And room comes back once they are gone.
    let after: Awaited<ReturnType<typeof ingest>> | undefined;
    for (let attempt = 0; attempt < 50 && after?.status !== 200; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      after = await ingest(server, [record('later')]);
    }
    expect(after?.status).toBe(200);
  });

  it('the live feed delivers a record accepted after connecting', async () => {
    const server = await start();

    const stream = await fetch(`${server.url}/_reqray/api/stream`);
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

    const response = await fetch(`${server.url}/_reqray/api/replay`, {
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
    expect(root.headers.get('location')).toBe('/_reqray/');

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

    expect((await fetch(`${server.url}/_reqray/api/requests`)).status).toBe(403);
    expect((await fetch(`${server.url}/auth?token=wrong`)).status).toBe(403);

    const auth = await fetch(`${server.url}/auth?token=staging-secret`, { redirect: 'manual' });
    expect(auth.status).toBe(302);
    const cookie = auth.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toBeTruthy();

    const list = await fetch(`${server.url}/_reqray/api/requests`, {
      headers: { cookie: cookie ?? '' },
    });
    expect(list.status).toBe(200);
  });

  it('the x-reqray-token header opens the panel without a cookie — for curl', async () => {
    const server = await start({ token: 'staging-secret' });

    const list = await fetch(`${server.url}/_reqray/api/requests`, {
      headers: { 'x-reqray-token': 'staging-secret' },
    });
    expect(list.status).toBe(200);
  });

  it('listening on a non-loopback host without a token is not allowed', async () => {
    await expect(createReqrayServer({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/token/);
  });
});

describe('a history on disk', () => {
  const dirs: string[] = [];
  const dbFile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'reqray-collector-'));
    dirs.push(dir);
    return join(dir, 'reqray.db');
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps what it was sent after the collector is restarted', async () => {
    // The reason the option exists: a collector that forgets on restart is a
    // buffer, not a history.
    const db = dbFile();
    const first = await start({ db });
    await ingest(first, [record('r1', '/api/orders')]);
    await first.close();
    servers.length = 0;

    const second = await start({ db });
    const detail = await (await fetch(`${second.url}/_reqray/api/requests/r1`)).json();

    expect(detail).toMatchObject({ id: 'r1', path: '/api/orders' });
  });

  it('serves the list a page at a time, oldest reachable by cursor', async () => {
    const server = await start({ db: dbFile() });
    await ingest(
      server,
      Array.from({ length: 12 }, (_, index) =>
        record(`r${String(index).padStart(2, '0')}`, `/api/orders/${index}`),
      ),
    );

    const first = (await (await fetch(`${server.url}/_reqray/api/requests?limit=5`)).json()) as {
      requests: Array<{ id: string }>;
      nextCursor: string;
      summary: { total: number };
    };
    expect(first.requests).toHaveLength(5);
    expect(first.summary.total).toBe(12);

    const second = (await (
      await fetch(
        `${server.url}/_reqray/api/requests?limit=5&cursor=${encodeURIComponent(first.nextCursor)}`,
      )
    ).json()) as { requests: Array<{ id: string }> };

    const ids = [...first.requests, ...second.requests].map((row) => row.id);
    expect(new Set(ids).size).toBe(10);
  });

  it('filters the whole history, not the page that happens to be loaded', async () => {
    const server = await start({ db: dbFile() });
    await ingest(server, [
      ...Array.from({ length: 30 }, (_, index) => record(`r${index}`, '/api/orders')),
      record('needle', '/api/checkout'),
    ]);

    const found = (await (
      await fetch(`${server.url}/_reqray/api/requests?q=checkout&limit=5`)
    ).json()) as { requests: Array<{ id: string }> };

    expect(found.requests.map((row) => row.id)).toEqual(['needle']);
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
      await fetch(`${server.url}/_reqray/api/requests`, {
        headers: { 'x-reqray-token': 'staging-secret' },
      })
    ).json()) as { requests: Array<{ id: string }> };

    expect(list.requests.map((row) => row.id).sort()).toEqual(['one', 'tail', 'two']);
  });
});
