/**
 * Per-route aggregates.
 *
 * The request list answers "what happened just now"; this answers "which
 * endpoint is expensive". It is computed over whatever the store still holds,
 * which is a dev session rather than a statistically sound window — the
 * numbers are for spotting the obvious offender, not for a capacity plan, and
 * the screen says as much by showing the sample count next to them.
 */

import type { Callsite, RouteFinding, RouteStats, RoutesReport } from '@reqray/protocol';
import type { RecordedRequest } from '../types.js';
import { patternKey } from './findings.js';

export type { RouteFinding, RouteStats, RoutesReport };

/**
 * How many columns a route's sparkline is cut into.
 *
 * Ten: enough to see a shape, few enough that one column of a short window
 * still holds calls rather than drawing a comb of ones and zeroes.
 */
export const TREND_BUCKETS = 10;

/**
 * Collapses the variable parts of a path.
 *
 * Per segment rather than by regex over the whole path, so that a route with
 * several ids normalizes cleanly. A hex token must contain a digit to count
 * as an id: otherwise ordinary words like `feed` or `cafe` would normalize
 * away and two unrelated routes would merge into one row.
 */
export function normalizeRoute(path: string): string {
  return path
    .split('?')[0]
    ?.split('/')
    .map((segment) => {
      if (/^\d+$/.test(segment)) return ':id';
      if (/^\d{4}-\d{2}/.test(segment)) return ':date';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
        return ':id';
      }
      if (/^[0-9a-f]{4,}$/i.test(segment) && /\d/.test(segment)) return ':id';
      return segment;
    })
    .join('/') as string;
}

/**
 * A percentile with linear interpolation between neighbouring samples.
 *
 * Index-based selection would collapse p95 and p99 onto the same sample at
 * the sample counts a dev session produces, and two columns showing the same
 * number are worse than one.
 *
 * @param sorted values in ascending order.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] as number;

  const position = p * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] as number;
  if (lower === upper) return low;
  const high = sorted[upper] as number;
  return low + (high - low) * (position - lower);
}

/** One detector's tally on one route, while it is being accumulated. */
interface FoundHere {
  calls: number;
  recoverableMs: number;
  /** When the occurrence that supplied the words happened. */
  at: number;
  title: string;
  hint: string;
  callsite: Callsite | null;
}

interface Accumulator {
  method: string;
  route: string;
  durations: number[];
  errors: number;
  sql: number;
  totalMs: number;
  bytes: number;
  /** Calls that reported a size — the divisor for the average. */
  weighed: number;
  /** Per detector, accumulated across the route's calls. */
  findings: Map<string, FoundHere>;
  /** When each call started — bucketed into the trend once the window is known. */
  starts: number[];
}

/**
 * Aggregates the retained requests by normalized route.
 *
 * @param muted pattern ids the reader silenced, as {@link patternKey} spells
 * them. Their findings stay on the records and out of this table: the column
 * is a shout, and a muted pattern has been told to stop shouting.
 */
export function routeStats(
  requests: readonly RecordedRequest[],
  muted: ReadonlySet<string> = new Set(),
): RoutesReport {
  if (requests.length === 0) {
    return { routes: [], samples: 0, windowMs: 0, from: 0, to: 0 };
  }

  const byRoute = new Map<string, Accumulator>();
  let overallMs = 0;
  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;

  for (const request of requests) {
    const route = normalizeRoute(request.path);
    const key = `${request.method} ${route}`;
    let bucket = byRoute.get(key);
    if (!bucket) {
      bucket = {
        method: request.method,
        route,
        durations: [],
        errors: 0,
        sql: 0,
        totalMs: 0,
        bytes: 0,
        weighed: 0,
        findings: new Map(),
        starts: [],
      };
      byRoute.set(key, bucket);
    }

    bucket.durations.push(request.durationMs);
    bucket.starts.push(request.startedAt);

    for (const finding of request.findings) {
      if (
        muted.has(
          patternKey({
            detector: finding.detector,
            callsite: finding.callsite,
            method: request.method,
            route,
          }),
        )
      ) {
        continue;
      }
      const seen = bucket.findings.get(finding.detector);
      if (seen) {
        seen.calls++;
        seen.recoverableMs += finding.costMs;
        // The freshest occurrence speaks: "150 identical queries" must not be
        // last week's count.
        if (request.startedAt >= seen.at) {
          seen.at = request.startedAt;
          seen.title = finding.title;
          seen.hint = finding.hint;
          seen.callsite = finding.callsite;
        }
        continue;
      }
      bucket.findings.set(finding.detector, {
        calls: 1,
        recoverableMs: finding.costMs,
        at: request.startedAt,
        title: finding.title,
        hint: finding.hint,
        callsite: finding.callsite,
      });
    }
    bucket.totalMs += request.durationMs;
    const bytesOut = request.weight?.bytesOut ?? null;
    if (bytesOut !== null) {
      bucket.bytes += bytesOut;
      bucket.weighed++;
    }
    if (request.error !== null || request.status >= 500) bucket.errors++;
    for (const span of request.spans) {
      if (span.kind === 'db') bucket.sql++;
    }

    overallMs += request.durationMs;
    if (request.startedAt < oldest) oldest = request.startedAt;
    if (request.startedAt > newest) newest = request.startedAt;
  }

  // A single request spans no time; one second keeps rps finite and honest.
  const windowMs = Math.max(1_000, newest - oldest);

  const routes = [...byRoute.values()].map((bucket): RouteStats => {
    const sorted = [...bucket.durations].sort((a, b) => a - b);
    const calls = sorted.length;

    // The shape of the traffic, over the same window every other row uses —
    // so two sparklines on this screen are comparable by eye.
    const trend = new Array<number>(TREND_BUCKETS).fill(0);
    const span = Math.max(1, newest - oldest);
    for (const at of bucket.starts) {
      const index = Math.min(TREND_BUCKETS - 1, Math.floor(((at - oldest) / span) * TREND_BUCKETS));
      trend[index] = (trend[index] ?? 0) + 1;
    }

    return {
      method: bucket.method,
      route: bucket.route,
      calls,
      rps: calls / (windowMs / 1_000),
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      errorRate: (bucket.errors / calls) * 100,
      sqlAvg: bucket.sql / calls,
      bytesAvg: bucket.weighed > 0 ? bucket.bytes / bucket.weighed : null,
      timeShare: overallMs > 0 ? (bucket.totalMs / overallMs) * 100 : 0,
      findings: [...bucket.findings.entries()]
        .map(([detector, found]) => ({
          detector,
          calls: found.calls,
          recoverableMs: found.recoverableMs,
          title: found.title,
          hint: found.hint,
          callsite: found.callsite,
        }))
        .sort((a, b) => b.recoverableMs - a.recoverableMs || b.calls - a.calls),
      trend,
    };
  });

  // Most expensive first — the order the screen opens in.
  routes.sort((a, b) => b.timeShare - a.timeShare);
  return { routes, samples: requests.length, windowMs, from: oldest, to: newest };
}
