/**
 * Comparison of two requests, grouped by work shape.
 *
 * Answers the most common debugging question — "why is it sometimes fast
 * and sometimes slow" — with a table instead of eyeballing two waterfalls: the same
 * group on both sides, its calls and time, and the delta. Groups missing on
 * one side are the loudest signal and sort by the absolute delta.
 */

import type { RequestDetail, Span } from '../../../api/index';
import { cacheCall, clock, oneLine } from '../../../shared/format';

/** One side's share of a group. */
export interface CompareSide {
  readonly calls: number;
  readonly totalMs: number;
}

/** One row of the comparison table. */
export interface CompareGroup {
  readonly key: string;
  readonly kind: Span['kind'];
  readonly label: string;
  readonly a: CompareSide;
  readonly b: CompareSide;
  /** `b.totalMs - a.totalMs` — positive means B spent more here. */
  readonly deltaMs: number;
}

/** Spans of one shape collapse into one row: db by fingerprint, http by target. */
function keyOf(span: Span): [key: string, label: string] {
  switch (span.kind) {
    case 'db':
      return [`db:${span.fingerprint}`, oneLine(span.sql)];
    case 'http': {
      // The query string is almost always the varying part — it is not a shape.
      const target = span.url.split('?')[0] ?? span.url;
      return [`http:${span.method} ${target}`, `${span.method} ${target}`];
    }
    case 'cache': {
      const call = cacheCall(span);
      return [`cache:${call}`, call];
    }
    default:
      return [`${span.kind}:${span.label}`, span.label];
  }
}

function accumulate(
  spans: readonly Span[],
  side: 'a' | 'b',
  groups: Map<string, { kind: Span['kind']; label: string; a: CompareSide; b: CompareSide }>,
): void {
  for (const span of spans) {
    const [key, label] = keyOf(span);
    const group = groups.get(key) ?? {
      kind: span.kind,
      label,
      a: { calls: 0, totalMs: 0 },
      b: { calls: 0, totalMs: 0 },
    };
    const bucket = group[side];
    groups.set(key, {
      ...group,
      [side]: { calls: bucket.calls + 1, totalMs: bucket.totalMs + span.duration },
    });
  }
}

/** Builds the comparison rows, loudest difference first. */
export function buildComparison(a: RequestDetail, b: RequestDetail): CompareGroup[] {
  const groups = new Map<
    string,
    { kind: Span['kind']; label: string; a: CompareSide; b: CompareSide }
  >();
  accumulate(a.spans, 'a', groups);
  accumulate(b.spans, 'b', groups);

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      kind: group.kind,
      label: group.label,
      a: group.a,
      b: group.b,
      deltaMs: group.b.totalMs - group.a.totalMs,
    }))
    .sort(
      (left, right) =>
        Math.abs(right.deltaMs) - Math.abs(left.deltaMs) || left.key.localeCompare(right.key),
    );
}

/** One row of the metrics table above the span diff. */
export interface MetricRow {
  readonly label: string;
  readonly a: string;
  readonly b: string;
  /** `=`, `≠`, or a signed number — what the Δ column prints. */
  readonly delta: string;
  readonly tone: 'dim' | 'warn' | 'ok' | 'err';
}

function countSql(detail: RequestDetail): number {
  return detail.spans.filter((span) => span.kind === 'db').length;
}

/** Read from the findings rather than the row flag: the detail always has them. */
function hasNPlusOne(detail: RequestDetail): boolean {
  return detail.findings.some((finding) => finding.detector === 'n_plus_one');
}

/**
 * A numeric row where lower is better: durations, query counts, findings.
 *
 * The sign is kept in the text so the reader sees direction without doing
 * arithmetic, and the colour says whether that direction is good news.
 */
