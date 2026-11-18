/**
 * One page of a list, from records held in memory.
 *
 * The paging rule, in one place: the router's fallback calls it, and so does
 * any store that holds its records in memory. Two implementations of it would
 * mean one panel giving two answers depending on the store behind it.
 *
 * A store that pages in its own query language cannot use this and should not
 * — pushing the work down is why it has a `page()`. What it owes is the same
 * behaviour, which is what the parity test checks.
 */

import type { RecordedRequest } from '../types.js';
import type { PageQuery, RequestPage } from './api.js';
import { toRow } from './api.js';
import { filterRequests, summarize } from './filters.js';
import { decodeCursor, encodeCursor, isAfterCursor } from './paging.js';

/** What the caller knows that the records do not. */
export interface PageContext {
  /** Ids currently pinned. Exempt from the filter, and flagged on the row. */
  readonly pinned?: ReadonlySet<string> | undefined;
  /** Above this a request counts as slow in the summary. */
  readonly slowMs?: number | undefined;
}

/**
 * Pages `records` — newest first — according to `query`.
 *
 * `records` is the store's whole contents: the summary is over all of them,
 * which is what makes the status bar a statement about the store rather than
 * about the page.
 */
export function pageFromList(
  records: readonly RecordedRequest[],
  query: PageQuery,
  context: PageContext = {},
): RequestPage {
  const pinned = context.pinned ?? new Set<string>();

  // A pinned request is one the reader deliberately set aside: it stays
  // through a filter that would otherwise exclude it.
  const matched = new Set(filterRequests(records, query.filter).map((item) => item.id));
  const shown = records.filter((item) => matched.has(item.id) || pinned.has(item.id));

  // What the page is ordered by, and therefore what the cursor counts in.
  const slowest = query.sort === 'slowest';
  const keyOf = (item: RecordedRequest): number => (slowest ? item.durationMs : item.startedAt);
  // Sorted in both cases: the cursor counts in this order, and a list handed
  // over in arrival order is not in it — a slow request starts early and
  // lands late, and a page boundary beside it would skip or repeat rows.
  const ordered = [...shown].sort((a, b) => keyOf(b) - keyOf(a) || (a.id < b.id ? 1 : -1));

  const cursor = decodeCursor(query.cursor);
  const after = cursor
    ? ordered.filter((item) => isAfterCursor(cursor, keyOf(item), item.id))
    : ordered;

  const rows = after.slice(0, query.limit);
  const last = rows[rows.length - 1];
  const nextCursor = after.length > rows.length && last ? encodeCursor(keyOf(last), last.id) : null;

  return {
    rows: rows.map((item) => toRow(item, pinned.has(item.id))),
    nextCursor,
    summary: summarize(records, shown, context.slowMs),
  };
}
