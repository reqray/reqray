import { useEffect, useMemo, useState } from 'react';
import { fetchRoutes, type RouteStats } from '../api';
import { count, duration, durationTone, methodTone } from '../format';

/** Columns, in the order they are drawn; `key` is also the sort key. */
const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'calls', label: 'CALLS' },
  { key: 'rps', label: 'RPS' },
  { key: 'p50', label: 'P50' },
  { key: 'p95', label: 'P95' },
  { key: 'p99', label: 'P99' },
  { key: 'errorRate', label: 'ERR' },
  { key: 'sqlAvg', label: 'SQL AVG' },
  { key: 'timeShare', label: 'TIME SHARE' },
];

type SortKey = 'calls' | 'rps' | 'p50' | 'p95' | 'p99' | 'errorRate' | 'sqlAvg' | 'timeShare';

/** How many rows carry the "most expensive endpoint" marker. */
const EXPENSIVE = 3;

function errorTone(rate: number): string {
  if (rate > 5) return 's-err';
  if (rate > 0) return 's-warn';
  return 's-dim';
}

function shareTone(share: number): string {
  if (share > 66) return 'var(--err)';
  if (share > 33) return 'var(--warn)';
  return 'var(--acc)';
}

export function RoutesScreen({
  onPickRoute,
}: {
  /** Filters the request list down to this route. */
  onPickRoute: (route: { method: string; route: string }) => void;
}) {
  const [report, setReport] = useState<{
    routes: RouteStats[];
    samples: number;
    windowMs: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'timeShare',
    dir: 'desc',
  });

  useEffect(() => {
    const controller = new AbortController();
    fetchRoutes(controller.signal)
      .then((payload) => {
        setReport(payload);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, []);

  const rows = useMemo(() => {
    if (!report) return [];
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...report.routes].sort((a, b) => sign * (a[sort.key] - b[sort.key]));
  }, [report, sort]);

  // The marker means "expensive", so it only makes sense in the default order.
  const marksExpensive = sort.key === 'timeShare' && sort.dir === 'desc';

  if (error) {
    return (
      <div className="routes">
        <div className="routes-head">routes unavailable — {error}</div>
      </div>
    );
  }

  return (
    <div className="routes">
      <div className="routes-head">
        <span>
          {count(report?.routes.length ?? 0)} routes · {count(report?.samples ?? 0)} samples ·
          window {Math.round((report?.windowMs ?? 0) / 1000)}s
        </span>
        <span className="spacer" />
        <span>normalized: numeric segments → :id · query stripped</span>
      </div>

      <div className="routes-body">
        <div className="routes-grid routes-header">
          <span />
          <span>ROUTE</span>
          {COLUMNS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className="sort-head cell-right"
              aria-pressed={sort.key === key}
              onClick={() =>
                setSort((current) =>
                  current.key === key
                    ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
                    : { key, dir: 'desc' },
                )
              }
            >
              {label}
              {sort.key === key ? (
                <span className="sort-dir">{sort.dir === 'asc' ? '▲' : '▼'}</span>
              ) : null}
            </button>
          ))}
        </div>

        {rows.map((row, index) => (
          <button
            key={`${row.method} ${row.route}`}
            type="button"
            className="routes-grid routes-row"
            data-tick={marksExpensive && index < EXPENSIVE ? 'warn' : undefined}
            onClick={() => onPickRoute({ method: row.method, route: row.route })}
          >
            <span className="s-dim">{index + 1}</span>
            <span className="ellipsis">
              <span className={methodTone(row.method)}>{row.method}</span> {row.route}
            </span>
            <span className="cell-right s-fg2">{count(row.calls)}</span>
            <span className="cell-right s-fg2">{row.rps.toFixed(2)}</span>
            <span className={`cell-right ${durationTone(row.p50)}`}>{duration(row.p50)}</span>
            <span className={`cell-right ${durationTone(row.p95)}`}>{duration(row.p95)}</span>
            <span className={`cell-right ${durationTone(row.p99)}`}>{duration(row.p99)}</span>
            <span className={`cell-right ${errorTone(row.errorRate)}`}>
              {row.errorRate.toFixed(1)}%
            </span>
            <span className={`cell-right ${row.sqlAvg >= 20 ? 's-warn' : 's-fg2'}`}>
              {row.sqlAvg.toFixed(1)}
            </span>
            <span className="cell-right route-share">
              <span className="s-dim">{row.timeShare.toFixed(1)}%</span>
              <span className="share-track">
                <span
                  className="share-fill"
                  style={{
                    width: `${Math.min(100, row.timeShare)}%`,
                    background: shareTone(row.timeShare),
                  }}
                />
              </span>
            </span>
          </button>
        ))}

        {report && report.routes.length === 0 ? (
          <div className="routes-empty s-fg2">
            Nothing recorded yet — hit a route and it will show up here.
          </div>
        ) : null}
      </div>
    </div>
  );
}
