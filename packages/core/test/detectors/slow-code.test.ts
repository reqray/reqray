/**
 * Slow-code detector.
 *
 * The "does not find it" group carries the whole design here. Every other
 * detector reasons from something it watched happen; this one reasons from an
 * absence, and an absence has a second explanation — I/O Reqray has no
 * instrumentation for — that is not the application's fault and must never be
 * reported as if it were. Most of the tests below exist to hold that line.
 */

import { slowCode } from '@reqray/core';
import { describe, expect, it } from 'vitest';
import { scenario } from '../fixtures/spans.js';

const options = slowCode.defaultOptions;

/** A finished request of `durationMs`, with nothing notable about the response. */
const after = (durationMs: number, bytesOut: number | null = null) => ({
  durationMs,
  status: 200,
  bytesOut,
  contentType: bytesOut === null ? null : 'application/json',
});

/**
 * The canonical shape: four quick queries around one long hole.
 *
 * 600 ms of request, 200 ms of it queries, 400 ms of it nothing at all — the
 * request whose waterfall is mostly empty space.
 */
function holeBetweenQueries() {
  return scenario()
    .query({
      sql: 'SELECT * FROM orders WHERE id = $1',
      duration: 50,
      callsite: 'src/orders.ts:12',
    })
    .query({ sql: 'SELECT * FROM users WHERE id = $1', duration: 50, callsite: 'src/orders.ts:18' })
    .pause(400)
    .query({
      sql: 'SELECT * FROM items WHERE order_id = $1',
      duration: 50,
      callsite: 'src/total.ts:47',
    })
    .query({ sql: 'SELECT * FROM taxes', duration: 50, callsite: 'src/total.ts:51' })
    .done();
}

describe('slow_code — finds it', () => {
  it('reports the stretch nothing accounts for', () => {
    const [finding] = slowCode.run(holeBetweenQueries(), options, after(600));

    expect(finding?.detector).toBe('slow_code');
    expect(finding?.severity).toBe('warn');
    expect(finding?.costMs).toBeCloseTo(400, 5);
    expect(finding?.evidence).toMatchObject({ kind: 'slow_code', stretchMs: 400 });
  });

  it('points at the code that runs into the far end of the stretch', () => {
    // The hole is the code that led up to the next call, so the address is
    // the bottom of it — not the query that happened to finish before it.
    const [finding] = slowCode.run(holeBetweenQueries(), options, after(600));

    expect(finding?.callsite?.relative).toBe('src/total.ts');
    expect(finding?.callsite?.line).toBe(47);
  });

  it('brackets the stretch with what ran on either side of it', () => {
    const [finding] = slowCode.run(holeBetweenQueries(), options, after(600));

    expect(finding?.evidence).toMatchObject({
      before: 'SELECT * FROM users WHERE id = $1',
      after: 'SELECT * FROM items WHERE order_id = $1',
    });
  });

  it('names the innermost handler the stretch sits inside', () => {
    const scope = scenario()
      .container({ label: 'GET /api/orders', from: 0, to: 600 })
      .container({ label: 'renderTotals', from: 90, to: 520, kind: 'middleware' })
      .query({ sql: 'SELECT 1', duration: 50 })
      .query({ sql: 'SELECT 2', duration: 50 })
      .pause(400)
      .query({ sql: 'SELECT 3', duration: 50 })
      .query({ sql: 'SELECT 4', duration: 50 })
      .done();

    const [finding] = slowCode.run(scope, options, after(600));

    // The request-wide handler contains it too, and saying so would be saying
    // the time was spent inside the request.
    expect(finding?.evidence).toMatchObject({ label: 'renderTotals' });
    expect(finding?.title).toContain('renderTotals');
  });

  it('reports a stretch that opens the request, before any I/O', () => {
    const scope = scenario()
      .pause(300)
      .query({ sql: 'SELECT 1', duration: 30, callsite: 'src/a.ts:5' })
      .query({ sql: 'SELECT 2', duration: 30 })
      .query({ sql: 'SELECT 3', duration: 30 })
      .done();

    const [finding] = slowCode.run(scope, options, after(390));

    expect(finding?.evidence).toMatchObject({ before: null, atMs: 0, stretchMs: 300 });
    expect(finding?.callsite?.relative).toBe('src/a.ts');
    expect(finding?.callsite?.line).toBe(5);
  });

  it('reports a stretch that ends the request', () => {
    const scope = scenario()
      .query({ sql: 'SELECT 1', duration: 30, callsite: 'src/a.ts:5' })
      .query({ sql: 'SELECT 2', duration: 30 })
      .query({ sql: 'SELECT 3', duration: 30 })
      .done();

    const [finding] = slowCode.run(scope, options, after(500));

    expect(finding?.evidence).toMatchObject({ after: null, stretchMs: 410 });
  });

  it('fires exactly at the threshold and not a millisecond under it', () => {
    const at = (stretchMs: number) => {
      const scope = scenario()
        .query({ sql: 'SELECT 1', duration: 40 })
        .query({ sql: 'SELECT 2', duration: 40 })
        .pause(stretchMs)
        .query({ sql: 'SELECT 3', duration: 40 })
        .done();
      return slowCode.run(scope, options, after(120 + stretchMs));
    };

    expect(at(options.minMs)).toHaveLength(1);
    expect(at(options.minMs - 1)).toHaveLength(0);
  });

  it('reports one query followed by a long wait on something that is not the database', () => {
    // The demo's own `/api/report`: a report whose query is quick and whose
    // heavy part is everything after it. The plainest shape there is, and the
    // one a request-level budget can only describe as a percentage.
    const scope = scenario()
      .query({ sql: 'SELECT user_id, sum(price) FROM orders GROUP BY 1', duration: 20 })
      .pause(850)
      .done();

    const [finding] = slowCode.run(scope, options, after(900));

    // The hole runs to the end of the request, not merely to the end of
    // the wait: nothing was recorded after it either.
    expect(finding?.evidence).toMatchObject({ stretchMs: 880, after: null });
    expect(finding?.costMs).toBeCloseTo(880, 5);
  });

  it('blames serializing the response when the stretch ends a heavy request', () => {
    const scope = scenario()
      .query({ sql: 'SELECT 1', duration: 30 })
      .query({ sql: 'SELECT 2', duration: 30 })
      .query({ sql: 'SELECT 3', duration: 30 })
      .done();

    const [finding] = slowCode.run(scope, options, after(500, 4 * 1024 * 1024));

    expect(finding?.hint).toContain('serializing');
  });
});

