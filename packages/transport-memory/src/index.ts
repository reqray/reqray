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

/** Buffer summary — what the panel shows in its status bar. */
export interface MemoryStoreStats {
  readonly size: number;
  readonly capacity: number;
  /** How many requests have been evicted since the start. */
  readonly evicted: number;
  /** Start time of the oldest request in the buffer, epoch ms. */
  readonly oldestAt: number | null;
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
}

/** Creates the in-memory transport with its store. */
export function memoryTransport(options: MemoryTransportOptions = {}): MemoryStore {
  const buffer = new RingBuffer<RecordedRequest>(options.capacity ?? 500);
  const byId = new Map<string, RecordedRequest>();
  const listeners = new Set<MemoryStoreListener>();

  return {
    name: 'memory',

    send(request) {
      const displaced = buffer.push(request);
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

    list() {
      return buffer.toArray();
    },

    get(id) {
      return byId.get(id);
    },

    clear() {
      buffer.clear();
      byId.clear();
    },

    stats() {
      const items = buffer.toArray();
      const oldest = items[items.length - 1];
      return {
        size: buffer.size,
        capacity: buffer.capacity,
        evicted: buffer.evicted,
        oldestAt: oldest ? oldest.startedAt : null,
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
