import { type RecordedRequest, timingOf, weightOf } from '@reqray/core';
import { normalizeRoute, percentile, routeStats } from '@reqray/core/panel';
import { describe, expect, it } from 'vitest';

function request(overrides: Partial<RecordedRequest> = {}): RecordedRequest {
  const base = {
    id: `r${Math.random()}`,
    method: 'GET',
    path: '/api/orders',
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
    host: base.host ?? null,
    weight: weightOf(base),
    cost: null,
  };
}

describe('route normalization', () => {
  it.each([
    ['/api/orders/8812', '/api/orders/:id'],
    ['/api/orders/8812/items/3', '/api/orders/:id/items/:id'],
    ['/api/reports/2026-08-19', '/api/reports/:date'],
    ['/api/sessions/a4f1c2d3', '/api/sessions/:id'],
    ['/api/users/550e8400-e29b-41d4-a716-446655440000', '/api/users/:id'],
    ['/api/search?q=blue', '/api/search'],
  ])('%s → %s', (path, expected) => {
    expect(normalizeRoute(path)).toBe(expected);
  });

  it('leaves words alone, even hex-looking ones', () => {
    // `feed`, `cafe` and `beef` are all valid hex; without the digit rule two
    // unrelated routes would merge into one row.
    for (const word of ['/api/feed', '/api/cafe', '/api/beef', '/api/deadbeef']) {
      expect(normalizeRoute(word)).toBe(word);
    }
  });

  it('a root path stays a root path', () => {
    expect(normalizeRoute('/')).toBe('/');
  });
});

describe('percentiles', () => {
  it('interpolates between neighbours', () => {
    // With four samples p95 sits between the third and the fourth.
    expect(percentile([10, 20, 30, 40], 0.95)).toBeCloseTo(38.5, 5);
  });

  it('separates p95 from p99 on small samples', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];

    // Index-based selection would return 100 for both.
    expect(percentile(sorted, 0.95)).not.toBe(percentile(sorted, 0.99));
  });

  it('handles the degenerate cases', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([42], 0.99)).toBe(42);
    expect(percentile([10, 20], 0)).toBe(10);
    expect(percentile([10, 20], 1)).toBe(20);
  });
});

describe('route aggregates', () => {
  it('groups variable paths into one route', () => {
    const report = routeStats([
      request({ path: '/api/orders/1' }),
      request({ path: '/api/orders/2' }),
      request({ path: '/api/orders/3' }),
    ]);

    expect(report.routes).toHaveLength(1);
    expect(report.routes[0]).toMatchObject({ route: '/api/orders/:id', calls: 3 });
  });

  it('keeps methods apart on the same path', () => {
    const report = routeStats([
      request({ path: '/api/orders' }),
      request({ path: '/api/orders', method: 'POST' }),
    ]);

    expect(report.routes.map((route) => route.method).sort()).toEqual(['GET', 'POST']);
  });

  it('reports the share of time each route accounts for', () => {
    const report = routeStats([
      request({ path: '/api/slow', durationMs: 750 }),
      request({ path: '/api/fast', durationMs: 250 }),
    ]);

    expect(report.routes[0]).toMatchObject({ route: '/api/slow', timeShare: 75 });
    expect(report.routes[1]?.timeShare).toBe(25);
    // The expensive route comes first without asking.
    expect(report.routes[0]?.route).toBe('/api/slow');
  });

  it('counts errors and queries per call', () => {
    const report = routeStats([
      request({ status: 500 }),
      request({ status: 200, spans: [{ kind: 'db' }, { kind: 'db' }] as never }),
    ]);

    expect(report.routes[0]).toMatchObject({ errorRate: 50, sqlAvg: 1 });
  });

  it('a thrown error counts even when the status does not say so', () => {
    const report = routeStats([
      request({ status: 200, error: { name: 'TypeError', message: 'boom', stack: null } }),
    ]);

    expect(report.routes[0]?.errorRate).toBe(100);
  });

  it('rates are per second over the retained window', () => {
    const report = routeStats([
      request({ startedAt: 0 }),
      request({ startedAt: 2_000 }),
      request({ startedAt: 4_000 }),
    ]);

    expect(report.windowMs).toBe(4_000);
    expect(report.routes[0]?.rps).toBeCloseTo(0.75, 5);
  });

  it('a single request does not divide by a zero-wide window', () => {
    const report = routeStats([request()]);

    expect(report.routes[0]?.rps).toBe(1);
    expect(Number.isFinite(report.routes[0]?.rps ?? Number.NaN)).toBe(true);
  });

  it('an empty buffer has nothing to report', () => {
    expect(routeStats([])).toEqual({ routes: [], samples: 0, windowMs: 0, from: 0, to: 0 });
  });
});

