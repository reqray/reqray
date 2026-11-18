/**
 * A month, as a grid of days.
 *
 * Days are built with date arithmetic rather than by adding milliseconds: a
 * day is not always 24 hours long, and a calendar that skips or repeats one
 * around a daylight-saving change is a calendar nobody can use in October.
 *
 * The week starts on Monday. That is ISO 8601, and the panel's other dates —
 * `2026-08-20`, sorted lexicographically — follow the same standard.
 */

/** One cell of the grid. */
export interface CalendarDay {
  /** Midnight at the start of the day, epoch ms. */
  readonly at: number;
  /** Day of the month, as it is printed. */
  readonly day: number;
  /** Belongs to the month being shown, rather than padding either end. */
  readonly inMonth: boolean;
}

/** Monday first, as the grid is drawn. */
export const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;

/** How many weeks a grid holds — enough for any month, so it never resizes. */
const WEEKS = 6;

/** Midnight at the start of the day `at` falls in. */
export function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The last millisecond of the day `at` falls in. */
export function endOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

/** The first of the month `at` falls in. */
export function startOfMonth(at: number): number {
  const date = new Date(at);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The same day of an adjacent month; `step` is months, either direction. */
export function shiftMonth(at: number, step: number): number {
  const date = new Date(startOfMonth(at));
  date.setMonth(date.getMonth() + step);
  return date.getTime();
}

/** How the month is titled above the grid. */
export function monthLabel(at: number): string {
  return new Date(at).toLocaleDateString([], { month: 'long', year: 'numeric' });
}

/**
 * The six weeks a month is drawn in, padded from the months either side.
 *
 * A fixed six weeks rather than as many as the month needs: a grid that
 * changes height as you page through it makes the buttons under it move.
 */
export function monthGrid(at: number): CalendarDay[] {
  const first = new Date(startOfMonth(at));
  const month = first.getMonth();

  // `getDay()` is Sunday-first; Monday-first is one rotation away.
  const lead = (first.getDay() + 6) % 7;

  const days: CalendarDay[] = [];
  for (let index = 0; index < WEEKS * 7; index++) {
    const date = new Date(first.getFullYear(), month, 1 - lead + index);
    days.push({
      at: date.getTime(),
      day: date.getDate(),
      inMonth: date.getMonth() === month,
    });
  }
  return days;
}

/**
 * The stretch two picked days cover, whole days, in either click order.
 *
 * Picking one day twice is that day — which is what a single click means, and
 * the reason clicking a day never needs a second click to be useful.
 */
export function daysBetween(a: number, b: number): [from: number, to: number] {
  const first = Math.min(a, b);
  const last = Math.max(a, b);
  return [startOfDay(first), endOfDay(last)];
}

/** Whether a day falls inside a selected stretch. */
export function dayInRange(day: number, range: readonly [number, number] | null): boolean {
  if (!range) return false;
  return endOfDay(day) >= range[0] && startOfDay(day) <= range[1];
}
