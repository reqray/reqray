import {
  multiTransport,
  type RecordedRequest,
  resolveOptions,
  setLogSink,
  timingOf,
  weightOf,
} from '@reqray/core';
import {
  decodeCursor,
  encodeCursor,
  filterRequests,
  groupExceptions,
  isAfterCursor,
  panelSourceFor,
  summarize,
} from '@reqray/core/panel';
import { resetWarnings } from '@reqray/core/testing';
import { describe, expect, it } from 'vitest';

const stack = resolveOptions({ stack: { projectRoot: '/srv/app' } }).stack;

function request(overrides: Partial<RecordedRequest> = {}): RecordedRequest {
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
    host: base.host ?? null,
    weight: weightOf(base),
    cost: null,
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

  it('"only what failed" is wider than the 5xx class', () => {
    // A handler that threw and still answered 200 is the failure worth
    // finding; a status filter would never show it.
    const threw = request({ id: 'd', status: 200, error: errorAt(61) });
    const withThrow = [...all, threw];

    expect(filterRequests(withThrow, { onlyErrors: true }).map((r) => r.id)).toEqual(['b', 'd']);
    expect(filterRequests(withThrow, { statusClasses: [5] }).map((r) => r.id)).toEqual(['b']);
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

describe('list cursors', () => {
  it('round-trip a position back', () => {
    expect(decodeCursor(encodeCursor(1_734_000_000_000, 'a3f'))).toEqual({
      key: 1_734_000_000_000,
      id: 'a3f',
    });
  });

  it('survive a fractional key, which a duration is', () => {
    // Split at the last dot, not the first: `12.5.a3f` is one key and one id.
    expect(decodeCursor(encodeCursor(12.5, 'a3f'))).toEqual({ key: 12.5, id: 'a3f' });
  });

  it('read anything unparseable as "start from the beginning"', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('nonsense')).toBeNull();
    expect(decodeCursor('.a3f')).toBeNull();
    expect(decodeCursor('1700.')).toBeNull();
  });

  it('continue strictly past the position, with the id breaking a tie', () => {
    const cursor = { key: 100, id: 'r5' };

    expect(isAfterCursor(cursor, 99, 'r9')).toBe(true);
    expect(isAfterCursor(cursor, 101, 'r1')).toBe(false);
    // Same key: the row that is already on the previous page is not served
    // again, and the one below it is.
    expect(isAfterCursor(cursor, 100, 'r5')).toBe(false);
    expect(isAfterCursor(cursor, 100, 'r4')).toBe(true);
    expect(isAfterCursor(cursor, 100, 'r6')).toBe(false);
  });
});

describe('finding the store the panel reads', () => {
  const store = {
    name: 'memory',
    send: () => {},
    list: () => [],
    get: () => undefined,
    clear: () => {},
    subscribe: () => () => {},
  };
  const log = { name: 'file', send: () => {} };
  const panelOn = resolveOptions({ mode: 'development' });

  it('takes a transport that is a store', () => {
    expect(panelSourceFor(store, panelOn)).toBe(store);
  });

  it('finds the store among several, in whichever order they were given', () => {
    expect(panelSourceFor(multiTransport([log, store]), panelOn)).toBe(store);
    expect(panelSourceFor(multiTransport([store, log]), panelOn)).toBe(store);
  });

  it('says so when nothing among them keeps anything', () => {
    const warnings: string[] = [];
    setLogSink({ info: () => {}, warn: (message) => warnings.push(message) });

    expect(
      panelSourceFor(multiTransport([log, { name: 'http', send: () => {} }]), panelOn),
    ).toBeNull();
    expect(warnings.join(' ')).toContain('the panel is not mounted');

    setLogSink(null);
    resetWarnings();
  });

  it('stays quiet when there is no panel to mount', () => {
    const warnings: string[] = [];
    setLogSink({ info: () => {}, warn: (message) => warnings.push(message) });

    expect(panelSourceFor(log, resolveOptions({ mode: 'development', panel: false }))).toBeNull();
    expect(warnings).toEqual([]);

    setLogSink(null);
  });
});
