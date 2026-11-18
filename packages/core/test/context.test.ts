import { setTimeout as delay } from 'node:timers/promises';
import { current, RequestScope, resolveOptions, runInScope, runOutsideScope } from '@reqray/core';
import { describe, expect, it } from 'vitest';

const options = resolveOptions({ mode: 'development' });

const makeScope = (id: string) => new RequestScope({ id, method: 'GET', path: `/${id}`, options });

describe('request context', () => {
  it('no scope outside a request — and that is not an error', () => {
    expect(current()).toBeUndefined();
  });

  it('is visible inside a synchronous call', () => {
    const scope = makeScope('a');
    runInScope(scope, () => {
      expect(current()).toBe(scope);
    });
    expect(current()).toBeUndefined();
  });

  it('flows through await and timers', async () => {
    const scope = makeScope('b');
    await runInScope(scope, async () => {
      expect(current()).toBe(scope);
      await delay(1);
      expect(current()).toBe(scope);
      await Promise.resolve();
      expect(current()).toBe(scope);
    });
  });

  it('flows into callbacks created inside the scope', async () => {
    const scope = makeScope('c');
    const seen = await runInScope(
      scope,
      () =>
        new Promise<RequestScope | undefined>((resolve) => {
          setImmediate(() => resolve(current()));
        }),
    );
    expect(seen).toBe(scope);
  });

  it('does not mix parallel requests', async () => {
    const first = makeScope('first');
    const second = makeScope('second');

    const [a, b] = await Promise.all([
      runInScope(first, async () => {
        await delay(5);
        return current()?.id;
      }),
      runInScope(second, async () => {
        await delay(1);
        return current()?.id;
      }),
    ]);

    expect(a).toBe('first');
    expect(b).toBe('second');
  });

  it('a nested scope shadows the outer one and restores it', () => {
    const outer = makeScope('outer');
    const inner = makeScope('inner');

    runInScope(outer, () => {
      runInScope(inner, () => {
        expect(current()).toBe(inner);
      });
      expect(current()).toBe(outer);
    });
  });

  it('runOutsideScope hides the scope from background work', () => {
    const scope = makeScope('d');
    runInScope(scope, () => {
      runOutsideScope(() => {
        expect(current()).toBeUndefined();
      });
      expect(current()).toBe(scope);
    });
  });

  it('an exception from the handler passes through unchanged', () => {
    const scope = makeScope('e');
    const boom = new Error('boom');

    expect(() =>
      runInScope(scope, () => {
        throw boom;
      }),
    ).toThrow(boom);
    expect(current()).toBeUndefined();
  });
});
