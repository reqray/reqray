/**
 * Pool-wait detector.
 *
 * The "does not find it" group is the important one here, because the number
 * this detector reads is easy to over-read: a wait is only a finding when it
 * was a queue, when it was long enough to act on, and when it was longer than
 * the work it delayed.
 */

import { poolWait } from '@reqray/core';
import { describe, expect, it } from 'vitest';
import { scenario } from '../fixtures/spans.js';

const options = poolWait.defaultOptions;
const finished = { durationMs: 500, status: 200, bytesOut: null, contentType: null };

describe('pool_wait — finds it', () => {
  it('reports a query that queued far longer than it ran', () => {
    const scope = scenario()
      .query({ sql: 'SELECT * FROM orders WHERE id = $1', duration: 2, waitMs: 300 })
      .done();

    const [finding] = poolWait.run(scope, options, finished);

    expect(finding?.detector).toBe('pool_wait');
    expect(finding?.severity).toBe('critical');
    expect(finding?.title).toBe('A query waited 300 ms for a free connection');
    expect(finding?.costMs).toBe(300);
  });

  it('counts overlapping waits once', () => {
    // Five queries issued together queue together: the request lost 100 ms,
    // not 500, and the finding must not promise the difference back.
    const scope = scenario()
      .parallel(5, () => ({ sql: 'SELECT 1', duration: 2, waitMs: 100 }))
      .done();

    const [finding] = poolWait.run(scope, options, finished);

    expect(finding?.costMs).toBeCloseTo(100, 5);
    expect(finding?.evidence).toMatchObject({ kind: 'pool_wait', queries: 5 });
  });

  it('adds up waits that happened at different moments', () => {
    const scope = scenario()
      .query({ sql: 'SELECT 1', duration: 1, waitMs: 40, at: 100 })
      .query({ sql: 'SELECT 2', duration: 1, waitMs: 40, at: 300 })
      .done();

    const [finding] = poolWait.run(scope, options, finished);

    expect(finding?.costMs).toBeCloseTo(80, 5);
  });

  it('points at the query that waited longest', () => {
    const scope = scenario()
      .query({ sql: 'SELECT 1', duration: 1, waitMs: 20, callsite: 'src/a.ts:10', at: 0 })
      .query({ sql: 'SELECT 2', duration: 1, waitMs: 90, callsite: 'src/b.ts:20', at: 200 })
      .done();

    const [finding] = poolWait.run(scope, options, finished);

    expect(finding?.callsite?.relative).toBe('src/b.ts');
    expect(finding?.evidence).toMatchObject({ sample: 'SELECT 2' });
  });

  it('speaks about a pool that serialised a burst, without a coin flip', () => {
    // Five queries issued at once through a pool of one. Four of them queue,
    // and because the pool runs them one after another their durations add up
    // to the whole request — 604 ms of running against 607 ms of waiting.
    // Weighed as totals this comes down to three milliseconds; weighed per
    // query it is exactly what it looks like.
    const scope = scenario()
      .query({ sql: 'SELECT 1', duration: 151, at: 0 })
      .query({ sql: 'SELECT 1', duration: 151, at: 151, waitMs: 151 })
      .query({ sql: 'SELECT 1', duration: 151, at: 302, waitMs: 302 })
      .query({ sql: 'SELECT 1', duration: 151, at: 453, waitMs: 453 })
      .query({ sql: 'SELECT 1', duration: 151, at: 604, waitMs: 604 })
      .done();

    const [finding] = poolWait.run(scope, options, finished);

    // The one that waited exactly as long as it ran is not counted: it was
    // not held up by the queue any more than by the work.
    expect(finding?.evidence).toMatchObject({ queries: 3 });
    expect(finding?.costMs).toBeCloseTo(604, 5);
  });

  it('is a warning below a quarter of a second', () => {
    const scope = scenario().query({ sql: 'SELECT 1', duration: 1, waitMs: 80 }).done();

    expect(poolWait.run(scope, options, finished)[0]?.severity).toBe('warn');
  });
});

describe('pool_wait — does not find it', () => {
  it('says nothing when no query waited', () => {
    const scope = scenario().loop(20, { sql: 'SELECT 1', duration: 3 }).done();

    expect(poolWait.run(scope, options, finished)).toEqual([]);
  });

  it('ignores a queue too short to act on', () => {
    const scope = scenario().query({ sql: 'SELECT 1', duration: 0.5, waitMs: 8 }).done();

    expect(poolWait.run(scope, options, finished)).toEqual([]);
  });

  it('stays quiet when the query ran longer than it waited', () => {
    // A busy pool that still hands connections over faster than the work
    // takes is a pool doing its job.
    const scope = scenario()
      .query({ sql: 'SELECT * FROM report', duration: 400, waitMs: 60 })
      .done();

    expect(poolWait.run(scope, options, finished)).toEqual([]);
  });

  it('does not turn parallel waits into a total that exceeds the work', () => {
    // Ten queries, each 60 ms of wait and 30 ms of work, all at once: the
    // union is 60 against 30 — a real finding — but summing would have said
    // 600 against 300 and inflated the cost tenfold.
    const scope = scenario()
      .parallel(10, () => ({ sql: 'SELECT 1', duration: 30, waitMs: 60 }))
      .done();

    const [finding] = poolWait.run(scope, options, finished);

    expect(finding?.costMs).toBeCloseTo(60, 5);
  });

  it('can be tuned to only report waits that dwarf the work', () => {
    const scope = scenario().query({ sql: 'SELECT 1', duration: 100, waitMs: 120 }).done();

    expect(poolWait.run(scope, options, finished)).toHaveLength(1);
    expect(poolWait.run(scope, { ...options, minRatio: 3 }, finished)).toEqual([]);
  });
});
