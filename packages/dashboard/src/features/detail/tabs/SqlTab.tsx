import { useEffect, useMemo, useState } from 'react';
import type { ExplainResult, RequestDetail, Span } from '../../../api/index';
import { QueryRow } from '../parts/QueryRow';

type DbSpan = Extract<Span, { kind: 'db' }>;

export interface QueryGroup {
  id: number;
  fingerprint: string;
  sql: string;
  calls: number;
  durationMs: number;
  rowCount: number | null;
  callsite: DbSpan['callsite'];
  /** Values of the first call of the group — only under `collectSqlValues`. */
  values: readonly string[] | null;
}

/**
 * Groups repeats of one fingerprint into a single row.
 *
 * A hundred and fifty identical lines are honest and unreadable; the design
 * shows one row with a `150 calls` note instead.
 */
export function groupQueries(spans: readonly Span[]): QueryGroup[] {
  const groups = new Map<string, QueryGroup>();

  for (const span of spans) {
    if (span.kind !== 'db') continue;
    const existing = groups.get(span.fingerprint);
    if (existing) {
      existing.calls++;
      existing.durationMs += span.duration;
      existing.callsite ??= span.callsite;
      continue;
    }
    groups.set(span.fingerprint, {
      id: span.id,
      fingerprint: span.fingerprint,
      sql: span.sql,
      calls: 1,
      durationMs: span.duration,
      rowCount: span.rowCount,
      callsite: span.callsite,
      values: span.values ?? null,
    });
  }

  return [...groups.values()];
}

export type PlanState =
  | { status: 'loading' }
  | { status: 'done'; result: ExplainResult }
  | { status: 'error'; message: string };

interface SqlTabProps {
  detail: RequestDetail;
  plans: Map<number, PlanState>;
  /** A fingerprint to open and scroll to — the fix card's "show the calls". */
  focus: string | null;
  onExplain: (spanId: number) => void;
}

export function SqlTab({ detail, plans, focus, onExplain }: SqlTabProps) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const queries = useMemo(() => groupQueries(detail.spans), [detail]);

  useEffect(() => {
    if (!focus) return;
    const target = queries.find((query) => query.fingerprint === focus);
    if (!target) return;
    setOpen((current) => new Set(current).add(target.id));
    document.getElementById(`sql-${target.id}`)?.scrollIntoView({ block: 'center' });
  }, [focus, queries]);

  if (queries.length === 0)
    return <p className="s-dim mono">no database queries in this request</p>;

  const toggle = (id: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      {queries.map((query) => (
        <QueryRow
          key={query.id}
          query={query}
          open={open.has(query.id)}
          plan={plans.get(query.id)}
          onToggle={() => toggle(query.id)}
          onExplain={() => onExplain(query.id)}
        />
      ))}
    </div>
  );
}
