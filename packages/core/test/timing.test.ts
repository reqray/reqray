import {
  anyOverlap,
  coveredMs,
  ensureTiming,
  mergeIntervals,
  type RecordedRequest,
  type Span,
  selfTimes,
  timingOf,
} from '@reqray/core';
import { describe, expect, it } from 'vitest';

let nextId = 1;

function span(over: Partial<Span> & Pick<Span, 'kind'>): Span {
  return {
    id: nextId++,
    parentId: null,
    startedAt: 0,
    duration: 1,
    selfMs: 0,
    callsite: null,
    error: null,
    ...over,
  } as Span;
}

const db = (startedAt: number, duration: number, parentId: number | null = null): Span =>
  span({
    kind: 'db',
    sql: 'SELECT 1',
    fingerprint: 'SELECT ?',
    rowCount: 1,
    source: 'pg',
    clientId: null,
    connectionId: null,
    waitMs: null,
    values: null,
    startedAt,
    duration,
    parentId,
  });

const http = (startedAt: number, duration: number, parentId: number | null = null): Span =>
  span({
    kind: 'http',
    method: 'GET',
    url: 'https://api.example.com/v1/charges',
    statusCode: 200,
    startedAt,
    duration,
    parentId,
  });

describe('interval arithmetic', () => {
  it('merges stretches that touch or overlap', () => {
    expect(
      mergeIntervals([
        { start: 10, end: 20 },
        { start: 15, end: 25 },
        { start: 40, end: 50 },
      ]),
    ).toEqual([
      { start: 10, end: 25 },
      { start: 40, end: 50 },
    ]);
  });

  it('counts overlapping stretches once', () => {
    // Four 100 ms queries fired together took 100 ms of the request, not 400.
    const parallel = [0, 1, 2, 3].map((offset) => ({ start: offset, end: 100 + offset }));
    expect(coveredMs(parallel)).toBe(103);
  });

  it('does not call a sequence an overlap', () => {
    // One query ending exactly where the next begins is a loop, not a
    // fan-out — the distinction the N+1 detector is built on.
    expect(
      anyOverlap([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ]),
    ).toBe(false);
    expect(
      anyOverlap([
        { start: 0, end: 10 },
        { start: 9.9, end: 20 },
      ]),
    ).toBe(true);
  });
});

describe('self time', () => {
  it('leaves a leaf span with its whole duration', () => {
    nextId = 1;
    const query = db(0, 5);
    expect(selfTimes([query]).get(query.id)).toBe(5);
  });

  it('takes the children out of a container', () => {
    nextId = 1;
    const handler = span({ kind: 'handler', label: 'orders.list', startedAt: 0, duration: 100 });
    const spans = [handler, db(10, 30, handler.id), http(50, 40, handler.id)];
    // 100 ms of handler, 70 ms of it waiting on somebody else.
    expect(selfTimes(spans).get(handler.id)).toBe(30);
  });

  it('counts children that ran concurrently once', () => {
    nextId = 1;
    const handler = span({ kind: 'handler', label: 'orders.list', startedAt: 0, duration: 100 });
    // Promise.all: four 40 ms queries starting together.
    const spans = [handler, ...[0, 0, 0, 0].map(() => db(10, 40, handler.id))];
    // Naive subtraction gives 100 - 160 = -60, which is where a waterfall
    // starts showing negative time and a reader stops trusting it.
    expect(selfTimes(spans).get(handler.id)).toBe(60);
  });

  it('counts only the part of a child that falls inside its parent', () => {
    nextId = 1;
    const handler = span({ kind: 'handler', label: 'orders.list', startedAt: 0, duration: 50 });
    // A query closed after the response was written — clock skew, or a span
    // finished late. It cannot make the handler's own time negative.
    const spans = [handler, db(40, 30, handler.id)];
    expect(selfTimes(spans).get(handler.id)).toBe(40);
  });

  it('ignores a child whose parent was dropped by the span limit', () => {
    nextId = 1;
    const orphan = db(0, 5, 999);
    expect(selfTimes([orphan]).get(orphan.id)).toBe(5);
  });
});

