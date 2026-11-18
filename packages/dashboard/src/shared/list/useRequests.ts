/** The request list: one page at a time, plus whatever arrives live. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearRequests,
  fetchRequests,
  fetchTimeline,
  pinRequest,
  type RequestRow,
  type RequestSummary,
  subscribeToRequests,
} from '../../api/index';
import { asQuery, EMPTY_FILTER, type FilterState, matches, queryKey } from './filter';
import { DEFAULT_CAPACITY, insertRow, SLOW_MS, withArrival } from './insert';
import { DEFAULT_SORT, type SortState, sortRows } from './sort';
import {
  BUCKET_COUNT,
  newestRun,
  type Timeline,
  type TimelineScope,
  type TimeWindow,
} from './timeline';
import { parseQuery } from './tokens';

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
  /**
   * The shape of the traffic, over the stretch named by `timelineScope`.
   *
   * `null` from a store that does not keep one; the strip then draws itself
   * from the rows in hand, as it always did.
   */
  timeline: Timeline | null;
  /** Which stretch that is: the newest run of traffic, or everything kept. */
  timelineScope: TimelineScope;
  /**
   * The whole span, when the strip is showing less than it.
   *
   * `null` means the strip already covers everything, and there is nothing to
   * offer a way back to.
   */
  timelineSpan: TimeWindow | null;
  setTimelineScope: (scope: TimelineScope) => void;
  /** The store has older requests than the ones loaded. */
  hasMore: boolean;
  loadingMore: boolean;
  /** Fetches the next page of older requests and appends it. */
  loadMore: () => void;
  setFilter: (next: FilterState) => void;
  /** Selects a stretch of time; `null` is everything the store holds. */
  setSort: (next: SortState) => void;
  setWindow: (next: TimeWindow | null) => void;
  /** Pins or unpins a request; a refusal leaves the row as it was. */
  pin: (id: string, pinned: boolean) => void;
  clear: () => Promise<void>;
  reload: () => void;
}

/**
 * How long the panel waits before asking the server about a filter.
 *
 * Typing narrows the loaded rows on the very next frame, locally; this delay
 * is only about the request that goes looking through the rest of the history.
 */
const FILTER_DEBOUNCE_MS = 250;

/**
 * How often the strip above the list is redrawn from the store.
 *
 * It is a shape, not a reading: a few seconds out of date costs nothing, and
 * asking on every arrival would put a request on the wire per request
 * recorded.
 */
const TIMELINE_REFRESH_MS = 10_000;

/**
 * Request list plus the live feed.
 *
 * Filtering happens client-side even though the API supports it: rows arriving
 * over the live feed never pass through the server filter, and the list must
 * not show two different notions of "matching".
 *
 * @param active the list screen is visible. The feed does not run behind the
 * detail screen — nothing there would show it.
 * @param bufferSize the server's ring size, from the panel meta. Until it
 * arrives the client uses {@link DEFAULT_CAPACITY}.
 */
