/**
 * Occurrences into patterns — the arithmetic behind the findings tab.
 *
 * The grouping happens here, once, for every store: a store hands over one
 * row per occurrence and says when it stopped reading, the same division of
 * labour the history screen uses. Grouping is by detector plus code
 * location, not by request — `GET /api/orders` and `GET /api/orders/flaky`
 * both firing N+1 at the same line are one problem — and falls back to the
 * route when a finding carries no location, because "somewhere on this
 * endpoint" is still one somewhere.
 */

import type {
  Callsite,
  FindingPattern,
  FindingSeverity,
  FindingsResponse,
  PatternExample,
  StoredPatternState,
} from '@reqray/protocol';
import type { RecordedRequest } from '../types.js';
import { normalizeRoute } from './routes.js';

/**
 * One finding occurrence, as the tab needs it.
 *
 * A dozen fields rather than a record: the requests that carry findings are
 * a small minority, but a window of them is still not something to hold as
 * payloads to look at one finding in each.
 */
export interface FindingSample {
  readonly requestId: string;
  readonly startedAt: number;
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  readonly detector: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly costMs: number;
  readonly callsite: Callsite | null;
  readonly hint: string;
}

/** What a store hands back, and whether it read the whole window. */
export interface FindingSamples {
  readonly samples: readonly FindingSample[];
  readonly truncated: boolean;
}

/** The stretch of time a findings reading covers. Absent bounds mean all. */
export interface FindingsQuery {
  readonly from?: number | undefined;
  readonly to?: number | undefined;
}

/**
 * A request's findings, reduced to occurrence rows.
 *
 * For every store that keeps whole records, so the tab does not depend on
 * which store is behind it.
 */
export function findingSamplesOf(request: RecordedRequest): FindingSample[] {
  return request.findings.map((finding) => ({
    requestId: request.id,
    startedAt: request.startedAt,
    method: request.method,
    route: normalizeRoute(request.path),
    status: request.status,
    durationMs: request.durationMs,
    detector: finding.detector,
    severity: finding.severity,
    title: finding.title,
    costMs: finding.costMs,
    callsite: finding.callsite,
    hint: finding.hint,
  }));
}

/**
 * The pattern a finding belongs to.
 *
 * The code location when there is one — the same problem fires from the same
 * line whatever route reached it — and the route otherwise, so locationless
 * findings (a blown budget, a heavy response) still group by where they live.
 */
export function patternKey(sample: {
  readonly detector: string;
  readonly callsite: Callsite | null;
  readonly method: string;
  readonly route: string;
}): string {
  return sample.callsite
    ? `${sample.detector}@${sample.callsite.relative}:${sample.callsite.line}`
    : `${sample.detector}@${sample.method} ${sample.route}`;
}

/** How many example requests a pattern carries. */
const EXAMPLE_LIMIT = 3;

const SEVERITY_RANK: Record<FindingSeverity, number> = { info: 0, warn: 1, critical: 2 };

export interface PatternsOptions {
  /** `ack`/`muted` per pattern id, as the store remembered them. */
  readonly states?: ReadonlyMap<string, StoredPatternState> | undefined;
  /**
   * When a file last changed, epoch ms, or `null` when nobody knows.
   *
   * Injected rather than read here: the aggregation stays pure, and what
   * "changed" means (mtime, a commit) is the caller's business.
   */
  readonly changedAt?: ((file: string) => number | null) | undefined;
}

