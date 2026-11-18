import { type CacheSpan, RequestScope, resolveOptions, runInScope } from '@reqray/core';
import { instrumentIoredis } from '@reqray/instrumentation-ioredis';
import { describe, expect, it } from 'vitest';
import { createFakeIoredis, FakeCommand, type FakeRunner } from './fixtures/fake-ioredis.js';

const options = resolveOptions({ mode: 'development' });

function makeScope(): RequestScope {
  return new RequestScope({ id: 'r1', method: 'GET', path: '/orders', options });
}

function patched(runner?: FakeRunner) {
  const ioredis = createFakeIoredis(runner);
  const instrumentation = instrumentIoredis();
  instrumentation.apply(ioredis);
  return { ioredis, instrumentation, redis: new ioredis() };
}

const cacheSpans = (scope: RequestScope): CacheSpan[] =>
  scope.spans.filter((span): span is CacheSpan => span.kind === 'cache');

describe('ioredis instrumentation', () => {
  it('records a read with its command, key and hit', async () => {
    const { redis } = patched(() => Buffer.from('{"id":1}'));
    const scope = makeScope();

    await runInScope(scope, () => redis.get('user:1'));

    const [span] = cacheSpans(scope);
    expect(span).toMatchObject({
      kind: 'cache',
      operation: 'get',
      command: 'GET',
      key: 'user:1',
      hit: true,
      error: null,
    });
    expect(span?.duration).toBeGreaterThanOrEqual(0);
  });

  it('records a miss as a miss', async () => {
    const { redis } = patched(() => null);
    const scope = makeScope();

    await runInScope(scope, () => redis.get('user:404'));

    expect(cacheSpans(scope)[0]?.hit).toBe(false);
  });

  it('records the key of a write and never the value', async () => {
    const { redis } = patched();
    const scope = makeScope();

    await runInScope(scope, () => redis.set('session:9', 'eyJ.a-real-token.9'));

    const [span] = cacheSpans(scope);
    expect(span).toMatchObject({ operation: 'set', command: 'SET', key: 'session:9' });
    expect(JSON.stringify(span)).not.toContain('a-real-token');
  });

  it('ties the span to the line that sent the command', async () => {
    const { redis } = patched();
    const scope = makeScope();

    // Sent from here rather than through the double's own helpers: those
    // helpers are project files, while the real driver's frames sit in
    // node_modules and are skipped. The integration test covers that path.
    await runInScope(scope, () => redis.sendCommand(new FakeCommand('get', ['user:1'])));

    expect(cacheSpans(scope)[0]?.callsite?.relative).toContain('ioredis.test.ts');
  });

  it('keeps a command it does not know in the waterfall, without its arguments', async () => {
    const { redis } = patched(() => 1);
    const scope = makeScope();

    await runInScope(scope, () => redis.call('auth', 'admin', 'hunter2'));

    const [span] = cacheSpans(scope);
    expect(span).toMatchObject({ operation: 'other', command: 'AUTH', key: '' });
    expect(JSON.stringify(span)).not.toContain('hunter2');
  });
});

describe('transparency', () => {
  it('hands back exactly what the driver returned', async () => {
    const reply = Buffer.from('value');
    const { redis } = patched(() => reply);
    const scope = makeScope();

    await expect(runInScope(scope, () => redis.get('user:1'))).resolves.toBe(reply);
  });

  it('passes the driver error through unchanged and marks the span', async () => {
    const failure = new Error('WRONGTYPE Operation against a key');
    const { redis } = patched(() => {
      throw failure;
    });
    const scope = makeScope();

    await expect(runInScope(scope, () => redis.get('user:1'))).rejects.toBe(failure);

    const [span] = cacheSpans(scope);
    expect(span?.error?.message).toBe('WRONGTYPE Operation against a key');
    // A failed read is not a miss: nothing was looked up.
    expect(span?.hit).toBeNull();
  });

  it('records nothing outside a request, and still works', async () => {
    const { redis, ioredis } = patched(() => Buffer.from('v'));

    await expect(redis.get('user:1')).resolves.toEqual(Buffer.from('v'));
    expect(ioredis.calls).toHaveLength(1);
  });

  it('leaves a command object it does not understand alone', async () => {
    const { redis } = patched();
    const scope = makeScope();
    // A command with no name is not ours to interpret.
    const nameless = new FakeCommand('', ['x']);
    Object.defineProperty(nameless, 'name', { value: undefined });

    await runInScope(scope, () => redis.sendCommand(nameless));

    expect(cacheSpans(scope)).toHaveLength(0);
  });
});

describe('patching', () => {
  it('applying twice does not record twice', async () => {
    const { ioredis, instrumentation, redis } = patched();
    instrumentation.apply(ioredis);
    const scope = makeScope();

    await runInScope(scope, () => redis.get('user:1'));

    expect(cacheSpans(scope)).toHaveLength(1);
  });

  it('a command sent twice — an offline queue flushed — is one span', async () => {
    const { redis } = patched();
    const scope = makeScope();

    await runInScope(scope, () => {
      const command = new FakeCommand('get', ['user:1']);
      void redis.sendCommand(command);
      return redis.sendCommand(command);
    });

    expect(cacheSpans(scope)).toHaveLength(1);
  });

  it('covers a cluster client too', async () => {
    const { ioredis } = patched();
    const scope = makeScope();
    const cluster = new ioredis.Cluster();

    await runInScope(scope, () => cluster.get('user:1'));

    expect(cacheSpans(scope)).toHaveLength(1);
  });

  it('after unapply the driver is fully itself again', async () => {
    const { ioredis, instrumentation, redis } = patched();
    instrumentation.unapply?.(ioredis);
    const scope = makeScope();

    await expect(runInScope(scope, () => redis.get('user:1'))).resolves.toBe('OK');
    expect(cacheSpans(scope)).toHaveLength(0);
  });

  it('survives a module shape it has never seen', () => {
    const instrumentation = instrumentIoredis();

    expect(() => instrumentation.apply(undefined)).not.toThrow();
    expect(() => instrumentation.apply({})).not.toThrow();
    expect(() => instrumentation.unapply?.({})).not.toThrow();
  });
});
