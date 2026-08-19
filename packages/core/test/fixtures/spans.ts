/**
 * Request scenario builder for the detector tests.
 *
 * Hand-written fixtures of this kind quickly become unreadable: every span
 * needs its own start, duration and callsite, while all that matters is the
 * shape of the scenario — loop, `Promise.all`, gap. The builder keeps the time
 * cursor itself, so a test describes shape instead of arithmetic.
 */

import type { Callsite } from '@loupe/core';
import { fingerprintSql, type LoupeOptions, RequestScope, resolveOptions } from '@loupe/core';

const PROJECT_ROOT = '/srv/app';

export interface QuerySpec {
  readonly sql: string;
  /** Duration in ms. Defaults to 1. */
  readonly duration?: number;
  /** Code location as `src/orders.ts:118`. `null` means no stack was captured. */
  readonly callsite?: string | null;
  /** Who recorded the span: `pg`, `prisma`. */
  readonly source?: string | null;
  /** Explicit start, ms from the request start. Defaults to right after the previous one. */
  readonly at?: number;
}

function parseCallsite(value: string | null | undefined): Callsite | null {
  if (!value) return null;
  const [relative, line] = value.split(':');
  if (!relative) return null;
  return {
    file: `${PROJECT_ROOT}/${relative}`,
    relative,
    line: Number(line ?? 1),
    column: 1,
  };
}

type SpecFactory = QuerySpec | ((index: number) => QuerySpec);

function specAt(factory: SpecFactory, index: number): QuerySpec {
  return typeof factory === 'function' ? factory(index) : factory;
}

class ScopeBuilder {
  readonly #scope: RequestScope;
  #cursor = 0;

  constructor(options?: LoupeOptions) {
    this.#scope = new RequestScope({
      id: 'test',
      method: 'GET',
      path: '/api/orders',
      options: resolveOptions({
        mode: 'development',
        stack: { projectRoot: PROJECT_ROOT },
        ...options,
      }),
      startTime: 0,
    });
  }

  #add(spec: QuerySpec, at: number): void {
    const duration = spec.duration ?? 1;
    this.#scope.addSpan({
      kind: 'db',
      sql: spec.sql,
      fingerprint: fingerprintSql(spec.sql),
      duration,
      startTime: at,
      callsite: parseCallsite(spec.callsite),
      source: spec.source ?? null,
    });
  }

  /** A single query starting right after the previous one. */
  query(spec: QuerySpec): this {
    const at = spec.at ?? this.#cursor;
    this.#add(spec, at);
    this.#cursor = at + (spec.duration ?? 1);
    return this;
  }

  /** A run of identical queries one after another — the canonical N+1. */
  loop(count: number, factory: SpecFactory): this {
    for (let i = 0; i < count; i++) this.query(specAt(factory, i));
    return this;
  }

  /** Queries started at the same time — an already optimized `Promise.all`. */
  parallel(count: number, factory: SpecFactory): this {
    const start = this.#cursor;
    let longest = 0;
    for (let i = 0; i < count; i++) {
      const spec = specAt(factory, i);
      const duration = spec.duration ?? 1;
      this.#add(spec, start);
      if (duration > longest) longest = duration;
    }
    this.#cursor = start + longest;
    return this;
  }

  /**
   * Batches of `size` parallel queries running one after another — partially
   * optimized code.
   */
  batches(count: number, size: number, factory: SpecFactory): this {
    for (let i = 0; i < count; i += size) {
      const remaining = Math.min(size, count - i);
      this.parallel(remaining, (j) => specAt(factory, i + j));
    }
    return this;
  }

  /** A long external call that breaks a run of queries apart. */
  externalCall(durationMs: number, url = 'https://api.stripe.com/v1/charges'): this {
    this.#scope.addSpan({
      kind: 'http',
      method: 'GET',
      url,
      duration: durationMs,
      startTime: this.#cursor,
    });
    this.#cursor += durationMs;
    return this;
  }

  #addCall(spec: CallSpec, at: number): void {
    this.#scope.addSpan({
      kind: 'http',
      method: spec.method ?? 'GET',
      url: spec.url,
      duration: spec.duration ?? 20,
      startTime: at,
      statusCode: spec.status === undefined ? 200 : spec.status,
      callsite: parseCallsite(spec.callsite),
      error: spec.failed ? { name: 'Error', message: 'connection reset', stack: null } : null,
    });
  }

  /** A single outgoing HTTP call starting right after the previous one. */
  call(spec: CallSpec): this {
    const at = spec.at ?? this.#cursor;
    this.#addCall(spec, at);
    this.#cursor = at + (spec.duration ?? 20);
    return this;
  }

  /** A run of calls one after another — the sequential-HTTP shape. */
  callLoop(count: number, factory: CallFactory): this {
    for (let i = 0; i < count; i++) this.call(typeof factory === 'function' ? factory(i) : factory);
    return this;
  }

  /** Calls started at the same time — an already optimized `Promise.all`. */
  callParallel(count: number, factory: CallFactory): this {
    const start = this.#cursor;
    let longest = 0;
    for (let i = 0; i < count; i++) {
      const spec = typeof factory === 'function' ? factory(i) : factory;
      const duration = spec.duration ?? 20;
      this.#addCall(spec, start);
      if (duration > longest) longest = duration;
    }
    this.#cursor = start + longest;
    return this;
  }

  /**
   * A cache operation.
   *
   * There is no cache instrumentation yet, so these spans exist only in
   * fixtures — the detector that reads them has to be ready for the day one
   * lands, and this is how it is held to that.
   */
  cache(spec: {
    key: string;
    operation?: 'get' | 'set' | 'del';
    duration?: number;
    hit?: boolean;
    callsite?: string | null;
  }): this {
    const duration = spec.duration ?? 0.3;
    this.#scope.addSpan({
      kind: 'cache',
      operation: spec.operation ?? 'get',
      key: spec.key,
      hit: spec.hit ?? true,
      duration,
      startTime: this.#cursor,
      callsite: parseCallsite(spec.callsite),
    });
    this.#cursor += duration;
    return this;
  }

  /** Silence between spans — polling pauses, unrelated compute. */
  pause(durationMs: number): this {
    this.#cursor += durationMs;
    return this;
  }

  done(): RequestScope {
    return this.#scope;
  }
}

export interface CallSpec {
  readonly url: string;
  readonly method?: string;
  /** HTTP status. Defaults to 200; `null` — the response never came. */
  readonly status?: number | null;
  /** Duration in ms. Defaults to 20. */
  readonly duration?: number;
  readonly callsite?: string | null;
  /** Transport-level failure. */
  readonly failed?: boolean;
  readonly at?: number;
}

type CallFactory = CallSpec | ((index: number) => CallSpec);

export function scenario(options?: LoupeOptions): ScopeBuilder {
  return new ScopeBuilder(options);
}
