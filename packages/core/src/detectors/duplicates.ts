/**
 * Duplicate-work detectors: the same call made twice in one request.
 *
 * Unlike the N+1 detectors, order does not matter here — two identical calls
 * are wasted work whether they were sequential or parallel. What does matter
 * is that the call is *safe* to have made once: only reads are flagged, since
 * "memoize this" is sound advice for a GET and dangerous for a POST.
 *
 * What is intentionally NOT flagged:
 * - anything but GET/HEAD, and cache writes: repeating those may be the point;
 * - failures and retries — a second attempt after a 5xx is correct behaviour;
 * - calls whose URLs differ at all, query string included: a different URL is
 *   a different question, and collapsing them would invent a duplicate.
 */

import type { CacheSpan, Finding, FindingSeverity, HttpSpan, Span } from '../types.js';
import type { Detector } from './types.js';

export interface DuplicateHttpOptions {
  /** How many identical calls before it is worth reporting. */
  readonly threshold: number;
  /** Below this saving the duplicate is not worth a card. */
  readonly minWastedMs: number;
}

export interface DuplicateCacheOptions {
  readonly threshold: number;
}

const SEVERITY_WARN_MS = 50;

/** Methods where a second identical call returns the same thing. */
const READ_METHODS = new Set(['GET', 'HEAD']);

function isRetry(span: HttpSpan): boolean {
  if (span.error) return true;
  if (span.statusCode === null) return true;
  return span.statusCode >= 500 || span.statusCode === 429;
}

/**
 * What is saved by making the call once.
 *
 * The largest of the group is the one assumed to remain, so the number is
 * never larger than the time that actually exists.
 */
function savingOf(spans: readonly { duration: number }[]): number {
  let total = 0;
  let slowest = 0;
  for (const span of spans) {
    total += span.duration;
    if (span.duration > slowest) slowest = span.duration;
  }
  return total - slowest;
}

function group<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/** Two identical outbound reads in one request. */
export const duplicateHttp: Detector<DuplicateHttpOptions> = {
  id: 'dup_http',

  defaultOptions: {
    threshold: 2,
    // An external call worth deduplicating costs at least this much; below it
    // the card is noise on a screen meant for the expensive things.
    minWastedMs: 10,
  },

  run(scope, options) {
    const calls = scope.spans.filter(
      (span): span is HttpSpan =>
        span.kind === 'http' && READ_METHODS.has(span.method.toUpperCase()) && !isRetry(span),
    );

    const findings: Finding[] = [];
    for (const [key, spans] of group(calls, (span) => `${span.method} ${span.url}`)) {
      if (spans.length < options.threshold) continue;

      const costMs = savingOf(spans);
      if (costMs < options.minWastedMs) continue;

      const severity: FindingSeverity = costMs >= SEVERITY_WARN_MS ? 'warn' : 'info';
      const first = spans[0];
      const site = (span: HttpSpan) =>
        span.callsite ? `${span.callsite.relative}:${span.callsite.line}` : '';
      // The panel already prints the finding's own callsite, so the hint names
      // only the *other* places the same call is made from.
      const others = [...new Set(spans.slice(1).map(site).filter(Boolean))].filter(
        (place) => place !== site(first as HttpSpan),
      );

      findings.push({
        detector: 'dup_http',
        severity,
        title: `${spans.length} identical calls to the same URL`,
        costMs,
        callsite: first?.callsite ?? null,
        evidence: {
          kind: 'duplicate',
          repeats: spans.length,
          fingerprint: key,
          sample: first ? `${first.method} ${first.url}` : key,
          totalMs: spans.reduce((sum, span) => sum + span.duration, 0),
          spanIds: spans.map((span) => span.id),
        },
        hint:
          (others.length > 0 ? `also called from ${others.join(' and ')} — ` : '') +
          'the second call returns what the first already fetched. Hold the result for the ' +
          'duration of the request instead of asking again.',
      });
    }
    return findings;
  },
};

/** The same cache key read more than once in one request. */
export const duplicateCache: Detector<DuplicateCacheOptions> = {
  id: 'dup_cache',

  defaultOptions: { threshold: 2 },

  run(scope, options) {
    const reads = scope.spans.filter(
      (span): span is CacheSpan => span.kind === 'cache' && span.operation === 'get',
    );

    const findings: Finding[] = [];
    for (const [key, spans] of group(reads, (span) => span.key)) {
      if (spans.length < options.threshold) continue;

      const first = spans[0];
      findings.push({
        detector: 'dup_cache',
        // Cache reads are cheap; this is a nudge about redundant work, not an
        // alarm about time, so it never outranks a real cost on the screen.
        severity: 'info',
        title: `${spans.length} reads of the same cache key`,
        costMs: savingOf(spans),
        callsite: first?.callsite ?? null,
        evidence: {
          kind: 'duplicate',
          repeats: spans.length,
          fingerprint: key,
          sample: `cache.get ${key}`,
          totalMs: spans.reduce((sum, span) => sum + span.duration, 0),
          spanIds: spans.map((span) => span.id),
        },
        hint: `"${key}" is read ${spans.length} times while handling one request — read it once and pass the value down.`,
      });
    }
    return findings;
  },
};

/** Narrowing helper shared with the budget detector. */
export function isHttp(span: Span): span is HttpSpan {
  return span.kind === 'http';
}
