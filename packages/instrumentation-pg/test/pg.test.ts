import { RequestScope, resolveOptions, runInScope } from '@reqray/core';
import { instrumentPg } from '@reqray/instrumentation-pg';
import { describe, expect, it } from 'vitest';
import { createFakePg, type FakeResult } from './fixtures/fake-pg.js';

const options = resolveOptions({ mode: 'development' });

function makeScope(): RequestScope {
  return new RequestScope({ id: 'r1', method: 'GET', path: '/orders', options });
}

function patched(runner?: Parameters<typeof createFakePg>[0]) {
  const pg = createFakePg(runner);
  const instrumentation = instrumentPg();
  instrumentation.apply(pg);
  return { pg, instrumentation, client: new pg.Client() };
}

const dbSpans = (scope: RequestScope) => scope.spans.filter((span) => span.kind === 'db');

describe('pg instrumentation', () => {
  it('records a span with a normalized fingerprint and row count', async () => {
    const { client } = patched(() => ({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }));
    const scope = makeScope();

    await runInScope(scope, () => client.query('SELECT * FROM orders WHERE user_id = $1', [8812]));

    const [span] = dbSpans(scope);
    expect(span).toMatchObject({
      kind: 'db',
      sql: 'SELECT * FROM orders WHERE user_id = $1',
      fingerprint: 'SELECT * FROM orders WHERE user_id = ?',
      rowCount: 2,
      source: 'pg',
      error: null,
    });
    expect(span?.duration).toBeGreaterThanOrEqual(0);
  });

  it('ties the span to a project code line', async () => {
    const { client } = patched();
    const scope = makeScope();

    await runInScope(scope, () => client.query('SELECT 1'));

    expect(dbSpans(scope)[0]?.callsite?.relative).toContain('pg.test.ts');
  });

  it('parameter values are not collected by default', async () => {
    const { client } = patched();
    const scope = makeScope();

    await runInScope(scope, () => client.query('SELECT * FROM t WHERE id = $1', [8812]));

    expect(dbSpans(scope)[0]?.values).toBeNull();
  });

  it('collectSqlValues: true collects values as strings and truncates long ones', async () => {
    const { client } = patched();
    const scope = new RequestScope({
      id: 'r-values',
      method: 'GET',
      path: '/orders',
      options: resolveOptions({ mode: 'development', collectSqlValues: true }),
    });

    await runInScope(scope, () =>
      client.query('SELECT * FROM t WHERE id = $1 AND tag = $2 AND meta = $3 AND pad = $4', [
        8812,
        null,
        { source: 'import' },
        'x'.repeat(500),
      ]),
    );

    const values = dbSpans(scope)[0]?.values;
    expect(values?.[0]).toBe('8812');
    expect(values?.[1]).toBe('NULL');
    expect(values?.[2]).toBe('{"source":"import"}');
    expect(values?.[3]?.length).toBeLessThan(250);
    expect(values?.[3]).toContain('…');
  });

  it('collectSqlValues sees values in the query({ text, values }) form too', async () => {
    const { client } = patched();
    const scope = new RequestScope({
      id: 'r-values-2',
      method: 'GET',
      path: '/orders',
      options: resolveOptions({ mode: 'development', collectSqlValues: true }),
    });

    await runInScope(scope, () =>
      client.query({ text: 'SELECT * FROM t WHERE id = $1', values: [17] }),
    );

    expect(dbSpans(scope)[0]?.values).toEqual(['17']);
  });

  it('understands the query({ text, values }) form', async () => {
    const { client } = patched();
    const scope = makeScope();

    await runInScope(scope, () =>
      client.query({ text: 'SELECT * FROM t WHERE id = $1', values: [1] }),
    );

    expect(dbSpans(scope)[0]?.fingerprint).toBe('SELECT * FROM t WHERE id = ?');
  });

  it('supports the callback style', async () => {
    const { client } = patched();
    const scope = makeScope();

    const result = await runInScope(
      scope,
      () =>
        new Promise<FakeResult>((resolve, reject) => {
          const returned = client.query('SELECT 1', (error: unknown, value: FakeResult) => {
            if (error) reject(error);
            else resolve(value);
          });
          // With a callback pg returns undefined — the wrapper preserves that.
          expect(returned).toBeUndefined();
        }),
    );

    expect(result.rowCount).toBe(1);
    expect(dbSpans(scope)).toHaveLength(1);
  });

  it('supports a callback together with values', async () => {
    const { pg, client } = patched();
    const scope = makeScope();

    await runInScope(
      scope,
      () =>
        new Promise<void>((resolve) => {
          client.query('SELECT $1::int', [7], () => resolve());
        }),
    );

    expect(pg.calls[0]?.values).toEqual([7]);
    expect(dbSpans(scope)).toHaveLength(1);
  });
});