describe('slow_code — does not find it', () => {
  it('says nothing about a stretch too short to act on', () => {
    const scope = scenario()
      .query({ sql: 'SELECT 1', duration: 40 })
      .query({ sql: 'SELECT 2', duration: 40 })
      .pause(60)
      .query({ sql: 'SELECT 3', duration: 40 })
      .done();

    expect(slowCode.run(scope, options, after(180))).toEqual([]);
  });

  it('says nothing when the stretch is a small part of a long request', () => {
    // 150 ms of silence is long in itself and irrelevant inside three
    // seconds of queries: something else is the story of this request.
    const scope = scenario()
      .loop(30, (i) => ({ sql: `SELECT ${i} FROM orders`, duration: 95 }))
      .pause(150)
      .query({ sql: 'SELECT 1', duration: 10 })
      .done();

    expect(slowCode.run(scope, options, after(3010))).toEqual([]);
  });

  it('says nothing about a request it recorded no work in at all', () => {
    // A hole in the record and no record at all are different things, and
    // only the first is about the code. An application Reqray never
    // instrumented must not be told on every request that its own code
    // is slow.
    const scope = scenario().container({ label: 'GET /api/orders', from: 0, to: 900 }).done();

    expect(slowCode.run(scope, options, after(900))).toEqual([]);
  });

  it('says nothing when the silence is spread across the whole request', () => {
    // What a process Reqray cannot see looks like: a hole for every call it
    // has no instrumentation for. The largest of them is not a slow
    // function — it is one unsupported driver call among several, and
    // picking it would blame the application for Reqray's own blind spot.
    const scope = scenario()
      .query({ sql: 'SELECT 1', duration: 40 })
      .pause(90)
      .query({ sql: 'SELECT 2', duration: 40 })
      .pause(90)
      .query({ sql: 'SELECT 3', duration: 40 })
      .pause(90)
      .query({ sql: 'SELECT 4', duration: 40 })
      .pause(90)
      .query({ sql: 'SELECT 5', duration: 40 })
      .pause(400)
      .done();

    const [finding] = slowCode.run(scope, options, after(960));

    expect(finding).toBeUndefined();
  });

  it('does not call queueing for a connection an unaccounted stretch', () => {
    // The one idle-looking stretch of a request that is fully explained, and
    // the pool-wait detector is already the place it gets explained.
    // The wait runs from the start of the request up to the moment the query
    // gets its connection, so the query itself starts 300 ms in.
    const scope = scenario()
      .query({ sql: 'SELECT 1', duration: 5, waitMs: 300, at: 300 })
      .query({ sql: 'SELECT 2', duration: 5, at: 305 })
      .query({ sql: 'SELECT 3', duration: 5, at: 310 })
      .done();

    expect(slowCode.run(scope, options, after(315))).toEqual([]);
  });

  it('does not add scattered pauses up into a stretch that never happened', () => {
    // Eight 60 ms pauses are 480 ms of silence and no single place to look.
    // Summing them would produce a number that looks like a defect and
    // points at nothing.
    const scope = scenario()
      .loop(8, (i) => ({ sql: `SELECT ${i}`, duration: 20 }))
      .done();
    const spread = scenario();
    for (let i = 0; i < 8; i++) spread.query({ sql: `SELECT ${i}`, duration: 20 }).pause(60);

    expect(slowCode.run(spread.done(), options, after(640))).toEqual([]);
    expect(slowCode.run(scope, options, after(160))).toEqual([]);
  });

  it('says nothing about a request whose time is fully accounted for', () => {
    const scope = scenario()
      .loop(10, (i) => ({ sql: `SELECT ${i} FROM orders`, duration: 50 }))
      .done();

    expect(slowCode.run(scope, options, after(500))).toEqual([]);
  });

  it('says nothing about a request with no duration to divide by', () => {
    const scope = scenario()
      .query({ sql: 'SELECT 1', duration: 0 })
      .query({ sql: 'SELECT 2', duration: 0 })
      .query({ sql: 'SELECT 3', duration: 0 })
      .done();

    expect(slowCode.run(scope, options, after(0))).toEqual([]);
  });
});

