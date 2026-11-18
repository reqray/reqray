/**
 * One metric over one period, and what the period adds up to.
 *
 * Everything else the panel draws is scoped to something: the strip above the
 * list counts requests and nothing else, and stage 41's charts cover one route
 * at a time. This is the screen that answers "what did latency do this week",
 * and the arithmetic behind it lives here — once, for every store.
 *
 * **Why the store hands over rows rather than answers.** The obvious division
 * of labour is to let SQLite compute percentiles in SQL, and the obvious cost
 * is two implementations of the same statistic that quietly disagree: one
 * interpolating between neighbouring samples, the other picking the nearest
 * rank. So a store hands back a few numbers per request — the shape below,
 * never the payloads — and the bucketing and the percentiles happen here. The
 * rule the plan actually cares about still holds: a week of rows must never
 * reach the browser to have a median taken at the other end.
 *
 * What a store *is* responsible for is not reading its whole history into
 * memory. It reads a bounded number of rows and says when it stopped, and
 * this file passes that admission on rather than presenting a truncated total
 * as a complete one.
 */

import type { MetricSeries, SeriesMetric, SeriesResponse, SeriesTotals } from '@reqray/protocol';
import type { RecordedRequest } from '../types.js';
import type { RequestFilter } from './filters.js';
import { normalizeRoute, percentile } from './routes.js';
import { bucketIndex } from './timeline.js';

/**
 * One request, as a history reading needs it.
 *
 * Ten numbers rather than a record: a period is tens of thousands of requests,
 * and parsing that many JSON documents to look at one field in each is how a
 * screen becomes slower than the question it answers.
 */
export interface HistorySample {
  readonly startedAt: number;
  readonly durationMs: number;
  readonly hasError: boolean;
  readonly sqlCount: number;
  readonly httpCount: number;
  readonly bytes: number;
  /** Mean event-loop delay while it ran, or `null` when nothing measured it. */
  readonly loopDelayMs: number | null;
  readonly findingCount: number;
  /** Time inside queries, ms. `null` for requests stored before it was kept. */
  readonly sqlMs: number | null;
  /** Time covered by no instrumented work, ms. `null` as above. */
  readonly selfMs: number | null;
  readonly method: string;
  readonly route: string;
  /** The detector the list flags this request with, when one fired. */
  readonly flag: string | null;
}

/**
 * One request, reduced to what a history reading needs.
 *
 * For every store that keeps whole records — the in-memory ring, and any
 * store answering from `list()` — so that what the screen shows does not
 * depend on which one is behind it.
 */
export function historySampleOf(request: RecordedRequest): HistorySample {
  let sqlCount = 0;
  let httpCount = 0;
  for (const span of request.spans) {
    if (span.kind === 'db') sqlCount++;
    else if (span.kind === 'http') httpCount++;
  }

  return {
    startedAt: request.startedAt,
    durationMs: request.durationMs,
    hasError: request.error !== null || request.status >= 500,
    sqlCount,
    httpCount,
    bytes: request.weight?.bytesOut ?? 0,
    loopDelayMs: request.host?.loopDelayMs ?? null,
    findingCount: request.findings.length,
    sqlMs: request.timing?.sqlMs ?? null,
    selfMs: request.timing?.selfMs ?? null,
    method: request.method,
    route: normalizeRoute(request.path),
    // The same rule the list flags a row by: the costliest finding names it.
    flag: [...request.findings].sort((a, b) => b.costMs - a.costMs)[0]?.detector ?? null,
  };
}

/** What a store is asked for. */
export interface HistoryQuery {
  /** Epoch ms, inclusive. */
  readonly from: number;
  /** Epoch ms, inclusive. */
  readonly to: number;
  /** The same filter the list uses, so a metric can be asked about one route. */
  readonly filter: RequestFilter;
}

/** What a store answers with. */
export interface HistorySamples {
  readonly samples: readonly HistorySample[];
  /** The store stopped reading before the period ended. */
  readonly truncated: boolean;
}

/** Columns the chart is drawn with, unless the caller asks for fewer. */
export const SERIES_COLUMNS = 48;

/**
 * Below this many requests per column a percentile is not a statistic.
 *
 * The same figure stage 41 settled on for a route's charts: a p95 over three
 * samples is the slowest of three, and a chart of those jumps about saying
 * nothing.
 */
const MIN_PER_COLUMN = 6;

/** Below this the chart stops being a shape and becomes a row of bars. */
const MIN_COLUMNS = 8;

/** A column of the chart, while it is being filled. */
interface Column {
  readonly durations: number[];
  errors: number;
  sqlCount: number;
  httpCount: number;
  bytes: number;
  findings: number;
  loopTotal: number;
  loopSamples: number;
}

function emptyColumn(): Column {
  return {
    durations: [],
    errors: 0,
    sqlCount: 0,
    httpCount: 0,
    bytes: 0,
    findings: 0,
    loopTotal: 0,
    loopSamples: 0,
  };
}

/** The value of one metric in one column, or `null` when it cannot say. */
function metricValue(metric: SeriesMetric, column: Column, bucketMs: number): number | null {
  const calls = column.durations.length;
  // Nothing ran here. Every metric returns a void rather than a zero: a
  // stretch nobody called did not have an error rate of nought.
  if (calls === 0) return null;

  switch (metric) {
    case 'p50':
    case 'p95':
    case 'p99': {
      const sorted = [...column.durations].sort((a, b) => a - b);
      const p = metric === 'p50' ? 0.5 : metric === 'p95' ? 0.95 : 0.99;
      return percentile(sorted, p);
    }
    case 'throughput':
      return bucketMs > 0 ? (calls / bucketMs) * 60_000 : null;
    case 'errorRate':
      return column.errors / calls;
    case 'sqlPerRequest':
      return column.sqlCount / calls;
    case 'httpPerRequest':
      return column.httpCount / calls;
    case 'bytes':
      return column.bytes / calls;
    case 'loopDelay':
      // Only the requests that carried a reading. A process that was never
      // measured must not average in as calm.
      return column.loopSamples > 0 ? column.loopTotal / column.loopSamples : null;
    case 'findingsPerRequest':
      return column.findings / calls;
    default:
      return null;
  }
}

