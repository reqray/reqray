/**
 * The findings tab's arithmetic.
 *
 * Two claims carry this stage. Occurrences must group by problem — detector
 * plus code location — so eight hundred of them read as the handful of
 * problems they are. And the states must never lie in the optimistic
 * direction: `fixed` is only ever a guess about a file that changed after
 * the pattern went quiet, and a muted pattern stops shouting without the
 * detector stopping.
 */

import type { Callsite, RecordedRequest } from '@reqray/core';
import { timingOf, weightOf } from '@reqray/core';
import {
  type FindingSample,
  findingSamplesOf,
  flagWithMutes,
  patternsOf,
} from '@reqray/core/panel';
import { describe, expect, it } from 'vitest';

const BASE = 1_700_000_000_000;

const SHOP: Callsite = {
  file: '/srv/app/src/shop.js',
  relative: 'src/shop.js',
  line: 199,
  column: 5,
};
const PRICING: Callsite = {
  file: '/srv/app/src/pricing.js',
  relative: 'src/pricing.js',
  line: 42,
  column: 3,
};

function sample(over: Partial<FindingSample> = {}): FindingSample {
  return {
    requestId: 'r1',
    startedAt: BASE,
    method: 'GET',
    route: '/api/orders',
    status: 200,
    durationMs: 34,
    detector: 'n_plus_one',
    severity: 'warn',
    title: '150 identical queries ran in a loop',
    costMs: 24,
    callsite: SHOP,
    hint: 'fetch them in one query',
    ...over,
  };
}

const over = (samples: FindingSample[], options: Parameters<typeof patternsOf>[1] = {}) =>
  patternsOf({ samples, truncated: false }, options);

describe('occurrences become patterns', () => {
  it('groups by detector and code location, across routes', () => {
    // Two routes, one line of code: one problem. The routes are the rollup.
    const report = over([
      sample({ requestId: 'r1', route: '/api/orders' }),
      sample({ requestId: 'r2', route: '/api/orders/flaky', startedAt: BASE + 1_000 }),
      sample({ requestId: 'r3', route: '/api/orders/flaky', startedAt: BASE + 2_000 }),
    ]);

    expect(report.patterns).toHaveLength(1);
    const pattern = report.patterns[0];
    expect(pattern?.occurrences).toBe(3);
    expect(pattern?.recoverableMs).toBe(72);
    expect(pattern?.routes.map((route) => route.route)).toEqual([
      '/api/orders/flaky',
      '/api/orders',
    ]);
    expect(pattern?.firstSeen).toBe(BASE);
    expect(pattern?.lastSeen).toBe(BASE + 2_000);
  });

  it('keeps different lines apart — same detector is not same problem', () => {
    const report = over([sample(), sample({ requestId: 'r2', callsite: PRICING })]);

    expect(report.patterns).toHaveLength(2);
  });

  it('falls back to the route when a finding has no location', () => {
    const report = over([
      sample({ callsite: null, detector: 'slow_budget' }),
      sample({ requestId: 'r2', callsite: null, detector: 'slow_budget', route: '/api/export' }),
    ]);

    expect(report.patterns).toHaveLength(2);
  });

  it('orders by recoverable time, never by recency', () => {
    // The freshest pattern is the cheapest one; it still goes last.
    const report = over([
      sample({ costMs: 5, startedAt: BASE + 9_000 }),
      sample({ requestId: 'r2', callsite: PRICING, costMs: 500, startedAt: BASE }),
    ]);

    expect(report.patterns.map((pattern) => pattern.recoverableMs)).toEqual([500, 5]);
  });

  it('speaks with the freshest occurrence, and shouts at the loudest severity', () => {
    const report = over([
      sample({ title: '150 identical queries ran in a loop', severity: 'critical' }),
      sample({
        requestId: 'r2',
        startedAt: BASE + 5_000,
        title: '80 identical queries ran in a loop',
        severity: 'warn',
      }),
    ]);

    expect(report.patterns[0]?.title).toBe('80 identical queries ran in a loop');
    expect(report.patterns[0]?.severity).toBe('critical');
  });

  it('offers the worst examples, one per request', () => {
    // Two findings in one request are one way in, at the worse of the costs.
    const report = over([
      sample({ requestId: 'r1', costMs: 10 }),
      sample({ requestId: 'r1', costMs: 90 }),
      sample({ requestId: 'r2', costMs: 40 }),
      sample({ requestId: 'r3', costMs: 60 }),
      sample({ requestId: 'r4', costMs: 5 }),
    ]);

    expect(report.patterns[0]?.examples.map((example) => example.requestId)).toEqual([
      'r1',
      'r3',
      'r2',
    ]);
    expect(report.patterns[0]?.examples[0]?.costMs).toBe(90);
  });

  it('passes on that the store stopped reading', () => {
    const report = patternsOf({ samples: [sample()], truncated: true });

    expect(report.truncated).toBe(true);
  });
});

