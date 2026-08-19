import { normalizeRoute, percentile, type RecordedRequest, routeStats } from '@loupe/core';
import { describe, expect, it } from 'vitest';

function request(overrides: Partial<RecordedRequest> = {}): RecordedRequest {
  return {
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
    expect(routeStats([])).toEqual({ routes: [], samples: 0, windowMs: 0 });
  });
});
