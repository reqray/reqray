/**
 * Per-route aggregates.
 *
 * The request list answers "what happened just now"; this answers "which
 * endpoint is expensive". It is computed over whatever the store still holds,
 * which is a dev session rather than a statistically sound window — the
 * numbers are for spotting the obvious offender, not for a capacity plan, and
 * the screen says as much by showing the sample count next to them.
 */

import type { RecordedRequest } from '../types.js';

/** One row of the routes table. */
export interface RouteStats {
  /** `GET /api/orders/:id` — method and normalized path. */
  readonly method: string;
  readonly route: string;
  readonly calls: number;
  /** Calls per second over the retained window. */
  readonly rps: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  /** Share of calls that failed, as a percentage. */
  readonly errorRate: number;
  /** Mean SQL queries per call. */
  readonly sqlAvg: number;
  /** Share of all recorded request time this route accounts for, percent. */
  readonly timeShare: number;
}

export interface RoutesReport {
  readonly routes: readonly RouteStats[];
  /** How many requests the numbers are based on. */
  readonly samples: number;
  /** The span of time they cover, milliseconds. */
  readonly windowMs: number;
}

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

interface Accumulator {
  method: string;
  route: string;
  durations: number[];
  errors: number;
  sql: number;
  totalMs: number;
}

/** Aggregates the retained requests by normalized route. */
export function routeStats(requests: readonly RecordedRequest[]): RoutesReport {
  if (requests.length === 0) return { routes: [], samples: 0, windowMs: 0 };

  const byRoute = new Map<string, Accumulator>();
  let overallMs = 0;
  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;

  for (const request of requests) {
    const route = normalizeRoute(request.path);
    const key = `${request.method} ${route}`;
    let bucket = byRoute.get(key);
    if (!bucket) {
      bucket = { method: request.method, route, durations: [], errors: 0, sql: 0, totalMs: 0 };
      byRoute.set(key, bucket);
    }

    bucket.durations.push(request.durationMs);
    bucket.totalMs += request.durationMs;
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
      timeShare: overallMs > 0 ? (bucket.totalMs / overallMs) * 100 : 0,
    };
  });

  // Most expensive first — the order the screen opens in.
  routes.sort((a, b) => b.timeShare - a.timeShare);
  return { routes, samples: requests.length, windowMs };
}