describe("what a pattern is in somebody's work", () => {
  it('is new until somebody says otherwise', () => {
    expect(over([sample()]).patterns[0]?.state).toBe('new');
  });

  it('remembers an acknowledgement', () => {
    const report = over([sample()], {
      states: new Map([['n_plus_one@src/shop.js:199', 'ack']]),
    });

    expect(report.patterns[0]?.state).toBe('ack');
  });

  it('guesses fixed only when the file changed after the last occurrence', () => {
    const fixed = over([sample()], { changedAt: () => BASE + 60_000 });
    const notFixed = over([sample()], { changedAt: () => BASE - 60_000 });
    const unknowable = over([sample({ callsite: null })], { changedAt: () => BASE + 60_000 });

    expect(fixed.patterns[0]?.state).toBe('fixed');
    expect(notFixed.patterns[0]?.state).toBe('new');
    // No location, no guess: "the file changed" needs a file.
    expect(unknowable.patterns[0]?.state).toBe('new');
  });

  it('fixed outranks ack — it says more', () => {
    const report = over([sample()], {
      states: new Map([['n_plus_one@src/shop.js:199', 'ack']]),
      changedAt: () => BASE + 60_000,
    });

    expect(report.patterns[0]?.state).toBe('fixed');
  });

  it('muted wins over everything, and leaves the recoverable total', () => {
    const report = over(
      [sample({ costMs: 500 }), sample({ requestId: 'r2', callsite: PRICING, costMs: 40 })],
      {
        states: new Map([['n_plus_one@src/shop.js:199', 'muted']]),
        changedAt: () => BASE + 60_000,
      },
    );

    expect(report.patterns[0]?.state).toBe('muted');
    // Occurrences count everything; the headline figure counts what is heard.
    expect(report.occurrences).toBe(2);
    expect(report.recoverableMs).toBe(40);
  });
});

describe('muting reaches the list', () => {
  const request = (findings: RecordedRequest['findings']): RecordedRequest => {
    const base = {
      id: 'r1',
      method: 'GET',
      path: '/api/orders',
      query: null,
      status: 200,
      durationMs: 34,
      startedAt: BASE,
      spans: [],
      findings,
      requestHeaders: {},
      responseHeaders: {},
      requestBody: null,
      responseBody: null,
      logs: [],
      error: null,
      droppedSpans: 0,
      droppedLogs: 0,
      test: null,
    };
    return { ...base, timing: timingOf([], 34), host: null, weight: weightOf(base), cost: null };
  };

  const finding = (detector: string, costMs: number, callsite: Callsite | null) => ({
    detector,
    severity: 'warn' as const,
    title: 'a problem',
    costMs,
    callsite,
    evidence: {
      kind: 'budget' as const,
      durationMs: 34,
      budgetMs: 10,
      externalMs: 0,
      sqlMs: 0,
      spanIds: [],
    },
    hint: 'fix it',
  });

  it('silences the muted pattern and lets the next finding speak', () => {
    const record = request([finding('n_plus_one', 90, SHOP), finding('dup_cache', 10, PRICING)]);

    expect(flagWithMutes(record, new Set())).toBe('n_plus_one');
    expect(flagWithMutes(record, new Set(['n_plus_one@src/shop.js:199']))).toBe('dup_cache');
    expect(
      flagWithMutes(record, new Set(['n_plus_one@src/shop.js:199', 'dup_cache@src/pricing.js:42'])),
    ).toBeNull();
  });

  it('reduces a record to occurrence rows', () => {
    const rows = findingSamplesOf(
      request([finding('n_plus_one', 90, SHOP), finding('dup_cache', 10, null)]),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      requestId: 'r1',
      route: '/api/orders',
      detector: 'n_plus_one',
      costMs: 90,
    });
  });
});
