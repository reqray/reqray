import { RequestScope, record, resolveCallsite, resolveOptions } from '@reqray/core';
import { resetLearnedCallsites } from '@reqray/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
  resetLearnedCallsites();
});

const dev = resolveOptions({ mode: 'development' });

const makeScope = (options = dev) =>
  new RequestScope({ id: 'r1', method: 'GET', path: '/orders', options, startTime: 1_000 });

const dbSpan = (sql: string, duration: number, startTime: number) =>
  ({ kind: 'db', sql, fingerprint: sql, duration, startTime }) as const;

describe('RequestScope', () => {
  it('numbers spans from one and measures offset from the request start', () => {
    const scope = makeScope();
    const span = scope.addSpan(dbSpan('SELECT 1', 5, 1_010));

    expect(span).toMatchObject({ id: 1, parentId: null, startedAt: 10, duration: 5 });
  });

  it('without an explicit start derives it as "now minus duration"', () => {
    const scope = new RequestScope({
      id: 'r2',
      method: 'GET',
      path: '/',
      options: dev,
      startTime: performance.now(),
    });
    const span = scope.addSpan({
      kind: 'db',
      sql: 'SELECT 1',
      fingerprint: 'SELECT 1',
      duration: 3,
    });

    expect(span?.startedAt).toBeGreaterThanOrEqual(-3);
    expect(span?.startedAt).toBeLessThan(50);
  });

  it('nests spans under the open parent', () => {
    const scope = makeScope();
    const handler = scope.openSpan('handler', 'orders.list');
    const child = scope.addSpan(dbSpan('SELECT 1', 1, 1_001));
    scope.closeSpan(handler);

    expect(child?.parentId).toBe(handler);
    expect(scope.spans.find((s) => s.id === handler)).toMatchObject({
      kind: 'handler',
      parentId: null,
    });
  });

  it('closes everything left open', () => {
    const scope = makeScope();
    scope.openSpan('middleware', 'cors');
    scope.openSpan('handler', 'orders.list');
    scope.closeAllSpans();

    expect(scope.spans).toHaveLength(2);
    expect(scope.currentSpanId).toBeNull();
  });

  it('double close and an unknown id are ignored', () => {
    const scope = makeScope();
    const id = scope.openSpan('handler', 'h');

    expect(scope.closeSpan(id)).not.toBeNull();
    expect(scope.closeSpan(id)).toBeNull();
    expect(scope.closeSpan(999)).toBeNull();
    expect(scope.spans).toHaveLength(1);
  });

  it('returns spans in start order, not completion order', () => {
    const scope = makeScope();
    scope.addSpan(dbSpan('B', 1, 1_020));
    scope.addSpan(dbSpan('A', 1, 1_005));

    expect(scope.orderedSpans().map((s) => (s.kind === 'db' ? s.sql : ''))).toEqual(['A', 'B']);
  });

  it('does not grow past maxSpansPerRequest', () => {
    const scope = makeScope(resolveOptions({ mode: 'development', maxSpansPerRequest: 3 }));
    for (let i = 0; i < 10; i++) scope.addSpan(dbSpan(`SELECT ${i}`, 1, 1_000 + i));

    expect(scope.spans).toHaveLength(3);
    expect(scope.droppedSpans).toBe(7);
  });
});

/** Simulates a captured stack: the budget is spent by whoever actually captured it. */
function learn(fingerprint: string): void {
  resolveCallsite(
    makeScope(resolveOptions({ mode: 'production', enabled: true, stack: { projectRoot: '/' } })),
    fingerprint,
  );
}

describe('stack capture policy', () => {
  it('always captures in development', () => {
    const scope = makeScope();
    for (let i = 0; i < 100; i++) {
      expect(scope.shouldCaptureStack('SELECT ?')).toBe(true);
    }
  });

  it('in production the budget is per process, not per request', () => {
    // A request usually makes several database calls, so a per-request count
    // would mean capturing a stack for almost every one of them — measured
    // at roughly a third of the application throughput.
    const options = resolveOptions({ mode: 'production', enabled: true });
    const first = makeScope(options);

    expect(first.shouldCaptureStack('SELECT ?')).toBe(true);
    learn('SELECT ?');
    learn('SELECT ?');
    learn('SELECT ?');

    expect(first.shouldCaptureStack('SELECT ?')).toBe(false);
    // A new request does not reset the budget: the fingerprint origin is already known.
    expect(makeScope(options).shouldCaptureStack('SELECT ?')).toBe(false);
  });

  it('counts fingerprints independently of each other', () => {
    const scope = makeScope(
      resolveOptions({ mode: 'production', enabled: true, stack: { maxPerFingerprint: 1 } }),
    );

    expect(scope.shouldCaptureStack('SELECT a')).toBe(true);
    learn('SELECT a');
    expect(scope.shouldCaptureStack('SELECT a')).toBe(false);
    expect(scope.shouldCaptureStack('SELECT b')).toBe(true);
  });
});

describe('record', () => {
  it('does nothing and does not throw without a scope', () => {
    expect(record(undefined, dbSpan('SELECT 1', 1, 0))).toBeNull();
    expect(record(null, dbSpan('SELECT 1', 1, 0))).toBeNull();
  });

  it('swallows an internal error — the request matters more than the span', () => {
    const broken = {
      addSpan() {
        throw new Error('everything broke inside');
      },
    } as unknown as RequestScope;

    expect(() => record(broken, dbSpan('SELECT 1', 1, 0))).not.toThrow();
    expect(record(broken, dbSpan('SELECT 1', 1, 0))).toBeNull();
  });

  it('writes the span into the given scope', () => {
    const scope = makeScope();
    record(scope, dbSpan('SELECT 1', 2, 1_001));

    expect(scope.spans).toHaveLength(1);
  });

  it('cannot see the panel’s settings from inside a request', () => {
    // Not a runtime assertion — a compile-time one. The scope carries
    // `RecordingOptions`, so an instrumentation wrapper cannot reach the panel
    // gate (a closure somebody wrote to authenticate people) or the retention
    // policy's file handles. If that boundary is ever widened back, the
    // expected error stops happening and TypeScript fails this line for having
    // an unused `@ts-expect-error`.
    const scope = makeScope();

    // @ts-expect-error the recording path has no business reading the panel
    scope.options.panel;
    // @ts-expect-error nor the retention policy
    scope.options.retention;

    expect(scope.options.stack).toBeDefined();
  });
});
