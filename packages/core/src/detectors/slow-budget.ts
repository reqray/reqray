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
import type { Finding } from '../types.js';
import { isHttp } from './duplicates.js';
import type { Detector, FinishedRequest } from './types.js';

export interface SlowBudgetOptions {
  /** Wall time above which a request is over budget, milliseconds. */
  readonly budgetMs: number;
}

/** Where the time went, in the words the card uses. */
function breakdown(scope: RequestScope): { externalMs: number; sqlMs: number } {
  let externalMs = 0;
  let sqlMs = 0;
  for (const span of scope.spans) {
    if (isHttp(span)) externalMs += span.duration;
    else if (span.kind === 'db') sqlMs += span.duration;
  }
  return { externalMs, sqlMs };
}

export const slowBudget: Detector<SlowBudgetOptions> = {
  id: 'slow_budget',

  defaultOptions: {
    // The number the panel already treats as "red" in the duration column.
    budgetMs: 700,
  },

  run(scope: RequestScope, options: SlowBudgetOptions, request: FinishedRequest): Finding[] {
    if (request.durationMs <= options.budgetMs) return [];

    const { externalMs, sqlMs } = breakdown(scope);
    const externalShare = Math.round((externalMs / request.durationMs) * 100);
    const sqlShare = Math.round((sqlMs / request.durationMs) * 100);
    const uncovered = Math.max(0, request.durationMs - externalMs - sqlMs);

    // The largest share leads the hint; if nothing instrumented dominates,
    // the honest answer is that the time is in the application's own code.
    const hint =
      externalMs >= sqlMs && externalShare > 0
        ? `${externalShare}% of the time went to external HTTP calls — start there.`
        : sqlShare > 0 && sqlMs > externalMs
          ? `${sqlShare}% of the time went to SQL — start there.`
          : `Most of the time (${Math.round((uncovered / request.durationMs) * 100)}%) is not covered by any instrumentation: it is application code, a timer, or something Loupe does not see.`;

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
          externalMs,
          sqlMs,
          spanIds: [],
        },
        hint,
      },
    ];
  },
};
