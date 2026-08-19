/**
 * N+1 detector — Loupe's flagship finding.
 *
 * The governing principle here is not up for debate: **a false positive is
 * worse than a miss**. A tool that cries wolf gets switched off within a week.
 * So every heuristic below discards cases where the repeats have a plausible
 * explanation, even at the cost of missing some real N+1s.
 */

import { sqlOperation } from '../sql.js';
import type { DbSpan, Finding, FindingSeverity, Span } from '../types.js';
import { overlapRatio, singleCallsite, splitRuns } from './runs.js';
import type { Detector } from './types.js';

/** Detector thresholds. All exposed as options — the user tunes them. */
export interface NPlusOneOptions {
  /** How many consecutive repeats make a group suspicious. */
  readonly threshold: number;
  /** Below this saving there is nothing worth reporting. */
  readonly minWastedMs: number;
  /**
   * Share of adjacent pairs overlapping in time above which the queries are
   * treated as parallel rather than as a loop.
   */
  readonly maxOverlapRatio: number;
  /**
   * Gap between adjacent repeats above which this is no longer one loop but
   * two different places that happened to run the same query.
   */
  readonly maxGapMs: number;
}

const SEVERITY_CRITICAL_MS = 200;
const SEVERITY_WARN_MS = 50;

const TABLE_FROM_SQL = /\bFROM\s+"?([\w$.]+)"?/i;

function isDbSpan(span: Span): span is DbSpan {
  return span.kind === 'db';
}

/**
 * Groups SELECT spans by fingerprint.
 *
 * Batched `INSERT`/`UPDATE` is normal practice and must not be flagged, so
 * everything but `select` is dropped up front.
 */
function groupSelects(spans: readonly Span[]): Map<string, DbSpan[]> {
  const groups = new Map<string, DbSpan[]>();
  for (const span of spans) {
    if (!isDbSpan(span)) continue;
    if (sqlOperation(span.fingerprint) !== 'select') continue;

    const existing = groups.get(span.fingerprint);
    if (existing) existing.push(span);
    else groups.set(span.fingerprint, [span]);
  }
  return groups;
}

function severityFor(costMs: number): FindingSeverity {
  if (costMs >= SEVERITY_CRITICAL_MS) return 'critical';
  if (costMs >= SEVERITY_WARN_MS) return 'warn';
  return 'info';
}

function hintFor(source: string | null, fingerprint: string): string {
  const table = TABLE_FROM_SQL.exec(fingerprint)?.[1] ?? 'the related table';

  switch (source) {
    case 'prisma':
      return `Prisma: pull "${table}" in with \`include\` on the parent query — one JOIN instead of a series of queries`;
    case 'drizzle':
      return `Drizzle: pull "${table}" in with \`with\` on the parent query`;
    case 'typeorm':
      return `TypeORM: list "${table}" in the parent query's \`relations\``;
    default:
      return `Collect the ids and fetch "${table}" with a single \`WHERE … IN (…)\` instead of a query per iteration`;
  }
}

function evaluate(
  run: readonly DbSpan[],
  fingerprint: string,
  options: NPlusOneOptions,
): Finding | null {
  if (run.length < options.threshold) return null;
  if (overlapRatio(run) > options.maxOverlapRatio) return null;

  const callsite = singleCallsite(run);
  if (!callsite) return null;

  let totalMs = 0;
  let slowestMs = 0;
  for (const span of run) {
    totalMs += span.duration;
    if (span.duration > slowestMs) slowestMs = span.duration;
  }

  // The fix does not remove the query altogether — it replaces the run with a
  // single query. Its cost is taken to be the slowest query of the run: a
  // deliberately conservative estimate, since we must never promise more saved
  // time than actually exists.
  const costMs = totalMs - slowestMs;
  if (costMs < options.minWastedMs) return null;

  const first = run[0];
  return {
    detector: 'n_plus_one',
    severity: severityFor(costMs),
    title: `${run.length} identical queries ran in a loop`,
    costMs,
    callsite,
    evidence: {
      kind: 'n_plus_one',
      repeats: run.length,
      fingerprint,
      sample: first ? first.sql : fingerprint,
      totalMs,
      spanIds: run.map((span) => span.id),
    },
    hint: hintFor(first?.source ?? null, fingerprint),
  };
}

/** The N+1 detector itself. */
export const nPlusOne: Detector<NPlusOneOptions> = {
  id: 'n_plus_one',

  defaultOptions: {
    threshold: 5,
    minWastedMs: 20,
    maxOverlapRatio: 0.2,
    maxGapMs: 100,
  },

  run(scope, options) {
    const findings: Finding[] = [];

    for (const [fingerprint, spans] of groupSelects(scope.spans)) {
      // The whole group is below the threshold, so no run inside it can pass.
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
