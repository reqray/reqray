/**
 * Recorded requests to render.
 *
 * Modelled on the request the output specification is drawn around: fifteen
 * spans, an N+1 of forty-seven queries, a duplicated outbound call and a
 * duplicated cache read. Everything the renderers have to survive — a long
 * path, a long query, an exception — is here as its own record rather than as
 * a mutation of this one.
 */

import type {
  CacheSpan,
  DbSpan,
  Finding,
  HttpSpan,
  RecordedBody,
  RecordedRequest,
  RequestDetail,
  RequestTiming,
  RequestWeight,
  Span,
} from '@reqray/protocol';

/** A fixed moment, so the clock in a snapshot never moves. */
export const AT = new Date(2026, 7, 20, 9, 41, 2, 184).getTime();

let nextId = 1;

const span = (over: Partial<Span> & Pick<Span, 'kind'>): Span =>
  ({
    id: nextId++,
    parentId: null,
    startedAt: 0,
    duration: 1,
    // Replaced once the whole scenario is assembled: a span with children
    // did not spend its whole duration in its own code.
    selfMs: over.duration ?? 1,
    callsite: null,
    error: null,
    ...over,
  }) as Span;

/**
 * Self time and the request's breakdown, worked out here rather than imported.
 *
 * The terminal client does not depend on `@reqray/core` and neither do its
 * fixtures. What that costs is this: twenty lines of interval arithmetic kept
 * in step with the core's. What it proves, incidentally, is that the wire
 * types carry enough for any client to arrive at the same numbers.
 */
interface Interval {
  start: number;
  end: number;
}

const spanOf = (entry: Span): Interval => ({
  start: entry.startedAt,
  end: entry.startedAt + entry.duration,
});

function covered(intervals: readonly Interval[], within?: Interval): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = -Infinity;
  for (const interval of sorted) {
    const start = Math.max(interval.start, cursor, within?.start ?? -Infinity);
    const end = Math.min(interval.end, within?.end ?? Infinity);
    if (end > start) total += end - start;
    cursor = Math.max(cursor, interval.end);
  }
  return total;
}

function withSelfTimes(spans: readonly Span[]): Span[] {
  return spans.map((entry) => {
    const children = spans.filter((other) => other.parentId === entry.id).map(spanOf);
    return { ...entry, selfMs: Math.max(0, entry.duration - covered(children, spanOf(entry))) };
  });
}

/** What the request moved, as a client can work it out from the wire types. */
function weightFor(
  base: { responseHeaders: Record<string, string>; responseBody: RecordedBody | null },
  spans: readonly Span[],
): RequestWeight {
  const declared = Number(base.responseHeaders['content-length']);
  let rows = 0;
  let biggestRows = 0;
  for (const entry of spans) {
    if (entry.kind !== 'db' || entry.rowCount === null) continue;
    rows += entry.rowCount;
    if (entry.rowCount > biggestRows) biggestRows = entry.rowCount;
  }
  return {
    bytesIn: null,
    bytesOut: Number.isFinite(declared) ? declared : (base.responseBody?.bytes ?? null),
    rows,
    biggestRows,
  };
}

function timingFor(spans: readonly Span[], durationMs: number): RequestTiming {
  const work = spans.filter((entry) => entry.kind !== 'handler' && entry.kind !== 'middleware');
  const ofKind = (kind: Span['kind']) =>
    covered(work.filter((entry) => entry.kind === kind).map(spanOf));
  return {
    sqlMs: ofKind('db'),
    externalMs: ofKind('http'),
    cacheMs: ofKind('cache'),
    selfMs: Math.max(0, durationMs - covered(work.map(spanOf))),
    parallel: false,
  };
}

const middleware = (label: string, startedAt: number, duration: number): Span =>
  span({ kind: 'middleware', label, startedAt, duration });

const sql = (text: string, startedAt: number, duration: number, over: Partial<DbSpan> = {}): Span =>
  span({
    kind: 'db',
    sql: text,
    fingerprint: text.replace(/\d+/g, '?'),
    rowCount: null,
    source: 'pg',
    clientId: null,
    connectionId: null,
    waitMs: null,
    values: null,
    parentId: 5,
    startedAt,
    duration,
    ...over,
  } as Partial<Span> & Pick<Span, 'kind'>);

