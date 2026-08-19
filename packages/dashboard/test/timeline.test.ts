import { describe, expect, it } from 'vitest';
import type { RequestRow } from '../src/api';
import {
  bucketInWindow,
  buildTimeline,
  CLICK_FRACTION,
  inWindow,
  windowExtent,
  windowFromFractions,
} from '../src/timeline';

let seq = 0;

function row(startedAt: number, extra: Partial<RequestRow> = {}): RequestRow {
  seq += 1;
  return {
    id: `r${seq}`,
    method: 'GET',
    path: '/api/x',
    query: null,
    status: 200,
    durationMs: 10,
    startedAt,
    sqlCount: 0,
    nPlusOne: false,
    findingCount: 0,
    hasError: false,
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
