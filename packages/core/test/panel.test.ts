import {
  filterRequests,
  groupExceptions,
  type RecordedRequest,
  resolveOptions,
  summarize,
} from '@loupe/core';
import { describe, expect, it } from 'vitest';

const stack = resolveOptions({ stack: { projectRoot: '/srv/app' } }).stack;

function request(overrides: Partial<RecordedRequest> = {}): RecordedRequest {
  return {
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
    ...overrides,
  };
}

const errorAt = (line: number, message = 'cannot read undefined') => ({
  name: 'TypeError',
  message,
  stack: [
    `TypeError: ${message}`,
    `    at priceOf (/srv/app/services/pricing.js:${line}:14)`,
    '    at Array.map (<anonymous>)',
    '    at Client.query (/srv/app/node_modules/pg/lib/client.js:520:11)',
  ].join('\n'),
});

describe('list filters', () => {
  const all = [
    request({ id: 'a', path: '/api/search', query: 'q=blue', durationMs: 900 }),
    request({ id: 'b', method: 'POST', path: '/api/orders', status: 500, durationMs: 20 }),
    request({
      id: 'c',
      path: '/api/orders',
      durationMs: 300,
      findings: [{ detector: 'n_plus_one' } as never],
    }),
  ];

  it('searches by path, method, status, and query string', () => {
    expect(filterRequests(all, { query: 'search' }).map((r) => r.id)).toEqual(['a']);
    expect(filterRequests(all, { query: 'post' }).map((r) => r.id)).toEqual(['b']);
    expect(filterRequests(all, { query: '500' }).map((r) => r.id)).toEqual(['b']);
    expect(filterRequests(all, { query: 'blue' }).map((r) => r.id)).toEqual(['a']);
  });

  it('filters by methods and status classes', () => {
    expect(filterRequests(all, { methods: ['post'] }).map((r) => r.id)).toEqual(['b']);
    expect(filterRequests(all, { statusClasses: [5] }).map((r) => r.id)).toEqual(['b']);
    expect(filterRequests(all, { statusClasses: [2] }).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('filters by duration and presence of findings', () => {
    expect(filterRequests(all, { minDurationMs: 100 }).map((r) => r.id)).toEqual(['a', 'c']);
    expect(filterRequests(all, { onlyFindings: true }).map((r) => r.id)).toEqual(['c']);
  });

  it('an empty filter cuts nothing and preserves order', () => {
    expect(filterRequests(all).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(filterRequests(all, { methods: [], statusClasses: [] })).toHaveLength(3);
  });

  it('computes the summary over the whole buffer, not the shown slice', () => {
    const shown = filterRequests(all, { query: 'search' });

    expect(summarize(all, shown)).toEqual({
      shown: 1,
      total: 3,
      slow: 1,
      errors: 1,
      withFindings: 1,
    });
  });
});

describe('exception grouping', () => {
  it('identical errors from one place form one group', () => {
    const groups = groupExceptions(
      [
        request({ id: 'a', error: errorAt(61, 'cannot read undefined (id 8812)') }),
        request({ id: 'b', error: errorAt(61, 'cannot read undefined (id 4711)') }),
      ],
      stack,
    );

    // The messages differ only in values and the location is the same, so this
    // is one and the same error.
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ type: 'TypeError', count: 2 });
    expect(groups[0]?.requestIds).toEqual(['a', 'b']);
  });

  it('identical errors from different places form different groups', () => {
    const groups = groupExceptions(
      [request({ id: 'a', error: errorAt(61) }), request({ id: 'b', error: errorAt(88) })],
      stack,
    );

    expect(groups).toHaveLength(2);
  });

  it('shows the origin and tells project frames apart', () => {
    const [group] = groupExceptions([request({ error: errorAt(61) })], stack);

    expect(group?.origin).toBe('services/pricing.js:61');
    expect(group?.where).toBe('GET /orders');
    expect(group?.frames.filter((frame) => frame.project)).toHaveLength(1);
    expect(group?.frames.some((frame) => frame.raw.includes('node_modules'))).toBe(true);
  });

  it('sorts by occurrence count', () => {
    const groups = groupExceptions(
      [
        request({ error: errorAt(61) }),
        request({ error: errorAt(88) }),
        request({ error: errorAt(88) }),
      ],
      stack,
    );

    expect(groups.map((group) => group.count)).toEqual([2, 1]);
  });

  it('requests without errors do not enter groups', () => {
    expect(groupExceptions([request(), request()], stack)).toEqual([]);
  });

  it('distributes occurrences into sparkline buckets', () => {
    const now = 12_000;
    const groups = groupExceptions(
      [
        request({ startedAt: 11_900, error: errorAt(61) }),
        request({ startedAt: 200, error: errorAt(61) }),
      ],
      stack,
      now,
    );

    const buckets = groups[0]?.buckets ?? [];
    expect(buckets).toHaveLength(12);
    expect(buckets.reduce((sum, value) => sum + value, 0)).toBe(2);
    expect(buckets.at(-1)).toBe(1);
  });
});
