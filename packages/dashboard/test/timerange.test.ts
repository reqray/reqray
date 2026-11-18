/**
 * Picking a stretch of time.
 *
 * The arithmetic is here rather than in the control so "last hour" means one
 * thing, and so the awkward cases — an open end, ends the wrong way round, a
 * label short enough for a row of chips — can be checked without a browser.
 */

import { describe, expect, it } from 'vitest';
import {
  fromLocalInput,
  QUICK_RANGES,
  type QuickRange,
  rangeFrom,
  rangeLabel,
  startOfDay,
  toLocalInput,
} from '../src/features/requests/lib/timerange';

const NOW = new Date(2026, 7, 20, 14, 30, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The named stretch with this id. Absent means the list lost it, which is a failure. */
function quick(id: string): QuickRange {
  const found = QUICK_RANGES.find((entry) => entry.id === id);
  if (!found) throw new Error(`no quick range called ${id}`);
  return found;
}

describe('the named stretches', () => {
  it('measure back from now', () => {
    expect(quick('15m').range(NOW)).toEqual([NOW - 15 * MINUTE, NOW]);
    expect(quick('1h').range(NOW)).toEqual([NOW - HOUR, NOW]);
    expect(quick('24h').range(NOW)).toEqual([NOW - 24 * HOUR, NOW]);
  });

  it('today starts at midnight, in the reader’s own timezone', () => {
    const [from, to] = quick('today').range(NOW) as [number, number];

    expect(new Date(from).getHours()).toBe(0);
    expect(new Date(from).getDate()).toBe(new Date(NOW).getDate());
    expect(to).toBe(NOW);
  });

  it('yesterday is a whole day, and ends before today begins', () => {
    const [from, to] = quick('yesterday').range(NOW) as [number, number];

    expect(new Date(from).getDate()).toBe(new Date(NOW).getDate() - 1);
    expect(to).toBe(startOfDay(NOW) - 1);
    expect(to).toBeLessThan(startOfDay(NOW));
  });

  it('"all time" is not a stretch at all', () => {
    expect(quick('all').range(NOW)).toBeNull();
  });
});

describe('building a stretch from two ends', () => {
  it('takes both ends as given', () => {
    expect(rangeFrom(1_000, 2_000)).toEqual([1_000, 2_000]);
  });

  it('leaves an open end open, because "everything since Monday" is a question', () => {
    expect(rangeFrom(1_000, null)?.[0]).toBe(1_000);
    expect(rangeFrom(1_000, null)?.[1]).toBe(Number.POSITIVE_INFINITY);
    expect(rangeFrom(null, 2_000)?.[0]).toBe(Number.NEGATIVE_INFINITY);
  });

  it('swaps ends given the wrong way round rather than refusing them', () => {
    expect(rangeFrom(2_000, 1_000)).toEqual([1_000, 2_000]);
  });

  it('two empty ends are no filter at all', () => {
    expect(rangeFrom(null, null)).toBeNull();
  });
});

describe('the label on the pill', () => {
  it('says so when nothing is selected', () => {
    expect(rangeLabel(null, NOW)).toBe('any time');
  });

  it('names a stretch that runs up to now', () => {
    expect(rangeLabel([NOW - 15 * MINUTE, NOW], NOW)).toBe('last 15 min');
    expect(rangeLabel([NOW - HOUR, NOW], NOW)).toBe('last hour');
    expect(rangeLabel([NOW - 6 * HOUR, NOW], NOW)).toBe('last 24 h');
    expect(rangeLabel([startOfDay(NOW), NOW], NOW)).toBe('today');
  });

  it('gives the clock for a stretch inside today', () => {
    const from = new Date(2026, 7, 20, 9, 0, 0).getTime();
    const to = new Date(2026, 7, 20, 10, 30, 0).getTime();

    expect(rangeLabel([from, to], NOW)).toMatch(/9|09/);
    expect(rangeLabel([from, to], NOW)).toContain('–');
  });

  it('names a whole day by the day, not by its two ends', () => {
    const yesterday = quick('yesterday').range(NOW) as [number, number];
    expect(rangeLabel(yesterday, NOW)).toBe('yesterday');

    const older = startOfDay(NOW) - 3 * 24 * HOUR;
    expect(rangeLabel([older, older + 24 * HOUR - 1], NOW)).toMatch(/Aug|17/);
    expect(rangeLabel([older, older + 24 * HOUR - 1], NOW)).not.toContain(':');
  });

  it('names the day for a stretch that is not today', () => {
    const from = new Date(2026, 7, 18, 9, 0, 0).getTime();
    const to = new Date(2026, 7, 18, 10, 0, 0).getTime();

    expect(rangeLabel([from, to], NOW)).toMatch(/Aug|18/);
  });

  it('names both days for a stretch that crosses midnight', () => {
    const from = new Date(2026, 7, 18, 23, 0, 0).getTime();
    const to = new Date(2026, 7, 19, 1, 0, 0).getTime();

    expect(rangeLabel([from, to], NOW)).toContain('–');
  });
});

describe('the typed ends', () => {
  it('round-trip through the input without sliding by a timezone', () => {
    const at = new Date(2026, 7, 20, 14, 30, 0).getTime();

    expect(fromLocalInput(toLocalInput(at))).toBe(at);
  });

  it('an empty input is not a moment', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('not a date')).toBeNull();
  });
});
