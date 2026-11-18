/**
 * Where a request's time went.
 *
 * The panel answers "the database took 41 ms". It does not answer "and where
 * did the other 400 ms go", which for a Node backend is the more common
 * question. This module answers it, once, in the core: the API, the panel and
 * the terminal client read the same number rather than each deriving its own
 * from the span tree.
 *
 * Everything here is an interval union rather than a sum. Adding span
 * durations up is the mistake that makes a `Promise.all` of four 100 ms
 * queries read as 400 ms of database time inside a 120 ms request — a number
 * that is not merely imprecise but larger than the request that contains it.
 */

import type { HandlerSpan, MiddlewareSpan, RecordedRequest, RequestTiming, Span } from './types.js';
import { weightOf } from './weight.js';

/** A stretch of the request's clock, in milliseconds from its start. */
interface Interval {
  readonly start: number;
  readonly end: number;
}

/**
 * A span that holds other work rather than doing any.
 *
 * Exported because the same distinction decides three different questions —
 * what counts as coverage, what a self time is measured against, and what an
 * unaccounted stretch sits inside — and a second definition of "container"
 * is how the three drift apart.
 */
export function isContainer(span: Span): span is MiddlewareSpan | HandlerSpan {
  return span.kind === 'handler' || span.kind === 'middleware';
}

function intervalOf(span: Span): Interval {
  return { start: span.startedAt, end: span.startedAt + span.duration };
}

/**
 * The same stretches with overlaps merged away.
 *
 * @param intervals in any order; the result is sorted and disjoint.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  let current = sorted[0] as Interval;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= current.end) {
      current = { start: current.start, end: Math.max(current.end, interval.end) };
    } else {
      merged.push(current);
      current = interval;
    }
  }
  merged.push(current);
  return merged;
}

/** How much of the clock these stretches cover, counting overlaps once. */
export function coveredMs(intervals: readonly Interval[]): number {
  let total = 0;
  for (const interval of mergeIntervals(intervals)) total += interval.end - interval.start;
  return total;
}

/** Whether any two of them ran at the same time. */
export function anyOverlap(intervals: readonly Interval[]): boolean {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1] as Interval;
    const current = sorted[index] as Interval;
    // Touching is not overlapping: one query ending exactly where the next
    // begins is a sequence, and a rounding tie must not read as concurrency.
    if (current.start < previous.end) return true;
  }
  return false;
}

/** How much of `outer` the stretches cover. */
function coveredWithin(outer: Interval, intervals: readonly Interval[]): number {
  let total = 0;
  for (const interval of mergeIntervals(intervals)) {
    const start = Math.max(outer.start, interval.start);
    const end = Math.min(outer.end, interval.end);
    if (end > start) total += end - start;
  }
  return total;
}

/**
 * Time each span spent in its *own* code, by span id.
 *
 * A span's duration minus the stretch its children occupied — where children
 * that ran concurrently count once, and a child reaching outside its parent
 * (a clock that moved, a span closed late) counts only for the part inside.
 *
 * This is the number that answers "what did the work", and the reason the
 * panel does not rank by total: the handler is always at the top of that
 * list, because it contains everything and did nothing.
 */
export function selfTimes(spans: readonly Span[]): Map<number, number> {
  const children = new Map<number, Interval[]>();
  for (const span of spans) {
    if (span.parentId === null) continue;
    const list = children.get(span.parentId);
    if (list) list.push(intervalOf(span));
    else children.set(span.parentId, [intervalOf(span)]);
  }

  const self = new Map<number, number>();
  for (const span of spans) {
    const own = children.get(span.id);
    const covered = own ? coveredWithin(intervalOf(span), own) : 0;
    self.set(span.id, Math.max(0, span.duration - covered));
  }
  return self;
}

/**
 * Where the request's time went, as the header line reads it.
 *
 * `sqlMs`, `externalMs` and `cacheMs` are unions within their own kind, so
 * each is what that layer actually cost. They can still sum past the wall
 * clock when a query and an outgoing call overlapped, which is why `parallel`
 * travels with them: the panel says so rather than printing an addition that
 * does not add up.
 */
export function timingOf(spans: readonly Span[], durationMs: number): RequestTiming {
  const work = spans.filter((span) => !isContainer(span));
  const byKind = (kind: Span['kind']): Interval[] =>
    work.filter((span) => span.kind === kind).map(intervalOf);

  const all = work.map(intervalOf);
  const covered = coveredMs(all);

  return {
    sqlMs: coveredMs(byKind('db')),
    externalMs: coveredMs(byKind('http')),
    cacheMs: coveredMs(byKind('cache')),
    // Clamped: a span may finish a hair after the response is written, and a
    // negative "your code" would be read as a bug in the reader, not in us.
    selfMs: Math.max(0, durationMs - covered),
    parallel: anyOverlap(all),
  };
}

/**
 * The record with its timing filled in.
 *
 * Records written before this existed are still in stores on disk, and a
 * panel that shows a blank header for yesterday's request would be reporting
 * its own age as the request's fault. Computed on read, and only for those.
 */
export function ensureTiming(request: RecordedRequest): RecordedRequest {
  // Typed as required because they are required of anything written from now
  // on; what arrives from a store may predate them, and that is this case.
  const stored = request as Partial<RecordedRequest>;
  if (stored.timing !== undefined && stored.weight !== undefined && stored.cost !== undefined)
    return request;
  const self = selfTimes(request.spans);
  return {
    ...request,
    timing: stored.timing ?? timingOf(request.spans, request.durationMs),
    // Nothing was measuring the loop when this was written, and nothing can
    // work out afterwards what it was doing.
    host: request.host ?? null,
    // Weight, unlike the loop, is entirely derivable from what was stored.
    weight: stored.weight ?? weightOf(request),
    // Nothing was reading the processor clock when this was written, and no
    // arithmetic afterwards can recover what it said.
    cost: stored.cost ?? null,
    spans: request.spans.map((span) => ({ ...span, selfMs: self.get(span.id) ?? span.duration })),
  };
}
