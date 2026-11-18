/**
 * The plumbing shared by every instrumentation.
 *
 * One place for each rule to be broken, and one place for it to be caught.
 */

import {
  guarded,
  isPatched,
  patchMethod,
  setLogSink,
  settle,
  settleCallback,
  unpatchMethod,
} from '@reqray/core';
import { resetWarnings } from '@reqray/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('patching a method', () => {
  it('replaces it and puts it back', () => {
    const target = { greet: () => 'original' };
    const original = target.greet;

    patchMethod(target, 'greet', (fn) => () => `wrapped ${(fn as () => string)()}`);
    expect(target.greet()).toBe('wrapped original');

    unpatchMethod(target, 'greet');
    expect(target.greet).toBe(original);
    expect(target.greet()).toBe('original');
  });

  it('does not stack wrappers when the same module arrives twice', () => {
    // One module can reach the loader hook by two resolution paths. Two
    // wrappers would mean two spans for one query.
    const target = { greet: () => 'x' };
    const wrap = (fn: unknown) => () => `w${(fn as () => string)()}`;

    expect(patchMethod(target, 'greet', wrap)).toBe(true);
    expect(patchMethod(target, 'greet', wrap)).toBe(false);
    expect(target.greet()).toBe('wx');
  });

  it('keeps two patches on one object apart', () => {
    // This is why the marker is keyed by method name. `Pool.prototype` carries
    // both `query` and `connect`; a shared marker silently skipped whichever
    // ran second, and the symptom — a pool queue that is never measured —
    // points nowhere near the cause.
    const pool = { query: () => 'q', connect: () => 'c' };

    patchMethod(pool, 'query', (fn) => () => `Q${(fn as () => string)()}`);
    patchMethod(pool, 'connect', (fn) => () => `C${(fn as () => string)()}`);

    expect(pool.query()).toBe('Qq');
    expect(pool.connect()).toBe('Cc');
    expect(isPatched(pool, 'query')).toBe(true);
    expect(isPatched(pool, 'connect')).toBe(true);
  });

  it('leaves alone what it cannot patch', () => {
    expect(patchMethod(null, 'query', (fn) => fn)).toBe(false);
    expect(patchMethod({}, 'query', (fn) => fn)).toBe(false);
    expect(unpatchMethod({}, 'query')).toBe(false);
  });
});

describe('settling a driver call', () => {
  it('reports a resolved value and hands it on unchanged', async () => {
    const seen: unknown[] = [];
    const value = await settle(Promise.resolve('rows'), (v) => seen.push(v));
    expect(value).toBe('rows');
    expect(seen).toEqual(['rows']);
  });

  it('rethrows the driver’s own error, not a copy of it', async () => {
    const failure = new Error('connection terminated');
    let recorded: unknown;

    await expect(
      settle(Promise.reject(failure), (_value, error) => {
        recorded = error;
      }),
    ).rejects.toBe(failure);
    expect(recorded).toBe(failure);
  });

  it('says nothing about something that has not finished', () => {
    // A submittable — a cursor, a stream — completes on its own later.
    // Recording it here would put a zero-duration span in the waterfall.
    const finish = vi.fn();
    const submittable = { submit: () => undefined };

    expect(settle(submittable, finish)).toBe(submittable);
    expect(finish).not.toHaveBeenCalled();
  });

  it('records before the caller’s callback runs, and keeps its arguments', () => {
    const order: string[] = [];
    const wrapped = settleCallback(
      function (this: { name: string }, ...args: never[]) {
        const [error, value] = args as unknown as [unknown, unknown];
        order.push(`callback ${this.name} ${String(error)} ${String(value)}`);
        return 'returned';
      } as (...args: never[]) => unknown,
      () => order.push('recorded'),
    );

    const result = wrapped.call({ name: 'host' }, ...([null, 'rows'] as unknown as never[]));

    expect(order).toEqual(['recorded', 'callback host null rows']);
    expect(result).toBe('returned');
  });
});

describe('guarding instrumentation work', () => {
  beforeEach(() => resetWarnings());

  it('swallows the failure and names the instrumentation once', () => {
    const lines: string[] = [];
    setLogSink({
      info: () => undefined,
      warn: (message) => {
        lines.push(message);
      },
    });

    for (let i = 0; i < 3; i++) {
      guarded('pg', () => {
        throw new Error('prototype is frozen');
      });
    }

    // Once, not per call: a broken instrumentation must not also be a broken
    // log. And it never reached the caller.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('pg: instrumentation disabled');
    expect(lines[0]).toContain('prototype is frozen');
    setLogSink(null);
  });
});
