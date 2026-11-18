/**
 * Tests for the duplicate-work detectors.
 *
 * Two groups, and the "does NOT find" group is the important one: a duplicate
 * card that turns out to be two legitimate calls teaches people to ignore the
 * whole screen.
 */

import { duplicateCache, duplicateHttp } from '@reqray/core';
import { describe, expect, it } from 'vitest';
import { scenario } from '../fixtures/spans.js';

const FACTS = { durationMs: 200, status: 200, bytesOut: null, contentType: null };
const CHARGES = 'https://api.stripe.com/v1/charges?customer=cus_QxT1';

const runHttp = (scope: Parameters<typeof duplicateHttp.run>[0]) =>
  duplicateHttp.run(scope, duplicateHttp.defaultOptions, FACTS);
const runCache = (scope: Parameters<typeof duplicateCache.run>[0]) =>
  duplicateCache.run(scope, duplicateCache.defaultOptions, FACTS);

describe('duplicate HTTP calls — finds', () => {
  it('the same URL fetched twice in one request', () => {
    const scope = scenario()
      .call({ url: CHARGES, duration: 118, callsite: 'src/billing.ts:20' })
      .pause(40)
      .call({ url: CHARGES, duration: 96, callsite: 'src/receipt.ts:11' })
      .done();

    const [finding, ...rest] = runHttp(scope);

    expect(rest).toHaveLength(0);
    expect(finding).toMatchObject({
      detector: 'dup_http',
      severity: 'warn',
      title: '2 identical calls to the same URL',
    });
    // One call remains after the fix, and it is the dearest of the pair.
    expect(finding?.costMs).toBeCloseTo(96, 5);
    // The panel prints the finding's own callsite; the hint names the other
    // place the same call is made from, without repeating the first.
    expect(finding?.callsite?.relative).toBe('src/billing.ts');
    expect(finding?.hint).toContain('src/receipt.ts:11');
    expect(finding?.hint).not.toContain('src/billing.ts');
  });

  it('finds duplicates that ran in parallel too', () => {
    // Unlike an N+1, order is irrelevant: the second call is waste either way.
    const scope = scenario()
      .callParallel(2, { url: CHARGES, duration: 60, callsite: 'src/billing.ts:20' })
      .done();

    expect(runHttp(scope)).toHaveLength(1);
  });

  it('counts every repeat, not just the first pair', () => {
    const scope = scenario()
      .callLoop(4, { url: CHARGES, duration: 40, callsite: 'src/billing.ts:20' })
      .done();

    expect(runHttp(scope)[0]).toMatchObject({ title: '4 identical calls to the same URL' });
    expect(runHttp(scope)[0]?.costMs).toBeCloseTo(120, 5);
  });
});

describe('duplicate HTTP calls — does NOT find', () => {
  it('URLs that differ by a query parameter are different questions', () => {
    const scope = scenario()
      .call({ url: 'https://api.example.com/x?id=1', duration: 60 })
      .call({ url: 'https://api.example.com/x?id=2', duration: 60 })
      .done();

    expect(runHttp(scope)).toHaveLength(0);
  });

  it('two identical POSTs are two actions, not a duplicate read', () => {
    // "Hold the result" is wrong advice for a write; flagging it would invite
    // someone to drop the second one.
    const scope = scenario()
      .call({ url: CHARGES, method: 'POST', duration: 90 })
      .call({ url: CHARGES, method: 'POST', duration: 90 })
      .done();

    expect(runHttp(scope)).toHaveLength(0);
  });

  it('a retry after a failure is correct behaviour', () => {
    const scope = scenario()
      .call({ url: CHARGES, duration: 80, status: 503 })
      .call({ url: CHARGES, duration: 80 })
      .done();

    expect(runHttp(scope)).toHaveLength(0);
  });

  it('a retry after a network error is correct behaviour', () => {
    const scope = scenario()
      .call({ url: CHARGES, duration: 80, failed: true })
      .call({ url: CHARGES, duration: 80 })
      .done();

    expect(runHttp(scope)).toHaveLength(0);
  });

  it('a retry after rate limiting is correct behaviour', () => {
    const scope = scenario()
      .call({ url: CHARGES, duration: 80, status: 429 })
      .call({ url: CHARGES, duration: 80 })
      .done();

    expect(runHttp(scope)).toHaveLength(0);
  });

  it('duplicates too cheap to matter stay off the screen', () => {
    const scope = scenario()
      .call({ url: CHARGES, duration: 2 })
      .call({ url: CHARGES, duration: 2 })
      .done();

    expect(runHttp(scope)).toHaveLength(0);
  });

  it('one call is not a duplicate', () => {
    expect(runHttp(scenario().call({ url: CHARGES, duration: 200 }).done())).toHaveLength(0);
  });

  it('a request with no calls at all', () => {
    expect(runHttp(scenario().done())).toHaveLength(0);
  });
});

