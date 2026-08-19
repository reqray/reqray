import { describe, expect, it } from 'vitest';
import type { RequestRow } from '../src/api';
import { DEFAULT_SORT, nextSort, sortRows } from '../src/sort';

let seq = 0;

function row(overrides: Partial<RequestRow>): RequestRow {
  seq += 1;
  return {
    id: `r${seq}`,
    method: 'GET',
    path: `/api/${seq}`,
    query: null,
    status: 200,
    durationMs: 10,
    // Later rows are newer — the natural order of the live feed.
    startedAt: 1_000 + seq,
    sqlCount: 0,
    nPlusOne: false,
    findingCount: 0,
    hasError: false,
    ...overrides,
  };
}

describe('request list sorting', () => {
  it('newest first by default', () => {
    const rows = [row({}), row({}), row({})];

    const sorted = sortRows(rows, DEFAULT_SORT);

    expect(sorted.map((item) => item.startedAt)).toEqual(
      [...rows].map((item) => item.startedAt).sort((a, b) => b - a),
    );
  });

  it('duration: the first click puts the slowest on top', () => {
    const rows = [row({ durationMs: 12 }), row({ durationMs: 604 }), row({ durationMs: 48 })];

    const sort = nextSort(DEFAULT_SORT, 'duration');
    expect(sort).toEqual({ key: 'duration', dir: 'desc' });

    expect(sortRows(rows, sort).map((item) => item.durationMs)).toEqual([604, 48, 12]);
  });

  it('clicking the same column again flips the direction', () => {
    const rows = [row({ durationMs: 12 }), row({ durationMs: 604 })];

    const sort = nextSort(nextSort(DEFAULT_SORT, 'duration'), 'duration');
    expect(sort.dir).toBe('asc');

    expect(sortRows(rows, sort).map((item) => item.durationMs)).toEqual([12, 604]);
  });

  it('text columns start with alphabetical order', () => {
    const rows = [row({ path: '/api/users' }), row({ path: '/api/orders' })];

    const sort = nextSort(DEFAULT_SORT, 'path');
    expect(sort.dir).toBe('asc');

    expect(sortRows(rows, sort).map((item) => item.path)).toEqual(['/api/orders', '/api/users']);
  });

  it('status: errors on top after the first click', () => {
    const rows = [row({ status: 200 }), row({ status: 500 }), row({ status: 404 })];

    expect(sortRows(rows, nextSort(DEFAULT_SORT, 'status')).map((item) => item.status)).toEqual([
      500, 404, 200,
    ]);
  });

  it('ties keep the "newest first" order', () => {
    const oldest = row({ status: 200 });
    const newest = row({ status: 200 });

    const sorted = sortRows([oldest, newest], nextSort(DEFAULT_SORT, 'status'));

    expect(sorted[0]?.id).toBe(newest.id);
  });

  it('does not mutate the input array', () => {
    const rows = [row({ durationMs: 604 }), row({ durationMs: 12 })];
    const before = rows.map((item) => item.id);

    sortRows(rows, nextSort(DEFAULT_SORT, 'duration'));

    expect(rows.map((item) => item.id)).toEqual(before);
  });
});
