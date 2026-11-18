import type { RouteSeries, SeriesBucket } from '../../../api/index';
import { HEIGHT, segments, WIDTH } from '../lib/scale';

interface LatencyProps {
  series: RouteSeries;
}

/**
 * Latency: the spread as a band, the p95 as a line.
 *
 * Three lines was the obvious drawing and the wrong one. A column holding
 * five calls has a p95 and a p99 that are the same number — the slowest of
 * the five — so the three lines sat on top of each other, a pixel apart, and
 * read as one thick wobble. A band between p50 and p99 says what the three
 * lines were trying to: here is the middle, here is the tail, and this is how
 * far apart they were.
 */
export function Latency({ series }: LatencyProps) {
  const peak = Math.max(...series.buckets.map((bucket) => bucket.p99), 1);
  const step = WIDTH / series.buckets.length;
  const x = (index: number) => index * step + step / 2;
  const y = (value: number) => HEIGHT - (value / peak) * (HEIGHT - 4) - 2;

  const spread = segments(series.buckets, (bucket) => bucket.p50).map((run, index) => {
    const top = run.map((point) => `${x(point.index)},${y(series.buckets[point.index]?.p99 ?? 0)}`);
    const bottom = [...run].reverse().map((point) => `${x(point.index)},${y(point.value)}`);
    return (
      <polygon
        key={`spread-${run[0]?.index ?? index}`}
        className="chart-spread"
        points={[...top, ...bottom].join(' ')}
      />
    );
  });

  const line = (pick: (bucket: SeriesBucket) => number, className: string) =>
    segments(series.buckets, pick).map((run) => {
      const first = run[0];
      if (!first) return null;
      // A polyline needs two points. One column of traffic surrounded by
      // silence is an ordinary shape — a demo that ran for a minute, an
      // endpoint called once — and drawing nothing for it looks like a bug in
      // the chart rather than a fact about the traffic.
      if (run.length === 1) {
        return (
          <circle
            key={`${className}-${first.index}`}
            className={`${className} chart-dot`}
            cx={x(first.index)}
            cy={y(first.value)}
            r={2}
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
    });

  return (
    <>
      {spread}
      {line((bucket) => bucket.p95, 'chart-p95')}
    </>
  );
}
