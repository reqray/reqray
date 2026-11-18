/**
 * The history screen's arithmetic.
 *
 * Two claims carry this stage. A stretch nobody called must read as a void
 * rather than as a zero — a chart that draws quiet as "no errors" is a chart
 * that lies in the one direction people act on. And the numbers must not
 * depend on which store is behind them, which is why the aggregation lives in
 * one place and the stores only hand over rows.
 */

import { type HistorySample, historyOf, totalsOf } from '@reqray/core/panel';
import { describe, expect, it } from 'vitest';

const BASE = 1_700_000_000_000;

function sample(over: Partial<HistorySample> = {}): HistorySample {
  return {
    startedAt: BASE,
    durationMs: 10,
    hasError: false,
    sqlCount: 2,
    httpCount: 0,
    bytes: 1_000,
    loopDelayMs: null,
    findingCount: 0,
    sqlMs: 4,
    selfMs: 6,
    method: 'GET',
    route: '/api/orders',
    flag: null,
    ...over,
  };
}

const over = (
  samples: readonly HistorySample[],
  options: Partial<Parameters<typeof historyOf>[2]> = {},
) =>
  historyOf({ samples, truncated: false }, [], {
    from: BASE,
    to: BASE + 60_000,
    metrics: ['p95'],
    columns: 4,
    ...options,
  });

describe('a period, drawn', () => {
  it('spans the period asked for, not the one the traffic happened to fill', () => {
    // A week with an hour of traffic in it is a week. Stretching that hour
    // across the screen would be a claim about six days nobody recorded.
    const result = over([sample({ startedAt: BASE + 1_000 })], { columns: 4 });

    expect(result.from).toBe(BASE);
    expect(result.to).toBe(BASE + 60_000);
    expect(result.bucketMs).toBe(60_000 / result.calls.length);
  });

  it('leaves an empty column empty, not zero', () => {
    const result = over(
      [
        sample({ startedAt: BASE + 1_000, durationMs: 40 }),
        sample({ startedAt: BASE + 46_000, durationMs: 20 }),
      ],
      { metrics: ['p95', 'errorRate'], columns: 4 },
    );

    expect(result.calls).toEqual([1, 0, 0, 1]);
    for (const series of result.series) {
      expect(series.values[1]).toBeNull();
      expect(series.values[2]).toBeNull();
    }
    // And the columns that did hold something say what they measured.
    expect(result.series[0]?.values[0]).toBe(40);
    expect(result.series[1]?.values[0]).toBe(0);
  });

  it('draws at most two metrics, each over the same columns', () => {
    const result = over([sample(), sample({ startedAt: BASE + 30_000 })], {
      metrics: ['p50', 'throughput'],
      columns: 4,
    });

    expect(result.series.map((series) => series.metric)).toEqual(['p50', 'throughput']);
    for (const series of result.series) {
      expect(series.values).toHaveLength(result.calls.length);
    }
  });

  it('counts throughput per minute of the column, not per request', () => {
    // Four columns over a minute: fifteen seconds each, so two calls in one
    // of them is eight a minute.
    const result = over(
      [sample({ startedAt: BASE + 1_000 }), sample({ startedAt: BASE + 2_000 })],
      { metrics: ['throughput'], columns: 4 },
    );

    expect(result.series[0]?.values[0]).toBeCloseTo(8, 5);
  });

  it('averages the loop delay over the requests that carried a reading', () => {
    // A process nobody measured must not average in as calm.
    const result = over(
      [
        sample({ startedAt: BASE + 1_000, loopDelayMs: 40 }),
        sample({ startedAt: BASE + 2_000, loopDelayMs: null }),
      ],
      { metrics: ['loopDelay'], columns: 1 },
    );

    expect(result.series[0]?.values[0]).toBe(40);
  });

  it('says nothing about the loop when nothing measured it', () => {
    const result = over([sample({ loopDelayMs: null })], { metrics: ['loopDelay'], columns: 1 });

    expect(result.series[0]?.values[0]).toBeNull();
  });

  it('does not cut a period into more columns than its traffic supports', () => {
    // Six requests over forty-eight columns is eight columns of one request
    // and forty of nothing — and a percentile over one sample is that sample.
    const result = historyOf({ samples: [sample()], truncated: false }, [], {
      from: BASE,
      to: BASE + 60_000,
      metrics: ['p95'],
      columns: 48,
    });

    expect(result.calls.length).toBeLessThan(48);
  });

  it('passes on that the store stopped reading', () => {
    const result = historyOf({ samples: [sample()], truncated: true }, [], {
      from: BASE,
      to: BASE + 60_000,
      metrics: ['p95'],
    });

    expect(result.truncated).toBe(true);
  });
});

