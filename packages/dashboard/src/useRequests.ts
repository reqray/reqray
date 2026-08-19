import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearRequests,
  fetchRequests,
  pinRequest,
  type RequestRow,
  subscribeToRequests,
} from './api';
import { DEFAULT_SORT, type SortState, sortRows } from './sort';
import { inWindow, type TimeWindow } from './timeline';

/**
 * The chips in the last filter group are radio-like: exactly one is active.
 * `tests` is not about duration, but it belongs to the same single-choice
 * group — "show me only this kind of request".
 */
export type DurationFilter = 'any' | 'slow100' | 'slow500' | 'nplus' | 'tests';

export interface FilterState {
  query: string;
  methods: string[];
  statusClasses: number[];
  duration: DurationFilter;
  /** Set by picking a row on the Routes screen; cleared from the status bar. */
  route: { method: string; route: string } | null;
}

export const EMPTY_FILTER: FilterState = {
  query: '',
  methods: [],
  statusClasses: [],
  duration: 'any',
  route: null,
};

export interface RequestsState {
  rows: RequestRow[];
  shown: RequestRow[];
  summary: { shown: number; total: number; slow: number; errors: number; withFindings: number };
  oldestAt: number | null;
  filter: FilterState;
  sort: SortState;
  /** The scrubber's selection; `null` is the whole recorded range. */
  win: TimeWindow | null;
  error: string | null;
  loading: boolean;
  setFilter: (next: FilterState) => void;
  setSort: (next: SortState) => void;
  setWindow: (next: TimeWindow | null) => void;
  /** Pins or unpins a request; a refusal leaves the row as it was. */
  pin: (id: string, pinned: boolean) => void;
  clear: () => Promise<void>;
  reload: () => void;
}

function matches(row: RequestRow, filter: FilterState): boolean {
  if (filter.route && (row.method !== filter.route.method || row.route !== filter.route.route)) {
    return false;
  }
  const needle = filter.query.trim().toLowerCase();
  if (needle) {
    const haystack = `${row.method} ${row.path} ${row.query ?? ''} ${row.status}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (filter.methods.length && !filter.methods.includes(row.method.toUpperCase())) return false;
  if (filter.statusClasses.length && !filter.statusClasses.includes(Math.floor(row.status / 100))) {
    return false;
  }
  switch (filter.duration) {
    case 'slow100':
      return row.durationMs >= 100;
    case 'slow500':
      return row.durationMs >= 500;
    case 'nplus':
      return row.nPlusOne;
    case 'tests':
      return row.test !== null;
    default:
      return true;
  }
}

/**
 * Request list plus the live feed.
 *
 * Filtering happens client-side even though the API supports it: rows arriving
 * over the live feed never pass through the server filter, and the list must
 * not show two different notions of "matching".
 *
 * @param active the list screen is visible. The feed does not run behind the
 * detail screen — nothing there would show it.
 */
export function useRequests(active: boolean, live: boolean): RequestsState {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [win, setWindow] = useState<TimeWindow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const capacity = useRef(500);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is a trigger, not a read value
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchRequests({}, controller.signal)
      .then((payload) => {
        setRows(payload.requests);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadToken]);

  useEffect(() => {
    if (!active || !live) return;
    return subscribeToRequests((row) => {
      setRows((current) => {
        // The server holds a ring buffer; the client mirrors its cap so the
        // page cannot grow without bound during a long session.
        const next = [row, ...current.filter((existing) => existing.id !== row.id)];
        return next.length > capacity.current ? next.slice(0, capacity.current) : next;
      });
    });
  }, [active, live]);

  const shown = useMemo(
    () =>
      sortRows(
        // A pinned row is one the reader deliberately set aside; it stays on
        // screen through filters and through the timeline window, or pinning
        // would mean "keep it, then hide it".
        rows.filter((row) => row.pinned || (inWindow(row.startedAt, win) && matches(row, filter))),
        sort,
      ),
    [rows, filter, sort, win],
  );

  const summary = useMemo(() => {
    let slow = 0;
    let errors = 0;
    let withFindings = 0;
    for (const row of rows) {
      if (row.durationMs >= 500) slow++;
      if (row.hasError) errors++;
      if (row.nPlusOne) withFindings++;
    }
    return { shown: shown.length, total: rows.length, slow, errors, withFindings };
  }, [rows, shown.length]);

  const oldestAt = rows.length > 0 ? (rows[rows.length - 1]?.startedAt ?? null) : null;

  const clear = useCallback(async () => {
    await clearRequests();
    setRows([]);
  }, []);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const pin = useCallback((id: string, wanted: boolean) => {
    void pinRequest(id, wanted).then((pinned) => {
      // The collector decides: it may be out of pin slots, or the record may
      // already be gone. The row follows what it answers.
      setRows((current) => current.map((row) => (row.id === id ? { ...row, pinned } : row)));
    });
  }, []);

  return {
    rows,
    shown,
    summary,
    oldestAt,
    filter,
    sort,
    win,
    error,
    loading,
    setFilter,
    setSort,
    setWindow,
    pin,
    clear,
    reload,
  };
}
