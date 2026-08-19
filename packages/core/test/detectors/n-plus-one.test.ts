/**
 * Tests for the N+1 detector.
 *
 * Two groups, both mandatory. The "does not find" group matters more than the
 * first one and must not be smaller: a false positive is worse than a miss.
 */

import { type NPlusOneOptions, nPlusOne, resolveOptions } from '@loupe/core';
import { describe, expect, it } from 'vitest';
import { scenario } from '../fixtures/spans.js';

const options: NPlusOneOptions = nPlusOne.defaultOptions;

const run = (scope: Parameters<typeof nPlusOne.run>[0], overrides?: Partial<NPlusOneOptions>) =>
  // The N+1 detector ignores the request facts; the budget detector is the
  // one that reads them.
  nPlusOne.run(scope, { ...options, ...overrides }, { durationMs: 100, status: 200 });

const ORDERS = 'SELECT id, total FROM orders WHERE user_id = 8812 ORDER BY created_at DESC';
const lineItems = (orderId: number) => `SELECT * FROM line_items WHERE order_id = ${orderId}`;

describe('finds', () => {
  it('the canonical N+1: a query in a loop over parent results', () => {
    const scope = scenario()
      .query({
        sql: ORDERS,
        duration: 8.6,
        callsite: 'src/services/orders.ts:96',
        source: 'prisma',
      })
      .loop(47, (i) => ({
        sql: lineItems(i),
        duration: 0.9,
        callsite: 'src/services/orders.ts:118',
        source: 'prisma',
      }))
      .done();

    const [finding, ...rest] = run(scope);

    expect(rest).toHaveLength(0);
    expect(finding).toMatchObject({
      detector: 'n_plus_one',
      severity: 'info',
      title: '47 identical queries ran in a loop',
      callsite: { relative: 'src/services/orders.ts', line: 118 },
    });
    expect(finding?.evidence).toMatchObject({
      kind: 'n_plus_one',
      repeats: 47,
      fingerprint: 'SELECT * FROM line_items WHERE order_id = ?',
    });
  });

  it('costMs is the reclaimable time, not the total', () => {
    // 47 queries of 0.9 ms = 42.3 ms. A fix does not remove the query
    // entirely: one remains, and its price is the longest of the run.
    const scope = scenario()
      .loop(47, () => ({ sql: lineItems(1), duration: 0.9, callsite: 'src/orders.ts:118' }))
      .done();

    const [finding] = run(scope);

    expect(finding?.evidence).toMatchObject({ kind: 'n_plus_one' });
    expect((finding?.evidence as { totalMs: number }).totalMs).toBeCloseTo(42.3, 5);
    expect(finding?.costMs).toBeCloseTo(41.4, 5);
  });

  it('fires exactly at the threshold', () => {
    const scope = scenario()
      .loop(5, () => ({ sql: lineItems(1), duration: 10, callsite: 'src/orders.ts:118' }))
      .done();

    expect(run(scope)).toHaveLength(1);
  });

  it('stays silent one below the threshold', () => {
    const scope = scenario()
      .loop(4, () => ({ sql: lineItems(1), duration: 10, callsite: 'src/orders.ts:118' }))
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('reports a nested N+1 as a separate finding', () => {
    const builder = scenario();
    for (let order = 0; order < 6; order++) {
      builder.query({ sql: lineItems(order), duration: 5, callsite: 'src/orders.ts:118' });
      builder.loop(6, (i) => ({
        sql: `SELECT * FROM products WHERE id = ${i}`,
        duration: 5,
        callsite: 'src/items.ts:42',
      }));
    }

    const findings = run(builder.done());

    expect(findings).toHaveLength(2);
    expect(
      findings.map((f) => (f.evidence as { repeats: number }).repeats).sort((a, b) => a - b),
    ).toEqual([6, 36]);
  });

  it('raises severity along with the cost', () => {
    const cheap = scenario()
      .loop(6, () => ({ sql: lineItems(1), duration: 5, callsite: 'src/orders.ts:118' }))
      .done();
    const costly = scenario()
      .loop(30, () => ({ sql: lineItems(1), duration: 20, callsite: 'src/orders.ts:118' }))
      .done();

    expect(run(cheap)[0]?.severity).toBe('info');
    expect(run(costly)[0]?.severity).toBe('critical');
  });

  it('tailors the hint to the specific ORM', () => {
    const prisma = scenario()
      .loop(10, () => ({
        sql: lineItems(1),
        duration: 5,
        callsite: 'src/orders.ts:118',
        source: 'prisma',
      }))
      .done();
    const raw = scenario()
      .loop(10, () => ({
        sql: lineItems(1),
        duration: 5,
        callsite: 'src/orders.ts:118',
        source: 'pg',
      }))
      .done();

    expect(run(prisma)[0]?.hint).toContain('include');
    expect(run(prisma)[0]?.hint).toContain('line_items');
    expect(run(raw)[0]?.hint).toContain('IN');
  });
});

describe('does NOT find', () => {
  it('Promise.all of 20 identical queries is already optimized', () => {
    const scope = scenario()
      .parallel(20, (i) => ({ sql: lineItems(i), duration: 10, callsite: 'src/orders.ts:118' }))
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('partially parallel batches of 4 are not a loop either', () => {
    const scope = scenario()
      .batches(20, 4, (i) => ({ sql: lineItems(i), duration: 10, callsite: 'src/orders.ts:118' }))
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('a batch insert of 100 rows is normal practice', () => {
    const scope = scenario()
      .loop(100, (i) => ({
        sql: `INSERT INTO events (name, payload) VALUES ('click', '${i}')`,
        duration: 2,
        callsite: 'src/events.ts:12',
      }))
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('UPDATE in a loop does not count as N+1', () => {
    const scope = scenario()
      .loop(30, (i) => ({
        sql: `UPDATE counters SET value = value + 1 WHERE id = ${i}`,
        duration: 3,
        callsite: 'src/counters.ts:8',
      }))
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('the same SQL from three different places is a coincidence, not a loop', () => {
    const places = ['src/a.ts:10', 'src/b.ts:20', 'src/c.ts:30'];
    const scope = scenario()
      .loop(9, (i) => ({
        sql: lineItems(i),
        duration: 10,
        callsite: places[i % places.length] as string,
      }))
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('20 repeats cheaper than minWastedMs — nothing to report', () => {
    const scope = scenario()
      .loop(20, () => ({ sql: lineItems(1), duration: 0.1, callsite: 'src/orders.ts:118' }))
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('queries split by a long external call are two runs, not a loop', () => {
    const scope = scenario()
      .loop(3, () => ({ sql: lineItems(1), duration: 10, callsite: 'src/orders.ts:118' }))
      .externalCall(300)
      .loop(3, () => ({ sql: lineItems(1), duration: 10, callsite: 'src/orders.ts:118' }))
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('without a single callsite the finding is useless — stay silent', () => {
    const scope = scenario()
      .loop(20, () => ({ sql: lineItems(1), duration: 10, callsite: null }))
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('different queries in a row are not grouped', () => {
    const scope = scenario()
      .loop(20, (i) => ({
        sql: `SELECT * FROM table_${i} WHERE id = 1`,
        duration: 10,
        callsite: 'src/orders.ts:118',
      }))
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('an empty request with no spans yields no findings', () => {
    expect(run(scenario().done())).toHaveLength(0);
  });
});

describe('tuning thresholds', () => {
  it('the user can raise the threshold', () => {
    const scope = scenario()
      .loop(6, () => ({ sql: lineItems(1), duration: 10, callsite: 'src/orders.ts:118' }))
      .done();

    expect(run(scope)).toHaveLength(1);
    expect(run(scope, { threshold: 10 })).toHaveLength(0);
  });

  it('minWastedMs cuts off cheap runs', () => {
    const scope = scenario()
      .loop(20, () => ({ sql: lineItems(1), duration: 5, callsite: 'src/orders.ts:118' }))
      .done();

    expect(run(scope)).toHaveLength(1);
    expect(run(scope, { minWastedMs: 1_000 })).toHaveLength(0);
  });

  it('the whole detector can be disabled via options', () => {
    expect(resolveOptions({ detect: { nPlusOne: false } }).detect.nPlusOne).toBeNull();
    expect(
      resolveOptions({ detect: { nPlusOne: { threshold: 10 } } }).detect.nPlusOne,
    ).toMatchObject({ threshold: 10, minWastedMs: 20 });
  });
});

describe('cost of running', () => {
  it('does not degrade on a large number of spans', () => {
    const builder = scenario();
    for (let i = 0; i < 4_000; i++) {
      builder.query({
        sql: `SELECT * FROM t_${i % 40} WHERE id = ${i}`,
        duration: 0.5,
        callsite: `src/f${i % 40}.ts:1`,
      });
    }
    const scope = builder.done();

    const startedAt = performance.now();
    const findings = run(scope);
    const elapsed = performance.now() - startedAt;

    expect(findings).toHaveLength(40);
    // Rough upper bound: a quadratic scan shows up here immediately. The real
    // cost check is the overhead benchmark in bench/.
    expect(elapsed).toBeLessThan(250);
  });
});