describe('transparency', () => {
  it('the result matches the uninstrumented result', async () => {
    const runner = (sql: string) => ({ rows: [{ sql }], rowCount: 1 });

    const plain = createFakePg(runner);
    const { client: instrumented } = patched(runner);
    const scope = makeScope();

    const expected = await new plain.Client().query('SELECT * FROM t WHERE id = $1', [1]);
    const actual = await runInScope(scope, () =>
      instrumented.query('SELECT * FROM t WHERE id = $1', [1]),
    );

    expect(actual).toEqual(expected);
  });

  it('arguments reach the driver unchanged', async () => {
    const { pg, client } = patched();
    const scope = makeScope();

    await runInScope(scope, () => client.query('SELECT $1::int', [42]));

    expect(pg.calls).toEqual([{ sql: 'SELECT $1::int', values: [42] }]);
  });

  it('a driver exception reaches the caller unchanged', async () => {
    const failure = new Error('syntax error at or near "SELCT"');
    const { client } = patched(() => {
      throw failure;
    });
    const scope = makeScope();

    await expect(runInScope(scope, () => client.query('SELCT 1'))).rejects.toBe(failure);

    const [span] = dbSpans(scope);
    expect(span?.error).toMatchObject({ message: 'syntax error at or near "SELCT"' });
  });

  it('a callback-style error is not replaced either', async () => {
    const failure = new Error('connection terminated');
    const { client } = patched(() => {
      throw failure;
    });
    const scope = makeScope();

    const received = await runInScope(
      scope,
      () =>
        new Promise<unknown>((resolve) => {
          client.query('SELECT 1', (error: unknown) => resolve(error));
        }),
    );

    expect(received).toBe(failure);
    expect(dbSpans(scope)[0]?.error).not.toBeNull();
  });
});

describe('boundary behavior', () => {
  it('a call outside a request does not crash and records nothing', async () => {
    const { client } = patched();

    const result = await client.query('SELECT 1');

    expect(result.rowCount).toBe(1);
  });

  it('a repeated apply does not record the span twice', async () => {
    const pg = createFakePg();
    const instrumentation = instrumentPg();
    instrumentation.apply(pg);
    instrumentation.apply(pg);
    // Even a different instrumentation instance must not patch a second time.
    instrumentPg().apply(pg);

    const scope = makeScope();
    await runInScope(scope, () => new pg.Client().query('SELECT 1'));

    expect(dbSpans(scope)).toHaveLength(1);
  });

  it('finds the classes under `default`, where an ESM import of a CJS build puts them', async () => {
    // `import pg from 'pg'` with no ESM wrapper: the hook is handed a
    // namespace holding only `default`. Nothing used to be patched, while the
    // startup report said pg was instrumented.
    const pg = createFakePg();
    const instrumentation = instrumentPg();
    instrumentation.apply({ default: pg });

    const scope = makeScope();
    await runInScope(scope, () => new pg.Client().query('SELECT 1'));
    expect(dbSpans(scope)).toHaveLength(1);

    instrumentation.unapply?.({ default: pg });
  });

  it('after unapply the behavior is fully original', async () => {
    const pg = createFakePg();
    const original = pg.Client.prototype.query;
    const instrumentation = instrumentPg();

    instrumentation.apply(pg);
    expect(pg.Client.prototype.query).not.toBe(original);

    instrumentation.unapply?.(pg);
    expect(pg.Client.prototype.query).toBe(original);

    const scope = makeScope();
    await runInScope(scope, () => new pg.Client().query('SELECT 1'));
    expect(dbSpans(scope)).toHaveLength(0);
  });

  it('a repeated unapply is harmless', () => {
    const pg = createFakePg();
    const instrumentation = instrumentPg();
    instrumentation.apply(pg);

    expect(() => {
      instrumentation.unapply?.(pg);
      instrumentation.unapply?.(pg);
    }).not.toThrow();
  });

  it('survives exports without Client', () => {
    const instrumentation = instrumentPg();

    expect(() => instrumentation.apply({})).not.toThrow();
    expect(() => instrumentation.apply(undefined)).not.toThrow();
    expect(() => instrumentation.unapply?.({})).not.toThrow();
  });

  it('does not crash on exports where accessing native throws', () => {
    const pg = createFakePg();
    const hostile = {
      Client: pg.Client,
      get native(): never {
        throw new Error('pg-native is not installed');
      },
    };

    expect(() => instrumentPg().apply(hostile)).not.toThrow();
  });
});