export function useRequests(active: boolean, live: boolean, bufferSize?: number): RequestsState {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  // No state of its own: the selected stretch lives in the filter, so it goes
  // to the store with everything else the reader narrowed by.
  const win = filter.range;
  const setWindow = useCallback(
    (next: TimeWindow | null) => setFilter((current) => ({ ...current, range: next })),
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** The store's own numbers, which cover more than the rows on screen. */
  const [stored, setStored] = useState<RequestSummary | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  /**
   * Which stretch the strip is drawn over.
   *
   * `recent` is the newest run of traffic, when the store holds much more
   * silence than traffic; `full` is everything it keeps. Only what is *drawn*
   * — the list is not filtered by it, so nothing disappears without being
   * asked to.
   */
  const [scope, setScope] = useState<TimelineScope>('recent');
  /** The whole span, when the strip is showing less than it. */
  const [timelineSpan, setTimelineSpan] = useState<TimeWindow | null>(null);
  const filterQuery = queryKey(filter);
  const capacity = useRef(DEFAULT_CAPACITY);
  /** The filter the list was last asked with; `null` before the first ask. */
  const askedFor = useRef<string | null>(null);
  /** The live feed has been off since the rows on screen were read. */
  const feedStopped = useRef(false);
  // What the reader has narrowed to, for the live feed to read. A ref for the
  // same reason as the capacity: a keystroke in the search must not close and
  // re-open the stream.
  const narrowedTo = useRef({ filter, parsed: parseQuery(filter.query) });
  useEffect(() => {
    narrowedTo.current = { filter, parsed: parseQuery(filter.query) };
  }, [filter]);

  // Held in a ref rather than read from the closure: changing it must not tear
  // down and re-open the live feed, which would drop whatever arrived in
  // between.
  useEffect(() => {
    capacity.current = bufferSize && bufferSize > 0 ? bufferSize : DEFAULT_CAPACITY;
  }, [bufferSize]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is a trigger, and the filter is read through its key
  useEffect(() => {
    const controller = new AbortController();
    const ask = () => {
      setLoading(true);
      fetchRequests(asQuery(filter), null, controller.signal)
        .then((payload) => {
          setRows(payload.requests);
          setNextCursor(payload.nextCursor);
          setStored(payload.summary);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    };

    // A filter change waits, so a reader typing "orders" sends one request
    // rather than six. Everything else is immediate: the first load, and a
    // re-read after a reconnect or a pause, where the wait would only be a
    // quarter of a second of looking at a list with a hole in it.
    const typing = askedFor.current !== null && askedFor.current !== filterQuery;
    askedFor.current = filterQuery;
    const timer = setTimeout(ask, typing ? FILTER_DEBOUNCE_MS : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [reloadToken, filterQuery]);

  /**
   * The strip covers the store, not the filter and not the page.
   *
   * Deliberately not refetched when the filter changes: a strip that redrew
   * itself to the stretch just selected would leave nothing to drag back out
   * of. It is refreshed on a timer instead, because requests keep arriving
   * while it is on screen.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is a trigger, not a read value
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const load = () => {
      fetchTimeline(BUCKET_COUNT, null, controller.signal)
        .then((full) => {
          if (!full) {
            setTimeline(null);
            return;
          }
          // A store that keeps a week and an application that ran for an hour
          // draw a strip that is empty but for two columns. When the traffic
          // sits at one end, the strip is drawn over that end instead — with
          // the whole span one click away, so nothing is hidden.
          const run = scope === 'recent' ? newestRun(full) : null;
          setTimelineSpan(newestRun(full) === null ? null : [full.from, full.to]);
          if (!run) {
            setTimeline(full);
            return;
          }
          void fetchTimeline(BUCKET_COUNT, { from: run[0], to: run[1] }, controller.signal).then(
            (zoomed) => setTimeline(zoomed ?? full),
          );
        })
        .catch(() => {
          // An older panel API has no strip to serve; the rows still do.
        });
    };
    load();
    if (!live) return () => controller.abort();

    const timer = setInterval(load, TIMELINE_REFRESH_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [active, live, reloadToken, scope]);

  useEffect(() => {
    if (!active || !live) {
      feedStopped.current = true;
      return;
    }
    // Back from a pause or from another screen: whatever arrived meanwhile
    // is missing from the middle of the list, with nothing to mark the gap.
    // The same hole a reconnect leaves, and the same answer.
    if (feedStopped.current) {
      feedStopped.current = false;
      setReloadToken((token) => token + 1);
    }
    return subscribeToRequests(
      (row) => {
        // Only what the filter lets through goes into the list. The list is
        // capped, so a row that would be hidden anyway still took a place —
        // and under `status:5xx` a few hundred ordinary requests pushed every
        // match out, leaving "nothing matches" over a store full of them.
        const { filter: current, parsed } = narrowedTo.current;
        if (matches(row, current, parsed)) {
          setRows((held) => insertRow(held, row, capacity.current));
        }
        // The summary is the store's, and the store did receive it.
        setStored((held) => (held ? withArrival(held, row) : held));
      },
      // Reconnected: the rows on screen may have a hole where the connection
      // was, and a list that quietly skips requests is worse than one that
      // starts over from what the store actually has.
      () => setReloadToken((token) => token + 1),
    );
  }, [active, live]);

  const shown = useMemo(() => {
    // Parsed once per filter change, not per row per keystroke.
    const parsed = parseQuery(filter.query);
    return sortRows(
      // A pinned row is one the reader deliberately set aside; it stays on
      // screen through filters and through the timeline window, or pinning
      // would mean "keep it, then hide it".
      // The store already applied the filter to the page it served; this
      // applies it again to rows the live feed brought in, which never went
      // past the server at all.
      rows.filter((row) => row.pinned || matches(row, filter, parsed)),
      sort,
    );
  }, [rows, filter, sort]);

  const summary = useMemo(() => {
    // Two different facts, both true and both checkable by looking: how many
    // rows are on screen, and how many requests the store holds. What is on
    // screen is the client's to count — the filter, the timeline window and
    // the live feed all move it, and the store was asked about none of them.
    if (stored) return { ...stored, shown: shown.length };

    let slow = 0;
    let errors = 0;
    let withFindings = 0;
    for (const row of rows) {
      if (row.durationMs >= SLOW_MS) slow++;
      if (row.hasError) errors++;
      if (row.findingCount > 0) withFindings++;
    }
    return { shown: shown.length, total: rows.length, slow, errors, withFindings };
  }, [rows, shown.length, stored]);

  /**
   * Fetches the next page of older requests.
   *
   * Appended rather than replacing: the reader is reading down the list, and
   * pulling the ground out from under them is not paging.
   */
  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    fetchRequests(asQuery(filter), nextCursor)
      .then((payload) => {
        setRows((current) => {
          const known = new Set(current.map((row) => row.id));
          return [...current, ...payload.requests.filter((row) => !known.has(row.id))];
        });
        setNextCursor(payload.nextCursor);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setLoadingMore(false));
  }, [filter, loadingMore, nextCursor]);

  const oldestAt = rows.length > 0 ? (rows[rows.length - 1]?.startedAt ?? null) : null;

  const clear = useCallback(async () => {
    // The rows go only once the store says they are gone, or a refusal empties
    // the screen and the next poll puts everything back.
    try {
      await clearRequests();
      setRows([]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
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
    timeline,
    timelineScope: scope,
    timelineSpan,
    setTimelineScope: setScope,
    hasMore: nextCursor !== null,
    loadingMore,
    loadMore,
    setFilter,
    setSort,
    setWindow,
    pin,
    clear,
    reload,
  };
}
