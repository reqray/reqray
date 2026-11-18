/**
 * State that has to be single per process.
 *
 * `@reqray/core` is built as both ESM and CJS, and both builds can end up
 * loaded in one application at once: the adapter came in through `import`,
 * while a loader hook or a third-party package came in through `require`. That
 * gives two sets of module-level variables, and it is not cosmetic — two
 * `AsyncLocalStorage` instances mean instrumentation never sees the scope the
 * adapter created, and nothing is recorded at all.
 *
 * So anything that must be single lives on `globalThis`, under a symbol from
 * the global registry that both copies resolve to the same way. This file does
 * not hold that state — it hands out slots, and each module declares, names
 * and types the state it owns.
 */

/** Version in the key: an incompatible change of shape must not break silently. */
const REGISTRY_KEY = Symbol.for('reqray.state.v2');

type Holder = typeof globalThis & { [REGISTRY_KEY]?: Map<string, unknown> };

function registry(): Map<string, unknown> {
  const holder = globalThis as Holder;
  const existing = holder[REGISTRY_KEY];
  if (existing) return existing;

  const fresh = new Map<string, unknown>();
  holder[REGISTRY_KEY] = fresh;
  return fresh;
}

/**
 * Declares one piece of process-wide state and returns the way to read it.
 *
 * The name is the identity across module copies, so it must be unique and
 * stable — by convention, `<module>.<what>`. The accessor caches after the
 * first call: `current()` is the first line of every instrumentation wrapper
 * and must not cost a global lookup and a map read each time.
 *
 * @example
 * const fingerprints = globalSlot('sql.fingerprints', () => new Map<string, string>());
 */
export function globalSlot<T>(name: string, create: () => T): () => T {
  let cached: T | undefined;
  let resolved = false;

  return (): T => {
    if (resolved) return cached as T;

    const slots = registry();
    if (!slots.has(name)) slots.set(name, create());
    cached = slots.get(name) as T;
    resolved = true;
    return cached;
  };
}

/**
 * A single mutable value, for state that is not an object.
 *
 * A slot hands back a reference, so a boolean or a counter needs something to
 * be a reference *to*.
 */
export interface Box<T> {
  value: T;
}

/** @see Box */
export function globalBox<T>(name: string, initial: T): () => Box<T> {
  return globalSlot(name, () => ({ value: initial }));
}

/**
 * A bounded cache with no cliff at the limit.
 *
 * Clearing at the ceiling would make an application sitting just over it throw
 * away its hottest entries with its coldest and miss on everything until the
 * cache refills. Instead the hot generation becomes the cold one and a fresh
 * one starts; a read that hits the cold one promotes the entry. Holds at most
 * twice `limit`.
 */
export class TwoGenerationCache<K, V> {
  #hot = new Map<K, V>();
  #cold = new Map<K, V>();

  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    const hot = this.#hot.get(key);
    if (hot !== undefined) return hot;

    const cold = this.#cold.get(key);
    if (cold === undefined) return undefined;
    // Used again, so it belongs in the generation that will survive.
    this.#hot.set(key, cold);
    return cold;
  }

  set(key: K, value: V): void {
    if (this.#hot.size >= this.limit) {
      this.#cold = this.#hot;
      this.#hot = new Map<K, V>();
    }
    this.#hot.set(key, value);
  }

  /** Whether the key is known in either generation. */
  has(key: K): boolean {
    return this.#hot.has(key) || this.#cold.has(key);
  }

  clear(): void {
    this.#hot.clear();
    this.#cold.clear();
  }

  /** Entries held right now, across both generations. Needed by tests. */
  get size(): number {
    let total = this.#hot.size;
    for (const key of this.#cold.keys()) if (!this.#hot.has(key)) total++;
    return total;
  }
}
