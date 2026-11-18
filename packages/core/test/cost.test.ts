/**
 * What a request cost the process.
 *
 * The numbers here are read from a real processor clock, so the assertions
 * are about shape and direction rather than exact figures: that busy work
 * reads as busy, that waiting reads as waiting, and — the part that matters —
 * that the reading never claims more certainty than it has.
 */

import { performance } from 'node:perf_hooks';
import { markCost, measureCost, startCostMeter, stopCostMeter } from '@reqray/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Occupies a processor for roughly `ms`, without yielding. */
function burn(ms: number): number {
  const until = performance.now() + ms;
  let x = 0;
  while (performance.now() < until) x += Math.sqrt(x + 1);
  return x;
}

/** Measures one request end to end, the way `finish` does. */
function around<T>(body: () => T): ReturnType<typeof measureCost> {
  const mark = markCost();
  const startTime = performance.now();
  body();
  return measureCost(mark, startTime, performance.now() - startTime);
}

beforeEach(() => startCostMeter());
afterEach(() => stopCostMeter());

describe('what a request cost', () => {
  it('charges busy work something, and reports it against the wall clock', () => {
    // What is deliberately *not* asserted here is how much: this suite runs
    // its files as threads of one process, and `process.cpuUsage()` counts
    // every thread — so a neighbouring test file's work lands in this
    // reading. The claim that busy and waiting read differently is made where
    // it can be made honestly, end to end against the demo in its own
    // process.
    const cost = around(() => burn(30));

    expect(cost.cpuMs).toBeGreaterThan(0);
    expect(Number.isFinite(cost.cpuShare)).toBe(true);
  });

  it('reports the share it measured rather than the one that fits a bar', () => {
    // `process.cpuUsage()` counts every thread the process has, so a request
    // the libuv pool worked for genuinely spends more processor time than
    // wall time. Capping that at one would throw away the most interesting
    // reading on the screen; drawing it is the client's problem. Asserted as
    // pure arithmetic against a stated duration, so it holds whatever the
    // machine was doing.
    const mark = markCost();
    burn(20);
    const cost = measureCost(mark, performance.now() - 20, 20);

    expect(cost.cpuShare).toBe(cost.cpuMs / 20);
  });

  it('has no share to report for a request with no duration', () => {
    const mark = markCost();
    expect(measureCost(mark, performance.now(), 0).cpuShare).toBe(0);
  });
});

describe('how much company the window had', () => {
  it('reports none when the request ran alone', () => {
    expect(around(() => burn(5)).overlap).toBe(0);
  });

  it('counts requests already in flight when it began', () => {
    const first = markCost();
    const startTime = performance.now();
    const second = markCost();

    const secondCost = measureCost(second, startTime, 5);
    // The second began with one already running, so its window was shared.
    expect(secondCost.overlap).toBe(1);

    measureCost(first, startTime, 10);
  });

  it('counts requests that arrived while it ran', () => {
    const mine = markCost();
    const startTime = performance.now();

    // Three requests come and go inside my window.
    for (let i = 0; i < 3; i++) measureCost(markCost(), startTime, 1);

    expect(measureCost(mine, startTime, 10).overlap).toBe(3);
  });
});

describe('what the collector took', () => {
  it('attributes only the collections inside the window', () => {
    // Garbage first, so any collection it causes lands before the window.
    const before: unknown[] = [];
    for (let i = 0; i < 200; i++) before.push(new Array(20_000).fill(i));

    const mark = markCost();
    const startTime = performance.now();
    const cost = measureCost(mark, startTime, performance.now() - startTime);

    // A window of microseconds cannot contain a collection, whatever the
    // process did just before it.
    expect(cost.gcMs).toBe(0);
    expect(cost.collections).toBe(0);
  });

  it('reports nothing rather than failing when collections are not observed', () => {
    stopCostMeter();
    const cost = around(() => burn(2));

    expect(cost.gcMs).toBe(0);
    expect(cost.collections).toBe(0);
    // The processor clock does not depend on the observer.
    expect(cost.cpuMs).toBeGreaterThan(0);
  });
});
