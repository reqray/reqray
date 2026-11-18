/**
 * Integration test against a real Redis and the real driver.
 *
 * The double in `ioredis.test.ts` covers the wrapper contract; this covers what
 * a double cannot: that spans appear for the driver's own call shapes —
 * promise, callback, pipeline — that the callsite points at the application
 * rather than into `node_modules`, and that a real server error arrives
 * unchanged.
 *
 * Skipped, loudly, when Docker is missing.
 */

import { execFileSync } from 'node:child_process';
import {
  type CacheSpan,
  RequestScope,
  resolveOptions,
  runDetectors,
  runInScope,
} from '@reqray/core';
import { instrumentIoredis } from '@reqray/instrumentation-ioredis';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
if (!hasDocker) {
  console.warn('reqray: ioredis integration suite skipped — Docker is unavailable.');
}

const options = resolveOptions({ mode: 'development' });
const cacheSpans = (scope: RequestScope): CacheSpan[] =>
  scope.spans.filter((span): span is CacheSpan => span.kind === 'cache');

function makeScope(id = 'r1'): RequestScope {
  return new RequestScope({ id, method: 'GET', path: '/profile', options });
}

describe.skipIf(!hasDocker)('ioredis against a real Redis', () => {
  let container: StartedRedisContainer;
  let redis: Redis;

  beforeAll(async () => {
    container = await new RedisContainer('redis:8-alpine').start();

    // Patch the module before any client is created — exactly what the loader
    // hook does.
    const ioredis = await import('ioredis');
    instrumentIoredis().apply(ioredis.default ?? ioredis);

    redis = new Redis(container.getConnectionUrl());
    await redis.set('user:1', '{"email":"ada@example.com"}');
    await redis.hset('user:1:profile', 'email', 'ada@example.com', 'plan', 'pro');
  }, 180_000);

  afterAll(async () => {
    await redis?.quit();
    await container?.stop();
  }, 60_000);

  it('records a read with a plausible duration', async () => {
    const scope = makeScope();

    const value = await runInScope(scope, () => redis.get('user:1'));

    expect(value).toBe('{"email":"ada@example.com"}');
    const [span] = cacheSpans(scope);
    expect(span).toMatchObject({ operation: 'get', command: 'GET', key: 'user:1', hit: true });
    expect(span?.duration).toBeGreaterThan(0);
    expect(span?.duration).toBeLessThan(1000);
  });

  it('points at the application line, not into the driver', async () => {
    const scope = makeScope();

    await runInScope(scope, () => redis.get('user:1'));

    const callsite = cacheSpans(scope)[0]?.callsite;
    expect(callsite?.relative).toContain('ioredis.integration.test.ts');
    expect(callsite?.file).not.toContain('node_modules');
  });

  it('separates two reads of one hash by the field they read', async () => {
    const scope = makeScope();

    await runInScope(scope, async () => {
      await redis.hget('user:1:profile', 'email');
      await redis.hget('user:1:profile', 'plan');
    });

    expect(cacheSpans(scope).map((span) => span.key)).toEqual([
      'user:1:profile email',
      'user:1:profile plan',
    ]);
  });

  it('finds the duplicate read the panel exists to show', async () => {
    const scope = makeScope();

    await runInScope(scope, async () => {
      await redis.get('user:1');
      await redis.get('user:1');
    });

    const findings = runDetectors(scope, options, {
      durationMs: 20,
      status: 200,
      bytesOut: null,
      contentType: null,
    });
    const duplicate = findings.find((finding) => finding.detector === 'dup_cache');

    expect(duplicate?.evidence).toMatchObject({ kind: 'duplicate', fingerprint: 'GET user:1' });
    expect(duplicate?.callsite?.relative).toContain('ioredis.integration.test.ts');
  });

  it('records a miss without inventing a value', async () => {
    const scope = makeScope();

    const value = await runInScope(scope, () => redis.get('user:absent'));

    expect(value).toBeNull();
    expect(cacheSpans(scope)[0]?.hit).toBe(false);
  });

  it('supports the callback style the driver still offers', async () => {
    const scope = makeScope();

    const value = await runInScope(
      scope,
      () =>
        new Promise<string | null>((resolve, reject) => {
          redis.get('user:1', (error, reply) => (error ? reject(error) : resolve(reply ?? null)));
        }),
    );

    expect(value).toBe('{"email":"ada@example.com"}');
    expect(cacheSpans(scope)).toHaveLength(1);
  });

  it('records every command of a pipeline, once each', async () => {
    const scope = makeScope();

    const replies = await runInScope(scope, () =>
      redis.pipeline().get('user:1').get('user:absent').exec(),
    );

    expect(replies).toHaveLength(2);
    expect(cacheSpans(scope).map((span) => span.key)).toEqual(['user:1', 'user:absent']);
  });

  it('passes a server error through unchanged and marks the span', async () => {
    const scope = makeScope();

    // A hash read against a string key: the server refuses, the driver throws.
    await expect(runInScope(scope, () => redis.hget('user:1', 'email'))).rejects.toThrow(
      /WRONGTYPE/,
    );

    const [span] = cacheSpans(scope);
    expect(span?.error?.message).toMatch(/WRONGTYPE/);
    expect(span?.hit).toBeNull();
  });

  it('a command outside a request is not recorded and not disturbed', async () => {
    const scope = makeScope();

    await redis.get('user:1');

    expect(cacheSpans(scope)).toHaveLength(0);
  });
});
