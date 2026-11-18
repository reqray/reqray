/**
 * N+1 detector — Reqray's flagship finding.
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

const LIMIT = /\bLIMIT\b/i;

/**
 * Whether the run is one table being read a page at a time.
 *
 * `WHERE id > $1 ORDER BY id LIMIT 500` in a loop is the same SQL from the
 * same line, one after another — everything an N+1 is, except that it is the
 * fix rather than the problem: the alternative is one query for the whole
 * table. What gives it away is the shape of the answers: every page full, the
 * same size, until the last one. A lookup per parent row does not come back
 * like that unless every parent has exactly as many children as the limit,
 * and then "fetch them with one IN" would be the wrong advice anyway.
 *
 * A limit of one is left alone: that is `findFirst` in a loop, the most
 * common N+1 there is.
 */
function isPaging(run: readonly DbSpan[], fingerprint: string): boolean {
  if (!LIMIT.test(fingerprint)) return false;

  const pageSize = run[0]?.rowCount ?? null;
  if (pageSize === null || pageSize < 2) return false;

  const last = run.length - 1;
  for (let i = 0; i < last; i++) {
    if (run[i]?.rowCount !== pageSize) return false;
  }
  const tail = run[last]?.rowCount ?? null;
  return tail !== null && tail <= pageSize;
}

function evaluate(
  run: readonly DbSpan[],
  fingerprint: string,
  options: NPlusOneOptions,
): Finding | null {
  if (run.length < options.threshold) return null;
  if (isPaging(run, fingerprint)) return null;
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
