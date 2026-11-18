/**
 * How numbers and times are printed in the panel.
 *
 * The relative time is read on a git blame line and on a week-old log file
 * alike, so it has to degrade rather than count minutes forever.
 */

import { describe, expect, it } from 'vitest';
import { ago, bytes } from '../src/shared/format';

describe('how long ago', () => {
  const now = new Date(2026, 7, 20, 12, 0, 0).getTime();
  const back = (ms: number) => ago(now - ms, now);
  it('counts seconds, then minutes', () => {
    expect(back(5_000)).toBe('5s ago');
    expect(back(125_000)).toBe('2m 05s ago');
  });

  it('drops the seconds past an hour, and the minutes past a day', () => {
    // "10080m ago" is a week, and nobody converts that in their head.
    expect(back(3 * 3_600_000 + 4 * 60_000)).toBe('3h 04m ago');
    expect(back(7 * 86_400_000)).toBe('7d 0h ago');
    expect(back(90 * 86_400_000)).toBe('3mo ago');
  });

  it('never counts backwards', () => {
    expect(ago(now + 60_000, now)).toBe('0s ago');
  });
});

describe('sizes', () => {
  it('are kilobytes until they are megabytes', () => {
    expect(bytes(512)).toBe('1 KB');
    expect(bytes(53_973)).toBe('53 KB');
    expect(bytes(4_500_000)).toBe('4.3 MB');
  });
});
