/**
 * Request replay from the panel.
 *
 * The request is replayed through the same application — with its full
 * middleware stack — so this is a real run, not a simulation. Hence the
 * restriction: a replay in production means a second card charge and a second
 * email, so outside development it is enabled only by an explicit flag.
 *
 * A replayed request must not show up in the shared list: it is marked by a
 * header, and its record goes not to the transport but to whoever started the
 * replay.
 */

import type { ReplayComparison, ReplayInput, ReplayMetrics } from '@reqray/protocol';
import { runOutsideScope } from '../context.js';
import { awaitReplay } from '../replay-waiters.js';
import { REPLAY_HEADER } from '../reqray.js';
import type { RecordedRequest } from '../types.js';

export type { ReplayComparison, ReplayInput, ReplayMetrics };

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Reduces a request record to the comparison metrics. */
export function metricsOf(request: RecordedRequest): ReplayMetrics {
  let sqlCount = 0;
  for (const span of request.spans) {
    if (span.kind === 'db') sqlCount++;
  }

  return {
    status: request.status,
    durationMs: request.durationMs,
    sqlCount,
    nPlusOne: request.findings.some((finding) => finding.detector === 'n_plus_one'),
    bytes: numberOrNull(request.responseHeaders['content-length']),
    etag: request.responseHeaders['etag'] ?? null,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

let counter = 0;

function nextReplayId(): string {
  counter = (counter + 1) % 0xffffff;
  return `r${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Runs the request again and returns a comparison against the original.
 *
 * @param origin the application's own address, e.g. `http://127.0.0.1:3000`.
 * @param recordTimeoutMs how long to wait for the replay's record before
 * returning a partial comparison.
 */
export async function runReplay(
  origin: string,
  input: ReplayInput,
  original: RecordedRequest,
  recordTimeoutMs = 2_000,
): Promise<ReplayComparison> {
  const replayId = nextReplayId();

  let stopWaiting = (): void => {};
  const recorded = new Promise<RecordedRequest>((resolve) => {
    stopWaiting = awaitReplay(replayId, resolve);
  });

  const startedAt = performance.now();
  try {
    // Outside the scope: Reqray's own HTTP call must not become a span of the
    // request that opened the panel.
    const response = await runOutsideScope(() =>
      fetch(`${origin}${input.path}`, {
        method: input.method,
        headers: { ...input.headers, [REPLAY_HEADER]: replayId },
        ...(input.body === undefined ? {} : { body: input.body }),
      }),
    );

    const text = await response.text();
    const durationMs = performance.now() - startedAt;
    const record = await withTimeout(recorded, recordTimeoutMs);

    const replay: ReplayMetrics = record
      ? metricsOf(record)
      : {
          status: response.status,
          durationMs,
          sqlCount: 0,
          nPlusOne: false,
          bytes: Buffer.byteLength(text),
          etag: response.headers.get('etag'),
        };

    return { original: metricsOf(original), replay, partial: record === null };
  } finally {
    stopWaiting();
  }
}
