/**
 * Fitting a line into the terminal.
 *
 * One column is flexible — the path — and everything else keeps its place, so
 * output at 80 columns and at 200 reads the same way. When the flexible column
 * hits its floor, whole columns are dropped in a fixed order rather than the
 * grid collapsing.
 *
 * The numbers are in DESIGN.md and the table there is what these functions
 * produce; the tests check both ends of it.
 */

/** Below this the grid cannot be drawn at all. */
export const MIN_WIDTH = 56;

/** Shortest path column worth printing. */
const PATH_FLOOR = 21;

/**
 * The fixed part of a stream line.
 *
 * gutter 2, time 12, method 6, status 3, duration 7, queries 4, six spaces
 * between them, a flag reserve of 8, and one column left unused at the right
 * edge so a full line never wraps.
 */
const FIXED = 51;
/** What the queries column costs, separator included. */
const QUERIES = 5;
/** What the status column costs, separator included. */
const STATUS = 4;

/** What the id column costs, separator included. */
const IDS = 13;

/** Which columns a stream line has room for. */
export interface StreamColumns {
  readonly path: number;
  readonly queries: boolean;
  readonly status: boolean;
  /** Printed only when asked for: it is a handle, not information. */
  readonly ids: boolean;
}

/**
 * How a stream line is laid out at this width.
 *
 * The queries column goes first — it is a number that repeats what the
 * duration already implies — and the status second, because it is only
 * interesting when it is not 200, and a non-2xx keeps its code in the flag
 * column instead.
 */
export function streamColumns(width: number, ids = false): StreamColumns {
  // The id column is taken out of the path's budget, so everything else keeps
  // its place whether it is printed or not.
  const room = width - (ids ? IDS : 0);

  if (room - FIXED >= PATH_FLOOR) {
    return { path: room - FIXED, queries: true, status: true, ids };
  }
  if (room - FIXED + QUERIES >= PATH_FLOOR - 3) {
    return { path: room - FIXED + QUERIES, queries: false, status: true, ids };
  }
  return {
    path: Math.max(8, room - FIXED + QUERIES + STATUS),
    queries: false,
    status: false,
    ids,
  };
}

/** Pads to a width, cutting anything longer. */
export function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

/** The same, against the right edge — for numbers. */
export function padStart(text: string, width: number): string {
  return text.length >= width ? text.slice(-width) : ' '.repeat(width - text.length) + text;
}

/** Cuts to a width, marking that something was cut. */
export function cut(text: string, width: number, ellipsis: string): string {
  if (text.length <= width) return text;
  if (width <= ellipsis.length) return text.slice(0, width);
  return text.slice(0, width - ellipsis.length) + ellipsis;
}

/**
 * A path and its query string, fitted into a column.
 *
 * Whole segments go, never characters: a truncated path stays a path and can
 * still be recognised, where `/api/v2/organizat…` tells the reader nothing.
 * The query string is the first thing given up, then the segments in the
 * middle — the first says which service, the last which handler, and the
 * identifiers between them are what nobody reads.
 */
export function fitPath(
  path: string,
  query: string | null,
  width: number,
  ellipsis: string,
): string {
  const whole = query ? `${path}?${query}` : path;
  if (whole.length <= width) return whole;

  // Step one: the query string becomes a marker.
  const marker = query ? `?${ellipsis}` : '';
  if (path.length + marker.length <= width) return path + marker;

  // Step two: the middle segments collapse, keeping the head and as much of
  // the tail as fits.
  const segments = path.split('/').filter(Boolean);
  const head = segments[0] ?? '';
  const tail = segments.slice(1);

  for (const withHead of [true, false]) {
    const prefix = withHead ? `/${head}/${ellipsis}` : `/${ellipsis}`;
    let taken: string[] = [];
    for (let index = tail.length - 1; index >= (withHead ? 1 : 0); index--) {
      const candidate = [tail[index] as string, ...taken];
      const length = prefix.length + candidate.join('/').length + 1 + marker.length;
      if (length > width) break;
      taken = candidate;
    }
    if (taken.length > 0) return `${prefix}/${taken.join('/')}${marker}`;
  }

  // Step three: not even the leaf fits, so the leaf is cut.
  const leaf = segments[segments.length - 1] ?? path;
  return cut(`/${ellipsis}/${leaf}`, width, ellipsis);
}
