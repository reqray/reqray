import { useEffect, useRef, useState } from 'react';
import type { RequestRow } from '../api';
import { TimelineScrubber } from '../components/TimelineScrubber';
import {
  clock,
  count,
  duration,
  durationTone,
  span as formatSpan,
  methodTone,
  statusTone,
} from '../format';
import { isTypingTarget, nextIndex, scrollTopFor } from '../keyboard';
import { nextSort, type SortKey } from '../sort';
import type { DurationFilter, FilterState, RequestsState } from '../useRequests';

const METHODS = ['GET', 'POST', 'PATCH', 'DELETE'];

/** `key: null` — the pin/compare and flag columns, nothing to sort by. */
const COLUMNS: Array<{ key: SortKey | null; label: string; right?: boolean }> = [
  { key: null, label: '' },
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
  ['tests', 'tests'],
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

/** `A` for the first picked request, `B` for the second, `null` for the rest. */
function slotOf(compare: readonly string[], id: string): string | null {
  const index = compare.indexOf(id);
  return index < 0 ? null : index === 0 ? 'A' : 'B';
}

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
  compareSlot,
  onOpen,
  onPin,
  onCompare,
}: {
  row: RequestRow;
  selected: boolean;
  fresh: boolean;
  /** `A` or `B` when this row is part of the comparison, `null` otherwise. */
  compareSlot: string | null;
  onOpen: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onCompare: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="row row-grid"
      data-tick={tickOf(row, selected)}
      data-selected={selected}
      data-fresh={fresh}
      onClick={(event) => {
        // One click target for the row, three meanings: the glyphs mark
        // themselves so a click on them never opens the detail.
        const hit = (event.target as HTMLElement).closest('[data-act]');
        const act = hit?.getAttribute('data-act');
        if (act === 'pin') onPin(row.id, !row.pinned);
        else if (act === 'cmp') onCompare(row.id);
        else onOpen(row.id);
      }}
    >
      <span className="cell-marks">
        <span
          data-act="pin"
          className={`mark ${row.pinned ? 's-acc' : 's-dim'}`}
          title={
            row.pinned ? 'pinned — survives the ring buffer' : 'pin — survives the ring buffer'
          }
        >
          {row.pinned ? '●' : '○'}
        </span>
        <span
          data-act="cmp"
          className={`mark ${compareSlot ? 's-acc' : 's-dim'}`}
          title="add to the comparison"
        >
          {compareSlot ?? '+'}
        </span>
      </span>
      <span className={`cell-method ${methodTone(row.method)}`}>{row.method}</span>
      <span className="ellipsis">
        {row.path}
        {row.query ? <span className="s-dim">?{row.query}</span> : null}
        {row.test ? (
          <span className="test-mark" title={`issued by ${row.test}`}>
            TEST
          </span>
        ) : null}
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
  compare,
  onOpen,
  onSelect,
  onToggleCompare,
  onClearCompare,
  onOpenCompare,
}: {
  state: RequestsState;
  selected: string | null;
  /** Ids staged for comparison, in the order they were picked (at most two). */
  compare: readonly string[];
  onOpen: (id: string) => void;
  /** Moves the highlight without leaving the list — what `j`/`k` do. */
  onSelect: (id: string) => void;
  onToggleCompare: (id: string) => void;
  onClearCompare: () => void;
  onOpenCompare: () => void;
}) {
  const { filter, setFilter, shown, rows, summary, oldestAt } = state;
  const searchRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  // Arrivals the reader has not seen because they are scrolled away from the
  // top. Prepending rows under the eye would move what they are reading.
  const [pending, setPending] = useState(0);
  const scrolled = useRef(false);
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

  // Count arrivals while the reader is scrolled away, so the banner can offer
  // the trip back up instead of moving the ground under them.
  const topId = useRef<string | null>(null);
  useEffect(() => {
    const top = rows[0]?.id ?? null;
    const previous = topId.current;
    topId.current = top;
    if (previous === null || top === previous || !scrolled.current) return;
    const arrived = rows.findIndex((row) => row.id === previous);
    setPending((current) => current + (arrived > 0 ? arrived : 1));
  }, [rows]);

  useEffect(() => {
    const scrollToRow = (index: number) => {
      const container = rowsRef.current;
      if (!container) return;
      const rowHeight = container.querySelector('.row')?.getBoundingClientRect().height ?? 0;
      const top = scrollTopFor({
        scrollTop: container.scrollTop,
        viewportHeight: container.clientHeight,
        rowHeight,
        index,
      });
      if (top !== null) container.scrollTop = top;
    };

    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;

      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault();
        const current = shown.findIndex((row) => row.id === selected);
        const index = nextIndex(current, event.key === 'j' ? 1 : -1, shown.length);
        const row = shown[index];
        if (!row) return;
        onSelect(row.id);
        scrollToRow(index);
        return;
      }
      if (event.key === 'Enter' && selected) {
        event.preventDefault();
        onOpen(selected);
        return;
      }
      if (event.key === 'p' && selected) {
        event.preventDefault();
        const row = shown.find((item) => item.id === selected);
        if (row) state.pin(row.id, !row.pinned);
        return;
      }
      if (event.key === 'c' && selected) {
        event.preventDefault();
        onToggleCompare(selected);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, selected, onOpen, onSelect, onToggleCompare, state.pin]);

  const patch = (next: Partial<FilterState>) => setFilter({ ...filter, ...next });
  const pinnedCount = rows.reduce((total, row) => total + (row.pinned ? 1 : 0), 0);

  if (rows.length === 0) return <EmptyState error={state.error} />;

  return (
    <div className="requests">
      <TimelineScrubber rows={rows} win={state.win} onWindow={state.setWindow} />

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

      <div
        className="rows"
        ref={rowsRef}
        onScroll={(event) => {
          scrolled.current = event.currentTarget.scrollTop > 8;
          if (!scrolled.current) setPending(0);
        }}
      >
        {shown.map((row) => (
          <Row
            key={row.id}
            row={row}
            selected={row.id === selected}
            fresh={now - (seenAt.current?.get(row.id) ?? 0) < FLASH_WINDOW_MS}
            compareSlot={slotOf(compare, row.id)}
            onOpen={onOpen}
            onPin={state.pin}
            onCompare={onToggleCompare}
          />
        ))}
      </div>

      {compare.length > 0 ? (
        <div className="cmp-bar">
          <span className="s-fg2">
            {compare.length === 1
              ? '1 selected · pick a second request (or press c)'
              : `A #${compare[0]} ↔ B #${compare[1]}`}
          </span>
          <button
            type="button"
            className={compare.length === 2 ? 'btn-primary' : 'btn-secondary'}
            disabled={compare.length < 2}
            onClick={onOpenCompare}
          >
            COMPARE
          </button>
          <button type="button" className="btn-secondary" onClick={onClearCompare}>
            clear
          </button>
        </div>
      ) : null}

      {/* Outside the scroller on purpose: it is an offer to travel, and it has
          to stay put while the rows it counts move. */}
      {pending > 0 ? (
        <button
          type="button"
          className="new-banner"
          onClick={() => {
            if (rowsRef.current) rowsRef.current.scrollTop = 0;
            setPending(0);
          }}
        >
          ↑ {count(pending)} new {pending === 1 ? 'request' : 'requests'}
        </button>
      ) : null}

      <div className="statusbar">
        <span>
          {count(summary.shown)} of {count(summary.total)} entries
        </span>
        <span>slow &gt;500ms: {count(summary.slow)}</span>
        <span>errors: {count(summary.errors)}</span>
        <span>n+1: {count(summary.withFindings)}</span>
        <span>pinned: {count(pinnedCount)}</span>
        <span className="spacer" />
        <span>
          ring buffer {count(rows.length)}
          {pinnedCount > 0 ? ' · pinned entries exempt' : ''}
          {oldestAt ? ` · retained ${formatSpan(Date.now() - oldestAt)}` : ''}
        </span>
      </div>
    </div>
  );
}
