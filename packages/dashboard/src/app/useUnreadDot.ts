import { useEffect, useState } from 'react';
import { fetchFindings } from '../api/index';
import { unreadCount } from '../shared/findings';
import { useLiveQuery } from '../shared/useLiveQuery';

/**
 * A slow cadence on purpose: the tab reports exactly while it is open, and a
 * dot may lag half a minute without lying.
 */
const DOT_REFRESH_MS = 30_000;

const readFindings = (signal: AbortSignal) => fetchFindings(null, signal);

/**
 * The dot on the Findings tab: how many patterns nobody has looked at.
 *
 * Fed from two sides — this poll, and the findings screen itself, which
 * reports the exact count while it is open.
 */
export function useUnreadDot(live: boolean): [number, (count: number) => void] {
  const [unread, setUnread] = useState(0);
  const { data } = useLiveQuery(readFindings, {
    live,
    refreshMs: DOT_REFRESH_MS,
    keepLastGood: true,
  });

  useEffect(() => {
    // `null` — this store cannot read findings back, and the dot stays quiet.
    if (data) setUnread(unreadCount(data.patterns));
  }, [data]);

  return [unread, setUnread];
}
