import type { RequestRow } from '../../api/index';

/** Columns of the request list a click on the header can sort by. */
export type SortKey = 'method' | 'path' | 'status' | 'duration' | 'cpu' | 'sql' | 'time';

/** Which way a column reads. */
export type SortDir = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** Newest first — the order the live feed naturally produces. */
export const DEFAULT_SORT: SortState = { key: 'time', dir: 'desc' };

/**
 * The direction a column starts with: text reads top-down alphabetically,
 * numbers lead with what the user is hunting — the slowest, the chattiest,
 * the errors.
 */
const FIRST_DIR: Record<SortKey, SortDir> = {
  method: 'asc',
  path: 'asc',
  status: 'desc',
  duration: 'desc',
  cpu: 'desc',
  sql: 'desc',
  time: 'desc',
};

/** A click on a header: same column flips the direction, a new one starts over. */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: FIRST_DIR[key] };
}

function cellOf(row: RequestRow, key: SortKey): string | number {
  switch (key) {
    case 'method':
      return row.method;
    case 'path':
      return `${row.path}${row.query ? `?${row.query}` : ''}`;
    case 'status':
      return row.status;
    case 'duration':
      return row.durationMs;
    case 'cpu':
      // Unmeasured sorts below genuinely free: "we do not know" is not a
      // claim that it cost nothing.
      return row.cpuMs ?? -1;
    case 'sql':
      return row.sqlCount;
    case 'time':
      return row.startedAt;
  }
}

/**
 * Sorted copy of the rows. Ties break by recency so that, say, all the 200s
 * keep the familiar newest-first order instead of shuffling on every refresh.
 */
export function sortRows(rows: readonly RequestRow[], sort: SortState): RequestRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = cellOf(a, sort.key);
    const right = cellOf(b, sort.key);
    const order =
      typeof left === 'string' ? left.localeCompare(right as string) : left - (right as number);
    return order !== 0 ? sign * order : b.startedAt - a.startedAt;
  });
}
