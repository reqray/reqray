/**
 * The month grid.
 *
 * Calendar arithmetic is where off-by-one lives: the week that starts on the
 * wrong day, the month that pads from the wrong side, and the day in October
 * that is twenty-five hours long. None of that is visible in a screenshot
 * taken in June.
 */

import { describe, expect, it } from 'vitest';
import {
  dayInRange,
  daysBetween,
  endOfDay,
  monthGrid,
  monthLabel,
  shiftMonth,
  startOfDay,
  startOfMonth,
  WEEKDAYS,
} from '../src/features/requests/lib/calendar';

const day = (year: number, month: number, date: number) => new Date(year, month, date).getTime();

describe('the grid', () => {
  it('is always six weeks, so the buttons under it do not move', () => {
    for (const month of [day(2026, 0, 15), day(2026, 1, 15), day(2026, 7, 15)]) {
      expect(monthGrid(month)).toHaveLength(42);
    }
  });

  it('starts the week on Monday', () => {
    expect(WEEKDAYS[0]).toBe('Mo');
    // 1 August 2026 is a Saturday, so the grid opens on Monday 27 July.
    const grid = monthGrid(day(2026, 7, 1));

    expect(new Date(grid[0]?.at ?? 0).getDay()).toBe(1);
    expect(grid[0]).toMatchObject({ day: 27, inMonth: false });
  });

  it('marks which days belong to the month being shown', () => {
    const grid = monthGrid(day(2026, 7, 10));
    const inside = grid.filter((entry) => entry.inMonth);

    expect(inside).toHaveLength(31);
    expect(inside[0]?.day).toBe(1);
    expect(inside[30]?.day).toBe(31);
  });

  it('every cell is midnight, and every cell is a different day', () => {
    const grid = monthGrid(day(2026, 7, 10));

    for (const entry of grid) {
      expect(new Date(entry.at).getHours()).toBe(0);
      expect(entry.at).toBe(startOfDay(entry.at));
    }
    expect(new Set(grid.map((entry) => entry.at)).size).toBe(42);
  });

  it('survives a month with a daylight-saving change in it', () => {
    // Adding milliseconds instead of days would skip or repeat a date here,
    // depending on which side of the world the reader is on.
    for (const month of [day(2026, 2, 15), day(2026, 9, 15)]) {
      const grid = monthGrid(month);
      const dates = grid.map((entry) => entry.day);

      expect(new Set(grid.map((entry) => entry.at)).size).toBe(42);
      // Consecutive days, no repeats and no gaps.
      for (let index = 1; index < dates.length; index++) {
        const previous = new Date(grid[index - 1]?.at ?? 0);
        const current = new Date(grid[index]?.at ?? 0);
        previous.setDate(previous.getDate() + 1);
        expect(current.getDate()).toBe(previous.getDate());
      }
    }
  });
});

describe('moving between months', () => {
  it('steps either way and lands on the first', () => {
    expect(startOfMonth(shiftMonth(day(2026, 7, 20), 1))).toBe(day(2026, 8, 1));
    expect(startOfMonth(shiftMonth(day(2026, 7, 20), -1))).toBe(day(2026, 6, 1));
  });

  it('crosses the turn of the year', () => {
    expect(startOfMonth(shiftMonth(day(2026, 11, 15), 1))).toBe(day(2027, 0, 1));
    expect(startOfMonth(shiftMonth(day(2026, 0, 15), -1))).toBe(day(2025, 11, 1));
  });

  it('stepping from the 31st does not skip a month', () => {
    // 31 March + 1 month is not 31 April; stepping from the first avoids it.
    expect(startOfMonth(shiftMonth(day(2026, 2, 31), 1))).toBe(day(2026, 3, 1));
  });

  it('names the month it is showing', () => {
    expect(monthLabel(day(2026, 7, 20))).toMatch(/2026/);
  });
});

describe('picking a stretch', () => {
  it('one day is that whole day, midnight to midnight', () => {
    const [from, to] = daysBetween(day(2026, 7, 20), day(2026, 7, 20));

    expect(from).toBe(startOfDay(day(2026, 7, 20)));
    expect(to).toBe(endOfDay(day(2026, 7, 20)));
    expect(new Date(to).getHours()).toBe(23);
  });

  it('two days cover both ends, whichever was clicked first', () => {
    const forwards = daysBetween(day(2026, 7, 18), day(2026, 7, 20));
    const backwards = daysBetween(day(2026, 7, 20), day(2026, 7, 18));

    expect(forwards).toEqual(backwards);
    expect(forwards[0]).toBe(startOfDay(day(2026, 7, 18)));
    expect(forwards[1]).toBe(endOfDay(day(2026, 7, 20)));
  });

  it('a day inside the stretch is marked, and the ends are inside it', () => {
    const range = daysBetween(day(2026, 7, 18), day(2026, 7, 20));

    expect(dayInRange(day(2026, 7, 18), range)).toBe(true);
    expect(dayInRange(day(2026, 7, 19), range)).toBe(true);
    expect(dayInRange(day(2026, 7, 20), range)).toBe(true);
    expect(dayInRange(day(2026, 7, 17), range)).toBe(false);
    expect(dayInRange(day(2026, 7, 21), range)).toBe(false);
  });

  it('a day is marked by a stretch that only touches part of it', () => {
    // "Last hour" is inside today: today is still the day it happened on.
    const now = day(2026, 7, 20) + 14 * 3_600_000;
    expect(dayInRange(day(2026, 7, 20), [now - 3_600_000, now])).toBe(true);
  });

  it('nothing selected marks nothing', () => {
    expect(dayInRange(day(2026, 7, 20), null)).toBe(false);
  });
});
