import { useMemo, useRef } from 'react';
import type { RequestRow } from '../api';
import {
  bucketInWindow,
  buildTimeline,
  type TimeWindow,
  windowExtent,
  windowFromFractions,
} from '../timeline';

/**
 * The busiest bucket fills the strip and the rest are drawn in proportion to
 * it, with a floor so a single request is still a visible mark. A fixed
 * pixels-per-request scale reads the same but clips the moment a burst lands
 * in one bucket, which is exactly the moment worth seeing.
 */
const MIN_SEGMENT = '3px';

function segmentHeight(count: number, peak: number): string | 0 {
  return count === 0 ? 0 : `max(${MIN_SEGMENT}, ${(count / peak) * 100}%)`;
}

/**
 * The strip above the filters: when things went wrong, before any filter is
 * typed. Dragging across a burst narrows the list to that stretch of time.
 */
export function TimelineScrubber({
  rows,
  win,
  onWindow,
}: {
  rows: readonly RequestRow[];
  win: TimeWindow | null;
  onWindow: (next: TimeWindow | null) => void;
}) {
  const timeline = useMemo(() => buildTimeline(rows), [rows]);
  const chartRef = useRef<HTMLDivElement>(null);
  // The fraction the pointer went down at; `null` while not dragging.
  const dragFrom = useRef<number | null>(null);

  if (!timeline) return null;

  const fractionOf = (clientX: number): number => {
    const rect = chartRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const overlay = win ? windowExtent(win, timeline) : null;
  const windowSeconds = win ? Math.max(1, Math.round((win[1] - win[0]) / 1000)) : 0;
  const peak = Math.max(1, ...timeline.buckets.map((bucket) => bucket.total));

  return (
    <div className="timeline">
      <div className="timeline-label">
        <span className="label">TIMELINE</span>
        <span className={win ? 's-acc' : 's-dim'}>
          {win ? `${windowSeconds}s window` : 'full range · drag to zoom'}
        </span>
      </div>

      {/* A drag has no keyboard equivalent; the same narrowing is reachable
          with the filter field and the chips. */}
      <div
        ref={chartRef}
        className="timeline-chart"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragFrom.current = fractionOf(event.clientX);
          // A click clears; a drag replaces this with its window on move.
          onWindow(null);
        }}
        onPointerMove={(event) => {
          if (dragFrom.current === null) return;
          onWindow(windowFromFractions(dragFrom.current, fractionOf(event.clientX), timeline));
        }}
        onPointerUp={() => {
          dragFrom.current = null;
        }}
        onPointerCancel={() => {
          dragFrom.current = null;
        }}
      >
        {timeline.buckets.map((bucket, index) => (
          <span
            // The buckets are a fixed-length axis, so the index is the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
            key={index}
            className="tl-bucket"
            data-dim={!bucketInWindow(index, timeline, win)}
          >
            <span className="tl-seg tl-err" style={{ height: segmentHeight(bucket.err, peak) }} />
            <span className="tl-seg tl-slow" style={{ height: segmentHeight(bucket.slow, peak) }} />
            <span className="tl-seg tl-rest" style={{ height: segmentHeight(bucket.rest, peak) }} />
          </span>
        ))}
        {overlay ? (
          <span
            className="tl-window"
            style={{ left: `${overlay.left}%`, width: `${overlay.width}%` }}
          />
        ) : null}
      </div>

      <button type="button" className="btn-secondary tl-reset" onClick={() => onWindow(null)}>
        reset window
      </button>
    </div>
  );
}
