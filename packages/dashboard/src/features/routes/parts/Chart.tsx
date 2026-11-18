import type React from 'react';
import { useId } from 'react';
import type { RouteSeries } from '../../../api/index';
import { ChartPeek } from '../../../shared/chart/ChartPeek';
import { usePeek } from '../../../shared/chart/usePeek';
import { usePlotPointer } from '../../../shared/chart/usePlotPointer';
import { HEIGHT, MAX_BRIDGED, WIDTH } from '../lib/scale';

interface ChartProps {
  title: string;
  note: React.ReactNode;
  series: RouteSeries;
  selected: number | null;
  onPick: (index: number) => void;
  /** A stretch dragged across the plot, in epoch ms. */
  onZoom: (range: { from: number; to: number }) => void;
  /** Opens one request — the hover peek's rows lead straight to the detail. */
  onOpenRequest: (id: string) => void;
  children: React.ReactNode;
}

/**
 * One chart, with its title and the column that can be picked.
 *
 * The whole plot is one control rather than one per column: a hit target per
 * bucket would be forty-eight tab stops on each of three charts, and a
 * keyboard user would page through a hundred and forty-four rectangles to
 * reach the one that mattered. A click resolves to a column by where it
 * landed, and the arrow keys walk them.
 */
export function Chart({
  title,
  note,
  series,
  selected,
  onPick,
  onZoom,
  onOpenRequest,
  children,
}: ChartProps) {
  /** Rest on a column and the requests in it are named, worst first. */
  const peek = usePeek();
  // Three charts share a document, and two patterns cannot share an id.
  const hatch = useId();
  const columns = series.buckets.length;
  const step = WIDTH / columns;

  const timeAt = (fraction: number): number => series.from + (series.to - series.from) * fraction;

  const { gesture, handlers } = usePlotPointer({
    columns,
    onDragStart: peek.close,
    onLeave: peek.leave,
    onHover: peek.move,
    onPick,
    onDrag: (fromFraction, toFraction) =>
      onZoom({ from: timeAt(fromFraction), to: timeAt(toFraction) }),
  });
  const { hovered, dragFrom, dragTo } = gesture;

  const walk = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const move = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (move === 0) return;
    event.preventDefault();
    const from = selected ?? (move > 0 ? -1 : columns);
    onPick(Math.max(0, Math.min(columns - 1, from + move)));
  };

  const band = (index: number, className: string) => (
    <rect className={className} x={index * step} y={0} width={step} height={HEIGHT} />
  );

  /**
   * Stretches where nothing was recorded, drawn rather than left blank: an
   * empty middle reads as a broken chart, and the route was simply not called.
   *
   * Only stretches long enough to break the line, the same rule the line uses
   * — hatching under a line that runs straight over it would contradict it.
   */
  const voids: Array<[start: number, end: number]> = [];
  let run: number | null = null;
  series.buckets.forEach((bucket, index) => {
    if (bucket.calls === 0) {
      run ??= index;
      return;
    }
    if (run !== null && index - run > MAX_BRIDGED) voids.push([run, index]);
    run = null;
  });
  if (run !== null && series.buckets.length - run > MAX_BRIDGED) {
    voids.push([run, series.buckets.length]);
  }

  return (
    <div className="chart">
      <div className="chart-head">
        <span className="label">{title}</span>
        <span className="s-dim">{note}</span>
      </div>
      <button
        type="button"
        className="chart-plot"
        aria-label={`${title} for ${series.method} ${series.route} — click a column to ask what ran then, or drag across a stretch to zoom into it`}
        {...handlers}
        onKeyDown={walk}
      >
        <svg
          className="chart-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={title}
        >
          <title>{title}</title>
          <defs>
            {/* Hatched rather than tinted: a slightly different shade of the
                background reads as a rendering artefact, and this has to read
                as "nothing was recorded here". */}
            <pattern
              id={hatch}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line className="chart-hatch" x1="0" y1="0" x2="0" y2="6" />
            </pattern>
          </defs>
          {voids.map(([start, end]) => (
            <rect
              key={`void-${start}`}
              className="chart-void"
              fill={`url(#${hatch})`}
              x={start * step}
              y={0}
              width={(end - start) * step}
              height={HEIGHT}
            >
              <title>This route was not called in this stretch</title>
            </rect>
          ))}
          {children}
          {dragFrom !== null && dragTo !== null ? (
            <rect
              className="chart-drag"
              x={Math.min(dragFrom, dragTo) * WIDTH}
              y={0}
              width={Math.abs(dragTo - dragFrom) * WIDTH}
              height={HEIGHT}
            />
          ) : null}
          {hovered !== null && hovered !== selected ? band(hovered, 'chart-hover') : null}
          {selected === null ? null : (
            <>
              {band(selected, 'chart-selected')}
              {/* Along the top edge, where no data is ever drawn: a mark that
                  cannot be mistaken for a sample. */}
              <rect className="chart-marker" x={selected * step} y={0} width={step} height={2} />
            </>
          )}
        </svg>
      </button>

      {(() => {
        if (peek.column === null) return null;
        const bucket = series.buckets[peek.column];
        if (!bucket) return null;
        return (
          <ChartPeek
            from={bucket.at}
            to={bucket.at + series.bucketMs}
            total={bucket.calls}
            // The chart is one route's; so is the peek.
            filter={{ route: { method: series.method, route: series.route } }}
            onOpen={onOpenRequest}
            onHold={peek.hold}
            onLeave={peek.leave}
            style={{
              left: `clamp(160px, ${(((peek.column + 0.5) / columns) * 100).toFixed(2)}%, calc(100% - 160px))`,
            }}
          />
        );
      })()}
    </div>
  );
}
