import type { RequestRow } from '../../api/index';

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

/**
 * How much of the store the strip draws.
 *
 * `recent` is the newest run of traffic — a process restarted after a weekend
 * would otherwise draw two days of nothing around one live minute. `full` is
 * everything kept.
 */
export type TimelineScope = 'recent' | 'full';

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

/**
 * How long a silence has to be before it separates two sessions.
 *
 * A tenth of the strip: shorter than that is a quiet minute inside one
 * session, longer is the gap between yesterday and today.
 */
const SESSION_GAP = 0.1;

/**
 * Below this share of the strip, the newest run of traffic is worth opening
 * on instead of the whole span. Above it, the whole span already *is* the
 * traffic and zooming would only crop it.
 */
const WORTH_ZOOMING = 0.5;

/**
 * Below this span, the strip is one sitting and cropping it hides part of
 * what just happened.
 *
 * A dev session that started ten minutes ago has pauses in it — a coffee, a
 * restart, a test run — and none of them separate one session from another.
 */
const WORTH_ZOOMING_MS = 10 * 60 * 1000;

/**
 * The newest stretch of traffic, when the rest of the strip is silence.
 *
 * A store that keeps a week and an application that ran for an hour draw a
 * strip with sixty-two empty columns and everything squeezed into the last
 * one — true, and useless. This finds the run at the end and reports it, so
 * the strip can open there and keep the full range one click away. `null`
 * when the traffic already fills the strip, or when there is none.
 */
export function newestRun(timeline: Timeline): TimeWindow | null {
  const count = timeline.buckets.length;
  if (count === 0 || timeline.to - timeline.from < WORTH_ZOOMING_MS) return null;

  const last = timeline.buckets.reduce(
    (found, bucket, index) => (bucket.total > 0 ? index : found),
    -1,
  );
  if (last < 0) return null;

  const allowed = Math.max(1, Math.floor(count * SESSION_GAP));
  let start = last;
  let empty = 0;
  for (let index = last - 1; index >= 0; index--) {
    if ((timeline.buckets[index]?.total ?? 0) > 0) {
      start = index;
      empty = 0;
      continue;
    }
    empty++;
    if (empty > allowed) break;
  }

  if ((last - start + 1) / count > WORTH_ZOOMING) return null;

  const span = timeline.to - timeline.from;
  const width = span / count;
  return [timeline.from + start * width, timeline.from + (last + 1) * width];
}