/** Everything a period adds up to. */
export function totalsOf(samples: readonly HistorySample[]): SeriesTotals {
  if (samples.length === 0) {
    return {
      calls: 0,
      errorRate: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      sqlMs: null,
      appMs: null,
      busiest: null,
      topFinding: null,
    };
  }

  const durations: number[] = [];
  let errors = 0;
  let sqlMs = 0;
  let appMs = 0;
  let timed = 0;
  const routes = new Map<string, { method: string; route: string; calls: number }>();
  const findings = new Map<string, number>();

  for (const sample of samples) {
    durations.push(sample.durationMs);
    if (sample.hasError) errors++;
    if (sample.sqlMs !== null && sample.selfMs !== null) {
      sqlMs += sample.sqlMs;
      appMs += sample.selfMs;
      timed++;
    }

    const key = `${sample.method} ${sample.route}`;
    const seen = routes.get(key);
    if (seen) seen.calls++;
    else routes.set(key, { method: sample.method, route: sample.route, calls: 1 });

    if (sample.flag) findings.set(sample.flag, (findings.get(sample.flag) ?? 0) + 1);
  }

  durations.sort((a, b) => a - b);

  let busiest: SeriesTotals['busiest'] = null;
  for (const entry of routes.values()) {
    if (!busiest || entry.calls > busiest.calls) busiest = { ...entry };
  }

  let topFinding: SeriesTotals['topFinding'] = null;
  for (const [detector, calls] of findings) {
    if (!topFinding || calls > topFinding.calls) topFinding = { detector, calls };
  }

  return {
    calls: samples.length,
    errorRate: errors / samples.length,
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    p99: percentile(durations, 0.99),
    // Reported only when something recorded it. A period half of whose
    // requests predate the figure would otherwise show a share of SQL time
    // that is half of the truth and looks like a fall.
    sqlMs: timed > 0 ? sqlMs : null,
    appMs: timed > 0 ? appMs : null,
    busiest,
    topFinding,
  };
}

/**
 * How many columns a period's traffic can support.
 *
 * Never more than asked for, never so many that each holds a handful of
 * requests — see {@link MIN_PER_COLUMN}.
 */
export function columnsFor(sampleCount: number, asked: number): number {
  if (asked <= 0) return 0;
  return Math.max(
    Math.min(MIN_COLUMNS, asked),
    Math.min(asked, Math.ceil(sampleCount / MIN_PER_COLUMN)),
  );
}

export interface HistoryOptions {
  /** The period, as the caller chose it — not as the data happens to fall. */
  readonly from: number;
  readonly to: number;
  readonly metrics: readonly SeriesMetric[];
  readonly columns?: number;
}

/**
 * Builds the answer for one reading of the screen.
 *
 * The period comes from the caller rather than from the samples: a week with
 * traffic in one hour of it must draw a week with one column in it, not an
 * hour stretched across the screen.
 */
/** Samples into columns of one window — the same cut for a period and its ghost. */
function bucketize(
  samples: readonly HistorySample[],
  from: number,
  to: number,
  count: number,
): Column[] {
  const columns: Column[] = Array.from({ length: count }, emptyColumn);
  for (const sample of samples) {
    const column = columns[bucketIndex(sample.startedAt, from, to, count)];
    if (!column) continue;
    column.durations.push(sample.durationMs);
    if (sample.hasError) column.errors++;
    column.sqlCount += sample.sqlCount;
    column.httpCount += sample.httpCount;
    column.bytes += sample.bytes;
    column.findings += sample.findingCount;
    if (sample.loopDelayMs !== null) {
      column.loopTotal += sample.loopDelayMs;
      column.loopSamples++;
    }
  }
  return columns;
}

export function historyOf(
  current: HistorySamples,
  previous: readonly HistorySample[],
  options: HistoryOptions,
): SeriesResponse {
  const samples = current.samples;
  const asked = options.columns ?? SERIES_COLUMNS;
  const count = Math.max(1, columnsFor(samples.length, asked));

  const columns = bucketize(samples, options.from, options.to, count);

  // A period of no width would divide by zero and a chart of it would be a
  // single column claiming to be a stretch of time.
  const span = Math.max(1, options.to - options.from);
  const bucketMs = span / count;

  // The period immediately before, cut into the same number of columns, so
  // the ghost lines up with the line it sits behind.
  const ghostColumns =
    previous.length > 0 ? bucketize(previous, options.from - span, options.from - 1, count) : null;
  const primary = options.metrics[0];

  const series: MetricSeries[] = options.metrics.map((metric) => ({
    metric,
    values: columns.map((column) => metricValue(metric, column, bucketMs)),
  }));

  return {
    from: options.from,
    to: options.to,
    bucketMs,
    calls: columns.map((column) => column.durations.length),
    series,
    totals: totalsOf(samples),
    // No traffic before the period is not a period of zeroes; it is nothing
    // to compare against, and the screen says so instead of inventing a
    // hundred-percent rise.
    previous: previous.length > 0 ? totalsOf(previous) : null,
    ghost:
      ghostColumns && primary
        ? ghostColumns.map((column) => metricValue(primary, column, bucketMs))
        : null,
    truncated: current.truncated,
  };
}
