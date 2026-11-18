/**
 * The strip above the list, and what one of its columns opens into.
 *
 * `GET /api/timeline` draws the shape of the traffic; `GET /api/timeline/at`
 * answers the only question worth asking of a column — what was different
 * then. They are one flow, so they share a file: a client that draws the
 * strip is the client that will ask about a column of it.
 */

/** One column of the strip. The three counts never double-count. */
export interface TimelineBucket {
  /** Failed. */
  readonly err: number;
  /** Slow, but not failed. */
  readonly slow: number;
  readonly rest: number;
  readonly total: number;
}

/** The strip, and the stretch of time it covers. */
export interface TimelineReport {
  /** Oldest and newest request the store holds, epoch ms. */
  readonly from: number;
  readonly to: number;
  readonly buckets: readonly TimelineBucket[];
}

/**
 * A route that behaved unlike itself in the moment being asked about.
 *
 * Ranked by how far it strayed from its own behaviour, never by volume: by
 * volume the busiest endpoint tops every list and the moment explains nothing.
 */
export interface Outlier {
  readonly method: string;
  readonly route: string;
  readonly calls: number;
  readonly avgMs: number;
  /** How many times its usual rate it ran at, or `null` when it is new. */
  readonly rateRatio: number | null;
  /** How many times its usual duration it took, or `null` when it is new. */
  readonly slowerRatio: number | null;
  /** It did not run at all in the rest of the window. */
  readonly firstSeen: boolean;
}

/** What was unusual in a moment, and how the question was answered. */
export interface ActivityReport {
  readonly from: number;
  readonly to: number;
  /** Calls in the moment, across every route. */
  readonly calls: number;
  /**
   * How much busier the moment was than the rest of the window, overall.
   *
   * `null` when there is no rest to compare against. This is the figure every
   * route is judged against: if the whole application ran six times as often
   * here, a route that ran six times as often did nothing unusual — the
   * traffic simply arrived — and a list of every endpoint is not an answer.
   */
  readonly rateRatio: number | null;
  /** Ranked, most unlike itself first. Empty means nothing stood out. */
  readonly outliers: readonly Outlier[];
}
