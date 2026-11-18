/**
 * Process-wide state: the slots, and the caches that live in them.
 */

import {
  createReqray,
  fingerprintSql,
  globalBox,
  globalSlot,
  type Transport,
  TwoGenerationCache,
} from '@reqray/core';
import { clearSqlCaches } from '@reqray/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('slots', () => {
  it('two declarations of one name are one thing', () => {
    // This is the whole point: the ESM and CJS copies of core each declare
    // their own accessor, and both must reach the same object or the request
    // context splits in two and nothing is recorded at all.
    const first = globalSlot('test.shared', () => new Map<string, number>());
    const second = globalSlot('test.shared', () => new Map<string, number>());

    first().set('x', 1);
    expect(second().get('x')).toBe(1);
    expect(first()).toBe(second());
  });

  it('the second declaration does not overwrite the first', () => {
    const first = globalSlot('test.once', () => ({ made: 'first' }));
    first();
    const second = globalSlot('test.once', () => ({ made: 'second' }));

    expect(second().made).toBe('first');
  });

  it('a box holds what a slot cannot: a value that is replaced', () => {
    const box = globalBox('test.box', 0);
    box().value = 7;

    expect(globalBox('test.box', 0)().value).toBe(7);
  });
});

describe('a cache with a ceiling and no cliff', () => {
  it('keeps what is still being used, however many turnovers pass', () => {
    const cache = new TwoGenerationCache<string, string>(3);
    cache.set('hot', 'value');

    // Churn far past the ceiling. The guarantee is not that an entry lives
    // forever — it is that reading one keeps it, so an application's hot
    // statement is never the thing thrown away to make room.
    for (let i = 0; i < 100; i++) {
      cache.set(`filler-${i}`, 'x');
      expect(cache.get('hot')).toBe('value');
    }
  });

  it('lets go of what stopped being used', () => {
    const cache = new TwoGenerationCache<string, string>(2);
    cache.set('cold', 'value');

    // Two full turnovers with no read in between: nothing promoted it.
    for (let i = 0; i < 5; i++) cache.set(`filler-${i}`, 'x');
    expect(cache.get('cold')).toBeUndefined();
  });

  it('bounds what it holds', () => {
    const cache = new TwoGenerationCache<number, number>(10);
    for (let i = 0; i < 1_000; i++) cache.set(i, i);

    // Twice the limit is the ceiling — the price of not having a cliff.
    expect(cache.size).toBeLessThanOrEqual(20);
  });
});

describe('the SQL fingerprint cache', () => {
  beforeEach(() => clearSqlCaches());

  it('an application over the limit does not lose its hot statement', () => {
    // The old cache cleared wholesale at the ceiling, so an application
    // sitting just over it re-scanned everything — including the query it runs
    // a thousand times a second — until the cache filled again.
    const hot = 'SELECT * FROM orders WHERE id = 1';
    const expected = fingerprintSql(hot);

    for (let i = 0; i < 6_000; i++) {
      fingerprintSql(`SELECT * FROM t WHERE id = ${i}`);
      if (i % 100 === 0) fingerprintSql(hot);
    }

    expect(fingerprintSql(hot)).toBe(expected);
  });
});

describe('closing a runtime', () => {
  it('flushes before closing, and only once', async () => {
    const calls: string[] = [];
    const transport: Transport = {
      name: 'test',
      send: () => undefined,
      flush: async () => {
        calls.push('flush');
      },
      close: async () => {
        calls.push('close');
      },
    };

    const reqray = createReqray({ transport, panel: false });
    await reqray.close();
    await reqray.close();

    // Flush first: closing gracefully is for the sake of the last batch, and
    // a transport that buffers has nowhere to put it afterwards.
    expect(calls).toEqual(['flush', 'close']);
  });

  it('a collector that is already gone does not fail the shutdown', async () => {
    const transport: Transport = {
      name: 'test',
      send: () => undefined,
      flush: () => Promise.reject(new Error('connection refused')),
    };

    await expect(createReqray({ transport, panel: false }).close()).resolves.toBeUndefined();
  });

  it('stops the host monitor it started', async () => {
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const reqray = createReqray({ panel: false, hostMetrics: true });
    await reqray.close();

    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});
