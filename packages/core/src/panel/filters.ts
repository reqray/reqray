/**
 * Filtering and summary over the request list.
 *
 * Pure functions: the panel runs them on every keystroke in the search box,
 * and tests run them without standing up a server.
 */

import type { RecordedRequest } from '../types.js';

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
  /** Only requests where the detectors found something. */
  readonly onlyFindings?: boolean | undefined;
}

/** Numbers for the panel's status bar. */
export interface RequestSummary {
  readonly shown: number;
  readonly total: number;
  readonly slow: number;
  readonly errors: number;
  readonly withFindings: number;
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
    if (needle && !matchesQuery(request, needle)) return false;
    if (methods && !methods.has(request.method.toUpperCase())) return false;
    if (classes && !classes.has(Math.floor(request.status / 100))) return false;
    if (filter.minDurationMs !== undefined && request.durationMs < filter.minDurationMs)
      return false;
    if (filter.onlyFindings && request.findings.length === 0) return false;
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
