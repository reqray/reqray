/**
 * What one request cost the process.
 *
 * The waterfall answers "how long did it take". It does not answer "what did
 * it cost to run", and the two come apart constantly: a request that waits
 * 800 ms on a database is cheap, and one that spends 80 ms hashing a password
 * is expensive. A list sorted by duration puts the first one on top and the
 * second one nowhere, which is the wrong way round for anyone asking what
 * their process is actually spending itself on.
 *
 * Everything here is measured at the edges of a request and costs about a
 * microsecond, so it is always on. What it cannot do is name the function
 * that burned the time — that needs the sampling profiler, which is a
 * decision rather than a setting.
 *
 * ## What is honest to report, and what is not
 *
 * `process.cpuUsage()` measures the *process*, so the delta across a
 * request's window belongs to the request only when nothing else was running
 * in it. That is why `overlap` travels with every reading: the number of
 * other requests that shared the window. At zero, the CPU figure is this
 * request's. Above it, the figure is the window's and the panel says so
 * rather than dividing by a guess.
 *
 * Retained memory is deliberately absent. There is no way in V8 to ask what a
 * request still holds, and a number invented for the column would be wrong in
 * exactly the cases somebody would act on it. What can be measured is the
 * garbage collector's time inside the window, which is what allocation
 * pressure actually costs the request that triggers it.
 */

import { type PerformanceEntry, PerformanceObserver } from 'node:perf_hooks';
import { warnOnce } from './logger.js';
import { globalSlot } from './state.js';

/** A garbage collection, in the same clock spans are placed on. */
interface Pause {
  /** `performance.now()` when it started. */
  readonly at: number;
  readonly ms: number;
}

/**
 * How many recent collections are remembered.
 *
 * Only pauses inside a request's window are ever read, and a request outlives
 * at most a few hundred of them. The ring is what keeps an idle process from
 * accumulating a day of garbage-collection history nobody will ask about.
 */
const PAUSE_HISTORY = 512;

/**
 * A collection shorter than this is not worth attributing.
 *
 * Minor collections run constantly and cost tens of microseconds; summing
 * every one of them would produce a figure made mostly of noise.
 */
const PAUSE_FLOOR_MS = 0.1;

interface Meter {
  /** Recent collections, oldest first, capped at {@link PAUSE_HISTORY}. */
  pauses: Pause[];
  /** Requests currently in flight. */
  active: number;
  /** Requests begun since the process started — a monotonic clock of arrivals. */
  begun: number;
  observer: PerformanceObserver | null;
}

/**
 * Process-wide, and shared across Reqray instances by design.
 *
 * Two Reqray instances in one process observe one garbage collector and one
 * CPU clock. Giving each its own observer would double the cost of watching
 * and still measure the same thing twice.
 */
const meter = globalSlot(
  'cost.meter',
  (): Meter => ({ pauses: [], active: 0, begun: 0, observer: null }),
);

/**
 * Starts watching the collector.
 *
 * Never throws: on a runtime that does not report collections, every request
 * simply has nothing to say about garbage collection, which is what an
 * unmeasured thing looks like.
 */
export function startCostMeter(): void {
  const state = meter();
  if (state.observer) return;

  try {
    const observer = new PerformanceObserver((list) => {
      const { pauses } = meter();
      for (const entry of list.getEntries() as PerformanceEntry[]) {
        if (entry.duration < PAUSE_FLOOR_MS) continue;
        pauses.push({ at: entry.startTime, ms: entry.duration });
      }
      if (pauses.length > PAUSE_HISTORY) pauses.splice(0, pauses.length - PAUSE_HISTORY);
    });
    observer.observe({ type: 'gc' });
    state.observer = observer;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnOnce('cost.gc', `garbage collection is not being measured: ${reason}`);
  }
}

/** Stops watching. For tests and shutdown. */
export function stopCostMeter(): void {
  const state = meter();
  try {
    state.observer?.disconnect();
  } catch {
    // An observer that will not disconnect is not worth an exception.
  }
  state.observer = null;
  state.pauses = [];
  state.active = 0;
  state.begun = 0;
}

/** What is read at the start of a request and subtracted at the end. */
export interface CostMark {
  readonly cpu: NodeJS.CpuUsage;
  /** Requests already in flight when this one began. */
  readonly overlapping: number;
  /** Arrivals so far, so requests begun during this window can be counted. */
  readonly begun: number;
}

/**
 * Opens the measurement. Called once per request, on the hot path.
 *
 * About a microsecond, almost all of it `process.cpuUsage()`.
 */
export function markCost(): CostMark {
  const state = meter();
  const mark = { cpu: process.cpuUsage(), overlapping: state.active, begun: state.begun };
  state.active++;
  state.begun++;
  return mark;
}

/** What one request cost, as the panel reports it. */
export interface RequestCost {
  /** Processor time in the request's window, user and system, ms. */
  readonly cpuMs: number;
  /**
   * That time as a share of the wall clock. `1` is a request that spent its
   * whole life on a processor.
   *
   * Deliberately not capped. `process.cpuUsage()` counts every thread the
   * process has — the libuv pool doing filesystem, DNS, zlib and crypto work,
   * and any worker threads — so a request that fanned work out across cores
   * genuinely spends more processor time than wall time. Capping it at one
   * would turn the most interesting reading on the screen into the same
   * number as an ordinary busy request.
   */
  readonly cpuShare: number;
  /** Time the garbage collector took inside the window, ms. */
  readonly gcMs: number;
  /** Collections inside the window. */
  readonly collections: number;
  /**
   * Other requests that shared the window.
   *
   * Part of the honesty dial on `cpuMs`, and only part of it: it counts
   * requests, and the processor clock counts threads. A request can be alone
   * in the process and still show more processor time than wall time, because
   * the libuv pool was busy on its behalf — which is why `cpuShare` above one
   * is a reading in its own right rather than a contradiction of this field.
   */
  readonly overlap: number;
}

/**
 * Closes the measurement.
 *
 * Must be called synchronously when the response ends, for the same reason
 * the duration is: a reading taken a tick later has the tick in it.
 */
export function measureCost(mark: CostMark, startTime: number, durationMs: number): RequestCost {
  const state = meter();
  state.active = Math.max(0, state.active - 1);

  const spent = process.cpuUsage(mark.cpu);
  const cpuMs = (spent.user + spent.system) / 1000;

  const end = startTime + durationMs;
  let gcMs = 0;
  let collections = 0;
  for (const pause of state.pauses) {
    if (pause.at < startTime || pause.at > end) continue;
    gcMs += pause.ms;
    collections++;
  }

  return {
    cpuMs,
    // Uncapped on purpose; see the field. Drawing it is the client's problem,
    // and a client that clamps a bar is not the same as a measurement that
    // throws the excess away.
    cpuShare: durationMs > 0 ? cpuMs / durationMs : 0,
    gcMs,
    collections,
    // Those already running when this began, plus those that arrived while it
    // ran. An upper bound on distinct company, computed in constant time.
    overlap: mark.overlapping + (state.begun - mark.begun - 1),
  };
}
