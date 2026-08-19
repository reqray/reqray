/**
 * `@loupe/transport-http` — shipping batches to an external collector.
 *
 * The agent inside the application only collects and sends; storage and the
 * panel live in `@loupe/server`. Two promises this transport keeps no matter
 * what the collector does:
 *
 * - the application is never blocked: `send()` is a queue push, everything
 *   else happens on timers;
 * - memory is bounded: the queue has a cap, and beyond it the **oldest**
 *   records are dropped — fresh data is worth more than stale data.
 */

import { type RecordedRequest, type Transport, warnOnce } from '@loupe/core';

/** Options for {@link httpTransport}. */
export interface HttpTransportOptions {
  /** Collector address, e.g. `http://localhost:4318`. */
  readonly url: string;
  /** Shared token; sent as `authorization: Bearer <token>`. */
  readonly token?: string;
  /** How many records go into one batch. */
  readonly batchSize?: number;
  /** How long a record may wait before the batch is sent anyway, ms. */
  readonly flushIntervalMs?: number;
  /** Queue cap; beyond it the oldest records are dropped. */
  readonly maxQueue?: number;
  /** Timeout of one POST to the collector, ms. */
  readonly timeoutMs?: number;
  /** First retry delay after a failure, ms. Doubles up to 30 s, with jitter. */
  readonly retryDelayMs?: number;
}

/** The transport with the extra lifecycle methods made non-optional. */
export interface HttpTransport extends Transport {
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** The batch as the collector receives it. */
export interface IngestPayload {
  readonly requests: readonly RecordedRequest[];
}

const MAX_RETRY_DELAY_MS = 30_000;

/** Creates the HTTP transport. */
export function httpTransport(options: HttpTransportOptions): HttpTransport {
  const url = new URL('/ingest', options.url).toString();
  const batchSize = options.batchSize ?? 50;
  const flushIntervalMs = options.flushIntervalMs ?? 2_000;
  const maxQueue = options.maxQueue ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const baseRetryDelayMs = options.retryDelayMs ?? 1_000;

  // The queue holds records already serialized one by one: serializing a
  // whole batch at flush time is a multi-megabyte synchronous stringify that
  // shows up as event-loop lag spikes. Per-record cost is paid in `send()`,
  // which already runs outside request handling.
  const queue: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let retryDelayMs = 0;
  /** `performance.now()` before which sending is paused after a failure. */
  let pausedUntil = 0;
  let closed = false;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;

  async function post(batch: readonly string[]): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        // Assembled from pre-serialized records; the shape is IngestPayload.
        body: `{"requests":[${batch.join(',')}]}`,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        warnOnce(
          'transport.http.status',
          `collector answered ${response.status} — records will be retried and displaced by newer ones`,
        );
        return false;
      }
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnOnce(
        'transport.http.unreachable',
        `collector unreachable (${reason}) — the application keeps running, records are displaced by newer ones`,
      );
      return false;
    }
  }

  /** Trims the queue to the cap, dropping the oldest records. */
  function trim(): void {
    if (queue.length <= maxQueue) return;
    queue.splice(0, queue.length - maxQueue);
    warnOnce(
      'transport.http.overflow',
      `transport queue overflowed, oldest records are being dropped (limit ${maxQueue})`,
    );
  }

  function armTimer(): void {
    if (timer || closed || queue.length === 0) return;
    const delay = Math.max(flushIntervalMs, pausedUntil - performance.now());
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, delay);
    // The timer must not keep somebody else's process alive.
    timer.unref?.();
  }

  /**
   * Sends full batches while there are any, one POST in flight at a time.
   * A failed batch goes back to the front of the queue: on overflow it is
   * the first to be dropped, which is exactly the drop-oldest promise.
   */
  async function drain(): Promise<void> {
    if (inFlight || closed) return;
    if (performance.now() < pausedUntil) {
      armTimer();
      return;
    }

    inFlight = true;
    try {
      while (queue.length > 0) {
        const batch = queue.splice(0, batchSize);
        const delivered = await post(batch);

        if (!delivered) {
          queue.unshift(...batch);
          trim();
          retryDelayMs = Math.min(
            retryDelayMs > 0 ? retryDelayMs * 2 : baseRetryDelayMs,
            MAX_RETRY_DELAY_MS,
          );
          // Jitter keeps a fleet of agents from retrying in lockstep.
          pausedUntil = performance.now() + retryDelayMs * (0.5 + Math.random() * 0.5);
          break;
        }
        retryDelayMs = 0;
        pausedUntil = 0;

        // The tail below batch size waits for the timer, not for the loop.
        if (queue.length < batchSize) break;
      }
    } finally {
      inFlight = false;
    }
    armTimer();
  }

  return {
    name: 'http',

    send(request) {
      if (closed) return;
      try {
        queue.push(JSON.stringify(request));
      } catch {
        // An unserializable record is dropped; the transport must never throw.
        return;
      }
      trim();
      if (queue.length >= batchSize && performance.now() >= pausedUntil) {
        // Off the caller's stack: `send` stays a queue push.
        setImmediate(() => void drain());
        return;
      }
      armTimer();
    },

    /**
     * Sends whatever is queued, one attempt per batch.
     *
     * Called on shutdown, so it must not hang on a dead collector: what
     * cannot be delivered right now is dropped.
     */
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      while (queue.length > 0 && !inFlight) {
        const batch = queue.splice(0, batchSize);
        if (!(await post(batch))) return;
      }
    },

    async close() {
      if (closed) return;
      await this.flush();
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