describe('slow_code — what it claims', () => {
  it('hedges at the edges of a request, where anything could be happening', () => {
    // A trailing stretch shares its ground with serializing and writing the
    // response — work Reqray never watched — so the claim stays open.
    const scope = scenario()
      .query({ sql: 'SELECT 1', duration: 40 })
      .query({ sql: 'SELECT 2', duration: 40 })
      .query({ sql: 'SELECT 3', duration: 40 })
      .done();

    const [finding] = slowCode.run(scope, options, after(520));

    expect(finding?.title).toContain('nothing accounts for');
    expect(finding?.hint).toContain('no instrumentation for');
  });

  it('drops the hedge when instrumented work sits on both sides of it', () => {
    const [finding] = slowCode.run(holeBetweenQueries(), options, after(600));

    expect(finding?.title).toContain('of your own code');
    expect(finding?.hint).toContain('both sides');
  });

  it('calls a synchronous block between two queries what it is', () => {
    // The demo's `/api/register`: a `SELECT`, ~200 ms of `pbkdf2Sync`, an
    // `INSERT`. Bracketed on both sides, so there is no hedge to make.
    const scope = scenario()
      .query({ sql: 'SELECT id FROM users WHERE email = $1', duration: 2 })
      .pause(238)
      .query({
        sql: 'INSERT INTO users (email) VALUES ($1)',
        duration: 2,
        callsite: 'src/shop.js:231',
      })
      .done();

    const [finding] = slowCode.run(scope, options, after(242));

    expect(finding?.title).toBe('238 ms of your own code');
    expect(finding?.callsite?.relative).toBe('src/shop.js');
    expect(finding?.callsite?.line).toBe(231);
  });

  it('never claims the request burned CPU, which the process cannot attribute', () => {
    const [finding] = slowCode.run(holeBetweenQueries(), options, after(600));

    expect(finding?.hint).not.toMatch(/cpu|event loop/i);
    expect(finding?.title).not.toMatch(/cpu/i);
  });
});
