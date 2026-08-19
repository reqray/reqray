import { describe, expect, it } from 'vitest';
import type { RequestRow } from '../src/api';
import { DEFAULT_RULES, loadRules, RULES, type RuleId, saveRules, tintOf } from '../src/rules';

function row(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: 'r1',
    method: 'GET',
    path: '/api/orders',
    query: null,
    status: 200,
    durationMs: 20,
    startedAt: 1_000,
    sqlCount: 1,
    httpCount: 0,
    nPlusOne: false,
    findingCount: 0,
    hasError: false,
    pinned: false,
    test: null,
    ...overrides,
  };
}

const all = new Set<RuleId>(RULES.map((rule) => rule.id));

describe('highlight rules', () => {
  it('tints nothing on an ordinary row', () => {
    expect(tintOf(row(), all)).toBeNull();
  });

  it.each([
    ['slow_external', { durationMs: 1_500, httpCount: 2 }],
    ['server_error', { status: 500 }],
    ['n_plus_one', { nPlusOne: true }],
    ['chatty_sql', { sqlCount: 21 }],
    ['from_test', { test: 'orders.spec.ts:42' }],
  ] as const)('%s tints its own row', (id, overrides) => {
    expect(tintOf(row(overrides), all)).toBe(id);
  });

  it('a slow request that called nobody is not the external-call rule', () => {
    // The rule is about waiting on someone else, not about being slow.
    expect(tintOf(row({ durationMs: 5_000, httpCount: 0 }), all)).toBeNull();
  });

  it('the first matching rule wins', () => {
    // A 500 that is also an N+1 reads as an error, not as a query pattern.
    expect(tintOf(row({ status: 500, nPlusOne: true }), all)).toBe('server_error');
  });

  it('a disabled rule lets the next one through', () => {
    const withoutErrors = new Set<RuleId>([...all].filter((id) => id !== 'server_error'));

    expect(tintOf(row({ status: 500, nPlusOne: true }), withoutErrors)).toBe('n_plus_one');
  });

  it('the selected row keeps its own highlight', () => {
    expect(tintOf(row({ status: 500 }), all, true)).toBeNull();
  });

  describe('persistence', () => {
    const store = (value: string | null) => ({
      getItem: () => value,
      setItem: () => undefined,
    });

    it('starts with the three that earn their keep', () => {
      expect([...loadRules(store(null))]).toEqual([...DEFAULT_RULES]);
    });

    it('restores a saved selection', () => {
      expect([...loadRules(store('["chatty_sql"]'))]).toEqual(['chatty_sql']);
    });

    it('an empty selection is a choice, not a missing one', () => {
      expect([...loadRules(store('[]'))]).toEqual([]);
    });

    it('ignores rules it no longer has', () => {
      expect([...loadRules(store('["chatty_sql","rule_from_an_older_build"]'))]).toEqual([
        'chatty_sql',
      ]);
    });

    it('falls back to the defaults on garbage', () => {
      expect([...loadRules(store('not json'))]).toEqual([...DEFAULT_RULES]);
      expect([...loadRules(store('{"nope":1}'))]).toEqual([...DEFAULT_RULES]);
      expect([...loadRules(null)]).toEqual([...DEFAULT_RULES]);
    });

    it('a storage that throws does not break the panel', () => {
      const hostile = {
        getItem() {
          throw new Error('denied');
        },
        setItem() {
          throw new Error('denied');
        },
      };

      expect([...loadRules(hostile)]).toEqual([...DEFAULT_RULES]);
      expect(() => saveRules(hostile, all)).not.toThrow();
    });
  });
});
