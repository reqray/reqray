/**
 * Tests for the budget detector.
 *
 * It is the one detector that fires on a fact rather than a mistake, so the
 * only thing keeping it from becoming wallpaper is the budget itself — and
 * the direction it points in.
 */

import { slowBudget } from '@loupe/core';
import { describe, expect, it } from 'vitest';
import { scenario } from '../fixtures/spans.js';

const options = slowBudget.defaultOptions;
const run = (scope: Parameters<typeof slowBudget.run>[0], durationMs: number) =>
  slowBudget.run(scope, options, { durationMs, status: 200 });

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
