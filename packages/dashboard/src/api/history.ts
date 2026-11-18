/** One metric over a period, the strip above the list, and what ran in a moment. */

import type {
  ActivityReport,
  SeriesMetric,
  SeriesResponse,
  TimelineBucket,
} from '@reqray/protocol';
import { apiBase, getJson, type RequestFilterQuery, toSearchParams } from './client';

/**
 * One reading of the history screen.
 *
 * `null` from a store that cannot read a stretch — the in-memory ring can,
 * SQLite can, and a source that implements neither says so rather than
 * letting the screen draw a quiet week that was never recorded.
 */
export async function fetchSeries(
  query: RequestFilterQuery & { metrics: SeriesMetric[]; buckets?: number },
  signal?: AbortSignal,
): Promise<SeriesResponse | null> {
  const { metrics, buckets, ...filter } = query;
  const search = new URLSearchParams(toSearchParams(filter).replace(/^\?/, ''));
  search.set('metric', metrics.join(','));
  if (buckets) search.set('buckets', String(buckets));

  const payload = await getJson<{ series: SeriesResponse | null }>(
    `${apiBase()}/series?${search}`,
    signal,
  );
  return payload.series;
}

/**
 * The shape of the traffic over the store's whole range.
 *
 * `null` from a store that does not keep one — the panel then draws the strip
 * from the rows it has loaded, which is what it always did.
 */
export async function fetchTimeline(
  buckets: number,
  range?: { from: number; to: number } | null,
  signal?: AbortSignal,
): Promise<{ from: number; to: number; buckets: TimelineBucket[] } | null> {
  const search = new URLSearchParams({ buckets: String(buckets) });
  if (range) {
    search.set('from', String(Math.round(range.from)));
    search.set('to', String(Math.round(range.to)));
  }
  const payload = await getJson<{
    timeline: { from: number; to: number; buckets: TimelineBucket[] } | null;
  }>(`${apiBase()}/timeline?${search}`, signal);
  return payload.timeline;
}

/**
 * What ran in one stretch of time, ranked against each route's own baseline.
 *
 * The whole window is passed along so the moment can be taken out of its own
 * baseline: a spike that inflates what it is compared against reports itself
 * as ordinary.
 */
export async function fetchActivity(
  moment: { from: number; to: number },
  window: { from: number; to: number },
  signal?: AbortSignal,
): Promise<ActivityReport | null> {
  const search = new URLSearchParams({
    from: String(Math.round(moment.from)),
    to: String(Math.round(moment.to)),
    overallFrom: String(Math.round(window.from)),
    overallTo: String(Math.round(window.to)),
  });
  const { activity } = await getJson<{ activity: ActivityReport | null }>(
    `${apiBase()}/timeline/at?${search}`,
    signal,
  );
  return activity;
}