describe('what a route moves', () => {
  it('averages the bytes over the calls that reported any', () => {
    const [route] = routeStats([
      request({ responseHeaders: { 'content-length': '1000' } }),
      request({ responseHeaders: { 'content-length': '3000' } }),
      // A 204, a stream, a framework that did not set the header: this call
      // says nothing about its size, and counting it as zero would rank the
      // endpoint below one that returns a status code.
      request({ responseHeaders: {} }),
    ]).routes;

    expect(route?.bytesAvg).toBe(2_000);
    expect(route?.calls).toBe(3);
  });

  it('says nothing when no call reported a size', () => {
    const [route] = routeStats([request(), request()]).routes;
    expect(route?.bytesAvg).toBeNull();
  });
});

describe('what the detectors found here', () => {
  const finding = (detector: string, costMs: number, over: Record<string, unknown> = {}) =>
    ({
      detector,
      severity: 'warn',
      title: `${detector} fired`,
      costMs,
      callsite: { file: '/srv/app/src/shop.js', relative: 'src/shop.js', line: 7, column: 1 },
      evidence: {
        kind: 'budget',
        durationMs: 10,
        budgetMs: 1,
        externalMs: 0,
        sqlMs: 0,
        spanIds: [],
      },
      hint: 'fix it',
      ...over,
    }) as unknown as RecordedRequest['findings'][number];

  it('rolls the detectors up per route, costliest first', () => {
    const report = routeStats([
      request({ findings: [finding('n_plus_one', 30), finding('dup_cache', 1)] }),
      request({ findings: [finding('n_plus_one', 20)] }),
      request({ path: '/api/quiet', findings: [] }),
    ]);

    const orders = report.routes.find((row) => row.route === '/api/orders');
    expect(orders?.findings.map((found) => found.detector)).toEqual(['n_plus_one', 'dup_cache']);
    expect(orders?.findings[0]).toMatchObject({ calls: 2, recoverableMs: 50 });
    expect(report.routes.find((row) => row.route === '/api/quiet')?.findings).toEqual([]);
  });

  it('speaks with the freshest occurrence — a count must not be stale', () => {
    const report = routeStats([
      request({ startedAt: 1_000, findings: [finding('n_plus_one', 5, { title: '150 queries' })] }),
      request({ startedAt: 9_000, findings: [finding('n_plus_one', 5, { title: '12 queries' })] }),
    ]);

    expect(report.routes[0]?.findings[0]?.title).toBe('12 queries');
  });

  it('leaves a muted pattern out — the column is a shout', () => {
    const requests = [request({ findings: [finding('n_plus_one', 30), finding('dup_cache', 1)] })];
    const muted = new Set(['n_plus_one@src/shop.js:7']);

    expect(routeStats(requests)['routes'][0]?.findings.map((found) => found.detector)).toEqual([
      'n_plus_one',
      'dup_cache',
    ]);
    expect(
      routeStats(requests, muted)['routes'][0]?.findings.map((found) => found.detector),
    ).toEqual(['dup_cache']);
  });
});

describe('the shape of the traffic', () => {
  it('cuts every route into the same ten columns of the same window', () => {
    // Two routes over one ten-second window: one called at the start, one at
    // the end. Comparable by eye is the whole point of a shared window.
    const report = routeStats([
      request({ path: '/api/early', startedAt: 1_000 }),
      request({ path: '/api/early', startedAt: 1_500 }),
      request({ path: '/api/late', startedAt: 11_000 }),
    ]);

    const early = report.routes.find((row) => row.route === '/api/early');
    const late = report.routes.find((row) => row.route === '/api/late');

    expect(early?.trend).toHaveLength(10);
    expect(early?.trend[0]).toBe(2);
    expect(early?.trend.at(-1)).toBe(0);
    expect(late?.trend[0]).toBe(0);
    expect(late?.trend.at(-1)).toBe(1);
    // Every bar adds up to the calls it stands for.
    for (const row of report.routes) {
      expect(row.trend.reduce((sum, value) => sum + value, 0)).toBe(row.calls);
    }
  });

  it('a single call still draws a shape rather than dividing by nothing', () => {
    const report = routeStats([request()]);

    expect(report.routes[0]?.trend).toHaveLength(10);
    expect(report.routes[0]?.trend.reduce((sum, value) => sum + value, 0)).toBe(1);
  });
});
