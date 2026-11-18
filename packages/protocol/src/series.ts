/**
 * The history screen's contract: one metric over one period.
 *
 * A fixed list of metrics rather than a query language over the store. Every
 * one of them is something Reqray measured and already keeps per request, and
 * the list ends where the measurements do — which is the line between a way
 * of reading a history and a dashboard product.
 */

/** What a column of the history chart can show. */
export type SeriesMetric =
  | 'p50'
  | 'p95'
  | 'p99'
  /** Requests per minute. */
  | 'throughput'
  /** Share of requests that failed, 0 to 1. */
  | 'errorRate'
  /** Mean queries per request. */
  | 'sqlPerRequest'
  /** Mean outgoing calls per request. */
  | 'httpPerRequest'
  /** Mean bytes sent to the client. */
  | 'bytes'
  /** Mean event-loop delay while these requests ran, ms. */
  | 'loopDelay'
  /** Mean findings per request. */
  | 'findingsPerRequest';

/** One metric, one value per column. */
export interface MetricSeries {
  readonly metric: SeriesMetric;
  /**
   * `null` where the column has nothing to answer with.
   *
   * A stretch nobody called is not a zero — drawing it as one invents a floor
   * the traffic never touched. The client draws a void instead.
   */
  readonly values: readonly (number | null)[];
}

/** What a period adds up to, as numbers rather than as a shape. */
export interface SeriesTotals {
  readonly calls: number;
  /** Share of calls that failed, 0 to 1. */
  readonly errorRate: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  /**
   * Wall time inside queries over the whole period, ms.
   *
   * `null` when nothing in the period recorded it — requests stored before
   * the store kept the figure, which is not the same as zero time in SQL.
   */
  readonly sqlMs: number | null;
  /** Wall time covered by no instrumented work, ms. `null` as above. */
  readonly appMs: number | null;
  /** The endpoint called most often in the period. */
  readonly busiest: {
    readonly method: string;
    readonly route: string;
    readonly calls: number;
  } | null;
  /** The detector that fired on the most requests. */
  readonly topFinding: { readonly detector: string; readonly calls: number } | null;
}

/** The answer to one reading of the history screen. */
export interface SeriesResponse {
  /** The period drawn, epoch ms. The columns span exactly this. */
  readonly from: number;
  readonly to: number;
  readonly bucketMs: number;
  /**
   * Requests per column.
   *
   * Carried separately from every metric because it is what tells an empty
   * stretch from a measured zero, and every metric needs that distinction.
   */
  readonly calls: readonly number[];
  readonly series: readonly MetricSeries[];
  readonly totals: SeriesTotals;
  /**
   * The same numbers for the period of equal length immediately before.
   *
   * `null` when the store holds nothing there — a figure with nothing to
   * compare it against is better than one compared with an invented zero.
   */
  readonly previous: SeriesTotals | null;
  /**
   * The primary metric over the period immediately before, same columns.
   *
   * Drawn behind the line as a ghost, so "worse than last week" is a shape
   * rather than a percentage. Only the first metric: a ghost behind each of
   * two lines is four lines on one chart, which is the wall of gauges this
   * screen exists not to be. `null` when nothing ran before the period.
   */
  readonly ghost: readonly (number | null)[] | null;
  /**
   * The store stopped reading before the period ended.
   *
   * Said out loud rather than folded away: a total drawn from the most recent
   * fifty thousand requests of a busier period is a different number from the
   * one the reader thinks they are looking at.
   */
  readonly truncated: boolean;
}