function lowerIsBetter(label: string, a: number, b: number, unit = ''): MetricRow {
  const delta = b - a;
  const rounded = Math.abs(delta) < 0.05 ? 0 : delta;
  const text = (value: number) =>
    unit === ' ms' ? `${Math.round(value)}${unit}` : `${value}${unit}`;

  return {
    label,
    a: text(a),
    b: text(b),
    delta: rounded === 0 ? '=' : `${rounded > 0 ? '+' : '−'}${text(Math.abs(rounded))}`,
    tone: rounded === 0 ? 'dim' : rounded < 0 ? 'ok' : 'err',
  };
}

/** A row that is either the same on both sides or simply different. */
function sameOrNot(label: string, a: string, b: string, tone: 'warn' | 'dim' = 'dim'): MetricRow {
  const same = a === b;
  return { label, a, b, delta: same ? '=' : '≠', tone: same ? 'dim' : tone };
}

/** The metrics table: the facts about each request, side by side. */
export function buildMetrics(a: RequestDetail, b: RequestDetail): MetricRow[] {
  return [
    sameOrNot('method', a.method, b.method),
    sameOrNot('path', a.path, b.path),
    // A status difference is never just a difference: one of them failed.
    sameOrNot('status', String(a.status), String(b.status), 'warn'),
    lowerIsBetter('duration', a.durationMs, b.durationMs, ' ms'),
    lowerIsBetter('sql queries', countSql(a), countSql(b)),
    sameOrNot(
      'n+1',
      hasNPlusOne(a) ? 'detected' : 'none',
      hasNPlusOne(b) ? 'detected' : 'none',
      'warn',
    ),
    lowerIsBetter('findings', a.findings.length, b.findings.length),
    sameOrNot('from test', a.test ?? '—', b.test ?? '—'),
    sameOrNot('recorded', clock(a.startedAt), clock(b.startedAt)),
  ];
}

/**
 * The sentence a reader would write after looking at the table.
 *
 * Stating the conclusion in words is the point of the screen: two columns of
 * numbers still leave the question "so which one is better, and why" to the
 * reader, and that is the question they came with.
 */
export function buildVerdict(a: RequestDetail, b: RequestDetail): string {
  const parts: string[] = [];
  const deltaMs = b.durationMs - a.durationMs;
  // Of the slower one, whichever that is: "faster by 67%" then reads the
  // same in both directions and can never pass 100%. Measured against A
  // alone, A = 10 ms beside B = 1000 ms came out as "faster by 9900%".
  const longer = Math.max(a.durationMs, b.durationMs);
  const share = longer > 0 ? (Math.abs(deltaMs) / longer) * 100 : 0;

  if (Math.abs(deltaMs) < 1) {
    parts.push('A and B took the same time.');
  } else {
    const faster = deltaMs < 0 ? 'B' : 'A';
    parts.push(
      `${faster} is faster by ${Math.round(Math.abs(deltaMs))} ms (${Math.round(share)}%).`,
    );
  }

  if (hasNPlusOne(a) !== hasNPlusOne(b)) {
    parts.push(hasNPlusOne(a) ? 'The N+1 is gone in B.' : 'B has an N+1 that A does not.');
  }

  const sqlDelta = countSql(b) - countSql(a);
  if (sqlDelta !== 0) {
    parts.push(
      sqlDelta < 0
        ? `B runs ${Math.abs(sqlDelta)} fewer queries.`
        : `B runs ${sqlDelta} more queries.`,
    );
  }

  // What to do next comes from the slower side's own findings.
  const slower = deltaMs < 0 ? a : b;
  const worst = [...slower.findings].sort((left, right) => right.costMs - left.costMs)[0];
  if (worst) {
    parts.push(
      `Next: ${worst.title.toLowerCase()}${
        worst.callsite ? ` at ${worst.callsite.relative}:${worst.callsite.line}` : ''
      }.`,
    );
  } else if (Math.abs(deltaMs) >= 1) {
    parts.push('Neither side has an outstanding finding — the difference is elsewhere.');
  }

  return parts.join(' ');
}
