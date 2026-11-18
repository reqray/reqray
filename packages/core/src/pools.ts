/**
 * Registry of live connection pools.
 *
 * A pool is the one part of the picture that cannot be reconstructed from
 * spans. A span says a query waited; only the pool says whether it was the
 * last free connection or the fortieth request in a queue, and that is the
 * difference between "raise `max`" and "stop holding connections". So the
 * panel asks the pool itself, at the moment somebody is looking.
 *
 * Two rules hold this together.
 *
 * References are weak. A pool that the application closed and dropped must be
 * collectable; a registry that keeps one alive is a leak with a nice name.
 *
 * And core knows nothing about any driver. Each instrumentation registers its
 * pools with a reader that speaks that driver's dialect — `totalCount` and
 * `idleCount` in `pg`, something else in the next one — so this file never
 * grows a `if (driver === …)`.
 */

import type { PoolReading, PoolStats } from '@reqray/protocol';
import { type Box, globalBox, globalSlot } from './state.js';

/** A registered pool: the reference stays weak, the reader knows the driver. */
interface PoolEntry {
  readonly id: number;
  readonly ref: WeakRef<object>;
  readonly read: (pool: object) => PoolReading | null;
}

/** Live pools, weakly held. */
const pools = globalSlot('pools.live', () => new Set<PoolEntry>());

/** Pools already registered, keyed by the pool itself. */
const registered = globalSlot('pools.registered', () => new WeakMap<object, PoolEntry>());

/** Id source for {@link pools}. */
const sequence: () => Box<number> = globalBox('pools.sequence', 0);

export type { PoolReading, PoolStats };

/**
 * Registers a pool, idempotently.
 *
 * Called from the instrumentation on every pooled query, so it has to be
 * cheap and it has to tolerate being called a million times: a pool already
 * registered costs one `WeakMap` lookup and nothing else.
 */
export function registerPool(pool: object, read: (pool: object) => PoolReading | null): void {
  try {
    const known = registered();
    if (known.has(pool)) return;

    const seq = sequence();
    seq.value += 1;
    const entry: PoolEntry = { id: seq.value, ref: new WeakRef(pool), read };
    known.set(pool, entry);
    pools().add(entry);
  } catch {
    // A registry failure must never reach the query that triggered it.
  }
}

/**
 * What every live pool says about itself, right now.
 *
 * Entries whose pool has been collected are dropped on the way past: this is
 * the only moment the registry is walked, so it is the only place the dead
 * ones can be noticed.
 */
export function poolStats(): PoolStats[] {
  const stats: PoolStats[] = [];
  try {
    const live = pools();
    for (const entry of live) {
      const pool = entry.ref.deref();
      if (!pool) {
        live.delete(entry);
        continue;
      }
      try {
        const reading = entry.read(pool);
        if (reading) stats.push({ id: entry.id, ...reading });
      } catch {
        // A driver that changed shape reports nothing rather than throwing
        // into whoever opened the panel.
      }
    }
  } catch {
    return stats;
  }
  return stats;
}

/** Forgets every pool. Needed by tests. */
export function resetPools(): void {
  pools().clear();
}
