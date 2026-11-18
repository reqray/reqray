/**
 * The panel's HTTP contract, tested where the router lives.
 *
 * The part of it that is a refusal: the checks standing between a web page a
 * developer happens to have open and an endpoint that charges a card again.
 */

import { createServer, request as httpRequest, type Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { type RecordedRequest, resolveOptions, timingOf, weightOf } from '@reqray/core';
import { createPanelHandler, pageFromList, parseFilter } from '@reqray/core/panel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function record(overrides: Partial<RecordedRequest> = {}): RecordedRequest {
  const base = {
    id: 'r1',
    method: 'GET',
    path: '/orders',
    query: null,
    status: 200,
    durationMs: 10,
    startedAt: 1_000,
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
    ...overrides,
  };
  return {
    ...base,
    timing: timingOf(base.spans, base.durationMs),
    host: null,
    weight: weightOf(base),
    cost: null,
  };
}

/** The smallest thing the panel will read from. */
function sourceOf(records: readonly RecordedRequest[] = [], pinned: readonly string[] = []) {
  const held = [...records];
  return {
    list: () => held,
    get: (id: string) => held.find((r) => r.id === id),
    clear: () => {
      held.length = 0;
    },
    subscribe: () => () => undefined,
    pinned: () => pinned,
  };
}

let server: Server;
let base: string;

