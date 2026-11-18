/**
 * `@reqray/store-memory` — transport and store for local development.
 *
 * Data sits in a ring buffer inside the application itself. Nothing leaves the
 * process, nothing is written to disk: this is the default for
 * `NODE_ENV=development`. In staging and production an HTTP transport to an
 * external collector takes its place.
 */

import { RingBuffer, type Transport } from '@reqray/core';
import {
  type BaselineQuery,
  type DurationSample,
  type FindingSamples,
  type FindingsQuery,
  filterRequests,
  findingSamplesOf,
  type HistoryQuery,
  type HistorySamples,
  historySampleOf,
  normalizeRoute,
  type PageQuery,
  pageFromList,
  type RequestPage,
  type RouteWindow,
  type TimePoint,
} from '@reqray/core/panel';
import type { FiledPatternState, RecordedRequest, StoredPatternState } from '@reqray/protocol';

/** Options for {@link memoryTransport}. */
export interface MemoryTransportOptions {
  /** How many requests to keep. Older ones are evicted. */
  readonly capacity?: number;
}

/**
 * How many requests may be pinned at once.
 *
 * Pinning suspends the ring buffer's promise that memory is bounded, so it
 * gets a bound of its own. Fifty full records with capped bodies is a few
 * megabytes — the price of keeping the incident you are working on.
 */
export const PIN_LIMIT = 50;

/** Buffer summary — what the panel shows in its status bar. */
export interface MemoryStoreStats {
  readonly size: number;
  readonly capacity: number;
  /** How many requests have been evicted since the start. */
  readonly evicted: number;
  /** Start time of the oldest request in the buffer, epoch ms. */
  readonly oldestAt: number | null;
  /** How many requests are pinned, out of {@link PIN_LIMIT}. */
  readonly pinned: number;
}

/** Subscriber for new requests. Needed by the panel's live feed. */
export type MemoryStoreListener = (request: RecordedRequest) => void;

/** A transport that is also the store the panel reads from. */
export interface MemoryStore extends Transport {
  /** Requests newest first — the order the panel displays them in. */
  list(): RecordedRequest[];
  get(id: string): RecordedRequest | undefined;
  clear(): void;
  stats(): MemoryStoreStats;
  /** @returns unsubscribe function. */
  subscribe(listener: MemoryStoreListener): () => void;
  /**
   * Holds a request past its turn in the ring, or lets it go again.
   *
   * @returns `false` when the request is already gone or {@link PIN_LIMIT} is
   * reached. Unpinning always succeeds.
   */
  pin(id: string, pinned: boolean): boolean;
  /** Ids currently pinned. */
  pinned(): string[];
  /**
   * One page of the list, newest first.
   *
   * A ring this size could be served whole, and was — but the panel must not
   * behave differently depending on which store is behind it, and a store
   * that can page is the shape the panel now asks for.
   */
  page(query: PageQuery): RequestPage;
  /** Durations of other calls of one route, for the detail page's verdict. */
  durations(query: BaselineQuery): DurationSample[];
  /** Traffic grouped by route over a stretch of time. */
  counts(query: { from: number; to: number }): RouteWindow[];
  /** Three numbers per request, for the strip above the list. */
  timeSeries(): TimePoint[];
  /** A period's requests, a handful of numbers each, for the history screen. */
  history(query: HistoryQuery): HistorySamples;
  /** Finding occurrences over a stretch, one row each, for the findings tab. */
  findings(query: FindingsQuery): FindingSamples;
  /** `ack`/`muted` per pattern id, as the reader left them. */
  findingStates(): ReadonlyMap<string, FiledPatternState>;
  /** Remembers a state; `new` forgets the pattern. */
  setFindingState(id: string, state: StoredPatternState): void;
}

