import { useEffect, useRef } from 'react';
import type { RequestRow } from '../api';
import {
  clock,
  count,
  duration,
  durationTone,
  span as formatSpan,
  methodTone,
  statusTone,
} from '../format';
import { nextSort, type SortKey } from '../sort';
import type { DurationFilter, FilterState, RequestsState } from '../useRequests';

const METHODS = ['GET', 'POST', 'PATCH', 'DELETE'];

/** `key: null` — the flag column, purely visual, nothing to sort by. */
const COLUMNS: Array<{ key: SortKey | null; label: string; right?: boolean }> = [
  { key: 'method', label: 'METHOD' },
  { key: 'path', label: 'PATH' },
  { key: 'status', label: 'ST', right: true },
  { key: null, label: '' },
  { key: 'duration', label: 'DURATION', right: true },
  { key: 'sql', label: 'SQL', right: true },
  { key: 'time', label: 'TIME', right: true },
];
const STATUS_CLASSES = [2, 3, 4, 5];
const DURATIONS: Array<[DurationFilter, string]> = [
  ['any', 'any'],
  ['slow100', '>100ms'],
  ['slow500', '>500ms'],
  ['nplus', 'N+1'],
];

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/**
 * Freshness is a moment, not a flag: slightly longer than the 1.4s flash, so
 * a row flashes once on arrival and stays quiet when a filter change or a
 * sort remounts it later.
 */
const FLASH_WINDOW_MS = 1500;

/** Left tick — the only severity marker visible while scanning the list. */
function tickOf(row: RequestRow, selected: boolean): string | undefined {
  if (selected) return 'acc';
  if (row.status >= 500) return 'err';
  if (row.durationMs >= 700) return 'warn';
  return undefined;
}

function Row({
  row,
  selected,
  fresh,
  onOpen,
}: {
  row: RequestRow;
  selected: boolean;
  fresh: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="row row-grid"
      data-tick={tickOf(row, selected)}
      data-selected={selected}
      data-fresh={fresh}
      onClick={() => onOpen(row.id)}
    >
      <span className={`cell-method ${methodTone(row.method)}`}>{row.method}</span>
      <span className="ellipsis">
        {row.path}
        {row.query ? <span className="s-dim">?{row.query}</span> : null}
      </span>
      <span
        className={`cell-right ${statusTone(row.status)}`}
        style={{ fontWeight: row.status >= 400 ? 700 : 400 }}
      >
        {row.status}
      </span>
      <span className="cell-center">
        {row.nPlusOne ? (
          <span className="flag" title="Possible N+1 query pattern">
            N+1
          </span>
        ) : row.findingCount > 0 ? (
          <span className="flag" title="Sequential calls that could run in parallel">
            SEQ
          </span>
        ) : null}
      </span>
      <span className={`cell-right ${durationTone(row.durationMs)}`}>
        {duration(row.durationMs)}
      </span>
      <span
        className={`cell-right ${row.sqlCount === 0 ? 's-dim' : row.nPlusOne ? 's-warn' : 's-fg2'}`}
      >
        {row.sqlCount === 0 ? '—' : row.sqlCount}
      </span>
      <span className="cell-right s-dim">{clock(row.startedAt)}</span>
    </button>
  );
}

function EmptyState({ error }: { error: string | null }) {
  return (
    <div className="empty">
      <div className="empty-card">
        <div className="empty-head">
          <span className="pulse" />
          {error
            ? `collector unreachable — ${error}`
            : 'collector attached — waiting for the first request'}
        </div>
        <div className="empty-body">
          <h1 className="empty-title">No requests recorded yet</h1>
          <p className="empty-text">
            Loupe is listening on the application it was attached to. Hit any route and it will
            appear here instantly.
          </p>
          <div className="empty-label">TRY IT</div>
          <div className="snippet">curl -s localhost:3000/api/orders | jq</div>
          <div className="snippet s-fg2">{'// or just reload your app in the browser'}</div>
        </div>
      </div>
    </div>
  );
}

