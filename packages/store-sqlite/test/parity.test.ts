/**
 * The two stores must answer identically.
 *
 * "Matching" is now decided in three places: `filterRequests` in the core,
 * which the in-memory store and the browser use, and the SQL in `query.ts`.
 * Three implementations of one rule drift the moment somebody edits one of
 * them, and the drift shows up as a filter that quietly means something
 * different depending on where the data happens to live.
 *
 * So both stores are filled with the same records and asked the same
 * questions, and the ids they hand back have to be the same list in the same
 * order. This is the test that fails when the rule is changed in one place.
 */

import { historyOf, type RequestFilter } from '@reqray/core/panel';
import { memoryTransport } from '@reqray/store-memory';
import { sqliteTransport } from '@reqray/store-sqlite';
import { describe, expect, it } from 'vitest';
import { BASE_TIME, record, sample, sampleWithWildcards } from './fixtures/records.js';

function stores() {
  const memory = memoryTransport({ capacity: 100 });
  const sqlite = sqliteTransport({ file: ':memory:' });
  for (const entry of sampleWithWildcards()) {
    memory.send(entry);
    sqlite.send(entry);
  }
  return { memory, sqlite };
}

const CASES: Array<[name: string, filter: RequestFilter]> = [
  ['no filter at all', {}],
  ['a path substring', { query: 'orders' }],
  ['a substring that matches nothing', { query: 'zzz' }],
  ['a status typed into the search box', { query: '500' }],
  ['a method typed into the search box', { query: 'post' }],
  ['something only the query string has', { query: 'walnut' }],
  ['upper case, because the box does not care', { query: 'ORDERS' }],
  ['one method', { methods: ['POST'] }],
  ['two methods', { methods: ['GET', 'POST'] }],
  ['a status class', { statusClasses: [5] }],
  ['two status classes', { statusClasses: [2, 4] }],
  ['slower than 100 ms', { minDurationMs: 100 }],
  ['slower than everything there is', { minDurationMs: 10_000 }],
  ['only what the detectors flagged', { onlyFindings: true }],
  ['a filter and a search at once', { methods: ['GET'], query: 'api', minDurationMs: 20 }],
  // The search box is a free-text field: what it types must be data, not syntax.
  ['a percent sign, which SQL would read as a wildcard', { query: '100%' }],
  ['an underscore, which SQL would read as any character', { query: 'a_i' }],
  ['a bare percent sign, which would otherwise match everything', { query: '%' }],
  // The sample starts at BASE_TIME and each record is a second later.
  ['everything since the third second', { from: BASE_TIME + 3_000 }],
  ['everything up to the third second', { to: BASE_TIME + 3_000 }],
  ['one stretch in the middle', { from: BASE_TIME + 2_000, to: BASE_TIME + 5_000 }],
  ['a stretch nothing happened in', { from: BASE_TIME + 60_000, to: BASE_TIME + 90_000 }],
  ['a stretch that ends before it starts', { from: BASE_TIME + 5_000, to: BASE_TIME + 1_000 }],
  ['a stretch and a filter together', { from: BASE_TIME + 2_000, methods: ['GET'] }],
  ['only the N+1s', { onlyNPlusOne: true }],
  ['only what a test issued', { onlyTests: true }],
  ['only what failed', { onlyErrors: true }],
  ['one endpoint, picked on the Routes screen', { route: { method: 'GET', route: '/api/orders' } }],
  ['an endpoint with an id in it', { route: { method: 'GET', route: '/api/profile/:id' } }],
  [
    'the same endpoint under a method nobody used',
    { route: { method: 'PUT', route: '/api/orders' } },
  ],
  // The token filters stage 54 taught the search box.
  ['exactly one status code', { status: 401 }],
  ['a status code nobody answered', { status: 418 }],
  ['a path substring, wildcards and all', { path: 'a_i' }],
  ['at least one query', { minSql: 1 }],
  ['rows flagged N+1', { flagged: ['n_plus_one'] }],
  ['rows flagged with detectors that never fired', { flagged: ['dup_http', 'sequential_http'] }],
  ['issued by a test matching a word', { test: 'profile' }],
  ['a test word nobody used', { test: 'checkout' }],
  ['a test word with a wildcard in it', { test: '_i' }],
];

