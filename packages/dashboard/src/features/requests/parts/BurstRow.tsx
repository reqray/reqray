import { clock, methodTone, statusTone } from '../../../shared/format';
import { BURST_SPREAD_MS, type BurstGroup } from '../lib/bursts';
import { gradeOf } from '../lib/marks';
import { CostCell } from './CostCell';
import { DurationCell } from './DurationCell';

interface BurstRowProps {
  group: BurstGroup;
  yardMs: number;
  onExpand: () => void;
}

/** The one row a collapsed burst shows: the shape, the count, the average. */
export function BurstRow({ group, yardMs, onExpand }: BurstRowProps) {
  const { head, rows } = group;
  const avgMs = rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length;
  const sql = rows.reduce((sum, row) => sum + row.sqlCount, 0);
  // Averaged over the calls that were measured, not over all of them: a burst
  // straddling a restart would otherwise read as half price.
  const measured = rows.filter((row) => row.cpuMs !== null);
  const avgCpuMs = measured.length
    ? measured.reduce((sum, row) => sum + (row.cpuMs ?? 0), 0) / measured.length
    : null;
  const avgCpuShare = measured.length
    ? measured.reduce((sum, row) => sum + (row.cpuShare ?? 0), 0) / measured.length
    : null;
  return (
    <button
      type="button"
      className="row row-grid"
      data-tick={undefined}
      onClick={onExpand}
      title={`${rows.length} identical calls within ${BURST_SPREAD_MS} ms — click to expand`}
    >
      <span className="row-gutter" data-grade={gradeOf(head)} />
      <span className="cell-marks" />
      <span className={`cell-method ${methodTone(head.method)}`}>{head.method}</span>
      <span className="ellipsis">
        {head.route}
        <span className="s-dim"> · identical calls · expand</span>
      </span>
      <span className={`cell-right ${head.status < 300 ? 's-dim' : statusTone(head.status)}`}>
        {head.status}
      </span>
      <span className="cell-center">
        <span className="burst-tag">{rows.length}×</span>
      </span>
      <DurationCell ms={avgMs} yardMs={yardMs} note="avg" />
      <CostCell cpuMs={avgCpuMs} cpuShare={avgCpuShare} yardMs={yardMs} />
      <span className={`cell-right ${sql === 0 ? 's-dim' : 's-fg2'}`}>{sql === 0 ? '—' : sql}</span>
      <span className="cell-right s-dim">{clock(head.startedAt)}</span>
    </button>
  );
}
