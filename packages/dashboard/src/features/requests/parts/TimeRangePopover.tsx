import { useEffect, useState } from 'react';
import type { TimeWindow } from '../../../shared/list/timeline';
import {
  fromLocalInput,
  QUICK_RANGES,
  rangeFrom,
  rangeLabel,
  toLocalInput,
} from '../lib/timerange';
import { CalendarMonth } from './CalendarMonth';

interface TimeRangePopoverProps {
  range: TimeWindow | null;
  /** What the store holds, so the calendar can dim the days it has nothing for. */
  coverage: { from: number; to: number } | null;
  open: boolean;
  onToggleOpen: () => void;
  onPick: (next: TimeWindow | null) => void;
}

/**
 * The `time · …` pill and its popover.
 *
 * The strip above the list is the fast way to pick a stretch — but it can only
 * be dragged across what it draws, and with a history behind the panel the
 * interesting hour is usually not on it. This is how you say "yesterday" or
 * type the exact minutes of the incident.
 */
export function TimeRangePopover({
  range,
  coverage,
  open,
  onToggleOpen,
  onPick,
}: TimeRangePopoverProps) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // The inputs follow the selection: a stretch dragged on the strip should be
  // readable here as the exact minutes it covers.
  useEffect(() => {
    setFrom(range && Number.isFinite(range[0]) ? toLocalInput(range[0]) : '');
    setTo(range && Number.isFinite(range[1]) ? toLocalInput(range[1]) : '');
  }, [range]);

  /** A quick range answers and closes: there is nothing else to say here. */
  const pick = (next: TimeWindow | null) => {
    onPick(next);
    onToggleOpen();
  };

  /**
   * Either end may be left empty: "everything since Monday" is a question
   * people ask.
   */
  const applyExact = () => pick(rangeFrom(fromLocalInput(from), fromLocalInput(to)));

  return (
    <div className="timerange">
      <button
        type="button"
        className="chip"
        aria-pressed={range !== null}
        aria-expanded={open}
        onClick={onToggleOpen}
      >
        time · {rangeLabel(range)}
      </button>

      {open ? (
        <div className="timerange-pop">
          <div className="rules-head label">WHEN</div>
          {QUICK_RANGES.map((quick) => (
            <button
              key={quick.id}
              type="button"
              className="timerange-row"
              onClick={() => pick(quick.range(Date.now()))}
            >
              {quick.label}
            </button>
          ))}

          <CalendarMonth range={range} coverage={coverage} onPick={onPick} />

          <div className="timerange-exact">
            <label className="timerange-field">
              <span className="label">FROM</span>
              <input
                type="datetime-local"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label className="timerange-field">
              <span className="label">TO</span>
              <input
                type="datetime-local"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
            <button type="button" className="btn-secondary" onClick={applyExact}>
              apply the exact times
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
