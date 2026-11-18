import type { MetricSeries } from '../../../api/index';
import { HEIGHT, segments, WIDTH } from '../lib/scale';

interface LineProps {
  line: MetricSeries;
  columns: number;
  className: string;
  /**
   * The scale to draw on, when it is somebody else's.
   *
   * The ghost shares the primary line's axis — on its own it would be
   * stretched to its own peak, and a quiet week would look exactly like a
   * catastrophic one.
   */
  peak?: number;
}

/** One line, on its own scale — two metrics rarely share units. */
export function Line({ line, columns, className, peak: given }: LineProps) {
  // Somebody else's scale when there is one, and a positive one: a primary
  // line of nothing but voids must not send the ghost off the top of the box.
  const own = Math.max(...line.values.map((value) => value ?? 0), 0);
  const peak = Math.max(given && given > 0 ? given : own, Number.MIN_VALUE);
  const step = WIDTH / columns;
  const x = (index: number) => index * step + step / 2;
  const y = (value: number) => HEIGHT - (value / peak) * (HEIGHT - 8) - 4;

  /**
   * One unbroken run of readings.
   *
   * A single column of traffic between two silences is an ordinary shape, and
   * a polyline needs two points to be anything at all — so it is drawn as a
   * dot instead.
   */
  const shapeOf = (run: ReturnType<typeof segments>[number]) => {
    const first = run[0];
    if (!first) return null;

    if (run.length === 1) {
      return (
        <circle
          key={`${className}-${first.index}`}
          className={`${className} chart-dot`}
          cx={x(first.index)}
          cy={y(first.value)}
          r={2.5}
        />
      );
    }

    return (
      <polyline
        key={`${className}-${first.index}`}
        className={className}
        points={run.map((point) => `${x(point.index)},${y(point.value)}`).join(' ')}
      />
    );
  };

  return <>{segments(line.values).map(shapeOf)}</>;
}