describe('memory and SQLite answer the same', () => {
  for (const [name, filter] of CASES) {
    it(name, async () => {
      const { memory, sqlite } = stores();
      const ask = (store: { page: typeof memory.page }) =>
        store.page({ filter, limit: 50 }).rows.map((row) => row.id);

      expect(ask(sqlite)).toEqual(ask(memory));
      await sqlite.close();
    });
  }

  it('and the narrow cases are not both empty, which would prove nothing', async () => {
    const { sqlite } = stores();

    const ask = (filter: RequestFilter) =>
      sqlite.page({ filter, limit: 50 }).rows.map((row) => row.id);
    expect(ask({ onlyNPlusOne: true })).toEqual(['r1']);
    expect(ask({ onlyTests: true })).toEqual(['r8']);
    expect(ask({ onlyErrors: true })).toEqual(['r5']);
    // The path had an id in it, and both stores collapse it the same way.
    expect(ask({ route: { method: 'GET', route: '/api/profile/:id' } })).toEqual(['r8']);
    // Both ends are inclusive, and the boundary record is in.
    expect(ask({ from: BASE_TIME + 8_000 })).toEqual(['r10', 'r9', 'r8']);
    expect(ask({ to: BASE_TIME + 2_000 })).toEqual(['r2', 'r1']);
    await sqlite.close();
  });

  it('and the wildcard cases are not both empty either', async () => {
    const { sqlite } = stores();

    // `a_i` finds the literal path and not the decoy; `%` finds only the row
    // that actually contains one.
    expect(sqlite.page({ filter: { query: 'a_i' }, limit: 50 }).rows.map((row) => row.id)).toEqual([
      'r9',
    ]);
    expect(sqlite.page({ filter: { query: '%' }, limit: 50 }).rows.map((row) => row.id)).toEqual([
      'r9',
    ]);
    await sqlite.close();
  });

  it('including a period of history, down to the last figure', async () => {
    // The history screen's numbers must not depend on which store is behind
    // them. Both are filled with the same requests, both are asked for the
    // same stretch, and what the aggregation makes of the two answers has to
    // be the same object — percentiles, totals, the busiest route and the
    // finding that fired most.
    const memory = memoryTransport({ capacity: 100 });
    const sqlite = sqliteTransport({ file: ':memory:' });
    for (const entry of sample()) {
      memory.send(entry);
      sqlite.send(entry);
    }

    const query = { from: BASE_TIME, to: BASE_TIME + 60_000, filter: {} };
    const draw = (store: { history: typeof memory.history }) =>
      historyOf(store.history(query), [], {
        from: query.from,
        to: query.to,
        metrics: ['p95', 'throughput'],
        columns: 8,
      });

    const fromSqlite = draw(sqlite);
    expect(fromSqlite).toEqual(draw(memory));
    // And not both empty, which would prove nothing.
    expect(fromSqlite.totals.calls).toBe(8);
    expect(fromSqlite.totals.p95).toBeGreaterThan(0);
    expect(fromSqlite.totals.busiest).not.toBeNull();
    await sqlite.close();
  });

  it('including the durations a verdict is drawn from', async () => {
    const memory = memoryTransport({ capacity: 100 });
    const sqlite = sqliteTransport({ file: ':memory:' });
    // Twelve calls of one route, one call of another, and one with an id in
    // the path that has to collapse into the same route as the rest.
    const calls = [
      ...Array.from({ length: 12 }, (_, index) =>
        record({ id: `c${index}`, path: '/api/orders', durationMs: 10 + index }),
      ),
      record({ id: 'c99', path: '/api/orders/8812', durationMs: 999 }),
      record({ id: 'other', path: '/api/report', durationMs: 500 }),
      record({ id: 'posted', method: 'POST', path: '/api/orders', durationMs: 700 }),
    ];
    for (const entry of calls) {
      memory.send(entry);
      sqlite.send(entry);
    }

    const query = { method: 'GET', route: '/api/orders', excludeId: 'c0' };
    const ask = (store: { durations: typeof memory.durations }) =>
      [...store.durations(query)].map((sample) => sample.durationMs).sort((a, b) => a - b);

    // Eleven: twelve calls of the route, minus the one being judged. The
    // POST, the other route and `/api/orders/8812` are all somebody else's.
    expect(ask(sqlite)).toHaveLength(11);
    expect(ask(sqlite)).toEqual(ask(memory));
    expect(ask(sqlite)).not.toContain(999);
    expect(ask(sqlite)).not.toContain(700);
    await sqlite.close();
  });

  it('including what the event loop was doing at the time', async () => {
    const memory = memoryTransport({ capacity: 100 });
    const sqlite = sqliteTransport({ file: ':memory:' });
    const calls = Array.from({ length: 4 }, (_, index) =>
      record({
        id: `h${index}`,
        path: '/api/orders',
        durationMs: 10 + index,
        // The third was recorded when nothing was watching the loop.
        host: index === 2 ? null : { loopDelayMs: index * 12, loopMaxMs: index * 30 },
      }),
    );
    for (const entry of calls) {
      memory.send(entry);
      sqlite.send(entry);
    }

    const query = { method: 'GET', route: '/api/orders', excludeId: 'none' };
    const ask = (store: { durations: typeof memory.durations }) =>
      [...store.durations(query)]
        .sort((a, b) => a.durationMs - b.durationMs)
        .map((sample) => sample.loopDelayMs);

    // Null survives the round trip through a column rather than becoming a
    // zero: "not measured" and "the loop was fine" are different facts, and
    // the comparison must not average the first in as if it were the second.
    expect(ask(sqlite)).toEqual([0, 12, null, 36]);
    expect(ask(sqlite)).toEqual(ask(memory));
    await sqlite.close();
  });

  it('including the numbers under the list', async () => {
    const { memory, sqlite } = stores();
    const filter = { methods: ['GET'] };

    expect(sqlite.page({ filter, limit: 50 }).summary).toEqual(
      memory.page({ filter, limit: 50 }).summary,
    );
    await sqlite.close();
  });

  it('including where a page stops and what comes next', async () => {
    const { memory, sqlite } = stores();

    const firstMemory = memory.page({ filter: {}, limit: 3 });
    const firstSqlite = sqlite.page({ filter: {}, limit: 3 });
    expect(firstSqlite.nextCursor).toEqual(firstMemory.nextCursor);

    // And a cursor one store wrote is one the other can continue from.
    const crossed = memory.page({ filter: {}, limit: 3, cursor: firstSqlite.nextCursor });
    const own = sqlite.page({ filter: {}, limit: 3, cursor: firstMemory.nextCursor });
    expect(own.rows.map((row) => row.id)).toEqual(crossed.rows.map((row) => row.id));
    await sqlite.close();
  });

  it('and a handler that threw and still answered 200 counts as failed', async () => {
    // The 5xx class would miss it, which is why the filter is not the class.
    const memory = memoryTransport({ capacity: 10 });
    const sqlite = sqliteTransport({ file: ':memory:' });
    const quietFailure = record({
      id: 'r11',
      status: 200,
      error: { name: 'TypeError', message: 'cannot read undefined', stack: null },
    });
    for (const entry of [...sample(), quietFailure]) {
      memory.send(entry);
      sqlite.send(entry);
    }

    const ask = (store: { page: typeof memory.page }, filter: RequestFilter) =>
      store.page({ filter, limit: 50 }).rows.map((row) => row.id);
    expect(ask(sqlite, { onlyErrors: true })).toEqual(['r11', 'r5']);
    expect(ask(sqlite, { onlyErrors: true })).toEqual(ask(memory, { onlyErrors: true }));
    expect(ask(sqlite, { statusClasses: [5] })).toEqual(['r5']);
    await sqlite.close();
  });

  it('including a pinned row a filter would have hidden', async () => {
    const { memory, sqlite } = stores();
    memory.pin('r5', true);
    sqlite.pin('r5', true);
    const filter = { methods: ['POST'] };

    expect(sqlite.page({ filter, limit: 50 }).rows.map((row) => row.id)).toEqual(
      memory.page({ filter, limit: 50 }).rows.map((row) => row.id),
    );
    await sqlite.close();
  });
});

