/**
 * Tests for the budget detector.
 *
 * It is the one detector that fires on a fact rather than a mistake, so the
 * only thing keeping it from becoming wallpaper is the budget itself — and
 * the direction it points in.
 */

import { slowBudget } from '@reqray/core';
import { describe, expect, it } from 'vitest';
import { scenario } from '../fixtures/spans.js';

const options = slowBudget.defaultOptions;
const run = (scope: Parameters<typeof slowBudget.run>[0], durationMs: number) =>
  slowBudget.run(scope, options, { durationMs, status: 200, bytesOut: null, contentType: null });

describe('budget — finds', () => {
  it('reports the overshoot, not the duration', () => {
    const scope = scenario().call({ url: 'https://api.example.com/x', duration: 600 }).done();

    const [finding] = run(scope, 900);

    expect(finding).toMatchObject({ detector: 'slow_budget', severity: 'warn' });
    expect(finding?.title).toContain('700');
    expect(finding?.costMs).toBe(200);
  });

  it('points at external calls when that is where the time went', () => {
    const scope = scenario().call({ url: 'https://api.example.com/x', duration: 800 }).done();

    expect(run(scope, 1_000)[0]?.hint).toContain('external HTTP');
    expect(run(scope, 1_000)[0]?.hint).toContain('80%');
  });

  it('points at SQL when that is where the time went', () => {
    const scope = scenario()
      .loop(3, () => ({ sql: 'SELECT 1', duration: 250, callsite: 'src/a.ts:1' }))
      .done();

    expect(run(scope, 1_000)[0]?.hint).toContain('SQL');
  });

  it('does not send a reader to the one query when the code holds the time', () => {
    // The case from a real session: 867 ms, of which SQL was ten. A hint
    // reading "1% of the time went to SQL — start there" is worse than
    // silence, and it contradicts the header line directly above it.
    const scope = scenario().query({ sql: 'SELECT 1', duration: 10 }).done();

    const hint = run(scope, 867)[0]?.hint ?? '';
    expect(hint).toContain('not covered by any instrumentation');
    expect(hint).not.toContain('SQL');
  });

  it('counts what ran at the same time once', () => {
    // Four 600 ms calls fired together inside an 800 ms request. Summed, they
    // are 2,400 ms of "external" — three times the request they are part of.
    const scope = scenario()
      .call({ url: 'https://api.example.com/a', duration: 600, at: 0 })
      .call({ url: 'https://api.example.com/b', duration: 600, at: 0 })
      .call({ url: 'https://api.example.com/c', duration: 600, at: 0 })
      .call({ url: 'https://api.example.com/d', duration: 600, at: 0 })
      .done();

    const [finding] = run(scope, 800);

    expect(finding?.evidence).toMatchObject({ kind: 'budget', externalMs: 600 });
    expect(finding?.hint).toContain('75% of the time went to external HTTP calls');
  });

  it('does not send the reader to the queries when they were queueing', () => {
    // Five queries through a pool of one: the SQL layer holds the whole
    // request, and the finding directly above this one says the queue is
    // why. "100% went to SQL — start there" would send the reader straight
    // past it, to add an index that will not help.
    const scope = scenario()
      .query({ sql: 'SELECT 1', duration: 150, at: 0 })
      .query({ sql: 'SELECT 1', duration: 150, at: 150, waitMs: 150 })
      .query({ sql: 'SELECT 1', duration: 150, at: 300, waitMs: 300 })
      .query({ sql: 'SELECT 1', duration: 150, at: 450, waitMs: 450 })
      .query({ sql: 'SELECT 1', duration: 150, at: 600, waitMs: 600 })
      .done();

    const hint = run(scope, 760)[0]?.hint ?? '';

    expect(hint).toContain('queueing for a free connection');
    expect(hint).toContain('The pool is the constraint');
    expect(hint).not.toContain('start there');
  });

  it('still names SQL when the queries actually ran', () => {
    const scope = scenario()
      .loop(5, () => ({ sql: 'SELECT 1', duration: 150 }))
      .done();

    expect(run(scope, 760)[0]?.hint).toContain('went to SQL — start there');
  });

  it('says so when the time is in nothing it can see', () => {
    // A slow request with almost no instrumented work is the case the
    // waterfall draws as a gap; the hint must not invent a culprit.
    const scope = scenario().query({ sql: 'SELECT 1', duration: 2 }).done();

    expect(run(scope, 1_000)[0]?.hint).toContain('not covered by any instrumentation');
  });
});

describe('budget — does NOT find', () => {
  it('a request inside the budget', () => {
    const scope = scenario().call({ url: 'https://api.example.com/x', duration: 400 }).done();

    expect(run(scope, 690)).toHaveLength(0);
  });

  it('a request exactly at the budget', () => {
    expect(run(scenario().done(), 700)).toHaveLength(0);
  });

  it('an empty fast request', () => {
    expect(run(scenario().done(), 3)).toHaveLength(0);
  });
});