export function memoryTransport(options: MemoryTransportOptions = {}): MemoryStore {
  const buffer = new RingBuffer<RecordedRequest>(options.capacity ?? 500);
  const byId = new Map<string, RecordedRequest>();
  const listeners = new Set<MemoryStoreListener>();
  /**
   * Pinned records, held here rather than inside the ring: the ring is a plain
   * "drop the oldest" structure and stays that way — skipping slots would cost
   * every push a branch, on the path that has to stay cheap.
   */
  const pinned = new Map<string, RecordedRequest>();
  /**
   * The reader's bookkeeping per finding pattern.
   *
   * In memory beside the requests, and gone with them: a buffer that forgets
   * its requests on restart has nothing for a remembered `ack` to be about.
   * The SQLite store is the one that keeps both.
   */
  const findingStates = new Map<string, FiledPatternState>();

  /** The ring plus any pinned records it has already dropped, newest first. */
  function listAll(): RecordedRequest[] {
    const items = buffer.toArray();
    if (pinned.size === 0) return items;

    const inRing = new Set(items.map((item) => item.id));
    const survivors = [...pinned.values()].filter((item) => !inRing.has(item.id));
    if (survivors.length === 0) return items;
    // Survivors are older than everything in the ring, but sorting keeps the
    // "newest first" promise without depending on that.
    return [...items, ...survivors].sort((a, b) => b.startedAt - a.startedAt);
  }

  return {
    name: 'memory',

    send(request) {
      const displaced = buffer.push(request);
      // A displaced record that is pinned lives on in `pinned`; `get` and
      // `list` look there too.
      if (displaced) byId.delete(displaced.id);
      byId.set(request.id, request);

      for (const listener of listeners) {
        try {
          listener(request);
        } catch {
          // A broken subscriber must not break data collection.
        }
      }
    },

    list: listAll,

    durations(query: BaselineQuery): DurationSample[] {
      const samples: DurationSample[] = [];
      for (const item of listAll()) {
        if (item.id === query.excludeId) continue;
        if (query.from !== undefined && item.startedAt < query.from) continue;
        if (query.to !== undefined && item.startedAt > query.to) continue;
        if (item.method !== query.method) continue;
        if (normalizeRoute(item.path) !== query.route) continue;
        samples.push({
          durationMs: item.durationMs,
          startedAt: item.startedAt,
          hasError: item.error !== null || item.status >= 500,
          loopDelayMs: item.host?.loopDelayMs ?? null,
        });
      }
      return samples;
    },

    counts(query: { from: number; to: number }): RouteWindow[] {
      const grouped = new Map<
        string,
        { method: string; route: string; calls: number; ms: number }
      >();
      for (const item of listAll()) {
        if (item.startedAt < query.from || item.startedAt > query.to) continue;
        const route = normalizeRoute(item.path);
        const key = `${item.method} ${route}`;
        const found = grouped.get(key);
        if (found) {
          found.calls++;
          found.ms += item.durationMs;
        } else {
          grouped.set(key, { method: item.method, route, calls: 1, ms: item.durationMs });
        }
      }
      return [...grouped.values()].map((entry) => ({
        method: entry.method,
        route: entry.route,
        calls: entry.calls,
        avgMs: entry.ms / entry.calls,
      }));
    },

    timeSeries(): TimePoint[] {
      return listAll().map((item) => ({
        startedAt: item.startedAt,
        durationMs: item.durationMs,
        hasError: item.error !== null || item.status >= 500,
      }));
    },

    findings(query: FindingsQuery): FindingSamples {
      const from = query.from ?? Number.NEGATIVE_INFINITY;
      const to = query.to ?? Number.POSITIVE_INFINITY;
      // Bounded by the ring itself, so never truncated — the same honesty
      // deal `history` makes.
      const samples = listAll()
        .filter(
          (item) => item.findings.length > 0 && item.startedAt >= from && item.startedAt <= to,
        )
        .flatMap(findingSamplesOf);
      return { samples, truncated: false };
    },

    findingStates(): ReadonlyMap<string, FiledPatternState> {
      return findingStates;
    },

    setFindingState(id: string, state: StoredPatternState): void {
      if (state === 'new') findingStates.delete(id);
      else findingStates.set(id, state);
    },

    history(query: HistoryQuery): HistorySamples {
      // Never truncated, and not out of generosity: the ring holds what it
      // holds, so reading all of it is bounded by its own capacity. Whether
      // the period reaches further back than the ring does is a different
      // question, and one the retention card on the Project tab answers.
      const samples = filterRequests(listAll(), query.filter).map(historySampleOf);
      return { samples, truncated: false };
    },

    page(query: PageQuery): RequestPage {
      // The rule — pinned rows survive a filter, the cursor counts in whatever
      // the sort orders by — lives in core, so that this store and the panel's
      // own fallback cannot answer differently.
      return pageFromList(listAll(), query, { pinned: new Set(pinned.keys()) });
    },

    get(id) {
      return byId.get(id) ?? pinned.get(id);
    },

    clear() {
      buffer.clear();
      byId.clear();
      // `clear` is someone asking for an empty panel; keeping pinned rows
      // around would leave the list stubbornly non-empty.
      pinned.clear();
    },

    stats() {
      const items = listAll();
      const oldest = items[items.length - 1];
      return {
        // The ring's own occupancy; pinned survivors are counted separately.
        size: buffer.size,
        capacity: buffer.capacity,
        evicted: buffer.evicted,
        oldestAt: oldest ? oldest.startedAt : null,
        pinned: pinned.size,
      };
    },

    pin(id, wanted) {
      if (!wanted) {
        pinned.delete(id);
        return true;
      }
      if (pinned.has(id)) return true;
      if (pinned.size >= PIN_LIMIT) return false;
      const record = byId.get(id);
      if (!record) return false;
      pinned.set(id, record);
      return true;
    },

    pinned() {
      return [...pinned.keys()];
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