describe('the period before, drawn', () => {
  it('cuts the previous period into the same columns as the current one', () => {
    // A minute drawn in four columns; the minute before it had traffic in
    // its own first and last quarters.
    const result = historyOf(
      { samples: [sample()], truncated: false },
      [
        sample({ startedAt: BASE - 59_000, durationMs: 80 }),
        sample({ startedAt: BASE - 2_000, durationMs: 40 }),
      ],
      {
        from: BASE,
        to: BASE + 60_000,
        metrics: ['p95'],
        columns: 4,
      },
    );

    expect(result.ghost).toHaveLength(result.calls.length);
    expect(result.ghost?.[0]).toBe(80);
    expect(result.ghost?.[1]).toBeNull();
    expect(result.ghost?.at(-1)).toBe(40);
  });

  it('draws only the primary metric — a ghost per line is four lines', () => {
    const result = historyOf(
      { samples: [sample()], truncated: false },
      [sample({ startedAt: BASE - 1_000 })],
      {
        from: BASE,
        to: BASE + 60_000,
        metrics: ['p95', 'throughput'],
        columns: 2,
      },
    );

    expect(result.series).toHaveLength(2);
    expect(result.ghost).toHaveLength(2);
  });

  it('has no ghost when nothing ran before the period', () => {
    expect(over([sample()]).ghost).toBeNull();
  });
});

describe('what a period adds up to', () => {
  it('names the busiest route and the finding that fired most', () => {
    const totals = totalsOf([
      sample({ route: '/api/orders', flag: 'n_plus_one' }),
      sample({ route: '/api/orders', flag: 'n_plus_one' }),
      sample({ route: '/api/report', flag: 'slow_budget' }),
      sample({ route: '/api/report' }),
    ]);

    expect(totals.busiest).toMatchObject({ route: '/api/orders', calls: 2 });
    expect(totals.topFinding).toEqual({ detector: 'n_plus_one', calls: 2 });
  });

  it('reports time in SQL against time in application code', () => {
    const totals = totalsOf([sample({ sqlMs: 10, selfMs: 5 }), sample({ sqlMs: 30, selfMs: 15 })]);

    expect(totals.sqlMs).toBe(40);
    expect(totals.appMs).toBe(20);
  });

  it('says nothing about the split when nothing in the period recorded it', () => {
    // Requests stored before the figure was kept. Reporting the sum of what
    // half a period recorded would read as a fall rather than as silence.
    const totals = totalsOf([sample({ sqlMs: null, selfMs: null })]);

    expect(totals.sqlMs).toBeNull();
    expect(totals.appMs).toBeNull();
  });

  it('compares against the period before, and admits when there is none', () => {
    const now = [sample({ durationMs: 100 })];
    const before = [sample({ startedAt: BASE - 30_000, durationMs: 50 })];

    const withPrevious = historyOf({ samples: now, truncated: false }, before, {
      from: BASE,
      to: BASE + 60_000,
      metrics: ['p95'],
    });
    const without = historyOf({ samples: now, truncated: false }, [], {
      from: BASE,
      to: BASE + 60_000,
      metrics: ['p95'],
    });

    expect(withPrevious.previous?.p50).toBe(50);
    expect(without.previous).toBeNull();
  });

  it('an empty period is empty, and does not divide by nothing', () => {
    const totals = totalsOf([]);

    expect(totals).toMatchObject({ calls: 0, errorRate: 0, p50: 0, busiest: null });
  });
});
