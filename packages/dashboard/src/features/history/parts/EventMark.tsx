import { clock } from '../../../shared/format';
import type { Annotation } from '../lib/annotations';
import { HEIGHT, WIDTH } from '../lib/scale';

interface EventMarkProps {
  event: Annotation;
  /** The stretch the plot is drawn over, which places the mark on it. */
  from: number;
  to: number;
}

/** A witnessed moment, as a rule down the plot; outside the window, nothing. */
export function EventMark({ event, from, to }: EventMarkProps) {
  const x = ((event.at - from) / (to - from)) * WIDTH;
  if (x < 0 || x > WIDTH) return null;

  return (
    <line className="chart-event" x1={x} x2={x} y1={0} y2={HEIGHT}>
      <title>
        {clock(event.at)} · {event.detail}
      </title>
    </line>
  );
}
