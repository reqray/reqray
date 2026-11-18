/**
 * The store behind the real panel handler.
 *
 * The unit tests ask the store questions directly; this asks the panel, over
 * HTTP, the way a browser does — which is the only way to find out whether a
 * store that satisfies the interface actually satisfies the panel.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RecordedRequest } from '@reqray/core';
import { DAY_MS, type RetentionPolicy, resolveOptions, retentionPolicy } from '@reqray/core';
import { createPanelHandler } from '@reqray/core/panel';
import { sqliteTransport } from '@reqray/store-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { record, sample } from './fixtures/records.js';

const servers: Server[] = [];
const stores: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) await store.close();
});

/** A panel serving a SQLite store, on a port of its own. */
async function panel(
  options: { retention?: RetentionPolicy } = {},
): Promise<{ base: string; store: ReturnType<typeof sqliteTransport> }> {
  const store = sqliteTransport({
    file: ':memory:',
    ...(options.retention ? { retention: options.retention } : {}),
  });
  stores.push(store);
  for (const entry of sample()) store.send(entry);

  const handler = createPanelHandler({
    source: store,
    options: resolveOptions({
      mode: 'development',
      ...(options.retention ? { retention: options.retention } : {}),
    }),
  });
  if (!handler) throw new Error('the panel refused to mount');

  const server = createServer((request, response) => {
    if (handler(request, response)) return;
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}/_reqray`, store };
}

const get = async (base: string, path: string) =>
  (await fetch(`${base}${path}`)).json() as Promise<Record<string, never>>;

describe('the panel over a SQLite store', () => {
  it('serves a page and a way to continue', async () => {
    const { base } = await panel();

    const first = (await get(base, '/api/requests?limit=3')) as unknown as {
      requests: Array<{ id: string }>;
      nextCursor: string;
      summary: { total: number };
    };

    expect(first.requests.map((row) => row.id)).toEqual(['r8', 'r7', 'r6']);
    expect(first.summary.total).toBe(8);

    const next = (await get(
      base,
      `/api/requests?limit=3&cursor=${encodeURIComponent(first.nextCursor)}`,
    )) as unknown as { requests: Array<{ id: string }> };
    expect(next.requests.map((row) => row.id)).toEqual(['r5', 'r4', 'r3']);
  });

  it('answers "what was slowest" without being asked for the whole history', async () => {
    const { base } = await panel();

    const slowest = (await get(base, '/api/requests?sort=slowest&limit=2')) as unknown as {
      requests: Array<{ id: string; durationMs: number }>;
    };

    expect(slowest.requests.map((row) => row.id)).toEqual(['r4', 'r3']);
    expect(slowest.requests[0]?.durationMs).toBe(855);
  });

  it('answers "what failed", which is wider than the 5xx class', async () => {
    const { base } = await panel();

    const failed = (await get(base, '/api/requests?errors=1')) as unknown as {
      requests: Array<{ id: string }>;
    };

    expect(failed.requests.map((row) => row.id)).toEqual(['r5']);
  });

  it('filters on the server, over everything it holds', async () => {
    const { base } = await panel();

    const found = (await get(base, '/api/requests?q=checkout')) as unknown as {
      requests: Array<{ id: string }>;
    };

    expect(found.requests.map((row) => row.id)).toEqual(['r3']);
  });

  it('hands over one request in full', async () => {
    const { base } = await panel();

    const detail = (await get(base, '/api/requests/r4')) as unknown as {
      id: string;
      path: string;
      spans: unknown[];
    };

    expect(detail).toMatchObject({ id: 'r4', path: '/api/report' });
    expect(detail.spans).toEqual([]);
  });

  it('answers the screens that read the store whole', async () => {
    const { base } = await panel();

    const routes = (await get(base, '/api/routes')) as unknown as {
      routes: Array<{ route: string }>;
    };
    const exceptions = (await get(base, '/api/exceptions')) as unknown as { groups: unknown[] };

    expect(routes.routes.length).toBeGreaterThan(0);
    expect(exceptions.groups).toEqual([]);
  });

  it('pins through the panel, and the pin sticks', async () => {
    const { base, store } = await panel();

    const response = await fetch(`${base}/api/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'r2', pinned: true }),
    });

    expect(response.status).toBe(200);
    expect(store.pinned()).toEqual(['r2']);
  });
  it('judges one call against the route it belongs to', async () => {
    const { base, store } = await panel();
    // Twenty-five calls of one route: twenty-four to compare against, which
    // is past the point where a ninety-fifth percentile means something.
    for (let index = 0; index < 25; index++) {
      store.send(record({ id: `c${index}`, path: '/api/orders/1', durationMs: 20 + index }));
    }
    store.send(record({ id: 'slow', path: '/api/orders/1', durationMs: 900 }));

    const { baseline } = (await get(base, '/api/requests/slow/baseline')) as unknown as {
      baseline: { route: string; samples: number; verdict: string; p95Ms: number };
    };

    expect(baseline.route).toBe('/api/orders/:id');
    expect(baseline.samples).toBe(25);
    expect(baseline.verdict).toBe('slower');
    expect(baseline.p95Ms).toBeGreaterThan(40);
  });

  it('says when a route is slower while the loop is behind, and when it is not', async () => {
    const { base, store } = await panel();
    // Sixty calls of one route: half while the loop was quiet, half while it
    // was 60 ms behind and the route ran three times slower.
    for (let index = 0; index < 30; index++) {
      store.send(
        record({
          id: `q${index}`,
          path: '/api/checkout/1',
          durationMs: 40,
          host: { loopDelayMs: 0.5, loopMaxMs: 2 },
        }),
      );
      store.send(
        record({
          id: `b${index}`,
          path: '/api/checkout/1',
          durationMs: 120,
          host: { loopDelayMs: 60, loopMaxMs: 180 },
        }),
      );
    }
    store.send(record({ id: 'subject', path: '/api/checkout/1', durationMs: 130 }));

    const { pressure } = (await get(base, '/api/requests/subject/baseline')) as unknown as {
      pressure: { cutoffMs: number; ratio: number; elevated: { calls: number } };
    };

    expect(pressure.ratio).toBeCloseTo(3, 1);
    expect(pressure.cutoffMs).toBeGreaterThan(1);
    expect(pressure.elevated.calls).toBe(30);

    // And the route where nothing varied says nothing at all.
    const quiet = (await get(base, '/api/requests/r1/baseline')) as unknown as {
      pressure: unknown;
    };
    expect(quiet.pressure).toBeNull();
  });

  it('draws three charts for one route, bucketed by the store', async () => {
    const { base, store } = await panel();
    for (let index = 0; index < 40; index++) {
      store.send(
        record({
          id: `s${index}`,
          path: '/api/orders/1',
          durationMs: 20 + index,
          status: index % 10 === 0 ? 500 : 200,
        }),
      );
    }

    const { series } = (await get(
      base,
      '/api/routes/series?method=GET&route=%2Fapi%2Forders%2F%3Aid&buckets=8',
    )) as unknown as {
      series: {
        calls: number;
        bucketMs: number;
        buckets: Array<{ calls: number; errors: number; p95: number }>;
      };
    };

    expect(series.buckets).toHaveLength(8);
    expect(series.calls).toBe(40);
    expect(series.buckets.reduce((total, bucket) => total + bucket.calls, 0)).toBe(40);
    expect(series.buckets.reduce((total, bucket) => total + bucket.errors, 0)).toBe(4);
    // Later columns hold the slower calls: the fixture's durations climb.
    expect(series.buckets.at(-1)?.p95 ?? 0).toBeGreaterThan(series.buckets[0]?.p95 ?? 0);
  });

  it('draws a period, one metric per line and a void where nothing ran', async () => {
    const { base, store } = await panel();
    const start = Date.UTC(2026, 7, 20, 10, 0, 0);
    // Twenty calls in the first ten minutes of an hour, then silence.
    for (let index = 0; index < 20; index++) {
      store.send(
        record({
          id: `h${index}`,
          path: '/api/orders',
          durationMs: 20 + index,
          startedAt: start + index * 30_000,
          status: index === 0 ? 500 : 200,
        }),
      );
    }

    const { series } = (await get(
      base,
      `/api/series?from=${start}&to=${start + 3_600_000}&buckets=6&metric=p95,errorRate`,
    )) as unknown as {
      series: {
        from: number;
        to: number;
        calls: number[];
        truncated: boolean;
        series: Array<{ metric: string; values: Array<number | null> }>;
        totals: { calls: number; p95: number; busiest: { route: string } | null };
        previous: unknown;
      };
    };

    expect(series.from).toBe(start);
    expect(series.to).toBe(start + 3_600_000);
    expect(series.series.map((line) => line.metric)).toEqual(['p95', 'errorRate']);
    // The traffic is in the first columns; the rest of the hour is a void,
    // not a floor.
    expect(series.calls[0]).toBeGreaterThan(0);
    expect(series.calls.at(-1)).toBe(0);
    for (const line of series.series) {
      expect(line.values.at(-1)).toBeNull();
      expect(line.values).toHaveLength(series.calls.length);
    }
    expect(series.totals).toMatchObject({ calls: 20 });
    expect(series.totals.busiest?.route).toBe('/api/orders');
    expect(series.truncated).toBe(false);
    // And the hour before it, read the same way: the fixture's eight
    // requests, which is what "against the period before" is drawn from.
    expect(series.previous).toMatchObject({ calls: 8 });
  });

  it('takes the same filter the list takes', async () => {
    const { base, store } = await panel();
    const start = Date.UTC(2026, 7, 20, 12, 0, 0);
    for (let index = 0; index < 10; index++) {
      store.send(
        record({
          id: `f${index}`,
          path: index % 2 === 0 ? '/api/orders' : '/api/report',
          startedAt: start + index * 1_000,
        }),
      );
    }

    const { series } = (await get(
      base,
      `/api/series?from=${start}&to=${start + 60_000}&route=%2Fapi%2Freport&routeMethod=GET`,
    )) as unknown as { series: { totals: { calls: number } } };

    expect(series.totals.calls).toBe(5);
  });

  it('answers two metrics at most, and defaults to one', async () => {
    const { base } = await panel();
    const ask = async (query: string) =>
      (
        (await get(base, `/api/series?${query}`)) as unknown as {
          series: { series: Array<{ metric: string }> };
        }
      ).series.series.map((line) => line.metric);

    expect(await ask('metric=p50,p95,p99,throughput')).toEqual(['p50', 'p95']);
    // A metric nobody measures is not a metric: it falls back rather than
    // answering with an empty line.
    expect(await ask('metric=cpu')).toEqual(['p95']);
    expect(await ask('')).toEqual(['p95']);
  });

  it('refuses a period that ends before it starts', async () => {
    const { base } = await panel();
    const answer = await fetch(`${base}/api/series?from=2000&to=1000`);
    expect(answer.status).toBe(400);
  });

  it('refuses to draw one without being told which', async () => {
    const { base } = await panel();
    const answer = await fetch(`${base}/api/routes/series`);
    expect(answer.status).toBe(400);
  });

  it('answers what ran in one moment, and says so when nothing stood out', async () => {
    const { base, store } = await panel();
    const start = Date.UTC(2026, 7, 20, 10, 0, 0);
    // An hour of steady traffic on one route...
    for (let index = 0; index < 120; index++) {
      store.send(
        record({
          id: `q${index}`,
          path: '/api/orders',
          durationMs: 20,
          startedAt: start + index * 30_000,
        }),
      );
    }
    // ...and a burst of a different one inside a single minute of it.
    for (let index = 0; index < 20; index++) {
      store.send(
        record({
          id: `burst${index}`,
          path: '/api/export',
          durationMs: 400,
          startedAt: start + 1_800_000 + index * 2_000,
        }),
      );
    }

    const overall = `overallFrom=${start}&overallTo=${start + 3_600_000}`;
    const spike = (await get(
      base,
      `/api/timeline/at?from=${start + 1_800_000}&to=${start + 1_860_000}&${overall}`,
    )) as unknown as { activity: { outliers: Array<{ route: string; firstSeen: boolean }> } };

    expect(spike.activity.outliers[0]?.route).toBe('/api/export');
    expect(spike.activity.outliers[0]?.firstSeen).toBe(true);

    // And a quiet minute of the same window has nothing to report, which is
    // the answer rather than the absence of one.
    const quiet = (await get(
      base,
      `/api/timeline/at?from=${start + 600_000}&to=${start + 660_000}&${overall}`,
    )) as unknown as { activity: { outliers: unknown[] } };

    expect(quiet.activity.outliers).toEqual([]);
  });

  it('says nothing about a route it has seen once', async () => {
    const { base } = await panel();
    const { baseline } = (await get(base, '/api/requests/r1/baseline')) as unknown as {
      baseline: unknown;
    };

    // The sample holds one call per path. A verdict here would be the request
    // measuring itself.
    expect(baseline).toBeNull();
  });

  it('does not mistake the baseline route for a request id', async () => {
    const { base } = await panel();
    const detail = (await get(base, '/api/requests/r1')) as unknown as { id: string };
    expect(detail.id).toBe('r1');
  });
});

