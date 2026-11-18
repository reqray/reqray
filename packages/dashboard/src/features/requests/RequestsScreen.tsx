import { useEffect, useMemo, useRef, useState } from 'react';
import { isTypingTarget, nextIndex, scrollTopFor } from '../../app/keyboard';
import { ago, count } from '../../shared/format';
import {
  type DurationFilter,
  describeFilter,
  EMPTY_FILTER,
  type FilterState,
  isFiltering,
} from '../../shared/list/filter';
import { nextSort, type SortKey } from '../../shared/list/sort';
import type { RequestsState } from '../../shared/list/useRequests';
import {
  filterOf,
  loadViews,
  type SavedView,
  saveViews,
  viewOf,
  withView,
} from '../../shared/list/views';
import { Skeleton } from '../../shared/ui/Skeleton';
import { BURST_MIN, type BurstGroup, groupBursts } from './lib/bursts';
import { loadRules, type RuleId, saveRules } from './lib/rules';
import { BurstRow } from './parts/BurstRow';
import { EmptyState } from './parts/EmptyState';
import { OpenGroup } from './parts/OpenGroup';
import { RulesPopover } from './parts/RulesPopover';
import { TimelineScrubber } from './parts/TimelineScrubber';
import { TimeRangePopover } from './parts/TimeRangePopover';
import { ViewsPopover } from './parts/ViewsPopover';

const METHODS = ['GET', 'POST', 'PATCH', 'DELETE'];

