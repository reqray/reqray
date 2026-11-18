/**
 * The strip above the list.
 *
 * It is drawn from the whole store rather than from the rows on screen, which
 * is what makes it draggable back to yesterday — and the bucketing happens
 * once, here, so the strip can never disagree with the list under it.
 */

import { buildTimeline, TIMELINE_BUCKETS, type TimePoint } from '@reqray/core/panel';
import { describe, expect, it } from 'vitest';

const BASE = Date.UTC(2026, 7, 20, 9, 0, 0);

const at = (offsetMs: number, over: Partial<TimePoint> = {}): TimePoint => ({
  startedAt: BASE + offsetMs,
  durationMs: 10,
  hasError: false,
  ...over,
});

describe('bucketing', () => {
  it('spans the oldest and newest request, and nothing beyond', () => {
    const timeline = buildTimeline([at(0), at(1_000), at(5_000)]);

    expect(timeline).toMatchObject({ from: BASE, to: BASE + 5_000 });
    expect(timeline?.buckets).toHaveLength(TIMELINE_BUCKETS);
  });

  it('has nothing to say about an empty store', () => {
    // Ends invented out of nothing would be a lie about what is recorded.
    expect(buildTimeline([])).toBeNull();
  });

  it('puts the oldest at one end and the newest at the other', () => {
    const timeline = buildTimeline([at(0), at(10_000)], 10);

    expect(timeline?.buckets[0]?.total).toBe(1);
    expect(timeline?.buckets[9]?.total).toBe(1);
    expect(timeline?.buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(2);
  });

  it('counts every request exactly once', () => {
    const points = Array.from({ length: 500 }, (_, index) => at(index * 37));

    const timeline = buildTimeline(points, 16);

    expect(timeline?.buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(500);
  });

  it('a burst inside one millisecond is one column, not a division by zero', () => {
    const timeline = buildTimeline([at(0), at(0), at(0)], 8);

    expect(timeline?.from).toBe(timeline?.to);
    expect(timeline?.buckets[0]?.total).toBe(3);
  });
});

describe('what a column is made of', () => {
  it('separates failures, slow requests and the rest', () => {
    const timeline = buildTimeline(
      [
        at(0, { hasError: true, durationMs: 900 }),
        at(1, { durationMs: 900 }),
        at(2, { durationMs: 12 }),
      ],
      1,
    );

    // A slow failure is a failure: the counts never double-count, or the
    // column would be taller than the traffic it draws.
    expect(timeline?.buckets[0]).toEqual({ err: 1, slow: 1, rest: 1, total: 3 });
  });

  it('draws the slow line where the rest of the panel draws it', () => {
    const timeline = buildTimeline([at(0, { durationMs: 500 }), at(1, { durationMs: 499 })], 1);

    expect(timeline?.buckets[0]).toMatchObject({ slow: 1, rest: 1 });
  });

  it('asked for no columns, it draws none rather than crashing', () => {
    expect(buildTimeline([at(0)], 0)).toBeNull();
  });
});
