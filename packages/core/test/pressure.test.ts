/**
 * Was the process to blame?
 *
 * Every rule here is a rule about silence. The card is absent far more often
 * than it is present, and each guard has a case below that must not produce
 * one — because a card that fires on noise is a card that fires always, and
 * then it is wallpaper.
 */

import { type DurationSample, pressureFor } from '@reqray/core/panel';
import { describe, expect, it } from 'vitest';

/**
 * Calls of one route.
 *
 * @param calls `[durationMs, loopDelayMs]` pairs; a `null` delay is a call
 * recorded when nothing was watching the loop.
 */
function samples(calls: ReadonlyArray<[number, number | null]>): DurationSample[] {
  return calls.map(([durationMs, loopDelayMs], index) => ({
    durationMs,
    startedAt: 1_000 + index * 1_000,
    hasError: false,
    loopDelayMs,
  }));
}

/** `count` calls at one duration, under one loop delay. */
const run = (count: number, durationMs: number, loopDelayMs: number | null) =>
  Array.from({ length: count }, () => [durationMs, loopDelayMs] as [number, number | null]);

/** The shape the card exists for: quiet host fast, busy host slow. */
const pressured = samples([...run(30, 40, 0.5), ...run(30, 120, 60)]);

describe('host pressure — finds', () => {
  it('the route that is slower when the loop is behind', () => {
    const found = pressureFor(pressured);

    expect(found?.metric).toBe('loop');
    expect(found?.ratio).toBeCloseTo(3, 5);
    expect(found?.elevated.calls).toBe(30);
    expect(found?.normal.calls).toBe(30);
    expect(found?.elevated.p95Ms).toBeCloseTo(120, 5);
    expect(found?.normal.p95Ms).toBeCloseTo(40, 5);
  });

  it('prints the cutoff it split at, so the claim can be checked', () => {
    const found = pressureFor(pressured);

    // The route's own top quartile, not a threshold anybody chose: half the
    // calls ran at 60 ms of delay, so the 75th percentile lands there.
    expect(found?.cutoffMs).toBeCloseTo(60, 5);
    expect(found?.share).toBeCloseTo(50, 5);
  });
});

describe('host pressure — does NOT find', () => {
  it('a host that was flat', () => {
    // Same loop delay throughout, and the durations differ for reasons of
    // their own. Splitting a flat metric at its own quartile sorts calls by
    // jitter and then reports whatever the halves happen to differ by.
    const flat = samples([...run(30, 40, 2), ...run(30, 120, 2)]);

    expect(pressureFor(flat)).toBeNull();
  });

  it('a difference inside the noise', () => {
    // Twenty per cent slower under strain is not a finding at this sample
    // size; it is the sample size.
    const slight = samples([...run(30, 100, 0.5), ...run(30, 120, 60)]);

    expect(pressureFor(slight)).toBeNull();
  });

  it('too few calls to compare distributions', () => {
    const thin = samples([...run(19, 40, 0.5), ...run(19, 200, 60)]);

    expect(pressureFor(thin)).toBeNull();
  });

  it('a split that leaves one side thin, however many calls there are', () => {
    // A hundred quiet calls and five loud ones: the quartile falls inside the
    // quiet group, and the loud side never reaches twenty.
    const lopsided = samples([...run(100, 40, 1), ...run(5, 400, 90)]);

    expect(pressureFor(lopsided)).toBeNull();
  });

  it('calls nothing was watching the loop for', () => {
    const unmeasured = samples([...run(30, 40, null), ...run(30, 200, null)]);

    expect(pressureFor(unmeasured)).toBeNull();
  });

  it('a route whose good half is instant', () => {
    // Nothing to be slower than: a ratio against zero is infinity, and
    // infinity is not a sentence anybody can act on.
    const instant = samples([...run(30, 0, 0.5), ...run(30, 120, 60)]);

    expect(pressureFor(instant)).toBeNull();
  });

  it('and it ignores unmeasured calls rather than counting them as quiet', () => {
    // Thirty measured calls under strain, thirty with no reading at all. The
    // unmeasured ones must not become the comparison's "normal" half.
    const mixed = samples([...run(30, 120, 60), ...run(30, 40, null)]);

    expect(pressureFor(mixed)).toBeNull();
  });
});
