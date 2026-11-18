import type { RequestRow } from '../../../api/index';

/**
 * A burst: the same route answering the same way, fired together.
 *
 * "Together" is starts within this many milliseconds of the first — the
 * signature of a client fanning out in parallel. Sequential repeats are
 * spaced by at least a round trip and stay separate rows, which is what the
 * duplicate detectors are about.
 */
export const BURST_SPREAD_MS = 5;

/** Fewer than this and collapsing hides more than it tidies. */
export const BURST_MIN = 3;

export interface BurstGroup {
  readonly head: RequestRow;
  readonly rows: RequestRow[];
}

/**
 * Consecutive identical simultaneous calls, one group each.
 *
 * Only meaningful in the feed's own order (newest first): a burst is a
 * moment, and a list sorted by anything else has already dissolved it.
 * Pinned rows never join a group — a pin the reader set aside must not
 * disappear into a multiplier.
 */
export function groupBursts(rows: readonly RequestRow[]): BurstGroup[] {
  const groups: BurstGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (
      last &&
      !row.pinned &&
      !last.head.pinned &&
      row.method === last.head.method &&
      row.route === last.head.route &&
      row.status === last.head.status &&
      last.head.startedAt - row.startedAt <= BURST_SPREAD_MS
    ) {
      last.rows.push(row);
      continue;
    }
    groups.push({ head: row, rows: [row] });
  }
  return groups;
}
