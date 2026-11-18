/**
 * Was the process to blame?
 *
 * Knowing an operation is slow does not say why, and often the code did not
 * change at all — the loop fell behind, and every callback waited before it
 * even started. That is invisible in a waterfall: the spans are each fast and
 * the time is between them.
 *
 * The comparison here is a route against itself. Its calls are split by
 * whether the loop was in its *own* top quartile at the time, and the two
 * halves are compared. Elevated is never a fixed threshold: a delay that is
 * alarming for one service is idle for the next, and the only baseline worth
 * comparing a process against is the same process.
 *
 * It is evidence, not proof, and the panel says so. A batch job hammering the
 * same process explains the shape as well as this route being its victim.
 */

import type { HostPressure, HostPressureSide } from '../types.js';
import type { DurationSample } from './api.js';
import { percentile } from './routes.js';

/**
 * Calls needed on each side of the split.
 *
 * Twenty is where a ninety-fifth percentile stops being the single slowest
 * call and starts describing a distribution. Below it the comparison is
 * between two anecdotes.
 */
const MIN_PER_SIDE = 20;

/**
 * How much slower the bad half has to be before it is worth a word.
 *
 * Under half again, the difference is inside the noise of a sample this size,
 * and a card that fires there is a card that fires always.
 */
const MIN_RATIO = 1.5;

/**
 * How much the loop has to have varied for "elevated" to mean anything.
 *
 * A host that was flat has no elevated state to compare against: splitting it
 * at its own quartile would sort calls by a millisecond of jitter and then
 * report whatever the two halves happened to differ by.
 */
const MIN_SPREAD_MS = 1;

function sideOf(durations: readonly number[]): HostPressureSide {
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    calls: sorted.length,
    p95Ms: percentile(sorted, 0.95),
    avgMs: sorted.length === 0 ? 0 : sum / sorted.length,
  };
}

/**
 * The finding, or `null` — which is the answer far more often, and by design.
 *
 * @param samples every other call of the route, as the store hands them over.
 */
export function pressureFor(samples: readonly DurationSample[]): HostPressure | null {
  const measured = samples.filter(
    (sample): sample is DurationSample & { loopDelayMs: number } => sample.loopDelayMs !== null,
  );
  if (measured.length < MIN_PER_SIDE * 2) return null;

  const delays = measured.map((sample) => sample.loopDelayMs).sort((a, b) => a - b);
  const cutoffMs = percentile(delays, 0.75);
  // Did the loop actually move? Comparing the top quartile against the bottom
  // one answers it without a threshold of its own.
  if (cutoffMs - percentile(delays, 0.25) < MIN_SPREAD_MS) return null;

  const elevated = sideOf(
    measured.filter((sample) => sample.loopDelayMs >= cutoffMs).map((sample) => sample.durationMs),
  );
  const normal = sideOf(
    measured.filter((sample) => sample.loopDelayMs < cutoffMs).map((sample) => sample.durationMs),
  );
  if (elevated.calls < MIN_PER_SIDE || normal.calls < MIN_PER_SIDE) return null;
  // Nothing to be slower than: a route where the good half is instant would
  // report a ratio of infinity and mean nothing by it.
  if (normal.p95Ms <= 0) return null;

  const ratio = elevated.p95Ms / normal.p95Ms;
  if (ratio < MIN_RATIO) return null;

  return {
    metric: 'loop',
    cutoffMs,
    ratio,
    share: (elevated.calls / measured.length) * 100,
    elevated,
    normal,
  };
}