const call = (url: string, startedAt: number, duration: number): Span =>
  span({
    kind: 'http',
    method: 'GET',
    url,
    statusCode: 200,
    parentId: 5,
    startedAt,
    duration,
  } as Partial<HttpSpan> & Pick<HttpSpan, 'kind'>);

const cache = (key: string, startedAt: number, duration: number): Span =>
  span({
    kind: 'cache',
    operation: 'get',
    command: 'GET',
    key,
    hit: true,
    parentId: 5,
    startedAt,
    duration,
  } as Partial<CacheSpan> & Pick<CacheSpan, 'kind'>);

const callsite = (relative: string, line: number) => ({
  file: `/srv/app/${relative}`,
  relative,
  line,
  column: 9,
});

/** Fills in the row half of a detail from the record half. */
export function detailOf(record: RecordedRequest, route = record.path): RequestDetail {
  let sqlCount = 0;
  let httpCount = 0;
  for (const entry of record.spans) {
    if (entry.kind === 'db') sqlCount++;
    else if (entry.kind === 'http') httpCount++;
  }

  return {
    ...record,
    route,
    sqlCount,
    httpCount,
    nPlusOne: record.findings.some((finding) => finding.detector === 'n_plus_one'),
    findingCount: record.findings.length,
    flag: [...record.findings].sort((a, b) => b.costMs - a.costMs)[0]?.detector ?? null,
    hasError: record.error !== null || record.status >= 500,
    cpuMs: record.cost?.cpuMs ?? null,
    cpuShare: record.cost?.cpuShare ?? null,
    pinned: false,
  };
}

