/**
 * The briefing formatter is pure: what the assistant receives must be
 * checkable without a browser or a clipboard.
 */

import { describe, expect, it } from 'vitest';
import type { ExplainResult, RequestDetail, Span } from '../src/api/index';
import { buildBriefing } from '../src/features/detail/lib/briefing';

let spanId = 0;

function db(sql: string, duration: number): Span {
  return {
    id: ++spanId,
    parentId: null,
    startedAt: 0,
    duration,
    callsite: null,
    error: null,
    kind: 'db',
    sql,
    fingerprint: sql,
    rowCount: 1,
    source: 'pg',
  } as Span;
}

function detailWith(overrides: Partial<RequestDetail>): RequestDetail {
  return {
    id: 'r1',
    method: 'GET',
    path: '/api/orders',
    query: null,
    route: '/api/orders',
    flag: null,
    status: 200,
    durationMs: 48,
    startedAt: Date.now(),
    sqlCount: 0,
    nPlusOne: false,
    findingCount: 0,
    hasError: false,
    httpCount: 0,
    cpuMs: null,
    cpuShare: null,
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
    timing: { sqlMs: 0, externalMs: 0, cacheMs: 0, selfMs: 48, parallel: false },
    weight: { bytesIn: null, bytesOut: null, rows: 0, biggestRows: 0 },
    cost: null,
    host: null,
    ...overrides,
  };
}

describe('assistant briefing', () => {
  it('a finding comes with the code line, a hint, and a patch request', () => {
    const detail = detailWith({
      spans: [db('SELECT * FROM line_items WHERE order_id = 1', 0.4)],
      findings: [
        {
          detector: 'n_plus_one',
          severity: 'warn',
          title: '150 identical queries executed in a loop',
          costMs: 26,
          callsite: {
            file: '/srv/app/src/orders.js',
            relative: 'src/orders.js',
            line: 26,
            column: 5,
          },
          evidence: {
            kind: 'n_plus_one',
            repeats: 150,
            fingerprint: 'SELECT * FROM line_items WHERE order_id = ?',
            sample: 'SELECT * FROM line_items WHERE order_id = $1',
            totalMs: 60,
            spanIds: [1],
          },
          hint: 'Collect the identifiers and fetch "line_items" in a single query',
        },
      ],
    });

    const text = buildBriefing(detail);

    expect(text).toContain('# GET /api/orders — 200');
    expect(text).toContain('[n_plus_one] 150');
    expect(text).toContain('src/orders.js:26');
    expect(text).toContain('line_items');
    expect(text).toContain('Propose a minimal patch');
  });

  it('without findings the briefing is still meaningful: waterfall and SQL groups', () => {
    const text = buildBriefing(
      detailWith({
        spans: [db('SELECT 1', 2), db('SELECT 1', 3)],
      }),
    );

    expect(text).toContain('## Waterfall (2 spans)');
    expect(text).toContain('- 2× (5.0 ms) SELECT 1');
    expect(text).not.toContain('## Detector findings');
  });

  it('EXPLAIN plans make it into the briefing along with their notes', () => {
    const explain: ExplainResult = {
      sql: 'SELECT * FROM orders',
      nodes: [{ depth: 0, label: 'Seq Scan on orders', rows: 150, cost: 31 }],
      notes: [{ severity: 'warn', message: 'index hint' }],
      plan: {},
    };

    const text = buildBriefing(detailWith({}), new Map([[1, explain]]));

    expect(text).toContain('Seq Scan on orders rows≈150');
    expect(text).toContain('! index hint');
  });

  it('bodies are truncated and the total briefing length is capped', () => {
    const huge = detailWith({
      responseBody: { text: 'x'.repeat(5_000), truncated: false, bytes: 5_000 },
      spans: Array.from({ length: 500 }, (_, i) => db(`SELECT col_${i} FROM t_${i}`, 1)),
      logs: Array.from({ length: 100 }, (_, i) => ({
        at: i,
        level: 'info' as const,
        message: `line ${i}`,
      })),
    });

    const text = buildBriefing(huge);

    expect(text.length).toBeLessThanOrEqual(16_100);
    expect(text).toContain('more rows');
  });
});
