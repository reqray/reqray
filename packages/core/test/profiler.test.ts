/**
 * The sampling profiler.
 *
 * The claim under test is the one the panel makes on its behalf: given the
 * window of a stretch nothing accounts for, it names the function that was
 * running in it — and says when nothing was.
 *
 * Each case grinds in a function of its own. Sharing one would make it hot,
 * and V8 inlines a hot function into its caller, at which point its samples
 * are attributed to the caller and the test would be asserting the optimiser's
 * mood rather than the profiler's arithmetic.
 */

import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { startProfiler } from '@reqray/core';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Occupies a processor without yielding. */
function spin(ms: number): number {
  const until = performance.now() + ms;
  let x = 0;
  while (performance.now() < until) x += Math.sqrt(x + 1);
  return x;
}

function grindNumbers(ms: number): number {
  return spin(ms);
}
function siftRecords(ms: number): number {
  return spin(ms);
}
function tallyTotals(ms: number): number {
  return spin(ms);
}
function sealTheBooks(ms: number): number {
  return spin(ms);
}

let running: ReturnType<typeof startProfiler> = null;
afterEach(() => {
  running?.stop();
  running = null;
});

function profiler() {
  running = startProfiler({
    intervalUs: 1000,
    stack: { projectRoot: HERE, exclude: [], maxPerFingerprint: 0, limit: 12 },
  });
  return running;
}

describe('what ran in a window', () => {
  it('names the function that burned the time, and the file it is in', () => {
    const profile = profiler();
    if (!profile) return;

    const from = performance.now();
    grindNumbers(200);
    const hot = profile.read(from, performance.now());

    expect(hot).not.toBeNull();
    expect(hot?.busyShare).toBeGreaterThan(0.8);
    const top = hot?.frames[0];
    expect(top?.relative).toBe('profiler.test.ts');
    expect(top?.share).toBeGreaterThan(0.7);
    expect(top?.line).toBeGreaterThan(0);
  });

  it('names one hot spot per place in the code, not one per thing it calls', () => {
    // Keying a frame by its callee would split a function across everything
    // it happens to call and report none of it as hot.
    const profile = profiler();
    if (!profile) return;

    const from = performance.now();
    siftRecords(150);
    const hot = profile.read(from, performance.now());

    const places = (hot?.frames ?? []).map((frame) => `${frame.relative}:${frame.line}`);
    expect(places).toHaveLength(new Set(places).size);
    expect(hot?.frames[0]?.share).toBeGreaterThan(0.7);
  });

  it('says the window was waiting rather than naming a culprit', async () => {
    const profile = profiler();
    if (!profile) return;

    const from = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const hot = profile.read(from, performance.now());

    // The distinction slow_code cannot make on its own: nothing was running,
    // so there is no line of code to point at and none must be invented.
    expect(hot).not.toBeNull();
    expect(hot?.busyShare).toBeLessThan(0.3);
    expect(hot?.frames).toEqual([]);
  });

  it('has nothing to say about a window it holds no samples for', () => {
    const profile = profiler();
    if (!profile) return;

    // Long before this process started sampling.
    expect(profile.read(-10_000, -9_000)).toBeNull();
  });

  it('keeps answering across repeated reads', () => {
    const profile = profiler();
    if (!profile) return;

    // Each read drains what the last one could not have seen. What is
    // asserted is that the drain-and-restart cycle keeps working, not that
    // every short window catches something: on a loaded machine a 40 ms
    // window can honestly go unsampled, and demanding otherwise would be
    // asserting that the machine is idle.
    const answers = [];
    for (let i = 0; i < 4; i++) {
      const from = performance.now();
      tallyTotals(40);
      answers.push(profile.read(from, performance.now()));
    }

    expect(answers.some((answer) => answer !== null)).toBe(true);
    expect(answers.every((answer) => answer === null || answer.samples > 0)).toBe(true);
  });

  it('reports nothing rather than throwing once stopped', () => {
    const profile = profiler();
    if (!profile) return;

    const from = performance.now();
    sealTheBooks(20);
    profile.stop();

    expect(() => profile.read(from, performance.now())).not.toThrow();
  });
});
