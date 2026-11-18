/**
 * The shape of the traffic over time, for the strip above the list.
 *
 * The panel used to draw this from the rows it had loaded, which was fine
 * while a store held five hundred requests and everything was on screen. With
 * a history behind it, "the rows I have" is the last page — a few minutes —
 * and a strip that only spans a few minutes cannot be dragged back to
 * yesterday. So the store answers for its whole range instead.
 *
 * Three numbers per request go into it — when, how long, and whether it
 * failed — and the bucketing happens here, once, for every store. Two
 * implementations of "which bucket does this fall into" would drift, and the
 * drift would be a strip that disagrees with the list under it.
 */

/** What the timeline needs to know about one request. */
export interface TimePoint {
  readonly startedAt: number;
  readonly durationMs: number;
  readonly hasError: boolean;
}

import type { TimelineBucket, TimelineReport } from '@reqray/protocol';

export type { TimelineBucket, TimelineReport };

/** How many columns the strip is drawn with, unless asked otherwise. */
export const TIMELINE_BUCKETS = 64;
/** Above this, a request is drawn as slow — the panel's own threshold. */
const SLOW_MS = 500;

/**
 * Which column a moment falls into.
 *
 * Shared with the per-route charts on purpose: two implementations of "which
 * bucket is this" drift, and the drift is a strip that disagrees with the
 * chart under it about when something happened. Everything inside a single
 * millisecond lands in the first column rather than dividing by a zero span.
 */
export function bucketIndex(at: number, from: number, to: number, count: number): number {
  const span = to - from;
  const fraction = span > 0 ? (at - from) / span : 0;
  return Math.max(0, Math.min(count - 1, Math.floor(fraction * count)));
}

/**
 * Buckets a set of points into a strip.
 *
 * `null` when there is nothing to draw: an empty store has no range, and a
 * strip with invented ends would be a lie about what is recorded.
 */
export function buildTimeline(
  points: readonly TimePoint[],
  bucketCount: number = TIMELINE_BUCKETS,
): TimelineReport | null {
  if (points.length === 0 || bucketCount <= 0) return null;

  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.startedAt < from) from = point.startedAt;
    if (point.startedAt > to) to = point.startedAt;
  }

  const buckets: TimelineBucket[] = Array.from({ length: bucketCount }, () => ({
    err: 0,
    slow: 0,
    rest: 0,
    total: 0,
  }));

  for (const point of points) {
    const index = bucketIndex(point.startedAt, from, to, bucketCount);
    const bucket = buckets[index] as {
      err: number;
      slow: number;
      rest: number;
      total: number;
    };
    if (point.hasError) bucket.err++;
    else if (point.durationMs >= SLOW_MS) bucket.slow++;
    else bucket.rest++;
    bucket.total++;
  }

  return { from, to, buckets };
}
