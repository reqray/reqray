/**
 * The findings tab: recorded occurrences, grouped into a work list.
 *
 * The list screen answers "what ran"; this contract answers "what is worth
 * fixing". Occurrences group by detector and code location rather than by
 * request — two routes both firing N+1 at the same line are one problem, and
 * eight hundred occurrences are usually a handful of patterns.
 */

import type { Callsite, FindingSeverity } from './record.js';

/**
 * Where a pattern stands in somebody's work.
 *
 * `new` and `ack` are the reader's own bookkeeping. `muted` hides the pattern
 * and stops it flagging list rows — the detector keeps running, so unmuting
 * has history to show. `fixed` is a guess, never a promise: the pattern has
 * not fired since the file it points at last changed, which a client renders
 * with the question mark it deserves.
 */
export type PatternState = 'new' | 'ack' | 'muted' | 'fixed';

/** The states a client may set; `fixed` is computed and cannot be. */
export type StoredPatternState = 'new' | 'ack' | 'muted';

/**
 * The states a store actually keeps.
 *
 * `new` is the absence of a row rather than a value: a pattern nobody has
 * touched costs no storage, and reopening one forgets it again.
 */
export type FiledPatternState = Exclude<StoredPatternState, 'new'>;

/** One route a pattern fired on, with how often. */
export interface PatternRoute {
  readonly method: string;
  readonly route: string;
  readonly calls: number;
}

/** One of the worst occurrences, as a way into the request behind it. */
export interface PatternExample {
  readonly requestId: string;
  readonly startedAt: number;
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  /** What this occurrence cost, ms. */
  readonly costMs: number;
}

/** One problem, wherever and however often it fired. */
export interface FindingPattern {
  /** Stable key: detector plus code location (or route, when no location). */
  readonly id: string;
  readonly detector: string;
  readonly severity: FindingSeverity;
  /** One plain sentence, from the most recent occurrence. */
  readonly title: string;
  /** How to fix it, from the most recent occurrence. */
  readonly hint: string;
  readonly callsite: Callsite | null;
  readonly occurrences: number;
  /**
   * Milliseconds that come back if the pattern is fixed, summed over the
   * occurrences in the window. Zero when the cost is not time.
   */
  readonly recoverableMs: number;
  /** Routes it fired on, busiest first. */
  readonly routes: readonly PatternRoute[];
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly state: PatternState;
  /** The worst occurrences, costliest first — each opens a request. */
  readonly examples: readonly PatternExample[];
}

/** What `/api/findings` answers. */
export interface FindingsResponse {
  /** Sorted by recoverable time, never by recency — the list does recency. */
  readonly patterns: readonly FindingPattern[];
  /** Occurrences behind the patterns, muted ones included. */
  readonly occurrences: number;
  /** Recoverable ms across every pattern that is not muted. */
  readonly recoverableMs: number;
  /** The store stopped reading before the window ended. */
  readonly truncated: boolean;
}
