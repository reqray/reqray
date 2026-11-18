/**
 * Filtering and summary over the request list.
 *
 * Pure functions: the panel runs them on every keystroke in the search box,
 * and tests run them without standing up a server.
 */

import type { RequestSummary } from '@reqray/protocol';
import type { RecordedRequest } from '../types.js';
import { normalizeRoute } from './routes.js';

export type { RequestSummary } from '@reqray/protocol';

/** The panel's filter set. Empty fields exclude nothing. */
export interface RequestFilter {
  /** Substring of the path, method or status. Case-insensitive. */
  readonly query?: string | undefined;
  /** Methods: `GET`, `POST`. An empty list means all. */
  readonly methods?: readonly string[] | undefined;
  /** Status classes: 2, 3, 4, 5. An empty list means all. */
  readonly statusClasses?: readonly number[] | undefined;
  /** Only requests no faster than the given duration. */
  readonly minDurationMs?: number | undefined;
  /** Not before this moment, epoch ms. Inclusive. */
  readonly from?: number | undefined;
  /** Not after this moment, epoch ms. Inclusive. */
  readonly to?: number | undefined;
  /** Only requests where the detectors found something. */
  readonly onlyFindings?: boolean | undefined;
  /** Only requests with an N+1 — a narrower question than "any finding". */
  readonly onlyNPlusOne?: boolean | undefined;
  /** Only requests a test issued. */
  readonly onlyTests?: boolean | undefined;
  /**
   * Only requests that failed.
   *
   * Wider than the 5xx class: a handler that threw and still answered 200 is
   * a failure, and it is the one worth finding.
   */
  readonly onlyErrors?: boolean | undefined;
  /**
   * One endpoint, as the Routes screen names it: the normalized path and the
   * method that go with it.
   */
  readonly route?: { readonly method: string; readonly route: string } | undefined;
  /** Substring of the path alone — narrower than `query`, which matches four fields. */
  readonly path?: string | undefined;
  /** Exactly this status code — `404`, not the whole 4xx class. */
  readonly status?: number | undefined;
  /** At least this many SQL queries. */
  readonly minSql?: number | undefined;
  /**
   * Rows the list flags with one of these detectors.
   *
   * The *flag* — the costliest finding — not "any finding of this kind":
   * both stores can answer that question identically (SQLite keeps the flag
   * as a column), and it is the badge the reader is pointing at anyway.
   */
  readonly flagged?: readonly string[] | undefined;
  /** Requests issued by a test whose name contains this. Case-insensitive. */
  readonly test?: string | undefined;
}

function matchesQuery(request: RecordedRequest, needle: string): boolean {
  if (request.method.toLowerCase().includes(needle)) return true;
  if (request.path.toLowerCase().includes(needle)) return true;
  if (String(request.status).includes(needle)) return true;
  return request.query ? request.query.toLowerCase().includes(needle) : false;
}

/** Selects requests matching the filter, keeping the original order (newest first). */
export function filterRequests(
  requests: readonly RecordedRequest[],
  filter: RequestFilter = {},
): RecordedRequest[] {
  const needle = filter.query?.trim().toLowerCase();
  const methods = filter.methods?.length
    ? new Set(filter.methods.map((m) => m.toUpperCase()))
    : null;
  const classes = filter.statusClasses?.length ? new Set(filter.statusClasses) : null;

  return requests.filter((request) => {
    if (filter.from !== undefined && request.startedAt < filter.from) return false;
    if (filter.to !== undefined && request.startedAt > filter.to) return false;
    if (needle && !matchesQuery(request, needle)) return false;
    if (methods && !methods.has(request.method.toUpperCase())) return false;
    if (classes && !classes.has(Math.floor(request.status / 100))) return false;
    if (filter.minDurationMs !== undefined && request.durationMs < filter.minDurationMs)
      return false;
    if (filter.onlyFindings && request.findings.length === 0) return false;
    if (filter.onlyNPlusOne && !request.findings.some((f) => f.detector === 'n_plus_one'))
      return false;
    if (filter.onlyTests && request.test === null) return false;
    if (filter.path && !request.path.toLowerCase().includes(filter.path.toLowerCase())) {
      return false;
    }
    if (filter.status !== undefined && request.status !== filter.status) return false;
    if (filter.minSql !== undefined) {
      let sql = 0;
      for (const span of request.spans) if (span.kind === 'db') sql++;
      if (sql < filter.minSql) return false;
    }
    if (filter.flagged?.length) {
      // The same rule the list flags a row by: the costliest finding names it.
      const flag = [...request.findings].sort((a, b) => b.costMs - a.costMs)[0]?.detector;
      if (!flag || !filter.flagged.includes(flag)) return false;
    }
    if (filter.test !== undefined) {
      if (request.test === null || !request.test.toLowerCase().includes(filter.test.toLowerCase()))
        return false;
    }
    if (filter.onlyErrors && request.error === null && request.status < 500) return false;
    if (filter.route) {
      if (request.method.toUpperCase() !== filter.route.method.toUpperCase()) return false;
      if (normalizeRoute(request.path) !== filter.route.route) return false;
    }
    return true;
  });
}

/**
 * Summary over the buffer.
 *
 * `slowMs` is the "slow" threshold for the status bar, 500 ms by default, as
 * in the panel mockup.
 */
export function summarize(
  all: readonly RecordedRequest[],
  shown: readonly RecordedRequest[],
  slowMs = 500,
): RequestSummary {
  let slow = 0;
  let errors = 0;
  let withFindings = 0;

  for (const request of all) {
    if (request.durationMs >= slowMs) slow++;
    if (request.status >= 500 || request.error) errors++;
    if (request.findings.length > 0) withFindings++;
  }

  return { shown: shown.length, total: all.length, slow, errors, withFindings };
}
