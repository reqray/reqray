/**
 * What ran here.
 *
 * A chart nobody can click is decoration. Clicking a moment on one should
 * answer the only question worth asking of it — what was different then —
 * and the answer has to be ranked by *how far each route strayed from its own
 * behaviour*, not by how much traffic it had. Ranked by volume, the busiest
 * endpoint tops every list and the moment explains nothing.
 *
 * Every route is compared against itself over the rest of the window, so a
 * spike does not inflate the baseline it is being measured against. When
 * nothing stands out, the answer is that nothing did: whatever moved the
 * chart came from garbage collection, a neighbour on the box, or the host —
 * and a list of ordinary routes presented as an explanation is worse than a
 * sentence admitting there is none.
 */

import type { ActivityReport, Outlier } from '@reqray/protocol';

export type { ActivityReport, Outlier };

/** One route's traffic over a stretch of time, as the store groups it. */
export interface RouteWindow {
  readonly method: string;
  readonly route: string;
  readonly calls: number;
  /** Mean duration over those calls, ms. */
  readonly avgMs: number;
}

/**
 * Calls a route needs in the moment before it can be called unusual.
 *
 * Two calls that happened to be slow are two calls that happened to be slow.
 */
const MIN_CALLS = 3;

/**
 * How far from its own baseline a route has to be.
 *
 * Half again, on either rate or duration. Below that the difference is inside
 * the noise of a handful of calls, and a list that includes it is a list of
 * everything that ran.
 */
const MIN_RATIO = 1.5;

/**
 * How many calls above its usual count a route has to be.
 *
 * A ratio alone is not enough at low rates: a route called twice a minute
 * that happens to be called three times has run at 1.5× its rate and nothing
 * has happened. Three extra calls is the smallest excess that is a count
 * rather than a rounding of one.
 */
const MIN_EXCESS_CALLS = 3;

/**
 * How much slower, in milliseconds, before a ratio means anything.
 *
 * A route that goes from 0.2 ms to 0.4 ms has doubled and nobody has noticed.
 * Five milliseconds is the smallest difference somebody could experience, and
 * below it a ratio is reporting the jitter of the clock.
 */
const MIN_EXCESS_MS = 5;

/**
 * What stood out in one stretch of time.
 *
 * @param moment routes grouped over the clicked stretch.
 * @param overall the same, over the whole window the chart covers — the
 * moment included, and subtracted here so a spike is not its own baseline.
 */
export function whatRanAt(
  moment: readonly RouteWindow[],
  overall: readonly RouteWindow[],
  window: { from: number; to: number; overallMs: number },
): ActivityReport {
  const before = new Map(overall.map((entry) => [`${entry.method} ${entry.route}`, entry]));
  const momentMs = Math.max(1, window.to - window.from);
  // The rest of the window: what the route usually does, with the moment
  // taken out of it. Never negative, and never zero as a divisor.
  const restMs = Math.max(1, window.overallMs - momentMs);

  // How the moment compares as a whole. Bursty traffic — a demo restarting, a
  // cron waking up, a deploy draining a queue — lifts every route at once, and
  // without this every route is an outlier in every burst.
  const momentCalls = moment.reduce((total, entry) => total + entry.calls, 0);
  const overallCalls = overall.reduce((total, entry) => total + entry.calls, 0);
  const restOverall = Math.max(0, overallCalls - momentCalls);
  const overallRatio = restOverall > 0 ? momentCalls / momentMs / (restOverall / restMs) : null;

  /**
   * How much busier the moment was for everything *except* this route.
   *
   * Each route is judged against how the rest of the traffic moved, not
   * against the total it is part of — otherwise a route that is the only
   * thing running compares against itself and can never stand out, which is
   * exactly the case where it obviously does.
   */
  const withoutRatio = (entry: RouteWindow, restCalls: number): number | null => {
    const otherMoment = momentCalls - entry.calls;
    const otherRest = restOverall - restCalls;
    if (otherMoment <= 0 || otherRest <= 0) return null;
    return otherMoment / momentMs / (otherRest / restMs);
  };

  const outliers: Outlier[] = [];
  for (const entry of moment) {
    if (entry.calls < MIN_CALLS) continue;

    const all = before.get(`${entry.method} ${entry.route}`);
    const restCalls = Math.max(0, (all?.calls ?? 0) - entry.calls);

    // Never ran outside this moment: not a ratio, a fact.
    if (restCalls === 0) {
      outliers.push({
        method: entry.method,
        route: entry.route,
        calls: entry.calls,
        avgMs: entry.avgMs,
        rateRatio: null,
        slowerRatio: null,
        firstSeen: true,
      });
      continue;
    }

    const rate = restCalls / restMs;
    const rateRatio = entry.calls / momentMs / rate;
    // What this moment would have held if the route had simply grown with
    // everything else. The excess over *that* is the part worth reporting,
    // and at low rates it is what tells a burst from a coin toss.
    const others = withoutRatio(entry, restCalls);
    const expected = rate * momentMs * (others ?? 1);
    // The route against how the rest of the traffic moved: one means it rose
    // exactly as much as everything around it, which is not an answer to
    // "what was different here".
    const shareRatio = others === null ? rateRatio : rateRatio / others;
    // The mean over the rest, recovered from the totals: the store grouped
    // once, and asking it twice for overlapping ranges would cost a scan to
    // learn something arithmetic already knows.
    const restAvg =
      all && all.calls > 0
        ? Math.max(0, (all.avgMs * all.calls - entry.avgMs * entry.calls) / restCalls)
        : 0;
    const slowerRatio = restAvg > 0 ? entry.avgMs / restAvg : null;

    const busier = shareRatio >= MIN_RATIO && entry.calls - expected >= MIN_EXCESS_CALLS;
    const slower =
      slowerRatio !== null && slowerRatio >= MIN_RATIO && entry.avgMs - restAvg >= MIN_EXCESS_MS;
    if (!busier && !slower) continue;

    outliers.push({
      method: entry.method,
      route: entry.route,
      calls: entry.calls,
      avgMs: entry.avgMs,
      rateRatio,
      slowerRatio,
      firstSeen: false,
    });
  }

  const strength = (outlier: Outlier): number =>
    outlier.firstSeen
      ? Number.POSITIVE_INFINITY
      : Math.max(outlier.rateRatio ?? 0, outlier.slowerRatio ?? 0);

  return {
    from: window.from,
    to: window.to,
    calls: momentCalls,
    rateRatio: overallRatio,
    outliers: outliers.sort((a, b) => strength(b) - strength(a)),
  };
}
