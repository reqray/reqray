/**
 * The live feed's bookkeeping.
 *
 * The list is fetched once and then kept up to date one row at a time, so
 * every arrival has to land in the right place, replace an earlier copy of
 * itself, and never let the client hold more requests than the server still
 * has to open.
 */

import { describe, expect, it } from 'vitest';
import type { RequestRow } from '../src/api/index';
import { DEFAULT_CAPACITY, insertRow, withArrival } from '../src/shared/list/insert';

function row(id: string, startedAt = 0): RequestRow {
  return {
    id,
    method: 'GET',
    path: `/api/orders/${id}`,
    query: null,
    status: 200,
    durationMs: 5,
    startedAt,
    sqlCount: 1,
    httpCount: 0,
    nPlusOne: false,
    hasError: false,
    findingCount: 0,
    flag: null,
    route: '/api/orders/:id',
    pinned: false,
    test: null,
  } as RequestRow;
}

const ids = (rows: readonly RequestRow[]) => rows.map((entry) => entry.id);

const summary = { shown: 0, total: 10, slow: 1, errors: 2, withFindings: 3 };

describe('the numbers under the list', () => {
  it('move with the feed, because the store was asked once', () => {
    // A panel left open for an hour would otherwise show the totals from the
    // minute it was opened.
    const next = withArrival(summary, row('new'));

    expect(next.total).toBe(11);
    expect(next.slow).toBe(1);
    expect(next.errors).toBe(2);
    expect(next.withFindings).toBe(3);
  });

  it('count a slow arrival as slow', () => {
    expect(withArrival(summary, { ...row('slow'), durationMs: 900 }).slow).toBe(2);
    // Exactly on the line counts, as it does everywhere else in the panel.
    expect(withArrival(summary, { ...row('edge'), durationMs: 500 }).slow).toBe(2);
    expect(withArrival(summary, { ...row('quick'), durationMs: 499 }).slow).toBe(1);
  });

  it('count a failure and a finding', () => {
    expect(withArrival(summary, { ...row('boom'), hasError: true }).errors).toBe(3);
    expect(withArrival(summary, { ...row('slow-sql'), findingCount: 2 }).withFindings).toBe(4);
    // Any finding, not only an N+1 — which is what the label now says.
    expect(withArrival(summary, { ...row('clean'), findingCount: 0 }).withFindings).toBe(3);
  });

  it('leaves what it was not asked about alone', () => {
    expect(withArrival(summary, row('new')).shown).toBe(summary.shown);
  });
});

describe('a row arriving on the feed', () => {
  it('goes to the front, where the newest belongs', () => {
    const rows = insertRow([row('a'), row('b')], row('c'), DEFAULT_CAPACITY);

    expect(ids(rows)).toEqual(['c', 'a', 'b']);
  });

  it('replaces an earlier copy of itself rather than doubling it', () => {
    // A reconnecting feed can replay what the client already has.
    const rows = insertRow([row('a'), row('b')], row('b'), DEFAULT_CAPACITY);

    expect(ids(rows)).toEqual(['b', 'a']);
  });

  it('never grows the list past what the server holds', () => {
    const full = Array.from({ length: 500 }, (_, index) => row(`r${index}`));

    const rows = insertRow(full, row('new'), 500);

    expect(rows).toHaveLength(500);
    expect(rows[0]?.id).toBe('new');
    // The oldest is the one that goes, exactly as it does in the ring buffer.
    expect(ids(rows)).not.toContain('r499');
  });

  it('follows a larger server buffer instead of a number of its own', () => {
    // A collector keeps more than an in-process ring does. Trimming to the
    // in-process default would shrink the list while the reader watched it.
    const many = Array.from({ length: 900 }, (_, index) => row(`r${index}`));

    expect(insertRow(many, row('new'), 2000)).toHaveLength(901);
    expect(insertRow(many, row('new'), DEFAULT_CAPACITY)).toHaveLength(DEFAULT_CAPACITY);
  });

  it('leaves a list that is under the cap alone', () => {
    expect(insertRow([], row('a'), DEFAULT_CAPACITY)).toHaveLength(1);
  });
});
