import { duration, durationFill, durationTone } from '../../../shared/format';

interface DurationCellProps {
  ms: number;
  yardMs: number;
  note?: string;
}

/**
 * A duration as a length, on a square-root scale.
 *
 * Linear hides everything under 50 ms behind the one slow request; the
 * square root keeps 2 ms and 20 ms distinguishable while 800 ms still
 * dwarfs both. The yardstick is the slowest request in view.
 */
export function DurationCell({ ms, yardMs, note }: DurationCellProps) {
  const share = yardMs > 0 ? Math.min(1, Math.sqrt(ms / yardMs)) : 0;
  return (
    <span className="cell-right cell-duration">
      <span className="dur-track">
        <span
          className="dur-fill"
          data-tone={durationFill(ms)}
          style={{ width: `${Math.max(2, Math.round(share * 100))}%` }}
        />
      </span>
      <span className={durationTone(ms)}>
        {duration(ms)}
        {note ? <span className="s-dim"> {note}</span> : null}
      </span>
    </span>
  );
}
