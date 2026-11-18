/**
 * The panel's filter, expressed as SQL.
 *
 * There are now two places that decide what "matching" means — this one and
 * `filterRequests` in the core, which the in-memory store and the browser
 * both use. Two implementations of one rule drift, so they are held together
 * by a test that runs the same cases through both stores and demands the same
 * ids back. Change the rule here and that test is where it will be caught.
 */

import type { Cursor, RequestFilter } from '@reqray/core/panel';
import type { RequestSort } from '@reqray/protocol';

/** A WHERE fragment and the values it binds. */
export interface Where {
  readonly sql: string;
  readonly params: (string | number)[];
}

/** Escapes what SQLite's LIKE treats as wildcards. */
function likeArgument(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Builds the WHERE clause for a filter.
 *
 * Always returns a usable fragment: an empty filter excludes nothing, so the
 * caller can concatenate without special cases.
 */
export function whereFor(filter: RequestFilter): Where {
  const clauses: string[] = ['1 = 1'];
  const params: (string | number)[] = [];

  if (filter.from !== undefined) {
    clauses.push('started_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('started_at <= ?');
    params.push(filter.to);
  }

  const needle = filter.query?.trim().toLowerCase();
  if (needle) {
    // The same four fields the in-memory filter searches: method, path,
    // status as text, and the query string.
    clauses.push(
      "(lower(method) LIKE ? ESCAPE '\\' OR lower(path) LIKE ? ESCAPE '\\' " +
        "OR CAST(status AS TEXT) LIKE ? ESCAPE '\\' " +
        "OR (query_string IS NOT NULL AND lower(query_string) LIKE ? ESCAPE '\\'))",
    );
    const like = likeArgument(needle);
    params.push(like, like, like, like);
  }

  const methods = filter.methods?.filter(Boolean) ?? [];
  if (methods.length > 0) {
    clauses.push(`upper(method) IN (${methods.map(() => '?').join(', ')})`);
    params.push(...methods.map((method) => method.toUpperCase()));
  }

  const classes = filter.statusClasses?.filter((value) => Number.isFinite(value)) ?? [];
  if (classes.length > 0) {
    clauses.push(`(status / 100) IN (${classes.map(() => '?').join(', ')})`);
    params.push(...classes.map((value) => Math.floor(value)));
  }

  if (filter.minDurationMs !== undefined) {
    clauses.push('duration_ms >= ?');
    params.push(filter.minDurationMs);
  }

  if (filter.path) {
    clauses.push("lower(path) LIKE ? ESCAPE '\\'");
    params.push(likeArgument(filter.path.toLowerCase()));
  }

  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }

  if (filter.minSql !== undefined) {
    clauses.push('sql_count >= ?');
    params.push(filter.minSql);
  }

  const flagged = filter.flagged?.filter(Boolean) ?? [];
  if (flagged.length > 0) {
    clauses.push(`flag IN (${flagged.map(() => '?').join(', ')})`);
    params.push(...flagged);
  }

  if (filter.test !== undefined) {
    clauses.push("test IS NOT NULL AND lower(test) LIKE ? ESCAPE '\\'");
    params.push(likeArgument(filter.test.toLowerCase()));
  }

  if (filter.onlyFindings) clauses.push('finding_count > 0');
  if (filter.onlyNPlusOne) clauses.push('n_plus_one = 1');
  if (filter.onlyTests) clauses.push('test IS NOT NULL');
  if (filter.onlyErrors) clauses.push('has_error = 1');

  if (filter.route) {
    // The normalized route is stored per row rather than computed here: the
    // rule lives in the core and the browser bundle does not carry a copy,
    // and neither should the SQL.
    clauses.push('route = ? AND upper(method) = ?');
    params.push(filter.route.route, filter.route.method.toUpperCase());
  }

  return { sql: clauses.join(' AND '), params };
}

/** The column a page is ordered by. Not user input — one of these two. */
export type OrderColumn = 'started_at' | 'duration_ms';

/** Which column each sort order reads. */
export function orderColumn(sort: RequestSort | undefined): OrderColumn {
  return sort === 'slowest' ? 'duration_ms' : 'started_at';
}

/**
 * The clause that continues from a cursor.
 *
 * The same rule `isAfterCursor` applies in memory, written for SQLite:
 * strictly past the cursor, with the id breaking ties, so a row is never
 * served twice and never skipped when several share a millisecond — or, when
 * the page is ordered by duration, share a duration.
 */
export function afterCursor(cursor: Cursor, column: OrderColumn = 'started_at'): Where {
  return {
    sql: `(${column} < ? OR (${column} = ? AND id < ?))`,
    params: [cursor.key, cursor.key, cursor.id],
  };
}
