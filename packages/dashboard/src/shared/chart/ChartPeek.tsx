import type React from 'react';
import type { RequestFilterQuery } from '../../api/index';
import { RequestList } from './RequestList';

/**
 * The requests behind a hovered column, without leaving the chart.
 *
 * Always slowest first, whatever metric the chart draws: a list that reordered
 * itself per metric would make one column answer differently depending on
 * which chart it was hovered on.
 */

interface ChartPeekProps {
  from: number;
  to: number;
  total: number;
  filter: RequestFilterQuery;
  /** Where the anchor column sits; the caller knows its own geometry. */
  style: React.CSSProperties;
  onOpen: (id: string) => void;
  /** Pointer entered the popup — it must not close mid-read. */
  onHold: () => void;
  /** Pointer left it. */
  onLeave: () => void;
}

/** The floating card the route charts pop under a hovered column. */
export function ChartPeek({
  from,
  to,
  total,
  filter,
  style,
  onOpen,
  onHold,
  onLeave,
}: ChartPeekProps) {
  return (
    // A hover surface, not a modal: it lives and dies by the pointer, and
    // the pointer's arrival is what keeps it open.
    <div
      className="chart-peek"
      style={style}
      role="status"
      onPointerEnter={onHold}
      onPointerLeave={onLeave}
    >
      <RequestList from={from} to={to} total={total} filter={filter} onOpen={onOpen} />
    </div>
  );
}
