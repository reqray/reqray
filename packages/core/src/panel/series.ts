/**
 * Three charts for one endpoint, and nothing beyond them.
 *
 * Latency over time, the share that failed, and how often it was called —
 * enough to see "it got slower at 14:20, after the deploy" and to stop there.
 * Not a dashboard builder, not alerting, not aggregates over arbitrary
 * dimensions: that is the line where this becomes a worse Datadog, and it is
 * written down in the plan so that nobody crosses it by inertia.
 *
 * The bucketing is the strip's own, so a chart and the strip above it cannot
 * disagree about when something happened.
 */

import type { RouteSeries, SeriesBucket } from '@reqray/protocol';
import type { DurationSample } from './api.js';
import { percentile } from './routes.js';
import { bucketIndex } from './timeline.js';

export type { RouteSeries, SeriesBucket };

/** Columns a route's charts are drawn with, unless asked otherwise. */
export const SERIES_BUCKETS = 48;

/**
 * Calls a column should hold before it is worth drawing as one.
 *
 * A percentile over three samples is the slowest of three, which is why a
 * chart drawn at full resolution over a quiet route shows a p95 and a p99
 * that are the same number and jump about together. Fewer, fuller columns say
 * less about *when* and much more about *what*, and the resolution should
 * follow how much there is to draw rather than the width of the box.
 */
const MIN_PER_COLUMN = 6;

/** Below this the chart stops being a shape and becomes a bar. */
const MIN_BUCKETS = 12;

/**
 * Buckets one route's calls.
 *
 * `null` when the store holds nothing for it: a chart with invented ends
 * would be a claim about a stretch of time nobody recorded.
 */
export function routeSeries(
  method: string,
  route: string,
  samples: readonly DurationSample[],
  bucketCount: number = SERIES_BUCKETS,
): RouteSeries | null {
  if (samples.length === 0 || bucketCount <= 0) return null;

  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    if (sample.startedAt < from) from = sample.startedAt;
    if (sample.startedAt > to) to = sample.startedAt;
  }

  // As many columns as the traffic supports, and never more than asked for.
  const count = Math.max(
    Math.min(MIN_BUCKETS, bucketCount),
    Math.min(bucketCount, Math.ceil(samples.length / MIN_PER_COLUMN)),
  );

  const columns: Array<{ durations: number[]; errors: number }> = Array.from(
    { length: count },
    () => ({ durations: [], errors: 0 }),
  );

  for (const sample of samples) {
    const column = columns[bucketIndex(sample.startedAt, from, to, count)];
    if (!column) continue;
    column.durations.push(sample.durationMs);
    if (sample.hasError) column.errors++;
  }

  // A single call spans no time; a second keeps throughput finite and honest.
  const span = Math.max(1_000, to - from);
  const bucketMs = span / count;

  return {
    method,
    route,
    from,
    to,
    bucketMs,
    calls: samples.length,
    buckets: columns.map((column, index) => {
      const sorted = column.durations.sort((a, b) => a - b);
      return {
        at: from + index * bucketMs,
        calls: sorted.length,
        errors: column.errors,
        p50: sorted.length > 0 ? percentile(sorted, 0.5) : 0,
        p95: sorted.length > 0 ? percentile(sorted, 0.95) : 0,
        p99: sorted.length > 0 ? percentile(sorted, 0.99) : 0,
      };
    }),
  };
}