describe('changing how long requests are kept', () => {
  const post = async (base: string, body: unknown) => {
    const response = await fetch(`${base}/api/retention`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
  };

  it('reports what is in force, and whether it outlives the process', async () => {
    const { base } = await panel({ retention: retentionPolicy({ days: 7 }) });

    const read = (await get(base, '/api/retention')) as unknown as {
      retention: { days: number; writable: boolean; remembered: boolean };
    };

    expect(read.retention).toMatchObject({ days: 7, writable: true, remembered: false });
  });

  it('changes it, and the store obeys at once', async () => {
    const retention = retentionPolicy({ days: 30 });
    const { base, store } = await panel({ retention });
    const first = sample()[0] as RecordedRequest;
    store.send({ ...first, id: 'ancient', startedAt: Date.now() - 20 * DAY_MS });
    expect(store.list().some((entry) => entry.id === 'ancient')).toBe(true);

    const { status, payload } = await post(base, { days: 3 });

    expect(status).toBe(200);
    expect(payload['limits']).toMatchObject({ days: 3 });
    // Not "it will be gone eventually": the store swept when it was told.
    expect(store.list().some((entry) => entry.id === 'ancient')).toBe(false);
  });

  it('refuses a number that is not a limit, and changes nothing', async () => {
    const retention = retentionPolicy({ days: 7 });
    const { base } = await panel({ retention });

    const { status, payload } = await post(base, { days: -3 });

    expect(status).toBe(400);
    expect(String(payload['error'])).toContain('retention unchanged');
    expect(retention.current().days).toBe(7);
  });

  it('refuses a body with nothing to change in it', async () => {
    const { base } = await panel({ retention: retentionPolicy({ days: 7 }) });

    expect((await post(base, { nonsense: 1 })).status).toBe(400);
  });

  it('refuses when the application made the policy read-only', async () => {
    const { base } = await panel({ retention: retentionPolicy({ days: 7, writable: false }) });

    const { status, payload } = await post(base, { days: 3 });

    expect(status).toBe(403);
    expect(String(payload['error'])).toContain('read-only');
  });

  it('says what to do when there is no policy at all', async () => {
    const { base } = await panel();

    const { status, payload } = await post(base, { days: 3 });

    expect(status).toBe(501);
    expect(String(payload['error'])).toContain('retentionPolicy');
  });
});

describe('the findings tab, over HTTP', () => {
  it('groups the occurrences and answers the window', async () => {
    const { base } = await panel();

    const { findings } = (await get(base, '/api/findings')) as unknown as {
      findings: {
        patterns: Array<{ id: string; detector: string; occurrences: number; state: string }>;
        occurrences: number;
      };
    };

    expect(findings.patterns).toHaveLength(1);
    expect(findings.patterns[0]).toMatchObject({
      detector: 'n_plus_one',
      occurrences: 1,
      state: 'new',
    });
    expect(findings.occurrences).toBe(1);
  });

  it('a muted pattern stops flagging the list, and unmuting restores it', async () => {
    const { base } = await panel();
    const patternId = 'n_plus_one@GET /api/orders';

    const rowOf = async () => {
      const { requests } = (await get(base, '/api/requests')) as unknown as {
        requests: Array<{ id: string; flag: string | null }>;
      };
      return requests.find((row) => row.id === 'r1');
    };

    expect((await rowOf())?.flag).toBe('n_plus_one');

    const mute = await fetch(`${base}/api/findings/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: patternId, state: 'muted' }),
    });
    expect(mute.status).toBe(200);

    // The record keeps its findings; only the shout is gone.
    expect((await rowOf())?.flag).toBeNull();
    const { findings } = (await get(base, '/api/findings')) as unknown as {
      findings: { patterns: Array<{ state: string }> };
    };
    expect(findings.patterns[0]?.state).toBe('muted');

    await fetch(`${base}/api/findings/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: patternId, state: 'new' }),
    });
    expect((await rowOf())?.flag).toBe('n_plus_one');
  });

  it('refuses a state it does not keep', async () => {
    const { base } = await panel();

    const response = await fetch(`${base}/api/findings/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'x', state: 'fixed' }),
    });

    expect(response.status).toBe(400);
  });
});
