/**
 * Slow-code detector: the stretch of a request nothing accounts for.
 *
 * Every other detector names something Reqray watched happen — a query, an
 * outgoing call, a connection held open too long. This one names the
 * opposite: a stretch where nothing it watches was running at all. That is
 * the answer a waterfall gives worst, because the evidence for it is an empty
 * space, and it is the most common answer for a Node backend once the
 * database has been ruled out.
 *
 * The whole difficulty is that an empty space has two explanations — code
 * that ran, or I/O Reqray has no instrumentation for — and only one of them is
 * worth telling somebody about. Coverage is how they are told apart: if the
 * rest of the request was well accounted for, then Reqray does see this
 * application's I/O, and a hole in it is the application's own work. If it
 * was not, Reqray is blind to this process and says nothing, because a tool
 * that blames your code for its own blind spot is a tool nobody keeps
 * installed.
 *
 * What it deliberately does not claim is CPU. The process knows how far
 * behind its event loop was, but never which request put it there — under
 * concurrency the code that blocked the loop is usually somebody else's, so
 * the finding reports a stretch of the request's own wall clock and leaves
 * the loop to the host monitor, which measures the process and says so.
 */

import type { RequestScope } from '../scope.js';
import { coveredMs, isContainer } from '../timing.js';
import type { Finding, HandlerSpan, MiddlewareSpan, Span } from '../types.js';
import type { Detector, FinishedRequest } from './types.js';

export interface SlowCodeOptions {
  /** Shortest stretch worth reporting, milliseconds. */
  readonly minMs: number;
  /** What share of the request the stretch has to be, 0..1. */
  readonly minShare: number;
  /**
   * How much of the request's unaccounted time this one stretch has to be,
   * 0..1.
   *
   * The guard against blaming the application for an uninstrumented driver,
   * and the one that actually separates the two cases. A process Reqray cannot
   * see is not slow in one place — it is full of holes, one per call it has
   * no instrumentation for. A process Reqray can see, with one slow function
   * in it, has exactly one. So the question is not how much was covered but
   * whether the silence is concentrated: one long stretch is a thing that
   * happened, and a dozen comparable ones are a blind spot.
   */
  readonly minDominance: number;
  /**
   * Instrumented spans the request must have before any of this is evidence.
   *
   * One is the honest floor: it proves instrumentation was live for this
   * request, which is the difference between a hole in the record and no
   * record at all. A request with nothing in it says nothing about the code.
   */
  readonly minSpans: number;
}

/** An interval of the request, in milliseconds from its start. */
interface Interval {
  readonly start: number;
  readonly end: number;
}

/**
 * A stretch of the request with no instrumented work in it, and its edges.
 *
 * The neighbours travel with it because they are the whole address: an
 * unaccounted stretch has no callsite of its own, and "between the query at
 * orders.ts:47 and the call at mailer.ts:12" is the closest thing to a line
 * number that the absence of evidence can honestly produce.
 */
interface Stretch {
  readonly start: number;
  readonly end: number;
  /** The span that finished before it, or `null` when it opens the request. */
  readonly before: Span | null;
  /** The span that ends it, or `null` when the request ends with it. */
  readonly after: Span | null;
}

/**
 * What a span was doing, for the line that brackets the stretch.
 *
 * The same shapes the other detectors quote, so a reader who has seen one
 * sample has seen them all.
 */
function describe(span: Span): string {
  if (span.kind === 'db') return span.sql.replace(/\s+/g, ' ').trim();
  if (span.kind === 'http') return `${span.method} ${span.url}`;
  if (span.kind === 'cache') return `${span.command ?? span.operation} ${span.key}`;
  return span.label;
}

/**
 * The stretch a span occupies, with a query's queueing counted as occupied.
 *
 * Time spent waiting for a free connection is the one idle-looking stretch of
 * a request that is fully accounted for; calling it unaccounted would hide an
 * answer the pool-wait detector already gives behind the word for "no
 * answer".
 */
function occupied(span: Span): Interval {
  const wait = span.kind === 'db' ? (span.waitMs ?? 0) : 0;
  return { start: span.startedAt - wait, end: span.startedAt + span.duration };
}

