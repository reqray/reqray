/**
 * The diff builder is pure — the answer to "where they diverged" must be testable
 * without a browser.
 */

import { describe, expect, it } from 'vitest';
import type { RequestDetail, Span } from '../src/api';
import { buildComparison, buildMetrics, buildVerdict } from '../src/compare';

let spanId = 0;

function db(fingerprint: string, duration: number): Span {
  return {
    id: ++spanId,
    parentId: null,
    startedAt: 0,
    duration,
    callsite: null,
    error: null,
    kind: 'db',
    sql: fingerprint,
    fingerprint,
    rowCount: 1,
    source: 'pg',
  } as Span;
}

function http(method: string, url: string, duration: number): Span {
  return {
    id: ++spanId,
    parentId: null,
    startedAt: 0,
    duration,
    callsite: null,
    error: null,
    kind: 'http',
    method,
    url,
    statusCode: 200,
  } as Span;
}

function detailWith(spans: Span[]): RequestDetail {
  return { spans } as RequestDetail;
}

describe('comparing two requests', () => {
  it('N+1 vs eager: the divergence is a single group, and it comes first', () => {
    const slow = detailWith([
      db('SELECT id FROM orders', 5),
      ...Array.from({ length: 150 }, () => db('SELECT * FROM line_items WHERE order_id = ?', 0.4)),
    ]);
    const fast = detailWith([
      db('SELECT id FROM orders', 5),
      db('SELECT * FROM line_items WHERE order_id = ANY(?)', 6),
    ]);

    const rows = buildComparison(slow, fast);

    const loudest = rows[0];
    expect(loudest?.label).toContain('line_items WHERE order_id = ?');
    expect(loudest?.a).toEqual({ calls: 150, totalMs: expect.closeTo(60, 5) });
    expect(loudest?.b).toEqual({ calls: 0, totalMs: 0 });
    expect(loudest?.deltaMs).toBeLessThan(0);

    // The shared parent query cancels out and sinks to the bottom.
    const shared = rows.find((row) => row.label === 'SELECT id FROM orders');
    expect(shared?.deltaMs).toBe(0);
  });

  it('HTTP shapes are grouped without the query string', () => {
    const a = detailWith([
      http('GET', 'https://api.example.com/search?q=1', 30),
      http('GET', 'https://api.example.com/search?q=2', 30),
    ]);
    const b = detailWith([http('GET', 'https://api.example.com/search?q=3', 25)]);

    const rows = buildComparison(a, b);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: 'GET https://api.example.com/search',
      a: { calls: 2, totalMs: 60 },
      b: { calls: 1, totalMs: 25 },
    });
  });

  it('a group present on only one side shows zero on the other', () => {
    const a = detailWith([]);
    const b = detailWith([db('SELECT 1', 3)]);

    const [row] = buildComparison(a, b);

    expect(row?.a.calls).toBe(0);
    expect(row?.b.calls).toBe(1);
    expect(row?.deltaMs).toBe(3);
  });
});

/** A whole request, not just its spans: the metrics table reads the facts. */
function requestWith(over: Partial<RequestDetail>): RequestDetail {
  return {
    id: 'r1',
    method: 'GET',
    path: '/api/orders',
    query: null,
    route: '/api/orders',
    status: 200,
    durationMs: 100,
    startedAt: 1_700_000_000_000,
    sqlCount: 0,
    httpCount: 0,
    nPlusOne: false,
    findingCount: 0,
    hasError: false,
    pinned: false,
    test: null,
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
    ...over,
  } as RequestDetail;
}

const row = (rows: ReturnType<typeof buildMetrics>, label: string) =>
  rows.find((item) => item.label === label);

describe('the metrics table', () => {
  it('marks an identical value as the same', () => {
    const rows = buildMetrics(requestWith({}), requestWith({}));

    expect(row(rows, 'method')).toMatchObject({ delta: '=', tone: 'dim' });
  });

  it('a status difference is never just a difference', () => {
    const rows = buildMetrics(requestWith({}), requestWith({ status: 500 }));

    expect(row(rows, 'status')).toMatchObject({ a: '200', b: '500', delta: '≠', tone: 'warn' });
  });

  it('getting faster is good news, getting slower is not', () => {
    const faster = buildMetrics(requestWith({ durationMs: 300 }), requestWith({ durationMs: 100 }));
    const slower = buildMetrics(requestWith({ durationMs: 100 }), requestWith({ durationMs: 300 }));

    expect(row(faster, 'duration')).toMatchObject({ delta: '−200 ms', tone: 'ok' });
    expect(row(slower, 'duration')).toMatchObject({ delta: '+200 ms', tone: 'err' });
  });

  it('counts queries on both sides', () => {
    const rows = buildMetrics(
      requestWith({ spans: [db('SELECT 1', 1), db('SELECT 2', 1)] }),
      requestWith({ spans: [db('SELECT 1', 1)] }),
    );

    expect(row(rows, 'sql queries')).toMatchObject({ a: '2', b: '1', delta: '−1', tone: 'ok' });
  });

  it('an absent test reads as a dash, not as an empty cell', () => {
    const rows = buildMetrics(requestWith({}), requestWith({ test: 'orders.spec.ts:42' }));

    expect(row(rows, 'from test')).toMatchObject({ a: '—', b: 'orders.spec.ts:42', delta: '≠' });
  });
});

describe('the verdict', () => {
  it('says which is faster, by how much, and what to do next', () => {
    const slow = requestWith({
      durationMs: 300,
      spans: [db('SELECT 1', 1)],
      findings: [
        {
          detector: 'n_plus_one',
          severity: 'warn',
          title: '150 identical queries ran in a loop',
          costMs: 120,
          callsite: {
            file: '/srv/app/src/orders.js',
            relative: 'src/orders.js',
            line: 26,
            column: 1,
          },
          evidence: {
            kind: 'n_plus_one',
            repeats: 150,
            fingerprint: 'SELECT ?',
            sample: 'SELECT 1',
            totalMs: 120,
            spanIds: [],
          },
          hint: 'use IN (…)',
        },
      ],
    });
    const fast = requestWith({ durationMs: 100 });

    const verdict = buildVerdict(slow, fast);

    expect(verdict).toContain('B is faster by 200 ms');
    expect(verdict).toContain('67%');
    expect(verdict).toContain('The N+1 is gone in B');
    expect(verdict).toContain('src/orders.js:26');
  });

  it('names the slower side when it is B', () => {
    const verdict = buildVerdict(
      requestWith({ durationMs: 100 }),
      requestWith({ durationMs: 400 }),
    );

    expect(verdict).toContain('A is faster');
  });

  it('says plainly when there is nothing between them', () => {
    const verdict = buildVerdict(requestWith({}), requestWith({}));

    expect(verdict).toContain('the same time');
  });

  it('does not invent a next step when neither side has a finding', () => {
    const verdict = buildVerdict(
      requestWith({ durationMs: 100 }),
      requestWith({ durationMs: 200 }),
    );

    expect(verdict).toContain('the difference is elsewhere');
  });
});
