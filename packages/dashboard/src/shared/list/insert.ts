/** Merging an arriving request into the list on screen. */

import type { RequestRow, RequestSummary } from '../../api/index';

/** The threshold the status bar counts "slow" by, as the panel always has. */
export const SLOW_MS = 500;

/**
 * The store's numbers, moved on by one row arriving on the live feed.
 *
 * The counts come from the store when a page is fetched, and the feed is the
 * only thing that changes them afterwards — a panel left open for an hour
 * would otherwise show the totals from the minute it was opened. The stream
 * carries no backlog, so every row delivered is one the store has just gained.
 */
export function withArrival(summary: RequestSummary, row: RequestRow): RequestSummary {
  return {
    ...summary,
    total: summary.total + 1,
    slow: summary.slow + (row.durationMs >= SLOW_MS ? 1 : 0),
    errors: summary.errors + (row.hasError ? 1 : 0),
    withFindings: summary.withFindings + (row.findingCount > 0 ? 1 : 0),
  };
}

/**
 * How many rows the client keeps when the server has not said otherwise.
 *
 * The same number the in-app ring buffer defaults to. A collector's is larger,
 * which is exactly why this is only a fallback.
 */
export const DEFAULT_CAPACITY = 500;

/**
 * Puts an arriving row at the front of the list.
 *
 * Newest first, no duplicates — the same request can arrive twice when the
 * feed reconnects and replays — and never more rows than the server itself
 * holds, or a long session would grow a list of requests that no longer exist
 * to open.
 */
export function insertRow(
  rows: readonly RequestRow[],
  row: RequestRow,
  capacity: number,
): RequestRow[] {
  const next = [row, ...rows.filter((existing) => existing.id !== row.id)];
  return next.length > capacity ? next.slice(0, capacity) : next;
}
