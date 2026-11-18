/**
 * What the process was doing while a request was in flight.
 *
 * A route that got slower with no change to its span timings is not a slow
 * route; it is a process that could not get scheduled. That is invisible in a
 * waterfall — every span is individually fast, and the time is *between*
 * them — and it is the more common answer for a Node backend than anything
 * the database did.
 *
 * The measurement is deliberately of the process, never of the request. Under
 * concurrency the code that blocked the loop is usually somebody else's, and
 * a number that says "this request burned 180 ms of CPU" is wrong often
 * enough to make every other number on the screen suspect.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { warnOnce } from './logger.js';
import type { HostState } from './types.js';

export interface HostMonitor {
  /**
   * The window in progress, or `null` when nothing has been measured yet.
   *
   * Read when a request finishes, so what it carries is the loop's behaviour
   * over the window the request ran in — at most a second of it.
   */
  read(): HostState | null;
  /** Stops sampling. The timer is unrefed, so this is for tests and shutdown. */
  stop(): void;
}

/**
 * How often the histogram is emptied.
 *
 * A window shorter than this stops being a distribution; a longer one stops
 * being about the request that reads it. A second is the compromise, and it
 * is why the panel never draws one request against these numbers: a 90 ms
 * request does not resolve against a one-second window.
 */
const WINDOW_MS = 1_000;

/**
 * How often the histogram is actually asked, however often it is read.
 *
 * `mean` walks the histogram's buckets on every call and costs about eleven
 * microseconds — trivial once, and eleven milliseconds a second at a thousand
 * requests. The window it summarises is a second long, so a reading fifty
 * milliseconds old is the same reading; what a memo buys is that the cost
 * stops scaling with traffic.
 */
const READ_EVERY_MS = 50;

/**
 * How finely libuv samples the loop.
 *
 * Ten milliseconds is the interval the histogram itself schedules at — fine
 * enough to catch a blocking parse, coarse enough that the monitor is not
 * itself the thing keeping the loop busy.
 */
const RESOLUTION_MS = 10;

/**
 * A histogram reading, in milliseconds of *delay*.
 *
 * libuv records the whole interval between samples, so an idle loop at a
 * resolution of ten reads about eleven. Reporting that as "the loop was
 * behind by 11 ms" would put a number on every request that is wrong on all
 * of them — the baseline comes off, and what is left is the lateness.
 */
const delayMs = (nanoseconds: number): number =>
  Number.isFinite(nanoseconds) ? Math.max(0, nanoseconds / 1e6 - RESOLUTION_MS) : 0;

/**
 * Starts watching the event loop.
 *
 * Never throws: on a runtime without the histogram the monitor reads `null`
 * for ever and every screen that shows loop delay simply has nothing to show,
 * which is what an unmeasured thing looks like.
 */
export function startHostMonitor(): HostMonitor {
  let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  try {
    histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    histogram.enable();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnOnce('host.monitor', `event-loop delay is not being measured: ${reason}`);
    return { read: () => null, stop: () => {} };
  }

  // The window just closed, kept so that a reset cannot swallow what it
  // measured. Without it, a request that blocked the loop and finished a
  // moment after a reset reports nothing at all — which is exactly the
  // request the number exists for.
  let previous: HostState | null = null;
  let cached: HostState | null = null;
  let cachedAt = 0;

  // Emptied on a timer rather than on every read: a reset per request would
  // mean each request reports the delay since the previous one finished,
  // which under load is a window of microseconds and a number of zero.
  const timer = setInterval(() => {
    try {
      if (histogram && histogram.count > 0) {
        previous = { loopDelayMs: delayMs(histogram.mean), loopMaxMs: delayMs(histogram.max) };
      }
      histogram?.reset();
      cached = null;
    } catch {
      // A histogram that will not reset still reads; it just widens.
    }
  }, WINDOW_MS);
  // The monitor must never be the reason a process stays alive.
  timer.unref?.();

  return {
    read() {
      if (!histogram) return null;
      const now = Date.now();
      if (cached && now - cachedAt < READ_EVERY_MS) return cached;
      try {
        // The window in progress and the one before it, together: the worst
        // the loop was behind over the last second or two, which is the span
        // a request is honestly placed against. An empty window is not a
        // delay of zero — it is no measurement — so the closed window carries
        // the answer alone until the new one has something to say.
        const open =
          histogram.count > 0
            ? { loopDelayMs: delayMs(histogram.mean), loopMaxMs: delayMs(histogram.max) }
            : null;
        const closed = previous;
        if (!open && !closed) return null;

        cached = {
          loopDelayMs: open?.loopDelayMs ?? closed?.loopDelayMs ?? 0,
          loopMaxMs: Math.max(open?.loopMaxMs ?? 0, closed?.loopMaxMs ?? 0),
        };
        cachedAt = now;
        return cached;
      } catch {
        return null;
      }
    },

    stop() {
      clearInterval(timer);
      cached = null;
      previous = null;
      try {
        histogram?.disable();
      } catch {
        // Already gone.
      }
      histogram = null;
    },
  };
}
