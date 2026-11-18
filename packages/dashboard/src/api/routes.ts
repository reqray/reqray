/** Per-route aggregates and the charts one row opens into. */

import type { RouteSeries, RouteStats } from '@reqray/protocol';
import { apiBase, getJson } from './client';

export async function fetchRoutes(
  signal?: AbortSignal,
): Promise<{ routes: RouteStats[]; samples: number; windowMs: number; from: number; to: number }> {
  return getJson(`${apiBase()}/routes`, signal);
}

/** Latency, failures and throughput for one route, bucketed by the store. */
export async function fetchRouteSeries(
  method: string,
  route: string,
  buckets: number,
  window: { from: number; to: number },
  signal?: AbortSignal,
): Promise<RouteSeries | null> {
  const search = new URLSearchParams({
    method,
    route,
    buckets: String(buckets),
    from: String(Math.round(window.from)),
    to: String(Math.round(window.to)),
  });
  const { series } = await getJson<{ series: RouteSeries | null }>(
    `${apiBase()}/routes/series?${search}`,
    signal,
  );
  return series;
}
