/**
 * The history obeys the shared policy.
 *
 * Age is the limit the old code did not have: a store nobody has written to
 * for a week still holds a week-old request, and "kept for three days" has to
 * mean that whether or not traffic arrives to trigger the sweep.
 */

import { DAY_MS, type RecordedRequest, retentionPolicy } from '@reqray/core';
import { sqliteTransport } from '@reqray/store-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { record } from './fixtures/records.js';

const stores: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

function store(options: Record<string, unknown> = {}) {
  const made = sqliteTransport({ file: ':memory:', ...options });
  stores.push(made);
  return made;
}

/** A request that finished `days` ago. */
function aged(id: string, days: number): RecordedRequest {
  return { ...record({ id }), startedAt: Date.now() - days * DAY_MS };
}

describe('keeping requests for a number of days', () => {
  it('drops what is older than the limit', async () => {
    const held = store({ retention: retentionPolicy({ days: 3 }) });

    held.send(aged('old', 10));
    held.send(aged('recent', 1));

    expect(held.list().map((entry) => entry.id)).toEqual(['recent']);
  });

  it('keeps everything when age is not limited', async () => {
    const held = store({ retention: retentionPolicy({ maxRequests: 100 }) });

    held.send(aged('ancient', 400));

    expect(held.list()).toHaveLength(1);
  });

  it('applies a change from the panel without waiting for traffic', async () => {
    const retention = retentionPolicy({ days: 30 });
    const held = store({ retention });

    held.send(aged('old', 10));
    held.send(aged('recent', 1));
    expect(held.list()).toHaveLength(2);

    // Somebody moves the setting; the store sweeps on the news, not on the
    // next request — a store that waits for traffic to obey looks broken.
    retention.update({ days: 3 });

    expect(held.list().map((entry) => entry.id)).toEqual(['recent']);
  });

  it('never drops a pinned request, whatever its age', async () => {
    const retention = retentionPolicy({ days: 30 });
    const held = store({ retention });

    held.send(aged('old', 10));
    held.pin('old', true);
    retention.update({ days: 1 });

    expect(held.list().map((entry) => entry.id)).toEqual(['old']);
  });

  it('takes its count and size limits from the policy too', async () => {
    const retention = retentionPolicy({ maxRequests: 2 });
    const held = store({ retention, maxRequests: 1_000 });

    for (const id of ['a', 'b', 'c']) held.send(record({ id }));

    // The policy wins over the number written in code: one setting, one
    // meaning, whichever store is asked.
    expect(held.list()).toHaveLength(2);
    expect(held.stats().capacity).toBe(2);
  });

  it('keeps to its own limits when there is no policy', async () => {
    const held = store({ maxRequests: 2 });

    for (const id of ['a', 'b', 'c']) held.send(record({ id }));

    expect(held.list()).toHaveLength(2);
  });
});
