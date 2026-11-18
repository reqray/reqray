/**
 * Numbers, as they are read.
 *
 * Two duration formats on purpose: the stream is scanned for outliers and the
 * waterfall is read for proportion, and a span of 0.4 ms has to be tellable
 * from one of 4 ms even though neither matters in a list.
 */

import { describe, expect, it } from 'vitest';
import { badgeFor, bytes, clock, duration, share, spanDuration } from '../src/render/format.js';
import { plainTheme } from '../src/render/theme.js';

describe('durations in the stream', () => {
  it('keep a decimal only while the whole number would say nothing', () => {
    expect(duration(0.8)).toBe('0.8ms');
    expect(duration(1.2)).toBe('1.2ms');
    expect(duration(9.4)).toBe('9.4ms');
    expect(duration(12)).toBe('12ms');
    expect(duration(47.4)).toBe('47ms');
    expect(duration(604)).toBe('604ms');
  });

  it('turn into seconds where milliseconds stop being readable', () => {
    expect(duration(1_000)).toBe('1.00s');
    expect(duration(2_140)).toBe('2.14s');
    expect(duration(104_000)).toBe('104s');
  });

  it('fit the column they are printed in', () => {
    for (const ms of [0.1, 9.9, 99, 999, 1_000, 59_999, 100_000, 999_000]) {
      expect(duration(ms).length).toBeLessThanOrEqual(7);
      expect(spanDuration(ms).length).toBeLessThanOrEqual(7);
    }
  });
});

describe('durations in the waterfall', () => {
  it('keep a decimal up to a hundred, where a bar is a few cells wide', () => {
    expect(spanDuration(0.4)).toBe('0.4ms');
    expect(spanDuration(41.17)).toBe('41.2ms');
    expect(spanDuration(96)).toBe('96.0ms');
    expect(spanDuration(118)).toBe('118ms');
    expect(spanDuration(268.5)).toBe('269ms');
  });
});

describe('the rest of the numbers', () => {
  it('sizes, as a response header would have said them', () => {
    expect(bytes(182)).toBe('182 B');
    expect(bytes(4_198)).toBe('4.1 KB');
    expect(bytes(2_500_000)).toBe('2.4 MB');
  });

  it('the clock, to the millisecond, in the reader’s own zone', () => {
    expect(clock(new Date(2026, 7, 20, 9, 41, 2, 184).getTime())).toBe('09:41:02.184');
    expect(clock(new Date(2026, 7, 20, 23, 5, 9, 7).getTime())).toBe('23:05:09.007');
  });

  it('a share of the request, or nothing when there is nothing to divide by', () => {
    expect(share(41.2, 275.3)).toBe('15% of total');
    expect(share(1, 0)).toBe('');
  });

  it('a query count, or a mark that says there were none', () => {
    const theme = plainTheme(100);
    expect(theme.glyph('none')).toBe('—');
    expect(plainTheme(100, false).glyph('none')).toBe('-');
  });
});

describe('detector badges', () => {
  it('are the panel’s own words, shortened where the column cannot hold them', () => {
    expect(badgeFor('n_plus_one')).toBe('N+1');
    expect(badgeFor('sequential_http')).toBe('SEQ');
    expect(badgeFor('dup_http')).toBe('DUP');
    expect(badgeFor('dup_cache')).toBe('DUP');
    expect(badgeFor('slow_budget')).toBe('SLOW');
  });

  it('fall back to the id of a detector this client has not heard of', () => {
    expect(badgeFor('cold_start')).toBe('COLD_START');
  });

  it('fit the flag column', () => {
    for (const detector of ['n_plus_one', 'sequential_http', 'dup_http', 'slow_budget']) {
      expect(badgeFor(detector).length).toBeLessThanOrEqual(4);
    }
  });
});
