/**
 * `@reqray/transport-http` — shipping batches to an external collector.
 *
 * The agent inside the application only collects and sends; storage and the
 * panel live in `@reqray/server`. Two promises this transport keeps no matter
 * what the collector does:
 *
 * - the application is never blocked: `send()` is a queue push, everything
 *   else happens on timers;
 * - memory is bounded: the queue has a cap, and beyond it the **oldest**
 *   records are dropped — fresh data is worth more than stale data.
 */

import { type Transport, warnOnce } from '@reqray/core';
import type { RecordedRequest } from '@reqray/protocol';

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
  /**
   * Cap on the serialized size of the queue; beyond it the oldest records
   * are dropped. A count alone bounds nothing: a thousand records with
   * bodies is hundreds of megabytes held for a collector that is down.
   */
  readonly maxQueueBytes?: number;
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

export function httpTransport(options: HttpTransportOptions): HttpTransport {
  const url = new URL('/ingest', options.url).toString();
  const batchSize = options.batchSize ?? 50;
  const flushIntervalMs = options.flushIntervalMs ?? 2_000;
  const maxQueue = options.maxQueue ?? 1_000;
  // shortcut: counted in string length, not bytes — non-ASCII bodies are up
  // to 3x larger on the wire. 8 MB keeps the worst case under the
  // collector's 32 MB batch limit; count bytes if a 400 for size ever shows.
  const maxQueueBytes = options.maxQueueBytes ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const baseRetryDelayMs = options.retryDelayMs ?? 1_000;

  // The queue holds records already serialized one by one: serializing a
  // whole batch at flush time is a multi-megabyte synchronous stringify that
  // shows up as event-loop lag spikes. Per-record cost is paid in `send()`,
  // which already runs outside request handling.
  const queue: string[] = [];
  let queuedSize = 0;
  /** What the collector asked for in `Retry-After` on its last refusal, ms. */
  let askedToWaitMs = 0;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  /** Settles when the drain in progress, if any, has finished its POST. */
  let draining: Promise<void> = Promise.resolve();
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
        // A saturated collector says how long to stay away; an agent that
        // came back sooner would be part of what saturates it.
        const seconds = Number(response.headers.get('retry-after'));
        askedToWaitMs = seconds > 0 ? seconds * 1000 : 0;
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

  /** Takes the next batch off the front of the queue. */
  function take(): string[] {
    const batch = queue.splice(0, batchSize);
    for (const record of batch) queuedSize -= record.length;
    return batch;
  }

  /** Trims the queue to its caps, dropping the oldest records. */
  function trim(): void {
    let dropped = false;
    while (queue.length > maxQueue || (queuedSize > maxQueueBytes && queue.length > 0)) {
      queuedSize -= queue.shift()?.length ?? 0;
      dropped = true;
    }
    if (!dropped) return;
    warnOnce(
      'transport.http.overflow',
      `transport queue overflowed, oldest records are being dropped (limits: ${maxQueue} records, ${maxQueueBytes} bytes)`,
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
    let finished = (): void => {};
    draining = new Promise((resolve) => {
      finished = resolve;
    });
    try {
      while (queue.length > 0) {
        const batch = take();
        const delivered = await post(batch);

        if (!delivered) {
          queue.unshift(...batch);
          for (const record of batch) queuedSize += record.length;
          trim();
          retryDelayMs = Math.min(
            retryDelayMs > 0 ? retryDelayMs * 2 : baseRetryDelayMs,
            MAX_RETRY_DELAY_MS,
          );
          // Jitter keeps a fleet of agents from retrying in lockstep.
          pausedUntil =
            performance.now() + Math.max(retryDelayMs * (0.5 + Math.random() * 0.5), askedToWaitMs);
          break;
        }
        retryDelayMs = 0;
        pausedUntil = 0;

        // The tail below batch size waits for the timer, not for the loop.
        if (queue.length < batchSize) break;
      }
    } finally {
      inFlight = false;
      finished();
    }
    armTimer();
  }

  return {
    name: 'http',

    send(request) {
      if (closed) return;
      try {
        const record = JSON.stringify(request);
        queue.push(record);
        queuedSize += record.length;
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
      // A POST already on the wire is part of what is being flushed: returning
      // past it let `close()` finish with that batch undelivered and the tail
      // behind it never sent. Looped, because a `send` may start another.
      while (inFlight) await draining;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      while (queue.length > 0) {
        if (!(await post(take()))) return;
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
