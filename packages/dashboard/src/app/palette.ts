/** What feeds the command palette, beyond the actions the shell wires up. */

import type { RequestRow } from '../api/index';

/** A route the panel can filter to — the shape the list and the palette speak. */
export type RoutePick = { method: string; route: string };

/** How many of the routes in hand the palette offers. */
const PALETTE_ROUTES = 12;

/**
 * The routes of the requests in hand — no extra fetch, and it is the traffic
 * being looked at anyway.
 */
export function recentRoutes(rows: readonly RequestRow[]): RoutePick[] {
  const unique = new Map(
    rows.map((row) => [`${row.method} ${row.route}`, { method: row.method, route: row.route }]),
  );
  return [...unique.values()].slice(0, PALETTE_ROUTES);
}
