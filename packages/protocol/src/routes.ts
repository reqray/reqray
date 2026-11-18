/**
 * `GET /api/routes` and `GET /api/routes/:method/:route/series` — the routes
 * screen and the three charts one row opens into.
 *
 * The aggregates are computed over whatever the store still holds, which is a
 * session rather than a statistically sound window. That is a property of the
 * answer, not a caveat to add at display time: `samples` and `windowMs` travel
 * with it so a client can say what the numbers rest on.
 */

import type { Callsite } from './record.js';

/**
 * A detector that fired on a route, with what it cost the route.
 *
 * One entry per detector rather than per occurrence: the column is a set of
 * badges, and the expansion needs the freshest occurrence's own words.
 */
export interface RouteFinding {
  readonly detector: string;
  /** How many of the route's calls it fired on. */
  readonly calls: number;
  /** Milliseconds that come back across those calls. */
  readonly recoverableMs: number;
  /** From the most recent occurrence — a count in it must not be stale. */
  readonly title: string;
  readonly hint: string;
  readonly callsite: Callsite | null;
}

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
  /**
   * Mean bytes returned per call, over the calls that said how many.
   *
   * `null` when none of them did. Averaging a silent response in as zero
   * would rank the endpoint that returns megabytes below the one that
   * returns a status code.
   */
  readonly bytesAvg: number | null;
  /** Share of all recorded request time this route accounts for, percent. */
  readonly timeShare: number;
  /**
   * What the detectors found here, costliest first.
   *
   * The reason to visit this screen: a table of latencies says which endpoint
   * is expensive, and this says whether anybody already knows why. Muted
   * patterns are left out — muting is presentation, and this is a shout.
   */
  readonly findings: readonly RouteFinding[];
  /**
   * Calls per column over the window, ten of them.
   *
   * A shape, not a series: whether this endpoint is steady, bursty, or was
   * called twice an hour ago and never since.
   */
  readonly trend: readonly number[];
}

/** `GET /api/routes`. */
export interface RoutesReport {
  readonly routes: readonly RouteStats[];
  /** How many requests the numbers are based on. */
  readonly samples: number;
  /** The span of time they cover, milliseconds. */
  readonly windowMs: number;
  /**
   * The oldest and newest request behind them, epoch ms.
   *
   * So that a chart drawn beside this table covers the same stretch: a table
   * describing thirteen minutes above a chart describing six hours is two
   * answers to one question.
   */
  readonly from: number;
  readonly to: number;
}

/** One column of a route's chart. */
export interface SeriesBucket {
  /** When the column starts, epoch ms. */
  readonly at: number;
  readonly calls: number;
  readonly errors: number;
  /**
   * Percentiles over the calls in this column.
   *
   * Zero when there were none — a column with no traffic is a gap, and a
   * client draws it as one rather than as a line falling to the floor.
   */
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

/** A route's three charts, as one answer. */
export interface RouteSeries {
  readonly method: string;
  readonly route: string;
  /** The stretch the columns cover, epoch ms. */
  readonly from: number;
  readonly to: number;
  /** How long one column is, ms — what throughput is per. */
  readonly bucketMs: number;
  readonly calls: number;
  readonly buckets: readonly SeriesBucket[];
}
