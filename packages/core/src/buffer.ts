/**
 * Ring buffer with a hard cap.
 *
 * Eviction policy is "drop the oldest": the buffer lives in someone else's
 * application memory and has no right to grow without bound.
 */
export class RingBuffer<T> implements Iterable<T> {
  /** How many items fit. */
  readonly capacity: number;

  #items: (T | undefined)[];
  #head = 0;
  #size = 0;
  #evicted = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`loupe: buffer capacity must be an integer ≥ 1, got ${capacity}`);
    }
    this.capacity = capacity;
    this.#items = new Array<T | undefined>(capacity);
  }

  /** How many items are held right now. */
  get size(): number {
    return this.#size;
  }

  /** How many items have been evicted over the buffer's lifetime. */
  get evicted(): number {
    return this.#evicted;
  }

  /**
   * Pushes an item, evicting the oldest one when full.
   *
   * @returns the evicted item, if the buffer was full.
   */
  push(item: T): T | undefined {
    const full = this.#size === this.capacity;
    const displaced = full ? this.#items[this.#head] : undefined;

    this.#items[this.#head] = item;
    this.#head = (this.#head + 1) % this.capacity;

    if (full) this.#evicted++;
    else this.#size++;

    return displaced;
  }

  /** Items newest to oldest — the order the panel shows them in. */
  toArray(): T[] {
    const out = new Array<T>(this.#size);
    for (let i = 0; i < this.#size; i++) {
      const index = (this.#head - 1 - i + this.capacity) % this.capacity;
      out[i] = this.#items[index] as T;
    }
    return out;
  }

  /** Iterates newest to oldest. */
  *[Symbol.iterator](): Iterator<T> {
    for (let i = 0; i < this.#size; i++) {
      const index = (this.#head - 1 - i + this.capacity) % this.capacity;
      yield this.#items[index] as T;
    }
  }

  /** Clears the buffer, releasing references to the items. */
  clear(): void {
    this.#items = new Array<T | undefined>(this.capacity);
    this.#head = 0;
    this.#size = 0;
  }
}