describe('duplicate cache reads', () => {
  const KEY = 'feature-flags:checkout-v3';

  it('finds the same key read twice', () => {
    const scope = scenario()
      .cache({ key: KEY, callsite: 'src/checkout.ts:14' })
      .cache({ key: 'user:8812' })
      .cache({ key: KEY, callsite: 'src/pricing.ts:31' })
      .done();

    const [finding, ...rest] = runCache(scope);

    expect(rest).toHaveLength(0);
    expect(finding).toMatchObject({
      detector: 'dup_cache',
      // A nudge, never an alarm: cache reads are cheap and this must not
      // outrank a real cost on the findings screen.
      severity: 'info',
      title: '2 reads of the same cache key',
    });
    expect(finding?.hint).toContain(KEY);
  });

  it('does not count a write as a repeated read', () => {
    const scope = scenario().cache({ key: KEY }).cache({ key: KEY, operation: 'set' }).done();

    expect(runCache(scope)).toHaveLength(0);
  });

  it('different keys are not duplicates', () => {
    const scope = scenario().cache({ key: 'a' }).cache({ key: 'b' }).done();

    expect(runCache(scope)).toHaveLength(0);
  });

  it('a request without cache spans yields nothing', () => {
    expect(runCache(scenario().call({ url: CHARGES }).done())).toHaveLength(0);
  });

  it('points at the first read and names where else it happened', () => {
    const scope = scenario()
      .cache({ key: KEY, callsite: 'src/checkout.ts:14' })
      .cache({ key: KEY, callsite: 'src/pricing.ts:31' })
      .done();

    const [finding] = runCache(scope);

    expect(finding?.callsite?.relative).toBe('src/checkout.ts');
    expect(finding?.hint).toContain('src/pricing.ts:31');
  });

  it('names the whole call when a driver reported one', () => {
    const scope = scenario()
      .cache({ command: 'HGET', key: 'user:1 email', callsite: 'src/profile.ts:9' })
      .cache({ command: 'HGET', key: 'user:1 email', callsite: 'src/billing.ts:22' })
      .done();

    const [finding] = runCache(scope);

    expect(finding?.evidence).toMatchObject({
      kind: 'duplicate',
      fingerprint: 'HGET user:1 email',
    });
  });

  it('two fields of one hash are two reads, not a duplicate', () => {
    // The key is the same and the values are different: calling this a
    // duplicate would be the false positive that gets a tool switched off.
    const scope = scenario()
      .cache({ command: 'HGET', key: 'user:1 email' })
      .cache({ command: 'HGET', key: 'user:1 plan' })
      .done();

    expect(runCache(scope)).toHaveLength(0);
  });

  it('a read that also removes what it read is not a repeated read', () => {
    const scope = scenario()
      .cache({ command: 'LPOP', operation: 'other', key: 'jobs' })
      .cache({ command: 'LPOP', operation: 'other', key: 'jobs' })
      .done();

    expect(runCache(scope)).toHaveLength(0);
  });
});