/** `key: null` — the pin/compare and flag columns, nothing to sort by. */
const COLUMNS: Array<{ id: string; key: SortKey | null; label: string; right?: boolean }> = [
  { id: 'gutter', key: null, label: '' },
  { id: 'marks', key: null, label: '' },
  { id: 'method', key: 'method', label: 'METHOD' },
  { id: 'path', key: 'path', label: 'PATH' },
  { id: 'status', key: 'status', label: 'ST', right: true },
  { id: 'flag', key: null, label: '' },
  { id: 'duration', key: 'duration', label: 'DURATION', right: true },
  { id: 'cpu', key: 'cpu', label: 'CPU', right: true },
  { id: 'sql', key: 'sql', label: 'SQL', right: true },
  { id: 'time', key: 'time', label: 'TIME', right: true },
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

/**
 * Above this many arrivals a second, nothing animates.
 *
 * An animation that cannot be followed is worse than none: at ten rows a
 * second the flash is a strobe and the slide is a shudder, and neither says
 * "this one is new" — which is the only thing they were for.
 */
const FLASH_RATE_LIMIT = 5;

interface RequestsScreenProps {
  state: RequestsState;
  selected: string | null;
  /** Ids staged for comparison, in the order they were picked (at most two). */
  compare: readonly string[];
  onOpen: (id: string) => void;
  /** The status bar's findings count leads to the tab, scoped to the window. */
  onOpenFindings: () => void;
  /** Moves the highlight without leaving the list — what `j`/`k` do. */
  onSelect: (id: string) => void;
  onToggleCompare: (id: string) => void;
  onClearCompare: () => void;
  onOpenCompare: () => void;
}

export function RequestsScreen({
  state,
  selected,
  compare,
  onOpen,
  onOpenFindings,
  onSelect,
  onToggleCompare,
  onClearCompare,
  onOpenCompare,
}: RequestsScreenProps) {
  const { filter, setFilter, shown, rows, summary, oldestAt } = state;
  const searchRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  // Arrivals the reader has not seen because they are scrolled away from the
  // top. Prepending rows under the eye would move what they are reading.
  const [pending, setPending] = useState(0);
  const scrolled = useRef(false);
  /** Collapse identical simultaneous calls — a setting, persisted. */
  const [bursts, setBursts] = useState(
    () => typeof localStorage === 'undefined' || localStorage.getItem('reqray.bursts') !== 'off',
  );
  /** Bursts the reader expanded in place, by their newest row's id. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());

  const toggleBursts = () => {
    setBursts((current) => {
      const next = !current;
      try {
        localStorage.setItem('reqray.bursts', next ? 'on' : 'off');
      } catch {
        // No storage — the toggle still works for this session.
      }
      return next;
    });
  };
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

  // How fast rows are arriving, from the marks already kept: nothing extra
  // to measure, and the answer is exactly "how many appeared this second".
  let arrivedLately = 0;
  if (seenAt.current) {
    for (const at of seenAt.current.values()) if (at > 0 && now - at < 1_000) arrivedLately++;
  }
  const flashing = arrivedLately <= FLASH_RATE_LIMIT;

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

  // A burst is a moment in the feed's own order; any other sort has already
  // dissolved it, so grouping only happens under the default sort.
  const groups = useMemo<BurstGroup[]>(() => {
    if (!bursts || state.sort.key !== 'time' || state.sort.dir !== 'desc') {
      return shown.map((row) => ({ head: row, rows: [row] }));
    }
    return groupBursts(shown);
  }, [shown, bursts, state.sort.key, state.sort.dir]);

  /** What is actually on screen — what j/k walk and Enter opens. */
  const visible = useMemo(
    () =>
      groups.flatMap((group) =>
        group.rows.length >= BURST_MIN && !opened.has(group.head.id) ? [group.head] : group.rows,
      ),
    [groups, opened],
  );

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
        const current = visible.findIndex((row) => row.id === selected);
        const index = nextIndex(current, event.key === 'j' ? 1 : -1, visible.length);
        const row = visible[index];
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
        const row = visible.find((item) => item.id === selected);
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
  }, [visible, selected, onOpen, onSelect, onToggleCompare, state.pin]);

  const [rules, setRules] = useState<ReadonlySet<RuleId>>(() =>
    loadRules(typeof localStorage === 'undefined' ? null : localStorage),
  );
  const [rulesOpen, setRulesOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const [views, setViews] = useState(() =>
    loadViews(typeof localStorage === 'undefined' ? null : localStorage),
  );
  const [viewsOpen, setViewsOpen] = useState(false);

  const keepViews = (next: ReturnType<typeof loadViews>) => {
    setViews(next);
    saveViews(typeof localStorage === 'undefined' ? null : localStorage, next);
  };

  const toggleRule = (id: RuleId) => {
    setRules((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      saveRules(typeof localStorage === 'undefined' ? null : localStorage, next);
      return next;
    });
  };

  /** A burst opened in place, and closed again, by its newest row's id. */
  const openBurst = (id: string) => setOpened((current) => new Set(current).add(id));

  const closeBurst = (id: string) =>
    setOpened((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });

  /** A saved view is the whole question, so it replaces the filter and closes. */
  const applyView = (view: SavedView) => {
    setFilter(filterOf(view));
    setViewsOpen(false);
  };

  /** The scroller decides whether arrivals may be prepended under the eye. */
  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    scrolled.current = event.currentTarget.scrollTop > 8;
    if (!scrolled.current) setPending(0);
  };

  /** The banner's offer to travel: back to the top, where the new rows are. */
  const showNewest = () => {
    if (rowsRef.current) rowsRef.current.scrollTop = 0;
    setPending(0);
  };

  const patch = (next: Partial<FilterState>) => setFilter({ ...filter, ...next });
  const pinnedCount = rows.reduce((total, row) => total + (row.pinned ? 1 : 0), 0);
  /** The slowest request in view: what every duration bar is measured against. */
  const yardMs = shown.reduce((peak, row) => Math.max(peak, row.durationMs), 0);

  // The welcome screen is for an empty store, never for an empty result: a
  // filter that matched nothing must not take away the filters that caused
  // it, or there is no way back. And never while the first page is still in
  // flight — "no requests recorded yet" is a claim, and a screen that makes
  // it before the answer arrives is wrong about half the time.
  if (rows.length === 0 && !isFiltering(filter) && summary.total === 0 && !state.loading) {
    return <EmptyState error={state.error} />;
  }

  return (
    <div className="requests">
      <TimelineScrubber
        rows={rows}
        report={state.timeline}
        win={state.win}
        scope={state.timelineScope}
        span={state.timelineSpan}
        onScope={state.setTimelineScope}
        onWindow={state.setWindow}
      />

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

        {/* Only the chips scroll: the rules pill and `clear` must stay put,
            and an overflow container would clip the popover anyway. */}
        <div className="filter-chips">
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
        </div>

        <TimeRangePopover
          range={filter.range}
          coverage={state.timeline}
          open={timeOpen}
          onToggleOpen={() => setTimeOpen((open) => !open)}
          onPick={state.setWindow}
        />
        <ViewsPopover
          views={views}
          open={viewsOpen}
          canSave={isFiltering(filter)}
          onToggleOpen={() => setViewsOpen((open) => !open)}
          onApply={applyView}
          onSave={(name) => keepViews(withView(views, viewOf(name, filter)))}
          onDelete={(name) => keepViews(views.filter((view) => view.name !== name))}
        />
        <RulesPopover
          enabled={rules}
          open={rulesOpen}
          onToggleOpen={() => setRulesOpen((open) => !open)}
          onToggleRule={toggleRule}
        />
        <button
          type="button"
          className="btn-secondary btn-danger"
          onClick={() => void state.clear()}
        >
          clear
        </button>
      </div>

      <div className="row-head row-grid">
        {COLUMNS.map(({ id, key, label, right }) =>
          key === null ? (
            <span key={id} />
          ) : (
            <button
              key={id}
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

      <div className="rows" ref={rowsRef} onScroll={onScroll}>
        {shown.length === 0 && state.loading ? (
          <Skeleton rows={4} label="reading the list" />
        ) : null}

        {shown.length === 0 && !state.loading ? (
          <div className="rows-empty mono">
            <span className="s-dim">nothing matches — {count(summary.total)} recorded</span>
            {isFiltering(filter) ? (
              <span className="rows-empty-terms">
                {describeFilter(filter).map((term) => (
                  <span key={term} className="rows-empty-term">
                    {term}
                  </span>
                ))}
              </span>
            ) : null}
            <button
              type="button"
              className="btn-secondary"
              onClick={() => state.setFilter(EMPTY_FILTER)}
            >
              clear the filters
            </button>
          </div>
        ) : null}

        {groups.map((group) =>
          group.rows.length >= BURST_MIN && !opened.has(group.head.id) ? (
            <BurstRow
              key={group.head.id}
              group={group}
              yardMs={yardMs}
              onExpand={() => openBurst(group.head.id)}
            />
          ) : (
            <OpenGroup
              key={group.head.id}
              group={group}
              burst={group.rows.length >= BURST_MIN}
              selected={selected}
              compare={compare}
              rules={rules}
              yardMs={yardMs}
              freshSince={flashing ? now - FLASH_WINDOW_MS : null}
              seenAt={seenAt.current}
              onOpen={onOpen}
              onPin={state.pin}
              onCompare={onToggleCompare}
              onCollapse={() => closeBurst(group.head.id)}
            />
          ),
        )}

        {state.hasMore ? (
          <button type="button" className="load-more" onClick={state.loadMore}>
            {state.loadingMore ? 'loading…' : '↓ older requests'}
          </button>
        ) : null}
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
        <button type="button" className="new-banner" onClick={showNewest}>
          ↑ {count(pending)} new {pending === 1 ? 'request' : 'requests'}
        </button>
      ) : null}

      <div className="statusbar">
        <span>
          {count(summary.shown)} of {count(summary.total)} entries
        </span>
        <button
          type="button"
          className="sb-link sb-warn"
          aria-pressed={filter.duration === 'slow500'}
          onClick={() => patch({ duration: filter.duration === 'slow500' ? 'any' : 'slow500' })}
        >
          slow &gt;500ms: {count(summary.slow)}
        </button>
        <button
          type="button"
          className="sb-link sb-err"
          aria-pressed={filter.statusClasses.includes(5)}
          onClick={() => patch({ statusClasses: toggle(filter.statusClasses, 5) })}
        >
          errors: {count(summary.errors)}
        </button>
        <button type="button" className="sb-link sb-warn" onClick={onOpenFindings}>
          findings: {count(summary.withFindings)}
        </button>
        <span>pinned: {count(pinnedCount)}</span>
        <span className="spacer" />
        <button
          type="button"
          className="sb-link"
          aria-pressed={bursts}
          title="collapse identical simultaneous calls into one row"
          onClick={toggleBursts}
        >
          bursts: {bursts ? 'grouped' : 'shown'}
        </button>
        {filter.route ? (
          <button
            type="button"
            className="route-filter"
            title="clear the route filter"
            onClick={() => patch({ route: null })}
          >
            route filter: {filter.route.method} {filter.route.route} ✕
          </button>
        ) : null}
        <span>
          loaded {count(rows.length)}
          {state.hasMore ? '+' : ''}
          {pinnedCount > 0 ? ' · pinned entries exempt' : ''}
          {oldestAt ? ` · back to ${ago(oldestAt)}` : ''}
        </span>
      </div>
    </div>
  );
}
