/**
 * How one call compares against the route's own history.
 *
 * A duration on its own says nothing. 400 ms is alarming for a cache read and
 * excellent for a report, so the only comparison worth drawing is against
 * other calls of the same route — and only when there are enough of them for
 * the comparison to be worth more than the silence it replaces.
 */

import type { DurationBaseline, RecordedRequest } from '../types.js';
import type { DurationSample } from './api.js';
import { normalizeRoute, percentile } from './routes.js';

/**
 * Below this a percentile is one call wearing a statistic's name.
 *
 * Twenty is where the ninety-fifth percentile stops being the single slowest
 * sample and starts interpolating between two — the point at which "slower
 * than 95% of calls" is a claim about a distribution rather than about the
 * one unlucky call that happens to top the list.
 */
const MIN_FOR_P95 = 20;

/** Below this the request would be measuring itself. */
const MIN_SAMPLES = 2;

/** What the store is asked for when a request is judged against its route. */
export interface BaselineQuery {
  readonly method: string;
  /** The normalized route, as `normalizeRoute` produces it. */
  readonly route: string;
  /**
   * The request being judged — it is never part of its own baseline.
   *
   * Left out when the caller wants the route's whole history: the charts do,
   * and a chart with one call missing from it would be a different kind of
   * lie from the one this field prevents.
   */
  readonly excludeId?: string;
  /**
   * The stretch to read, epoch ms.
   *
   * Left out for the whole history. The charts pass the same window the
   * routes table was computed over: a table describing thirteen minutes above
   * a chart describing six hours is two answers to one question.
   */
  readonly from?: number;
  readonly to?: number;
}

/**
 * The verdict, or `null` when there is nothing honest to say.
 *
 * @param samples the route's other calls, as the store hands them over.
 * `undefined` is a store that cannot answer at all, and produces no verdict
 * rather than one drawn from whatever page happened to be loaded.
 */
export function baselineFor(
  request: RecordedRequest,
  samples: readonly DurationSample[] | undefined,
): DurationBaseline | null {
  if (!samples || samples.length < MIN_SAMPLES) return null;

  const sorted = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const avgMs = sum / sorted.length;

  const times = samples.map((sample) => sample.startedAt);
  const windowMs = Math.max(...times) - Math.min(...times);

  const p95Ms = sorted.length >= MIN_FOR_P95 ? percentile(sorted, 0.95) : null;
  const p50Ms = percentile(sorted, 0.5);
  const p99Ms = sorted.length >= MIN_FOR_P95 ? percentile(sorted, 0.99) : null;
  const maxMs = sorted[sorted.length - 1] ?? 0;

  // Without a trustworthy p95 the strongest claim available is "at or under
  // the mean", which roughly half of all calls are. Calling anything slow off
  // five samples is how a tool starts crying wolf.
  const verdict =
    p95Ms !== null && request.durationMs >= p95Ms
      ? 'slower'
      : request.durationMs <= avgMs
        ? 'faster'
        : 'typical';

  return {
    method: request.method,
    route: normalizeRoute(request.path),
    samples: sorted.length,
    windowMs,
    avgMs,
    p95Ms,
    p50Ms,
    p99Ms,
    maxMs,
    verdict,
  };
}
