import { memo } from 'react';
import type { RequestRow } from '../../../api/index';
import { clock, methodTone, statusTone } from '../../../shared/format';
import { badgeFor } from '../../../shared/waterfall/badge';
import { gradeOf, sqlTone } from '../lib/marks';
import type { RuleId } from '../lib/rules';
import { CostCell } from './CostCell';
import { DurationCell } from './DurationCell';

interface RowProps {
  row: RequestRow;
  selected: boolean;
  fresh: boolean;
  /** The highlight rule that claimed this row, if any. */
  tint: RuleId | null;
  /** `A` or `B` when this row is part of the comparison, `null` otherwise. */
  compareSlot: string | null;
  /** The slowest duration in view — what the bars are scaled against. */
  yardMs: number;
  onOpen: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onCompare: (id: string) => void;
}

/**
 * Memoised: the live feed renders the list on every arrival, and at a few
 * hundred rows the arrivals were costing a thousand row renders a second.
 * Every prop is a primitive or a stable callback, so an untouched row is a
 * cache hit; measured, the same traffic renders only the rows that changed.
 */
export const Row = memo(function Row({
  row,
  selected,
  fresh,
  tint,
  compareSlot,
  yardMs,
  onOpen,
  onPin,
  onCompare,
}: RowProps) {
  /**
   * One click target for the row, three meanings: the glyphs mark themselves
   * so a click on them never opens the detail.
   */
  const click = (event: React.MouseEvent<HTMLElement>) => {
    const hit = (event.target as HTMLElement).closest('[data-act]');
    const act = hit?.getAttribute('data-act');
    if (act === 'pin') onPin(row.id, !row.pinned);
    else if (act === 'cmp') onCompare(row.id);
    else onOpen(row.id);
  };

  return (
    <button
      type="button"
      className="row row-grid"
      data-tick={selected ? 'acc' : undefined}
      data-selected={selected}
      data-fresh={fresh}
      data-rule={tint ?? undefined}
      onClick={click}
    >
      <span className="row-gutter" data-grade={gradeOf(row)} />
      <span className="cell-marks">
        <span
          data-act="pin"
          className={`mark ${row.pinned ? 's-acc' : 's-dim'}`}
          title={
            row.pinned ? 'pinned — survives the ring buffer' : 'pin — survives the ring buffer'
          }
        >
          {row.pinned ? '●' : '○'}
        </span>
        <span
          data-act="cmp"
          className={`mark ${compareSlot ? 's-acc' : 's-dim'}`}
          title="add to the comparison"
        >
          {compareSlot ?? '+'}
        </span>
      </span>
      <span className={`cell-method ${methodTone(row.method)}`}>{row.method}</span>
      <span className="ellipsis">
        {row.path}
        {row.query ? <span className="s-dim">?{row.query}</span> : null}
        {row.test ? (
          <span className="test-mark" title={`issued by ${row.test}`}>
            TEST
          </span>
        ) : null}
      </span>
      <span
        className={`cell-right ${row.status < 300 ? 's-dim' : statusTone(row.status)}`}
        style={{ fontWeight: row.status >= 400 ? 700 : 400 }}
      >
        {row.status}
      </span>
      <span className="cell-center">
        {row.flag ? (
          <span className="flag" title={`${row.findingCount} finding(s) — ${row.flag}`}>
            {badgeFor(row.flag)}
          </span>
        ) : null}
      </span>
      <DurationCell ms={row.durationMs} yardMs={yardMs} />
      <CostCell cpuMs={row.cpuMs} cpuShare={row.cpuShare} yardMs={yardMs} />
      <span className={`cell-right ${sqlTone(row)}`}>
        {row.sqlCount === 0 ? '—' : row.sqlCount}
      </span>
      <span className="cell-right s-dim">{clock(row.startedAt)}</span>
    </button>
  );
});
