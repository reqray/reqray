/**
 * Picking a stretch of time the strip cannot reach — yesterday afternoon, the
 * hour of the incident.
 *
 * Apart from the control so "last hour" means one thing rather than one thing
 * per place that offers it.
 */

import type { TimeWindow } from '../../../shared/list/timeline';

/** A named stretch, relative to now. */
export interface QuickRange {
  readonly id: string;
  readonly label: string;
  /** `null` — everything there is. */
  range(now: number): TimeWindow | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The start of the day `at` falls in, in the reader's own timezone. */
export function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export const QUICK_RANGES: readonly QuickRange[] = [
  { id: 'all', label: 'all time', range: () => null },
  { id: '15m', label: 'last 15 min', range: (now) => [now - 15 * MINUTE, now] },
  { id: '1h', label: 'last hour', range: (now) => [now - HOUR, now] },
  { id: '24h', label: 'last 24 hours', range: (now) => [now - 24 * HOUR, now] },
  { id: 'today', label: 'today', range: (now) => [startOfDay(now), now] },
  {
    id: 'yesterday',
    label: 'yesterday',
    range: (now) => [startOfDay(now) - 24 * HOUR, startOfDay(now) - 1],
  },
];

/**
 * A range as the pill shows it.
 *
 * Short on purpose: it sits in a row of chips, and the exact ends are one
 * click away inside the popover.
 */
export function rangeLabel(range: TimeWindow | null, now = Date.now()): string {
  if (!range) return 'any time';

  const [from, to] = range;
  const today = startOfDay(now);
  const clock = (at: number) =>
    new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (at: number) =>
    new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });

  // Ends within a couple of seconds of now read as "up to now" rather than as
  // a clock time that is already wrong by the time it is read.
  const open = Math.abs(now - to) < 2_000;
  const sameDay = startOfDay(from) === startOfDay(to);

  if (open) {
    // Midnight first: "today" is a more specific answer than "last 24 h", and
    // it is the one that was picked.
    if (from === today) return 'today';
    const span = now - from;
    if (span <= 15 * MINUTE + 1_000) return 'last 15 min';
    if (span <= HOUR + 1_000) return 'last hour';
    if (span <= 24 * HOUR + 1_000) return 'last 24 h';
  }

  // A whole day is named by the day: "Aug 19", not "Aug 19 12:00 AM–11:59 PM".
  const DAY = 24 * HOUR;
  if (from === startOfDay(from) && to - from >= DAY - 1_000 && to - from < DAY) {
    return from === today - DAY ? 'yesterday' : day(from);
  }
  if (sameDay && startOfDay(from) === today) return `${clock(from)}–${clock(to)}`;
  if (sameDay) return `${day(from)} ${clock(from)}–${clock(to)}`;
  return `${day(from)} – ${day(to)}`;
}

/**
 * What a `datetime-local` input shows for a moment.
 *
 * The input speaks local time with no zone, which is what a reader means when
 * they type one, so the offset is subtracted rather than the value being sent
 * through `toISOString`.
 */
export function toLocalInput(at: number): string {
  const local = new Date(at - new Date(at).getTimezoneOffset() * MINUTE);
  return local.toISOString().slice(0, 16);
}

/** Reads what a `datetime-local` input gives back. `null` when it is empty. */
export function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

/**
 * Builds a range from two ends, either of which may be missing.
 *
 * An open end is left open — "everything since Monday" is a question people
 * ask — and ends given the wrong way round are swapped rather than refused,
 * because the reader meant a stretch either way.
 */
export function rangeFrom(from: number | null, to: number | null): TimeWindow | null {
  if (from === null && to === null) return null;
  const start = from ?? Number.NEGATIVE_INFINITY;
  const end = to ?? Number.POSITIVE_INFINITY;
  return start <= end ? [start, end] : [end, start];
}
