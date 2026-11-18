import { useMemo, useRef, useState } from 'react';
import type { RequestRow } from '../../../api/index';

import {
  bucketInWindow,
  buildTimeline,
  type Timeline,
  type TimelineScope,
  type TimeWindow,
  windowExtent,
  windowFromFractions,
} from '../../../shared/list/timeline';

/** How many time labels sit under the strip. */
const TICKS = 5;

/**
 * Where a tick's label sits relative to its mark.
 *
 * The ends are pulled inside the box; everything between is centred, which is
 * what an empty value means to the stylesheet.
 */
type TickAlign = 'start' | 'end' | '';

function alignOf(index: number): TickAlign {
  if (index === 0) return 'start';
  return index === TICKS - 1 ? 'end' : '';
}

/** `14:32`, or `20 Aug 14:32` when the strip spans more than a day. */
function tick(at: number, spanMs: number): string {
  const when = new Date(at);
  const hhmm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  if (spanMs < 24 * 60 * 60 * 1000) return hhmm;
  return `${when.getDate()} ${when.toLocaleString('en-US', { month: 'short' })} ${hhmm}`;
}

/** `2h 22m`, `5d 3h`, `40m` — how long a stretch of the strip is. */
function elapsed(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

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

/** What stretch the strip is drawing, in the words under it. */
function rangeLabel(span: TimeWindow | null, scope: TimelineScope, width: string): string {
  if (span === null) return 'full range';
  return scope === 'recent' ? `last ${width}` : `${width} kept`;
}

interface TimelineScrubberProps {
  rows: readonly RequestRow[];
  /**
   * The strip as the store draws it. Without one — an older panel API, or a
   * store that keeps no series — the rows in hand are used instead, which
   * only span the page that is loaded.
   */
  report: Timeline | null;
  win: TimeWindow | null;
  /** Which stretch is drawn: the newest run of traffic, or everything kept. */
  scope: TimelineScope;
  /** The whole span, when the strip is showing less than it. */
  span: TimeWindow | null;
  onScope: (next: TimelineScope) => void;
  onWindow: (next: TimeWindow | null) => void;
}

/**
 * The strip above the filters: when things went wrong, before any filter is
 * typed. Dragging across a burst narrows the list to that stretch of time.
 */
export function TimelineScrubber({
  rows,
  report,
  win,
  scope,
  span,
  onScope,
  onWindow,
}: TimelineScrubberProps) {
  const fromRows = useMemo(() => buildTimeline(rows), [rows]);
  const timeline = report ?? fromRows;
  const chartRef = useRef<HTMLDivElement>(null);
  /** The column the pointer is over, for the readout beside the strip. */
  const [hovered, setHovered] = useState<number | null>(null);
  // The fraction the pointer went down at; `null` while not dragging.
  const dragFrom = useRef<number | null>(null);

  if (!timeline) return null;

  const fractionOf = (clientX: number): number => {
    const rect = chartRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const overlay = win ? windowExtent(win, timeline) : null;
  const other = scope === 'recent' ? 'full' : 'recent';
  // What the strip is actually drawn over — said out loud, because a strip
  // showing the last hour of a week-long store while claiming "full range"
  // would be the panel lying about its own axis.
  /** What the strip says about the column under the pointer. */
  const bucketMs = (timeline.to - timeline.from) / Math.max(1, timeline.buckets.length);
  const under = hovered === null ? null : timeline.buckets[hovered];
  const readout =
    under && hovered !== null
      ? [
          tick(timeline.from + hovered * bucketMs, timeline.to - timeline.from),
          `${under.total} ${under.total === 1 ? 'request' : 'requests'}`,
          // One of the two, not both: the line has to fit beside the strip,
          // and a failure is what somebody is scanning for.
          under.err > 0 ? `${under.err} failed` : under.slow > 0 ? `${under.slow} slow` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null;

  const drawnLabel = rangeLabel(span, scope, elapsed(timeline.to - timeline.from));
  const windowSeconds = win ? Math.max(1, Math.round((win[1] - win[0]) / 1000)) : 0;
  const peak = Math.max(1, ...timeline.buckets.map((bucket) => bucket.total));

  /** A click clears the window; a drag replaces it on the first move. */
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragFrom.current = fractionOf(event.clientX);
    onWindow(null);
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragFrom.current === null) return;
    onWindow(windowFromFractions(dragFrom.current, fractionOf(event.clientX), timeline));
  };

  const endDrag = () => {
    dragFrom.current = null;
  };

  return (
    <div className="timeline">
      <div className="timeline-label">
        <span className="label">TIMELINE</span>
        {/* The window in force stays put; the hovered reading goes under it. */}
        <span className={win ? 's-acc' : 's-dim'}>
          {win ? `${windowSeconds}s window` : `${drawnLabel} · drag to zoom`}
        </span>
        <span className="s-fg2 tl-readout">{readout ?? '\u00a0'}</span>
      </div>

      {/* A drag has no keyboard equivalent; the same narrowing is reachable
          with the filter field and the chips. */}
      <div className="timeline-main">
        <div
          ref={chartRef}
          className="timeline-chart"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => setHovered(null)}
        >
          {timeline.buckets.map((bucket, index) => (
            <span
              // The buckets are a fixed-length axis, so the index is the identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
              key={index}
              className="tl-bucket"
              data-dim={!bucketInWindow(index, timeline, win)}
              onPointerEnter={() => setHovered(index)}
            >
              <span className="tl-seg tl-err" style={{ height: segmentHeight(bucket.err, peak) }} />
              <span
                className="tl-seg tl-slow"
                style={{ height: segmentHeight(bucket.slow, peak) }}
              />
              <span
                className="tl-seg tl-rest"
                style={{ height: segmentHeight(bucket.rest, peak) }}
              />
            </span>
          ))}
          {overlay ? (
            <span
              className="tl-window"
              style={{ left: `${overlay.left}%`, width: `${overlay.width}%` }}
            />
          ) : null}
        </div>

        <div className="timeline-axis" aria-hidden="true">
          {Array.from({ length: TICKS }, (_, index) => {
            const at = timeline.from + ((timeline.to - timeline.from) * index) / (TICKS - 1);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length axis; with a single request `at` is the same for every tick
              <span key={index} data-align={alignOf(index)}>
                {tick(at, timeline.to - timeline.from)}
              </span>
            );
          })}
        </div>
      </div>

      <div className="tl-controls">
        {span ? (
          <button type="button" className="tl-scope" onClick={() => onScope(other)}>
            {scope === 'recent' ? 'everything kept' : 'recent traffic'}
          </button>
        ) : null}
        <button type="button" className="btn-secondary tl-reset" onClick={() => onWindow(null)}>
          reset window
        </button>
      </div>
    </div>
  );
}
