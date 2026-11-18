import type { RouteStats } from '../../../api/index';
import { bytes, count, duration, durationTone, methodTone } from '../../../shared/format';
import { badgeFor } from '../../../shared/waterfall/badge';
import { Trend } from './Trend';

/** How many detector badges a row shows before it says "and more". */
const BADGES = 2;

interface RouteRowProps {
  row: RouteStats;
  /** Its place in the table, counted from one. */
  rank: number;
  /** Among the few costliest, when the table is worth marking at all. */
  marked: boolean;
  /** The single route that costs the most — the one bar that is coloured. */
  worst: boolean;
  expanded: boolean;
  onToggle: () => void;
}

/** One route's numbers, in the order the header names them. */
export function RouteRow({ row, rank, marked, worst, expanded, onToggle }: RouteRowProps) {
  const badges = row.findings.slice(0, BADGES);
  const hidden = row.findings.length - badges.length;

  return (
    <button
      type="button"
      className="routes-grid routes-row"
      data-tick={marked ? 'warn' : undefined}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span className="s-dim">{rank}</span>
      <span className="ellipsis">
        <span className={methodTone(row.method)}>{row.method}</span> {row.route}
      </span>
      <span className="route-findings">
        {badges.map((found) => (
          <span key={found.detector} className="badge-nplus" title={found.title}>
            {badgeFor(found.detector)}
          </span>
        ))}
        {hidden > 0 ? <span className="s-dim">+{hidden}</span> : null}
      </span>
      <span className="cell-right s-fg2">{count(row.calls)}</span>
      <Trend trend={row.trend} red={row.errorRate > 0} />
      <span className="cell-right s-fg2">{row.rps.toFixed(2)}</span>
      <span className={`cell-right ${durationTone(row.p50)}`}>{duration(row.p50)}</span>
      <span className={`cell-right ${durationTone(row.p95)}`}>{duration(row.p95)}</span>
      <span className={`cell-right ${durationTone(row.p99)}`}>{duration(row.p99)}</span>
      <span className={`cell-right ${errorTone(row.errorRate)}`}>{row.errorRate.toFixed(1)}%</span>
      <span className={`cell-right ${row.sqlAvg >= 20 ? 's-warn' : 's-fg2'}`}>
        {row.sqlAvg.toFixed(1)}
      </span>
      <span className={`cell-right ${bytesTone(row.bytesAvg)}`}>
        {/* An em dash, not a zero: a route whose calls never said how
            big they were has no average, and a zero would sort it
            against routes that measured theirs. */}
        {row.bytesAvg === null ? '—' : bytes(row.bytesAvg)}
      </span>
      <span className="cell-right route-share">
        <span className="s-dim">{row.timeShare.toFixed(1)}%</span>
        <span className="share-track">
          <span
            className="share-fill"
            // Neutral, except for the one route that costs the most:
            // a colour that varies with the figure says "warning"
            // about a share that is merely large on a quiet screen.
            data-worst={worst || undefined}
            style={{ width: `${Math.min(100, row.timeShare)}%` }}
          />
        </span>
      </span>
    </button>
  );
}

/** A megabyte a call is a route somebody should look at. */
function bytesTone(average: number | null): string {
  if (average === null) return 's-dim';
  return average >= 1024 * 1024 ? 's-warn' : 's-fg2';
}

function errorTone(rate: number): string {
  if (rate > 5) return 's-err';
  if (rate > 0) return 's-warn';
  return 's-dim';
}