export function RequestsScreen({
  state,
  selected,
  onOpen,
}: {
  state: RequestsState;
  selected: string | null;
  onOpen: (id: string) => void;
}) {
  const { filter, setFilter, shown, rows, summary, oldestAt } = state;
  const searchRef = useRef<HTMLInputElement>(null);
  // When each id was first seen. Written during render on purpose: a row must
  // count as fresh on its very first paint, before any effect has run. The
  // write is idempotent per id, so re-renders are safe.
  const seenAt = useRef<Map<string, number> | null>(null);
  const now = Date.now();
  if (seenAt.current === null) {
    // Rows present when the screen opens are history, not arrivals.
    if (rows.length > 0) seenAt.current = new Map(rows.map((row) => [row.id, 0]));
  } else {
    for (const row of rows) {
      if (!seenAt.current.has(row.id)) seenAt.current.set(row.id, now);
    }
  }

  // Ids evicted from the ring buffer have nothing left to flash.
  useEffect(() => {
    const map = seenAt.current;
    if (!map) return;
    const live = new Set(rows.map((row) => row.id));
    for (const id of map.keys()) {
      if (!live.has(id)) map.delete(id);
    }
  }, [rows]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.target !== document.body) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const patch = (next: Partial<FilterState>) => setFilter({ ...filter, ...next });

  if (rows.length === 0) return <EmptyState error={state.error} />;

  return (
    <div className="requests">
      <div className="filters">
        <label className="search">
          <span className="search-hint">/</span>
          <input
            ref={searchRef}
            value={filter.query}
            placeholder="filter path, status, header…"
            onChange={(event) => patch({ query: event.target.value })}
          />
        </label>

        <span className="divider" />
        {METHODS.map((method) => (
          <button
            key={method}
            type="button"
            className="chip"
            aria-pressed={filter.methods.includes(method)}
            onClick={() => patch({ methods: toggle(filter.methods, method) })}
          >
            {method}
          </button>
        ))}

        <span className="divider" />
        {STATUS_CLASSES.map((cls) => (
          <button
            key={cls}
            type="button"
            className="chip"
            aria-pressed={filter.statusClasses.includes(cls)}
            onClick={() => patch({ statusClasses: toggle(filter.statusClasses, cls) })}
          >
            {cls}xx
          </button>
        ))}

        <span className="divider" />
        {DURATIONS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="chip"
            aria-pressed={filter.duration === value}
            onClick={() => patch({ duration: value })}
          >
            {label}
          </button>
        ))}

        <span className="spacer" />
        <button
          type="button"
          className="btn-secondary btn-danger"
          onClick={() => void state.clear()}
        >
          clear
        </button>
      </div>

      <div className="row-head row-grid">
        {COLUMNS.map(({ key, label, right }) =>
          key === null ? (
            <span key="flags" />
          ) : (
            <button
              key={key}
              type="button"
              className={`sort-head ${right ? 'cell-right' : ''}`}
              aria-pressed={state.sort.key === key}
              onClick={() => state.setSort(nextSort(state.sort, key))}
            >
              {label}
              {state.sort.key === key ? (
                <span className="sort-dir">{state.sort.dir === 'asc' ? '▲' : '▼'}</span>
              ) : null}
            </button>
          ),
        )}
      </div>

      <div className="rows">
        {shown.map((row) => (
          <Row
            key={row.id}
            row={row}
            selected={row.id === selected}
            fresh={now - (seenAt.current?.get(row.id) ?? 0) < FLASH_WINDOW_MS}
            onOpen={onOpen}
          />
        ))}
      </div>

      <div className="statusbar">
        <span>
          {count(summary.shown)} of {count(summary.total)} entries
        </span>
        <span>slow &gt;500ms: {count(summary.slow)}</span>
        <span>errors: {count(summary.errors)}</span>
        <span>n+1: {count(summary.withFindings)}</span>
        <span className="spacer" />
        <span>
          ring buffer {count(rows.length)}
          {oldestAt ? ` · retained ${formatSpan(Date.now() - oldestAt)}` : ''}
        </span>
      </div>
    </div>
  );
}
