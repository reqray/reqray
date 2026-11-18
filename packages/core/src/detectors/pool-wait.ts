/**
 * Pool-wait detector: the query did not take that long, it queued for that
 * long.
 *
 * This is the failure a waterfall is worst at showing. A query that waited
 * 338 ms for a free connection and then ran for 2 draws exactly like a query
 * that worked for 340, and the reader goes off to add an index that will not
 * help. The instrumentation measures the queue separately (`waitMs` on the
 * span); this detector is what says out loud that the queue, not the query,
 * was the request's problem.
 *
 * Two things keep it quiet.
 *
 * The driver only records a wait when the pool was genuinely saturated —
 * every connection in use and none left to create. A brand-new connection
 * being established, or an idle one handed over a tick later, is not a
 * queue, and reporting either would send somebody to change `max` when the
 * fix is elsewhere.
 *
 * And waits are counted as a union of intervals, never a sum. Five queries
 * issued through `Promise.all` queue at the same time, and adding their waits
 * together would claim a saving five times the size of the one that exists.
 *
 * The comparison that decides whether to speak — did it wait longer than it
 * ran — is made per query rather than on the totals, and for the same reason
 * in reverse: a saturated pool runs the queries behind the queue one after
 * another, so their durations add up to the whole request. Weighed against
 * that sum, the clearest case of contention there is comes out a coin flip.
 */

import { coveredMs } from '../timing.js';
import type { DbSpan, Finding, FindingSeverity, Span } from '../types.js';
import type { Detector } from './types.js';

export interface PoolWaitOptions {
  /** Below this, the queue is not the story of the request. */
  readonly minWaitMs: number;
  /**
   * How much of a query's wait must exceed its own run for it to count.
   *
   * At `1` the rule is the one the panel states: it waited longer than it
   * ran. Anything below that is a busy pool doing its job.
   *
   * Applied per query, never to the totals. A pool that serialises five
   * queries makes their run times add up to the whole request, and comparing
   * that sum against the waits would turn the plainest case of contention
   * into a coin flip decided by a couple of milliseconds.
   */
  readonly minRatio: number;
}

/** A quarter of a second in a queue is not a busy moment, it is a shortage. */
const SEVERITY_CRITICAL_MS = 250;

function isDb(span: Span): span is DbSpan {
  return span.kind === 'db';
}

function severityFor(waitMs: number): FindingSeverity {
  return waitMs >= SEVERITY_CRITICAL_MS ? 'critical' : 'warn';
}

const HINT =
  'The pool had nothing free to give: every connection was in use and it was already at its limit. ' +
  'Usually the fix is upstream — a transaction held open across an external call, or a query that runs far longer than it needs to. ' +
  'Raising `max` helps only if the database can take the extra connections.';

export const poolWait: Detector<PoolWaitOptions> = {
  id: 'pool_wait',

  defaultOptions: {
    // Fifty milliseconds is where a queue stops being scheduling noise and
    // starts being something a reader can act on.
    minWaitMs: 50,
    minRatio: 1,
  },

  run(scope, options): Finding[] {
    const waited: DbSpan[] = [];
    for (const span of scope.spans) {
      if (!isDb(span)) continue;
      const wait = span.waitMs;
      if (wait === null || wait <= 0) continue;
      // Only the queries the queue, rather than the database, held up.
      if (wait <= span.duration * options.minRatio) continue;
      waited.push(span);
    }
    if (waited.length === 0) return [];

    // Concurrent queries queue concurrently: the request lost the union of
    // the waits, not their sum.
    const waitMs = coveredMs(
      waited.map((span) => ({ start: span.startedAt - (span.waitMs ?? 0), end: span.startedAt })),
    );
    if (waitMs < options.minWaitMs) return [];

    const runMs = coveredMs(
      waited.map((span) => ({ start: span.startedAt, end: span.startedAt + span.duration })),
    );

    let worst = waited[0] as DbSpan;
    for (const span of waited) {
      if ((span.waitMs ?? 0) > (worst.waitMs ?? 0)) worst = span;
    }

    const queries = waited.length;
    return [
      {
        detector: 'pool_wait',
        severity: severityFor(waitMs),
        title: `${queries === 1 ? 'A query' : `${queries} queries`} waited ${Math.round(waitMs)} ms for a free connection`,
        // Real time, and this request's own: had a connection been free, it
        // would have started that much sooner.
        costMs: waitMs,
        callsite: worst.callsite,
        evidence: {
          kind: 'pool_wait',
          waitMs,
          runMs,
          queries,
          sample: worst.sql.replace(/\s+/g, ' ').trim(),
          spanIds: waited.map((span) => span.id),
        },
        hint: HINT,
      },
    ];
  },
};
