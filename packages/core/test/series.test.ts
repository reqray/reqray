/**
 * Three charts for one endpoint.
 *
 * The bucketing is the strip's own — two implementations of "which column is
 * this" drift, and the drift is a chart that disagrees with the strip above it
 * about when something happened.
 */

import { bucketIndex, type DurationSample, routeSeries } from '@reqray/core/panel';
import { describe, expect, it } from 'vitest';

/** Calls a second apart, starting at a fixed moment. */
function calls(
  durations: readonly number[],
  options: { errorsAt?: readonly number[]; stepMs?: number } = {},
): DurationSample[] {
  const step = options.stepMs ?? 1_000;
  return durations.map((durationMs, index) => ({
    durationMs,
    startedAt: 10_000 + index * step,
    hasError: options.errorsAt?.includes(index) ?? false,
    loopDelayMs: null,
  }));
}

describe('a route over time', () => {
  it('says nothing about a route the store holds nothing for', () => {
    expect(routeSeries('GET', '/api/orders', [], 8)).toBeNull();
  });

  it('spreads calls across the columns by when they happened', () => {
    const series = routeSeries('GET', '/api/orders', calls([10, 10, 10, 10]), 4);

    expect(series?.buckets.map((bucket) => bucket.calls)).toEqual([1, 1, 1, 1]);
    expect(series?.calls).toBe(4);
  });

  it('draws percentiles per column, and a gap where nothing ran', () => {
    // Two calls at the start, two at the end, nothing between.
    const samples = [...calls([10, 20]), ...calls([100, 200], { stepMs: 1_000 })].map(
      (sample, index) => ({
        ...sample,
        startedAt: 10_000 + (index < 2 ? index : index + 20) * 1_000,
      }),
    );
    const series = routeSeries('GET', '/api/orders', samples, 4);

    const empty = series?.buckets.filter((bucket) => bucket.calls === 0) ?? [];
    expect(empty.length).toBeGreaterThan(0);
    // A column with no traffic is a gap. Zero is what it reports, and a
    // client draws a break rather than a line falling to the floor.
    expect(empty.every((bucket) => bucket.p95 === 0)).toBe(true);
  });

  it('counts failures per column', () => {
    const series = routeSeries('GET', '/api/orders', calls([10, 10, 10, 10], { errorsAt: [2] }), 4);

    expect(series?.buckets.map((bucket) => bucket.errors)).toEqual([0, 0, 1, 0]);
  });

  it('gives a single call a column and a second of width', () => {
    // One call spans no time; dividing by that span is how throughput
    // becomes infinite.
    const series = routeSeries('GET', '/api/orders', calls([42]), 4);

    expect(series?.buckets[0]?.calls).toBe(1);
    expect((series?.bucketMs ?? 0) * 4).toBeGreaterThanOrEqual(1_000);
  });

  it('draws fewer columns than asked for when there is less to draw', () => {
    // A percentile over three calls is the slowest of three. Asked for
    // forty-eight columns over a hundred calls, the chart would show a p95
    // and a p99 that are the same number in every column and jump about
    // together — so the resolution follows the traffic instead of the box.
    const hundred = routeSeries('GET', '/api/orders', calls(Array(100).fill(20)), 48);
    expect(hundred?.buckets).toHaveLength(17);

    // With enough traffic the full resolution is what it asked for.
    const thousand = routeSeries('GET', '/api/orders', calls(Array(1_000).fill(20)), 48);
    expect(thousand?.buckets).toHaveLength(48);

    // And a floor, so a quiet route is still a shape and not one bar.
    const few = routeSeries('GET', '/api/orders', calls([10, 20, 30]), 48);
    expect(few?.buckets).toHaveLength(12);
  });

  it('never draws more columns than the caller asked for', () => {
    const narrow = routeSeries('GET', '/api/orders', calls(Array(500).fill(20)), 8);
    expect(narrow?.buckets).toHaveLength(8);
  });

  it('buckets the way the strip above it does', () => {
    // Same function, so a moment on the chart and a moment on the strip are
    // the same moment.
    expect(bucketIndex(150, 100, 200, 4)).toBe(2);
    expect(bucketIndex(100, 100, 200, 4)).toBe(0);
    expect(bucketIndex(200, 100, 200, 4)).toBe(3);
    // A range of no width does not divide by zero.
    expect(bucketIndex(100, 100, 100, 4)).toBe(0);
  });
});
