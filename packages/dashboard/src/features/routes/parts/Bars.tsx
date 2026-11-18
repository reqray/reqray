import type { RouteSeries, SeriesBucket } from '../../../api/index';
import { HEIGHT, WIDTH } from '../lib/scale';

interface BarsProps {
  series: RouteSeries;
  pick: (bucket: SeriesBucket) => number;
  className: string;
}

export function Bars({ series, pick, className }: BarsProps) {
  const peak = Math.max(...series.buckets.map(pick), 1);
  const step = WIDTH / series.buckets.length;

  /** One column, or nothing where the bucket is empty. */
  const barOf = (bucket: RouteSeries['buckets'][number], index: number) => {
    const value = pick(bucket);
    if (value <= 0) return null;
    const height = Math.max(1, (value / peak) * (HEIGHT - 4));

    return (
      <rect
        key={bucket.at}
        className={className}
        x={index * step + 1}
        y={HEIGHT - height}
        width={Math.max(1, step - 2)}
        height={height}
      />
    );
  };

  return <>{series.buckets.map(barOf)}</>;
}
