/**
 * The store's own behaviour: what it keeps, what it throws away, and what it
 * still knows after the process that wrote it is gone.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordedRequest } from '@reqray/core';
import { type SqliteStore, sqliteTransport } from '@reqray/store-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { record, sample } from './fixtures/records.js';

const open = (options: Partial<Parameters<typeof sqliteTransport>[0]> = {}): SqliteStore =>
  sqliteTransport({ file: ':memory:', ...options });

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);
const page = (store: SqliteStore, over: Partial<Parameters<SqliteStore['page']>[0]> = {}) =>
  store.page({ filter: {}, limit: 50, ...over });

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reqray-sqlite-'));
  dirs.push(dir);
  return join(dir, 'reqray.db');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('storing and reading back', () => {
  it('hands back the whole record, spans and all', async () => {
    const store = open();
    const stored = record({
      id: 'r1',
      spans: [
        {
          id: 1,
          parentId: null,
          kind: 'db',
          sql: 'SELECT 1',
          fingerprint: 'SELECT ?',
          rowCount: 1,
          source: 'pg',
          clientId: null,
          connectionId: null,
          waitMs: null,
          values: null,
          startedAt: 1,
          duration: 2,
          selfMs: 2,
          callsite: null,
          error: null,
        },
      ],
    });

    store.send(stored);

    expect(store.get('r1')).toEqual(stored);
    await store.close();
  });

  it('knows nothing about a request it never saw', async () => {
    const store = open();
    expect(store.get('nope')).toBeUndefined();
    await store.close();
  });

  it('a request sent twice is stored once', async () => {
    const store = open();
    store.send(record({ id: 'r1' }));
    store.send(record({ id: 'r1' }));

    expect(store.stats().size).toBe(1);
    await store.close();
  });

  it('outlives the process that wrote it', async () => {
    // The whole point of the package: reopen the same file and the history is
    // still there.
    const file = tempFile();
    const first = open({ file });
    for (const entry of sample()) first.send(entry);
    await first.close();

    const second = open({ file });
    expect(second.stats().size).toBe(8);
    expect(second.get('r4')?.path).toBe('/api/report');
    await second.close();
  });

  it('newest first, both in the list and in a page', async () => {
    const store = open();
    for (const entry of sample()) store.send(entry);

    expect(ids(page(store).rows)).toEqual(['r8', 'r7', 'r6', 'r5', 'r4', 'r3', 'r2', 'r1']);
    expect(store.list()[0]?.id).toBe('r8');
    await store.close();
  });
});

describe('paging', () => {
  it('cuts the list and says where to continue', async () => {
    const store = open();
    for (const entry of sample()) store.send(entry);

    const first = page(store, { limit: 3 });
    expect(ids(first.rows)).toEqual(['r8', 'r7', 'r6']);
    expect(first.nextCursor).not.toBeNull();

    const second = page(store, { limit: 3, cursor: first.nextCursor });
    expect(ids(second.rows)).toEqual(['r5', 'r4', 'r3']);
    await store.close();
  });

  it('says the end is the end', async () => {
    const store = open();
    for (const entry of sample()) store.send(entry);

    const last = page(store, { limit: 8 });

    // Exactly a full page and nothing beyond it: a cursor here would send the
    // panel to fetch an empty page.
    expect(last.rows).toHaveLength(8);
    expect(last.nextCursor).toBeNull();
    await store.close();
  });

  it('serves no request twice when several start in the same millisecond', async () => {
    const store = open();
    const at = Date.UTC(2026, 7, 20, 12, 0, 0);
    for (const id of ['a', 'b', 'c', 'd']) store.send(record({ id, startedAt: at }));

    const first = page(store, { limit: 2 });
    const second = page(store, { limit: 2, cursor: first.nextCursor });

    expect(new Set([...ids(first.rows), ...ids(second.rows)]).size).toBe(4);
    await store.close();
  });

  it('counts the whole store in the summary, not the page', async () => {
    const store = open();
    for (const entry of sample()) store.send(entry);

    const { summary } = page(store, { limit: 2 });

    expect(summary.total).toBe(8);
    expect(summary.shown).toBe(8);
    // r3 at 620 ms and r4 at 855 ms are over the 500 ms line; r5 is the 500.
    expect(summary.slow).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.withFindings).toBe(1);
    await store.close();
  });

  it('a cursor from nowhere starts at the newest instead of failing', async () => {
    const store = open();
    for (const entry of sample()) store.send(entry);

    expect(ids(page(store, { limit: 2, cursor: 'rubbish' }).rows)).toEqual(['r8', 'r7']);
    await store.close();
  });
});

describe('retention', () => {
  it('keeps the newest and drops the oldest past the request budget', async () => {
    const store = open({ maxRequests: 5 });
    for (const entry of sample()) store.send(entry);

    expect(store.stats().size).toBe(5);
    expect(ids(page(store).rows)).toEqual(['r8', 'r7', 'r6', 'r5', 'r4']);
    expect(store.stats().evicted).toBe(3);
    await store.close();
  });

  it('a full store sweeps in steps, not on every insert', async () => {
    // The sweep walks the whole table. Run the moment a limit is crossed, a
    // full store pays for it on every request it records; with a fiftieth of
    // slack it pays once per batch and trims back to the exact limit.
    const store = open({ maxRequests: 100 });
    for (let index = 1; index <= 102; index++) store.send(record({ id: `r${index}` }));
    expect(store.stats().evicted).toBe(0);

    store.send(record({ id: 'r103' }));
    expect(store.stats().evicted).toBe(3);
    expect(store.stats().size).toBe(100);
    await store.close();
  });

  it('a pin does not leave the store permanently over its budget', async () => {
    // Pinned rows are outside the budget. Counted against it, one pin kept a
    // full store "over" for good, sweeping on every insert and removing
    // nothing.
    const store = open({ maxRequests: 100 });
    store.send(record({ id: 'kept' }));
    store.pin('kept', true);
    for (let index = 1; index <= 100; index++) store.send(record({ id: `r${index}` }));

    expect(store.stats().evicted).toBe(0);
    expect(store.stats().size).toBe(101);
    await store.close();
  });

  it('holds to a byte budget as well', async () => {
    const store = open({ maxBytes: 2_000 });
    for (let index = 1; index <= 40; index++) {
      store.send(record({ id: `r${index}`, responseBody: { text: 'x'.repeat(400) } as never }));
    }

    expect(store.stats().bytes).toBeLessThanOrEqual(2_000);
    expect(store.stats().size).toBeGreaterThan(0);
    await store.close();
  });

  it('a pinned request survives the budget', async () => {
    // A pin means "this is the one I am working on". Evicting it would make
    // the feature a lie.
    const store = open({ maxRequests: 3 });
    store.send(record({ id: 'r1' }));
    expect(store.pin('r1', true)).toBe(true);

    for (let index = 2; index <= 10; index++) store.send(record({ id: `r${index}` }));

    expect(store.get('r1')).toBeDefined();
    expect(store.pinned()).toEqual(['r1']);
    await store.close();
  });

  it('refuses a pin past the limit rather than dropping an older one', async () => {
    const store = open({ pinLimit: 2 });
    for (const id of ['a', 'b', 'c']) store.send(record({ id }));

    expect(store.pin('a', true)).toBe(true);
    expect(store.pin('b', true)).toBe(true);
    expect(store.pin('c', true)).toBe(false);
    // Unpinning always works, and frees the slot.
    expect(store.pin('a', false)).toBe(true);
    expect(store.pin('c', true)).toBe(true);
    await store.close();
  });

  it('pinning a request that is gone says so', async () => {
    const store = open();
    expect(store.pin('never-existed', true)).toBe(false);
    await store.close();
  });
});

describe("the panel's other needs", () => {
  it('a pinned request stays visible through a filter that excludes it', async () => {
    const store = open();
    for (const entry of sample()) store.send(entry);
    store.pin('r5', true);

    const rows = page(store, { filter: { methods: ['POST'] } }).rows;

    expect(ids(rows)).toContain('r5');
    await store.close();
  });

  it('feeds subscribers as requests arrive, and stops when told', async () => {
    const store = open();
    const seen: RecordedRequest[] = [];
    const unsubscribe = store.subscribe((request) => seen.push(request));

    store.send(record({ id: 'r1' }));
    unsubscribe();
    store.send(record({ id: 'r2' }));

    expect(ids(seen)).toEqual(['r1']);
    await store.close();
  });

  it('a throwing subscriber does not stop the store', async () => {
    const store = open();
    store.subscribe(() => {
      throw new Error('the panel fell over');
    });

    expect(() => store.send(record({ id: 'r1' }))).not.toThrow();
    expect(store.stats().size).toBe(1);
    await store.close();
  });

  it('clear empties it', async () => {
    const store = open();
    for (const entry of sample()) store.send(entry);

    store.clear();

    expect(store.stats().size).toBe(0);
    expect(page(store).rows).toEqual([]);
    await store.close();
  });

  it('caps what list() hands over, because a history has no end', async () => {
    const store = open({ listLimit: 4 });
    for (const entry of sample()) store.send(entry);

    expect(store.list()).toHaveLength(4);
    expect(store.list()[0]?.id).toBe('r8');
    await store.close();
  });
});

describe('findings', () => {
  it('reads occurrence rows back out of the payloads', async () => {
    const store = open();
    for (const entry of sample()) store.send(entry);

    const read = store.findings({});

    expect(read.truncated).toBe(false);
    expect(read.samples.length).toBeGreaterThan(0);
    expect(read.samples[0]).toMatchObject({ detector: 'n_plus_one' });
    // The window narrows it the same way every other reader narrows.
    expect(store.findings({ from: Number.MAX_SAFE_INTEGER - 1 }).samples).toHaveLength(0);

    await store.close();
  });

  it('ack and mute survive a restart — the part a buffer cannot promise', async () => {
    const file = tempFile();
    const first = sqliteTransport({ file });
    first.setFindingState('n_plus_one@src/shop.js:199', 'muted');
    first.setFindingState('dup_cache@src/cache.js:7', 'ack');
    first.setFindingState('dup_cache@src/cache.js:7', 'new');
    await first.close();

    const second = sqliteTransport({ file });
    const states = second.findingStates();
    expect(states.get('n_plus_one@src/shop.js:199')).toBe('muted');
    // `new` forgot it before the restart; the restart must not resurrect it.
    expect(states.has('dup_cache@src/cache.js:7')).toBe(false);
    await second.close();
  });
});
