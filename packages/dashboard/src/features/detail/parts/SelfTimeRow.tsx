import type { Span } from '../../../api/index';
import { duration, spanColor } from '../../../shared/format';

/** One line of the self-time table: a span, or every repeat of one span. */
export interface Row {
  key: string;
  label: string;
  kind: Span['kind'];
  /** How many spans this line stands for. */
  calls: number;
  /** Their own time, added up — self times of separate spans never overlap. */
  selfMs: number;
  totalMs: number;
  parallel: boolean;
}

interface SelfTimeRowProps {
  row: Row;
  /** The whole request, which the share is a share of. */
  ofMs: number;
}

/** One span's own time, as a share of the request and as a bar. */
export function SelfTimeRow({ row, ofMs }: SelfTimeRowProps) {
  const share = ofMs > 0 ? (row.selfMs / ofMs) * 100 : 0;

  return (
    <tr>
      <td className="selftime-name">
        <span className="dot" style={{ background: spanColor(row.kind) }} />
        <span className="ellipsis">
          {row.calls > 1 ? `${row.calls}× ` : ''}
          {row.label}
        </span>
        {row.parallel ? (
          <span
            className="s-dim selftime-parallel"
            title="Its children ran at the same time as each other, so they cost it less than they add up to."
          >
            ∥
          </span>
        ) : null}
      </td>
      <td className="cell-right mono num">
        <span className="selftime-bar" style={{ width: `${Math.min(100, share)}%` }} />
        <span className="selftime-share">{share.toFixed(1)}%</span>
      </td>
      <td className="cell-right mono num">{duration(row.selfMs)}</td>
      <td className="cell-right mono num s-dim">{duration(row.totalMs)}</td>
    </tr>
  );
}
