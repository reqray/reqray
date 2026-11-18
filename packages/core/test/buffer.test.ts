import { RingBuffer } from '@reqray/core';
import { describe, expect, it } from 'vitest';

describe('ring buffer', () => {
  it('yields items newest to oldest', () => {
    const buffer = new RingBuffer<number>(4);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);

    expect(buffer.size).toBe(3);
    expect(buffer.toArray()).toEqual([3, 2, 1]);
    expect([...buffer]).toEqual([3, 2, 1]);
  });

  it('does not grow past the limit and evicts the oldest', () => {
    const buffer = new RingBuffer<number>(3);
    for (let i = 1; i <= 10; i++) buffer.push(i);

    expect(buffer.size).toBe(3);
    expect(buffer.capacity).toBe(3);
    expect(buffer.toArray()).toEqual([10, 9, 8]);
    expect(buffer.evicted).toBe(7);
  });

  it('returns the evicted item', () => {
    const buffer = new RingBuffer<string>(2);
    expect(buffer.push('a')).toBeUndefined();
    expect(buffer.push('b')).toBeUndefined();
    expect(buffer.push('c')).toBe('a');
  });

  it('a one-item buffer keeps only the latest', () => {
    const buffer = new RingBuffer<number>(1);
    buffer.push(1);
    buffer.push(2);

    expect(buffer.toArray()).toEqual([2]);
  });

  it('clear releases references', () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.clear();

    expect(buffer.size).toBe(0);
    expect(buffer.toArray()).toEqual([]);
    buffer.push(9);
    expect(buffer.toArray()).toEqual([9]);
  });

  it('cannot be created with a nonsensical capacity', () => {
    expect(() => new RingBuffer<number>(0)).toThrow(RangeError);
    expect(() => new RingBuffer<number>(-1)).toThrow(RangeError);
    expect(() => new RingBuffer<number>(1.5)).toThrow(RangeError);
  });
});