/**
 * Every unaccounted stretch, in order.
 *
 * A sweep rather than a comparison of every span against every other: at five
 * hundred spans the quadratic version is the detector that costs more than
 * what it measures.
 */
function stretchesOf(work: readonly Span[], durationMs: number): Stretch[] {
  const ordered = work
    .map((span) => ({ span, at: occupied(span) }))
    .sort((a, b) => a.at.start - b.at.start);

  const stretches: Stretch[] = [];
  let cursor = 0;
  let previous: Span | null = null;

  for (const { span, at } of ordered) {
    if (at.start > cursor) {
      stretches.push({ start: cursor, end: at.start, before: previous, after: span });
    }
    // Only a span that reaches further than everything before it moves the
    // cursor, and only that span is the one a later stretch follows.
    if (at.end > cursor) {
      cursor = at.end;
      previous = span;
    }
  }

  if (durationMs > cursor) {
    stretches.push({ start: cursor, end: durationMs, before: previous, after: null });
  }
  return stretches;
}

/**
 * The innermost handler or middleware the stretch sits inside.
 *
 * Innermost because that is the one that names something: every stretch is
 * inside the handler, and being told the time was spent in the request is not
 * being told anything.
 */
function containerAround(
  spans: readonly Span[],
  stretch: Stretch,
): MiddlewareSpan | HandlerSpan | null {
  let found: MiddlewareSpan | HandlerSpan | null = null;
  for (const span of spans) {
    if (!isContainer(span)) continue;
    const at = occupied(span);
    if (at.start > stretch.start || at.end < stretch.end) continue;
    if (!found || span.duration < found.duration) found = span;
  }
  return found;
}

/**
 * Where to send the reader.
 *
 * The span *after* the stretch, in preference to the one before it: the code
 * that ran during the hole is the code that led up to the next call, so its
 * callsite is the bottom of the stretch rather than the top of it. A trailing
 * stretch has no next call, and then the last thing that ran is the best
 * address there is.
 */
function callsiteFor(stretch: Stretch, container: Span | null) {
  return stretch.after?.callsite ?? container?.callsite ?? stretch.before?.callsite ?? null;
}

/** A response big enough that writing it is a candidate for the time itself. */
const HEAVY_TAIL_BYTES = 1024 * 1024;

/**
 * Whether the stretch can be called code without hedging.
 *
 * It can when instrumented work sits on both sides of it: the silence is then
 * demonstrably *between* two things Reqray watched happen, which is where
 * application code runs. At either edge of a request it is not — a leading
 * stretch shares its ground with parsing and middleware Reqray never saw, a
 * trailing one with serializing and writing the response — so an edge keeps
 * the hedge whatever the arithmetic says.
 *
 * Deliberately structural rather than a ratio. Coverage is the obvious
 * measure and it inverts exactly where it matters: the more completely the
 * stretch fills the request, the smaller the window the ratio is computed
 * over, so the clearest cases come out the least certain.
 */
function bracketed(stretch: Stretch): boolean {
  return stretch.before !== null && stretch.after !== null;
}

/**
 * What to do about it.
 *
 * Three readings, because the same hole means three different things
 * depending on where it sits and how much Reqray can see around it — and a
 * hint that reads the same in all three is a hint nobody acts on.
 */
function hintFor(stretch: Stretch, request: FinishedRequest): string {
  const trailing = stretch.after === null;

  if (trailing && request.bytesOut !== null && request.bytesOut >= HEAVY_TAIL_BYTES) {
    return `It is the last thing the request does and the response is ${Math.round(request.bytesOut / 1024)} KB — serializing that and writing it to the socket is the first thing to rule out.`;
  }

  if (bracketed(stretch)) {
    return 'Instrumented work sits on both sides of it, so the time is the application’s own: a loop, a parse, a crypto or compression call, or something waiting on a timer.';
  }

  return 'This is either the application’s own work or I/O Reqray has no instrumentation for. It covers SQL, outgoing HTTP and the cache — if this request also talks to something else, that is the first place to look.';
}

