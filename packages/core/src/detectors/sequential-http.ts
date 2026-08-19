/**
 * Sequential-HTTP detector: N+1 for outgoing calls.
 *
 * A loop of `await fetch(...)` over a list of ids is the same disease as a
 * query in a loop — each call waits for the previous one for no reason. The
 * heuristics are deliberately identical to the N+1 detector's, and the same
 * principle governs: **a false positive is worse than a miss**.
 *
 * What is intentionally NOT flagged:
 * - calls to *different* URLs in sequence: whether B needs A's response is
 *   invisible from timing, and "parallelize this" on a dependent chain is a lie;
 * - overlapping calls — that is `Promise.all`, already optimised;
 * - repeats from different lines of code — a coincidence, not a loop;
 * - runs dominated by failures (5xx, 429, network errors) — that is a retry
 *   loop, and retries are *supposed* to be sequential.
 */

import { fingerprintHttp } from '../http-fingerprint.js';
import type { Finding, FindingSeverity, HttpSpan, Span } from '../types.js';
import { overlapRatio, singleCallsite, splitRuns } from './runs.js';
import type { Detector } from './types.js';

/** Detector thresholds. All exposed as options — the user tunes them. */
export interface SequentialHttpOptions {
  /** How many consecutive calls of one shape make a run suspicious. */
  readonly threshold: number;
  /** Below this saving there is nothing worth reporting. */
  readonly minWastedMs: number;
  /** Share of overlapping adjacent pairs above which the run is parallel. */
  readonly maxOverlapRatio: number;
  /** Gap between calls above which the run is not one loop. */
  readonly maxGapMs: number;
}

const SEVERITY_CRITICAL_MS = 300;
const SEVERITY_WARN_MS = 100;

function isHttpSpan(span: Span): span is HttpSpan {
  return span.kind === 'http';
}

/**
 * A retry, not a loop: the call failed at the transport level, hit a 5xx or
 * ran into rate limiting. Sequential retries are correct behaviour.
 */
function looksLikeRetry(span: HttpSpan): boolean {
  if (span.error) return true;
  if (span.statusCode === null) return true;
  return span.statusCode >= 500 || span.statusCode === 429;
}

function groupCalls(spans: readonly Span[]): Map<string, HttpSpan[]> {
  const groups = new Map<string, HttpSpan[]>();
  for (const span of spans) {
    if (!isHttpSpan(span)) continue;
    if (looksLikeRetry(span)) continue;

    const fingerprint = fingerprintHttp(span.method, span.url);
    const existing = groups.get(fingerprint);
    if (existing) existing.push(span);
    else groups.set(fingerprint, [span]);
  }
  return groups;
}

function severityFor(costMs: number): FindingSeverity {
  if (costMs >= SEVERITY_CRITICAL_MS) return 'critical';
  if (costMs >= SEVERITY_WARN_MS) return 'warn';
  return 'info';
}

function evaluate(
  run: readonly HttpSpan[],
  fingerprint: string,
  options: SequentialHttpOptions,
): Finding | null {
  if (run.length < options.threshold) return null;
  if (overlapRatio(run) > options.maxOverlapRatio) return null;

  const callsite = singleCallsite(run);
  if (callsite === null) return null;

  let totalMs = 0;
  let slowestMs = 0;
  for (const span of run) {
    totalMs += span.duration;
    if (span.duration > slowestMs) slowestMs = span.duration;
  }

  // Parallel execution is bounded by the slowest call, so the honest saving
  // is everything above it — never more than actually exists.
  const costMs = totalMs - slowestMs;
  if (costMs < options.minWastedMs) return null;

  const first = run[0];
  return {
    detector: 'sequential_http',
    severity: severityFor(costMs),
    title: `${run.length} HTTP calls ran sequentially`,
    costMs,
    callsite,
    evidence: {
      kind: 'sequential_http',
      repeats: run.length,
      fingerprint,
      sample: first ? `${first.method} ${first.url}` : fingerprint,
      totalMs,
      spanIds: run.map((span) => span.id),
    },
    hint:
      'Calls of one shape from one place can run in parallel: `Promise.all(items.map(…))`. ' +
      'Better yet — a batch endpoint, if the API offers one: a single call instead of a series.',
  };
}

/** The sequential-HTTP detector itself. */
export const sequentialHttp: Detector<SequentialHttpOptions> = {
  id: 'sequential_http',

  defaultOptions: {
    // HTTP calls are an order of magnitude dearer than queries, so the bar is
    // lower than the N+1 detector's.
    threshold: 3,
    minWastedMs: 30,
    maxOverlapRatio: 0.2,
    maxGapMs: 100,
  },

  run(scope, options) {
    const findings: Finding[] = [];

    for (const [fingerprint, spans] of groupCalls(scope.spans)) {
      if (spans.length < options.threshold) continue;

      spans.sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
      for (const run of splitRuns(spans, options.maxGapMs)) {
        const finding = evaluate(run, fingerprint, options);
        if (finding) findings.push(finding);
      }
    }

    return findings;
  },
};