describe('memory and SQLite agree on what was slowest', () => {
  it('the same order, and the same tie broken the same way', async () => {
    const { memory, sqlite } = stores();
    const ask = (store: { page: typeof memory.page }) =>
      store.page({ filter: {}, limit: 50, sort: 'slowest' }).rows.map((row) => row.id);

    // r9 and r10 both took 12 ms; the larger id comes first, in both stores,
    // because that is the rule the cursor continues by.
    expect(ask(sqlite)).toEqual(['r4', 'r3', 'r1', 'r6', 'r2', 'r9', 'r10', 'r7', 'r8', 'r5']);
    expect(ask(sqlite)).toEqual(ask(memory));
    await sqlite.close();
  });

  it('and page through it without repeating or skipping a row', async () => {
    const { memory, sqlite } = stores();

    const walk = (store: { page: typeof memory.page }) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const next: ReturnType<typeof memory.page> = store.page({
          filter: {},
          limit: 3,
          sort: 'slowest',
          cursor,
        });
        ids.push(...next.rows.map((row) => row.id));
        cursor = next.nextCursor;
        if (!cursor) break;
      }
      return ids;
    };

    const whole = sqlite.page({ filter: {}, limit: 50, sort: 'slowest' }).rows.map((r) => r.id);
    expect(walk(sqlite)).toEqual(whole);
    expect(walk(memory)).toEqual(whole);
    await sqlite.close();
  });

  it('and a cursor from one store continues in the other', async () => {
    const { memory, sqlite } = stores();

    const first = sqlite.page({ filter: {}, limit: 4, sort: 'slowest' });
    const crossed = memory.page({
      filter: {},
      limit: 4,
      sort: 'slowest',
      cursor: first.nextCursor,
    });
    const own = sqlite.page({ filter: {}, limit: 4, sort: 'slowest', cursor: first.nextCursor });

    expect(own.rows.map((row) => row.id)).toEqual(crossed.rows.map((row) => row.id));
    // And the fractional key survived the trip: 12 ms is where the tie is.
    expect(own.rows.map((row) => row.id)).toEqual(['r2', 'r9', 'r10', 'r7']);
    await sqlite.close();
  });

  it('and a filter still applies when the order changes', async () => {
    const { memory, sqlite } = stores();
    const filter = { methods: ['GET'] };
    const ask = (store: { page: typeof memory.page }) =>
      store.page({ filter, limit: 50, sort: 'slowest' }).rows.map((row) => row.id);

    expect(ask(sqlite)).toEqual(ask(memory));
    expect(ask(sqlite)[0]).toBe('r4');
    await sqlite.close();
  });
});
