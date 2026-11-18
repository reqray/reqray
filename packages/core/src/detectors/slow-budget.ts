/**
 * Budget detector: this request took longer than the page can afford.
 *
 * The other detectors name a specific mistake. This one names a fact — the
 * request went over budget — and then says where the time went, because
 * "slow" without a direction is not worth a card. It only fires when the
 * request is genuinely over the line, so the screen stays quiet on a healthy
 * session.
 */

import type { RequestScope } from '../scope.js';
import { coveredMs, timingOf } from '../timing.js';
import type { Finding } from '../types.js';
import type { Detector, FinishedRequest } from './types.js';

export interface SlowBudgetOptions {
  /** Wall time above which a request is over budget, milliseconds. */
  readonly budgetMs: number;
}

/**
 * Where the time went — the same arithmetic the header line uses.
 *
 * Unions rather than sums, so a `Promise.all` of four 200 ms calls inside a
 * 300 ms request is 300 ms of waiting and not 800 ms of it. A hint drawn from
 * a figure larger than the request it describes is worse than no hint.
 */
function breakdown(scope: RequestScope, durationMs: number) {
  return timingOf(scope.spans, durationMs);
}

/**
 * Of the time spent in the database layer, how much was spent queueing.
 *
 * A union, like everything else here: queries issued together queue together.
 */
function queuedMs(scope: RequestScope): number {
  const waits: Array<{ start: number; end: number }> = [];
  for (const span of scope.spans) {
    if (span.kind !== 'db' || !span.waitMs) continue;
    waits.push({ start: span.startedAt - span.waitMs, end: span.startedAt });
  }
  return waits.length === 0 ? 0 : coveredMs(waits);
}

/** Above this share, the queue rather than the layer is what to look at. */
const MOSTLY_QUEUE = 0.5;

export const slowBudget: Detector<SlowBudgetOptions> = {
  id: 'slow_budget',

  defaultOptions: {
    // The number the panel already treats as "red" in the duration column.
    budgetMs: 700,
  },

  run(scope: RequestScope, options: SlowBudgetOptions, request: FinishedRequest): Finding[] {
    if (request.durationMs <= options.budgetMs) return [];

    const timing = breakdown(scope, request.durationMs);
    const share = (ms: number) => Math.round((ms / request.durationMs) * 100);

    // The layer that actually holds the time leads the hint — the largest
    // one, not the first one that is above zero. A request that spent 99% of
    // itself in application code must not be sent to look at the one query
    // that took a millisecond.
    const layers: Array<[string, number]> = [
      ['external HTTP calls', timing.externalMs],
      ['SQL', timing.sqlMs],
      ['the cache', timing.cacheMs],
    ];
    const [label, ms] = layers.reduce((most, layer) => (layer[1] > most[1] ? layer : most));

    // A layer can hold the time without being the reason for it. Queries
    // that spent most of their lives waiting for a free connection put the
    // whole wait under "SQL", and sending the reader to the queries would be
    // sending them past the finding directly above this one.
    const queued = label === 'SQL' ? queuedMs(scope) : 0;

    const hint =
      ms <= timing.selfMs
        ? `Most of the time (${share(timing.selfMs)}%) is not covered by any instrumentation: it is application code, a timer, or something Reqray does not see.`
        : queued > ms * MOSTLY_QUEUE
          ? `${share(ms)}% of the time went to SQL — but ${share(queued)}% of the request was queueing for a free connection, not querying. The pool is the constraint, not the query.`
          : `${share(ms)}% of the time went to ${label} — start there.`;

    return [
      {
        detector: 'slow_budget',
        severity: 'warn',
        title: `Over the ${options.budgetMs} ms budget`,
        // The overshoot: what would have to go for the request to fit.
        costMs: request.durationMs - options.budgetMs,
        callsite: null,
        evidence: {
          kind: 'budget',
          durationMs: request.durationMs,
          budgetMs: options.budgetMs,
          externalMs: timing.externalMs,
          sqlMs: timing.sqlMs,
          spanIds: [],
        },
        hint,
      },
    ];
  },
};
