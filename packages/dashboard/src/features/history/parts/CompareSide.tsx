import type { SeriesMetric, SeriesResponse } from '../../../api/index';
import { clock, count } from '../../../shared/format';
import { METRICS } from '../lib/metrics';
import type { RailScope } from './HistoryRail';

interface CompareSideProps {
  /** `A` or `B` — which of the pinned pair this is. */
  name: string;
  stretch: RailScope;
  drawn: SeriesResponse;
  metric: SeriesMetric;
}

/** One side of the pinned pair: when it was, how busy, and what it read. */
export function CompareSide({ name, stretch, drawn, metric }: CompareSideProps) {
  const column = drawn.bucketMs ? Math.round((stretch.from - drawn.from) / drawn.bucketMs) : 0;
  const value = drawn.series[0]?.values[column] ?? null;

  return (
    <div className="rail-compare-side">
      <span className="s-dim">{name}</span>
      <span>{clock(stretch.from)}</span>
      <span className="s-fg2">
        {count(stretch.total)} call{stretch.total === 1 ? '' : 's'}
      </span>
      <span className="s-acc">{value === null ? '—' : METRICS[metric].format(value)}</span>
    </div>
  );
}
