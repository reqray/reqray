/**
 * Shared machinery for loop-shaped detectors.
 *
 * N+1 and sequential-HTTP are the same finding over different span kinds:
 * repeats of one fingerprint, sequential in time, from a single line of code.
 * The heuristics live here once, so both detectors treat time and attribution
 * identically.
 */

import type { Callsite } from '../types.js';

/** What the run heuristics need to know about a span. */
export interface TimedSpan {
  readonly id: number;
  readonly startedAt: number;
  readonly duration: number;
  readonly callsite: Callsite | null;
}

export function endOf(span: TimedSpan): number {
  return span.startedAt + span.duration;
}

/**
 * Splits a fingerprint group into runs on time gaps.
 *
 * The same call at the start and at the end of handling, separated by a long
 * unrelated operation, is not a loop. Splitting lets each run be judged on
 * its own, and short runs simply fall short of the threshold.
 */
export function splitRuns<T extends TimedSpan>(sorted: readonly T[], maxGapMs: number): T[][] {
  const runs: T[][] = [];
  let current: T[] = [];
  let previousEnd = Number.NEGATIVE_INFINITY;

  for (const span of sorted) {
    if (current.length > 0 && span.startedAt - previousEnd > maxGapMs) {
      runs.push(current);
      current = [];
      previousEnd = Number.NEGATIVE_INFINITY;
    }
    current.push(span);
    previousEnd = Math.max(previousEnd, endOf(span));
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Share of adjacent pairs that overlap in time.
 *
 * A loop is a waterfall: each call starts after the previous one finished.
 * Calls issued through `Promise.all` overlap — that is already optimised,
 * nothing to fix.
 */
export function overlapRatio(run: readonly TimedSpan[]): number {
  if (run.length < 2) return 0;

  let overlapping = 0;
  for (let i = 1; i < run.length; i++) {
    const previous = run[i - 1];
    const current = run[i];
    if (!previous || !current) continue;
    const overlap =
      Math.min(endOf(previous), endOf(current)) - Math.max(previous.startedAt, current.startedAt);
    if (overlap > 0) overlapping++;
  }
  return overlapping / (run.length - 1);
}

/**
 * The single place in the code the whole run came from.
 *
 * Returns `null` if the known callsites disagree (the same call from
 * different places is a coincidence, not a loop) or if there are none at all:
 * a finding without a line of code reports a problem but does not help fix it.
 */
export function singleCallsite(run: readonly TimedSpan[]): Callsite | null {
  let found: Callsite | null = null;
  for (const span of run) {
    const callsite = span.callsite;
    if (!callsite) continue;
    if (!found) {
      found = callsite;
      continue;
    }
    if (found.file !== callsite.file || found.line !== callsite.line) return null;
  }
  return found;
}