function mount(
  records: readonly RecordedRequest[] = [],
  pinned: readonly string[] = [],
): Promise<void> {
  const handler = createPanelHandler({
    source: sourceOf(records, pinned),
    options: resolveOptions({ panel: { path: '/_reqray' } }),
  });
  if (!handler) throw new Error('the panel refused to mount');

  server = createServer((request, response) => {
    if (handler(request, response)) return;
    response.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/_reqray`;
      resolve();
    });
  });
}

afterEach(
  () =>
    new Promise<void>((resolve) => {
      server?.close(() => resolve());
    }),
);

describe('a request that did not come from the panel', () => {
  beforeEach(() => mount([record()]));

  it('refuses a POST a page on another site made', async () => {
    const response = await fetch(`${base}/api/pin`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'r1', pinned: true }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/did not come from the panel/);
  });

  it('refuses a neighbour on another port of the same host', async () => {
    // Two ports of localhost are one *site*, which is exactly the case a
    // same-site allowance would let through: another dev server on :4000.
    const response = await fetch(`${base}/api/requests`, {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'same-site' },
    });
    expect(response.status).toBe(403);
  });

  it('refuses a cross-origin POST from a browser too old to say', async () => {
    const response = await fetch(`${base}/api/pin`, {
      method: 'POST',
      headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'r1', pinned: true }),
    });
    expect(response.status).toBe(403);
  });

  it('lets the panel’s own page through', async () => {
    const response = await fetch(`${base}/api/requests`, {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(response.status).toBe(200);
  });

  it('lets a terminal client through — a script is not a cross-site page', async () => {
    // No `Sec-Fetch-Site`, no `Origin`: no browser sends neither, so this is
    // curl or the CLI, and CSRF is not what that is.
    const response = await fetch(`${base}/api/requests`, { method: 'DELETE' });
    expect(response.status).toBe(200);
  });

  it('leaves reads alone', async () => {
    const response = await fetch(`${base}/api/requests`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(response.status).toBe(200);
  });
});

describe('blame', () => {
  beforeEach(() => mount());

  it('answers nothing for a file outside the project', async () => {
    const response = await fetch(`${base}/api/blame`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ frames: [{ file: '/etc/passwd', line: 1 }] }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { frames: unknown[] }).frames).toEqual([null]);
  });

  it('answers nothing for a line that is not a line', async () => {
    const response = await fetch(`${base}/api/blame`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        frames: [{ file: `${process.cwd()}/x.ts`, line: Number.POSITIVE_INFINITY }],
      }),
    });
    expect(((await response.json()) as { frames: unknown[] }).frames).toEqual([null]);
  });
});

describe('the live feed', () => {
  beforeEach(() => mount());

  it('refuses to hold more streams open than it can account for', async () => {
    const controllers: AbortController[] = [];
    const statuses: number[] = [];
    try {
      // One past the cap: the last one must be told, not silently accepted.
      for (let i = 0; i < 33; i++) {
        const controller = new AbortController();
        controllers.push(controller);
        const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
        statuses.push(response.status);
        if (response.status !== 200) await response.body?.cancel();
      }
      expect(statuses.filter((s) => s === 200)).toHaveLength(32);
      expect(statuses.at(-1)).toBe(503);

      // And a slot comes back when one feed closes: the cap is a gauge, not a
      // ratchet, or a panel left open all morning would stop answering. One
      // stream is closed rather than all of them — how long thirty-two sockets
      // take to tear down is a fact about the machine, and asserting on it
      // would make this a test of how busy the machine is.
      controllers[0]?.abort();
      let after: Response | undefined;
      for (let attempt = 0; attempt < 100 && after?.status !== 200; attempt++) {
        await after?.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 50));
        after = await fetch(`${base}/api/stream`);
      }
      expect(after?.status).toBe(200);
      await after?.body?.cancel();
    } finally {
      for (const controller of controllers) controller.abort();
    }
  });
});

describe('a live feed nobody is reading', () => {
  it('is dropped rather than buffered without end', async () => {
    // A backgrounded tab or a stalled proxy stops reading; every row since
    // then used to stay in the application's memory for as long as it ran.
    let listener: ((recorded: RecordedRequest) => void) | null = null;
    const handler = createPanelHandler({
      source: {
        ...sourceOf(),
        subscribe: (onRecord: (recorded: RecordedRequest) => void) => {
          listener = onRecord;
          return () => {
            listener = null;
          };
        },
      },
      options: resolveOptions({ panel: { path: '/_reqray' } }),
    });
    server = createServer((request, response) => void handler?.(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    // A raw socket that asks for the feed and then never reads a byte.
    const socket = connect(port, '127.0.0.1');
    socket.pause();
    socket.write(`GET /_reqray/api/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    try {
      for (let waited = 0; !listener && waited < 100; waited++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(listener).not.toBeNull();

      // Far more than the kernel will take on the reader's behalf.
      const row = record({ path: `/${'x'.repeat(64 * 1024)}` });
      for (let sent = 0; listener && sent < 500; sent++) {
        (listener as (recorded: RecordedRequest) => void)(row);
        if (sent % 20 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
      for (let waited = 0; listener && waited < 100; waited++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(listener).toBeNull();
    } finally {
      socket.destroy();
    }
  });
});

describe('a store that cannot page for itself', () => {
  beforeEach(() =>
    mount(
      [
        record({ id: 'kept', path: '/orders', startedAt: 2_000 }),
        record({ id: 'other', path: '/health', startedAt: 1_000 }),
      ],
      ['kept'],
    ),
  );

  it('keeps a pinned row through a filter that excludes it', async () => {
    // A pin is somebody deliberately setting a request aside; it must not
    // depend on which store is behind the panel.
    const response = await fetch(`${base}/api/requests?path=health`);
    const body = (await response.json()) as { requests: Array<{ id: string; pinned: boolean }> };

    expect(body.requests.map((row) => row.id)).toContain('kept');
    expect(body.requests.find((row) => row.id === 'kept')?.pinned).toBe(true);
  });

  it('pages, and says where to continue from', async () => {
    const response = await fetch(`${base}/api/requests?limit=1`);
    const body = (await response.json()) as {
      requests: unknown[];
      nextCursor: string | null;
    };

    // Without this a store with no paging of its own has no second page.
    expect(body.requests).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();
  });
});

/** A GET with a `Host` of the caller's choosing — `fetch` will not send one. */
function getAs(host: string, path: string): Promise<number> {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    httpRequest(
      { host: target.hostname, port: target.port, path, headers: { host } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    )
      .on('error', reject)
      .end();
  });
}

describe('a panel with no gate', () => {
  beforeEach(() => mount([record()]));

  it('answers this machine at a local address', async () => {
    expect(await getAs('localhost:3000', '/_reqray/api/requests')).toBe(200);
    expect(await getAs('127.0.0.1:3000', '/_reqray/api/requests')).toBe(200);
  });

  it('refuses a name that is not this machine’s, even from loopback', async () => {
    // DNS rebinding: a hostile domain re-pointed at 127.0.0.1 is same-origin
    // to its own page, so the browser lets it read — but it still names itself.
    expect(await getAs('attacker.example:3000', '/_reqray/api/requests')).toBe(403);
  });
});

describe('a request the panel cannot parse', () => {
  beforeEach(() => mount([record()]));

  it('answers 400 instead of throwing into the server it is mounted on', async () => {
    // A lone `%` does not decode. On a bare `node:http` server an exception
    // in the listener is an uncaught one, and the process is the application.
    const response = await fetch(`${base}/api/requests/%`);
    expect(response.status).toBe(400);

    // And the server is still there to answer the next one.
    expect((await fetch(`${base}/api/requests/r1`)).status).toBe(200);
  });
});

describe('paging a list that is not in start order', () => {
  // A ring holds requests in the order they finished. `slow` started first
  // and landed last, so it sits at the newest end of the list.
  const ring = [
    record({ id: 'slow', startedAt: 1_000 }),
    record({ id: 'c', startedAt: 3_000 }),
    record({ id: 'b', startedAt: 2_000 }),
  ];

  it('serves every row once, newest start first', () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = pageFromList(ring, {
        filter: parseFilter(new URLSearchParams()),
        limit: 1,
        cursor,
      });
      seen.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(['c', 'b', 'slow']);
  });
});
