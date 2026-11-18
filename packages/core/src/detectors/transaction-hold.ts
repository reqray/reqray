/**
 * Transaction-hold detector: what the connection was doing while it was held.
 *
 * A transaction is not just a correctness construct, it is a connection taken
 * out of the pool for as long as it is open. Two hundred milliseconds of a
 * payment API called between `BEGIN` and `COMMIT` is two hundred milliseconds
 * one connection cannot serve anybody else with, and it is invisible to
 * anything that looks only at SQL or only at outgoing calls: you have to see
 * both, on the same connection, to see it at all.
 *
 * One finding per transaction, never two. The external call and the long hold
 * are the same problem — a connection held for something that is not a query
 * — with the same fix in the same place, and reporting them separately would
 * put two entries on the screen about one `BEGIN`.
 *
 * What it will not fire on:
 * - a call made after the `COMMIT`: the overlap with the open window is zero,
 *   which is the whole point of measuring an overlap rather than an order;
 * - a query on another connection while a transaction is open — it was not
 *   inside it, and `transactionsOf` groups by connection precisely so this
 *   cannot happen;
 * - an implicit single-statement transaction, which every write is: without
 *   an explicit `BEGIN` there is no transaction here to talk about;
 * - a transaction that was long because its queries were long. That is a
 *   slow query, the panel already says so, and saying it twice in different
 *   words is how a tool teaches people to skim its findings.
 */

import { coveredMs } from '../timing.js';
import type { Finding, FindingSeverity, HttpSpan, Span } from '../types.js';
import { overlapMs, type Transaction, transactionsOf } from './transactions.js';
import type { Detector, FinishedRequest } from './types.js';

export interface TransactionHoldOptions {
  /**
   * Time inside outgoing calls made while a transaction was open, above which
   * the hold is reported.
   */
  readonly minExternalMs: number;
  /** How long a transaction may hold a connection before the hold is itself the finding. */
  readonly maxHeldMs: number;
  /**
   * How much of a long hold must have gone on something other than querying.
   *
   * A transaction that spent its whole life running queries is a slow query,
   * not a held connection.
   */
  readonly minIdleMs: number;
}

/** A quarter of a second of somebody else's service, with a connection in hand. */
const SEVERITY_CRITICAL_MS = 250;

const EXTERNAL_HINT =
  'Move the call out of the transaction: read what you need, call, then open the transaction to write. ' +
  'While it is open the connection belongs to this request alone, and a pool runs out of connections long before a payment API runs out of patience.';

const HOLD_HINT =
  'Do the work before `BEGIN`, not inside it. A transaction is a connection taken out of the pool, and everything that is not a query — serialisation, a template, a call to another service — is time the pool is one connection smaller.';

/** `POST api.stripe.com/v1/charges` — the call, without its query string. */
function callLabel(span: HttpSpan): string {
  const cut = span.url.indexOf('?');
  return `${span.method} ${cut === -1 ? span.url : span.url.slice(0, cut)}`;
}

/** Milliseconds spent querying inside the window, counted once. */
function sqlInside(transaction: Transaction): number {
  const spans = [transaction.begin, ...transaction.queries];
  if (transaction.end) spans.push(transaction.end);
  return coveredMs(
    spans.map((span) => ({
      start: Math.max(span.startedAt, transaction.startedAt),
      end: Math.min(span.startedAt + span.duration, transaction.endedAt),
    })),
  );
}

/** Outgoing calls that overlap the open window, longest first. */
function callsInside(spans: readonly Span[], transaction: Transaction): HttpSpan[] {
  const inside: HttpSpan[] = [];
  for (const span of spans) {
    if (span.kind !== 'http') continue;
    if (overlapMs(span, transaction.startedAt, transaction.endedAt) <= 0) continue;
    inside.push(span);
  }
  return inside.sort((a, b) => b.duration - a.duration);
}

function findingFor(
  spans: readonly Span[],
  transaction: Transaction,
  options: TransactionHoldOptions,
): Finding | null {
  const heldMs = transaction.endedAt - transaction.startedAt;
  const sqlMs = sqlInside(transaction);
  const queries = transaction.queries.length;
  const spanIds = [transaction.begin.id, ...transaction.queries.map((span) => span.id)];
  if (transaction.end) spanIds.push(transaction.end.id);

  const calls = callsInside(spans, transaction);
  // A union, not a sum: two calls made through `Promise.all` inside one
  // transaction held the connection once, for as long as the longer of them.
  const externalMs = coveredMs(
    calls.map((span) => ({
      start: Math.max(span.startedAt, transaction.startedAt),
      end: Math.min(span.startedAt + span.duration, transaction.endedAt),
    })),
  );

  const worst = calls[0];
  if (worst && externalMs >= options.minExternalMs) {
    const severity: FindingSeverity = externalMs >= SEVERITY_CRITICAL_MS ? 'critical' : 'warn';
    const what =
      calls.length === 1 ? `a ${Math.round(externalMs)} ms call` : `${calls.length} calls`;
    return {
      detector: 'transaction_hold',
      severity,
      title: `A transaction held a connection through ${what}`,
      // Not this request's time: moving the call out does not make the
      // request faster, it gives the connection back sooner. The cost lands
      // on every other request queueing for the pool, and putting a figure
      // here would promise a saving this request will never see.
      costMs: 0,
      // The call is where the fix is written, not the `BEGIN`.
      callsite: worst.callsite ?? transaction.begin.callsite,
      evidence: {
        kind: 'transaction',
        heldMs,
        sqlMs,
        externalMs,
        queries,
        sample: callLabel(worst),
        closedBy: transaction.end ? (statementLabel(transaction.end.sql) ?? null) : null,
        spanIds: [...spanIds, ...calls.map((span) => span.id)],
      },
      hint: EXTERNAL_HINT,
    };
  }

  const idleMs = heldMs - sqlMs;
  if (heldMs >= options.maxHeldMs && idleMs >= options.minIdleMs) {
    return {
      detector: 'transaction_hold',
      severity: 'warn',
      title: `A transaction held a connection for ${Math.round(heldMs)} ms, ${Math.round(sqlMs)} ms of it querying`,
      costMs: 0,
      callsite: transaction.begin.callsite,
      evidence: {
        kind: 'transaction',
        heldMs,
        sqlMs,
        externalMs,
        queries,
        sample: null,
        closedBy: transaction.end ? (statementLabel(transaction.end.sql) ?? null) : null,
        spanIds,
      },
      hint: HOLD_HINT,
    };
  }

  return null;
}

/** `COMMIT` or `ROLLBACK`, as the statement itself spells it. */
function statementLabel(sql: string): string | null {
  const word = sql.trim().split(/[\s;]/, 1)[0];
  return word ? word.toUpperCase() : null;
}

export const transactionHold: Detector<TransactionHoldOptions> = {
  id: 'transaction_hold',

  defaultOptions: {
    // Fifty milliseconds of somebody else's service is already longer than
    // most of the queries the connection was taken out for.
    minExternalMs: 50,
    maxHeldMs: 500,
    minIdleMs: 100,
  },

  run(scope, options, request: FinishedRequest): Finding[] {
    const findings: Finding[] = [];
    for (const transaction of transactionsOf(scope.spans, request.durationMs)) {
      const finding = findingFor(scope.spans, transaction, options);
      if (finding) findings.push(finding);
    }
    return findings;
  },
};
