import { Fragment, useMemo, useState } from 'react';
import { fetchRoutes, type RouteStats } from '../../api/index';
import { useLive } from '../../app/PanelContext';
import { count } from '../../shared/format';
import type { SortDir } from '../../shared/list/sort';
import { useLiveQuery } from '../../shared/useLiveQuery';
import { RouteCharts } from './parts/RouteCharts';
import { RouteRow } from './parts/RouteRow';

/** What identifies a route in this table: the pair, as one string. */
function keyOf(row: RouteStats): string {
  return `${row.method} ${row.route}`;
}

/** Columns, in the order they are drawn; `key` is also the sort key. */
const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'findings', label: 'FINDINGS' },
  { key: 'calls', label: 'CALLS' },
  { key: 'trend', label: 'TREND' },
  { key: 'rps', label: 'RPS' },
  { key: 'p50', label: 'P50' },
  { key: 'p95', label: 'P95' },
  { key: 'p99', label: 'P99' },
  { key: 'errorRate', label: 'ERR' },
  { key: 'sqlAvg', label: 'SQL AVG' },
  { key: 'bytesAvg', label: 'BYTES AVG' },
  { key: 'timeShare', label: 'TIME SHARE' },
];

type SortKey =
  | 'findings'
  | 'trend'
  | 'calls'
  | 'rps'
  | 'p50'
  | 'p95'
  | 'p99'
  | 'errorRate'
  | 'sqlAvg'
  | 'bytesAvg'
  | 'timeShare';

/** How many rows carry the "most expensive endpoint" marker. */
const EXPENSIVE = 3;

interface RoutesScreenProps {
  /** Opens one request — the chart peeks lead straight to the detail. */
  onOpenRequest: (id: string) => void;
  /** Filters the request list down to this route. */
  onPickRoute: (route: { method: string; route: string }) => void;
}

export function RoutesScreen({ onOpenRequest, onPickRoute }: RoutesScreenProps) {
  const live = useLive();
  // The table already on screen survives a failed refresh: a blip in a
  // ten-second poll must not replace a page of numbers with an apology.
  const { data: report, error } = useLiveQuery(fetchRoutes, { live, keepLastGood: true });
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: 'timeShare',
    dir: 'desc',
  });

  /** A second click on the same column turns it around. */
  const sortBy = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'desc' },
    );

  const rows = useMemo(() => {
    if (!report) return [];
    const sign = sort.dir === 'asc' ? 1 : -1;
    // A route with nothing to report sorts as if it were empty rather than
    // jumping to the top: the column is "how much this returns", and "we
    // never found out" is not the answer to that.
    const value = (row: RouteStats): number => {
      // Sorting by findings means by what they cost, not by how many kinds
      // there are: one N+1 worth a second outranks three cheap duplicates.
      if (sort.key === 'findings') {
        return row.findings.reduce((sum, found) => sum + found.recoverableMs, 0);
      }
      // And by trend means by where the traffic is: a route that stopped
      // being called an hour ago sorts away from one that is busy now.
      if (sort.key === 'trend') {
        const last = row.trend.reduce((at, calls, index) => (calls > 0 ? index : at), -1);
        return last;
      }
      return row[sort.key] ?? 0;
    };
    return [...report.routes].sort((a, b) => sign * (value(a) - value(b)));
  }, [report, sort]);

  // One route open at a time: the charts are the point of opening it, and two
  // sets of them on screen is a dashboard, which is the thing this is not.
  const [open, setOpen] = useState<string | null>(null);

  // The marker means "expensive", so it only makes sense in the default order.
  const marksExpensive = sort.key === 'timeShare' && sort.dir === 'desc';

  /** The route that costs the most — the one bar that earns a colour. */
  const worst = useMemo(
    () =>
      rows.reduce<RouteStats | null>(
        (top, row) => (top === null || row.timeShare > top.timeShare ? row : top),
        null,
      ),
    [rows],
  );

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
              onClick={() => sortBy(key)}
            >
              {label}
              {sort.key === key ? (
                <span className="sort-dir">{sort.dir === 'asc' ? '▲' : '▼'}</span>
              ) : null}
            </button>
          ))}
        </div>

        {rows.map((row, index) => {
          const key = keyOf(row);
          return (
            <Fragment key={key}>
              <RouteRow
                row={row}
                rank={index + 1}
                marked={marksExpensive && index < EXPENSIVE}
                worst={row === worst}
                expanded={open === key}
                onToggle={() => setOpen(open === key ? null : key)}
              />
              {open === key ? (
                <RouteCharts
                  row={row}
                  from={report?.from ?? 0}
                  to={report?.to ?? 0}
                  onOpenRequest={onOpenRequest}
                  onPickRoute={onPickRoute}
                />
              ) : null}
            </Fragment>
          );
        })}

        {report && report.routes.length === 0 ? (
          <div className="routes-empty s-fg2">
            Nothing recorded yet — hit a route and it will show up here.
          </div>
        ) : null}
      </div>
    </div>
  );
}
