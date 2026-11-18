import type { MetricSeries } from '../../../api/index';
import { duration, span } from '../../../shared/format';
import { DAY } from './metrics';

/**
 * The plot's own coordinate space.
 *
 * Everything is drawn against these and stretched to the box by the viewBox,
 * so no geometry here depends on how wide the screen happens to be.
 */
export const WIDTH = 960;
export const HEIGHT = 150;

/** A single empty column is sampling; two in a row is silence. */
export const MAX_BRIDGED = 1;

/** How many labels the time axis carries. */
export const TICKS = 5;

/**
 * How many rules the chart carries, and how far apart they must be.
 *
 * Eight events inside one second are one event as far as the eye is
 * concerned, and eight rules on top of each other are a hatch pattern. The
 * chart keeps the first of any cluster and a handful in all: an annotation
 * layer that has to be read carefully is not an annotation layer.
 */

/**
 * `14:32:07`, `14:32`, or `20 Aug 14:32` — as coarse as the period allows.
 *
 * A minute of traffic labelled to the minute puts the same five words under
 * five different columns, which is a legend that says nothing.
 */
export function tickAt(at: number, spanMs: number): string {
  const when = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  const hhmm = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  if (spanMs < 5 * 60_000) return `${hhmm}:${pad(when.getSeconds())}`;
  if (spanMs < DAY) return hhmm;
  return `${when.getDate()} ${when.toLocaleString('en-US', { month: 'short' })} ${hhmm}`;
}

/** How wide one column is, in words rather than in milliseconds. */
export function columnSpan(ms: number): string {
  // `span` rounds to whole seconds, and a column of a busy minute is
  // narrower than one — "0s each" is not a description of anything.
  return ms < 1_000 ? duration(ms) : span(ms);
}

/** The tallest value a line reaches — what its axis is scaled to. */
export function peakOf(line: MetricSeries): number {
  return Math.max(...line.values.map((value) => value ?? 0), 0);
}

/** Runs of columns that hold something, split where the line must break. */
export function segments(values: readonly (number | null)[]) {
  const runs: Array<Array<{ index: number; value: number }>> = [];
  let current: Array<{ index: number; value: number }> = [];
  let empty = 0;

  values.forEach((value, index) => {
    if (value === null) {
      empty++;
      if (empty > MAX_BRIDGED && current.length > 0) {
        runs.push(current);
        current = [];
      }
      return;
    }
    empty = 0;
    current.push({ index, value });
  });
  if (current.length > 0) runs.push(current);
  return runs;
}
