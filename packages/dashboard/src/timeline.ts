import type { RequestRow } from './api';

/**
 * The timeline scrubber's arithmetic.
 *
 * The strip answers "when did it go wrong" before any filter is typed: a
 * burst of red at 14:32 is the incident, and dragging across it narrows the
 * list to that minute. Bucketing and window maths live here, apart from the
 * pointer handling, because this is the part that can be wrong in ways a
 * screenshot would not reveal.
 */

export interface Bucket {
  /** 5xx. */
  err: number;
  /** Slow but not an error — the two never double-count. */
  slow: number;
  rest: number;
  total: number;
}

export interface Timeline {
  /** Timestamps of the oldest and newest recorded request. */
  from: number;
  to: number;
  buckets: Bucket[];
}

/** A selected time window, inclusive on both ends. */
export type TimeWindow = readonly [from: number, to: number];

export const BUCKET_COUNT = 64;

/** Slow enough to be worth a colour, matching the status bar's own wording. */
const SLOW_MS = 500;

/**
 * A drag this short is a click: releasing the pointer where it went down must
 * clear the window rather than select a sliver nothing falls into.
 */
export const CLICK_FRACTION = 0.01;

export function buildTimeline(
  rows: readonly RequestRow[],
  bucketCount: number = BUCKET_COUNT,
): Timeline | null {
  if (rows.length === 0) return null;

  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.startedAt < from) from = row.startedAt;
    if (row.startedAt > to) to = row.startedAt;
  }

  const buckets: Bucket[] = Array.from({ length: bucketCount }, () => ({
    err: 0,
    slow: 0,
    rest: 0,
    total: 0,
  }));

  // A single request, or several within one millisecond, still has to land
  // somewhere: a zero-wide range would divide by zero.
  const span = Math.max(1, to - from);
  for (const row of rows) {
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor(((row.startedAt - from) / span) * bucketCount)),
    );
    const bucket = buckets[index];
    if (!bucket) continue;
    if (row.status >= 500) bucket.err++;
    else if (row.durationMs >= SLOW_MS) bucket.slow++;
    else bucket.rest++;
    bucket.total++;
  }

  return { from, to, buckets };
}

/**
 * The window a drag between two fractions of the strip selects, or `null`
 * when the gesture was a click and the window should be cleared.
 */
export function windowFromFractions(
  a: number,
  b: number,
  timeline: Pick<Timeline, 'from' | 'to'>,
): TimeWindow | null {
  if (Math.abs(a - b) < CLICK_FRACTION) return null;
  const low = Math.max(0, Math.min(a, b));
  const high = Math.min(1, Math.max(a, b));
  const span = Math.max(1, timeline.to - timeline.from);
  return [timeline.from + low * span, timeline.from + high * span];
}

/** Where a window sits on the strip, as left/width percentages. */
export function windowExtent(
  win: TimeWindow,
  timeline: Pick<Timeline, 'from' | 'to'>,
): { left: number; width: number } {
  const span = Math.max(1, timeline.to - timeline.from);
  const left = ((win[0] - timeline.from) / span) * 100;
  const right = ((win[1] - timeline.from) / span) * 100;
  return { left: Math.max(0, left), width: Math.max(0, Math.min(100, right) - Math.max(0, left)) };
}

export function inWindow(startedAt: number, win: TimeWindow | null): boolean {
  if (!win) return true;
  return startedAt >= win[0] && startedAt <= win[1];
}

/** Whether a bucket overlaps the window — the rest are dimmed, not hidden. */
export function bucketInWindow(index: number, timeline: Timeline, win: TimeWindow | null): boolean {
  if (!win) return true;
  const span = Math.max(1, timeline.to - timeline.from);
  const width = span / timeline.buckets.length;
  const start = timeline.from + index * width;
  return start + width >= win[0] && start <= win[1];
}
