/** Bar heights from the design: 3px minimum so an empty bucket stays visible. */
function barHeight(value: number, peak: number): number {
  if (peak <= 0) return 3;
  return 3 + Math.round((value / peak) * 14);
}

interface SparklineProps {
  buckets: readonly number[];
}

export function Sparkline({ buckets }: SparklineProps) {
  const peak = Math.max(...buckets, 0);
  return (
    <span className="sparkline">
      {buckets.map((value, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positional
          key={index}
          className="spark-bar"
          data-recent={index >= buckets.length - 3}
          style={{ height: `${barHeight(value, peak)}px` }}
        />
      ))}
    </span>
  );
}
