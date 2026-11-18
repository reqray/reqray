import type { SeriesTotals } from '../../../api/index';
import { count, duration } from '../../../shared/format';
import { share } from '../lib/metrics';
import { Against } from './Against';

interface TotalsProps {
  totals: SeriesTotals;
  previous: SeriesTotals | null;
}

/** The period, as numbers rather than as a shape. */
export function Totals({ totals, previous }: TotalsProps) {
  return (
    <div className="history-totals">
      <span className="fact-label">calls</span>
      <span className="mono">
        {count(totals.calls)}
        <Against now={totals.calls} before={previous?.calls} format={count} />
      </span>

      <span className="fact-label">errors</span>
      <span className="mono">
        {share(totals.errorRate)}
        <Against now={totals.errorRate} before={previous?.errorRate} format={share} />
      </span>

      <span className="fact-label">p50 / p95 / p99</span>
      <span className="mono">
        {duration(totals.p50)} · {duration(totals.p95)} · {duration(totals.p99)}
        <Against now={totals.p95} before={previous?.p95} format={duration} />
      </span>

      <span className="fact-label">sql / app</span>
      <span className="mono">
        {/* `null` is not zero: a period recorded before the split was kept
            cannot answer, and saying "0 ms in SQL" would be an answer. */}
        {totals.sqlMs === null || totals.appMs === null ? (
          <span className="s-dim">not recorded for this period</span>
        ) : (
          `${duration(totals.sqlMs)} in SQL · ${duration(totals.appMs)} in app code`
        )}
      </span>

      <span className="fact-label">busiest</span>
      <span className="mono ellipsis">
        {totals.busiest ? (
          <>
            {totals.busiest.method} {totals.busiest.route}
            <span className="s-dim"> · {count(totals.busiest.calls)} calls</span>
          </>
        ) : (
          <span className="s-dim">nothing ran</span>
        )}
      </span>

      <span className="fact-label">fired most</span>
      <span className="mono">
        {totals.topFinding ? (
          <>
            {totals.topFinding.detector}
            <span className="s-dim"> · {count(totals.topFinding.calls)} requests</span>
          </>
        ) : (
          <span className="s-dim">no findings</span>
        )}
      </span>
    </div>
  );
}