/** Groups occurrences into the tab's patterns, costliest first. */
export function patternsOf(read: FindingSamples, options: PatternsOptions = {}): FindingsResponse {
  interface Bucket {
    latest: FindingSample;
    occurrences: number;
    recoverableMs: number;
    firstSeen: number;
    lastSeen: number;
    severity: FindingSeverity;
    routes: Map<string, { method: string; route: string; calls: number }>;
    /** Worst occurrence per request — five findings in one request are one way in. */
    examples: Map<string, PatternExample>;
  }

  const buckets = new Map<string, Bucket>();
  for (const sample of read.samples) {
    const key = patternKey(sample);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        latest: sample,
        occurrences: 0,
        recoverableMs: 0,
        firstSeen: sample.startedAt,
        lastSeen: sample.startedAt,
        severity: sample.severity,
        routes: new Map(),
        examples: new Map(),
      };
      buckets.set(key, bucket);
    }

    bucket.occurrences++;
    bucket.recoverableMs += sample.costMs;
    if (sample.startedAt < bucket.firstSeen) bucket.firstSeen = sample.startedAt;
    if (sample.startedAt >= bucket.lastSeen) {
      bucket.lastSeen = sample.startedAt;
      // The sentence and the hint follow the freshest occurrence: "150
      // identical queries" must not describe last week's count.
      bucket.latest = sample;
    }
    if (SEVERITY_RANK[sample.severity] > SEVERITY_RANK[bucket.severity]) {
      bucket.severity = sample.severity;
    }

    const routeKey = `${sample.method} ${sample.route}`;
    const route = bucket.routes.get(routeKey);
    if (route) route.calls++;
    else bucket.routes.set(routeKey, { method: sample.method, route: sample.route, calls: 1 });

    const example = bucket.examples.get(sample.requestId);
    if (!example || sample.costMs > example.costMs) {
      bucket.examples.set(sample.requestId, {
        requestId: sample.requestId,
        startedAt: sample.startedAt,
        method: sample.method,
        route: sample.route,
        status: sample.status,
        durationMs: sample.durationMs,
        costMs: sample.costMs,
      });
    }
  }

  const patterns: FindingPattern[] = [...buckets.entries()].map(([id, bucket]) => ({
    id,
    detector: bucket.latest.detector,
    severity: bucket.severity,
    title: bucket.latest.title,
    hint: bucket.latest.hint,
    callsite: bucket.latest.callsite,
    occurrences: bucket.occurrences,
    recoverableMs: bucket.recoverableMs,
    routes: [...bucket.routes.values()].sort((a, b) => b.calls - a.calls),
    firstSeen: bucket.firstSeen,
    lastSeen: bucket.lastSeen,
    state: stateOf(id, bucket, options),
    examples: [...bucket.examples.values()]
      .sort((a, b) => b.costMs - a.costMs)
      .slice(0, EXAMPLE_LIMIT),
  }));

  patterns.sort((a, b) => b.recoverableMs - a.recoverableMs || b.occurrences - a.occurrences);

  return {
    patterns,
    occurrences: read.samples.length,
    recoverableMs: patterns.reduce(
      (sum, pattern) => (pattern.state === 'muted' ? sum : sum + pattern.recoverableMs),
      0,
    ),
    truncated: read.truncated,
  };
}

/**
 * What a pattern's state is, muted winning over everything.
 *
 * `fixed` outranks `ack` because it says more: the pattern has been silent
 * since the file it points at changed. It is only ever a guess — hence the
 * question mark a client draws — and only claimed when somebody did change
 * the file after the last occurrence.
 */
function stateOf(
  id: string,
  bucket: { latest: FindingSample; lastSeen: number },
  options: PatternsOptions,
): FindingPattern['state'] {
  const stored = options.states?.get(id);
  if (stored === 'muted') return 'muted';

  const file = bucket.latest.callsite?.file;
  if (file && options.changedAt) {
    const changed = options.changedAt(file);
    if (changed !== null && changed > bucket.lastSeen) return 'fixed';
  }

  return stored === 'ack' ? 'ack' : 'new';
}

/**
 * The row's flag, with muted patterns silenced.
 *
 * Muting is presentation, not detection: the detector keeps running and the
 * findings stay on the record, but a muted pattern must stop shouting from
 * the list. The flag falls back to the costliest finding that is not muted,
 * and to nothing when they all are.
 */
export function flagWithMutes(request: RecordedRequest, muted: ReadonlySet<string>): string | null {
  if (muted.size === 0 || request.findings.length === 0) {
    return [...request.findings].sort((a, b) => b.costMs - a.costMs)[0]?.detector ?? null;
  }
  const audible = request.findings.filter(
    (finding) =>
      !muted.has(
        patternKey({
          detector: finding.detector,
          callsite: finding.callsite,
          method: request.method,
          route: normalizeRoute(request.path),
        }),
      ),
  );
  return [...audible].sort((a, b) => b.costMs - a.costMs)[0]?.detector ?? null;
}