function record(over: Partial<RecordedRequest> = {}): RecordedRequest {
  const base = {
    id: '8974',
    method: 'GET',
    path: '/api/orders',
    query: null,
    status: 200,
    durationMs: 275.3,
    startedAt: AT,
    spans: [],
    findings: [],
    requestHeaders: { host: 'localhost:3000', accept: 'application/json' },
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
  const spans = withSelfTimes(base.spans);
  return {
    ...base,
    spans,
    timing: timingFor(spans, base.durationMs),
    host: base.host ?? null,
    weight: weightFor(base, spans),
    cost: null,
  };
}

/** The request the specification is drawn around. */
export function ordersWithNPlusOne(): RequestDetail {
  nextId = 1;
  const before: Span[] = [
    middleware('cors', 0, 0.4),
    middleware('helmet', 0.4, 0.3),
    middleware('auth.verifyJwt', 0.7, 5.4),
    middleware('body-parser.json', 6.1, 0.7),
  ];
  const handler = span({ kind: 'handler', label: 'orders.list', startedAt: 6.8, duration: 268.5 });
  const head: Span[] = [
    cache('user:8812:permissions', 6.8, 0.3),
    cache('feature-flags:checkout-v3', 7.1, 0.2),
    sql('SELECT * FROM users WHERE id = $1', 7.3, 2.1, {
      callsite: callsite('services/orders.js', 96),
    }),
    sql('SELECT id, reference, status FROM orders ORDER BY created_at DESC LIMIT 25', 9.4, 8.6, {
      rowCount: 25,
      callsite: callsite('services/orders.js', 96),
    }),
  ];

  // Forty-seven of them, one after another — a loop, not a fan-out.
  const loop: Span[] = [];
  for (let index = 0; index < 47; index++) {
    loop.push(
      sql('SELECT * FROM line_items WHERE order_id = $1', 18 + index * 0.876, 0.876, {
        rowCount: 3,
        callsite: callsite('services/orders.js', 118),
      }),
    );
  }
  const loopIds = loop.map((entry) => entry.id);

  const tail: Span[] = [
    call('https://api.stripe.com/v1/charges?customer=cus_QxT1', 59.2, 118),
    cache('feature-flags:checkout-v3', 177.2, 0.2),
    call('https://api.stripe.com/v1/charges?customer=cus_QxT1', 177.4, 96),
    cache('orders:8812:page1', 273.4, 0.5),
  ];
  const after = middleware('serialize + gzip', 273.9, 1.4);

  const findings: Finding[] = [
    {
      detector: 'n_plus_one',
      severity: 'critical',
      title: '47 identical queries in a loop',
      costMs: 41.2,
      callsite: callsite('services/orders.js', 118),
      evidence: {
        kind: 'n_plus_one',
        repeats: 47,
        fingerprint: 'SELECT * FROM line_items WHERE order_id = ?',
        sample: 'SELECT * FROM line_items WHERE order_id = $1',
        totalMs: 41.2,
        spanIds: loopIds,
      },
      hint: 'eager-load line_items with a single IN (…) query',
    },
    {
      detector: 'dup_http',
      severity: 'warn',
      title: '2 identical outbound calls',
      costMs: 96,
      callsite: callsite('clients/stripe.js', 40),
      evidence: {
        kind: 'duplicate',
        repeats: 2,
        fingerprint: 'GET api.stripe.com/v1/charges',
        sample: 'GET https://api.stripe.com/v1/charges?customer=cus_QxT1',
        totalMs: 214,
        spanIds: [tail[0]?.id ?? 0, tail[2]?.id ?? 0],
      },
      hint: 'memoize within the request scope',
    },
    {
      detector: 'dup_cache',
      severity: 'info',
      title: '2 identical cache reads for one key',
      costMs: 0.4,
      callsite: callsite('middleware/flags.js', 14),
      evidence: {
        kind: 'duplicate',
        repeats: 2,
        fingerprint: 'GET feature-flags:checkout-v3',
        sample: 'cache.get feature-flags:checkout-v3',
        totalMs: 0.4,
        spanIds: [head[1]?.id ?? 0, tail[1]?.id ?? 0],
      },
      hint: 'read it once and pass it down',
    },
  ];

  return detailOf(
    record({
      spans: [...before, handler, ...head, ...loop, ...tail, after],
      findings,
      test: 'orders.spec.ts:42 › lists orders',
      responseHeaders: {
        'content-type': 'application/json',
        'content-length': '4198',
        etag: 'W/"105b-7Yl1dK+8"',
        'server-timing': 'db;dur=52.1, cache;dur=0.8, ext;dur=214.0',
      },
      responseBody: {
        text: JSON.stringify({
          data: [{ id: 8812, reference: 'ORD-2026-8812', total_cents: 12_900, currency: 'EUR' }],
          meta: { page: 1, per_page: 25, total: 213 },
        }),
        truncated: false,
        // What the header says: the record and the wire agree in the demo.
        bytes: 4_198,
      },
    }),
  );
}

/** A request the detectors had nothing to say about. */
export function quietRequest(): RequestDetail {
  nextId = 1;
  return detailOf(
    record({
      id: '8975',
      path: '/api/users/me',
      durationMs: 12.4,
      spans: [
        middleware('cors', 0, 0.2),
        span({ kind: 'handler', label: 'users.me', startedAt: 0.2, duration: 12 }),
        sql('SELECT * FROM users WHERE id = $1', 0.4, 2.1, {
          parentId: 2,
          rowCount: 1,
          callsite: callsite('services/users.js', 22),
        }),
        { ...(cache('session:8812', 2.6, 0.3) as CacheSpan), parentId: 2 },
      ],
      responseHeaders: { 'content-type': 'application/json', 'content-length': '182' },
      responseBody: { text: '{"id":8812,"email":"ada@example.com"}', truncated: false, bytes: 37 },
    }),
  );
}

/** A request that threw. The stream prints a second line for this one. */
export function failedRequest(): RequestDetail {
  nextId = 1;
  return detailOf(
    record({
      id: '9012',
      method: 'POST',
      path: '/api/orders',
      status: 500,
      durationMs: 2140,
      spans: [
        span({ kind: 'handler', label: 'orders.create', startedAt: 0, duration: 2139 }),
        sql('INSERT INTO orders (user_id, total_cents) VALUES ($1, $2)', 1, 12, { parentId: 1 }),
      ],
      error: {
        name: 'TypeError',
        message: "Cannot read properties of undefined (reading 'currency')",
        stack: [
          "TypeError: Cannot read properties of undefined (reading 'currency')",
          '    at priceOf (/srv/app/services/pricing.js:61:14)',
          '    at async createOrder (/srv/app/services/orders.js:141:18)',
        ].join('\n'),
      },
      responseHeaders: { 'content-type': 'application/json' },
    }),
  );
}

/** 114 characters of path, plus a query string. */
export function longPathRequest(): RequestDetail {
  nextId = 1;
  return detailOf(
    record({
      id: '9101',
      path: '/api/v2/organizations/8f2c14/workspaces/3391/projects/checkout-service/deployments/latest/logs',
      query: 'tail=200&level=warn',
      durationMs: 318,
      spans: [span({ kind: 'handler', label: 'logs.tail', startedAt: 0, duration: 317 })],
    }),
    '/api/v2/organizations/:id/workspaces/:id/projects/checkout-service/deployments/latest/logs',
  );
}

/** One query too long to print on a line, and one that is an N+1. */
export function longSqlRequest(): RequestDetail {
  nextId = 1;
  const wide = [
    'SELECT o.id, o.reference, o.status, o.total_cents, o.currency, o.created_at,',
    'u.email, u.display_name, a.line1, a.city, a.country_code, COUNT(li.id) AS item_count',
    'FROM orders o INNER JOIN users u ON u.id = o.user_id',
    'LEFT JOIN addresses a ON a.id = o.address_id',
    'LEFT JOIN line_items li ON li.order_id = o.id',
    'WHERE o.status IN (1, 2, 3) AND o.created_at > $1',
    'GROUP BY o.id, u.email, u.display_name, a.line1, a.city, a.country_code',
    'ORDER BY o.created_at DESC LIMIT 25',
  ].join(' ');

  const first = sql(wide, 1, 8.6, {
    parentId: 1,
    rowCount: 25,
    callsite: callsite('services/orders.js', 96),
  });
  const loop: Span[] = [];
  for (let index = 0; index < 47; index++) {
    loop.push(
      sql('SELECT * FROM line_items WHERE order_id = $1', 12 + index * 0.876, 0.876, {
        parentId: 1,
        callsite: callsite('services/orders.js', 118),
      }),
    );
  }

  return detailOf(
    record({
      id: '9102',
      durationMs: 62,
      spans: [
        span({ kind: 'handler', label: 'orders.list', startedAt: 0, duration: 61 }),
        first,
        ...loop,
      ],
      findings: [
        {
          detector: 'n_plus_one',
          severity: 'critical',
          title: '47 identical queries in a loop',
          costMs: 41.2,
          callsite: callsite('services/orders.js', 118),
          evidence: {
            kind: 'n_plus_one',
            repeats: 47,
            fingerprint: 'SELECT * FROM line_items WHERE order_id = ?',
            sample: 'SELECT * FROM line_items WHERE order_id = $1',
            totalMs: 41.2,
            spanIds: loop.map((entry) => entry.id),
          },
          hint: 'eager-load line_items with a single IN (…) query',
        },
      ],
    }),
  );
}

/** An export nobody paginated: one fast query, megabytes back. */
export function heavyExport(): RequestDetail {
  nextId = 1;
  const handler = span({ kind: 'handler', label: 'export.prices', startedAt: 0, duration: 88 });
  const query = sql(
    "SELECT p.id, p.title, p.price, d::date AS day FROM products p CROSS JOIN generate_series(now() - interval '120 days', now(), interval '1 day') AS d ORDER BY p.id, d",
    1,
    49,
    { rowCount: 48_400, callsite: callsite('src/shop.js', 213), parentId: handler.id },
  );

  return detailOf(
    record({
      id: '9101',
      path: '/api/export',
      durationMs: 88,
      spans: [handler, query],
      findings: [
        {
          detector: 'heavy_response',
          severity: 'warn',
          title: '3.8 MB response from 48,400 rows',
          // Bytes, not milliseconds: the seconds it spends reaching a phone
          // are not something the collector measured.
          costMs: 0,
          callsite: callsite('src/shop.js', 213),
          evidence: {
            kind: 'heavy_response',
            bytes: 4_003_174,
            rows: 48_400,
            sample: 'SELECT p.id, p.title, p.price, d::date AS day FROM products p CROSS JOIN …',
            contentType: 'application/json',
            spanIds: [query.id],
          },
          hint: 'Paginate it, or return only the fields the caller uses.',
        },
      ],
      responseHeaders: { 'content-type': 'application/json', 'content-length': '4003174' },
    }),
  );
}
