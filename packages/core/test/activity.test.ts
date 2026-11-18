/**
 * What ran here.
 *
 * The rule that matters is what gets left out. Ranked by volume, the busiest
 * endpoint tops every moment and the answer explains nothing; ranked against
 * each route's own behaviour, the list is short and occasionally empty — and
 * empty is an answer, not a failure.
 */

import { type RouteWindow, whatRanAt } from '@reqray/core/panel';
import { describe, expect, it } from 'vitest';

const route = (route: string, calls: number, avgMs: number): RouteWindow => ({
  method: 'GET',
  route,
  calls,
  avgMs,
});

/** A moment of one second inside a window of one hundred. */
const WINDOW = { from: 100_000, to: 101_000, overallMs: 100_000 };

describe('what ran in a moment', () => {
  it('finds the route that ran far more often than it usually does', () => {
    // 12 calls in a second, against 12 calls in the remaining 99 — a hundred
    // times its usual rate.
    const { outliers } = whatRanAt(
      [route('/api/orders', 12, 40)],
      [route('/api/orders', 24, 40)],
      WINDOW,
    );

    expect(outliers).toHaveLength(1);
    expect(outliers[0]?.route).toBe('/api/orders');
    expect(outliers[0]?.rateRatio ?? 0).toBeGreaterThan(50);
    expect(outliers[0]?.firstSeen).toBe(false);
  });

  it('finds the route that ran at its usual rate and took far longer', () => {
    // Same rate as ever; three times the duration. The mean over the rest is
    // recovered from the totals rather than asked for a second time.
    const { outliers } = whatRanAt(
      [route('/api/report', 4, 900)],
      [route('/api/report', 404, 300 + (900 - 300) * (4 / 404))],
      WINDOW,
    );

    expect(outliers[0]?.slowerRatio ?? 0).toBeCloseTo(3, 1);
  });

  it('calls a route that never ran before what it is', () => {
    const { outliers } = whatRanAt(
      [route('/api/export', 5, 900)],
      [route('/api/export', 5, 900)],
      WINDOW,
    );

    expect(outliers[0]).toMatchObject({ firstSeen: true, rateRatio: null, slowerRatio: null });
  });

  it('puts the most unlike itself on top, whatever the traffic', () => {
    const { outliers } = whatRanAt(
      [
        // Ten thousand calls, exactly as always: the busiest route in the
        // moment, and the least interesting thing in it.
        route('/api/health', 10_000, 1),
        route('/api/orders', 6, 40),
      ],
      [route('/api/health', 1_000_000, 1), route('/api/orders', 12, 40)],
      WINDOW,
    );

    expect(outliers.map((outlier) => outlier.route)).toEqual(['/api/orders']);
  });

  it('counts the calls it was asked about, not only the ones it reports', () => {
    const report = whatRanAt(
      [route('/api/health', 200, 1), route('/api/orders', 6, 40)],
      [route('/api/health', 20_000, 1), route('/api/orders', 12, 40)],
      WINDOW,
    );

    expect(report.calls).toBe(206);
    expect(report.from).toBe(100_000);
  });
});

describe('what did not run here', () => {
  it('says nothing when every route behaved as it always does', () => {
    // Whatever moved the chart came from garbage collection, a neighbour on
    // the box, or the host — and a list of ordinary routes presented as an
    // explanation is worse than an admission that there is none.
    const { outliers } = whatRanAt(
      [route('/api/orders', 10, 40), route('/api/health', 100, 1)],
      [route('/api/orders', 1_000, 40), route('/api/health', 10_000, 1)],
      WINDOW,
    );

    expect(outliers).toEqual([]);
  });

  it('ignores a burst that lifted every route at once', () => {
    // A cron waking up, a deploy draining a queue, a demo restarting: the
    // traffic arrived, and every endpoint ran six times as often. Judged
    // against the total it is part of, every one of them is an outlier; the
    // honest answer is that nothing here was different.
    const momentRoutes = ['a', 'b', 'c', 'd'].map((name) => route(`/api/${name}`, 60, 20));
    const overallRoutes = ['a', 'b', 'c', 'd'].map((name) => route(`/api/${name}`, 660, 20));
    const { outliers, rateRatio } = whatRanAt(momentRoutes, overallRoutes, {
      from: 100_000,
      to: 160_000,
      overallMs: 3_660_000,
    });

    expect(outliers).toEqual([]);
    // And the moment still reports that it was busier, which is the fact the
    // reader came for even when no single route explains it.
    expect(rateRatio ?? 0).toBeGreaterThan(5);
  });

  it('still finds the one route that outran the burst', () => {
    const momentRoutes = [
      ...['a', 'b', 'c'].map((name) => route(`/api/${name}`, 60, 20)),
      route('/api/orders', 300, 20),
    ];
    const overallRoutes = [
      ...['a', 'b', 'c'].map((name) => route(`/api/${name}`, 660, 20)),
      route('/api/orders', 900, 20),
    ];
    const { outliers } = whatRanAt(momentRoutes, overallRoutes, {
      from: 100_000,
      to: 160_000,
      overallMs: 3_660_000,
    });

    expect(outliers.map((outlier) => outlier.route)).toEqual(['/api/orders']);
  });

  it('ignores a route with too few calls to say anything about', () => {
    // Two calls that happened to be slow are two calls that happened to be
    // slow, however far from the mean they landed.
    const { outliers } = whatRanAt(
      [route('/api/orders', 2, 4_000)],
      [route('/api/orders', 1_002, 40)],
      WINDOW,
    );

    expect(outliers).toEqual([]);
  });

  it('ignores three calls where two were expected', () => {
    // 1.5× the rate, and nothing has happened: a route called twice a minute
    // that happens to be called three times. The ratio alone would report it,
    // which is how a moment ends up listing everything that ran.
    const { outliers } = whatRanAt([route('/api/orders', 3, 20)], [route('/api/orders', 200, 20)], {
      from: 100_000,
      to: 160_000,
      overallMs: 3_600_000,
    });

    expect(outliers).toEqual([]);
  });

  it('ignores a route that doubled from a fifth of a millisecond', () => {
    // Twice as slow, and nobody could tell. Below five milliseconds a ratio
    // is reporting the jitter of the clock.
    const { outliers } = whatRanAt(
      [route('/api/health', 100, 0.4)],
      [route('/api/health', 10_000, 0.2 + (0.4 - 0.2) * (100 / 10_000))],
      WINDOW,
    );

    expect(outliers).toEqual([]);
  });

  it('ignores a difference inside the noise', () => {
    const { outliers } = whatRanAt(
      [route('/api/orders', 10, 48)],
      [route('/api/orders', 1_000, 40)],
      WINDOW,
    );

    expect(outliers).toEqual([]);
  });

  it('does not let a spike become its own baseline', () => {
    // Every call of this route happened in the moment. Comparing against the
    // whole window, spike included, would report a ratio near one and call
    // the most unusual thing on the chart ordinary.
    const { outliers } = whatRanAt(
      [route('/api/export', 40, 900)],
      [route('/api/export', 40, 900)],
      WINDOW,
    );

    expect(outliers[0]?.firstSeen).toBe(true);
  });
});
