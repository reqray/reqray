/**
 * The event-loop monitor.
 *
 * Two facts decide whether the number is worth showing: an idle loop must
 * read as nothing, and a blocked one must read as roughly what it blocked
 * for. A monitor that reports eleven milliseconds on a healthy process would
 * put a wrong number on every request Reqray records.
 */

import { startHostMonitor } from '@reqray/core';
import { describe, expect, it } from 'vitest';

/** Blocks the loop the way a synchronous parse or a crypto call does. */
function block(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Deliberately busy: this is the thing being measured.
  }
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('event-loop delay', () => {
  it('reads as nothing on a healthy process', async () => {
    const monitor = startHostMonitor();
    try {
      await settle(120);
      const state = monitor.read();

      expect(state).not.toBeNull();
      // libuv reports the whole sampling interval, so the baseline has to
      // come off. Without that this is 11 ms on an idle process.
      expect(state?.loopDelayMs ?? 99).toBeLessThan(5);
      expect(state?.loopMaxMs ?? 99).toBeLessThan(15);
    } finally {
      monitor.stop();
    }
  });

  it('reads roughly what the loop was blocked for', async () => {
    const monitor = startHostMonitor();
    try {
      await settle(60);
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          block(120);
          resolve();
        }, 10),
      );
      await settle(60);

      const state = monitor.read();
      // Roughly: the sample lands wherever it lands inside the block.
      expect(state?.loopMaxMs ?? 0).toBeGreaterThan(80);
    } finally {
      monitor.stop();
    }
  });

  it('stops when it is told to, and answers nothing after', async () => {
    const monitor = startHostMonitor();
    await settle(60);
    monitor.stop();

    expect(monitor.read()).toBeNull();
    // And stopping twice is not an error: shutdown paths run more than once.
    expect(() => monitor.stop()).not.toThrow();
  });
});

describe('a window boundary', () => {
  /**
   * Retried, and only this one.
   *
   * The assertion holds while the block is still inside the monitor's memory
   * — the open window and the one before it, two seconds in all. Every wait
   * here is a `setTimeout` competing with a dozen worker processes for the
   * same cores, and when the full suite stretches 1.2 s of waiting past 2 s
   * of wall clock the reading is legitimately gone. That is a fact about the
   * machine, not about the monitor, and it is the reason for the retry rather
   * than for a wider window.
   */
  it('does not swallow a block that just happened', { retry: 2, timeout: 10_000 }, async () => {
    const monitor = startHostMonitor();
    try {
      // Block, then wait past the window's reset. The request that blocked
      // the loop finishes right about here, and it is the one request the
      // number exists for: if the reset takes the reading with it, the
      // panel says nothing about the only interesting thing that happened.
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          block(120);
          resolve();
        }, 20),
      );
      await settle(1_200);

      expect(monitor.read()?.loopMaxMs ?? 0).toBeGreaterThan(80);
    } finally {
      monitor.stop();
    }
  });
});

describe('what it costs to ask', () => {
  it('does not walk the histogram once per request', async () => {
    const monitor = startHostMonitor();
    try {
      await settle(80);
      // Warm, so the first (real) read is not what is being timed.
      monitor.read();

      const started = process.hrtime.bigint();
      for (let index = 0; index < 20_000; index++) monitor.read();
      const perRead = Number(process.hrtime.bigint() - started) / 20_000;

      // `mean` walks the buckets and costs about eleven microseconds. Asked
      // on every request at a thousand a second, that is eleven milliseconds
      // of every second spent measuring rather than serving.
      expect(perRead).toBeLessThan(1_000);
    } finally {
      monitor.stop();
    }
  });

  it('still answers with a fresh reading once the memo is stale', async () => {
    const monitor = startHostMonitor();
    try {
      await settle(80);
      const first = monitor.read();
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          block(60);
          resolve();
        }, 10),
      );
      await settle(120);

      const second = monitor.read();
      expect(second?.loopMaxMs ?? 0).toBeGreaterThan(first?.loopMaxMs ?? 0);
    } finally {
      monitor.stop();
    }
  });
});
