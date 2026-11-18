import { describe, expect, it } from 'vitest';
import type { RequestRow } from '../src/api/index';
import {
  bucketInWindow,
  buildTimeline,
  CLICK_FRACTION,
  inWindow,
  newestRun,
  type Timeline,
  windowExtent,
  windowFromFractions,
} from '../src/shared/list/timeline';

let seq = 0;

function row(startedAt: number, extra: Partial<RequestRow> = {}): RequestRow {
  seq += 1;
  return {
    id: `r${seq}`,
    method: 'GET',
    path: '/api/x',
    query: null,
    route: '/api/x',
    flag: null,
    status: 200,
    durationMs: 10,
    startedAt,
    sqlCount: 0,
    nPlusOne: false,
    findingCount: 0,
    hasError: false,
    httpCount: 0,
    cpuMs: null,
    cpuShare: null,
    pinned: false,
    test: null,
    ...extra,
  };
}

describe('timeline buckets', () => {
  it('spreads requests across the recorded range', () => {
    const timeline = buildTimeline([row(0), row(500), row(1000)], 4);

    expect(timeline).not.toBeNull();
    expect(timeline?.from).toBe(0);
    expect(timeline?.to).toBe(1000);
    expect(timeline?.buckets.map((bucket) => bucket.total)).toEqual([1, 0, 1, 1]);
  });

  it('classifies each request exactly once', () => {
    const timeline = buildTimeline(
      [
        row(0, { status: 500, durationMs: 900 }), // an error, however slow
        row(0, { durationMs: 700 }),
        row(0, { durationMs: 20 }),
      ],
      1,
    );

    expect(timeline?.buckets[0]).toEqual({ err: 1, slow: 1, rest: 1, total: 3 });
  });

  it('survives a range with no width', () => {
    // Several requests inside one millisecond must not divide by zero.
    const timeline = buildTimeline([row(1000), row(1000)], 8);

    expect(timeline?.buckets[0]?.total).toBe(2);
    expect(timeline?.buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(2);
  });

  it('has nothing to draw for an empty buffer', () => {
    expect(buildTimeline([], 8)).toBeNull();
  });
});

describe('the drag window', () => {
  const timeline = { from: 1000, to: 2000 };

  it('selects the dragged stretch', () => {
    expect(windowFromFractions(0.25, 0.75, timeline)).toEqual([1250, 1750]);
  });

  it('reads the same dragged backwards', () => {
    expect(windowFromFractions(0.75, 0.25, timeline)).toEqual([1250, 1750]);
  });

  it('treats a tap as "clear the window"', () => {
    expect(windowFromFractions(0.4, 0.4 + CLICK_FRACTION / 2, timeline)).toBeNull();
  });

  it('clamps a drag that leaves the strip', () => {
    expect(windowFromFractions(-0.4, 1.6, timeline)).toEqual([1000, 2000]);
  });

  it('keeps rows inside and drops rows outside', () => {
    const win = windowFromFractions(0.25, 0.75, timeline);

    expect(inWindow(1500, win)).toBe(true);
    expect(inWindow(1100, win)).toBe(false);
    // No window means no filtering at all.
    expect(inWindow(1100, null)).toBe(true);
  });

  it('places the overlay over the selection', () => {
    expect(windowExtent([1250, 1750], timeline)).toEqual({ left: 25, width: 50 });
  });

  it('dims only the buckets the window misses', () => {
    const full = buildTimeline([row(1000), row(2000)], 4);
    if (!full) throw new Error('timeline');
    const win = [1000, 1200] as const;

    expect(bucketInWindow(0, full, win)).toBe(true);
    expect(bucketInWindow(3, full, win)).toBe(false);
    expect(bucketInWindow(3, full, null)).toBe(true);
  });
});

describe('the newest run of traffic', () => {
  /** A strip of `count` columns with traffic only where told. */
  const strip = (count: number, busy: readonly number[]): Timeline => ({
    from: 0,
    // Wide enough columns that the strip spans hours: below ten minutes the
    // whole strip is one sitting and there is nothing to crop.
    to: count * 60_000,
    buckets: Array.from({ length: count }, (_, index) => ({
      err: 0,
      slow: 0,
      rest: busy.includes(index) ? 5 : 0,
      total: busy.includes(index) ? 5 : 0,
    })),
  });

  it('finds the run at the end when the rest of the strip is silence', () => {
    // A store that keeps a week and an application that ran for an hour: one
    // session days ago, one now, and sixty columns of nothing between them.
    const run = newestRun(strip(64, [0, 62, 63]));

    expect(run).not.toBeNull();
    expect(run?.[0]).toBe(62 * 60_000);
    expect(run?.[1]).toBe(64 * 60_000);
  });

  it('bridges a quiet stretch inside one session', () => {
    // A tenth of the strip is a quiet minute, not the gap between two days.
    const run = newestRun(strip(64, [0, 56, 57, 62, 63]));
    expect(run?.[0]).toBe(56 * 60_000);
  });

  it('says nothing when the traffic already fills the strip', () => {
    // Zooming here would crop the history rather than reveal it.
    const busy = Array.from({ length: 40 }, (_, index) => index + 24);
    expect(newestRun(strip(64, busy))).toBeNull();
  });

  it('says nothing about an empty strip', () => {
    expect(newestRun(strip(64, []))).toBeNull();
  });

  it('leaves a short session alone, however it is clustered', () => {
    // Two minutes of traffic with a pause in the middle is one sitting: a
    // coffee, a restart, a test run. Cropping it to the newest half would
    // hide what happened before the pause.
    const short: Timeline = {
      from: 0,
      to: 120_000,
      buckets: Array.from({ length: 64 }, (_, index) => {
        const busy = index < 4 || index > 58;
        return { err: 0, slow: 0, rest: busy ? 5 : 0, total: busy ? 5 : 0 };
      }),
    };

    expect(newestRun(short)).toBeNull();
  });
});
