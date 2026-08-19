/**
 * Comparison of two requests, grouped by work shape.
 *
 * Answers the most common debugging question — "why is it sometimes fast
 * and sometimes slow" — with a table instead of eyeballing two waterfalls: the same
 * group on both sides, its calls and time, and the delta. Groups missing on
 * one side are the loudest signal and sort by the absolute delta.
 */

import type { RequestDetail, Span } from './api';
import { oneLine } from './format';

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
    case 'cache':
      return [`cache:${span.operation}:${span.key}`, `cache.${span.operation} ${span.key}`];
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
