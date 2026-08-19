/**
 * Tests for the sequential-HTTP detector.
 *
 * Two groups, both mandatory. The "does not find" group matters more than the
 * first one and must not be smaller: a false positive is worse than a miss —
 * and for this detector doubly so, because a data dependency between calls is
 * invisible from timing.
 */

import { type SequentialHttpOptions, sequentialHttp } from '@loupe/core';
import { describe, expect, it } from 'vitest';
import { scenario } from '../fixtures/spans.js';

const options: SequentialHttpOptions = sequentialHttp.defaultOptions;

const run = (
  scope: Parameters<typeof sequentialHttp.run>[0],
  overrides?: Partial<SequentialHttpOptions>,
) => sequentialHttp.run(scope, { ...options, ...overrides });

const user = (id: number) => `https://api.example.com/users/${id}`;
const LINE = 'src/services/enrich.ts:42';

describe('finds', () => {
  it('the canonical loop: one call shape over a list of ids', () => {
    const scope = scenario()
      .callLoop(4, (i) => ({ url: user(i + 1), duration: 25, callsite: LINE }))
      .done();

    const [finding, ...rest] = run(scope);

    expect(rest).toHaveLength(0);
    expect(finding).toMatchObject({
      detector: 'sequential_http',
      title: '4 HTTP calls ran sequentially',
      callsite: { relative: 'src/services/enrich.ts', line: 42 },
    });
    expect(finding?.evidence).toMatchObject({
      kind: 'sequential_http',
      repeats: 4,
      fingerprint: 'GET api.example.com/users/:id',
    });
  });

  it('costMs is the saving from going parallel, not the total time', () => {
    // 4 calls: 25 + 25 + 25 + 40. In parallel the run costs its slowest call,
    // so the honest saving is 75.
    const scope = scenario()
      .callLoop(3, (i) => ({ url: user(i), duration: 25, callsite: LINE }))
      .call({ url: user(9), duration: 40, callsite: LINE })
      .done();

    const [finding] = run(scope);
    expect(finding?.costMs).toBeCloseTo(75, 5);
  });

  it('query string variations collapse into one shape', () => {
    const scope = scenario()
      .callLoop(3, (i) => ({
        url: `https://api.example.com/search?q=term-${i}&page=${i}`,
        duration: 30,
        callsite: LINE,
      }))
      .done();

    const [finding] = run(scope);
    expect(finding?.evidence).toMatchObject({ fingerprint: 'GET api.example.com/search' });
  });

  it('exactly at the threshold — finds', () => {
    const scope = scenario()
      .callLoop(options.threshold, (i) => ({ url: user(i), duration: 25, callsite: LINE }))
      .done();

    expect(run(scope)).toHaveLength(1);
  });
});

describe('does NOT find', () => {
  it('Promise.all: the calls are already parallel', () => {
    const scope = scenario()
      .callParallel(6, (i) => ({ url: user(i), duration: 25, callsite: LINE }))
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('different URLs in a row: a data dependency is invisible', () => {
    const scope = scenario()
      .call({ url: 'https://auth.example.com/token', duration: 30, callsite: LINE })
      .call({ url: 'https://api.example.com/profile', duration: 30, callsite: LINE })
      .call({ url: 'https://api.example.com/settings/general', duration: 30, callsite: LINE })
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('one shape from different code places is a coincidence, not a loop', () => {
    const scope = scenario()
      .call({ url: user(1), duration: 25, callsite: 'src/a.ts:10' })
      .call({ url: user(2), duration: 25, callsite: 'src/b.ts:20' })
      .call({ url: user(3), duration: 25, callsite: 'src/a.ts:10' })
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('without a callsite the finding is useless and not created', () => {
    const scope = scenario()
      .callLoop(4, (i) => ({ url: user(i), duration: 25, callsite: null }))
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('one below the threshold', () => {
    const scope = scenario()
      .callLoop(options.threshold - 1, (i) => ({ url: user(i), duration: 25, callsite: LINE }))
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('saving cheaper than minWastedMs', () => {
    const scope = scenario()
      .callLoop(3, (i) => ({ url: user(i), duration: 10, callsite: LINE }))
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('retries after 5xx and network errors are not a loop', () => {
    const scope = scenario()
      .call({ url: user(1), status: 503, duration: 40, callsite: LINE })
      .call({ url: user(1), failed: true, status: null, duration: 40, callsite: LINE })
      .call({ url: user(1), status: 429, duration: 40, callsite: LINE })
      .call({ url: user(1), duration: 40, callsite: LINE })
      .done();

    expect(run(scope)).toHaveLength(0);
  });

  it('polling with pauses breaks into short runs', () => {
    const scope = scenario()
      .call({ url: 'https://api.example.com/jobs/42', duration: 15, callsite: LINE })
      .pause(500)
      .call({ url: 'https://api.example.com/jobs/42', duration: 15, callsite: LINE })
      .pause(500)
      .call({ url: 'https://api.example.com/jobs/42', duration: 15, callsite: LINE })
      .done();

    expect(run(scope)).toHaveLength(0);
  });
});
