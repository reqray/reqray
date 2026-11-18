import { useMemo, useState } from 'react';
import type { RequestDetail } from '../../../api/index';
import { labelOf, parallelSpans } from '../../../shared/waterfall/model';

/** How many rows the table shows before it has to be asked for the rest. */
const SELF_TIME_ROWS = 8;

import { type Row, SelfTimeRow } from './SelfTimeRow';

interface SelfTimeProps {
  detail: RequestDetail;
}

/**
 * The spans, ranked by the time they spent in their own code.
 *
 * Ranking by duration is what everyone tries first, and it always returns the
 * same useless answer: the handler at the top, because it contains everything
 * and did none of it. This is the table that names what actually did the
 * work — usually two reads: which span holds the self time, and what it was
 * waiting on.
 */
export function SelfTime({ detail }: SelfTimeProps) {
  const [all, setAll] = useState(false);

  const parallel = useMemo(() => parallelSpans(detail.spans), [detail.spans]);

  // Identical spans are one row, the way the waterfall draws them as one bar.
  // A hundred and fifty rows of the same query is honest and useless: what
  // the reader is looking for is that the loop, taken together, is the
  // largest single thing in the request — and split into rows of 0.3 ms it
  // never appears at all.
  const ranked = useMemo(() => {
    const groups = new Map<string, Row>();
    for (const span of detail.spans) {
      const label = labelOf(span);
      const key = `${span.kind}|${label}`;
      const found = groups.get(key);
      if (found) {
        found.calls++;
        found.selfMs += span.selfMs ?? 0;
        found.totalMs += span.duration;
      } else {
        groups.set(key, {
          key,
          label,
          kind: span.kind,
          calls: 1,
          selfMs: span.selfMs ?? 0,
          totalMs: span.duration,
          parallel: parallel.has(span.id),
        });
      }
    }
    return [...groups.values()]
      .filter((row) => row.selfMs >= 0.05)
      .sort((a, b) => b.selfMs - a.selfMs);
  }, [detail.spans, parallel]);
  if (ranked.length === 0) return null;

  const rows = all ? ranked : ranked.slice(0, SELF_TIME_ROWS);
  const hidden = ranked.length - rows.length;

  return (
    <section className="selftime">
      <div className="label selftime-label">
        WHERE THE TIME WENT · BY SELF TIME
        <span className="s-dim" style={{ textTransform: 'none' }}>
          {' '}
          — duration minus what each span was waiting on
        </span>
      </div>
      <table className="selftime-table">
        <thead>
          <tr>
            <th>Span</th>
            <th className="cell-right">Self&nbsp;%</th>
            <th className="cell-right">Self</th>
            <th className="cell-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <SelfTimeRow key={row.key} row={row} ofMs={detail.durationMs} />
          ))}
        </tbody>
      </table>
      {hidden > 0 ? (
        <button type="button" className="selftime-more" onClick={() => setAll(true)}>
          {hidden} more row{hidden === 1 ? '' : 's'}
        </button>
      ) : null}
    </section>
  );
}
