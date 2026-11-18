/** The list, one request, and the live feed. */

import type {
  DurationBaseline,
  HostPressure,
  RequestDetail,
  RequestRow,
  RequestSummary,
} from '@reqray/protocol';
import { apiBase, getJson, type RequestFilterQuery, sendJson, toSearchParams } from './client';

/**
 * One page of the list.
 *
 * The filter goes to the server rather than being applied to what happens to
 * be loaded: with a history behind the panel, "only the errors" has to mean
 * every error there is, not every error on this screen.
 */
export async function fetchRequests(
  filter: RequestFilterQuery = {},
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<{ requests: RequestRow[]; summary: RequestSummary; nextCursor: string | null }> {
  const search = toSearchParams(filter);
  const url = `${apiBase()}/requests${search}${cursor ? `${search ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : ''}`;
  return getJson(url, signal);
}

export async function fetchRequest(id: string, signal?: AbortSignal): Promise<RequestDetail> {
  return getJson(`${apiBase()}/requests/${encodeURIComponent(id)}`, signal);
}

/**
 * How this call compares against the route's own history, and whether the
 * process underneath was struggling while it ran.
 *
 * Both are ordinarily `null`: fewer than two other calls to compare against,
 * a store that does not keep enough to be asked, or — for the pressure — a
 * host that simply did not vary.
 */
export async function fetchBaseline(
  id: string,
  signal?: AbortSignal,
): Promise<{ baseline: DurationBaseline | null; pressure: HostPressure | null }> {
  return getJson(`${apiBase()}/requests/${encodeURIComponent(id)}/baseline`, signal);
}

export async function clearRequests(): Promise<void> {
  await sendJson('/requests', 'DELETE');
}

/**
 * Pins or unpins a request on the collector.
 *
 * @returns whether it is pinned now — a refusal (gone, or too many pinned)
 * comes back as `false` rather than an exception, because the only thing the
 * panel can do about it is leave the glyph alone.
 */
export async function pinRequest(id: string, pinned: boolean): Promise<boolean> {
  try {
    const response = await fetch(`${apiBase()}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, pinned }),
    });
    if (!response.ok) return false;
    return ((await response.json()) as { pinned?: boolean }).pinned === true;
  } catch {
    return false;
  }
}

/**
 * Subscribes to the live feed.
 *
 * @returns unsubscribe function.
 */
export function subscribeToRequests(
  onRow: (row: RequestRow) => void,
  onReconnect?: () => void,
): () => void {
  const source = new EventSource(`${apiBase()}/stream`);

  source.onmessage = (event) => {
    try {
      onRow(JSON.parse(event.data) as RequestRow);
    } catch {
      // A malformed frame must not kill the feed.
    }
  };

  // The stream carries no backlog, so whatever was recorded while the
  // connection was down is not coming: the browser reconnects on its own and
  // simply resumes, leaving a hole in the middle of the list. The caller is
  // told, so it can ask the store what it missed. The first open is not a
  // reconnect.
  let dropped = false;
  source.onerror = () => {
    dropped = true;
  };
  source.onopen = () => {
    if (!dropped) return;
    dropped = false;
    onReconnect?.();
  };

  return () => source.close();
}
