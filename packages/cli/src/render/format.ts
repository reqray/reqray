/**
 * Numbers, as they are read.
 *
 * Two duration formats, because the two screens ask different questions. The
 * stream is scanned for outliers, so 61 ms and 92 ms are near enough to
 * print whole. The waterfall is read for proportion, where a span of 0.4 ms
 * and one of 41.2 ms both have to be tellable apart from their neighbours.
 */

import type { Theme } from './theme.js';

/** Above this a request is worth a mark in the gutter, ms. */
export const SLOW_MS = 300;
/** Above this it is worth the strongest mark the stream has, ms. */
export const VERY_SLOW_MS = 1_000;
/** More queries than this in one request is worth colouring. */
export const MANY_QUERIES = 20;

/** A duration in the stream: `1.2ms`, `47ms`, `2.14s`. */
export function duration(ms: number): string {
  if (ms >= 100_000) return `${Math.round(ms / 1000)}s`;
  if (ms >= 1_000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 10) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(1)}ms`;
}

/** A duration in the waterfall: `0.4ms`, `41.2ms`, `268ms`, `2.14s`. */
export function spanDuration(ms: number): string {
  if (ms >= 100_000) return `${Math.round(ms / 1000)}s`;
  if (ms >= 1_000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 100) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(1)}ms`;
}

/** A size, as a response header would have said it: `4.1 KB`. */
export function bytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

/** Wall-clock time of a request, to the millisecond, in the reader's zone. */
export function clock(at: number): string {
  const when = new Date(at);
  const two = (value: number) => String(value).padStart(2, '0');
  const three = String(when.getMilliseconds()).padStart(3, '0');
  return `${two(when.getHours())}:${two(when.getMinutes())}:${two(when.getSeconds())}.${three}`;
}

/**
 * Short badge for a detector.
 *
 * The panel's own words, shortened where the flag column cannot hold them:
 * `SEQ HTTP` reads as `SEQ` here and means the same thing. An unknown
 * detector prints its own id rather than a shrug.
 */
export function badgeFor(detector: string): string {
  switch (detector) {
    case 'n_plus_one':
      return 'N+1';
    case 'sequential_http':
      return 'SEQ';
    case 'dup_http':
    case 'dup_cache':
      return 'DUP';
    case 'slow_budget':
      return 'SLOW';
    case 'heavy_response':
      return 'HEAVY';
    default:
      return detector.toUpperCase();
  }
}

/** A share of the request, as the findings block prints it. */
export function share(part: number, whole: number): string {
  if (whole <= 0) return '';
  return `${Math.round((part / whole) * 100)}% of total`;
}

/** A count of queries: `6q`, or nothing at all when there were none. */
export function queries(count: number, theme: Theme): string {
  return count === 0 ? theme.glyph('none') : `${count}q`;
}
