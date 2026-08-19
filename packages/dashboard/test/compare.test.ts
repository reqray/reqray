/**
 * The diff builder is pure — the answer to "where they diverged" must be testable
 * without a browser.
 */

import { describe, expect, it } from 'vitest';
import type { RequestDetail, Span } from '../src/api';
import { buildComparison } from '../src/compare';

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
