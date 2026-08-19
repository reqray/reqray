/**
 * `@loupe/transport-memory` — transport and store for local development.
 *
 * Data sits in a ring buffer inside the application itself. Nothing leaves the
 * process, nothing is written to disk: this is the default for
 * `NODE_ENV=development`. In staging and production an HTTP transport to an
 * external collector takes its place.
 */

import { type RecordedRequest, RingBuffer, type Transport } from '@loupe/core';

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
}

/** Creates the in-memory transport with its store. */
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