export const slowCode: Detector<SlowCodeOptions> = {
  id: 'slow_code',

  defaultOptions: {
    // A tenth of a second: long enough that a person waiting notices it, and
    // far enough above ordinary scheduling jitter that the detector is not
    // reporting the event loop's own heartbeat back as a defect.
    minMs: 100,
    // Under a third of the request, something else is the story — and the
    // budget detector is already the place where "it was slow" gets said.
    minShare: 0.3,
    // Seven tenths of the silence in one place. Below that the request has
    // several comparable holes, which is what a process Reqray cannot see
    // looks like, and picking the largest of them would be picking one call
    // out of a driver it does not support and calling it your code.
    minDominance: 0.7,
    // Enough to know instrumentation was live for this request. More would
    // exclude the plainest case there is — one query, then a long wait on
    // something that is not the database.
    minSpans: 1,
  },

  run(scope: RequestScope, options: SlowCodeOptions, request: FinishedRequest): Finding[] {
    if (request.durationMs <= 0) return [];

    const work = scope.spans.filter((span) => !isContainer(span));
    // Too little watched work for coverage to be evidence of anything. An
    // application whose database Reqray does not instrument looks exactly like
    // an application that does everything in a loop, and the difference
    // cannot be recovered from a request this thin.
    if (work.length < options.minSpans) return [];

    const stretches = stretchesOf(work, request.durationMs);
    if (stretches.length === 0) return [];

    // The largest single stretch, never the sum of them: forty scattered
    // milliseconds of ordinary async overhead add up to a number that looks
    // like a defect and points at nothing.
    const worst = stretches.reduce((most, stretch) =>
      stretch.end - stretch.start > most.end - most.start ? stretch : most,
    );

    const stretchMs = worst.end - worst.start;
    if (stretchMs < options.minMs) return [];

    const share = stretchMs / request.durationMs;
    if (share < options.minShare) return [];

    // Is the silence concentrated here, or is the whole request full of it?
    const silentMs = stretches.reduce((total, gap) => total + (gap.end - gap.start), 0);
    if (stretchMs / silentMs < options.minDominance) return [];

    // Of the time outside the stretch, how much instrumentation accounted
    // for. Not a gate — it decides how much the hint is willing to claim.
    // Unioned, so queries that ran together count once; a sum would report
    // coverage above one.
    const outsideMs = request.durationMs - stretchMs;
    if (outsideMs <= 0) return [];
    const coverage = Math.min(1, coveredMs(work.map(occupied)) / outsideMs);

    const container = containerAround(scope.spans, worst);
    const spanIds = [worst.before?.id, worst.after?.id].filter(
      (id): id is number => id !== undefined,
    );

    const where = container ? ` in ${container.label}` : '';
    // The heading claims exactly what the hint is prepared to defend. Saying
    // "your own code" above a sentence that goes on to allow it might not be
    // is the kind of small contradiction that costs a tool its credibility on
    // the findings that matter.
    const what = bracketed(worst) ? 'of your own code' : 'nothing accounts for';

    return [
      {
        detector: 'slow_code',
        severity: 'warn',
        title: `${Math.round(stretchMs)} ms ${what}${where}`,
        // The whole stretch: unlike a duplicate query, there is no irreducible
        // remainder that has to happen anyway. It is an upper bound on the
        // saving, and the hint says what it is made of rather than promising
        // that all of it comes back.
        costMs: stretchMs,
        callsite: callsiteFor(worst, container),
        evidence: {
          kind: 'slow_code',
          stretchMs,
          atMs: worst.start,
          share,
          coverage,
          label: container?.label ?? null,
          before: worst.before ? describe(worst.before) : null,
          after: worst.after ? describe(worst.after) : null,
          spanIds,
          // Filled in afterwards, when the sampling profiler is running: a
          // detector is a pure function of the scope, and reading a profiler
          // is neither pure nor something the scope knows about.
          frames: [],
          busyShare: null,
        },
        hint: hintFor(worst, request),
      },
    ];
  },
};
