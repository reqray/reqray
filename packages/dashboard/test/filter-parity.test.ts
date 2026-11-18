/**
 * The client filter, against the server's.
 *
 * The panel re-filters what arrives on the live feed, so the same words must
 * select the same rows whether one arrived live or came back from a page.
 * Driven through the chain the panel uses — chips and tokens to wire
 * parameters, wire parameters to the server's own `parseFilter`.
 *
 * The store's two implementations are held together by `store-sqlite`'s parity
 * test; this holds the third.
 */

import { filterRequests, parseFilter, type RequestFilter } from '@reqray/core/panel';
import type { RecordedRequest } from '@reqray/protocol';
import { describe, expect, it } from 'vitest';
import { type RequestRow, toSearchParams } from '../src/api/index';
import { asQuery, EMPTY_FILTER, type FilterState, matches } from '../src/shared/list/filter';
import { parseQuery } from '../src/shared/list/tokens';

function request(over: Partial<RecordedRequest> = {}): RecordedRequest {
  return {
    id: 'r1',
    method: 'GET',
    path: '/api/orders',
    query: null,
    status: 200,
    durationMs: 20,
    startedAt: 1_000,
    timing: { sqlMs: 0, externalMs: 0, cacheMs: 0, selfMs: 20, parallel: false },
    weight: { bytesIn: null, bytesOut: null, rows: 0, biggestRows: 0 },
    cost: null,
    host: null,
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
    ...over,
  };
}

/** The row the panel would hold for a record, as the server derives it. */
function rowOf(record: RecordedRequest): RequestRow {
  return {
    id: record.id,
    method: record.method,
    path: record.path,
    query: record.query,
    route: record.path.replace(/\/\d+(?=\/|$)/g, '/:id'),
    status: record.status,
    durationMs: record.durationMs,
    startedAt: record.startedAt,
    sqlCount: record.spans.filter((span) => span.kind === 'db').length,
    httpCount: record.spans.filter((span) => span.kind === 'http').length,
    nPlusOne: record.findings.some((finding) => finding.detector === 'n_plus_one'),
    findingCount: record.findings.length,
    flag: record.findings[0]?.detector ?? null,
    hasError: record.error !== null || record.status >= 500,
    cpuMs: null,
    cpuShare: null,
    pinned: false,
    test: record.test,
  };
}

/**
 * The server's filter, reached the way the panel reaches it.
 *
 * Through the server's own parser, not a second reading of the same
 * parameters: a parity test that reimplements the server proves only that two
 * guesses agree with each other.
 */
function serverFilter(filter: FilterState): RequestFilter {
  return parseFilter(new URLSearchParams(toSearchParams(asQuery(filter)).replace(/^\?/, '')));
}

const REQUESTS: readonly RecordedRequest[] = [
  request({ id: 'a', method: 'GET', path: '/api/orders', durationMs: 12 }),
  request({ id: 'b', method: 'POST', path: '/api/orders', status: 201, durationMs: 340 }),
  request({ id: 'c', method: 'GET', path: '/api/users/42', status: 404, durationMs: 8 }),
  request({ id: 'd', method: 'GET', path: '/health', status: 500, durationMs: 3 }),
  request({ id: 'e', method: 'DELETE', path: '/api/orders/7', status: 204, durationMs: 900 }),
  request({ id: 'f', method: 'GET', path: '/api/orders', query: 'page=2', durationMs: 55 }),
];

function bothSides(query: string, over: Partial<FilterState> = {}): [string[], string[]] {
  const filter: FilterState = { ...EMPTY_FILTER, ...over, query };
  const parsed = parseQuery(filter.query);

  const client = REQUESTS.filter((record) => matches(rowOf(record), filter, parsed)).map(
    (record) => record.id,
  );
  const server = filterRequests(REQUESTS, serverFilter(filter)).map((record) => record.id);
  return [client, server];
}

describe('the client filter selects what the server would', () => {
  const cases: Array<[name: string, query: string, over?: Partial<FilterState>]> = [
    ['nothing at all', ''],
    ['free text on a path', 'orders'],
    ['free text on a method', 'delete'],
    ['free text on a status', '404'],
    ['free text on a query string', 'page=2'],
    // A needle spanning two fields must not match: the server searches each
    // field on its own.
    ['free text across two fields', 'GET /api'],
    ['a method token', 'method:post'],
    ['a status class', 'status:5xx'],
    ['an exact status', 'status:404'],
    ['a path token', 'path:/api/orders'],
    ['a duration token', '>100ms'],
    ['errors only', 'has:error'],
    ['two tokens together', 'method:get status:404'],
    ['a token and free text', 'method:get orders'],
    ['a method chip', '', { methods: ['GET'] }],
    ['a status chip', '', { statusClasses: [4] }],
    ['a chip and a token', 'path:/api', { methods: ['GET'] }],
    ['a slow chip', '', { duration: 'slow100' }],
  ];

  for (const [name, query, over] of cases) {
    it(name, () => {
      const [client, server] = bothSides(query, over);
      expect(client).toEqual(server);
    });
  }

  it('a route chip ignores the case of its method', () => {
    // The chip is built from a row, so its method is already upper case — but
    // the server upper-cases both sides and the client did not, which is a
    // difference waiting for the first caller that does not.
    const [client, server] = bothSides('', {
      route: { method: 'get', route: '/api/orders' },
    });
    expect(client).toEqual(server);
  });
});
