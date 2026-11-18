import { useState } from 'react';
import type { TimeWindow } from '../../../shared/list/timeline';
import {
  type CalendarDay,
  dayInRange,
  daysBetween,
  monthGrid,
  monthLabel,
  shiftMonth,
  startOfDay,
  WEEKDAYS,
} from '../lib/calendar';

interface CalendarMonthProps {
  range: TimeWindow | null;
  /** Oldest and newest request the store holds; `null` when it holds none. */
  coverage: { from: number; to: number } | null;
  onPick: (next: TimeWindow) => void;
}

/**
 * A month of days, for picking a stretch without typing one.
 *
 * One click is a day — the common case, and it takes effect immediately. A
 * second click extends from the first to make a stretch; a third starts over.
 * Days the store has nothing for are dimmed, so it is visible at a glance how
 * far back the history goes.
 */
export function CalendarMonth({ range, coverage, onPick }: CalendarMonthProps) {
  const [month, setMonth] = useState(() => startOfDay(range?.[0] ?? Date.now()));
  /** The first day of a stretch being picked; `null` between selections. */
  const [anchor, setAnchor] = useState<number | null>(null);

  const today = startOfDay(Date.now());
  const days = monthGrid(month);

  const covered = (day: CalendarDay) =>
    coverage ? day.at <= coverage.to && day.at >= startOfDay(coverage.from) : false;

  const pick = (day: CalendarDay) => {
    // The first click is already an answer: one day. The second turns it into
    // a stretch rather than replacing it.
    const [from, to] = daysBetween(anchor ?? day.at, day.at);
    setAnchor(anchor === null ? day.at : null);
    setMonth(startOfDay(day.at));
    onPick([from, to]);
  };

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button
          type="button"
          className="calendar-step"
          aria-label="previous month"
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          ‹
        </button>
        <span className="calendar-month">{monthLabel(month)}</span>
        <button
          type="button"
          className="calendar-step"
          aria-label="next month"
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          ›
        </button>
      </div>

      <div className="calendar-grid">
        {WEEKDAYS.map((weekday) => (
          <span key={weekday} className="calendar-weekday">
            {weekday}
          </span>
        ))}

        {days.map((day) => (
          <button
            key={day.at}
            type="button"
            className="calendar-day"
            data-outside={!day.inMonth}
            data-selected={dayInRange(day.at, range)}
            data-today={day.at === today}
            data-empty={!covered(day)}
            onClick={() => pick(day)}
          >
            {day.day}
          </button>
        ))}
      </div>

      <div className="calendar-foot">
        {anchor === null ? 'click a day, or two for a stretch' : 'click the day it ends on'}
      </div>
    </div>
  );
}
