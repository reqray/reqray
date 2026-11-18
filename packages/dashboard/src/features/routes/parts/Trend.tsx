interface TrendProps {
  trend: readonly number[];
  red: boolean;
}

/**
 * The traffic's shape, ten bars wide.
 *
 * Scaled to the route's own busiest column rather than to the table's: the
 * question a sparkline answers is "steady, bursty, or long gone", and one
 * route with a thousand calls would flatten every other row to nothing.
 */
export function Trend({ trend, red }: TrendProps) {
  const peak = Math.max(...trend, 1);
  return (
    <span className="trend" data-red={red || undefined} aria-hidden="true">
      {trend.map((calls, index) => (
        <span
          // Bars are positions in a fixed-length window; nothing reorders.
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
          key={index}
          className="trend-bar"
          style={{ height: `${Math.max(calls > 0 ? 12 : 0, (calls / peak) * 100)}%` }}
        />
      ))}
    </span>
  );
}
