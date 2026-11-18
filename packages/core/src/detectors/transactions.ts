/**
 * Grouping a request's queries into the transactions they ran in.
 *
 * Nothing new is recorded to make this work. `BEGIN`, `COMMIT` and `ROLLBACK`
 * arrive as ordinary queries, and every db span already carries the
 * connection it ran on — so a transaction is simply the stretch between the
 * two ends *on one connection*. That last part is the whole reason this is a
 * shared helper rather than a line inside a detector: a query issued on some
 * other connection while a transaction is open did not happen inside it, and
 * getting that wrong turns every parallel query in a busy request into
 * evidence of a problem that is not there.
 */

import type { DbSpan, Span } from '../types.js';

/** One transaction, as the spans of a single request show it. */
export interface Transaction {
  readonly connectionId: number;
  /** The `BEGIN` that opened it. */
  readonly begin: DbSpan;
  /**
   * The `COMMIT` or `ROLLBACK` that closed it.
   *
   * `null` when the request ended with the transaction still open — which is
   * either a leak or a request that was cut short, and in both cases the
   * connection was held right up to the end.
   */
  readonly end: DbSpan | null;
  /** Queries between the two ends; the ends themselves are not among them. */
  readonly queries: readonly DbSpan[];
  /** Relative ms from the request start, as spans measure it. */
  readonly startedAt: number;
  /** Where the hold ended: the end of `COMMIT`, or the end of the request. */
  readonly endedAt: number;
}

/**
 * Transaction control statements, matched on the whole first word.
 *
 * Two traps are deliberate. `ROLLBACK TO SAVEPOINT` does not close a
 * transaction — it rewinds inside one, and reading it as an end would cut a
 * transaction in half and hide everything after the savepoint. And `END` is
 * Postgres's synonym for `COMMIT`, which is why the boundary matters: without
 * it the word would also match a column called `ENDED_AT`.
 */
const BEGIN_RE = /^(?:BEGIN|START\s+TRANSACTION)\b/;
const END_RE = /^(?:COMMIT|ROLLBACK|END)\b/;
const ROLLBACK_TO_RE = /^ROLLBACK\s+TO\b/;

/** Leading comments an ORM may prepend, so the first word is the statement. */
const LEADING_COMMENTS = /^(?:\s|\/\*[\s\S]*?\*\/|--[^\n]*\n)+/;

/** `begin`, `end`, or `null` for an ordinary query. */
export function statementKind(sql: string): 'begin' | 'end' | null {
  // The first characters are enough, and bounding the work keeps a detector
  // from walking a megabyte of generated SQL to read one word.
  const head = sql.slice(0, 200).replace(LEADING_COMMENTS, '').toUpperCase();
  if (BEGIN_RE.test(head)) return 'begin';
  if (ROLLBACK_TO_RE.test(head)) return null;
  if (END_RE.test(head)) return 'end';
  return null;
}

/** End of a span, in the same relative milliseconds `startedAt` uses. */
function endOf(span: Span): number {
  return span.startedAt + span.duration;
}

/**
 * The transactions a request opened.
 *
 * @param spans every span of the request, in any order.
 * @param requestEndMs where an unclosed transaction stops being measurable —
 *   the request's own duration.
 */
export function transactionsOf(spans: readonly Span[], requestEndMs: number): Transaction[] {
  const byConnection = new Map<number, DbSpan[]>();
  for (const span of spans) {
    if (span.kind !== 'db' || span.connectionId === null) continue;
    const existing = byConnection.get(span.connectionId);
    if (existing) existing.push(span);
    else byConnection.set(span.connectionId, [span]);
  }

  const transactions: Transaction[] = [];
  for (const [connectionId, queries] of byConnection) {
    queries.sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);

    let begin: DbSpan | null = null;
    let inside: DbSpan[] = [];

    for (const span of queries) {
      const kind = statementKind(span.sql);

      if (kind === 'begin') {
        // A second `BEGIN` with none of it closed is not a nested
        // transaction — Postgres has no such thing — so the first one stands.
        if (!begin) {
          begin = span;
          inside = [];
        }
        continue;
      }

      if (kind === 'end') {
        if (begin) {
          transactions.push({
            connectionId,
            begin,
            end: span,
            queries: inside,
            startedAt: begin.startedAt,
            endedAt: endOf(span),
          });
          begin = null;
          inside = [];
        }
        continue;
      }

      if (begin) inside.push(span);
    }

    if (begin) {
      transactions.push({
        connectionId,
        begin,
        end: null,
        queries: inside,
        startedAt: begin.startedAt,
        // Held until the request ended, which is the last moment anything
        // here can honestly speak for.
        endedAt: Math.max(requestEndMs, endOf(begin)),
      });
    }
  }

  return transactions;
}

/** How long `span` and the window overlap, in ms. Never negative. */
export function overlapMs(span: Span, from: number, to: number): number {
  return Math.max(0, Math.min(endOf(span), to) - Math.max(span.startedAt, from));
}
