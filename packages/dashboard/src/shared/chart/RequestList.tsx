import { useEffect, useState } from 'react';
import { fetchRequests, type RequestFilterQuery, type RequestRow } from '../../api/index';
import { clock, count, duration, durationTone, methodTone, statusTone } from '../format';
import { badgeFor } from '../waterfall/badge';

/** How many requests a peek names. */
const PEEK_LIMIT = 10;

/** The column must hold still this long before the store is asked. */
const FETCH_SETTLE_MS = 150;

/**
 * What the head says about how much of the column is on screen.
 *
 * `shown` is `null` while the answer is still coming: a list that says "all 3
 * calls" and then grows is a list that lied.
 */
function headOf(total: number, shown: number | null): string {
  if (total === 0) return 'nothing ran here';
  if (shown === null) return 'reading…';
  if (total > shown) return `the ${shown} slowest of ${count(total)} calls`;
  return `all ${count(total)} call${total === 1 ? '' : 's'}, slowest first`;
}

interface RequestListProps {
  /** The hovered column's stretch, epoch ms. */
  from: number;
  to: number;
  /** Requests in the column, from the series already drawn. */
  total: number;
  /** The chart's current filter — the list answers the same question. */
  filter: RequestFilterQuery;
  onOpen: (id: string) => void;
}

/**
 * The list itself — fetch, head line, rows — with no chrome of its own.
 *
 * Two containers wear it: the floating card the route charts pop under a
 * column, and the history screen's docked rail. One list, so what a row says
 * and does never depends on where it appears.
 */
export function RequestList({ from, to, total, filter, onOpen }: RequestListProps) {
  const [rows, setRows] = useState<RequestRow[] | null>(null);

  // One string carrying every input, so a re-render with the same question
  // does not re-ask it — the parent recreates `filter` on every render.
  const key = JSON.stringify([Math.round(from), Math.round(to), filter]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: key carries from/to/filter; total only gates the ask
  useEffect(() => {
    if (total === 0) return;
    const controller = new AbortController();
    // Rows already shown stay while the pointer slides — replaced, never
    // blanked, the same discipline as every chart here.
    const timer = setTimeout(() => {
      fetchRequests(
        {
          ...filter,
          from: Math.floor(from),
          to: Math.ceil(to),
          sort: 'slowest',
          limit: PEEK_LIMIT,
        },
        null,
        controller.signal,
      )
        // The store adds pinned requests to every answer, whenever they were
        // recorded; under a header naming this stretch they do not belong.
        .then((page) =>
          setRows(page.requests.filter((row) => row.startedAt >= from && row.startedAt <= to)),
        )
        .catch(() => {
          // An aborted or failed ask keeps whatever is on screen.
        });
    }, FETCH_SETTLE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, total]);

  const head = headOf(total, rows?.length ?? null);
  /** What there is to click: the rows that arrived, when the store had any. */
  const listed = total > 0 && rows ? rows : [];

  return (
    <>
      <div className="peek-head mono s-dim">
        <span>{head}</span>
        <span className="spacer" />
        <span>
          {clock(from)} → {clock(to)}
        </span>
      </div>

      {listed.map((row) => (
        <button key={row.id} type="button" className="peek-row" onClick={() => onOpen(row.id)}>
          <span className="s-dim">{clock(row.startedAt)}</span>
          <span className={methodTone(row.method)}>{row.method}</span>
          <span className="ellipsis">
            {row.path}
            {row.flag ? <span className="badge-nplus peek-flag">{badgeFor(row.flag)}</span> : null}
          </span>
          <span className={statusTone(row.status)}>{row.status}</span>
          <span className={durationTone(row.durationMs)}>{duration(row.durationMs)}</span>
        </button>
      ))}

      {listed.length > 0 ? (
        <div className="peek-hint s-dim mono">click a request to open it</div>
      ) : null}
    </>
  );
}