describe('where the request time went', () => {
  it('splits it by layer', () => {
    nextId = 1;
    const spans = [
      span({ kind: 'handler', label: 'orders.list', startedAt: 0, duration: 190 }),
      db(10, 40),
      http(60, 100),
      span({
        kind: 'cache',
        operation: 'get',
        command: 'GET',
        key: 'user:1',
        hit: true,
        startedAt: 5,
        duration: 2,
      }),
    ];
    const timing = timingOf(spans, 200);

    expect(timing.sqlMs).toBe(40);
    expect(timing.externalMs).toBe(100);
    expect(timing.cacheMs).toBe(2);
    // 200 ms, of which 142 was spent waiting on something instrumented.
    expect(timing.selfMs).toBe(58);
    expect(timing.parallel).toBe(false);
  });

  it('says so when the layers overlapped, instead of an addition that does not add up', () => {
    nextId = 1;
    const spans = [db(0, 100), http(0, 100)];
    const timing = timingOf(spans, 120);

    expect(timing.sqlMs).toBe(100);
    expect(timing.externalMs).toBe(100);
    // Not 120 - 200. The two ran at once and cost the request 100 ms.
    expect(timing.selfMs).toBe(20);
    expect(timing.parallel).toBe(true);
  });

  it('never reports negative time in the application', () => {
    nextId = 1;
    // A query that finished a hair after the response was written.
    expect(timingOf([db(0, 12)], 10).selfMs).toBe(0);
  });

  it('does not count containers as work', () => {
    nextId = 1;
    const spans = [
      span({ kind: 'middleware', label: 'cors', startedAt: 0, duration: 90 }),
      span({ kind: 'handler', label: 'orders.list', startedAt: 0, duration: 90 }),
    ];
    // A handler holds time; it does not spend it. Otherwise every request
    // would read as fully instrumented and "your code" would always be zero.
    expect(timingOf(spans, 100).selfMs).toBe(100);
  });
});

describe('records written before timing existed', () => {
  const legacy = {
    id: 'r1',
    method: 'GET',
    path: '/api/orders',
    query: null,
    status: 200,
    durationMs: 100,
    startedAt: 1_000,
    spans: [] as Span[],
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
  };

  it('fills in the timing and the spans a store on disk never had', () => {
    nextId = 1;
    const handler = span({ kind: 'handler', label: 'orders.list', startedAt: 0, duration: 90 });
    const filled = ensureTiming({
      ...legacy,
      spans: [handler, db(10, 30, handler.id)],
    } as unknown as RecordedRequest);

    expect(filled.timing.sqlMs).toBe(30);
    expect(filled.timing.selfMs).toBe(70);
    expect(filled.spans[0]?.selfMs).toBe(60);
  });

  it('leaves a record that already has everything alone', () => {
    const timed = {
      ...legacy,
      timing: timingOf([], 100),
      weight: { bytesIn: null, bytesOut: null, rows: 0, biggestRows: 0 },
      cost: null,
    } as unknown as RecordedRequest;
    expect(ensureTiming(timed)).toBe(timed);
  });

  it('fills in the cost a record predating it does not have', () => {
    // `null` is what "nothing was reading the processor clock" looks like;
    // a zero would put a week-old request among the genuinely cheap ones.
    const older = {
      ...legacy,
      timing: timingOf([], 100),
      weight: { bytesIn: null, bytesOut: null, rows: 0, biggestRows: 0 },
    } as unknown as RecordedRequest;

    expect(ensureTiming(older).cost).toBeNull();
  });

  it('works out what the request moved, which the stored record still knows', () => {
    nextId = 1;
    const query = db(0, 5);
    const filled = ensureTiming({
      ...legacy,
      spans: [{ ...query, rowCount: 150_000 } as Span],
      responseHeaders: { 'content-length': '12582912' },
    } as unknown as RecordedRequest);

    expect(filled.weight).toEqual({
      bytesIn: null,
      bytesOut: 12_582_912,
      rows: 150_000,
      biggestRows: 150_000,
    });
  });
});
